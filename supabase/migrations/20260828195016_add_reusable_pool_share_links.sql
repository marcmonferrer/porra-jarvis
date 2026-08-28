-- One reusable, revocable share capability per pool. Legacy single-use invitations remain valid.
alter table private.pool_invitations
  add column is_reusable boolean not null default false,
  add column usage_count integer not null default 0 check (usage_count >= 0),
  add constraint pool_invitations_reusable_consumption_shape
    check (not is_reusable or (consumed_at is null and consumed_by is null));

create unique index pool_invitations_one_active_share_idx
  on private.pool_invitations(pool_id) where is_reusable and revoked_at is null;

create function public.admin_create_pool_share_link(target_pool_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare admin_user_id uuid; raw_token text; link_created_at timestamptz; link_expires_at timestamptz;
begin
  admin_user_id := private.require_porra_admin();
  select closes_at into link_expires_at from public.pools where id = target_pool_id for update;
  if not found then raise exception 'Pool not found'; end if;
  if link_expires_at <= pg_catalog.now() then raise exception 'Pool is closed'; end if;
  if exists (select 1 from private.pool_invitations where pool_id = target_pool_id and is_reusable and revoked_at is null)
  then raise exception 'An active share link already exists'; end if;
  raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.pool_invitations(pool_id, token_hash, expires_at, created_by, is_reusable)
  values (target_pool_id, pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'), link_expires_at, admin_user_id, true)
  returning created_at into link_created_at;
  return pg_catalog.jsonb_build_object('shareToken', raw_token, 'createdAt', link_created_at,
    'expiresAt', link_expires_at, 'status', 'active', 'usageCount', 0);
end;
$$;

create function public.admin_get_pool_share_link(target_pool_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare link_state jsonb;
begin
  perform private.require_porra_admin();
  perform 1 from public.pools where id = target_pool_id;
  if not found then raise exception 'Pool not found'; end if;
  select pg_catalog.jsonb_build_object(
    'createdAt', invitation.created_at, 'expiresAt', pool.closes_at, 'revokedAt', invitation.revoked_at,
    'status', case when invitation.revoked_at is not null then 'revoked'
      when pool.status <> 'open' or pool.closes_at <= pg_catalog.now() then 'expired' else 'active' end,
    'usageCount', invitation.usage_count)
  into link_state from private.pool_invitations invitation
  where invitation.pool_id = target_pool_id and invitation.is_reusable
  order by invitation.created_at desc limit 1;
  return link_state;
end;
$$;

create function public.admin_rotate_pool_share_link(target_pool_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare admin_user_id uuid; raw_token text; link_created_at timestamptz; link_expires_at timestamptz;
begin
  admin_user_id := private.require_porra_admin();
  select closes_at into link_expires_at from public.pools where id = target_pool_id for update;
  if not found then raise exception 'Pool not found'; end if;
  if link_expires_at <= pg_catalog.now() then raise exception 'Pool is closed'; end if;
  update private.pool_invitations set revoked_at = pg_catalog.now()
  where pool_id = target_pool_id and is_reusable and revoked_at is null;
  raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.pool_invitations(pool_id, token_hash, expires_at, created_by, is_reusable)
  values (target_pool_id, pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'), link_expires_at, admin_user_id, true)
  returning created_at into link_created_at;
  return pg_catalog.jsonb_build_object('shareToken', raw_token, 'createdAt', link_created_at,
    'expiresAt', link_expires_at, 'status', 'active', 'usageCount', 0);
end;
$$;

create or replace function public.create_public_reservation(
  target_pool_id text, participant_name text, selected_cells text[], invitation_token text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  target_pool public.pools%rowtype; target_invitation private.pool_invitations%rowtype;
  target_phase text; new_participant_id uuid; raw_token text; normalized text;
  target_cell text; sorted_cells text[]; existing_entry_count integer; created_bets jsonb;
begin
  if invitation_token is null or pg_catalog.octet_length(invitation_token) <> 64 or invitation_token !~ '^[0-9a-f]{64}$'
  then raise exception 'Invalid invitation'; end if;
  if participant_name is null or pg_catalog.char_length(pg_catalog.btrim(participant_name)) not between 1 and 50
  then raise exception 'Participant name is required'; end if;
  if selected_cells is null or pg_catalog.cardinality(selected_cells) not between 1 and 2
  then raise exception 'Select one or two cells'; end if;
  if (select pg_catalog.count(distinct value) from pg_catalog.unnest(selected_cells) value) <> pg_catalog.cardinality(selected_cells)
  then raise exception 'Cells must be different'; end if;
  select pg_catalog.array_agg(value order by value) into sorted_cells from pg_catalog.unnest(selected_cells) value;
  foreach target_cell in array sorted_cells loop
    if target_cell !~ '^[0-4]-[0-4]$' then raise exception 'Invalid cell'; end if;
  end loop;
  select * into target_pool from public.pools
  where id::text = target_pool_id or slug = target_pool_id limit 1 for update;
  if not found then raise exception 'Pool not found'; end if;
  if target_pool.published_at is null or target_pool.status <> 'open' or pg_catalog.now() >= target_pool.closes_at
  then raise exception 'Pool is closed'; end if;
  select phase into target_phase from public.match_states where pool_id = target_pool.id;
  if target_phase in ('first', 'half', 'second', 'final')
  then raise exception 'Bets are closed because the match has started'; end if;

  normalized := private.normalize_participant_name(participant_name);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_pool.id::text || ':participant:' || normalized, 0));
  select pg_catalog.count(*) into existing_entry_count
  from public.bets bet join public.participants participant on participant.id = bet.participant_id
  where participant.pool_id = target_pool.id and participant.normalized_name = normalized
    and participant.archived_at is null and bet.payment_status <> 'released';
  if existing_entry_count + pg_catalog.cardinality(sorted_cells) > 2
  then raise exception 'Participant entry limit reached'; end if;

  select * into target_invitation from private.pool_invitations
  where pool_id = target_pool.id
    and token_hash = pg_catalog.encode(extensions.digest(invitation_token, 'sha256'), 'hex')
    and revoked_at is null and ((is_reusable) or (expires_at > pg_catalog.now() and consumed_at is null))
  for update;
  if not found then raise exception 'Invalid invitation'; end if;
  if target_invitation.is_reusable then
    update private.pool_invitations set usage_count = usage_count + 1 where id = target_invitation.id;
  else
    update private.pool_invitations set consumed_at = pg_catalog.now() where id = target_invitation.id;
  end if;

  foreach target_cell in array sorted_cells loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_pool.id::text || ':cell:' || target_cell, 0));
  end loop;
  new_participant_id := pg_catalog.gen_random_uuid();
  raw_token := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.participants(id, pool_id, display_name, normalized_name, tracking_token_hash)
  values (new_participant_id, target_pool.id, pg_catalog.btrim(participant_name), normalized,
    pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'));
  insert into public.bets(pool_id, participant_id, cell_key)
  select target_pool.id, new_participant_id, value from pg_catalog.unnest(sorted_cells) value;
  if not target_invitation.is_reusable then
    update private.pool_invitations set consumed_by = new_participant_id where id = target_invitation.id;
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('cellKey', cell_key) order by cell_key)
  into created_bets from public.bets where participant_id = new_participant_id;
  return pg_catalog.jsonb_build_object('token', raw_token,
    'participant', pg_catalog.jsonb_build_object('name', pg_catalog.btrim(participant_name)),
    'bets', created_bets, 'paymentInstructions', target_pool.payment_instructions);
end;
$$;

revoke execute on function public.admin_create_pool_share_link(uuid) from public, anon, authenticated;
revoke execute on function public.admin_get_pool_share_link(uuid) from public, anon, authenticated;
revoke execute on function public.admin_rotate_pool_share_link(uuid) from public, anon, authenticated;
revoke execute on function public.create_public_reservation(text, text, text[], text) from public, anon, authenticated;
grant execute on function public.admin_create_pool_share_link(uuid) to authenticated;
grant execute on function public.admin_get_pool_share_link(uuid) to authenticated;
grant execute on function public.admin_rotate_pool_share_link(uuid) to authenticated;
grant execute on function public.create_public_reservation(text, text, text[], text) to anon, authenticated;

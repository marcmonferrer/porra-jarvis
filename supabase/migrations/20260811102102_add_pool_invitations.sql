-- Invite-only anti-abuse: private, single-use invitations scoped to one pool.
-- The raw invitation token is returned once and only its SHA-256 hash is stored.

create table private.pool_invitations (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid unique references public.participants(id) on delete set null,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint pool_invitations_expiry_after_creation
    check (expires_at > created_at),
  constraint pool_invitations_not_consumed_and_revoked
    check (not (consumed_at is not null and revoked_at is not null)),
  constraint pool_invitations_consumer_requires_consumption
    check (consumed_by is null or consumed_at is not null)
);

create index pool_invitations_pool_created_idx
  on private.pool_invitations(pool_id, created_at desc);

create index pool_invitations_created_by_idx
  on private.pool_invitations(created_by);

revoke all on table private.pool_invitations from public, anon, authenticated;
alter table private.pool_invitations enable row level security;

create function public.admin_create_pool_invitation(
  target_pool_id uuid,
  invitation_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_user_id uuid;
  raw_token text;
  new_invitation_id uuid;
  invitation_created_at timestamptz;
begin
  admin_user_id := private.require_porra_admin();

  if invitation_expires_at is null or invitation_expires_at <= pg_catalog.now() then
    raise exception 'Invitation expiry must be in the future';
  end if;

  perform 1 from public.pools where id = target_pool_id;
  if not found then raise exception 'Pool not found'; end if;

  raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  insert into private.pool_invitations(
    pool_id,
    token_hash,
    expires_at,
    created_by
  )
  values (
    target_pool_id,
    pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    invitation_expires_at,
    admin_user_id
  )
  returning id, created_at into new_invitation_id, invitation_created_at;

  return pg_catalog.jsonb_build_object(
    'invitationId', new_invitation_id,
    'invitationToken', raw_token,
    'expiresAt', invitation_expires_at,
    'createdAt', invitation_created_at
  );
end;
$$;

create function public.admin_list_pool_invitations(target_pool_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  invitation_list jsonb;
begin
  perform private.require_porra_admin();

  perform 1 from public.pools where id = target_pool_id;
  if not found then raise exception 'Pool not found'; end if;

  select pg_catalog.coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'invitationId', invitation.id,
        'createdAt', invitation.created_at,
        'expiresAt', invitation.expires_at,
        'consumedAt', invitation.consumed_at,
        'revokedAt', invitation.revoked_at,
        'status', case
          when invitation.consumed_at is not null then 'consumed'
          when invitation.revoked_at is not null then 'revoked'
          when invitation.expires_at <= pg_catalog.now() then 'expired'
          else 'active'
        end
      )
      order by invitation.created_at desc
    ),
    '[]'::jsonb
  )
  into invitation_list
  from private.pool_invitations invitation
  where invitation.pool_id = target_pool_id;

  return invitation_list;
end;
$$;

create function public.admin_revoke_pool_invitation(target_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked_invitation_id uuid;
  invitation_revoked_at timestamptz;
begin
  perform private.require_porra_admin();

  update private.pool_invitations
  set revoked_at = pg_catalog.now()
  where id = target_invitation_id
    and consumed_at is null
    and revoked_at is null
  returning id, revoked_at into revoked_invitation_id, invitation_revoked_at;

  if not found then raise exception 'Invitation cannot be revoked'; end if;

  return pg_catalog.jsonb_build_object(
    'invitationId', revoked_invitation_id,
    'revokedAt', invitation_revoked_at,
    'status', 'revoked'
  );
end;
$$;

-- Replace the old signature instead of creating a PostgREST-incompatible overload.
revoke execute on function public.create_public_reservation(text, text, text[])
  from public, anon, authenticated;
drop function public.create_public_reservation(text, text, text[]);

create function public.create_public_reservation(
  target_pool_id text,
  participant_name text,
  selected_cells text[],
  invitation_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool public.pools%rowtype;
  target_phase text;
  new_participant_id uuid;
  raw_token text;
  normalized text;
  target_cell text;
  sorted_cells text[];
  claimed_invitation_id uuid;
  created_bets jsonb;
begin
  if invitation_token is null
    or pg_catalog.octet_length(invitation_token) <> 64
  then
    raise exception 'Invalid invitation';
  end if;
  if invitation_token !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid invitation';
  end if;

  if participant_name is null
    or pg_catalog.char_length(pg_catalog.btrim(participant_name)) not between 1 and 50
  then
    raise exception 'Participant name is required';
  end if;
  if selected_cells is null or pg_catalog.cardinality(selected_cells) not between 1 and 2 then
    raise exception 'Select one or two cells';
  end if;
  if (
    select pg_catalog.count(distinct value) from pg_catalog.unnest(selected_cells) value
  ) <> pg_catalog.cardinality(selected_cells) then
    raise exception 'Cells must be different';
  end if;

  select pg_catalog.array_agg(value order by value)
  into sorted_cells
  from pg_catalog.unnest(selected_cells) value;

  foreach target_cell in array sorted_cells
  loop
    if target_cell !~ '^[0-4]-[0-4]$' then raise exception 'Invalid cell'; end if;
  end loop;

  select * into target_pool
  from public.pools
  where id::text = target_pool_id or slug = target_pool_id
  limit 1
  for update;
  if not found then raise exception 'Pool not found'; end if;
  if target_pool.published_at is null
    or target_pool.status <> 'open'
    or pg_catalog.now() >= target_pool.closes_at
  then
    raise exception 'Pool is closed';
  end if;

  select phase into target_phase
  from public.match_states
  where pool_id = target_pool.id;
  if target_phase in ('first', 'half', 'second', 'final') then
    raise exception 'Bets are closed because the match has started';
  end if;

  update private.pool_invitations
  set consumed_at = pg_catalog.now()
  where pool_id = target_pool.id
    and token_hash = pg_catalog.encode(
      extensions.digest(invitation_token, 'sha256'),
      'hex'
    )
    and expires_at > pg_catalog.now()
    and consumed_at is null
    and revoked_at is null
  returning id into claimed_invitation_id;

  if not found then raise exception 'Invalid invitation'; end if;

  foreach target_cell in array sorted_cells
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        target_pool.id::text || ':cell:' || target_cell,
        0
      )
    );
  end loop;

  new_participant_id := pg_catalog.gen_random_uuid();
  raw_token := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  normalized := private.normalize_participant_name(participant_name);

  insert into public.participants(
    id,
    pool_id,
    display_name,
    normalized_name,
    tracking_token_hash
  )
  values (
    new_participant_id,
    target_pool.id,
    pg_catalog.btrim(participant_name),
    normalized,
    pg_catalog.encode(extensions.digest(raw_token, 'sha256'), 'hex')
  );

  insert into public.bets(pool_id, participant_id, cell_key)
  select target_pool.id, new_participant_id, value
  from pg_catalog.unnest(selected_cells) value;

  update private.pool_invitations
  set consumed_by = new_participant_id
  where id = claimed_invitation_id;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('cellKey', cell_key)
    order by cell_key
  )
  into created_bets
  from public.bets
  where participant_id = new_participant_id;

  return pg_catalog.jsonb_build_object(
    'token', raw_token,
    'participant', pg_catalog.jsonb_build_object(
      'name', pg_catalog.btrim(participant_name)
    ),
    'bets', created_bets,
    'paymentInstructions', target_pool.payment_instructions
  );
end;
$$;

revoke execute on function public.admin_create_pool_invitation(uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.admin_list_pool_invitations(uuid)
  from public, anon, authenticated;
revoke execute on function public.admin_revoke_pool_invitation(uuid)
  from public, anon, authenticated;
revoke execute on function public.create_public_reservation(text, text, text[], text)
  from public, anon, authenticated;

grant execute on function public.admin_create_pool_invitation(uuid, timestamptz)
  to authenticated;
grant execute on function public.admin_list_pool_invitations(uuid)
  to authenticated;
grant execute on function public.admin_revoke_pool_invitation(uuid)
  to authenticated;
grant execute on function public.create_public_reservation(text, text, text[], text)
  to anon, authenticated;

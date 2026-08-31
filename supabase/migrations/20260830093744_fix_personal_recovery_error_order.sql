-- Preserve a uniform personal-recovery error before participant-limit checks.
-- The original activation migration remains immutable and applied exactly once.

create or replace function public.create_public_reservation_with_recovery(
  target_pool_id text,
  participant_name text,
  selected_cells text[],
  invitation_token text,
  existing_recovery_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool public.pools%rowtype;
  target_invitation private.pool_invitations%rowtype;
  target_participant public.participants%rowtype;
  target_phase text;
  new_participant_id uuid;
  raw_tracking_token text;
  raw_recovery_token text;
  normalized text;
  target_cell text;
  sorted_cells text[];
  existing_entry_count integer;
  created_bets jsonb;
  created_new_participant boolean := false;
  base_response jsonb;
begin
  if invitation_token is null
    or pg_catalog.octet_length(invitation_token) <> 64
    or invitation_token !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid invitation';
  end if;

  if existing_recovery_token is not null
    and (
      pg_catalog.octet_length(existing_recovery_token) <> 64
      or existing_recovery_token !~ '^[0-9a-f]{64}$'
    )
  then
    raise exception 'No s’ha pogut recuperar aquesta aposta.';
  end if;

  if participant_name is null
    or pg_catalog.char_length(pg_catalog.btrim(participant_name)) not between 1 and 50
  then
    raise exception 'Participant name is required';
  end if;

  if selected_cells is null
    or pg_catalog.cardinality(selected_cells) not between 1 and 2
  then
    raise exception 'Select one or two cells';
  end if;

  if (
    select pg_catalog.count(distinct value)
    from pg_catalog.unnest(selected_cells) value
  ) <> pg_catalog.cardinality(selected_cells)
  then
    raise exception 'Cells must be different';
  end if;

  select pg_catalog.array_agg(value order by value)
  into sorted_cells
  from pg_catalog.unnest(selected_cells) value;

  foreach target_cell in array sorted_cells loop
    if target_cell !~ '^[0-4]-[0-4]$' then
      raise exception 'Invalid cell';
    end if;
  end loop;

  select *
  into target_pool
  from public.pools
  where id::text = target_pool_id or slug = target_pool_id
  limit 1
  for update;

  if not found then
    raise exception 'Pool not found';
  end if;

  if target_pool.published_at is null
    or target_pool.status <> 'open'
    or pg_catalog.now() >= target_pool.closes_at
  then
    raise exception 'Pool is closed';
  end if;

  select phase
  into target_phase
  from public.match_states
  where pool_id = target_pool.id;

  if target_phase in ('first', 'half', 'second', 'final') then
    raise exception 'Bets are closed because the match has started';
  end if;

  normalized := private.normalize_participant_name(participant_name);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_pool.id::text || ':participant:' || normalized, 0)
  );

  if existing_recovery_token is not null then
    select participant.*
    into target_participant
    from private.participant_recovery_tokens recovery
    join public.participants participant
      on participant.id = recovery.participant_id
      and participant.pool_id = recovery.pool_id
    where recovery.pool_id = target_pool.id
      and recovery.token_hash = pg_catalog.encode(
        extensions.digest(existing_recovery_token, 'sha256'),
        'hex'
      )
      and recovery.revoked_at is null
      and (recovery.expires_at is null or recovery.expires_at > pg_catalog.now())
      and participant.archived_at is null
      and participant.normalized_name = normalized
    for update of recovery;

    if not found then
      raise exception 'No s’ha pogut recuperar aquesta aposta.';
    end if;

    if exists (
      select 1
      from public.bets bet
      where bet.participant_id = target_participant.id
        and bet.pool_id = target_pool.id
        and bet.payment_status <> 'released'
        and bet.cell_key = any(sorted_cells)
    ) then
      raise exception 'Cells must be different';
    end if;
  elsif exists (
    select 1
    from public.participants participant
    join private.participant_recovery_tokens recovery
      on recovery.participant_id = participant.id
      and recovery.pool_id = participant.pool_id
    where participant.pool_id = target_pool.id
      and participant.normalized_name = normalized
      and participant.archived_at is null
      and recovery.revoked_at is null
      and (recovery.expires_at is null or recovery.expires_at > pg_catalog.now())
  ) then
    raise exception 'No s’ha pogut recuperar aquesta aposta.';
  end if;

  select pg_catalog.count(*)
  into existing_entry_count
  from public.bets bet
  join public.participants participant on participant.id = bet.participant_id
  where participant.pool_id = target_pool.id
    and participant.normalized_name = normalized
    and participant.archived_at is null
    and bet.payment_status <> 'released';

  if existing_entry_count + pg_catalog.cardinality(sorted_cells) > 2 then
    raise exception 'Participant entry limit reached';
  end if;

  select *
  into target_invitation
  from private.pool_invitations
  where pool_id = target_pool.id
    and token_hash = pg_catalog.encode(extensions.digest(invitation_token, 'sha256'), 'hex')
    and revoked_at is null
    and (is_reusable or (expires_at > pg_catalog.now() and consumed_at is null))
  for update;

  if not found then
    raise exception 'Invalid invitation';
  end if;

  if target_invitation.is_reusable then
    update private.pool_invitations
    set usage_count = usage_count + 1
    where id = target_invitation.id;
  else
    update private.pool_invitations
    set consumed_at = pg_catalog.now()
    where id = target_invitation.id;
  end if;

  foreach target_cell in array sorted_cells loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(target_pool.id::text || ':cell:' || target_cell, 0)
    );
  end loop;

  if target_participant.id is null then
    new_participant_id := pg_catalog.gen_random_uuid();
    raw_tracking_token := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
    raw_recovery_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    created_new_participant := true;

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
      pg_catalog.encode(extensions.digest(raw_tracking_token, 'sha256'), 'hex')
    );

    insert into private.participant_recovery_tokens(
      pool_id,
      participant_id,
      token_hash
    )
    values (
      target_pool.id,
      new_participant_id,
      pg_catalog.encode(extensions.digest(raw_recovery_token, 'sha256'), 'hex')
    );
  else
    new_participant_id := target_participant.id;
  end if;

  insert into public.bets(pool_id, participant_id, cell_key)
  select target_pool.id, new_participant_id, value
  from pg_catalog.unnest(sorted_cells) value;

  if not target_invitation.is_reusable then
    update private.pool_invitations
    set consumed_by = new_participant_id
    where id = target_invitation.id;
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('cellKey', cell_key)
    order by cell_key
  )
  into created_bets
  from public.bets
  where participant_id = new_participant_id
    and cell_key = any(sorted_cells)
    and payment_status <> 'released';

  base_response := pg_catalog.jsonb_build_object(
    'participant', pg_catalog.jsonb_build_object(
      'name', coalesce(target_participant.display_name, pg_catalog.btrim(participant_name))
    ),
    'bets', created_bets,
    'paymentInstructions', target_pool.payment_instructions
  );

  if created_new_participant then
    return base_response || pg_catalog.jsonb_build_object(
      'token', raw_tracking_token,
      'recoveryToken', raw_recovery_token
    );
  end if;

  return base_response;
end;
$$;

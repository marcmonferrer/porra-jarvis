-- Private personal-bet recovery capabilities for new reservations.
-- Existing tracking tokens remain valid for legacy participants.

alter table public.participants
  add constraint participants_id_pool_id_key unique (id, pool_id);

create table private.participant_recovery_tokens (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  pool_id uuid not null,
  participant_id uuid not null,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint participant_recovery_tokens_participant_pool_fkey
    foreign key (participant_id, pool_id)
    references public.participants(id, pool_id)
    on delete cascade,
  constraint participant_recovery_tokens_expiry_shape
    check (expires_at is null or expires_at > created_at),
  constraint participant_recovery_tokens_revocation_shape
    check (revoked_at is null or revoked_at >= created_at)
);

create unique index participant_recovery_tokens_one_active_idx
  on private.participant_recovery_tokens(participant_id, pool_id)
  where revoked_at is null;

create index participant_recovery_tokens_pool_id_idx
  on private.participant_recovery_tokens(pool_id);

alter table private.participant_recovery_tokens enable row level security;
revoke all on table private.participant_recovery_tokens from public, anon, authenticated;

create function public.create_public_reservation_with_recovery(
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

create or replace function public.create_public_reservation(
  target_pool_id text,
  participant_name text,
  selected_cells text[],
  invitation_token text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.create_public_reservation_with_recovery(
    target_pool_id,
    participant_name,
    selected_cells,
    invitation_token,
    null::text
  );
$$;

create function public.get_personal_bet_state(
  pool_identifier text,
  raw_recovery_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_recovery private.participant_recovery_tokens%rowtype;
  target_participant public.participants%rowtype;
  target_pool public.pools%rowtype;
begin
  if raw_recovery_token is null
    or pg_catalog.octet_length(raw_recovery_token) <> 64
    or raw_recovery_token !~ '^[0-9a-f]{64}$'
    or pool_identifier is null
    or pg_catalog.char_length(pg_catalog.btrim(pool_identifier)) not between 1 and 100
  then
    return null;
  end if;

  select recovery.*
  into target_recovery
  from private.participant_recovery_tokens recovery
  join public.participants participant
    on participant.id = recovery.participant_id
    and participant.pool_id = recovery.pool_id
  join public.pools pool on pool.id = recovery.pool_id
  where recovery.token_hash = pg_catalog.encode(
      extensions.digest(raw_recovery_token, 'sha256'),
      'hex'
    )
    and recovery.revoked_at is null
    and (recovery.expires_at is null or recovery.expires_at > pg_catalog.now())
    and participant.archived_at is null
    and (pool.slug = pg_catalog.btrim(pool_identifier) or pool.id::text = pg_catalog.btrim(pool_identifier));

  if not found then
    return null;
  end if;

  select *
  into target_participant
  from public.participants
  where id = target_recovery.participant_id
    and pool_id = target_recovery.pool_id
    and archived_at is null;

  select *
  into target_pool
  from public.pools
  where id = target_recovery.pool_id;

  if not found then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'pool', pg_catalog.jsonb_build_object(
      'id', target_pool.slug,
      'slug', target_pool.slug,
      'title', target_pool.title,
      'homeTeam', target_pool.home_team,
      'awayTeam', target_pool.away_team,
      'homeImage', target_pool.home_image_url,
      'awayImage', target_pool.away_image_url,
      'matchAt', target_pool.match_at,
      'closesAt', target_pool.closes_at,
      'priceCents', target_pool.price_cents,
      'paymentInstructions', target_pool.payment_instructions,
      'status', target_pool.status,
      'specials', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'cellKey', special.cell_key,
              'title', special.title,
              'description', special.description
            )
            order by special.sort_order
          ),
          '[]'::jsonb
        )
        from public.special_bets special
        where special.pool_id = target_pool.id
      )
    ),
    'participant', pg_catalog.jsonb_build_object(
      'name', target_participant.display_name,
      'createdAt', target_participant.created_at
    ),
    'bets', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'cellKey', bet.cell_key,
            'paymentStatus', bet.payment_status,
            'createdAt', bet.created_at,
            'amountCents', target_pool.price_cents,
            'prizeCents', coalesce((
              select pg_catalog.sum(award.amount_cents)
              from public.prize_awards award
              where award.bet_id = bet.id
            ), 0),
            'halfPrizeCents', coalesce((
              select pg_catalog.sum(award.amount_cents)
              from public.prize_awards award
              where award.bet_id = bet.id and award.category = 'half'
            ), 0),
            'finalPrizeCents', coalesce((
              select pg_catalog.sum(award.amount_cents)
              from public.prize_awards award
              where award.bet_id = bet.id and award.category = 'final'
            ), 0),
            'specialPrizeCents', coalesce((
              select pg_catalog.sum(award.amount_cents)
              from public.prize_awards award
              where award.bet_id = bet.id and award.category = 'special'
            ), 0),
            'redistributionPrizeCents', coalesce((
              select pg_catalog.sum(award.amount_cents)
              from public.prize_awards award
              where award.bet_id = bet.id and award.category = 'final-redistribution'
            ), 0)
          )
          order by bet.created_at, bet.cell_key
        ),
        '[]'::jsonb
      )
      from public.bets bet
      where bet.participant_id = target_participant.id
        and bet.pool_id = target_pool.id
    ),
    'match', (
      select pg_catalog.jsonb_build_object(
        'phase', match.phase,
        'minute', match.minute,
        'currentHome', match.current_home,
        'currentAway', match.current_away,
        'halfHome', match.half_home,
        'halfAway', match.half_away,
        'finalHome', match.final_home,
        'finalAway', match.final_away,
        'specialStatuses', (
          select coalesce(
            pg_catalog.jsonb_object_agg(
              special.cell_key,
              coalesce(result.status, 'pending')
            ),
            '{}'::jsonb
          )
          from public.special_bets special
          left join public.special_results result
            on result.pool_id = special.pool_id
            and result.special_bet_id = special.id
          where special.pool_id = target_pool.id
        )
      )
      from public.match_states match
      where match.pool_id = target_pool.id
    ),
    'final', target_pool.status = 'finished'
  );
end;
$$;

revoke execute on function public.create_public_reservation_with_recovery(text, text, text[], text, text)
  from public, anon, authenticated;
revoke execute on function public.create_public_reservation(text, text, text[], text)
  from public, anon, authenticated;
revoke execute on function public.get_personal_bet_state(text, text)
  from public, anon, authenticated;
grant execute on function public.create_public_reservation_with_recovery(text, text, text[], text, text)
  to anon, authenticated;
grant execute on function public.create_public_reservation(text, text, text[], text)
  to anon, authenticated;
grant execute on function public.get_personal_bet_state(text, text)
  to anon, authenticated;

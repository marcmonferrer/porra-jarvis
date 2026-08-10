-- Porra Live v1: model reutilitzable, reserves anònimes transaccionals i RLS.
-- No conté credencials, dades de pagament privades ni automatitzacions actives.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Administrador',
  created_at timestamptz not null default now()
);

create table public.pools (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(trim(title)) between 1 and 120),
  home_team text not null check (char_length(trim(home_team)) between 1 and 80),
  away_team text not null check (char_length(trim(away_team)) between 1 and 80),
  home_image_url text,
  away_image_url text,
  match_at timestamptz not null,
  closes_at timestamptz not null,
  price_cents integer not null default 400 check (price_cents >= 0),
  pool_per_bet_cents integer not null default 350 check (pool_per_bet_cents >= 0),
  fee_cents integer not null default 50 check (fee_cents >= 0),
  carryover_cents integer not null default 0 check (carryover_cents >= 0),
  payment_instructions text not null default '',
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'finished')),
  published_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pool_price_parts_match check (price_cents = pool_per_bet_cents + fee_cents)
);

create table public.special_bets (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  cell_key text not null check (cell_key in ('3-3', '3-4', '4-3', '4-4')),
  title text not null check (char_length(trim(title)) between 1 and 100),
  description text not null default '',
  sort_order smallint not null check (sort_order between 1 and 4),
  unique (pool_id, cell_key),
  unique (pool_id, sort_order)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 50),
  normalized_name text not null,
  tracking_token_hash text not null unique,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bets (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  cell_key text not null check (cell_key ~ '^[0-4]-[0-4]$'),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'released')),
  paid_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bets_active_participant_cell_unique
  on public.bets(participant_id, cell_key)
  where payment_status in ('pending', 'paid');

create index bets_pool_cell_active_idx
  on public.bets(pool_id, cell_key)
  where payment_status in ('pending', 'paid');

create table public.match_states (
  pool_id uuid primary key references public.pools(id) on delete cascade,
  phase text not null default 'pre' check (phase in ('pre', 'first', 'half', 'second', 'final')),
  minute smallint not null default 0 check (minute between 0 and 150),
  current_home smallint not null default 0 check (current_home between 0 and 99),
  current_away smallint not null default 0 check (current_away between 0 and 99),
  half_home smallint check (half_home between 0 and 99),
  half_away smallint check (half_away between 0 and 99),
  final_home smallint check (final_home between 0 and 99),
  final_away smallint check (final_away between 0 and 99),
  provider_name text,
  provider_fixture_id text,
  provider_status text,
  provider_error text,
  updated_at timestamptz not null default now(),
  constraint complete_half_score check ((half_home is null) = (half_away is null)),
  constraint complete_final_score check ((final_home is null) = (final_away is null))
);

create table public.special_results (
  pool_id uuid not null references public.pools(id) on delete cascade,
  special_bet_id uuid not null references public.special_bets(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  updated_at timestamptz not null default now(),
  primary key (pool_id, special_bet_id)
);

create table public.prize_results (
  pool_id uuid primary key references public.pools(id) on delete cascade,
  total_pot_cents integer not null check (total_pot_cents >= 0),
  carryover_cents integer not null default 0 check (carryover_cents >= 0),
  calculation jsonb not null,
  finalized_by uuid not null references auth.users(id),
  finalized_at timestamptz not null default now()
);

create table public.prize_awards (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  bet_id uuid not null references public.bets(id) on delete restrict,
  category text not null check (category in ('half', 'final', 'special', 'final-redistribution')),
  amount_cents integer not null check (amount_cents >= 0),
  created_at timestamptz not null default now(),
  unique (pool_id, bet_id, category)
);

-- This is the only table exposed to Postgres Changes. Its payload contains no UUIDs
-- or participant, bet, payment, score, prize or tracking data.
create table public.pool_revisions (
  pool_slug text primary key references public.pools(slug) on update cascade on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

create function private.normalize_participant_name(raw_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(trim(raw_name), '\s+', ' ', 'g'));
$$;

create function private.is_porra_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.admin_profiles
      where user_id = (select auth.uid())
    );
$$;

create function private.require_porra_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  admin_user_id uuid := (select auth.uid());
begin
  if admin_user_id is null or not exists (
    select 1 from public.admin_profiles where user_id = admin_user_id
  ) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return admin_user_id;
end;
$$;

create function public.admin_update_match(target_pool_id uuid, match_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_phase text := match_patch->>'phase';
  target_minute smallint := (match_patch->>'minute')::smallint;
  target_current_home smallint := (match_patch->>'currentHome')::smallint;
  target_current_away smallint := (match_patch->>'currentAway')::smallint;
  target_half_home smallint := (match_patch->>'halfHome')::smallint;
  target_half_away smallint := (match_patch->>'halfAway')::smallint;
  target_final_home smallint := (match_patch->>'finalHome')::smallint;
  target_final_away smallint := (match_patch->>'finalAway')::smallint;
begin
  perform private.require_porra_admin();
  perform 1 from public.pools where id = target_pool_id for update;
  if not found then raise exception 'Pool not found'; end if;

  if target_phase not in ('pre', 'first', 'half', 'second', 'final') then
    raise exception 'Invalid match phase';
  end if;
  if target_minute not between 0 and 150 then raise exception 'Invalid match minute'; end if;
  if target_current_home not between 0 and 99 or target_current_away not between 0 and 99 then
    raise exception 'Invalid current score';
  end if;
  if (target_half_home is null) <> (target_half_away is null) then raise exception 'Incomplete half-time score'; end if;
  if (target_final_home is null) <> (target_final_away is null) then raise exception 'Incomplete final score'; end if;

  if target_phase = 'final' then
    if target_half_home is null or target_final_home is null then
      raise exception 'Half-time and final scores are required';
    end if;
    if target_current_home <> target_final_home or target_current_away <> target_final_away then
      raise exception 'Current score must match the final score';
    end if;
    if exists (
      select 1
      from public.special_bets s
      where s.pool_id = target_pool_id
        and coalesce(match_patch->'specialStatuses'->>s.cell_key, 'pending') = 'pending'
    ) then
      raise exception 'Every special result must be resolved';
    end if;
  end if;

  if exists (
    select 1
    from public.special_bets s
    where s.pool_id = target_pool_id
      and coalesce(match_patch->'specialStatuses'->>s.cell_key, 'pending')
        not in ('pending', 'completed', 'failed')
  ) then
    raise exception 'Invalid special result';
  end if;

  insert into public.match_states(
    pool_id, phase, minute, current_home, current_away,
    half_home, half_away, final_home, final_away, updated_at
  )
  values (
    target_pool_id, target_phase, target_minute, target_current_home, target_current_away,
    target_half_home, target_half_away, target_final_home, target_final_away, now()
  )
  on conflict (pool_id) do update set
    phase = excluded.phase,
    minute = excluded.minute,
    current_home = excluded.current_home,
    current_away = excluded.current_away,
    half_home = excluded.half_home,
    half_away = excluded.half_away,
    final_home = excluded.final_home,
    final_away = excluded.final_away,
    updated_at = excluded.updated_at;

  insert into public.special_results(pool_id, special_bet_id, status, updated_at)
  select
    target_pool_id,
    s.id,
    coalesce(match_patch->'specialStatuses'->>s.cell_key, 'pending'),
    now()
  from public.special_bets s
  where s.pool_id = target_pool_id
  on conflict (pool_id, special_bet_id) do update set
    status = excluded.status,
    updated_at = excluded.updated_at;

  return match_patch;
end;
$$;

create function public.admin_finalize_pool(target_pool_id uuid, prize_calculation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_user_id uuid;
  target_pool public.pools%rowtype;
  expected_total integer;
  reported_total integer := (prize_calculation->>'totalPotCents')::integer;
  reported_carryover integer := (prize_calculation->>'carryoverCents')::integer;
  award_sum integer;
  award_count integer;
begin
  admin_user_id := private.require_porra_admin();

  select * into target_pool
  from public.pools
  where id = target_pool_id
  for update;
  if not found then raise exception 'Pool not found'; end if;

  if exists (
    select 1 from public.bets
    where pool_id = target_pool_id and payment_status = 'pending'
  ) then
    raise exception 'Pending payments must be resolved before finalization';
  end if;
  if not exists (
    select 1 from public.match_states
    where pool_id = target_pool_id
      and phase = 'final'
      and half_home is not null
      and final_home is not null
  ) then
    raise exception 'The match must have complete final results';
  end if;
  if exists (
    select 1
    from public.special_bets s
    left join public.special_results r
      on r.pool_id = s.pool_id and r.special_bet_id = s.id
    where s.pool_id = target_pool_id and coalesce(r.status, 'pending') = 'pending'
  ) then
    raise exception 'Every special result must be resolved';
  end if;

  select count(*) * target_pool.pool_per_bet_cents + target_pool.carryover_cents
  into expected_total
  from public.bets
  where pool_id = target_pool_id and payment_status = 'paid';

  if reported_total is null or reported_total <> expected_total then
    raise exception 'Prize total does not match the confirmed pool';
  end if;
  if reported_carryover is null or reported_carryover < 0 or reported_carryover > reported_total then
    raise exception 'Invalid carryover';
  end if;
  if jsonb_typeof(coalesce(prize_calculation->'awards', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid prize awards';
  end if;

  select coalesce(sum((breakdown->>'cents')::integer), 0)
  into award_sum
  from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award,
       jsonb_array_elements(coalesce(award->'breakdown', '[]'::jsonb)) breakdown;
  if award_sum + reported_carryover <> reported_total then
    raise exception 'Prize awards do not conserve the pool';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award
    where (award->>'totalCents')::integer <> (
      select coalesce(sum((breakdown->>'cents')::integer), 0)
      from jsonb_array_elements(coalesce(award->'breakdown', '[]'::jsonb)) breakdown
    )
  ) then
    raise exception 'Award totals do not match their breakdown';
  end if;

  select count(*) into award_count
  from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award;
  if (
    select count(*)
    from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award
    join public.bets b on b.id = (award->>'betId')::uuid
    where b.pool_id = target_pool_id and b.payment_status = 'paid'
  ) <> award_count then
    raise exception 'Every award must reference a paid bet in this pool';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award,
         jsonb_array_elements(coalesce(award->'breakdown', '[]'::jsonb)) breakdown
    where breakdown->>'category' not in ('half', 'final', 'special', 'final-redistribution')
      or (breakdown->>'cents')::integer < 0
  ) then
    raise exception 'Invalid award breakdown';
  end if;

  insert into public.prize_results(
    pool_id, total_pot_cents, carryover_cents, calculation, finalized_by, finalized_at
  )
  values (
    target_pool_id, reported_total, reported_carryover, prize_calculation, admin_user_id, now()
  )
  on conflict (pool_id) do update set
    total_pot_cents = excluded.total_pot_cents,
    carryover_cents = excluded.carryover_cents,
    calculation = excluded.calculation,
    finalized_by = excluded.finalized_by,
    finalized_at = excluded.finalized_at;

  delete from public.prize_awards where pool_id = target_pool_id;

  insert into public.prize_awards(pool_id, bet_id, category, amount_cents)
  select
    target_pool_id,
    (award->>'betId')::uuid,
    breakdown->>'category',
    (breakdown->>'cents')::integer
  from jsonb_array_elements(coalesce(prize_calculation->'awards', '[]'::jsonb)) award,
       jsonb_array_elements(coalesce(award->'breakdown', '[]'::jsonb)) breakdown;

  update public.pools
  set status = 'finished', updated_at = now()
  where id = target_pool_id;

  return prize_calculation;
end;
$$;

-- No table is implicitly reachable. Grants and RLS are kept together below.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated;

grant usage on schema public to anon, authenticated;
grant usage on schema private to authenticated;

grant select on public.admin_profiles to authenticated;
grant select, insert, update, delete on
  public.pools,
  public.special_bets,
  public.participants,
  public.bets,
  public.match_states,
  public.special_results,
  public.prize_results,
  public.prize_awards
to authenticated;

-- Required solely for the minimal Postgres Changes subscription.
grant select on public.pool_revisions to anon, authenticated;

alter table public.admin_profiles enable row level security;
alter table public.pools enable row level security;
alter table public.special_bets enable row level security;
alter table public.participants enable row level security;
alter table public.bets enable row level security;
alter table public.match_states enable row level security;
alter table public.special_results enable row level security;
alter table public.prize_results enable row level security;
alter table public.prize_awards enable row level security;
alter table public.pool_revisions enable row level security;

create policy "admin_profiles_self"
on public.admin_profiles for select to authenticated
using (user_id = (select auth.uid()));

create policy "pools_admin_all"
on public.pools for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "special_bets_admin_all"
on public.special_bets for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "participants_admin_all"
on public.participants for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "bets_admin_all"
on public.bets for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "match_states_admin_all"
on public.match_states for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "special_results_admin_all"
on public.special_results for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "prize_results_admin_all"
on public.prize_results for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());
create policy "prize_awards_admin_all"
on public.prize_awards for all to authenticated
using (private.is_porra_admin())
with check (private.is_porra_admin());

create policy "pool_revisions_public_read"
on public.pool_revisions for select to anon, authenticated
using (is_public);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bets'
    ) then alter publication supabase_realtime drop table public.bets; end if;
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_states'
    ) then alter publication supabase_realtime drop table public.match_states; end if;
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pools'
    ) then alter publication supabase_realtime drop table public.pools; end if;
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'special_results'
    ) then alter publication supabase_realtime drop table public.special_results; end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pool_revisions'
    ) then alter publication supabase_realtime add table public.pool_revisions; end if;
  end if;
end;
$$;

create function public.get_public_pool_state(pool_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_pool public.pools%rowtype;
  result jsonb;
begin
  select * into target_pool
  from public.pools
  where published_at is not null
    and status in ('open', 'closed', 'finished')
    and (
      nullif(trim(pool_identifier), '') is null
      or id::text = pool_identifier
      or slug = pool_identifier
    )
  order by
    case when id::text = pool_identifier or slug = pool_identifier then 0 else 1 end,
    case when status = 'open' then 0 else 1 end,
    created_at desc
  limit 1;
  if not found then return null; end if;

  select jsonb_build_object(
    'pool', jsonb_build_object(
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
      'poolPerBetCents', target_pool.pool_per_bet_cents,
      'feeCents', target_pool.fee_cents,
      'carryoverCents', target_pool.carryover_cents,
      'status', target_pool.status,
      'specials', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'cellKey', s.cell_key,
          'title', s.title,
          'description', s.description
        ) order by s.sort_order), '[]'::jsonb)
        from public.special_bets s
        where s.pool_id = target_pool.id
      )
    ),
    -- Only paid entries are sent to the prize presentation. Their identifiers are
    -- one-way public keys, never database UUIDs or participant identifiers.
    'bets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', encode(extensions.digest(b.id::text, 'sha256'), 'hex'),
        'cellKey', b.cell_key,
        'eligible', true
      ) order by b.created_at), '[]'::jsonb)
      from public.bets b
      where b.pool_id = target_pool.id and b.payment_status = 'paid'
    ),
    -- Occupancy is aggregated independently so pending payment status cannot be
    -- inferred for a named participant.
    'occupancy', (
      select coalesce(jsonb_object_agg(counts.cell_key, counts.total), '{}'::jsonb)
      from (
        select b.cell_key, count(*)::integer as total
        from public.bets b
        where b.pool_id = target_pool.id and b.payment_status in ('pending', 'paid')
        group by b.cell_key
      ) counts
    ),
    'winnerParticipations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', winners.display_name,
        'betIds', winners.bet_ids
      ) order by winners.created_at), '[]'::jsonb)
      from (
        select
          p.id,
          p.display_name,
          p.created_at,
          jsonb_agg(encode(extensions.digest(b.id::text, 'sha256'), 'hex') order by b.created_at) as bet_ids
        from public.participants p
        join public.bets b
          on b.participant_id = p.id
          and b.payment_status = 'paid'
        join public.match_states m on m.pool_id = p.pool_id
        where p.pool_id = target_pool.id
          and m.phase in ('half', 'second', 'final')
          and (
            (
              b.cell_key not in ('3-3', '3-4', '4-3', '4-4')
              and m.half_home is not null
              and m.half_away is not null
              and b.cell_key = m.half_home::text || '-' || m.half_away::text
            )
            or (
              m.phase = 'final'
              and b.cell_key not in ('3-3', '3-4', '4-3', '4-4')
              and m.final_home is not null
              and m.final_away is not null
              and b.cell_key = m.final_home::text || '-' || m.final_away::text
            )
            or (
              m.phase = 'final'
              and exists (
                select 1
                from public.special_bets s
                join public.special_results r
                  on r.special_bet_id = s.id
                  and r.status = 'completed'
                where s.pool_id = p.pool_id and s.cell_key = b.cell_key
              )
            )
          )
        group by p.id, p.display_name, p.created_at
      ) winners
    ),
    'match', (
      select jsonb_build_object(
        'phase', m.phase,
        'minute', m.minute,
        'currentHome', m.current_home,
        'currentAway', m.current_away,
        'halfHome', m.half_home,
        'halfAway', m.half_away,
        'finalHome', m.final_home,
        'finalAway', m.final_away,
        'specialStatuses', (
          select coalesce(
            jsonb_object_agg(s.cell_key, coalesce(r.status, 'pending')),
            '{}'::jsonb
          )
          from public.special_bets s
          left join public.special_results r on r.special_bet_id = s.id
          where s.pool_id = target_pool.id
        )
      )
      from public.match_states m
      where m.pool_id = target_pool.id
    ),
    'metrics', jsonb_build_object(
      'capacity', 50,
      'freePlaces', 50 - (
        select count(*) from public.bets
        where pool_id = target_pool.id and payment_status in ('pending', 'paid')
      ),
      'pendingPlaces', (
        select count(*) from public.bets
        where pool_id = target_pool.id and payment_status = 'pending'
      ),
      'paidPlaces', (
        select count(*) from public.bets
        where pool_id = target_pool.id and payment_status = 'paid'
      ),
      'confirmedPoolCents', (
        select count(*) * target_pool.pool_per_bet_cents from public.bets
        where pool_id = target_pool.id and payment_status = 'paid'
      ),
      'potentialPoolCents', (
        select count(*) * target_pool.pool_per_bet_cents from public.bets
        where pool_id = target_pool.id and payment_status in ('pending', 'paid')
      ),
      'confirmedFeeCents', (
        select count(*) * target_pool.fee_cents from public.bets
        where pool_id = target_pool.id and payment_status = 'paid'
      )
    )
  ) into result;

  return result;
end;
$$;

create function public.get_tracking_state(raw_tracking_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_participant public.participants%rowtype;
  target_pool public.pools%rowtype;
  public_state jsonb;
begin
  select * into target_participant
  from public.participants
  where tracking_token_hash = encode(extensions.digest(raw_tracking_token, 'sha256'), 'hex')
    and archived_at is null;
  if not found then return null; end if;

  select * into target_pool
  from public.pools
  where id = target_participant.pool_id;

  public_state := public.get_public_pool_state(target_pool.slug);
  if public_state is null then return null; end if;

  public_state := jsonb_set(
    public_state,
    '{pool,paymentInstructions}',
    to_jsonb(target_pool.payment_instructions),
    true
  );

  return public_state || jsonb_build_object(
    'participant', jsonb_build_object('name', target_participant.display_name),
    'bets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', encode(extensions.digest(b.id::text, 'sha256'), 'hex'),
        'cellKey', b.cell_key,
        'paymentStatus', b.payment_status,
        'prizeCents', coalesce((
          select sum(a.amount_cents) from public.prize_awards a where a.bet_id = b.id
        ), 0)
      ) order by b.created_at), '[]'::jsonb)
      from public.bets b
      where b.participant_id = target_participant.id
    ),
    'final', target_pool.status = 'finished'
  );
end;
$$;

create function public.admin_update_reservation(
  target_participant_id uuid,
  participant_name text,
  bet_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool_id uuid;
  supplied_count integer;
  active_count integer;
  target_cell text;
begin
  perform private.require_porra_admin();

  if char_length(trim(participant_name)) not between 1 and 50 then
    raise exception 'Participant name is required';
  end if;
  if jsonb_typeof(bet_updates) <> 'array' then raise exception 'Invalid bet updates'; end if;

  supplied_count := jsonb_array_length(bet_updates);
  if supplied_count not between 1 and 2 then raise exception 'A reservation must contain one or two bets'; end if;
  if (
    select count(distinct item->>'cellKey') from jsonb_array_elements(bet_updates) item
  ) <> supplied_count then
    raise exception 'Cells must be different';
  end if;

  select pool_id into target_pool_id
  from public.participants
  where id = target_participant_id and archived_at is null
  for update;
  if not found then raise exception 'Reservation not found'; end if;

  select count(*) into active_count
  from public.bets b
  where b.participant_id = target_participant_id
    and b.payment_status in ('pending', 'paid')
    and exists (
      select 1
      from jsonb_array_elements(bet_updates) item
      where (item->>'id')::uuid = b.id
    );
  if active_count <> supplied_count then raise exception 'Bet updates do not match the reservation'; end if;

  foreach target_cell in array (
    select array_agg(item->>'cellKey' order by item->>'cellKey')
    from jsonb_array_elements(bet_updates) item
  )
  loop
    if target_cell !~ '^[0-4]-[0-4]$' then raise exception 'Invalid cell'; end if;
    perform pg_advisory_xact_lock(hashtextextended(target_pool_id::text || ':cell:' || target_cell, 0));
    if (
      select count(*) from public.bets
      where pool_id = target_pool_id
        and participant_id <> target_participant_id
        and cell_key = target_cell
        and payment_status in ('pending', 'paid')
    ) >= 2 then
      raise exception 'Cell is full';
    end if;
  end loop;

  update public.participants
  set
    display_name = trim(participant_name),
    normalized_name = private.normalize_participant_name(participant_name),
    updated_at = now()
  where id = target_participant_id;

  update public.bets b
  set cell_key = updates.cell_key, updated_at = now()
  from (
    select (item->>'id')::uuid as id, item->>'cellKey' as cell_key
    from jsonb_array_elements(bet_updates) item
  ) updates
  where b.id = updates.id and b.participant_id = target_participant_id;

  return jsonb_build_object('participantId', target_participant_id, 'bets', bet_updates);
end;
$$;


create function private.validate_bet_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool public.pools%rowtype;
  active_cell_count integer;
  active_participant_count integer;
begin
  if new.payment_status = 'released' then
    new.released_at := coalesce(new.released_at, now());
    new.updated_at := now();
    return new;
  end if;

  select * into target_pool
  from public.pools
  where id = new.pool_id
  for update;
  if not found then raise exception 'Pool not found'; end if;

  if tg_op = 'INSERT' and not private.is_porra_admin() then
    if target_pool.status <> 'open' then raise exception 'Pool is not open'; end if;
    if now() >= target_pool.closes_at then raise exception 'Entry window is closed'; end if;
    if exists (
      select 1 from public.match_states
      where pool_id = new.pool_id and phase in ('first', 'half', 'second', 'final')
    ) then
      raise exception 'Bets are closed because the match has started';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.pool_id::text || ':cell:' || new.cell_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.pool_id::text || ':participant:' || new.participant_id::text, 0));

  select count(*) into active_cell_count
  from public.bets
  where pool_id = new.pool_id
    and cell_key = new.cell_key
    and payment_status in ('pending', 'paid')
    and id <> new.id;
  if active_cell_count >= 2 then raise exception 'Cell is full'; end if;

  select count(*) into active_participant_count
  from public.bets
  where pool_id = new.pool_id
    and participant_id = new.participant_id
    and payment_status in ('pending', 'paid')
    and id <> new.id;
  if active_participant_count >= 2 then raise exception 'Participant already has two bets'; end if;

  if exists (
    select 1 from public.bets
    where participant_id = new.participant_id
      and cell_key = new.cell_key
      and payment_status in ('pending', 'paid')
      and id <> new.id
  ) then
    raise exception 'Participant cannot repeat a cell';
  end if;

  new.updated_at := now();
  if new.payment_status = 'paid' and new.paid_at is null then new.paid_at := now(); end if;
  if new.payment_status = 'released' and new.released_at is null then new.released_at := now(); end if;
  return new;
end;
$$;

create trigger bets_capacity_guard
before insert or update of cell_key, payment_status, participant_id on public.bets
for each row execute function private.validate_bet_capacity();

create function private.initialize_pool_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.pool_revisions(pool_slug, is_public)
  values (new.slug, new.published_at is not null and new.status in ('open', 'closed', 'finished'));
  insert into public.match_states(pool_id) values (new.id);
  return new;
end;
$$;

create trigger a_pools_initialize_children
after insert on public.pools
for each row execute function private.initialize_pool_children();

create function private.bump_pool_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool_id uuid;
  target_pool_slug text;
begin
  if tg_table_name = 'pools' then
    target_pool_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    target_pool_id := case when tg_op = 'DELETE' then old.pool_id else new.pool_id end;
  end if;

  select slug into target_pool_slug from public.pools where id = target_pool_id;
  if target_pool_slug is not null then
    update public.pool_revisions
    set
      revision = revision + 1,
      is_public = (
        select p.published_at is not null and p.status in ('open', 'closed', 'finished')
        from public.pools p where p.slug = target_pool_slug
      ),
      updated_at = now()
    where pool_slug = target_pool_slug;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger z_pools_bump_revision
after insert or update on public.pools
for each row execute function private.bump_pool_revision();
create trigger special_bets_bump_revision
after insert or update or delete on public.special_bets
for each row execute function private.bump_pool_revision();
create trigger participants_bump_revision
after insert or update or delete on public.participants
for each row execute function private.bump_pool_revision();
create trigger bets_bump_revision
after insert or update or delete on public.bets
for each row execute function private.bump_pool_revision();
create trigger match_states_bump_revision
after insert or update or delete on public.match_states
for each row execute function private.bump_pool_revision();
create trigger special_results_bump_revision
after insert or update or delete on public.special_results
for each row execute function private.bump_pool_revision();
create trigger prize_results_bump_revision
after insert or update or delete on public.prize_results
for each row execute function private.bump_pool_revision();
create trigger prize_awards_bump_revision
after insert or update or delete on public.prize_awards
for each row execute function private.bump_pool_revision();

create function public.create_public_reservation(
  target_pool_id text,
  participant_name text,
  selected_cells text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pool public.pools%rowtype;
  target_phase text;
  new_participant_id uuid := gen_random_uuid();
  raw_token text := encode(extensions.gen_random_bytes(24), 'hex');
  normalized text := private.normalize_participant_name(participant_name);
  target_cell text;
  created_bets jsonb;
begin
  if char_length(trim(participant_name)) not between 1 and 50 then
    raise exception 'Participant name is required';
  end if;
  if cardinality(selected_cells) not between 1 and 2 then
    raise exception 'Select one or two cells';
  end if;
  if (select count(distinct value) from unnest(selected_cells) value) <> cardinality(selected_cells) then
    raise exception 'Cells must be different';
  end if;

  select * into target_pool
  from public.pools
  where id::text = target_pool_id or slug = target_pool_id
  limit 1
  for update;
  if not found then raise exception 'Pool not found'; end if;
  if target_pool.published_at is null or target_pool.status <> 'open' or now() >= target_pool.closes_at then
    raise exception 'Pool is closed';
  end if;

  select phase into target_phase
  from public.match_states
  where pool_id = target_pool.id;
  if target_phase in ('first', 'half', 'second', 'final') then
    raise exception 'Bets are closed because the match has started';
  end if;

  foreach target_cell in array (
    select array_agg(value order by value) from unnest(selected_cells) value
  )
  loop
    if target_cell !~ '^[0-4]-[0-4]$' then raise exception 'Invalid cell'; end if;
    perform pg_advisory_xact_lock(hashtextextended(target_pool.id::text || ':cell:' || target_cell, 0));
  end loop;

  insert into public.participants(id, pool_id, display_name, normalized_name, tracking_token_hash)
  values (
    new_participant_id,
    target_pool.id,
    trim(participant_name),
    normalized,
    encode(extensions.digest(raw_token, 'sha256'), 'hex')
  );

  insert into public.bets(pool_id, participant_id, cell_key)
  select target_pool.id, new_participant_id, value
  from unnest(selected_cells) value;

  select jsonb_agg(
    jsonb_build_object('cellKey', cell_key)
    order by cell_key
  ) into created_bets
  from public.bets
  where participant_id = new_participant_id;

  return jsonb_build_object(
    'token', raw_token,
    'participant', jsonb_build_object('name', trim(participant_name)),
    'bets', created_bets,
    'paymentInstructions', target_pool.payment_instructions
  );
end;
$$;

-- Functions created after the baseline revoke are closed explicitly as well.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function public.create_public_reservation(text, text, text[]) to anon, authenticated;
grant execute on function public.get_public_pool_state(text) to anon, authenticated;
grant execute on function public.get_tracking_state(text) to anon, authenticated;
grant execute on function public.admin_update_reservation(uuid, text, jsonb) to authenticated;
grant execute on function public.admin_update_match(uuid, jsonb) to authenticated;
grant execute on function public.admin_finalize_pool(uuid, jsonb) to authenticated;
grant execute on function private.is_porra_admin() to authenticated;

-- Porra Live v1: model reutilitzable, reserves anònimes transaccionals i RLS.
-- No conté credencials, dades de pagament ni automatitzacions actives.

create extension if not exists pgcrypto;

create table if not exists public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Administrador',
  created_at timestamptz not null default now()
);

create table if not exists public.pools (
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

create table if not exists public.special_bets (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  cell_key text not null check (cell_key in ('3-3', '3-4', '4-3', '4-4')),
  title text not null check (char_length(trim(title)) between 1 and 100),
  description text not null default '',
  sort_order smallint not null check (sort_order between 1 and 4),
  unique (pool_id, cell_key),
  unique (pool_id, sort_order)
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 50),
  normalized_name text not null,
  tracking_token_hash text not null unique,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bets (
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

create unique index if not exists bets_active_participant_cell_unique
  on public.bets(participant_id, cell_key)
  where payment_status in ('pending', 'paid');

create index if not exists bets_pool_cell_active_idx
  on public.bets(pool_id, cell_key)
  where payment_status in ('pending', 'paid');

create table if not exists public.match_states (
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

create table if not exists public.special_results (
  pool_id uuid not null references public.pools(id) on delete cascade,
  special_bet_id uuid not null references public.special_bets(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  updated_at timestamptz not null default now(),
  primary key (pool_id, special_bet_id)
);

create table if not exists public.prize_results (
  pool_id uuid primary key references public.pools(id) on delete cascade,
  total_pot_cents integer not null check (total_pot_cents >= 0),
  carryover_cents integer not null default 0 check (carryover_cents >= 0),
  calculation jsonb not null,
  finalized_by uuid not null references auth.users(id),
  finalized_at timestamptz not null default now()
);

create table if not exists public.prize_awards (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  bet_id uuid not null references public.bets(id) on delete restrict,
  category text not null check (category in ('half', 'final', 'special', 'final-redistribution')),
  amount_cents integer not null check (amount_cents >= 0),
  created_at timestamptz not null default now(),
  unique (pool_id, bet_id, category)
);

create or replace function public.normalize_participant_name(raw_name text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(regexp_replace(trim(raw_name), '\s+', ' ', 'g'));
$$;

create or replace function public.is_porra_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.admin_profiles where user_id = auth.uid()
  ) or coalesce((auth.jwt() -> 'app_metadata' ->> 'porra_admin')::boolean, false);
$$;

revoke all on function public.is_porra_admin() from public;
grant execute on function public.is_porra_admin() to anon, authenticated;

create or replace function public.validate_bet_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_pool public.pools%rowtype;
  target_phase text;
  active_cell_count integer;
  active_participant_count integer;
begin
  if new.payment_status = 'released' then
    new.released_at := coalesce(new.released_at, now());
    new.updated_at := now();
    return new;
  end if;

  select * into target_pool from public.pools where id = new.pool_id for update;
  if not found then raise exception 'Pool not found'; end if;

  if tg_op = 'INSERT' and not public.is_porra_admin() then
    if target_pool.status <> 'open' then raise exception 'Pool is not open'; end if;
    if now() >= target_pool.closes_at then raise exception 'Entry window is closed'; end if;
  end if;

  -- Locks are deterministic and transaction-scoped. They prevent a concurrent third place.
  perform pg_advisory_xact_lock(hashtextextended(new.pool_id::text || ':cell:' || new.cell_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(new.pool_id::text || ':participant:' || new.participant_id::text, 0));

  select count(*) into active_cell_count
  from public.bets
  where pool_id = new.pool_id and cell_key = new.cell_key
    and payment_status in ('pending', 'paid') and id <> new.id;
  if active_cell_count >= 2 then raise exception 'Cell is full'; end if;

  select count(*) into active_participant_count
  from public.bets
  where pool_id = new.pool_id and participant_id = new.participant_id
    and payment_status in ('pending', 'paid') and id <> new.id;
  if active_participant_count >= 2 then raise exception 'Participant already has two bets'; end if;

  if exists (
    select 1 from public.bets
    where participant_id = new.participant_id and cell_key = new.cell_key
      and payment_status in ('pending', 'paid') and id <> new.id
  ) then raise exception 'Participant cannot repeat a cell'; end if;

  new.updated_at := now();
  if new.payment_status = 'paid' and new.paid_at is null then new.paid_at := now(); end if;
  if new.payment_status = 'released' and new.released_at is null then new.released_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists bets_capacity_guard on public.bets;
create trigger bets_capacity_guard
before insert or update of cell_key, payment_status, participant_id on public.bets
for each row execute function public.validate_bet_capacity();

create or replace function public.initialize_pool_children()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.match_states(pool_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists pools_initialize_children on public.pools;
create trigger pools_initialize_children
after insert on public.pools
for each row execute function public.initialize_pool_children();

create or replace function public.create_public_reservation(
  target_pool_id uuid,
  participant_name text,
  selected_cells text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_pool public.pools%rowtype;
  new_participant_id uuid := gen_random_uuid();
  raw_token text := encode(gen_random_bytes(24), 'hex');
  normalized text := public.normalize_participant_name(participant_name);
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

  select * into target_pool from public.pools where id = target_pool_id for update;
  if not found then raise exception 'Pool not found'; end if;
  if target_pool.status <> 'open' or now() >= target_pool.closes_at then
    raise exception 'Pool is closed';
  end if;
  select phase into target_phase from public.match_states where pool_id = target_pool_id;
  if target_phase in ('first', 'half', 'second', 'final') then
    raise exception 'Bets are closed because the match has started';
  end if;
  foreach target_cell in array (select array_agg(value order by value) from unnest(selected_cells) value)
  loop
    if target_cell !~ '^[0-4]-[0-4]$' then raise exception 'Invalid cell'; end if;
    perform pg_advisory_xact_lock(hashtextextended(target_pool_id::text || ':cell:' || target_cell, 0));
  end loop;

  insert into public.participants(id, pool_id, display_name, normalized_name, tracking_token_hash)
  values (new_participant_id, target_pool_id, trim(participant_name), normalized, encode(digest(raw_token, 'sha256'), 'hex'));

  insert into public.bets(pool_id, participant_id, cell_key)
  select target_pool_id, new_participant_id, value from unnest(selected_cells) value;

  select jsonb_agg(jsonb_build_object(
    'id', id, 'cellKey', cell_key, 'paymentStatus', payment_status
  ) order by cell_key) into created_bets
  from public.bets where participant_id = new_participant_id;

  return jsonb_build_object(
    'token', raw_token,
    'participant', jsonb_build_object('id', new_participant_id, 'name', trim(participant_name)),
    'bets', created_bets
  );
end;
$$;

create or replace function public.get_public_pool_state(pool_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_pool public.pools%rowtype;
  result jsonb;
begin
  select * into target_pool from public.pools
  where (id::text = pool_identifier or slug = pool_identifier)
    and published_at is not null and status in ('open', 'closed', 'finished')
  limit 1;
  if not found then return null; end if;

  select jsonb_build_object(
    'pool', jsonb_build_object(
      'id', target_pool.id, 'slug', target_pool.slug, 'title', target_pool.title,
      'homeTeam', target_pool.home_team, 'awayTeam', target_pool.away_team,
      'homeImage', target_pool.home_image_url, 'awayImage', target_pool.away_image_url,
      'matchAt', target_pool.match_at, 'closesAt', target_pool.closes_at,
      'priceCents', target_pool.price_cents, 'poolPerBetCents', target_pool.pool_per_bet_cents,
      'feeCents', target_pool.fee_cents, 'carryoverCents', target_pool.carryover_cents,
      'paymentInstructions', target_pool.payment_instructions, 'status', target_pool.status,
      'specials', (select coalesce(jsonb_agg(jsonb_build_object(
        'cellKey', s.cell_key, 'title', s.title, 'description', s.description
      ) order by s.sort_order), '[]'::jsonb) from public.special_bets s where s.pool_id = target_pool.id)
    ),
    'bets', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'cellKey', b.cell_key, 'paymentStatus', b.payment_status,
      'participantName', case
        when b.payment_status = 'paid' and exists (
          select 1 from public.match_states m
          where m.pool_id = b.pool_id
            and m.phase in ('half', 'second', 'final')
            and m.half_home is not null and m.half_away is not null
            and b.cell_key = m.half_home::text || '-' || m.half_away::text
        ) then p.display_name
        else null
      end
    )), '[]'::jsonb)
      from public.bets b
      join public.participants p on p.id = b.participant_id
      where b.pool_id = target_pool.id and b.payment_status in ('pending', 'paid')),
    'match', (select jsonb_build_object(
      'phase', m.phase, 'minute', m.minute, 'currentHome', m.current_home, 'currentAway', m.current_away,
      'halfHome', m.half_home, 'halfAway', m.half_away, 'finalHome', m.final_home, 'finalAway', m.final_away,
      'specialStatuses', (select coalesce(jsonb_object_agg(s.cell_key, coalesce(r.status, 'pending')), '{}'::jsonb)
        from public.special_bets s left join public.special_results r on r.special_bet_id = s.id
        where s.pool_id = target_pool.id)
    ) from public.match_states m where m.pool_id = target_pool.id),
    'metrics', jsonb_build_object(
      'capacity', 50,
      'freePlaces', 50 - (select count(*) from public.bets where pool_id = target_pool.id and payment_status in ('pending', 'paid')),
      'pendingPlaces', (select count(*) from public.bets where pool_id = target_pool.id and payment_status = 'pending'),
      'paidPlaces', (select count(*) from public.bets where pool_id = target_pool.id and payment_status = 'paid'),
      'confirmedPoolCents', (select count(*) * target_pool.pool_per_bet_cents from public.bets where pool_id = target_pool.id and payment_status = 'paid'),
      'potentialPoolCents', (select count(*) * target_pool.pool_per_bet_cents from public.bets where pool_id = target_pool.id and payment_status in ('pending', 'paid')),
      'confirmedFeeCents', (select count(*) * target_pool.fee_cents from public.bets where pool_id = target_pool.id and payment_status = 'paid')
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.get_tracking_state(raw_tracking_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  target_participant public.participants%rowtype;
  public_state jsonb;
begin
  select * into target_participant from public.participants
  where tracking_token_hash = encode(digest(raw_tracking_token, 'sha256'), 'hex')
    and archived_at is null;
  if not found then return null; end if;
  public_state := public.get_public_pool_state(target_participant.pool_id::text);
  return public_state || jsonb_build_object(
    'participant', jsonb_build_object('id', target_participant.id, 'name', target_participant.display_name),
    'bets', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'cellKey', b.cell_key, 'paymentStatus', b.payment_status,
      'prizeCents', coalesce((select sum(a.amount_cents) from public.prize_awards a where a.bet_id = b.id), 0)
    ) order by b.created_at), '[]'::jsonb) from public.bets b where b.participant_id = target_participant.id),
    'final', (select status = 'finished' from public.pools where id = target_participant.pool_id)
  );
end;
$$;

revoke all on function public.create_public_reservation(uuid, text, text[]) from public;
revoke all on function public.get_public_pool_state(text) from public;
revoke all on function public.get_tracking_state(text) from public;
grant execute on function public.create_public_reservation(uuid, text, text[]) to anon, authenticated;
grant execute on function public.get_public_pool_state(text) to anon, authenticated;
grant execute on function public.get_tracking_state(text) to anon, authenticated;

alter table public.admin_profiles enable row level security;
alter table public.pools enable row level security;
alter table public.special_bets enable row level security;
alter table public.participants enable row level security;
alter table public.bets enable row level security;
alter table public.match_states enable row level security;
alter table public.special_results enable row level security;
alter table public.prize_results enable row level security;
alter table public.prize_awards enable row level security;

create policy "admin_profiles_self" on public.admin_profiles for select to authenticated using (user_id = auth.uid());
create policy "pools_public_read" on public.pools for select to anon, authenticated using (published_at is not null and status in ('open', 'closed', 'finished'));
create policy "pools_admin_all" on public.pools for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "special_bets_public_read" on public.special_bets for select to anon, authenticated using (exists (select 1 from public.pools p where p.id = pool_id and p.published_at is not null));
create policy "special_bets_admin_all" on public.special_bets for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "participants_admin_all" on public.participants for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "bets_public_read" on public.bets for select to anon, authenticated using (
  exists (select 1 from public.pools p where p.id = pool_id and p.published_at is not null)
);
create policy "bets_admin_all" on public.bets for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "match_states_public_read" on public.match_states for select to anon, authenticated using (exists (select 1 from public.pools p where p.id = pool_id and p.published_at is not null));
create policy "match_states_admin_all" on public.match_states for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "special_results_public_read" on public.special_results for select to anon, authenticated using (exists (select 1 from public.pools p where p.id = pool_id and p.published_at is not null));
create policy "special_results_admin_all" on public.special_results for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "prize_results_public_read" on public.prize_results for select to anon, authenticated using (exists (select 1 from public.pools p where p.id = pool_id and p.status = 'finished'));
create policy "prize_results_admin_all" on public.prize_results for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());
create policy "prize_awards_admin_all" on public.prize_awards for all to authenticated using (public.is_porra_admin()) with check (public.is_porra_admin());

revoke insert, update, delete on public.participants, public.bets, public.match_states, public.special_results, public.prize_results, public.prize_awards from anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pools'
  ) then alter publication supabase_realtime add table public.pools; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bets'
  ) then alter publication supabase_realtime add table public.bets; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_states'
  ) then alter publication supabase_realtime add table public.match_states; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'special_results'
  ) then alter publication supabase_realtime add table public.special_results; end if;
end
$$;

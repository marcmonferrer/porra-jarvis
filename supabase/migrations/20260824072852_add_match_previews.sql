-- Optional, versioned snapshot produced by the authenticated match-preview Edge Function.
alter table public.pools
  add column match_preview jsonb;

alter table public.pools
  add constraint pools_match_preview_shape check (
    match_preview is null
    or (
      pg_catalog.pg_column_size(match_preview) <= 32768
      and pg_catalog.jsonb_typeof(match_preview) = 'object'
      and match_preview ->> 'version' is not distinct from '1'
      and match_preview ->> 'provider' is not distinct from 'api-football'
      and pg_catalog.jsonb_typeof(match_preview -> 'homeTeam') is not distinct from 'object'
      and pg_catalog.jsonb_typeof(match_preview -> 'awayTeam') is not distinct from 'object'
      and pg_catalog.jsonb_typeof(match_preview -> 'warnings') is not distinct from 'array'
      and pg_catalog.jsonb_typeof(match_preview -> 'source') is not distinct from 'object'
    )
  );

create function private.public_match_preview_text(raw_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(raw_value) = 'string'
      and pg_catalog.length(raw_value #>> '{}') <= 2048
    then raw_value
    else null
  end
$$;

create function private.public_match_preview_number(raw_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when pg_catalog.jsonb_typeof(raw_value) = 'number' then raw_value else null end
$$;
create function private.public_match_preview_recent_match(raw_match jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when raw_match is null or pg_catalog.jsonb_typeof(raw_match) is distinct from 'object' then null
    else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'competitionName', private.public_match_preview_text(raw_match -> 'competitionName'),
      'opponent', private.public_match_preview_text(raw_match -> 'opponent'),
      'scoreFor', private.public_match_preview_number(raw_match -> 'scoreFor'),
      'scoreAgainst', private.public_match_preview_number(raw_match -> 'scoreAgainst'),
      'venue', private.public_match_preview_text(raw_match -> 'venue'),
      'playedAt', private.public_match_preview_text(raw_match -> 'playedAt')
    ))
  end
$$;

create function private.public_match_preview_team(raw_team jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when raw_team is null or pg_catalog.jsonb_typeof(raw_team) is distinct from 'object' then null
    else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'name', private.public_match_preview_text(raw_team -> 'name'),
      'crestUrl', private.public_match_preview_text(raw_team -> 'crestUrl'),
      'standing', case
        when pg_catalog.jsonb_typeof(raw_team -> 'standing') = 'object'
        then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'position', private.public_match_preview_number(raw_team #> '{standing,position}'),
          'points', private.public_match_preview_number(raw_team #> '{standing,points}'),
          'played', private.public_match_preview_number(raw_team #> '{standing,played}'),
          'goalsFor', private.public_match_preview_number(raw_team #> '{standing,goalsFor}'),
          'goalsAgainst', private.public_match_preview_number(raw_team #> '{standing,goalsAgainst}')
        ))
        else null
      end,
      'form', coalesce((
        select pg_catalog.jsonb_agg(form_value.value order by form_value.ordinality)
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(raw_team -> 'form') = 'array'
            then raw_team -> 'form' else '[]'::jsonb end
        ) with ordinality as form_value(value, ordinality)
        where form_value.ordinality <= 5
          and form_value.value in ('"W"'::jsonb, '"D"'::jsonb, '"L"'::jsonb)
      ), '[]'::jsonb),
      'recentMatches', coalesce((
        select pg_catalog.jsonb_agg(
          private.public_match_preview_recent_match(recent.value)
          order by recent.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(raw_team -> 'recentMatches') = 'array'
            then raw_team -> 'recentMatches' else '[]'::jsonb end
        ) with ordinality as recent(value, ordinality)
        where recent.ordinality <= 2
      ), '[]'::jsonb),
      'attackingReference', case
        when pg_catalog.jsonb_typeof(raw_team -> 'attackingReference') = 'object'
        then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'name', private.public_match_preview_text(raw_team #> '{attackingReference,name}'),
          'goals', private.public_match_preview_number(raw_team #> '{attackingReference,goals}')
        ))
        else null
      end
    ))
  end
$$;

create function private.public_match_preview(raw_preview jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when raw_preview is null
      or pg_catalog.jsonb_typeof(raw_preview) is distinct from 'object'
      or raw_preview ->> 'version' is distinct from '1'
      or raw_preview ->> 'provider' is distinct from 'api-football'
    then null
    else pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'version', private.public_match_preview_text(raw_preview -> 'version'),
      'provider', private.public_match_preview_text(raw_preview -> 'provider'),
      'competitionName', private.public_match_preview_text(raw_preview -> 'competitionName'),
      'season', private.public_match_preview_number(raw_preview -> 'season'),
      'fetchedAt', private.public_match_preview_text(raw_preview -> 'fetchedAt'),
      'kickoffAt', private.public_match_preview_text(raw_preview -> 'kickoffAt'),
      'homeTeam', private.public_match_preview_team(raw_preview -> 'homeTeam'),
      'awayTeam', private.public_match_preview_team(raw_preview -> 'awayTeam'),
      'warnings', coalesce((
        select pg_catalog.jsonb_agg(warning.value order by warning.ordinality)
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(raw_preview -> 'warnings') = 'array'
            then raw_preview -> 'warnings' else '[]'::jsonb end
        ) with ordinality as warning(value, ordinality)
        where warning.ordinality <= 5
          and pg_catalog.jsonb_typeof(warning.value) = 'string'
      ), '[]'::jsonb),
      'source', pg_catalog.jsonb_build_object(
        'label', 'API-Football',
        'url', 'https://www.api-football.com/'
      )
    ))
  end
$$;

revoke execute on function private.public_match_preview_text(jsonb)
  from public, anon, authenticated;
revoke execute on function private.public_match_preview_number(jsonb)
  from public, anon, authenticated;revoke execute on function private.public_match_preview_recent_match(jsonb)
  from public, anon, authenticated;
revoke execute on function private.public_match_preview_team(jsonb)
  from public, anon, authenticated;
revoke execute on function private.public_match_preview(jsonb)
  from public, anon, authenticated;
create or replace function public.get_public_pool_state(pool_identifier text)
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
      'matchPreview', private.public_match_preview(target_pool.match_preview),
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
revoke execute on function public.get_public_pool_state(text)
  from public, anon, authenticated;
grant execute on function public.get_public_pool_state(text)
  to anon, authenticated;

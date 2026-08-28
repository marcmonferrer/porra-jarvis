-- Optional public organizer copy. Empty legacy pools remain fully compatible.
alter table public.pools
  add column organizer_note text,
  add column organizer_contact text,
  add constraint pools_organizer_note_length
    check (organizer_note is null or char_length(organizer_note) <= 400),
  add constraint pools_organizer_contact_length
    check (organizer_contact is null or char_length(organizer_contact) <= 120);
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
      'organizerNote', target_pool.organizer_note,
      'organizerContact', target_pool.organizer_contact,
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

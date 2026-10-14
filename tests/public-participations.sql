-- Run after all migrations in a disposable local PostgreSQL database.
-- Synthetic data only; every fixture is rolled back.
begin;

insert into auth.users(id) values ('10000000-0000-4000-8000-000000000001');
insert into public.pools(id, slug, title, home_team, away_team, match_at, closes_at, published_at, status, created_by)
select ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'qa-directory-' || n, 'QA directory', 'Local', 'Visitor', '2099-01-01Z', '2099-01-01Z',
  case when n = 4 then null else now() end,
  case when n = 3 then 'draft' else 'open' end,
  '10000000-0000-4000-8000-000000000001'::uuid
from generate_series(1, 5) n;

insert into public.participants(id, pool_id, display_name, normalized_name, tracking_token_hash, archived_at, created_at)
select ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  case when n = 5 then '20000000-0000-4000-8000-000000000002'::uuid
    else '20000000-0000-4000-8000-000000000001'::uuid end,
  case when n in (1, 2) then 'Alex M.' else 'QA excluded ' || n end,
  case when n in (1, 2) then 'alex m.' else 'qa excluded ' || n end,
  'synthetic-private-hash-' || n,
  case when n = 4 then now() else null end,
  '2020-01-01Z'::timestamptz + n * interval '1 second'
from generate_series(1, 6) n;

insert into public.bets(id, pool_id, participant_id, cell_key, payment_status, created_at)
select ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  case when n = 6 then '20000000-0000-4000-8000-000000000002'::uuid
    else '20000000-0000-4000-8000-000000000001'::uuid end,
  ('30000000-0000-4000-8000-' || lpad((case when n = 2 then 1 else n - case when n > 2 then 1 else 0 end end)::text, 12, '0'))::uuid,
  case n when 1 then '2-1' when 2 then '3-3' when 3 then '1-0' when 4 then '0-0' when 5 then '2-2' else '4-4' end,
  case when n in (2, 3) then 'pending' when n = 4 then 'released' else 'paid' end,
  '2020-01-01Z'::timestamptz + n * interval '1 second'
from generate_series(1, 6) n;

set local role anon;
do $$
declare result jsonb;
begin
  result := public.get_public_pool_state('qa-directory-1')->'publicParticipations';
  assert result = '[{"name":"Alex M.","cellKeys":["2-1","3-3"]},{"name":"Alex M.","cellKeys":["1-0"]}]'::jsonb,
    'Directory must keep homonyms separate, include pending/paid, and exclude released/archived/other pools';
  assert public.get_public_pool_state('qa-directory-2')->'publicParticipations'
    = '[{"name":"QA excluded 5","cellKeys":["4-4"]}]'::jsonb, 'Pool isolation';
  assert public.get_public_pool_state('qa-directory-3') is null, 'Draft must stay private';
  assert public.get_public_pool_state('qa-directory-4') is null, 'Unpublished must stay private';
  assert public.get_public_pool_state('qa-directory-5')->'publicParticipations' = '[]'::jsonb, 'Empty directory';
  assert public.get_public_pool_state('qa-unknown') is null, 'Unknown pool';
  assert not exists (
    select 1 from jsonb_array_elements(result) person,
      lateral jsonb_object_keys(person) key
    where key not in ('name', 'cellKeys')
  ), 'Only name and cellKeys may be returned';
  begin
    perform 1 from public.participants;
    raise exception 'Anonymous direct participant access must remain forbidden';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role authenticated;
do $$
begin
  assert jsonb_array_length(public.get_public_pool_state('qa-directory-1')->'publicParticipations') = 2,
    'Authenticated RPC must have the same public directory';
  assert not exists (select 1 from public.participants), 'Non-admin RLS must still hide direct participant rows';
end;
$$;

reset role;
update public.pools set status = 'closed' where slug = 'qa-directory-1';
set local role anon;
do $$ begin
  assert jsonb_array_length(public.get_public_pool_state('qa-directory-1')->'publicParticipations') = 2, 'Closed pool';
end; $$;
reset role;
update public.pools set status = 'finished' where slug = 'qa-directory-1';
set local role anon;
do $$ begin
  assert jsonb_array_length(public.get_public_pool_state('qa-directory-1')->'publicParticipations') = 2, 'Finished pool';
end; $$;
reset role;
rollback;

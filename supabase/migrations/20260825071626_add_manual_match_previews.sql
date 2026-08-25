-- Add a compact manual snapshot variant while preserving API-Football snapshots.
create function private.is_valid_manual_preview_highlights(raw_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(raw_value) is distinct from 'array' then false
    else pg_catalog.jsonb_array_length(raw_value) between 1 and 4
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(raw_value) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
          or pg_catalog.char_length(item.value #>> '{}') not between 1 and 180
      )
  end
$$;

create function private.is_valid_manual_match_preview(raw_preview jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(raw_preview) = 'object'
    and pg_catalog.pg_column_size(raw_preview) <= 8192
    and raw_preview ->> 'version' = '1'
    and raw_preview ->> 'provider' = 'manual'
    and (raw_preview - array['version', 'provider', 'fetchedAt', 'homeTeam', 'awayTeam', 'source']::text[]) = '{}'::jsonb
    and pg_catalog.jsonb_typeof(raw_preview -> 'fetchedAt') = 'string'
    and pg_catalog.char_length(raw_preview ->> 'fetchedAt') between 20 and 40
    and (raw_preview ->> 'fetchedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'
    and pg_catalog.jsonb_typeof(raw_preview -> 'homeTeam') = 'object'
    and (raw_preview -> 'homeTeam') - array['highlights']::text[] = '{}'::jsonb
    and private.is_valid_manual_preview_highlights(raw_preview #> '{homeTeam,highlights}')
    and pg_catalog.jsonb_typeof(raw_preview -> 'awayTeam') = 'object'
    and (raw_preview -> 'awayTeam') - array['highlights']::text[] = '{}'::jsonb
    and private.is_valid_manual_preview_highlights(raw_preview #> '{awayTeam,highlights}')
    and pg_catalog.jsonb_typeof(raw_preview -> 'source') = 'object'
    and (raw_preview -> 'source') - array['label', 'url']::text[] = '{}'::jsonb
    and (
      not ((raw_preview -> 'source') ? 'label')
      or (
        pg_catalog.jsonb_typeof(raw_preview #> '{source,label}') = 'string'
        and pg_catalog.char_length(raw_preview #>> '{source,label}') between 1 and 120
      )
    )
    and (
      not ((raw_preview -> 'source') ? 'url')
      or (
        pg_catalog.jsonb_typeof(raw_preview #> '{source,url}') = 'string'
        and pg_catalog.char_length(raw_preview #>> '{source,url}') between 1 and 2048
        and (raw_preview #>> '{source,url}') ~ '^https?://[^[:space:]]+$'
      )
    )
$$;

alter table public.pools
  drop constraint pools_match_preview_shape;

alter table public.pools
  add constraint pools_match_preview_shape check (
    match_preview is null
    or (
      pg_catalog.jsonb_typeof(match_preview) = 'object'
      and match_preview ->> 'version' is not distinct from '1'
      and (
        (
          match_preview ->> 'provider' is not distinct from 'api-football'
          and pg_catalog.pg_column_size(match_preview) <= 32768
          and pg_catalog.jsonb_typeof(match_preview -> 'homeTeam') is not distinct from 'object'
          and pg_catalog.jsonb_typeof(match_preview -> 'awayTeam') is not distinct from 'object'
          and pg_catalog.jsonb_typeof(match_preview -> 'warnings') is not distinct from 'array'
          and pg_catalog.jsonb_typeof(match_preview -> 'source') is not distinct from 'object'
        )
        or private.is_valid_manual_match_preview(match_preview)
      )
    )
  );

create function private.public_manual_match_preview_team(raw_team jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(raw_team) is distinct from 'object' then null
    else pg_catalog.jsonb_build_object(
      'highlights', coalesce((
        select pg_catalog.jsonb_agg(highlight.value order by highlight.ordinality)
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(raw_team -> 'highlights') = 'array'
            then raw_team -> 'highlights' else '[]'::jsonb end
        ) with ordinality as highlight(value, ordinality)
        where highlight.ordinality <= 4
          and pg_catalog.jsonb_typeof(highlight.value) = 'string'
          and pg_catalog.char_length(highlight.value #>> '{}') between 1 and 180
      ), '[]'::jsonb)
    )
  end
$$;

create or replace function private.public_match_preview(raw_preview jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when raw_preview is null
      or pg_catalog.jsonb_typeof(raw_preview) is distinct from 'object'
      or raw_preview ->> 'version' is distinct from '1'
    then null
    when raw_preview ->> 'provider' = 'manual'
    then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'version', private.public_match_preview_text(raw_preview -> 'version'),
      'provider', 'manual',
      'fetchedAt', private.public_match_preview_text(raw_preview -> 'fetchedAt'),
      'homeTeam', private.public_manual_match_preview_team(raw_preview -> 'homeTeam'),
      'awayTeam', private.public_manual_match_preview_team(raw_preview -> 'awayTeam'),
      'source', case
        when pg_catalog.jsonb_typeof(raw_preview -> 'source') = 'object'
        then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'label', case
            when pg_catalog.jsonb_typeof(raw_preview #> '{source,label}') = 'string'
              and pg_catalog.char_length(raw_preview #>> '{source,label}') between 1 and 120
            then raw_preview #> '{source,label}' else null end,
          'url', case
            when pg_catalog.jsonb_typeof(raw_preview #> '{source,url}') = 'string'
              and pg_catalog.char_length(raw_preview #>> '{source,url}') between 1 and 2048
              and (raw_preview #>> '{source,url}') ~ '^https?://[^[:space:]]+$'
            then raw_preview #> '{source,url}' else null end
        ))
        else '{}'::jsonb
      end
    ))
    when raw_preview ->> 'provider' = 'api-football'
    then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
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
    else null
  end
$$;

revoke execute on function private.is_valid_manual_preview_highlights(jsonb)
  from public, anon, authenticated;
revoke execute on function private.is_valid_manual_match_preview(jsonb)
  from public, anon, authenticated;
grant execute on function private.is_valid_manual_preview_highlights(jsonb)
  to authenticated;
grant execute on function private.is_valid_manual_match_preview(jsonb)
  to authenticated;
revoke execute on function private.public_manual_match_preview_team(jsonb)
  from public, anon, authenticated;
revoke execute on function private.public_match_preview(jsonb)
  from public, anon, authenticated;

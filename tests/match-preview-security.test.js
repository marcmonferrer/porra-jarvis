import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20260824072852_add_match_previews.sql", import.meta.url), "utf8");
const edge = await readFile(new URL("../supabase/functions/refresh-match-preview/index.ts", import.meta.url), "utf8");
const provider = await readFile(new URL("../supabase/functions/_shared/api-football-preview.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const repository = await readFile(new URL("../src/repository.js", import.meta.url), "utf8");
const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");

function functionBody(name) {
  const match = migration.match(new RegExp(`create(?: or replace)? function ${name.replace(".", "\\.")}\\([^]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `No s'ha trobat ${name}`);
  return match[0];
}

test("la migració és additiva, nullable, acotada i no crea cap superfície de taula nova", () => {
  assert.match(migration, /alter table public\.pools\s+add column match_preview jsonb/);
  assert.doesNotMatch(migration, /match_preview jsonb not null/i);
  assert.match(migration, /pools_match_preview_shape/);
  assert.match(migration, /jsonb_typeof\(match_preview -> 'homeTeam'\) is not distinct from 'object'/);
  assert.match(migration, /pg_catalog\.pg_column_size\(match_preview\) <= 32768/);
  assert.match(migration, /match_preview ->> 'version' is not distinct from '1'/);
  assert.match(migration, /match_preview ->> 'provider' is not distinct from 'api-football'/);
  assert.doesNotMatch(migration, /create table|create index|alter publication|supabase_realtime/i);
  assert.doesNotMatch(migration, /grant (select|insert|update|delete).*anon/i);
});

test("la projecció pública reconstrueix una whitelist sense IDs del proveïdor ni dades privades", () => {
  const publicState = functionBody("public.get_public_pool_state");
  const sanitizer = functionBody("private.public_match_preview");
  const team = functionBody("private.public_match_preview_team");
  assert.match(publicState, /'matchPreview', private\.public_match_preview\(target_pool\.match_preview\)/);
  assert.doesNotMatch(sanitizer + team, /providerFixtureId|competitionId|providerTeamId|providerPlayerId|paymentInstructions|created_by|token|hash/i);
  assert.match(sanitizer, /when raw_preview is null/);
  for (const field of ["competitionName", "season", "fetchedAt", "kickoffAt", "homeTeam", "awayTeam", "warnings", "source"]) {
    assert.match(sanitizer, new RegExp(`'${field}'`));
  }
  assert.match(migration, /revoke execute on function private\.public_match_preview\(jsonb\)\s+from public, anon, authenticated/);
  assert.match(migration, /revoke execute on function public\.get_public_pool_state\(text\)\s+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_public_pool_state\(text\)\s+to anon, authenticated/);
});

test("l’RPC privilegiada conserva search_path buit i relacions qualificades", () => {
  const body = functionBody("public.get_public_pool_state");
  assert.match(body, /security definer\s+set search_path = ''/);
  for (const relation of ["public.pools", "public.special_bets", "public.bets", "public.participants", "public.match_states", "public.special_results"]) {
    assert.match(body, new RegExp(relation.replace(".", "\\.")));
  }
  assert.doesNotMatch(body, /execute\s+format|execute\s+immediate/i);
});

test("l’Edge Function exigeix JWT i administrador abans del proveïdor i escriu amb RLS d’usuari", () => {
  const authAt = edge.indexOf("supabase.auth.getUser()");
  const adminAt = edge.indexOf('.from("admin_profiles")');
  const poolAt = edge.indexOf('.from("pools")');
  const providerAt = edge.indexOf("const provider = createApiFootballProvider");
  const updateAt = edge.lastIndexOf('.from("pools")');
  const authorizedAt = edge.indexOf("adminAuthorized = true");
  assert.ok(authAt > 0 && authAt < adminAt && adminAt < authorizedAt && authorizedAt < poolAt && poolAt < providerAt && providerAt < updateAt);
  assert.match(edge, /SUPABASE_ANON_KEY/);
  assert.match(edge, /rawBody\.length > 1024/);
  assert.doesNotMatch(edge, /service_role|SERVICE_ROLE|SYNC_SECRET|console\.(log|error)|user_metadata|app_metadata/);
  assert.equal((edge.match(/console\.warn\(warning\)/g) || []).length, 1);
  assert.match(edge, /previewProviderErrorBody\(error, diagnosticAllowed\)/);
  assert.match(edge, /publicError\(error, adminAuthorized\)/);
  assert.match(provider, /return Object\.freeze\(\{ side, errorCode, candidateCount \}\)/);
  assert.doesNotMatch(provider, /JSON\.stringify\((?:error|payload|pool|homePayload|awayPayload)\)/);
  assert.match(provider, /response\.status === 429/);
  assert.match(provider, /MAX_PROVIDER_CALLS = 7/);
  assert.match(provider, /PROVIDER_TIMEOUT_MS = 8_000/);
  assert.match(config, /\[functions\.refresh-match-preview\][^]*verify_jwt = true/);
});

test("les visites públiques només renderitzen el snapshot i mai activen el proveïdor", () => {
  const publicBody = app.slice(app.indexOf("async function renderPublic"), app.indexOf("function liveMarkup"));
  assert.match(publicBody, /matchPreviewMarkup\(pool\.matchPreview, \{ crestUrls: \{ home: pool\.homeImage, away: pool\.awayImage \} \}\)/);
  assert.doesNotMatch(publicBody, /refreshMatchPreview|functions\.invoke|API_FOOTBALL/);
  assert.equal((repository.match(/functions\.invoke\("refresh-match-preview"/g) || []).length, 1);
  assert.doesNotMatch(repository, /API_FOOTBALL_KEY|x-apisports-key/);
});

test("cap mòdul de navegador conté secrets o capçalera del proveïdor", () => {
  assert.doesNotMatch(app + repository, /service_role|SUPABASE_SERVICE_ROLE_KEY|API_FOOTBALL_KEY|x-apisports-key/);
  assert.doesNotMatch(edge, /Deno\.env\.toObject|JSON\.stringify\(error\)/);
});

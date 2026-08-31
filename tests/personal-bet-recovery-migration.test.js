import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260830084619_add_personal_bet_recovery_links.sql", import.meta.url), "utf8");

function functionBody(name) {
  const start = migration.indexOf(`function public.${name}(`);
  assert.ok(start >= 0, `${name} absent`);
  const bodyStart = migration.indexOf("as $$", start);
  const end = migration.indexOf("$$;", bodyStart);
  return migration.slice(start, end + 3);
}

const reservation = () => functionBody("create_public_reservation_with_recovery");

test("la taula privada vincula porra i participant, aplica RLS i nega accés directe", () => {
  assert.match(migration, /create table private\.participant_recovery_tokens/);
  assert.match(migration, /foreign key \(participant_id, pool_id\)\s+references public\.participants\(id, pool_id\)\s+on delete cascade/);
  assert.match(migration, /unique index participant_recovery_tokens_one_active_idx[\s\S]*?where revoked_at is null/);
  assert.match(migration, /create index participant_recovery_tokens_pool_id_idx/);
  assert.match(migration, /alter table private\.participant_recovery_tokens enable row level security/);
  assert.match(migration, /revoke all on table private\.participant_recovery_tokens from public, anon, authenticated/);
  assert.doesNotMatch(migration, /create policy[\s\S]*participant_recovery_tokens/);
});

test("la primera aposta genera 256 bits, desa només SHA-256 i retorna el secret una vegada", () => {
  const body = reservation();
  assert.match(body, /if target_participant\.id is null then[\s\S]*raw_recovery_token := pg_catalog\.encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
  const recoveryInsert = body.slice(
    body.indexOf("insert into private.participant_recovery_tokens("),
    body.indexOf("values (", body.indexOf("insert into private.participant_recovery_tokens("))
  );
  assert.match(body, /insert into private\.participant_recovery_tokens\([\s\S]*?token_hash[\s\S]*?extensions\.digest\(raw_recovery_token, 'sha256'\)/);
  assert.doesNotMatch(recoveryInsert, /raw_recovery_token/);
  assert.match(body, /if created_new_participant then[\s\S]*'recoveryToken', raw_recovery_token/);
  assert.equal((body.match(/'recoveryToken'/g) || []).length, 1);
});

test("la segona aposta reutilitza participant i capacitat sense crear ni retornar un altre token", () => {
  const body = reservation();
  assert.match(body, /extensions\.digest\(existing_recovery_token, 'sha256'\)/);
  assert.match(body, /participant\.normalized_name = normalized/);
  assert.match(body, /new_participant_id := target_participant\.id/);
  assert.match(body, /if target_participant\.id is null then[\s\S]*insert into private\.participant_recovery_tokens/);
  assert.match(body, /if created_new_participant then[\s\S]*return base_response[\s\S]*end if;\s+return base_response;/);
  assert.doesNotMatch(body.slice(body.lastIndexOf("return base_response;")), /recoveryToken|raw_recovery_token/);
});

test("sense la capacitat local una segona reserva no filtra ni regenera el secret", () => {
  const body = reservation();
  assert.match(body, /elsif exists \([\s\S]*join private\.participant_recovery_tokens recovery[\s\S]*raise exception 'No s’ha pogut recuperar aquesta aposta\.'/);
  assert.equal((body.match(/'recoveryToken'/g) || []).length, 1);
  assert.doesNotMatch(body, /select[^;]*raw_recovery_token|return[^;]*existing_recovery_token/);
});

test("creació i reutilització són atòmiques i serialitzen els primers intents concurrents", () => {
  const body = reservation();
  const participantLock = body.indexOf("pg_catalog.pg_advisory_xact_lock");
  const existingLookup = body.indexOf("if existing_recovery_token is not null then");
  const participant = body.indexOf("insert into public.participants");
  const recovery = body.indexOf("insert into private.participant_recovery_tokens");
  const bets = body.indexOf("insert into public.bets");
  assert.ok(participantLock >= 0 && participantLock < existingLookup);
  assert.ok(participant >= 0 && participant < recovery && recovery < bets);
  assert.match(body, /existing_entry_count \+ pg_catalog\.cardinality\(sorted_cells\) > 2/);
  assert.match(body, /pg_advisory_xact_lock[\s\S]*?:cell:/);
  assert.match(migration, /unique index participant_recovery_tokens_one_active_idx/);
  assert.doesNotMatch(body, /exception\s+when|commit|dblink|autonomous/i);
});

test("qualsevol error posterior reverteix invitació, participant, token i apostes", () => {
  const body = reservation();
  assert.ok(body.indexOf("set usage_count = usage_count + 1") < body.indexOf("insert into public.participants"));
  assert.ok(body.indexOf("insert into private.participant_recovery_tokens") < body.indexOf("insert into public.bets"));
  assert.doesNotMatch(body, /commit|dblink|autonomous/i);
});

test("l’enllaç original recupera totes les apostes del mateix participant", () => {
  const body = functionBody("get_personal_bet_state");
  assert.match(body, /where bet\.participant_id = target_participant\.id\s+and bet\.pool_id = target_pool\.id/);
  assert.doesNotMatch(body, /limit\s+1[\s\S]*from public\.bets/);
});

test("validació personal és defensiva i uniforme per format, pool, expiració i revocació", () => {
  const body = functionBody("get_personal_bet_state");
  assert.match(body, /octet_length\(raw_recovery_token\) <> 64/);
  assert.match(body, /raw_recovery_token !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /pool_identifier[\s\S]*?not between 1 and 100/);
  assert.match(body, /recovery\.revoked_at is null/);
  assert.match(body, /recovery\.expires_at is null or recovery\.expires_at > pg_catalog\.now\(\)/);
  assert.match(body, /pool\.slug = pg_catalog\.btrim\(pool_identifier\) or pool\.id::text = pg_catalog\.btrim\(pool_identifier\)/);
  assert.doesNotMatch(body, /raise exception/);
});

test("la projecció personal és allowlisted i aïlla participants", () => {
  const body = functionBody("get_personal_bet_state");
  const projection = body.slice(body.indexOf("return pg_catalog.jsonb_build_object"));
  assert.match(projection, /'pool'[\s\S]*?'participant'[\s\S]*?'bets'[\s\S]*?'match'[\s\S]*?'final'/);
  assert.match(projection, /'paymentStatus'|'createdAt'|'amountCents'|'prizeCents'/);
  assert.doesNotMatch(projection, /'participantId'|'poolId'|'tokenHash'|'recoveryToken'|'invitationToken'|'providerFixtureId'/);
  assert.doesNotMatch(projection, /token_hash|raw_recovery_token|target_recovery\.id/);
});

test("RPC amb nom únic evita overload i conserva wrapper, search_path i grants mínims", () => {
  assert.equal((migration.match(/create function public\.create_public_reservation_with_recovery\(/g) || []).length, 1);
  assert.equal((migration.match(/create or replace function public\.create_public_reservation\(/g) || []).length, 1);
  assert.match(reservation(), /security definer\s+set search_path = ''/);
  assert.match(functionBody("create_public_reservation"), /security invoker\s+set search_path = ''[\s\S]*public\.create_public_reservation_with_recovery/);
  assert.match(functionBody("get_personal_bet_state"), /security definer\s+set search_path = ''/);
  for (const signature of [
    "create_public_reservation_with_recovery\\(text, text, text\\[\\], text, text\\)",
    "create_public_reservation\\(text, text, text\\[\\], text\\)",
    "get_personal_bet_state\\(text, text\\)"
  ]) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature}\\s+to anon, authenticated`));
  }
  assert.doesNotMatch(migration, /grant execute[\s\S]*service_role/);
});

test("tracking legacy, projecció pública i files existents continuen intactes sense backfill", () => {
  assert.doesNotMatch(migration, /drop function public\.get_tracking_state|create or replace function public\.get_tracking_state/);
  assert.doesNotMatch(migration, /update public\.participants|insert into private\.participant_recovery_tokens\([^;]+\)\s*select/);
  assert.doesNotMatch(migration, /create or replace function public\.get_public_pool_state/);
  assert.doesNotMatch(migration, /alter table public\.participants\s+drop|drop column/);
});

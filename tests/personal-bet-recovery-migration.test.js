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

test("la taula privada vincula porra i participant, aplica RLS i nega accés directe", () => {
  assert.match(migration, /create table private\.participant_recovery_tokens/);
  assert.match(migration, /foreign key \(participant_id, pool_id\)\s+references public\.participants\(id, pool_id\)\s+on delete cascade/);
  assert.match(migration, /unique index participant_recovery_tokens_one_active_idx[\s\S]*?where revoked_at is null/);
  assert.match(migration, /create index participant_recovery_tokens_pool_id_idx/);
  assert.match(migration, /alter table private\.participant_recovery_tokens enable row level security/);
  assert.match(migration, /revoke all on table private\.participant_recovery_tokens from public, anon, authenticated/);
  assert.doesNotMatch(migration, /create policy[\s\S]*participant_recovery_tokens/);
});

test("la reserva genera 256 bits, desa només SHA-256 i retorna el secret una vegada", () => {
  const body = functionBody("create_public_reservation");
  assert.match(body, /raw_recovery_token := pg_catalog\.encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
  assert.match(body, /insert into private\.participant_recovery_tokens\([\s\S]*?token_hash[\s\S]*?extensions\.digest\(raw_recovery_token, 'sha256'\)/);
  assert.doesNotMatch(body, /insert into private\.participant_recovery_tokens\([\s\S]*?raw_recovery_token\s*\)/);
  assert.match(body, /'recoveryToken', raw_recovery_token/);
  assert.equal((body.match(/'recoveryToken'/g) || []).length, 1);
});

test("la creació és atòmica i conserva els bloquejos i límits concurrents", () => {
  const body = functionBody("create_public_reservation");
  const participant = body.indexOf("insert into public.participants");
  const recovery = body.indexOf("insert into private.participant_recovery_tokens");
  const bets = body.indexOf("insert into public.bets");
  const response = body.indexOf("return pg_catalog.jsonb_build_object");
  assert.ok(participant >= 0 && participant < recovery && recovery < bets && bets < response);
  assert.match(body, /pg_advisory_xact_lock[\s\S]*?:participant:/);
  assert.match(body, /existing_entry_count \+ pg_catalog\.cardinality\(sorted_cells\) > 2/);
  assert.match(body, /pg_advisory_xact_lock[\s\S]*?:cell:/);
  assert.doesNotMatch(body, /exception\s+when/i);
});

test("errors posteriors reverteixen participant, token, apostes i ús de la invitació", () => {
  const body = functionBody("create_public_reservation");
  assert.ok(body.indexOf("set usage_count = usage_count + 1") < body.indexOf("insert into public.participants"));
  assert.ok(body.indexOf("insert into private.participant_recovery_tokens") < body.indexOf("insert into public.bets"));
  assert.doesNotMatch(body, /commit|dblink|autonomous/i);
});

test("validació personal és defensiva i uniforme per format, pool, expiració i revocació", () => {
  const body = functionBody("get_personal_bet_state");
  assert.match(body, /octet_length\(raw_recovery_token\) <> 64/);
  assert.match(body, /raw_recovery_token !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(body, /pool_identifier[\s\S]*?not between 1 and 100/);
  assert.match(body, /recovery\.revoked_at is null/);
  assert.match(body, /recovery\.expires_at is null or recovery\.expires_at > pg_catalog\.now\(\)/);
  assert.match(body, /pool\.slug = pg_catalog\.btrim\(pool_identifier\) or pool\.id::text = pg_catalog\.btrim\(pool_identifier\)/);
  assert.equal((body.match(/return null;/g) || []).length, 3);
  assert.doesNotMatch(body, /raise exception/);
});

test("la projecció personal és allowlisted i aïlla les apostes del participant", () => {
  const body = functionBody("get_personal_bet_state");
  const projection = body.slice(body.indexOf("return pg_catalog.jsonb_build_object"));
  assert.match(projection, /'pool'[\s\S]*?'participant'[\s\S]*?'bets'[\s\S]*?'match'[\s\S]*?'final'/);
  assert.match(projection, /where bet\.participant_id = target_participant\.id\s+and bet\.pool_id = target_pool\.id/);
  assert.match(projection, /'paymentStatus'|'createdAt'|'amountCents'|'prizeCents'/);
  assert.doesNotMatch(projection, /'participantId'|'poolId'|'tokenHash'|'recoveryToken'|'invitationToken'|'providerFixtureId'/);
  assert.doesNotMatch(projection, /token_hash|raw_recovery_token|target_recovery\.id/);
});

test("les dues RPC mantenen search_path buit i grants mínims", () => {
  for (const name of ["create_public_reservation", "get_personal_bet_state"]) {
    assert.match(functionBody(name), /security definer\s+set search_path = ''/);
  }
  assert.match(migration, /revoke execute on function public\.get_personal_bet_state\(text, text\)\s+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_personal_bet_state\(text, text\)\s+to anon, authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*service_role/);
});

test("participants legacy i projecció pública continuen intactes sense backfill", () => {
  assert.doesNotMatch(migration, /drop function public\.get_tracking_state|create or replace function public\.get_tracking_state/);
  assert.doesNotMatch(migration, /update public\.participants|insert into private\.participant_recovery_tokens\([^;]+\)\s*select/);
  assert.doesNotMatch(migration, /create or replace function public\.get_public_pool_state/);
  assert.doesNotMatch(migration, /alter table public\.participants\s+drop|drop column/);
});

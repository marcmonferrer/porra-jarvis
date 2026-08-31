import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repair = readFileSync(
  new URL("../supabase/migrations/20260830093744_fix_personal_recovery_error_order.sql", import.meta.url),
  "utf8"
);

function repairedReservation() {
  const start = repair.indexOf("create or replace function public.create_public_reservation_with_recovery(");
  assert.ok(start >= 0, "repaired reservation RPC absent");
  const bodyStart = repair.indexOf("as $$", start);
  const end = repair.indexOf("$$;", bodyStart);
  return repair.slice(start, end + 3);
}

test("la reparació valida la capacitat abans de revelar el límit del participant", () => {
  const body = repairedReservation();
  const capabilityGate = body.indexOf("if existing_recovery_token is not null then");
  const missingCapabilityGate = body.indexOf("elsif exists (");
  const participantCount = body.indexOf("select pg_catalog.count(*)\n  into existing_entry_count");

  assert.ok(capabilityGate >= 0 && capabilityGate < participantCount);
  assert.ok(missingCapabilityGate > capabilityGate && missingCapabilityGate < participantCount);
  assert.match(
    body.slice(capabilityGate, participantCount),
    /raise exception 'No s’ha pogut recuperar aquesta aposta\.';/
  );
});

test("token incorrecte, revocat, expirat o d’un altre pool conserva el mateix error genèric", () => {
  const body = repairedReservation();
  const capabilityGate = body.indexOf("if existing_recovery_token is not null then");
  const participantCount = body.indexOf("select pg_catalog.count(*)\n  into existing_entry_count");
  const validation = body.slice(capabilityGate, participantCount);

  assert.match(validation, /recovery\.pool_id = target_pool\.id/);
  assert.match(validation, /extensions\.digest\(existing_recovery_token, 'sha256'\)/);
  assert.match(validation, /recovery\.revoked_at is null/);
  assert.match(validation, /recovery\.expires_at is null or recovery\.expires_at > pg_catalog\.now\(\)/);
  assert.match(validation, /participant\.normalized_name = normalized/);
  assert.match(validation, /if not found then\s+raise exception 'No s’ha pogut recuperar aquesta aposta\.';/);
});

test("la reparació és limitada, segura i conserva la signatura pública", () => {
  const body = repairedReservation();

  assert.equal((repair.match(/create or replace function public\.create_public_reservation_with_recovery\(/g) || []).length, 1);
  assert.doesNotMatch(repair, /create table|alter table|drop function|grant execute|revoke execute/i);
  assert.match(body, /target_pool_id text,[\s\S]*existing_recovery_token text[\s\S]*returns jsonb/);
  assert.match(body, /security definer\s+set search_path = ''/);
  assert.doesNotMatch(body, /commit|dblink|autonomous|service_role/i);
});

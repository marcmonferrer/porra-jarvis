import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20260828200050_add_complete_configurable_pool_rules.sql", import.meta.url), "utf8");

test("la migració de regles és additiva, nullable i acotada", () => {
  assert.match(sql, /alter table public\.pools[\s\S]*add column organizer_note text[\s\S]*add column organizer_contact text/);
  assert.match(sql, /char_length\(organizer_note\) <= 400/);
  assert.match(sql, /char_length\(organizer_contact\) <= 120/);
  assert.doesNotMatch(sql, /drop table|drop column|disable row level security/i);
});

test("la projecció pública només afegeix els dos camps públics documentats", () => {
  assert.match(sql, /'organizerNote', target_pool\.organizer_note/);
  assert.match(sql, /'organizerContact', target_pool\.organizer_contact/);
  assert.doesNotMatch(sql, /paymentInstructions|tracking_token|token_hash|created_by/);
  assert.match(sql, /'matchPreview', private\.public_match_preview\(target_pool\.match_preview\)/);
});

test("get_public_pool_state conserva search_path, grants i superfície pública mínima", () => {
  assert.match(sql, /create or replace function public\.get_public_pool_state\(pool_identifier text\)/);
  assert.match(sql, /security definer\s+set search_path = ''/);
  assert.match(sql, /revoke execute on function public\.get_public_pool_state\(text\)\s+from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_public_pool_state\(text\)\s+to anon, authenticated/);
  assert.doesNotMatch(sql, /grant (select|insert|update|delete)/i);
});

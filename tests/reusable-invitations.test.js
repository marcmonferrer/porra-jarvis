import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SupabaseRepository } from "../src/repository.js";

const migration = await readFile(new URL("../supabase/migrations/20260828195016_add_reusable_pool_share_links.sql", import.meta.url), "utf8");
const statusRepair = await readFile(new URL("../supabase/migrations/20260828204032_fix_pool_share_link_status_lookup.sql", import.meta.url), "utf8");
const poolId = "4932ae42-3868-4785-b102-a96f33075b56";

function body(name) {
  const match = migration.match(new RegExp(`create(?: or replace)? function public\\.${name}\\([^]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("la migració amplia el model privat i manté una sola capacitat reutilitzable activa", () => {
  assert.match(migration, /add column is_reusable boolean not null default false/);
  assert.match(migration, /add column usage_count integer not null default 0 check \(usage_count >= 0\)/);
  assert.match(migration, /create unique index pool_invitations_one_active_share_idx[\s\S]*where is_reusable and revoked_at is null/);
  assert.match(migration, /check \(not is_reusable or \(consumed_at is null and consumed_by is null\)\)/);
});

test("creació i rotació generen 256 bits, desen SHA-256 i retornen el secret només una vegada", () => {
  for (const name of ["admin_create_pool_share_link", "admin_rotate_pool_share_link"]) {
    const sql = body(name);
    assert.match(sql, /extensions\.gen_random_bytes\(32\)/);
    assert.match(sql, /extensions\.digest\(raw_token, 'sha256'\)/);
    assert.match(sql, /private\.require_porra_admin\(\)/);
    assert.match(sql, /security definer set search_path = ''/);
    assert.match(sql, /'shareToken', raw_token/);
    assert.doesNotMatch(sql, /user_metadata|execute\s+format/i);
  }
  const read = body("admin_get_pool_share_link");
  assert.doesNotMatch(read, /shareToken|token_hash|created_by|poolId/);
  assert.match(read, /'usageCount', invitation\.usage_count/);
});

test("la reparació de l'estat declara l'alias de la porra i preserva el contracte privilegiat", () => {
  const match = statusRepair.match(/create or replace function public\.admin_get_pool_share_link\(target_pool_id uuid\)[^]*?\n\$\$;/i);
  assert.ok(match, "missing repaired admin_get_pool_share_link");
  const sql = match[0];
  assert.match(sql, /from private\.pool_invitations invitation\s+join public\.pools pool on pool\.id = invitation\.pool_id/);
  assert.match(sql, /'expiresAt', pool\.closes_at/);
  assert.match(sql, /pool\.status in \('closed', 'finished'\)/);
  assert.match(sql, /private\.require_porra_admin\(\)/);
  assert.match(sql, /stable security definer set search_path = ''/);
  assert.doesNotMatch(sql, /shareToken|invitationToken|token_hash|created_by|poolId/);
  assert.match(statusRepair, /revoke execute on function public\.admin_get_pool_share_link\(uuid\)\s+from public, anon, authenticated/);
  assert.match(statusRepair, /grant execute on function public\.admin_get_pool_share_link\(uuid\)\s+to authenticated/);
});
test("la reserva reutilitzable és serialitzada, no es consumeix i conserva invitacions antigues", () => {
  const sql = body("create_public_reservation");
  assert.match(sql, /and revoked_at is null and \(\(is_reusable\) or \(expires_at > pg_catalog\.now\(\) and consumed_at is null\)\)[\s\S]*for update/);
  assert.match(sql, /if target_invitation\.is_reusable then[\s\S]*usage_count = usage_count \+ 1/);
  assert.match(sql, /else[\s\S]*set consumed_at = pg_catalog\.now\(\)/);
  assert.match(sql, /if not target_invitation\.is_reusable then[\s\S]*set consumed_by/);
  assert.match(sql, /':participant:' \|\| normalized/);
  assert.match(sql, /existing_entry_count \+ pg_catalog\.cardinality\(sorted_cells\) > 2/);
  assert.match(sql, /':cell:' \|\| target_cell/);
});

test("els errors, grants i projeccions no filtren secrets", () => {
  assert.match(migration, /revoke execute on function public\.admin_create_pool_share_link\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_create_pool_share_link\(uuid\) to authenticated/);
  assert.match(migration, /grant execute on function public\.create_public_reservation\(text, text, text\[\], text\) to anon, authenticated/);
  const response = body("create_public_reservation").slice(body("create_public_reservation").lastIndexOf("return"));
  assert.doesNotMatch(response, /shareToken|token_hash|invitation|usageCount|pool_id|participant_id/);
});

test("SupabaseRepository usa UUID i només les tres RPC de share link", async () => {
  const calls = [];
  const client = { async rpc(name, args) { calls.push({ name, args }); return { data: { status: "active" }, error: null }; } };
  const repository = new SupabaseRepository(client);
  await repository.createPoolShareLink(poolId);
  await repository.getPoolShareLink(poolId);
  await repository.rotatePoolShareLink(poolId);
  assert.deepEqual(calls, [
    { name: "admin_create_pool_share_link", args: { target_pool_id: poolId } },
    { name: "admin_get_pool_share_link", args: { target_pool_id: poolId } },
    { name: "admin_rotate_pool_share_link", args: { target_pool_id: poolId } }
  ]);
  await assert.rejects(() => repository.createPoolShareLink(`pool-${poolId}`), /UUID vàlid/);
});

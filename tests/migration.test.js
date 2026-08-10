import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260810143143_porra_live_v1.sql", import.meta.url);
const repositoryUrl = new URL("../src/repository.js", import.meta.url);
const edgeFunctionUrl = new URL("../supabase/functions/sync-live-score/index.ts", import.meta.url);

const sql = await readFile(migrationUrl, "utf8");
const repositorySource = await readFile(repositoryUrl, "utf8");
const edgeFunctionSource = await readFile(edgeFunctionUrl, "utf8");

function functionBody(name) {
  const match = sql.match(new RegExp(`create function ${name.replace(".", "\\.")}\\([^]*?\\n\\$\\$;`, "i"));
  assert.ok(match, `No s'ha trobat la funció ${name}`);
  return match[0];
}

test("la migració inicial té blocs SQL complets i target_phase a la funció correcta", () => {
  assert.equal((sql.match(/\$\$/g) || []).length % 2, 0);
  const reservation = functionBody("public.create_public_reservation");
  const capacity = functionBody("private.validate_bet_capacity");
  assert.match(reservation, /declare[\s\S]*target_phase text;/);
  assert.match(reservation, /select phase into target_phase/);
  assert.doesNotMatch(capacity, /target_phase text;/);
});

test("la reserva pública és atòmica, bloqueja concurrència i rebutja partits iniciats", () => {
  const reservation = functionBody("public.create_public_reservation");
  assert.match(reservation, /for update/);
  assert.match(reservation, /pg_advisory_xact_lock\(hashtextextended\(target_pool\.id::text \|\| ':cell:'/);
  assert.match(reservation, /target_phase in \('first', 'half', 'second', 'final'\)/);
  assert.match(reservation, /now\(\) >= target_pool\.closes_at/);
  assert.match(sql, /active_cell_count >= 2/);
  assert.match(sql, /Participant cannot repeat a cell/);
});

test("anon només rep les tres RPC públiques i la lectura mínima de revisions", () => {
  assert.match(sql, /revoke all on all tables in schema public from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.create_public_reservation\(text, text, text\[\]\) to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_public_pool_state\(text\) to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.get_tracking_state\(text\) to anon, authenticated/);
  assert.match(sql, /grant select on public\.pool_revisions to anon, authenticated/);
  assert.doesNotMatch(sql, /grant select[^;]*public\.(bets|participants|pools|match_states)[^;]*to anon/i);
});

test("un autenticat no és administrador sense una fila positiva a admin_profiles", () => {
  const check = functionBody("private.is_porra_admin");
  assert.match(check, /public\.admin_profiles/);
  assert.match(check, /user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(sql, /app_metadata|user_metadata|auth\.role\(\)/);
  assert.match(sql, /using \(private\.is_porra_admin\(\)\)/);
});

test("totes les funcions privilegiades tenen search_path buit i EXECUTE revocat", () => {
  for (const name of [
    "private.is_porra_admin",
    "private.require_porra_admin",
    "private.validate_bet_capacity",
    "private.initialize_pool_children",
    "private.bump_pool_revision",
    "public.create_public_reservation",
    "public.get_public_pool_state",
    "public.get_tracking_state",
    "public.admin_update_reservation",
    "public.admin_update_match",
    "public.admin_finalize_pool"
  ]) {
    const body = functionBody(name);
    assert.match(body, /set search_path = ''/);
  }
  assert.match(sql, /revoke execute on all functions in schema public from public, anon, authenticated/);
  assert.match(sql, /revoke execute on all functions in schema private from public, anon, authenticated/);
});

test("RLS està activat a totes les taules públiques", () => {
  for (const table of [
    "admin_profiles", "pools", "special_bets", "participants", "bets",
    "match_states", "special_results", "prize_results", "prize_awards", "pool_revisions"
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

test("les tres operacions administratives són RPC transaccionals protegides", () => {
  for (const name of ["admin_update_reservation", "admin_update_match", "admin_finalize_pool"]) {
    const body = functionBody(`public.${name}`);
    assert.match(body, /security definer/);
    assert.match(body, /private\.require_porra_admin\(\)/);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}[^;]+to authenticated`));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}[^;]+to anon`));
  }
  assert.match(functionBody("public.admin_finalize_pool"), /Prize awards do not conserve the pool/);
});

test("Realtime publica només la revisió segura i tots els canvis rellevants l'incrementen", () => {
  assert.match(sql, /alter publication supabase_realtime add table public\.pool_revisions/);
  for (const table of ["bets", "match_states", "pools", "special_results"]) {
    assert.match(sql, new RegExp(`alter publication supabase_realtime drop table public\\.${table}`));
  }
  for (const trigger of ["bets_bump_revision", "match_states_bump_revision", "special_results_bump_revision"]) {
    assert.match(sql, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(sql, /revision = revision \+ 1/);
  assert.doesNotMatch(functionBody("private.bump_pool_revision"), /display_name|payment_status|tracking_token|final_home/);
});

test("l'estat públic evita UUIDs, pendents i instruccions de pagament", () => {
  const publicState = functionBody("public.get_public_pool_state");
  assert.match(publicState, /'id', target_pool\.slug/);
  assert.match(publicState, /payment_status = 'paid'/);
  assert.match(publicState, /'occupancy'/);
  assert.doesNotMatch(publicState, /'paymentStatus'|'participantId'|'paymentInstructions'|'trackingToken'/);
  assert.match(functionBody("public.get_tracking_state"), /paymentInstructions/);
  assert.match(functionBody("public.create_public_reservation"), /paymentInstructions/);
});

test("el frontend refresca per RPC i no se subscriu directament a bets", () => {
  assert.match(repositorySource, /rpc\("get_public_pool_state"/);
  assert.match(repositorySource, /table: "pool_revisions"/);
  assert.match(repositorySource, /filter: `pool_slug=eq\.\$\{poolSlug\}`/);
  assert.doesNotMatch(repositorySource, /table: "bets"/);
  assert.match(repositorySource, /CHANNEL_ERROR.*TIMED_OUT.*CLOSED/s);
  assert.match(repositorySource, /removeChannel/);
});

test("supabase-js està fixat a una versió exacta estable", () => {
  assert.match(repositorySource, /@supabase\/supabase-js@2\.111\.0/);
  assert.match(edgeFunctionSource, /@supabase\/supabase-js@2\.111\.0/);
  assert.doesNotMatch(repositorySource, /@supabase\/supabase-js@2["']/);
  assert.doesNotMatch(edgeFunctionSource, /@supabase\/supabase-js@2["']/);
});

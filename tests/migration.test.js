import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/202608090001_porra_live_v1.sql", import.meta.url);

test("la migració bloqueja de forma transaccional caselles i participants", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(new\.pool_id::text \|\| ':cell:'/);
  assert.match(sql, /active_cell_count >= 2/);
  assert.match(sql, /active_participant_count >= 2/);
  assert.match(sql, /Participant cannot repeat a cell/);
});

test("la migració protegeix les escriptures públiques amb RLS i RPC", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.bets enable row level security/);
  assert.match(sql, /create policy "bets_public_read"/);
  assert.match(sql, /revoke insert, update, delete on public\.participants, public\.bets/);
  assert.match(sql, /create_public_reservation/);
  assert.match(sql, /target_phase in \('first', 'half', 'second', 'final'\)/);
  assert.match(sql, /'winnerParticipations'/);
  assert.match(sql, /'name', winners\.display_name, 'betIds', winners\.bet_ids/);
  assert.match(sql, /b\.payment_status = 'paid'/);
  assert.match(sql, /security definer/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DemoRepository, SupabaseRepository } from "../src/repository.js";

const migration = readFileSync(new URL("../supabase/migrations/20261014175815_add_public_participations.sql", import.meta.url), "utf8");
const previous = readFileSync(new URL("../supabase/migrations/20260828200050_add_complete_configurable_pool_rules.sql", import.meta.url), "utf8");

test("la migració conserva la projecció prèvia i els permisos, afegint només el directori", () => {
  const functionOnly = sql => sql.slice(sql.indexOf("create or replace function"))
    .replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  const withoutDirectory = migration.replace(/    -- Public directory:[\s\S]*?(?=    'winnerParticipations')/, "");
  assert.equal(functionOnly(withoutDirectory), functionOnly(previous));
  const directory = migration.slice(migration.indexOf("'publicParticipations'"), migration.indexOf("'winnerParticipations'"));
  const publicObject = directory.slice(directory.indexOf("jsonb_build_object("), directory.indexOf(") order by people"));
  assert.deepEqual([...publicObject.matchAll(/'([^']+)',/g)].map(match => match[1]), ["name", "cellKeys"]);
  assert.match(directory, /p\.archived_at is null/);
  assert.match(directory, /b\.payment_status in \('pending', 'paid'\)/);
  assert.match(directory, /group by p\.id, p\.display_name, p\.created_at/);
  assert.doesNotMatch(migration, /grant (select|insert|update|delete)|disable row level security|alter table/i);
});

test("demo conserva homònims i només projecta noms i caselles actives de la mateixa porra", async () => {
  const repository = new DemoRepository({ getItem: () => null });
  repository.data.pools = [{ id: "qa", slug: "qa", specials: [], priceCents: 400, poolPerBetCents: 350, feeCents: 50 }];
  repository.data.participants = [
    { id: "p1", poolId: "qa", name: "Alex M.", trackingToken: "synthetic-private" },
    { id: "p2", poolId: "qa", name: "Alex M." },
    { id: "archived", poolId: "qa", name: "Archived", archivedAt: "2026-01-01" }
  ];
  repository.data.bets = [
    { participantId: "p1", poolId: "qa", cellKey: "1-0", paymentStatus: "pending" },
    { participantId: "p1", poolId: "qa", cellKey: "3-3", paymentStatus: "paid" },
    { participantId: "p2", poolId: "qa", cellKey: "2-0", paymentStatus: "paid" },
    { participantId: "p1", poolId: "qa", cellKey: "0-0", paymentStatus: "released" },
    { participantId: "archived", poolId: "qa", cellKey: "4-4", paymentStatus: "paid" },
    { participantId: "p1", poolId: "other", cellKey: "2-2", paymentStatus: "paid" }
  ];
  const state = await repository.getPoolState("qa");
  assert.deepEqual(state.publicParticipations, [
    { name: "Alex M.", cellKeys: ["1-0", "3-3"] },
    { name: "Alex M.", cellKeys: ["2-0"] }
  ]);
});

test("el repositori anònim transmet el directori de l'RPC sense consultar participants privats", async () => {
  const expected = { pool: { id: "qa" }, publicParticipations: [{ name: "Alex M.", cellKeys: ["2-1"] }] };
  const calls = [];
  const repository = new SupabaseRepository({
    async rpc(name, args) { calls.push({ name, args }); return { data: expected, error: null }; },
    from() { throw new Error("No private table access permitted"); }
  });
  repository.isAdmin = async () => false;
  assert.deepEqual(await repository.getPoolState("qa"), expected);
  assert.deepEqual(calls, [{ name: "get_public_pool_state", args: { pool_identifier: "qa" } }]);
});

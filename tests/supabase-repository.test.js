import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ADMIN_POOL_SELECT, DemoRepository, SupabaseRepository } from "../src/repository.js";

const POOL_ID = "6237e206-e429-4cf3-b585-d824c200a004";
const PARTICIPANT_ID = "55ac0225-cecc-4db2-aeba-234f296453c7";
const BET_ONE_ID = "6af67dfc-e2d5-47cd-a99b-c1fe416f8912";
const BET_TWO_ID = "84c0207f-ec2a-438d-bca4-7af370ed6bdb";
const INVITATION_ID = "89202043-8268-4e61-ae9a-48c87056bee1";
const ADMIN_ID = "cf34e45d-fc3e-4258-84a3-5e81edfc5a37";

function rpcClient(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: result, error: null };
    }
  };
}

test("updateReservation delega tota la mutació a una única RPC", async () => {
  const client = rpcClient();
  const repository = new SupabaseRepository(client);
  await repository.updateReservation(PARTICIPANT_ID, {
    name: "Laia",
    bets: [{ id: BET_ONE_ID, cellKey: "1-0" }, { id: BET_TWO_ID, cellKey: "2-1" }]
  });
  assert.deepEqual(client.calls, [{
    name: "admin_update_reservation",
    args: {
      target_participant_id: PARTICIPANT_ID,
      participant_name: "Laia",
      bet_updates: [{ id: BET_ONE_ID, cellKey: "1-0" }, { id: BET_TWO_ID, cellKey: "2-1" }]
    }
  }]);
});

test("updateMatch delega marcador i especials a una única RPC", async () => {
  const client = rpcClient();
  const repository = new SupabaseRepository(client);
  const patch = {
    phase: "half", minute: 45, currentHome: 1, currentAway: 0,
    halfHome: 1, halfAway: 0, finalHome: null, finalAway: null,
    specialStatuses: { "3-3": "pending" }
  };
  await repository.updateMatch(POOL_ID, patch);
  assert.deepEqual(client.calls, [{
    name: "admin_update_match",
    args: { target_pool_id: POOL_ID, match_patch: patch }
  }]);
});

test("finalizePool calcula una vegada i desa amb una única RPC transaccional", async () => {
  const client = rpcClient();
  const repository = new SupabaseRepository(client);
  repository.getPoolState = async () => ({
    pool: { id: POOL_ID, poolPerBetCents: 350, carryoverCents: 0 },
    bets: [{ id: BET_ONE_ID, participantId: PARTICIPANT_ID, cellKey: "1-0", paymentStatus: "paid" }],
    match: {
      phase: "final", minute: 90, currentHome: 1, currentAway: 0,
      halfHome: 1, halfAway: 0, finalHome: 1, finalAway: 0,
      specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" }
    },
    metrics: { pendingPlaces: 0 }
  });
  const result = await repository.finalizePool(POOL_ID);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "admin_finalize_pool");
  assert.equal(client.calls[0].args.prize_calculation.totalPotCents, 350);
  assert.deepEqual(result, { ok: true });
});

test("la subscripció Realtime usa només pool_revisions i es pot netejar", () => {
  const observed = {};
  const channel = {
    on(_kind, filter, listener) {
      observed.filter = filter;
      observed.listener = listener;
      return this;
    },
    subscribe(statusListener) {
      observed.statusListener = statusListener;
      return this;
    }
  };
  const client = {
    channel(name) { observed.name = name; return channel; },
    removeChannel(value) { observed.removed = value; return Promise.resolve(); }
  };
  const repository = new SupabaseRepository(client);
  const unsubscribe = repository.subscribe("classic-2026", () => {});
  assert.deepEqual(observed.filter, {
    event: "UPDATE", schema: "public", table: "pool_revisions", filter: "pool_slug=eq.classic-2026"
  });
  unsubscribe();
  assert.equal(observed.removed, channel);
});

test("l'estat públic sempre es torna a carregar mitjançant la RPC sanejada", async () => {
  const expected = { pool: { id: "classic-2026", slug: "classic-2026" } };
  const client = rpcClient(expected);
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.getPublicPoolState("classic-2026"), expected);
  assert.deepEqual(client.calls, [{
    name: "get_public_pool_state",
    args: { pool_identifier: "classic-2026" }
  }]);
});

test("la reserva Supabase usa la RPC de recuperació amb capacitat opcional", async () => {
  const invitationToken = "b".repeat(64);
  const recoveryToken = "c".repeat(64);
  const response = {
    token: "tracking-token",
    bets: [{ cellKey: "1-0" }],
    paymentInstructions: "Instruccions privades"
  };
  const client = rpcClient(response);
  const repository = new SupabaseRepository(client);
  repository.getPublicPoolState = async () => ({
    pool: { status: "open", closesAt: "2099-01-01T00:00:00.000Z" },
    match: { phase: "pre" }
  });

  await repository.createReservation({
    poolId: "pool-beta",
    name: "Participant sintètic",
    cellKeys: ["1-0"],
    invitationToken
  });
  const result = await repository.createReservation({
    poolId: "pool-beta",
    name: "Participant sintètic",
    cellKeys: ["2-0"],
    invitationToken,
    recoveryToken
  });

  assert.deepEqual(client.calls, [
    {
      name: "create_public_reservation_with_recovery",
      args: {
        target_pool_id: "pool-beta",
        participant_name: "Participant sintètic",
        selected_cells: ["1-0"],
        invitation_token: invitationToken,
        existing_recovery_token: null
      }
    },
    {
      name: "create_public_reservation_with_recovery",
      args: {
        target_pool_id: "pool-beta",
        participant_name: "Participant sintètic",
        selected_cells: ["2-0"],
        invitation_token: invitationToken,
        existing_recovery_token: recoveryToken
      }
    }
  ]);
  assert.equal(result.token, "tracking-token");
  assert.equal(result.paymentInstructions, "Instruccions privades");
});

test("les operacions administratives d'invitació usen exclusivament UUID natius", async () => {
  const client = rpcClient({ invitationId: INVITATION_ID, status: "active" });
  const repository = new SupabaseRepository(client);
  await repository.createPoolInvitation(POOL_ID, "2099-01-01T00:00:00.000Z");
  await repository.listPoolInvitations(POOL_ID);
  await repository.revokePoolInvitation(INVITATION_ID);
  assert.deepEqual(client.calls, [
    {
      name: "admin_create_pool_invitation",
      args: { target_pool_id: POOL_ID, invitation_expires_at: "2099-01-01T00:00:00.000Z" }
    },
    { name: "admin_list_pool_invitations", args: { target_pool_id: POOL_ID } },
    { name: "admin_revoke_pool_invitation", args: { target_invitation_id: INVITATION_ID } }
  ]);
});

test("el llistat administratiu no fabrica ni demana tokens crus", async () => {
  const listing = [{ invitationId: INVITATION_ID, status: "active", createdAt: "2026-08-12T00:00:00Z" }];
  const client = rpcClient(listing);
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.listPoolInvitations(POOL_ID), listing);
  assert.equal("invitationToken" in listing[0], false);
  assert.equal("token_hash" in listing[0], false);
});

function poolMutationClient() {
  const calls = [];
  const response = {
    id: POOL_ID,
    slug: "beta-pool",
    title: "Beta pool"
  };
  const mutation = {
    select() { return this; },
    async single() { return { data: response, error: null }; }
  };
  return {
    calls,
    auth: { async getSession() { return { data: { session: { user: { id: ADMIN_ID } } }, error: null }; } },
    from(table) {
      return {
        insert(payload) { calls.push({ table, operation: "insert", payload }); return mutation; },
        upsert(payload, options) {
          calls.push({ table, operation: "upsert", payload, options });
          if (table === "special_bets") return Promise.resolve({ error: null });
          return mutation;
        }
      };
    }
  };
}

test("la creació Supabase omet l'id local i adopta l'UUID retornat pel backend", async () => {
  const client = poolMutationClient();
  const repository = new SupabaseRepository(client);
  repository.getPool = async id => ({ id, slug: "beta-pool" });
  const saved = await repository.savePool({
    title: "Beta pool",
    homeTeam: "Local",
    awayTeam: "Visitant",
    matchAt: "2099-01-01T20:00:00.000Z",
    closesAt: "2099-01-01T19:00:00.000Z",
    price: "4",
    poolPerBet: "3.5",
    fee: "0.5",
    paymentInstructions: "Instruccions privades",
    specials: [{ title: "E1" }, { title: "E2" }, { title: "E3" }, { title: "E4" }]
  });
  const poolInsert = client.calls.find(call => call.table === "pools");
  assert.equal(poolInsert.operation, "insert");
assert.equal("id" in poolInsert.payload, false);
  assert.equal("match_preview" in poolInsert.payload, false);
  assert.equal(saved.id, POOL_ID);
  assert.ok(client.calls.filter(call => call.table === "special_bets").every(call =>
    call.payload.every(item => item.pool_id === POOL_ID)
  ));
});

test("els identificadors demo no poden arribar a cap operació de SupabaseRepository", async () => {
  const client = rpcClient();
  client.auth = { async getSession() { return { data: { session: { user: { id: ADMIN_ID } } }, error: null }; } };
  const repository = new SupabaseRepository(client);
  await assert.rejects(() => repository.savePool({ id: `pool-${POOL_ID}` }), /no és un UUID vàlid/);
  const demoPoolId = `pool-${POOL_ID}`;
  const demoParticipantId = `participant-${PARTICIPANT_ID}`;
  const demoBetId = `bet-${BET_ONE_ID}`;
  const blockedOperations = [
    () => repository.refreshMatchPreview(demoPoolId),
    () => repository.saveManualMatchPreview(demoPoolId, {}),
    () => repository.deleteManualMatchPreview(demoPoolId),
    () => repository.publishPool(demoPoolId),
    () => repository.setPoolStatus(demoPoolId, "open"),
    () => repository.createPoolInvitation(demoPoolId, "2099-01-01T00:00:00.000Z"),
    () => repository.listPoolInvitations(demoPoolId),
    () => repository.revokePoolInvitation(`invitation-${INVITATION_ID}`),
    () => repository.updateBet(demoBetId, {}),
    () => repository.updateParticipant(demoParticipantId, "Nom"),
    () => repository.updateReservation(demoParticipantId, { name: "Nom", bets: [{ id: demoBetId, cellKey: "1-0" }] }),
    () => repository.updateReservationPayment(demoParticipantId, "paid"),
    () => repository.updateMatch(demoPoolId, {}),
    () => repository.finalizePool(demoPoolId)
  ];
  for (const operation of blockedOperations) {
    await assert.rejects(operation, /no és un UUID vàlid/);
  }
  assert.deepEqual(client.calls, []);
});

test("la càrrega administrativa rebutja pools que no portin un UUID retornat pel backend", async () => {
  const client = {
    from() {
      return {
        select() { return this; },
        async order() {
          return { data: [{ id: `pool-${POOL_ID}`, slug: "leak", special_bets: [] }], error: null };
        }
      };
    }
  };
  const repository = new SupabaseRepository(client);
  await assert.rejects(() => repository.listAdminPools(), /no és un UUID vàlid/);
});

test("la hidratació administrativa desambigua special_bets amb la FK directa exacta", async () => {
  const observed = {};
  const client = {
    from(table) {
      observed.table = table;
      return {
        select(columns) { observed.columns = columns; return this; },
        async order(column, options) {
          observed.order = { column, options };
          return { data: [], error: null };
        }
      };
    }
  };
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.listAdminPools(), []);
  assert.deepEqual(observed, {
    table: "pools",
    columns: "*, special_bets!special_bets_pool_id_fkey(*)",
    order: { column: "created_at", options: { ascending: false } }
  });
  assert.equal(ADMIN_POOL_SELECT, observed.columns);
});

test("cap loader Supabase conserva l'embed ambigu i tots els loaders admin comparteixen listAdminPools", () => {
  const source = readFileSync(new URL("../src/repository.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /special_bets\(\*\)/);
  assert.equal((source.match(/special_bets!special_bets_pool_id_fkey\(\*\)/g) || []).length, 1);
  assert.match(source, /async listPools[\s\S]*?if \(await this\.isAdmin\(\)\) return this\.listAdminPools\(\)/);
  assert.match(source, /async getPool[\s\S]*?await this\.listAdminPools\(\)/);
  assert.match(source, /async getAdminPoolState[\s\S]*?await this\.listAdminPools\(\)/);
  assert.match(source, /async getPublicPoolState[\s\S]*?rpc\("get_public_pool_state"/);
});

test("DemoRepository conserva els identificadors pool- exclusivament en mode demo", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  const saved = await repository.savePool({ title: "Demo", price: 4, poolPerBet: 3.5, fee: 0.5 });
  assert.match(saved.id, /^pool-[0-9a-f-]+$/);
});
test("la prèvia Supabase envia només l’UUID a l’Edge Function autenticada", async () => {
  const calls = [];
  const expected = { version: "1", provider: "api-football", homeTeam: {}, awayTeam: {} };
  const client = {
    functions: {
      async invoke(name, options) {
        calls.push({ name, options });
        return { data: { matchPreview: expected }, error: null };
      }
    }
  };
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.refreshMatchPreview(POOL_ID), expected);
  assert.deepEqual(calls, [{ name: "refresh-match-preview", options: { body: { poolId: POOL_ID } } }]);
});

test("les escriptures manuals Supabase usen UUID, match_preview i RLS de l'usuari", async () => {
  const calls = [];
  const snapshot = {
    version: "1",
    provider: "manual",
    fetchedAt: "2026-08-25T08:00:00.000Z",
    homeTeam: { highlights: ["Local fort"] },
    awayTeam: { highlights: ["Visitant sòlid"] },
    source: {}
  };
  const client = {
    from(table) {
      return {
        update(payload) {
          const call = { table, payload };
          calls.push(call);
          return {
            eq(column, value) {
              call.filter = { column, value };
              return this;
            },
            select(columns) {
              call.select = columns;
              return this;
            },
            async single() {
              return { data: { match_preview: payload.match_preview }, error: null };
            },
            then(resolve, reject) {
              return Promise.resolve({ error: null }).then(resolve, reject);
            }
          };
        }
      };
    }
  };
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.saveManualMatchPreview(POOL_ID, snapshot), snapshot);
  await repository.deleteManualMatchPreview(POOL_ID);
  assert.deepEqual(calls, [
    {
      table: "pools",
      payload: { match_preview: snapshot },
      filter: { column: "id", value: POOL_ID },
      select: "match_preview"
    },
    {
      table: "pools",
      payload: { match_preview: null },
      filter: { column: "id", value: POOL_ID }
    }
  ]);
});

test("un error de refresh és segur i no modifica el snapshot carregat", async () => {
  const existing = { version: "1", fetchedAt: "2026-08-01T00:00:00Z" };
  const message = "El proveïdor no ha pogut completar la consulta.";
  const client = {
    functions: {
      async invoke() {
return {
          data: null,
          error: {
            context: new Response(JSON.stringify({
              error: "provider_response",
              message,
              diagnostic: { stage: "fixture_request", errorCode: "provider_response", providerIssue: "plan_or_season" }
            }), { status: 502 })
          }
        };
      }
    }
  };
  const repository = new SupabaseRepository(client);
  await assert.rejects(() => repository.refreshMatchPreview(POOL_ID), error => error.message === message);
  assert.deepEqual(existing, { version: "1", fetchedAt: "2026-08-01T00:00:00Z" });
});

test("mapPool hidrata el snapshot administratiu sense alterar-lo", () => {
  const snapshot = { version: "1", provider: "api-football", providerFixtureId: 901 };
  const repository = new SupabaseRepository({});
  const pool = repository.mapPool({
    id: POOL_ID,
    slug: "beta",
    home_team: "Local",
    away_team: "Visitant",
    match_preview: snapshot,
    special_bets: []
  });
  assert.equal(pool.id, POOL_ID);
  assert.equal(pool.matchPreview, snapshot);
});

import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseRepository } from "../src/repository.js";

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
  await repository.updateReservation("participant-1", {
    name: "Laia",
    bets: [{ id: "bet-1", cellKey: "1-0" }, { id: "bet-2", cellKey: "2-1" }]
  });
  assert.deepEqual(client.calls, [{
    name: "admin_update_reservation",
    args: {
      target_participant_id: "participant-1",
      participant_name: "Laia",
      bet_updates: [{ id: "bet-1", cellKey: "1-0" }, { id: "bet-2", cellKey: "2-1" }]
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
  await repository.updateMatch("pool-1", patch);
  assert.deepEqual(client.calls, [{
    name: "admin_update_match",
    args: { target_pool_id: "pool-1", match_patch: patch }
  }]);
});

test("finalizePool calcula una vegada i desa amb una única RPC transaccional", async () => {
  const client = rpcClient();
  const repository = new SupabaseRepository(client);
  repository.getPoolState = async () => ({
    pool: { id: "pool-1", poolPerBetCents: 350, carryoverCents: 0 },
    bets: [{ id: "bet-1", participantId: "p1", cellKey: "1-0", paymentStatus: "paid" }],
    match: {
      phase: "final", minute: 90, currentHome: 1, currentAway: 0,
      halfHome: 1, halfAway: 0, finalHome: 1, finalAway: 0,
      specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" }
    },
    metrics: { pendingPlaces: 0 }
  });
  const result = await repository.finalizePool("pool-1");
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

test("la reserva Supabase envia la invitació només a la RPC de quatre arguments", async () => {
  const invitationToken = "b".repeat(64);
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
  const result = await repository.createReservation({
    poolId: "pool-beta",
    name: "Participant sintètic",
    cellKeys: ["1-0"],
    invitationToken
  });
  assert.deepEqual(client.calls, [{
    name: "create_public_reservation",
    args: {
      target_pool_id: "pool-beta",
      participant_name: "Participant sintètic",
      selected_cells: ["1-0"],
      invitation_token: invitationToken
    }
  }]);
  assert.equal(result.token, "tracking-token");
  assert.equal(result.paymentInstructions, "Instruccions privades");
});

test("les operacions administratives d'invitació usen exclusivament les RPC previstes", async () => {
  const client = rpcClient({ invitationId: "invitation-1", status: "active" });
  const repository = new SupabaseRepository(client);
  await repository.createPoolInvitation("pool-1", "2099-01-01T00:00:00.000Z");
  await repository.listPoolInvitations("pool-1");
  await repository.revokePoolInvitation("invitation-1");
  assert.deepEqual(client.calls, [
    {
      name: "admin_create_pool_invitation",
      args: { target_pool_id: "pool-1", invitation_expires_at: "2099-01-01T00:00:00.000Z" }
    },
    { name: "admin_list_pool_invitations", args: { target_pool_id: "pool-1" } },
    { name: "admin_revoke_pool_invitation", args: { target_invitation_id: "invitation-1" } }
  ]);
});

test("el llistat administratiu no fabrica ni demana tokens crus", async () => {
  const listing = [{ invitationId: "invitation-1", status: "active", createdAt: "2026-08-12T00:00:00Z" }];
  const client = rpcClient(listing);
  const repository = new SupabaseRepository(client);
  assert.deepEqual(await repository.listPoolInvitations("pool-1"), listing);
  assert.equal("invitationToken" in listing[0], false);
  assert.equal("token_hash" in listing[0], false);
});

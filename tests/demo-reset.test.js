import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_RESET_CONFIRMATION,
  isDemoResetAvailable,
  resetDemoSafely
} from "../src/demo-reset.js";

function harness({ mode = "demo", confirmed = true } = {}) {
  const calls = [];
  let activeTracking = "tracking-actiu";
  const repository = {
    mode,
    async resetDemo() { calls.push("reset"); }
  };
  return {
    repository,
    calls,
    get activeTracking() { return activeTracking; },
    options: {
      repository,
      confirmReset(message) { calls.push(["confirm", message]); return confirmed; },
      clearActiveState() { calls.push("clear"); activeTracking = ""; },
      async reloadAdmin() { calls.push("reload"); },
      notify(message) { calls.push(["notify", message]); }
    }
  };
}

test("el control de reinici només està disponible en mode demo", () => {
  assert.equal(isDemoResetAvailable({ mode: "demo", resetDemo() {} }), true);
  assert.equal(isDemoResetAvailable({ mode: "supabase", resetDemo() {} }), false);
  assert.equal(isDemoResetAvailable({ mode: "demo" }), false);
});

test("cancel·lar el reinici no modifica cap estat", async () => {
  const context = harness({ confirmed: false });
  const result = await resetDemoSafely(context.options);
  assert.deepEqual(result, { reset: false, reason: "cancelled" });
  assert.deepEqual(context.calls, [["confirm", DEMO_RESET_CONFIRMATION]]);
  assert.equal(context.activeTracking, "tracking-actiu");
});

test("confirmar reinicia, neteja tracking, recarrega i notifica en ordre", async () => {
  const context = harness();
  const result = await resetDemoSafely(context.options);
  assert.deepEqual(result, { reset: true });
  assert.equal(context.activeTracking, "");
  assert.deepEqual(context.calls, [
    ["confirm", DEMO_RESET_CONFIRMATION],
    "reset",
    "clear",
    "reload",
    ["notify", "Demo reiniciada correctament"]
  ]);
});

test("el mode Supabase no mostra ni executa el control", async () => {
  const context = harness({ mode: "supabase" });
  assert.equal(isDemoResetAvailable(context.repository), false);
  const result = await resetDemoSafely(context.options);
  assert.deepEqual(result, { reset: false, reason: "unavailable" });
  assert.deepEqual(context.calls, []);
});

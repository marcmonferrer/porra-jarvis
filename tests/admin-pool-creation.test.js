import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAdminPoolCreationFlow, resolveAdminPoolView } from "../src/admin-pool-creation.js";

const openPool = { id: "open-pool", status: "open", title: "Oberta" };
const closedPool = { id: "closed-pool", status: "closed", title: "Tancada" };

test("zero pools keeps the blank creation form available", () => {
  assert.deepEqual(resolveAdminPoolView([], null), { selectedPool: null, formPool: null });
});

test("open and closed pools remain selected until explicit creation starts", () => {
  assert.equal(resolveAdminPoolView([openPool], openPool.id).formPool, openPool);
  assert.equal(resolveAdminPoolView([closedPool], closedPool.id).formPool, closedPool);
  assert.equal(resolveAdminPoolView([closedPool, openPool], openPool.id).formPool, openPool);
});

test("creation opens a blank form without replacing the selected closed pool", () => {
  const view = resolveAdminPoolView([closedPool, openPool], closedPool.id, true);
  assert.equal(view.selectedPool, closedPool);
  assert.equal(view.formPool, null);
});

test("cancelling creation restores the previous pool and tab", () => {
  const flow = createAdminPoolCreationFlow();
  flow.start({ poolId: closedPool.id, tab: "history" });
  assert.equal(flow.active, true);
  assert.deepEqual(flow.cancel(), { poolId: closedPool.id, tab: "history" });
  assert.equal(flow.active, false);
});

test("successful creation returns the backend pool without mutating existing pools", async () => {
  const flow = createAdminPoolCreationFlow();
  const existing = [structuredClone(closedPool), structuredClone(openPool)];
  const snapshot = structuredClone(existing);
  const returned = { id: "46d59e85-4150-4f7c-9270-21f54dc3a607", status: "draft" };
  flow.start({ poolId: closedPool.id, tab: "pool" });
  const result = await flow.save(async () => returned, { title: "Nova" });
  assert.equal(result.pool.id, returned.id);
  assert.deepEqual(existing, snapshot);
  flow.complete();
  assert.equal(flow.active, false);
});

test("repeated submissions cannot create duplicates while a save is in flight", async () => {
  const flow = createAdminPoolCreationFlow();
  let resolveSave;
  let calls = 0;
  const save = () => {
    calls += 1;
    return new Promise(resolve => { resolveSave = resolve; });
  };
  const first = flow.save(save, { title: "Nova" });
  const second = await flow.save(save, { title: "Nova" });
  assert.deepEqual(second, { duplicate: true, pool: null });
  assert.equal(calls, 1);
  resolveSave({ id: "returned-uuid" });
  assert.equal((await first).pool.id, "returned-uuid");
});

test("failed creation preserves caller form data and keeps creation active", async () => {
  const flow = createAdminPoolCreationFlow();
  const draft = { title: "Contingut que no es perd", homeTeam: "A" };
  flow.start({ poolId: closedPool.id, tab: "pool" });
  await assert.rejects(() => flow.save(async () => { throw new Error("RLS"); }, draft), /RLS/);
  assert.deepEqual(draft, { title: "Contingut que no es perd", homeTeam: "A" });
  assert.equal(flow.active, true);
  assert.equal(flow.saving, false);
});

test("app wiring exposes permanent controls and selects the returned backend id", async () => {
  const [appSource, repositorySource] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/repository.js", import.meta.url), "utf8")
  ]);
  assert.match(appSource, /data-action="new-pool"/);
  assert.match(appSource, /data-action="cancel-new-pool"/);
  assert.match(appSource, /currentPoolId = result\.pool\.id/);
  assert.match(appSource, /button\.disabled = true/);
  assert.match(repositorySource, /const mutation = pool\.id \? poolTable\.upsert\(payload\) : poolTable\.insert\(payload\)/);
  assert.match(repositorySource, /requireSupabaseUuid\(data\.id, "pool retornat"\)/);
  assert.match(repositorySource, /pool_id: data\.id/);
  assert.match(repositorySource, /export class DemoRepository/);
});

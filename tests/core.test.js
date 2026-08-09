import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePrizes,
  createPool,
  poolMetrics,
  validateSelection
} from "../src/core.js";
import { DemoRepository } from "../src/repository.js";

const future = "2099-12-31T20:00:00.000Z";
const pool = createPool({
  id: "pool-1",
  title: "Prova",
  homeTeam: "Local",
  awayTeam: "Visitant",
  closesAt: future,
  price: 4,
  poolPerBet: 3.5,
  fee: 0.5,
  status: "open",
  specials: [
    { title: "E1" }, { title: "E2" }, { title: "E3" }, { title: "E4" }
  ]
});

const bet = (id, participantId, cellKey, paymentStatus = "paid") => ({
  id, participantId, poolId: pool.id, cellKey, paymentStatus
});

const match = overrides => ({
  halfHome: 1,
  halfAway: 0,
  finalHome: 2,
  finalAway: 1,
  specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" },
  ...overrides
});

test("cada casella admet dues apostes i rebutja la tercera", () => {
  const bets = [bet("a", "p1", "0-0"), bet("b", "p2", "0-0")];
  const result = validateSelection({ pool, bets, participantId: "p3", cellKeys: ["0-0"] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /completa/);
});

test("cada participant queda limitat a dues apostes", () => {
  const bets = [bet("a", "p1", "0-0"), bet("b", "p1", "1-0")];
  const result = validateSelection({ pool, bets, participantId: "p1", cellKeys: ["2-0"] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /màxim de dues/);
});

test("no permet repetir una casella en la mateixa selecció", () => {
  const result = validateSelection({ pool, bets: [], participantId: "p1", cellKeys: ["1-1", "1-1"] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /repetir/);
});

test("divideix el pot confirmat 25/50/25", () => {
  const bets = [bet("half", "p1", "1-0"), bet("final", "p2", "2-1"), bet("special", "p3", "3-3")];
  const result = calculatePrizes({ pool, bets, match: match({ specialStatuses: { "3-3": "completed" } }) });
  assert.deepEqual(result.allocations, { halfBase: 263, finalBase: 525, specialBase: 262, finalAvailable: 525 });
  assert.equal(result.awards.find(item => item.betId === "half").totalCents, 263);
  assert.equal(result.awards.find(item => item.betId === "final").totalCents, 525);
  assert.equal(result.awards.find(item => item.betId === "special").totalCents, 262);
});

test("dues persones comparteixen a parts iguals una casella guanyadora", () => {
  const bets = [bet("a", "p1", "2-1"), bet("b", "p2", "2-1")];
  const result = calculatePrizes({ pool, bets, match: match({ halfHome: 9, halfAway: 9 }) });
  assert.deepEqual(result.awards.map(item => item.totalCents), [350, 350]);
});

test("diverses especials complertes reparteixen la seva franja per aposta", () => {
  const bets = [bet("a", "p1", "3-3"), bet("b", "p2", "4-4"), bet("c", "p3", "2-1")];
  const result = calculatePrizes({ pool, bets, match: match({ specialStatuses: { "3-3": "completed", "4-4": "completed" } }) });
  const specialAwards = result.awards.filter(item => ["a", "b"].includes(item.betId));
  assert.equal(specialAwards.reduce((sum, item) => sum + item.totalCents, 0), 262);
});

test("una persona pot guanyar amb dues apostes diferents", () => {
  const bets = [bet("a", "p1", "1-0"), bet("b", "p1", "2-1")];
  const result = calculatePrizes({ pool, bets, match: match() });
  assert.equal(result.awards.length, 2);
  assert.equal(result.awards.reduce((sum, item) => sum + item.totalCents, 0), 700);
});

test("les franges sense guanyador passen al resultat final", () => {
  const bets = [bet("final", "p1", "2-1"), bet("other", "p2", "0-0")];
  const result = calculatePrizes({ pool, bets, match: match({ halfHome: 4, halfAway: 2 }) });
  assert.equal(result.awards.find(item => item.betId === "final").totalCents, 700);
});

test("sense guanyador final, la franja final es redistribueix entre descans i especials", () => {
  const bets = [bet("half", "p1", "1-0"), bet("special", "p2", "3-3"), bet("other", "p3", "0-0")];
  const result = calculatePrizes({ pool, bets, match: match({ finalHome: 4, finalAway: 2, specialStatuses: { "3-3": "completed" } }) });
  assert.equal(result.awards.reduce((sum, item) => sum + item.totalCents, 0), 1050);
  assert.ok(result.awards.every(item => item.totalCents > 262));
});

test("si no hi ha cap guanyador, tot el pot queda acumulat", () => {
  const bets = [bet("a", "p1", "0-0")];
  const result = calculatePrizes({ pool, bets, match: match({ halfHome: 2, halfAway: 0, finalHome: 4, finalAway: 2 }) });
  assert.equal(result.carryoverCents, 350);
  assert.deepEqual(result.awards, []);
});

test("afegeix el pot acumulat anterior abans del repartiment", () => {
  const carryPool = { ...pool, carryoverCents: 101 };
  const result = calculatePrizes({ pool: carryPool, bets: [bet("a", "p1", "2-1")], match: match({ halfHome: 9, halfAway: 9 }) });
  assert.equal(result.totalPotCents, 451);
  assert.equal(result.awards[0].totalCents, 451);
});

test("els arrodoniments són deterministes i conserven exactament el pot", () => {
  const centsPool = { ...pool, poolPerBetCents: 1, carryoverCents: 0 };
  const bets = [bet("a", "p1", "2-1"), bet("b", "p2", "2-1"), bet("c", "p3", "2-1")];
  const result = calculatePrizes({ pool: centsPool, bets, match: match({ halfHome: 9, halfAway: 9 }) });
  assert.deepEqual(result.awards.map(item => item.totalCents), [1, 1, 1]);
  assert.equal(result.awards.reduce((sum, item) => sum + item.totalCents, 0), 3);
});

test("les reserves pendents no entren al pot confirmat", () => {
  const bets = [bet("paid", "p1", "2-1", "paid"), bet("pending", "p2", "2-1", "pending")];
  const metrics = poolMetrics(pool, bets);
  const result = calculatePrizes({ pool, bets, match: match({ halfHome: 9, halfAway: 9 }) });
  assert.equal(metrics.confirmedPoolCents, 350);
  assert.equal(metrics.potentialPoolCents, 700);
  assert.equal(result.totalPotCents, 350);
  assert.deepEqual(result.winners.final, ["paid"]);
});

test("tres reserves simultànies no poden obtenir una tercera plaça", async () => {
  const memory = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; }
  };
  const repo = new DemoRepository(memory);
  await repo.savePool(pool);
  const outcomes = await Promise.allSettled([
    repo.createReservation({ poolId: pool.id, name: "A", cellKeys: ["0-0"] }),
    repo.createReservation({ poolId: pool.id, name: "B", cellKeys: ["0-0"] }),
    repo.createReservation({ poolId: pool.id, name: "C", cellKeys: ["0-0"] })
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 2);
  assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
});

test("no permet finalitzar mentre queda una reserva pendent", async () => {
  const memory = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; }
  };
  const repo = new DemoRepository(memory);
  await repo.savePool(pool);
  await repo.createReservation({ poolId: pool.id, name: "Pendent", cellKeys: ["0-0"] });
  await assert.rejects(() => repo.finalizePool(pool.id), /confirmar o alliberar/);
});

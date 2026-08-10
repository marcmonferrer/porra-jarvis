import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistorySummary,
  calculatePrizes,
  createPool,
  finalReceivesRedistribution,
  formatDateTime,
  groupPrizeAwards,
  groupReservations,
  poolMetrics,
  validateMatchUpdate,
  validateSelection,
  winningBetsText
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

test("formata dates en català sense reinterpretar una hora local", () => {
  const localDate = new Date(2026, 8, 1, 21, 0);
  assert.equal(formatDateTime(localDate), "01/09/2026 · 21:00");
  assert.equal(formatDateTime(""), "Per definir");
});

test("agrupa reserves per identificador i manté separats els noms repetits", () => {
  const participants = [{ id: "p1", name: "Alex" }, { id: "p2", name: "Alex" }];
  const bets = [bet("a", "p1", "0-0"), bet("b", "p1", "1-0"), bet("c", "p2", "2-0")];
  const reservations = groupReservations({ pool, participants, bets });
  assert.equal(reservations.length, 2);
  assert.deepEqual(reservations.map(item => item.participantId), ["p1", "p2"]);
  assert.equal(reservations[0].totalCents, 800);
  assert.equal(reservations[1].totalCents, 400);
});

test("aplica el pagament a totes les apostes de la reserva", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repo = new DemoRepository(memory);
  await repo.savePool(pool);
  const reservation = await repo.createReservation({ poolId: pool.id, name: "Dues apostes", cellKeys: ["0-0", "1-0"] });
  await repo.updateReservationPayment(reservation.participant.id, "paid");
  const state = await repo.getPoolState(pool.id);
  assert.ok(state.bets.filter(item => item.participantId === reservation.participant.id).every(item => item.paymentStatus === "paid"));
});

test("desa correccions individuals dins de la mateixa reserva", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repo = new DemoRepository(memory);
  await repo.savePool(pool);
  const reservation = await repo.createReservation({ poolId: pool.id, name: "Original", cellKeys: ["0-0", "1-0"] });
  await repo.updateReservation(reservation.participant.id, {
    name: "Corregit",
    bets: [{ id: reservation.bets[0].id, cellKey: "2-0" }, { id: reservation.bets[1].id, cellKey: "1-0" }]
  });
  const state = await repo.getPoolState(pool.id);
  assert.equal(state.participants[0].name, "Corregit");
  assert.deepEqual(state.bets.map(item => item.cellKey), ["2-0", "1-0"]);
});

test("escriu correctament singulars i plurals de guanyadores", () => {
  assert.equal(winningBetsText(1), "1 aposta guanyadora");
  assert.equal(winningBetsText(2), "2 apostes guanyadores");
});

test("agrupa premis per participació sense fusionar persones amb el mateix nom", () => {
  const participants = [{ id: "p1", name: "Alex" }, { id: "p2", name: "Alex" }];
  const bets = [bet("a", "p1", "2-1"), bet("b", "p2", "2-1")];
  const result = calculatePrizes({ pool, bets, match: match({ halfHome: 9, halfAway: 9 }) });
  const summaries = groupPrizeAwards({ awards: result.awards, bets, participants });
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map(item => item.participantId), ["p1", "p2"]);
  assert.equal(summaries.reduce((sum, item) => sum + item.totalCents, 0), result.totalPotCents);
});

test("indica redistribució només quan la franja final rep diners addicionals", () => {
  const receives = calculatePrizes({ pool, bets: [bet("final", "p1", "2-1")], match: match({ halfHome: 9, halfAway: 9 }) });
  const balanced = calculatePrizes({ pool, bets: [bet("half", "p1", "1-0"), bet("final", "p2", "2-1"), bet("special", "p3", "3-3")], match: match({ specialStatuses: { "3-3": "completed" } }) });
  assert.equal(finalReceivesRedistribution(receives), true);
  assert.equal(finalReceivesRedistribution(balanced), false);
});

test("valida la fase final i sincronitza el marcador actual", () => {
  const invalidMinute = validateMatchUpdate({ match: { ...match({}), phase: "final", minute: -1 } });
  assert.equal(invalidMinute.valid, false);
  assert.match(invalidMinute.errors.join(" "), /minut/);
  const incomplete = validateMatchUpdate({ match: { ...match({ halfHome: null, finalHome: null, specialStatuses: { "3-3": "pending" } }), phase: "final", minute: 90 } });
  assert.equal(incomplete.valid, false);
  assert.match(incomplete.errors.join(" "), /descans/);
  assert.match(incomplete.errors.join(" "), /resultat final/);
  assert.match(incomplete.errors.join(" "), /especials/);
  const complete = validateMatchUpdate({
    match: { ...match({ specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" } }), phase: "final", minute: 90, currentHome: 0, currentAway: 0 },
    pendingPlaces: 1
  });
  assert.equal(complete.valid, true);
  assert.equal(complete.syncedScore, true);
  assert.deepEqual([complete.match.currentHome, complete.match.currentAway], [2, 1]);
  assert.match(complete.warnings.join(" "), /pagament pendent/);
});

test("el resum històric és de només lectura i conserva totals", () => {
  const bets = [bet("winner", "p1", "2-1")];
  const prizeResult = calculatePrizes({ pool, bets, match: match({ halfHome: 9, halfAway: 9 }) });
  const finishedPool = { ...pool, status: "finished" };
  const summary = buildHistorySummary({ pool: finishedPool, bets, participants: [{ id: "p1", name: "Guanyador" }], prizeResult, metrics: poolMetrics(finishedPool, bets) });
  assert.equal(summary.readOnly, true);
  assert.equal(summary.paidCount, 1);
  assert.equal(summary.finalPotCents, prizeResult.totalPotCents);
  assert.equal(summary.distributedCents + summary.carryoverCents, summary.finalPotCents);
  assert.equal(summary.winners.length, 1);
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

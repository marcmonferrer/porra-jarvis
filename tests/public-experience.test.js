import assert from "node:assert/strict";
import test from "node:test";
import { calculatePrizes, createPool } from "../src/core.js";
import {
  STARTED_BETS_MESSAGE,
  finalResultCellState,
  finalSummaryState,
  halfTimeCellState,
  halfTimeOutcome,
  participationState,
  publicPhasePresentation,
  showPublicLiveScorebar,
  trackingFinalState,
  trackingHalfTimeState
} from "../src/public-experience.js";
import { DemoRepository } from "../src/repository.js";

const pool = createPool({
  id: "half-pool",
  title: "Clàssic",
  homeTeam: "FC Barcelona",
  awayTeam: "Real Madrid",
  closesAt: "2099-12-31T20:00:00.000Z",
  price: 4,
  poolPerBet: 3.5,
  fee: 0.5,
  status: "open",
  specials: [{ title: "E1" }, { title: "E2" }, { title: "E3" }, { title: "E4" }]
});

const participant = (id, name) => ({ id, poolId: pool.id, name });
const bet = (id, participantId, cellKey, paymentStatus = "paid") => ({ id, participantId, poolId: pool.id, cellKey, paymentStatus });
const halfMatch = overrides => ({
  phase: "half",
  minute: 45,
  currentHome: 3,
  currentAway: 1,
  halfHome: 3,
  halfAway: 1,
  finalHome: null,
  finalAway: null,
  specialStatuses: { "3-3": "pending", "3-4": "pending", "4-3": "pending", "4-4": "pending" },
  ...overrides
});
const finalMatch = overrides => halfMatch({
  phase: "final",
  minute: 70,
  currentHome: 2,
  currentAway: 2,
  halfHome: 1,
  halfAway: 0,
  finalHome: 2,
  finalAway: 2,
  specialStatuses: { "3-3": "completed", "3-4": "failed", "4-3": "failed", "4-4": "failed" },
  ...overrides
});

test("bloqueja participacions quan el partit està en joc, al descans o final", () => {
  for (const phase of ["first", "half", "second", "final"]) {
    const state = participationState({ pool, match: halfMatch({ phase }) });
    assert.equal(state.open, false);
    assert.equal(state.message, STARTED_BETS_MESSAGE);
  }
  assert.equal(participationState({ pool, match: halfMatch({ phase: "pre" }) }).open, true);
});

test("el repositori rebutja reserves quan el partit ja ha començat", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  await repository.savePool(pool);
  await repository.updateMatch(pool.id, halfMatch({ phase: "first" }));
  await assert.rejects(
    () => repository.createReservation({ poolId: pool.id, name: "Tard", cellKeys: ["0-0"] }),
    new RegExp(STARTED_BETS_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("identifica inequívocament la casella del resultat del descans", () => {
  assert.deepEqual(halfTimeCellState(halfMatch(), "3-1"), { isResult: true, accessibleLabel: "Resultat del descans" });
  assert.deepEqual(halfTimeCellState(halfMatch(), "2-1"), { isResult: false, accessibleLabel: "" });
});

test("mostra el nom real d'un únic guanyador pagat amb la franja exacta del descans", () => {
  const bets = [bet("winner", "p1", "3-1")];
  const outcome = halfTimeOutcome({ pool, bets, participants: [participant("p1", "Laia Ferrer")], match: halfMatch() });
  const engine = calculatePrizes({ pool, bets, match: halfMatch() });
  assert.equal(outcome.winners.length, 1);
  assert.equal(outcome.winners[0].name, "Laia Ferrer");
  assert.equal(outcome.winners[0].cents, engine.allocations.halfBase);
});

test("utilitza el nom real inclòs a l'estat públic sense exposar un identificador de participació", () => {
  const publicBet = { id: "public-winner", poolId: pool.id, cellKey: "3-1", paymentStatus: "paid" };
  const outcome = halfTimeOutcome({ pool, bets: [publicBet], winnerParticipations: [{ name: "Núria Soler", betIds: ["public-winner"] }], match: halfMatch() });
  assert.equal(outcome.winners.length, 1);
  assert.equal(outcome.winners[0].name, "Núria Soler");
});

test("reparteix la franja del descans entre diverses apostes pagades", () => {
  const bets = [bet("a", "p1", "3-1"), bet("b", "p2", "3-1")];
  const outcome = halfTimeOutcome({ pool, bets, participants: [participant("p1", "Alex Puig"), participant("p2", "Alex Puig")], match: halfMatch() });
  assert.equal(outcome.winners.length, 2);
  assert.deepEqual(outcome.winners.map(winner => winner.name), ["Alex Puig", "Alex Puig"]);
  assert.notEqual(outcome.winners[0].participantKey, outcome.winners[1].participantKey);
  assert.equal(outcome.winners.reduce((sum, winner) => sum + winner.cents, 0), outcome.potCents);
});

test("una aposta coincident pendent de pagament no és guanyadora", () => {
  const pending = bet("pending", "p1", "3-1", "pending");
  const outcome = halfTimeOutcome({ pool, bets: [pending], participants: [participant("p1", "Pendent")], match: halfMatch() });
  const tracking = trackingHalfTimeState({ pool, match: halfMatch(), bet: { ...pending, halfPrizeCents: 0 } });
  assert.equal(outcome.winners.length, 0);
  assert.equal(tracking.won, false);
  assert.match(tracking.label, /pagament no està confirmat/);
});

test("sense guanyador, la franja del descans segueix la redistribució existent", () => {
  const bets = [bet("final", "p1", "2-1")];
  const outcome = halfTimeOutcome({ pool, bets, participants: [participant("p1", "Finalista")], match: halfMatch({ halfHome: 1, halfAway: 0 }) });
  const finalEngine = calculatePrizes({ pool, bets, match: halfMatch({ phase: "final", halfHome: 1, halfAway: 0, finalHome: 2, finalAway: 1 }) });
  assert.equal(outcome.winners.length, 0);
  assert.equal(outcome.disposition, "redistribute-to-final");
  assert.ok(finalEngine.allocations.finalAvailable > finalEngine.allocations.finalBase);
  assert.equal(finalEngine.awards[0].totalCents, finalEngine.totalPotCents);
});

test("La meva aposta queda en només lectura i identifica el premi del descans", () => {
  const state = trackingHalfTimeState({ pool, match: halfMatch(), bet: { ...bet("winner", "p1", "3-1"), halfPrizeCents: 88 } });
  assert.equal(state.readOnly, true);
  assert.equal(state.won, true);
  assert.equal(state.label, "Guanyadora del descans");
});

test("La meva aposta conserva el nom real de la participació guanyadora", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  await repository.savePool(pool);
  const reservation = await repository.createReservation({ poolId: pool.id, name: "Júlia Casals", cellKeys: ["3-1"] });
  await repository.updateReservationPayment(reservation.participant.id, "paid");
  await repository.updateMatch(pool.id, halfMatch());
  const tracking = await repository.getTracking(reservation.token);
  assert.equal(tracking.participant.name, "Júlia Casals");
  assert.ok(tracking.bets[0].halfPrizeCents > 0);
});

test("Final substitueix Partit en curs i oculta el minut", () => {
  const presentation = publicPhasePresentation(finalMatch());
  assert.equal(presentation.heading, "FINAL");
  assert.notEqual(presentation.heading, "Partit en curs");
  assert.equal(presentation.showMinute, false);
});

test("la barra pública només s'oculta al descans i al final", () => {
  assert.equal(showPublicLiveScorebar(halfMatch({ phase: "first" })), true);
  assert.equal(showPublicLiveScorebar(halfMatch({ phase: "second" })), true);
  assert.equal(showPublicLiveScorebar(halfMatch({ phase: "half" })), false);
  assert.equal(showPublicLiveScorebar(finalMatch()), false);
});

test("identifica inequívocament la casella del resultat final", () => {
  assert.deepEqual(finalResultCellState(finalMatch(), "2-2"), { isResult: true, accessibleLabel: "Resultat final" });
  assert.deepEqual(finalResultCellState(finalMatch(), "1-0"), { isResult: false, accessibleLabel: "" });
});

test("mostra un guanyador pagat del resultat final amb el nom real", () => {
  const bets = [bet("final-winner", "p1", "2-2")];
  const summary = finalSummaryState({ pool, bets, participants: [participant("p1", "Pau Vidal")], match: finalMatch() });
  assert.equal(summary.complete, true);
  assert.equal(summary.final.winners.length, 1);
  assert.equal(summary.final.winners[0].name, "Pau Vidal");
  assert.ok(summary.final.winners[0].cents > 0);
});

test("reparteix el resultat final entre diverses participacions amb noms reals", () => {
  const bets = [bet("final-a", "p1", "2-2"), bet("final-b", "p2", "2-2")];
  const participants = [participant("p1", "Alex Serra"), participant("p2", "Alex Serra")];
  const summary = finalSummaryState({ pool, bets, participants, match: finalMatch() });
  assert.equal(summary.final.winners.length, 2);
  assert.deepEqual(summary.final.winners.map(winner => winner.name), ["Alex Serra", "Alex Serra"]);
  assert.notEqual(summary.final.winners[0].participantKey, summary.final.winners[1].participantKey);
  assert.equal(summary.final.winners.reduce((sum, winner) => sum + winner.cents, 0), summary.result.allocations.finalAvailable);
});

test("exclou del resultat final una aposta coincident pendent de pagament", () => {
  const pending = bet("pending-final", "p1", "2-2", "pending");
  const summary = finalSummaryState({ pool, bets: [pending], participants: [participant("p1", "Pendent")], match: finalMatch() });
  const tracking = trackingFinalState({ pool, match: finalMatch(), bet: { ...pending, finalPrizeCents: 0, specialPrizeCents: 0 } });
  assert.equal(summary.final.winners.length, 0);
  assert.equal(tracking.finalWon, false);
  assert.match(tracking.finalLabel, /pagament no està confirmat/);
});

test("sense guanyador final redistribueix segons el motor existent", () => {
  const bets = [bet("half-only", "p1", "1-0")];
  const summary = finalSummaryState({ pool, bets, participants: [participant("p1", "Aina Costa")], match: finalMatch({ specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" } }) });
  assert.equal(summary.final.winners.length, 0);
  assert.ok(summary.result.awards[0].breakdown.some(item => item.category === "final-redistribution"));
  assert.equal(summary.participants[0].totalCents, summary.result.totalPotCents);
  assert.match(summary.final.ruleText, /redistribueix/);
});

test("sense cap guanyador el resum final manté el pot acumulat", () => {
  const bets = [bet("no-winner", "p1", "0-0")];
  const summary = finalSummaryState({ pool, bets, participants: [participant("p1", "Sense premi")], match: finalMatch({ specialStatuses: { "3-3": "failed", "3-4": "failed", "4-3": "failed", "4-4": "failed" } }) });
  assert.equal(summary.final.winners.length, 0);
  assert.equal(summary.result.carryoverCents, summary.result.totalPotCents);
  assert.equal(summary.participants.length, 0);
  assert.match(summary.final.ruleText, /pot queda acumulat/);
});

test("el resum final integra descans, resultat final, especials i totals per participació", () => {
  const bets = [bet("half", "p1", "1-0"), bet("final", "p2", "2-2"), bet("special", "p1", "3-3")];
  const participants = [participant("p1", "Marta Rius"), participant("p2", "Oriol Font")];
  const summary = finalSummaryState({ pool, bets, participants, match: finalMatch() });
  assert.equal(summary.half.winners[0].name, "Marta Rius");
  assert.equal(summary.final.winners[0].name, "Oriol Font");
  assert.equal(summary.specials.find(item => item.cellKey === "3-3").winners[0].name, "Marta Rius");
  assert.equal(summary.specials.filter(item => item.status === "failed").length, 3);
  assert.equal(summary.participants.length, 2);
  assert.equal(summary.participants.reduce((sum, item) => sum + item.totalCents, 0), summary.result.totalPotCents);
});

test("el resum final no calcula imports si falten dades per resoldre", () => {
  const summary = finalSummaryState({ pool, bets: [], participants: [], match: finalMatch({ finalHome: null, finalAway: null, specialStatuses: { "3-3": "pending", "3-4": "failed", "4-3": "failed", "4-4": "failed" } }) });
  assert.equal(summary.complete, false);
  assert.ok(summary.missing.includes("resultat final"));
  assert.ok(summary.missing.includes("resolució de totes les especials"));
  assert.equal(summary.result, undefined);
});

test("La meva aposta final és només lectura i desglossa final i especial", () => {
  const finalBet = { ...bet("final", "p1", "2-2"), finalPrizeCents: 700, specialPrizeCents: 0 };
  const finalState = trackingFinalState({ pool, match: finalMatch(), bet: finalBet });
  const specialBet = { ...bet("special", "p2", "3-3"), finalPrizeCents: 0, specialPrizeCents: 350 };
  const specialState = trackingFinalState({ pool, match: finalMatch(), bet: specialBet });
  assert.equal(finalState.readOnly, true);
  assert.equal(finalState.finalWon, true);
  assert.equal(specialState.specialWon, true);
  assert.equal(specialState.specialLabel, "Guanyadora especial");
});

test("el tracking real conserva el nom i els imports de final i especial", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  await repository.savePool(pool);
  const reservation = await repository.createReservation({ poolId: pool.id, name: "Clàudia Prat", cellKeys: ["2-2", "3-3"] });
  await repository.updateReservationPayment(reservation.participant.id, "paid");
  await repository.updateMatch(pool.id, finalMatch());
  const tracking = await repository.getTracking(reservation.token);
  assert.equal(tracking.participant.name, "Clàudia Prat");
  assert.ok(tracking.bets.find(item => item.cellKey === "2-2").finalPrizeCents > 0);
  assert.ok(tracking.bets.find(item => item.cellKey === "3-3").specialPrizeCents > 0);
});

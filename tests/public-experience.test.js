import assert from "node:assert/strict";
import test from "node:test";
import { calculatePrizes, createPool } from "../src/core.js";
import {
  STARTED_BETS_MESSAGE,
  halfTimeCellState,
  halfTimeOutcome,
  participationState,
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
  const publicBet = { id: "public-winner", poolId: pool.id, cellKey: "3-1", paymentStatus: "paid", participantName: "Núria Soler" };
  const outcome = halfTimeOutcome({ pool, bets: [publicBet], match: halfMatch() });
  assert.equal(outcome.winners.length, 1);
  assert.equal(outcome.winners[0].name, "Núria Soler");
  assert.equal(outcome.winners[0].participantId, undefined);
});

test("reparteix la franja del descans entre diverses apostes pagades", () => {
  const bets = [bet("a", "p1", "3-1"), bet("b", "p2", "3-1")];
  const outcome = halfTimeOutcome({ pool, bets, participants: [participant("p1", "Alex Puig"), participant("p2", "Alex Puig")], match: halfMatch() });
  assert.equal(outcome.winners.length, 2);
  assert.deepEqual(outcome.winners.map(winner => winner.name), ["Alex Puig", "Alex Puig"]);
  assert.notEqual(outcome.winners[0].participantId, outcome.winners[1].participantId);
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

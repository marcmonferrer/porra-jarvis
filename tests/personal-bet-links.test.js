import assert from "node:assert/strict";
import test from "node:test";
import {
  INVALID_PERSONAL_BET_MESSAGE,
  PERSONAL_BET_STORAGE_KEY,
  buildPersonalBetUrl,
  capturePersonalBetAccessFromUrl,
  createPersonalBetAccess,
  generateSecureRecoveryToken,
  isValidPersonalBetToken,
  parsePersonalBetInput
} from "../src/personal-bet-links.js";
import { DemoRepository, SupabaseRepository } from "../src/repository.js";

const token = "a".repeat(64);

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); }
  };
}

function browser(hash, search = "?pool=barca-athletic") {
  const calls = [];
  return {
    location: {
      origin: "https://example.test",
      pathname: "/finalissima-porra/",
      search,
      hash,
      href: `https://example.test/finalissima-porra/${search}${hash}`
    },
    history: { replaceState(...args) { calls.push(args); } },
    calls
  };
}

test("genera exactament 256 bits amb una font criptogràfica", () => {
  const generated = generateSecureRecoveryToken({ getRandomValues(bytes) { bytes.forEach((_, index) => { bytes[index] = index; }); return bytes; } });
  assert.equal(generated, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  assert.equal(generated.length, 64);
  assert.equal(isValidPersonalBetToken(generated), true);
  assert.equal(isValidPersonalBetToken(generated.toUpperCase()), false);
});

test("l’enllaç personal posa la capacitat només al fragment", () => {
  const url = buildPersonalBetUrl({ baseUrl: "https://example.test/finalissima-porra/?old=1#public", poolSlug: "barca-athletic", recoveryToken: token });
  assert.equal(url, `https://example.test/finalissima-porra/?pool=barca-athletic#mybet=${token}`);
  assert.doesNotMatch(new URL(url).search, new RegExp(token));
});

test("un altre dispositiu captura, desa i elimina immediatament el fragment", () => {
  const storage = memoryStorage();
  const state = browser(`#mybet=${token}`);
  const captured = capturePersonalBetAccessFromUrl({ ...state, storage });
  assert.equal(captured.valid, true);
  assert.equal(captured.token, token);
  assert.equal(captured.access.get("barca-athletic"), token);
  assert.deepEqual(state.calls, [[{ navigation: true }, "", "/finalissima-porra/?pool=barca-athletic#tracking"]]);
  assert.doesNotMatch(state.calls[0][2], new RegExp(token));
});

test("fragments malformats, uppercase o sense porra es netegen i no es persisteixen", () => {
  for (const [candidate, search] of [["A".repeat(64), "?pool=barca-athletic"], ["short", "?pool=barca-athletic"], [token, ""]]) {
    const storage = memoryStorage();
    const state = browser(`#mybet=${candidate}`, search);
    const captured = capturePersonalBetAccessFromUrl({ ...state, storage });
    assert.equal(captured.valid, false);
    assert.deepEqual(storage.snapshot(), {});
    assert.equal(state.calls.length, 1);
    assert.doesNotMatch(state.calls[0][2], /mybet=/);
  }
});

test("la recuperació del mateix navegador queda aïllada per slug i es pot oblidar", () => {
  const storage = memoryStorage();
  const access = createPersonalBetAccess({ storage });
  assert.equal(access.save("barca-athletic", token), true);
  assert.equal(access.get("barca-athletic"), token);
  assert.equal(access.get("altra-porra"), "");
  access.remove("barca-athletic");
  assert.equal(access.get("barca-athletic"), "");
  assert.equal(storage.getItem(PERSONAL_BET_STORAGE_KEY), null);
});

test("els enllaços legacy es capturen i deixen d’exposar ?track=", () => {
  const legacy = "b".repeat(48);
  const state = browser("#tracking", `?pool=barca-athletic&track=${legacy}`);
  const captured = capturePersonalBetAccessFromUrl({ ...state, storage: memoryStorage() });
  assert.equal(captured.legacyToken, legacy);
  assert.deepEqual(state.calls, [[{ navigation: true }, "", "/finalissima-porra/?pool=barca-athletic#tracking"]]);
});

test("el camp manual accepta URL personal, token contextual i tracking legacy", () => {
  assert.deepEqual(parsePersonalBetInput(`https://example.test/?pool=barca-athletic#mybet=${token}`), { kind: "personal", poolSlug: "barca-athletic", token });
  assert.deepEqual(parsePersonalBetInput(token, "barca-athletic"), { kind: "personal", poolSlug: "barca-athletic", token });
  assert.deepEqual(parsePersonalBetInput("b".repeat(48)), { kind: "legacy", token: "b".repeat(48) });
  assert.equal(parsePersonalBetInput("invalid"), null);
  assert.equal(INVALID_PERSONAL_BET_MESSAGE, "No s’ha pogut recuperar aquesta aposta.");
});

test("DemoRepository crea una capacitat, reutilitza participant i recupera les dues apostes", async () => {
  const storage = memoryStorage();
  const repository = new DemoRepository(storage);
  const pool = await repository.savePool({
    title: "Barça Athletic", homeTeam: "Barça", awayTeam: "Athletic",
    matchAt: "2099-08-27T19:00:00.000Z", closesAt: "2099-08-27T17:30:00.000Z",
    price: 4, poolPerBet: 3.5, fee: .5
  });
  await repository.publishPool(pool.id);

  const first = await repository.createReservation({
    poolId: pool.id,
    name: "Marc",
    cellKeys: ["1-0"]
  });
  assert.match(first.recoveryToken, /^[0-9a-f]{64}$/);
  assert.equal(repository.data.participants.length, 1);

  await assert.rejects(
    repository.createReservation({ poolId: pool.id, name: "Marc", cellKeys: ["2-1"] }),
    error => error.message === INVALID_PERSONAL_BET_MESSAGE
  );
  assert.equal(repository.data.participants.length, 1);
  assert.equal(repository.data.participants[0].recoveryToken, first.recoveryToken);

  const second = await repository.createReservation({
    poolId: pool.id,
    name: "Marc",
    cellKeys: ["2-1"],
    recoveryToken: first.recoveryToken
  });
  assert.equal(second.participant.id, first.participant.id);
  assert.equal(Object.hasOwn(second, "recoveryToken"), false);
  assert.equal(repository.data.participants.length, 1);

  const restored = await repository.getPersonalBet(pool.slug, first.recoveryToken);
  assert.equal(restored.participant.name, "Marc");
  assert.deepEqual(restored.bets.map(bet => bet.cellKey), ["1-0", "2-1"]);
  assert.deepEqual(restored.bets.map(bet => bet.paymentStatus), ["pending", "pending"]);
  assert.equal(await repository.getPersonalBet("wrong-pool", first.recoveryToken), null);

  await assert.rejects(
    repository.createReservation({
      poolId: pool.id,
      name: "Marc",
      cellKeys: ["3-2"],
      recoveryToken: first.recoveryToken
    }),
    /màxim de dues apostes/
  );

  const reloaded = new DemoRepository(storage);
  assert.equal((await reloaded.getPersonalBet(pool.slug, first.recoveryToken)).bets.length, 2);
});

test("dos primers intents concurrents no creen participants ni capacitats duplicats", async () => {
  const storage = memoryStorage();
  const repository = new DemoRepository(storage);
  const pool = await repository.savePool({
    title: "QA concurrent", homeTeam: "Local", awayTeam: "Visitant",
    matchAt: "2099-09-01T19:00:00.000Z", closesAt: "2099-09-01T17:30:00.000Z",
    price: 4, poolPerBet: 3.5, fee: .5
  });
  await repository.publishPool(pool.id);

  const attempts = await Promise.allSettled([
    repository.createReservation({ poolId: pool.id, name: "Concurrent", cellKeys: ["0-0"] }),
    repository.createReservation({ poolId: pool.id, name: "Concurrent", cellKeys: ["0-1"] })
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(result => result.status === "rejected").length, 1);
  assert.equal(repository.data.participants.length, 1);
  assert.equal(repository.data.bets.length, 1);
  assert.match(repository.data.participants[0].recoveryToken, /^[0-9a-f]{64}$/);
});

test("SupabaseRepository envia només slug i capacitat a la RPC personal", async () => {
  const calls = [];
  const expected = { pool: { slug: "barca-athletic" }, participant: { name: "Marc" }, bets: [] };
  const client = { async rpc(name, args) { calls.push({ name, args }); return { data: expected, error: null }; } };
  const repository = new SupabaseRepository(client);
  assert.equal(await repository.getPersonalBet("barca-athletic", "UPPER"), null);
  assert.deepEqual(await repository.getPersonalBet("barca-athletic", token), expected);
  assert.deepEqual(calls, [{ name: "get_personal_bet_state", args: { pool_identifier: "barca-athletic", raw_recovery_token: token } }]);
});

test("SupabaseRepository saneja errors de transport sense filtrar detalls interns", async () => {
  const client = { async rpc() { return { data: null, error: { message: "private.participant_recovery_tokens failed" } }; } };
  const repository = new SupabaseRepository(client);
  await assert.rejects(
    repository.getPersonalBet("barca-athletic", token),
    error => error.message === INVALID_PERSONAL_BET_MESSAGE && !error.message.includes("participant_recovery_tokens")
  );
});

test("la UI integra captura primerenca, estat local, còpia accessible i missatge de pèrdua", async () => {
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(new URL("../src/app.js", import.meta.url), "utf8"));
  assert.ok(source.indexOf("capturePersonalBetAccessFromUrl") < source.indexOf("await createRepository"));
  assert.match(source, /Guarda el teu enllaç personal/);
  assert.match(source, /Copiar el meu enllaç/);
  assert.match(source, /data-personal-copy-status/);
  assert.match(source, /Si has esborrat les dades del navegador/);
  assert.match(source, /repository\.getPersonalBet/);
  assert.match(source, /repository\.getTracking/);
  assert.match(source, /recoveryToken: existingRecoveryToken \|\| undefined/);
  assert.match(source, /result\.recoveryToken \|\| result\.recovery_token \|\| existingRecoveryToken/);
  assert.doesNotMatch(source, /console\.|analytics|telemetry/);
});

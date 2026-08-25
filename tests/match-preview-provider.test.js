import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXTURE_KICKOFF_PRECISION_MS,
  PreviewProviderError,
  buildMatchPreview,
  classifyProviderIssue,
  createApiFootballProvider,
  normalizeTeamIdentity,
  previewProviderErrorBody,
  requiredTeamIdentity,
  resolutionWarning,
  resolveFixture,
  standingForTeam
} from "../supabase/functions/_shared/api-football-preview.js";

const kickoff = "2026-08-30T19:00:00.000Z";
const fixture = {
  fixture: { id: 901, date: kickoff, status: { short: "NS" } },
  league: { id: 140, name: "La Liga", season: 2026 },
  teams: { home: { id: 10, name: "FC Barcelona" }, away: { id: 20, name: "Real Madrid CF" } },
  goals: { home: null, away: null }
};
const athleticFixture = {
  fixture: { id: 902, date: kickoff, status: { short: "NS" } },
  league: { id: 140, name: "La Liga", season: 2026 },
  teams: { home: { id: 10, name: "Barcelona" }, away: { id: 21, name: "Athletic Club" } },
  goals: { home: null, away: null }
};
const recent = (id, date, homeId, awayId, homeGoals, awayGoals) => ({
  fixture: { id, date, status: { short: "FT" } },
  league: { name: "La Liga" },
  teams: { home: { id: homeId, name: homeId === 10 ? "FC Barcelona" : "Rival" }, away: { id: awayId, name: awayId === 20 ? "Real Madrid CF" : "Rival" } },
  goals: { home: homeGoals, away: awayGoals }
});

function payload(response, errors = []) { return { response, errors }; }
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function providerFetch({ standingsStatus = 200, recentStatus = 200, topScorersStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), key: options.headers["x-apisports-key"] });
    if (url.pathname === "/fixtures" && url.searchParams.has("date")) return jsonResponse(payload([fixture]));
    if (url.pathname === "/standings") {
      if (standingsStatus !== 200) return jsonResponse({}, standingsStatus);
      return jsonResponse(payload([{ league: { standings: [[
        { rank: 2, points: 68, form: "WWDWL", team: { id: 10 }, all: { played: 34, goals: { for: 62, against: 29 } } },
        { rank: 1, points: 72, form: "WWWWW", team: { id: 20 }, all: { played: 34, goals: { for: 70, against: 25 } } }
      ]] } }]));
    }
    if (url.pathname === "/players/topscorers") {
      if (topScorersStatus !== 200) return jsonResponse({}, topScorersStatus);
      return jsonResponse(payload([
        { player: { id: 7, name: "Davanter A" }, statistics: [{ team: { id: 10 }, goals: { total: 18 } }] },
        { player: { id: 9, name: "Davanter B" }, statistics: [{ team: { id: 20 }, goals: { total: 20 } }] }
      ]));
    }
    if (url.pathname === "/fixtures" && url.searchParams.has("team") && recentStatus !== 200) return jsonResponse({}, recentStatus);
    if (url.pathname === "/fixtures" && url.searchParams.get("team") === "10") {
      return jsonResponse(payload([
        recent(802, "2026-08-17T19:00:00Z", 10, 31, 2, 0),
        recent(801, "2026-08-10T19:00:00Z", 32, 10, 1, 1)
      ]));
    }
    if (url.pathname === "/fixtures" && url.searchParams.get("team") === "20") return jsonResponse(payload([
      recent(804, "2026-08-18T19:00:00Z", 33, 20, 1, 3),
      recent(803, "2026-08-11T19:00:00Z", 20, 34, 0, 0)
    ]));
    return jsonResponse(payload([]));
  };
  return { calls, fetchImpl };
}

test("classifica errors del proveïdor amb una allowlist defensiva", () => {
  const cases = [
    [{ plan: "raw plan message" }, "plan_or_season"],
    [[{ code: "season", message: "raw season message" }], "plan_or_season"],
    [{ rateLimit: "raw quota message" }, "quota"],
    [["requests"], "quota"],
    [{ token: "raw authentication message" }, "authentication"],
    [[{ type: "api_key", detail: "raw authentication detail" }], "authentication"],
    [{ parameters: "raw invalid request message" }, "invalid_request"],
    [[{ category: "missing", detail: "raw invalid request detail" }], "invalid_request"],
    [[null, 42, { message: "raw unknown message", providerFixtureId: 901 }], "unknown"],
    ["a raw sentence mentioning plan access", "unknown"],
    [true, "unknown"]
  ];
  for (const [errors, expected] of cases) assert.equal(classifyProviderIssue(errors), expected);
  for (const errors of [null, undefined, false, [], {}]) assert.equal(classifyProviderIssue(errors), null);
  assert.equal(classifyProviderIssue({ plan: "raw", token: "raw" }), "authentication");
});

test("els errors de la consulta inicial només exposen el diagnòstic admin sanititzat", async () => {
  const cases = [
    [{ plan: "Free plans do not have access to this season: 2026" }, "plan_or_season"],
    [{ rateLimit: "Quota exhausted for key secret-provider-key" }, "quota"],
    [[{ code: "token", message: "Invalid secret-provider-key" }], "authentication"],
    [[{ type: "parameters", message: "Invalid date 2026-08-30" }], "invalid_request"],
    [[null, { message: "Unknown failure for fixture 901" }], "unknown"]
  ];
  for (const [errors, providerIssue] of cases) {
    let calls = 0;
    const provider = createApiFootballProvider({
      apiKey: "secret-provider-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(payload([], errors));
      }
    });
    await assert.rejects(
      () => provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Athletic Club", matchAt: kickoff }),
      error => {
        const diagnostic = { stage: "fixture_request", errorCode: "provider_response", providerIssue };
        assert.equal(error.code, "provider_response");
        assert.equal(error.message, "El proveïdor no ha pogut completar la consulta.");
        assert.deepEqual(error.diagnostic, diagnostic);
        assert.deepEqual(previewProviderErrorBody(error, false), {
          error: "provider_response",
          message: "El proveïdor no ha pogut completar la consulta."
        });
        assert.deepEqual(previewProviderErrorBody(error, true), {
          error: "provider_response",
          message: "El proveïdor no ha pogut completar la consulta.",
          diagnostic
        });
        assert.equal(resolutionWarning(error.diagnostic), JSON.stringify(diagnostic));
        const exposed = JSON.stringify(previewProviderErrorBody(error, true)) + resolutionWarning(error.diagnostic);
        assert.doesNotMatch(exposed, /Barcelona|Athletic|2026-08-30|901|secret-provider-key|message.*Invalid|providerFixtureId/);
        return true;
      }
    );
    assert.equal(calls, 1);
    assert.equal(provider.callCount, 1);
  }
});

test("normalitza identitats abans de resoldre la fixture", () => {
  assert.equal(normalizeTeamIdentity("F.C. Barcelona"), "barcelona");
  assert.equal(normalizeTeamIdentity("Real Madrid CF"), "real madrid");
  assert.equal(requiredTeamIdentity("FC Barcelona"), "barcelona");
  assert.equal(requiredTeamIdentity("Athletic Club"), "athletic club");
  assert.throws(() => requiredTeamIdentity("FC"), error => error.code === "invalid_team" && error.status === 400);
  assert.equal(FIXTURE_KICKOFF_PRECISION_MS, 60_000);
});

test("la fixture requereix noms, localia i el mateix minut UTC; mai no endevina", () => {
  const reversed = {
    ...athleticFixture,
    fixture: { ...athleticFixture.fixture, id: 903 },
    teams: { home: athleticFixture.teams.away, away: athleticFixture.teams.home }
  };
  const later = {
    ...athleticFixture,
    fixture: { ...athleticFixture.fixture, id: 904, date: "2026-08-30T19:01:00.000Z" }
  };
  const args = { homeTeamName: "FC Barcelona", awayTeamName: "Athletic Club", kickoffAt: kickoff };
  assert.equal(resolveFixture(payload([reversed, later, athleticFixture]), args).fixture.id, 902);
  for (const candidate of [reversed, later]) {
    assert.throws(
      () => resolveFixture(payload([candidate]), args),
      error => error.code === "fixture_not_found"
        && error.message === "No s’ha trobat un únic partit que coincideixi amb els equips i l’horari."
        && JSON.stringify(error.diagnostic) === JSON.stringify({ stage: "fixture", errorCode: "fixture_not_found", candidateCount: 0 })
    );
  }
});

test("zero o múltiples fixtures exactes produeixen diagnòstic sanititzat", () => {
  const args = { homeTeamName: "FC Barcelona", awayTeamName: "Athletic Club", kickoffAt: kickoff };
  assert.throws(
    () => resolveFixture(payload([]), args),
    error => error.code === "fixture_not_found"
      && JSON.stringify(error.diagnostic) === JSON.stringify({ stage: "fixture", errorCode: "fixture_not_found", candidateCount: 0 })
  );
  assert.throws(
    () => resolveFixture(payload([
      athleticFixture,
      { ...athleticFixture, fixture: { ...athleticFixture.fixture, id: 999 } }
    ]), args),
    error => error.code === "fixture_ambiguous"
      && JSON.stringify(error.diagnostic) === JSON.stringify({ stage: "fixture", errorCode: "fixture_ambiguous", candidateCount: 2 })
  );
});

test("el flux actiu resol Barça-Athletic per fixture encara que /teams fos ambigu", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), key: options.headers["x-apisports-key"] });
    if (url.pathname === "/teams") {
      return jsonResponse(payload([
        { team: { id: 21, name: "Athletic Club" } },
        { team: { id: 22, name: "Athletic Club" } },
        { team: { id: 23, name: "Athletic Club" } }
      ]));
    }
    if (url.pathname === "/fixtures" && url.searchParams.has("date")) return jsonResponse(payload([athleticFixture]));
    return jsonResponse(payload([]));
  };
  const provider = createApiFootballProvider({ apiKey: "test-only-key", fetchImpl });
  const snapshot = await provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Athletic Club", matchAt: kickoff });
  const discovery = new URL(calls[0].url);
  assert.equal(discovery.pathname, "/fixtures");
  assert.equal(discovery.searchParams.get("date"), "2026-08-30");
  assert.equal(discovery.searchParams.get("timezone"), "UTC");
  assert.equal(calls.some(call => new URL(call.url).pathname === "/teams"), false);
  assert.equal(provider.callCount, 5);
  assert.equal(snapshot.homeTeam.name, "Barcelona");
  assert.equal(snapshot.awayTeam.name, "Athletic Club");
  assert.doesNotMatch(JSON.stringify(snapshot), /providerFixtureId|competitionId|providerTeamId|providerPlayerId/);
});

test("una resolució de fixture fallida atura totes les consultes posteriors", async () => {
  for (const fixtures of [
    [],
    [athleticFixture, { ...athleticFixture, fixture: { ...athleticFixture.fixture, id: 999 } }]
  ]) {
    const calls = [];
    const provider = createApiFootballProvider({
      apiKey: "test-only-key",
      fetchImpl: async url => {
        calls.push(url.toString());
        return jsonResponse(payload(fixtures));
      }
    });
    await assert.rejects(
      () => provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Athletic Club", matchAt: kickoff }),
      error => {
        const errorCode = fixtures.length ? "fixture_ambiguous" : "fixture_not_found";
        assert.equal(error.code, errorCode);
        assert.deepEqual(error.diagnostic, { stage: "fixture", errorCode, candidateCount: fixtures.length });
        return true;
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]).pathname, "/fixtures");
  }
});

test("la resposta admin i l’avís només contenen diagnòstic de fixture sanititzat", () => {
  const message = "No s’ha trobat un únic partit que coincideixi amb els equips i l’horari.";
  const error = new PreviewProviderError("fixture_ambiguous", message, 502, {
    stage: "fixture",
    errorCode: "fixture_ambiguous",
    candidateCount: 3,
    poolTeamName: "Athletic Club",
    kickoffAt: kickoff,
    providerFixtureId: 902,
    apiKey: "test-only-key",
    jwt: "test-only-jwt",
    userId: "test-only-user"
  });
  const diagnostic = { stage: "fixture", errorCode: "fixture_ambiguous", candidateCount: 3 };
  assert.deepEqual(error.diagnostic, diagnostic);
  assert.deepEqual(previewProviderErrorBody(error, true), {
    error: "fixture_ambiguous",
    message,
    diagnostic
  });
  assert.deepEqual(previewProviderErrorBody(error, false), { error: "fixture_ambiguous", message });
  assert.equal(resolutionWarning(error.diagnostic), JSON.stringify(diagnostic));
  const serialized = JSON.stringify(previewProviderErrorBody(error, true)) + resolutionWarning(error.diagnostic);
  assert.doesNotMatch(serialized, /Athletic Club|kickoffAt|providerFixtureId|test-only-key|test-only-jwt|test-only-user/);
});

test("identitats invàlides fallen abans de qualsevol petició", async () => {
  let calls = 0;
  const provider = createApiFootballProvider({
    apiKey: "test-only-key",
    fetchImpl: async () => { calls += 1; return jsonResponse(payload([])); }
  });
  await assert.rejects(
    () => provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "CF", matchAt: kickoff }),
    error => error.code === "invalid_team" && error.status === 400
  );
  assert.equal(calls, 0);
  assert.equal(provider.callCount, 0);
});

test("el proveïdor fa cinc crides i desa només el snapshot compacte normalitzat", async () => {
  const mock = providerFetch();
  const provider = createApiFootballProvider({ apiKey: "test-only-key", fetchImpl: mock.fetchImpl, now: () => new Date("2026-08-24T09:00:00Z") });
  const snapshot = await provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Real Madrid CF", matchAt: kickoff });
  assert.equal(provider.callCount, 5);
  assert.equal(mock.calls.length, 5);
  const discovery = new URL(mock.calls[0].url);
  assert.equal(discovery.pathname, "/fixtures");
  assert.equal(discovery.searchParams.get("date"), "2026-08-30");
  assert.equal(discovery.searchParams.get("timezone"), "UTC");
  assert.equal(mock.calls.some(call => new URL(call.url).pathname === "/teams"), false);
  assert.ok(mock.calls.every(call => call.key === "test-only-key"));
  assert.deepEqual(snapshot.homeTeam.form, ["W", "W", "D", "W", "L"]);
  assert.equal(snapshot.homeTeam.recentMatches.length, 2);
  assert.equal(snapshot.awayTeam.attackingReference.name, "Davanter B");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /paging|parameters|headers|test-only-key|response|providerFixtureId|competitionId|providerTeamId|providerPlayerId/);
});

test("les dades complementàries no disponibles produeixen avisos sense impedir el snapshot", async () => {
  const mock = providerFetch({ standingsStatus: 500, recentStatus: 500, topScorersStatus: 500 });
  const provider = createApiFootballProvider({ apiKey: "test-only-key", fetchImpl: mock.fetchImpl });
  const snapshot = await provider.fetchPreview({ homeTeam: "Barcelona", awayTeam: "Real Madrid", matchAt: kickoff });
  assert.match(snapshot.warnings.join(" "), /classificació/);
  assert.match(snapshot.warnings.join(" "), /últims partits del local/);
  assert.match(snapshot.warnings.join(" "), /últims partits del visitant/);
  assert.match(snapshot.warnings.join(" "), /referència ofensiva/);
  assert.deepEqual(snapshot.homeTeam.form, []);
  assert.deepEqual(snapshot.homeTeam.recentMatches, []);
  assert.deepEqual(snapshot.awayTeam.recentMatches, []);
  assert.equal("attackingReference" in snapshot.homeTeam, false);
  assert.equal(provider.callCount, 5);
});

test("429 i manca de secret fallen de manera acotada i sense reintents", async () => {
  assert.throws(() => createApiFootballProvider(), error => error instanceof PreviewProviderError && error.code === "missing_key" && error.status === 503);
  let calls = 0;
  const provider = createApiFootballProvider({
    apiKey: "test-only-key",
    fetchImpl: async () => { calls += 1; return jsonResponse({}, 429); }
  });
  await assert.rejects(() => provider.fetchPreview({ homeTeam: "Barcelona", awayTeam: "Real Madrid", matchAt: kickoff }), error => error.code === "rate_limited" && error.status === 429);
  assert.equal(calls, 1);
});
test("dades numèriques malformades s’ometen si són opcionals i fallen si són essencials", () => {
  const incompleteStandings = payload([{ league: { standings: [[{
    rank: 2, points: 68, team: { id: 10 }, all: { played: 34, goals: { for: null, against: 29 } }
  }]] } }]);
  assert.equal(standingForTeam(incompleteStandings, 10), null);
  assert.throws(() => buildMatchPreview({
    fixture: { ...fixture, fixture: { ...fixture.fixture, id: null } },
    homeTeam: { id: 10, name: "Barcelona" },
    awayTeam: { id: 20, name: "Real Madrid" },
    standings: null,
    recentHome: [],
    recentAway: [],
    scorers: null,
    fetchedAt: "2026-08-24T09:00:00Z"
  }), error => error.code === "malformed_response");
});

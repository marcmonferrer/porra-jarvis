import assert from "node:assert/strict";
import test from "node:test";
import {
  PreviewProviderError,
  buildMatchPreview,
  createApiFootballProvider,
  normalizeTeamIdentity,
  resolveFixture,
  resolveTeam,
  standingForTeam,
  teamSearchTerm
} from "../supabase/functions/_shared/api-football-preview.js";

const kickoff = "2026-08-30T19:00:00.000Z";
const fixture = {
  fixture: { id: 901, date: kickoff, status: { short: "NS" } },
  league: { id: 140, name: "La Liga", season: 2026 },
  teams: { home: { id: 10, name: "FC Barcelona" }, away: { id: 20, name: "Real Madrid CF" } },
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

function providerFetch({ topScorersStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), key: options.headers["x-apisports-key"] });
    if (url.pathname === "/teams") {
      const search = url.searchParams.get("search");
      return jsonResponse(payload([{ team: search === "barcelona" ? { id: 10, name: "Barcelona", logo: "https://cdn.example/barca.png" } : { id: 20, name: "Real Madrid CF", logo: "https://cdn.example/madrid.png" } }]));
    }
    if (url.pathname === "/standings") return jsonResponse(payload([{ league: { standings: [[
      { rank: 2, points: 68, form: "WWDWL", team: { id: 10 }, all: { played: 34, goals: { for: 62, against: 29 } } },
      { rank: 1, points: 72, form: "WWWWW", team: { id: 20 }, all: { played: 34, goals: { for: 70, against: 25 } } }
    ]] } }]));
    if (url.pathname === "/players/topscorers") {
      if (topScorersStatus !== 200) return jsonResponse({}, topScorersStatus);
      return jsonResponse(payload([
        { player: { id: 7, name: "Davanter A" }, statistics: [{ team: { id: 10 }, goals: { total: 18 } }] },
        { player: { id: 9, name: "Davanter B" }, statistics: [{ team: { id: 20 }, goals: { total: 20 } }] }
      ]));
    }
    if (url.pathname === "/fixtures" && url.searchParams.has("date")) return jsonResponse(payload([fixture]));
    if (url.pathname === "/fixtures" && url.searchParams.get("team") === "10") return jsonResponse(payload([
      recent(802, "2026-08-17T19:00:00Z", 10, 31, 2, 0),
      recent(801, "2026-08-10T19:00:00Z", 32, 10, 1, 1)
    ]));
    if (url.pathname === "/fixtures" && url.searchParams.get("team") === "20") return jsonResponse(payload([
      recent(804, "2026-08-18T19:00:00Z", 33, 20, 1, 3),
      recent(803, "2026-08-11T19:00:00Z", 20, 34, 0, 0)
    ]));
    return jsonResponse(payload([]));
  };
  return { calls, fetchImpl };
}

test("normalitza variants habituals però exigeix una coincidència única", () => {
  assert.equal(normalizeTeamIdentity("F.C. Barcelona"), "barcelona");
  assert.equal(normalizeTeamIdentity("Real Madrid CF"), "real madrid");
  assert.equal(teamSearchTerm("FC Barcelona"), "barcelona");
  assert.equal(teamSearchTerm("Athletic Club"), "athletic club");
  assert.throws(() => teamSearchTerm("FC"), error => error.code === "invalid_team" && error.status === 400);
  assert.equal(resolveTeam(payload([{ team: { id: 10, name: "FC Barcelona" } }]), "Barcelona").id, 10);
  assert.equal(resolveTeam(payload([{ team: { id: 20, name: "Athletic Club" } }]), "Athletic Club").id, 20);
  assert.throws(() => resolveTeam(payload([]), "Athletic Club"), error => error.code === "team_not_found");
  assert.throws(() => resolveTeam(payload([{ team: { id: 10, name: "Club A" } }, { team: { id: 11, name: "Club A FC" } }]), "Club A"), error => error.code === "team_ambiguous");
});

test("resolució d’equip fallida no consulta fixtures ni endevina candidats", async () => {
  const run = async ({ home, away, expectedCode }) => {
    const calls = [];
    const provider = createApiFootballProvider({
      apiKey: "test-only-key",
      fetchImpl: async url => {
        calls.push(url.toString());
        assert.equal(url.pathname, "/teams");
        return jsonResponse(payload(url.searchParams.get("search") === "barcelona" ? home : away));
      }
    });
    await assert.rejects(
      () => provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Athletic Club", matchAt: kickoff }),
      error => error.code === expectedCode
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => new URL(url).pathname === "/teams"));
  };

  await run({
    home: [],
    away: [{ team: { id: 20, name: "Athletic Club" } }],
    expectedCode: "team_not_found"
  });
  await run({
    home: [{ team: { id: 10, name: "Barcelona" } }],
    away: [{ team: { id: 20, name: "Athletic Club" } }, { team: { id: 21, name: "Athletic Club FC" } }],
    expectedCode: "team_ambiguous"
  });
});

test("termes de descoberta invàlids fallen abans de qualsevol petició", async () => {
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

test("la fixture requereix equips, localia i horari exactes; mai no endevina", () => {
  assert.equal(resolveFixture(payload([fixture]), { homeTeamId: 10, awayTeamId: 20, kickoffAt: kickoff }).fixture.id, 901);
  assert.throws(() => resolveFixture(payload([{ ...fixture, teams: { home: fixture.teams.away, away: fixture.teams.home } }]), { homeTeamId: 10, awayTeamId: 20, kickoffAt: kickoff }), error => error.code === "fixture_not_found");
  assert.throws(() => resolveFixture(payload([fixture, { ...fixture, fixture: { ...fixture.fixture, id: 902 } }]), { homeTeamId: 10, awayTeamId: 20, kickoffAt: kickoff }), error => error.code === "fixture_ambiguous");
});

test("el proveïdor fa set crides com a màxim i desa només el snapshot compacte normalitzat", async () => {
  const mock = providerFetch();
  const provider = createApiFootballProvider({ apiKey: "test-only-key", fetchImpl: mock.fetchImpl, now: () => new Date("2026-08-24T09:00:00Z") });
  const snapshot = await provider.fetchPreview({ homeTeam: "FC Barcelona", awayTeam: "Real Madrid CF", matchAt: kickoff });
  assert.equal(provider.callCount, 7);
  assert.equal(mock.calls.length, 7);
  assert.deepEqual(mock.calls.slice(0, 2).map(call => new URL(call.url).searchParams.get("search")), ["barcelona", "real madrid"]);
  assert.ok(mock.calls.every(call => call.key === "test-only-key"));
  assert.equal(snapshot.providerFixtureId, 901);
  assert.equal(snapshot.homeTeam.providerTeamId, 10);
  assert.deepEqual(snapshot.homeTeam.form, ["W", "W", "D", "W", "L"]);
  assert.equal(snapshot.homeTeam.recentMatches.length, 2);
  assert.equal(snapshot.awayTeam.attackingReference.name, "Davanter B");
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /paging|parameters|headers|test-only-key|response/);
});

test("una dada complementària no disponible produeix avís sense impedir el snapshot", async () => {
  const mock = providerFetch({ topScorersStatus: 500 });
  const provider = createApiFootballProvider({ apiKey: "test-only-key", fetchImpl: mock.fetchImpl });
  const snapshot = await provider.fetchPreview({ homeTeam: "Barcelona", awayTeam: "Real Madrid", matchAt: kickoff });
  assert.match(snapshot.warnings.join(" "), /referència ofensiva/);
  assert.equal("attackingReference" in snapshot.homeTeam, false);
  assert.equal(provider.callCount, 7);
});

test("429 i manca de secret fallen de manera acotada i sense reintents", async () => {
  assert.throws(() => createApiFootballProvider(), error => error instanceof PreviewProviderError && error.code === "missing_key" && error.status === 503);
  let calls = 0;
  const provider = createApiFootballProvider({
    apiKey: "test-only-key",
    fetchImpl: async () => { calls += 1; return jsonResponse({}, 429); }
  });
  await assert.rejects(() => provider.fetchPreview({ homeTeam: "Barcelona", awayTeam: "Real Madrid", matchAt: kickoff }), error => error.code === "rate_limited" && error.status === 429);
  assert.ok(calls <= 2);
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

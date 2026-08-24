export const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
export const MATCH_PREVIEW_VERSION = "1";
export const MAX_PROVIDER_CALLS = 7;
export const PROVIDER_TIMEOUT_MS = 8_000;

const COMPLETE_FIXTURE_STATUSES = new Set(["FT", "AET", "PEN"]);
const IGNORED_TEAM_WORDS = new Set(["fc", "cf"]);

export class PreviewProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "PreviewProviderError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeTeamIdentity(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\b(?:f\s*\.\s*c|c\s*\.\s*f)\.?\b/g, " ")
    .replace(/\b(futbol|football)\s+club\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(word => word && !IGNORED_TEAM_WORDS.has(word))
    .join(" ");
}

export function teamSearchTerm(name) {
  const term = typeof name === "string" ? normalizeTeamIdentity(name) : "";
  if (term.length < 3) {
    throw new PreviewProviderError("invalid_team", "La porra no té noms d’equip vàlids.", 400);
  }
  return term;
}

function responseItems(payload) {
  if (!payload || !Array.isArray(payload.response)) {
    throw new PreviewProviderError("malformed_response", "El proveïdor ha retornat una resposta no vàlida.");
  }
  return payload.response;
}

export function resolveTeam(payload, expectedName) {
  const expected = normalizeTeamIdentity(expectedName);
  const matches = responseItems(payload)
    .map(item => item?.team)
    .filter(team => Number.isInteger(team?.id) && normalizeTeamIdentity(team.name) === expected);
  if (matches.length !== 1) {
    throw new PreviewProviderError(
      matches.length ? "team_ambiguous" : "team_not_found",
      "No s’ha pogut identificar l’equip de manera inequívoca."
    );
  }
  return matches[0];
}

export function resolveFixture(payload, { homeTeamId, awayTeamId, kickoffAt }) {
  const expectedKickoff = new Date(kickoffAt).getTime();
  const candidates = responseItems(payload).filter(item => {
    const actualKickoff = new Date(item?.fixture?.date).getTime();
    return item?.teams?.home?.id === homeTeamId
      && item?.teams?.away?.id === awayTeamId
      && Number.isFinite(actualKickoff)
      && Math.abs(actualKickoff - expectedKickoff) <= 30 * 60 * 1000;
  });
  if (candidates.length !== 1) {
    throw new PreviewProviderError(
      candidates.length ? "fixture_ambiguous" : "fixture_not_found",
      "No s’ha trobat un únic partit que coincideixi amb els equips i l’horari."
    );
  }
  return candidates[0];
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(value) {
  const number = finiteNumber(value);
  if (number === null) throw new PreviewProviderError("malformed_response", "El proveïdor ha retornat identificadors no vàlids.");
  return number;
}

export function standingForTeam(payload, teamId) {
  const groups = responseItems(payload)[0]?.league?.standings;
  const rows = Array.isArray(groups) ? groups.flat() : [];
  const row = rows.find(item => item?.team?.id === teamId);
  if (!row) return null;
  const values = {
    position: finiteNumber(row.rank),
    points: finiteNumber(row.points),
    played: finiteNumber(row.all?.played),
    goalsFor: finiteNumber(row.all?.goals?.for),
    goalsAgainst: finiteNumber(row.all?.goals?.against)
  };
  if (Object.values(values).some(value => value === null)) return null;
  return {
    ...values,
    form: String(row.form || "")
      .split("")
      .filter(value => ["W", "D", "L"].includes(value))
      .slice(-5)
  };
}

export function recentTeamContext(payload, teamId, kickoffAt) {
  const cutoff = new Date(kickoffAt).getTime();
  return responseItems(payload)
    .filter(item => COMPLETE_FIXTURE_STATUSES.has(item?.fixture?.status?.short))
    .filter(item => new Date(item?.fixture?.date).getTime() < cutoff)
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .map(item => {
      const home = item.teams?.home?.id === teamId;
      const opponent = home ? item.teams?.away?.name : item.teams?.home?.name;
      const scoreFor = finiteNumber(home ? item.goals?.home : item.goals?.away);
      const scoreAgainst = finiteNumber(home ? item.goals?.away : item.goals?.home);
      if (!opponent || !item.league?.name || scoreFor === null || scoreAgainst === null) return null;
      return {
        competitionName: String(item.league.name),
        opponent: String(opponent),
        scoreFor,
        scoreAgainst,
        venue: home ? "home" : "away",
        playedAt: new Date(item.fixture.date).toISOString()
      };
    })
    .filter(Boolean)
    .slice(0, 2);
}

export function attackingReferenceForTeam(payload, teamId) {
  const player = responseItems(payload).find(item => item?.statistics?.some(stat => stat?.team?.id === teamId));
  if (!player) return null;
  const statistics = player.statistics.find(stat => stat?.team?.id === teamId);
  const goals = finiteNumber(statistics?.goals?.total);
  const providerPlayerId = finiteNumber(player.player?.id);
  const name = String(player.player?.name || "").trim();
  if (goals === null || providerPlayerId === null || !name) return null;
  return { providerPlayerId, name, goals };
}

export function buildMatchPreview({ fixture, homeTeam, awayTeam, standings, recentHome, recentAway, scorers, fetchedAt, warnings = [] }) {
  const standingHome = standings ? standingForTeam(standings, homeTeam.id) : null;
  const standingAway = standings ? standingForTeam(standings, awayTeam.id) : null;
  const competitionName = String(fixture.league?.name || "").trim();
  if (!competitionName) throw new PreviewProviderError("malformed_response", "El proveïdor no ha identificat la competició.");
  const teamSnapshot = (team, standing, recentMatches) => {
    const attackingReference = scorers ? attackingReferenceForTeam(scorers, team.id) : null;
    return {
      providerTeamId: requiredNumber(team.id),
      name: String(team.name),
      ...(team.logo ? { crestUrl: String(team.logo) } : {}),
      ...(standing ? {
        standing: {
          position: standing.position,
          points: standing.points,
          played: standing.played,
          goalsFor: standing.goalsFor,
          goalsAgainst: standing.goalsAgainst
        },
        form: standing.form
      } : { form: [] }),
      recentMatches,
      ...(attackingReference ? { attackingReference } : {})
    };
  };
  return {
    version: MATCH_PREVIEW_VERSION,
    provider: "api-football",
    providerFixtureId: requiredNumber(fixture.fixture?.id),
    competitionId: requiredNumber(fixture.league?.id),
    competitionName,
    season: requiredNumber(fixture.league?.season),
    fetchedAt: new Date(fetchedAt).toISOString(),
    kickoffAt: new Date(fixture.fixture.date).toISOString(),
    homeTeam: teamSnapshot(homeTeam, standingHome, recentHome),
    awayTeam: teamSnapshot(awayTeam, standingAway, recentAway),
    warnings: warnings.slice(0, 5),
    source: { label: "API-Football", url: "https://www.api-football.com/" }
  };
}

function hasProviderErrors(payload) {
  if (!payload?.errors) return false;
  return Array.isArray(payload.errors) ? payload.errors.length > 0 : Object.keys(payload.errors).length > 0;
}

export function createApiFootballProvider({ apiKey, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = PROVIDER_TIMEOUT_MS, maxCalls = MAX_PROVIDER_CALLS } = {}) {
  if (!apiKey) throw new PreviewProviderError("missing_key", "La prèvia automàtica no està configurada.", 503);
  let calls = 0;

  async function request(path, params) {
    calls += 1;
    if (calls > maxCalls) throw new PreviewProviderError("call_budget", "S’ha assolit el límit segur de consultes.", 503);
    const url = new URL(`${API_FOOTBALL_BASE_URL}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "x-apisports-key": apiKey },
        signal: controller.signal
      });
      if (response.status === 429) throw new PreviewProviderError("rate_limited", "El proveïdor ha limitat temporalment les consultes.", 429);
      if (!response.ok) throw new PreviewProviderError("provider_http", "El proveïdor no està disponible temporalment.");
      const payload = await response.json();
      if (hasProviderErrors(payload)) throw new PreviewProviderError("provider_response", "El proveïdor no ha pogut completar la consulta.");
      return payload;
    } catch (error) {
      if (error instanceof PreviewProviderError) throw error;
      if (error?.name === "AbortError") throw new PreviewProviderError("timeout", "La consulta al proveïdor ha superat el temps límit.", 504);
      throw new PreviewProviderError("network", "No s’ha pogut contactar amb el proveïdor.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async function optional(load, warning, warnings) {
    try {
      return await load();
    } catch (error) {
      if (["rate_limited", "timeout", "call_budget"].includes(error?.code)) throw error;
      warnings.push(warning);
      return null;
    }
  }

  return {
    get callCount() { return calls; },
    async fetchPreview(pool) {
      const kickoff = new Date(pool.matchAt);
      if (!Number.isFinite(kickoff.getTime())) throw new PreviewProviderError("invalid_pool", "La porra no té un horari de partit vàlid.", 400);
      const homeSearch = teamSearchTerm(pool.homeTeam);
      const awaySearch = teamSearchTerm(pool.awayTeam);
      const [homePayload, awayPayload] = await Promise.all([
        request("/teams", { search: homeSearch }),
        request("/teams", { search: awaySearch })
      ]);
      const homeTeam = resolveTeam(homePayload, pool.homeTeam);
      const awayTeam = resolveTeam(awayPayload, pool.awayTeam);
      if (homeTeam.id === awayTeam.id) throw new PreviewProviderError("invalid_pool", "Els dos equips no poden ser el mateix.", 400);
      const fixturePayload = await request("/fixtures", {
        team: homeTeam.id,
        date: kickoff.toISOString().slice(0, 10),
        timezone: "UTC"
      });
      const fixture = resolveFixture(fixturePayload, {
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        kickoffAt: kickoff.toISOString()
      });
      const warnings = [];
      const standings = await optional(
        () => request("/standings", { league: fixture.league.id, season: fixture.league.season }),
        "La classificació no està disponible per a aquesta competició.",
        warnings
      );
      const [recentHomePayload, recentAwayPayload] = await Promise.all([
        optional(() => request("/fixtures", { team: homeTeam.id, last: 10 }), "Falten els últims partits del local.", warnings),
        optional(() => request("/fixtures", { team: awayTeam.id, last: 10 }), "Falten els últims partits del visitant.", warnings)
      ]);
      const scorers = await optional(
        () => request("/players/topscorers", { league: fixture.league.id, season: fixture.league.season }),
        "La referència ofensiva no està disponible.",
        warnings
      );
      return buildMatchPreview({
        fixture,
        homeTeam,
        awayTeam,
        standings,
        recentHome: recentHomePayload ? recentTeamContext(recentHomePayload, homeTeam.id, fixture.fixture.date) : [],
        recentAway: recentAwayPayload ? recentTeamContext(recentAwayPayload, awayTeam.id, fixture.fixture.date) : [],
        scorers,
        fetchedAt: now(),
        warnings
      });
    }
  };
}

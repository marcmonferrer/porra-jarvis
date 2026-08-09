import { createClient } from "npm:@supabase/supabase-js@2";

const API_BASE = "https://v3.football.api-sports.io";
const FINAL_STATUSES = new Set(["FT", "AET", "PEN"]);

function normalizeTeam(name: string) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function mapPhase(status: string) {
  if (status === "1H") return "first";
  if (status === "HT") return "half";
  if (["2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"].includes(status)) return "second";
  if (FINAL_STATUSES.has(status)) return "final";
  return "pre";
}

function findSide(fixture: any, configuredName: string) {
  const wanted = normalizeTeam(configuredName);
  if (normalizeTeam(fixture.teams.home.name) === wanted) return "home";
  if (normalizeTeam(fixture.teams.away.name) === wanted) return "away";
  return null;
}

async function apiFixture(fixtureId: string, apiKey: string) {
  const response = await fetch(`${API_BASE}/fixtures?id=${encodeURIComponent(fixtureId)}`, {
    headers: { "x-apisports-key": apiKey }
  });
  if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors && Object.keys(payload.errors).length) throw new Error("API-Football rejected the request");
  if (!payload.response?.[0]) throw new Error("Fixture not found");
  return payload.response[0];
}

Deno.serve(async request => {
  const expectedSecret = Deno.env.get("SYNC_SECRET");
  if (!expectedSecret || request.headers.get("x-sync-secret") !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = Deno.env.get("API_FOOTBALL_KEY");
  if (!supabaseUrl || !serviceRoleKey || !apiKey) {
    return Response.json({ error: "Missing server-side configuration" }, { status: 500 });
  }

  const database = createClient(supabaseUrl, serviceRoleKey);
  let poolId: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    poolId = body.poolId || null;
    if (!poolId) return Response.json({ error: "poolId is required" }, { status: 400 });

    const { data: pool, error: poolError } = await database
      .from("pools")
      .select("id, home_team, away_team, status")
      .eq("id", poolId)
      .single();
    if (poolError) throw poolError;

    const { data: current, error: stateError } = await database
      .from("match_states")
      .select("provider_fixture_id, provider_status")
      .eq("pool_id", poolId)
      .single();
    if (stateError) throw stateError;

    const fixtureId = body.fixtureId || current.provider_fixture_id;
    if (!fixtureId) {
      return Response.json({ skipped: true, reason: "provider-fixture-not-configured" });
    }
    if (FINAL_STATUSES.has(current.provider_status)) {
      return Response.json({ skipped: true, reason: "match-already-finished" });
    }

    const fixture = await apiFixture(String(fixtureId), apiKey);
    const homeSide = findSide(fixture, pool.home_team);
    const awaySide = findSide(fixture, pool.away_team);
    if (!homeSide || !awaySide || homeSide === awaySide) throw new Error("Provider teams do not match pool teams");

    const scoreFor = (score: any, side: "home" | "away") => score?.[side] ?? null;
    const status = fixture.fixture.status.short;
    const patch = {
      phase: mapPhase(status),
      minute: fixture.fixture.status.elapsed ?? 0,
      current_home: scoreFor(fixture.goals, homeSide) ?? 0,
      current_away: scoreFor(fixture.goals, awaySide) ?? 0,
      half_home: scoreFor(fixture.score.halftime, homeSide),
      half_away: scoreFor(fixture.score.halftime, awaySide),
      final_home: scoreFor(fixture.score.fulltime, homeSide),
      final_away: scoreFor(fixture.score.fulltime, awaySide),
      provider_name: "api-football",
      provider_fixture_id: String(fixtureId),
      provider_status: status,
      provider_error: null,
      updated_at: new Date().toISOString()
    };
    const { error: updateError } = await database.from("match_states").update(patch).eq("pool_id", poolId);
    if (updateError) throw updateError;
    return Response.json({ ok: true, poolId, fixtureId, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    if (poolId) {
      await database.from("match_states").update({
        provider_error: message.slice(0, 500),
        updated_at: new Date().toISOString()
      }).eq("pool_id", poolId);
    }
    // The manual match controls remain authoritative and usable after this failure.
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
});

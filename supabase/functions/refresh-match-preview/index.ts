import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import {
  PreviewProviderError,
  createApiFootballProvider,
  previewProviderErrorBody,
  resolutionWarning
} from "../_shared/api-football-preview.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_COOLDOWN_MS = 45_000;
const recentRefreshes = new Map<string, number>();

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

function publicError(error: unknown, diagnosticAllowed = false) {
  if (error instanceof PreviewProviderError) {
    const body = previewProviderErrorBody(error, diagnosticAllowed);
    const warning = resolutionWarning(body.diagnostic);
    if (warning) console.warn(warning);
    return json(error.status, body);
  }
  return json(500, { error: "preview_failed", message: "No s’ha pogut actualitzar la prèvia del partit." });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed", message: "Mètode no admès." });

  let adminAuthorized = false;
  try {
    const authorization = request.headers.get("Authorization") || "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 8192) {
      return json(401, { error: "unauthorized", message: "Cal iniciar sessió com a administrador." });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const apiFootballKey = Deno.env.get("API_FOOTBALL_KEY");
    if (!supabaseUrl || !supabaseAnonKey) return json(503, { error: "not_configured", message: "El servei no està configurat." });

    const rawBody = await request.text();
    if (rawBody.length > 1024) return json(413, { error: "payload_too_large", message: "La petició és massa gran." });
    const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
    const poolId = body?.poolId;
    if (typeof poolId !== "string" || !UUID_PATTERN.test(poolId)) {
      return json(400, { error: "invalid_pool", message: "La porra no és vàlida." });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } }
    });
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return json(401, { error: "unauthorized", message: "Cal iniciar sessió com a administrador." });

    const { data: admin, error: adminError } = await supabase
      .from("admin_profiles")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (adminError || !admin) return json(403, { error: "forbidden", message: "Aquesta operació requereix permisos d’administració." });
    adminAuthorized = true;

    const cooldownKey = `${authData.user.id}:${poolId}`;
    const lastRefresh = recentRefreshes.get(cooldownKey) || 0;
    if (Date.now() - lastRefresh < REFRESH_COOLDOWN_MS) {
      return json(429, { error: "cooldown", message: "Espera uns segons abans de tornar a actualitzar la prèvia." });
    }
    recentRefreshes.set(cooldownKey, Date.now());

    const { data: pool, error: poolError } = await supabase
      .from("pools")
      .select("id, home_team, away_team, match_at, status")
      .eq("id", poolId)
      .single();
    if (poolError || !pool) return json(404, { error: "pool_not_found", message: "No s’ha trobat la porra." });
    if (pool.status === "finished") return json(409, { error: "pool_finished", message: "No es pot actualitzar la prèvia d’una porra finalitzada." });

    const provider = createApiFootballProvider({ apiKey: apiFootballKey });
    const matchPreview = await provider.fetchPreview({
      homeTeam: pool.home_team,
      awayTeam: pool.away_team,
      matchAt: pool.match_at
    });
    const { data: updated, error: updateError } = await supabase
      .from("pools")
      .update({ match_preview: matchPreview, updated_at: new Date().toISOString() })
      .eq("id", pool.id)
      .select("match_preview")
      .single();
    if (updateError || !updated) throw new PreviewProviderError("save_failed", "No s’ha pogut desar la prèvia.", 500);

    return json(200, { matchPreview: updated.match_preview, warnings: matchPreview.warnings });
  } catch (error) {
    return publicError(error, adminAuthorized);
  }
});

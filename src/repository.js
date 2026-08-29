import {
  calculatePrizes,
  createPool,
  makeId,
  poolMetrics,
  slugify,
  validateMatchUpdate,
  validateSelection
} from "./core.js";
import { participationState } from "./public-experience.js";
import { createDemoMatchPreview } from "./match-preview.js";

export const BETA_SUPABASE_URL = "https://vczrkalsqdzwitpqwdwc.supabase.co";
export const ADMIN_POOL_SELECT = "*, special_bets!special_bets_pool_id_fkey(*)";

const STORAGE_KEY = "porra-live-demo-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function requireSupabaseUuid(value, label = "identificador") {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`El ${label} de Supabase no és un UUID vàlid.`);
  }
  return value;
}

function trackingPrizeFields(preview, betId) {
  const award = (preview?.awards || []).find(item => item.betId === betId);
  const centsFor = category => (award?.breakdown || []).filter(item => item.category === category).reduce((sum, item) => sum + item.cents, 0);
  return {
    prizeCents: award?.totalCents || 0,
    halfPrizeCents: centsFor("half"),
    finalPrizeCents: centsFor("final"),
    specialPrizeCents: centsFor("special"),
    redistributionPrizeCents: centsFor("final-redistribution")
  };
}

function initialData() {
  return { pools: [], participants: [], bets: [], matches: {}, prizeResults: {} };
}

function trackingToken() {
  return globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

export class DemoRepository {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.mode = "demo";
    this.data = this.read();
    this.listeners = new Set();
  }

  read() {
    try {
      return JSON.parse(this.storage?.getItem(STORAGE_KEY)) || initialData();
    } catch {
      return initialData();
    }
  }

  write() {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.data));
    this.listeners.forEach(listener => listener());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getSession() {
    return { user: { email: "demo@local", isDemo: true } };
  }

  async signIn() {
    return this.getSession();
  }

  async signOut() {
    return null;
  }

  async listPools() {
    return [...this.data.pools].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPool(poolIdOrSlug) {
    return this.data.pools.find(pool => pool.id === poolIdOrSlug || pool.slug === poolIdOrSlug) || null;
  }

  async savePool(input) {
    const current = input.id ? await this.getPool(input.id) : null;
    const pool = createPool({ ...current, ...input, id: current?.id || input.id || makeId("pool") });
    if (current) {
      this.data.pools = this.data.pools.map(item => item.id === pool.id ? pool : item);
    } else {
      if (this.data.pools.some(item => item.slug === pool.slug)) pool.slug = `${pool.slug}-${this.data.pools.length + 1}`;
      this.data.pools.push(pool);
      this.data.matches[pool.id] = {
        phase: "pre",
        minute: 0,
        currentHome: 0,
        currentAway: 0,
        halfHome: null,
        halfAway: null,
        finalHome: null,
        finalAway: null,
        specialStatuses: Object.fromEntries(pool.specials.map(item => [item.cellKey, "pending"]))
      };
    }
    this.write();
    return pool;
  }

  async refreshMatchPreview(poolId) {
    const pool = await this.getPool(poolId);
    if (!pool) throw new Error("No s’ha trobat la porra.");
    pool.matchPreview = createDemoMatchPreview(pool);
    pool.updatedAt = new Date().toISOString();
    this.write();
    return pool.matchPreview;
  }

  async saveManualMatchPreview(poolId, matchPreview) {
    const pool = await this.getPool(poolId);
    if (!pool) throw new Error("No s’ha trobat la porra.");
    pool.matchPreview = structuredClone(matchPreview);
    pool.updatedAt = new Date().toISOString();
    this.write();
    return structuredClone(pool.matchPreview);
  }

  async deleteManualMatchPreview(poolId) {
    const pool = await this.getPool(poolId);
    if (!pool) throw new Error("No s’ha trobat la porra.");
    pool.matchPreview = null;
    pool.updatedAt = new Date().toISOString();
    this.write();
    return null;
  }

  async publishPool(poolId) {
    return this.setPoolStatus(poolId, "open", { publishedAt: new Date().toISOString() });
  }

  async setPoolStatus(poolId, status, extra = {}) {
    const pool = await this.getPool(poolId);
    if (!pool) throw new Error("No s'ha trobat la porra.");
    Object.assign(pool, extra, { status, updatedAt: new Date().toISOString() });
    this.write();
    return pool;
  }

  async getPoolState(poolIdOrSlug) {
    const pool = await this.getPool(poolIdOrSlug);
    if (!pool) return null;
    const bets = this.data.bets.filter(bet => bet.poolId === pool.id);
    const participants = this.data.participants.filter(person => person.poolId === pool.id);
    return {
      pool,
      bets,
      participants,
      match: this.data.matches[pool.id],
      prizeResult: this.data.prizeResults[pool.id] || null,
      metrics: poolMetrics(pool, bets)
    };
  }

  async createReservation({ poolId, name, cellKeys }) {
    const pool = await this.getPool(poolId);
    if (!pool) throw new Error("No s'ha trobat la porra.");
    const normalizedName = name.trim().toLocaleLowerCase("ca");
    const participantId = makeId("participant");
    const validation = validateSelection({
      pool,
      bets: this.data.bets.filter(bet => bet.poolId === poolId),
      participantId,
      cellKeys,
      match: this.data.matches[poolId]
    });
    if (!validation.valid) throw new Error(validation.errors[0]);
    const token = trackingToken();
    const participant = {
      id: participantId,
      poolId,
      name: name.trim(),
      normalizedName,
      trackingToken: token,
      createdAt: new Date().toISOString()
    };
    const bets = cellKeys.map(cellKey => ({
      id: makeId("bet"),
      poolId,
      participantId,
      cellKey,
      paymentStatus: "pending",
      createdAt: new Date().toISOString()
    }));
    this.data.participants.push(participant);
    this.data.bets.push(...bets);
    this.write();
    return { participant, bets, token };
  }

  async getTracking(token) {
    const participant = this.data.participants.find(person => person.trackingToken === token);
    if (!participant) return null;
    const state = await this.getPoolState(participant.poolId);
    const bets = state.bets.filter(bet => bet.participantId === participant.id);
    const preview = state.prizeResult || calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
    return {
      pool: state.pool,
      participant,
      bets: bets.map(bet => ({
        ...bet,
        ...trackingPrizeFields(preview, bet.id)
      })),
      match: state.match,
      final: state.pool.status === "finished"
    };
  }

  async updateBet(betId, patch) {
    const bet = this.data.bets.find(item => item.id === betId);
    if (!bet) throw new Error("No s'ha trobat l'aposta.");
    if (patch.cellKey && patch.cellKey !== bet.cellKey) {
      const pool = await this.getPool(bet.poolId);
      const validation = validateSelection({
        pool: { ...pool, status: "open", closesAt: "" },
        bets: this.data.bets.filter(item => item.poolId === bet.poolId && item.id !== bet.id),
        participantId: bet.participantId,
        cellKeys: [patch.cellKey]
      });
      if (!validation.valid) throw new Error(validation.errors[0]);
    }
    Object.assign(bet, patch, { updatedAt: new Date().toISOString() });
    this.write();
    return bet;
  }

  async updateParticipant(participantId, name) {
    const participant = this.data.participants.find(item => item.id === participantId);
    if (!participant) throw new Error("No s'ha trobat el participant.");
    participant.name = name.trim();
    participant.normalizedName = name.trim().toLocaleLowerCase("ca");
    this.write();
    return participant;
  }

  async updateReservation(participantId, { name, bets }) {
    const participant = this.data.participants.find(item => item.id === participantId);
    if (!participant) throw new Error("No s'ha trobat la reserva.");
    const reservationBets = this.data.bets.filter(item => item.participantId === participantId && item.paymentStatus !== "released");
    const updates = bets.filter(update => reservationBets.some(bet => bet.id === update.id));
    const pool = await this.getPool(participant.poolId);
    const validation = validateSelection({
      pool: { ...pool, status: "open", closesAt: "" },
      bets: this.data.bets.filter(item => item.poolId === pool.id && item.participantId !== participantId),
      participantId,
      cellKeys: updates.map(item => item.cellKey)
    });
    if (!validation.valid) throw new Error(validation.errors[0]);
    participant.name = name.trim();
    participant.normalizedName = name.trim().toLocaleLowerCase("ca");
    for (const update of updates) {
      Object.assign(reservationBets.find(bet => bet.id === update.id), { cellKey: update.cellKey, updatedAt: new Date().toISOString() });
    }
    this.write();
    return { participant, bets: reservationBets };
  }

  async updateReservationPayment(participantId, paymentStatus) {
    const bets = this.data.bets.filter(item => item.participantId === participantId && item.paymentStatus !== "released");
    if (!bets.length) throw new Error("No s'ha trobat la reserva.");
    bets.forEach(bet => Object.assign(bet, { paymentStatus, updatedAt: new Date().toISOString() }));
    this.write();
    return bets;
  }

  async updateMatch(poolId, patch) {
    this.data.matches[poolId] = { ...this.data.matches[poolId], ...patch };
    this.write();
    return this.data.matches[poolId];
  }

  async finalizePool(poolId) {
    const state = await this.getPoolState(poolId);
    if (state.metrics.pendingPlaces > 0) {
      throw new Error("Cal confirmar o alliberar totes les apostes pendents abans de finalitzar.");
    }
    if (state.match.phase !== "final") throw new Error("Cal desar el partit en fase Final abans de publicar els premis.");
    const validation = validateMatchUpdate({ match: state.match });
    if (!validation.valid) throw new Error(validation.errors[0]);
    const prizeResult = calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
    this.data.prizeResults[poolId] = { ...prizeResult, finalizedAt: new Date().toISOString() };
    await this.setPoolStatus(poolId, "finished");
    return this.data.prizeResults[poolId];
  }

  async resetDemo() {
    this.data = initialData();
    this.write();
  }
}

export class SupabaseRepository {
  constructor(client) {
    this.client = client;
    this.mode = "supabase";
  }

  static async create(config) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.111.0");
    return new SupabaseRepository(createClient(config.supabaseUrl, config.supabasePublishableKey));
  }

  async getSession() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
  }

  async isAdmin() {
    const session = await this.getSession();
    if (!session?.user) return false;
    const { data, error } = await this.client
      .from("admin_profiles")
      .select("user_id")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  async listAdminPools() {
    const { data, error } = await this.client.from("pools").select(ADMIN_POOL_SELECT).order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(row => {
      const pool = this.mapPool(row);
      requireSupabaseUuid(pool.id, "pool");
      return pool;
    });
  }

  async getPublicPoolState(poolIdOrSlug = "") {
    const { data, error } = await this.client.rpc("get_public_pool_state", {
      pool_identifier: poolIdOrSlug || ""
    });
    if (error) throw error;
    return data;
  }

  async listPools(poolIdOrSlug = "") {
    if (await this.isAdmin()) return this.listAdminPools();
    const state = await this.getPublicPoolState(poolIdOrSlug);
    return state ? [this.mapPool(state.pool)] : [];
  }

  mapPool(row) {
    if (row.homeTeam) return row;
    return {
      id: row.id, slug: row.slug, title: row.title,
      homeTeam: row.home_team, awayTeam: row.away_team,
      homeImage: row.home_image_url || "", awayImage: row.away_image_url || "",
      matchAt: row.match_at, closesAt: row.closes_at,
      priceCents: row.price_cents, poolPerBetCents: row.pool_per_bet_cents,
      feeCents: row.fee_cents, carryoverCents: row.carryover_cents,
      paymentInstructions: row.payment_instructions, organizerNote: row.organizer_note || "", organizerContact: row.organizer_contact || "",
      matchPreview: row.match_preview || null, status: row.status,
      publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at,
      specials: [...(row.special_bets || [])].sort((a, b) => a.sort_order - b.sort_order).map(item => ({
        id: item.id, cellKey: item.cell_key, title: item.title, description: item.description
      }))
    };
  }

  async getPool(poolIdOrSlug) {
    if (await this.isAdmin()) {
      return (await this.listAdminPools()).find(pool => pool.id === poolIdOrSlug || pool.slug === poolIdOrSlug) || null;
    }
    return (await this.getPublicPoolState(poolIdOrSlug))?.pool || null;
  }

  async savePool(input) {
    const session = await this.getSession();
    if (!session?.user) throw new Error("Cal iniciar sessió com a administrador.");
    if (input.id) requireSupabaseUuid(input.id, "pool");
    requireSupabaseUuid(session.user.id, "usuari administrador");
    const current = input.id ? await this.getPool(input.id) : null;
    const pool = createPool({ ...current, ...input, id: input.id });
    const payload = {
      ...(pool.id ? { id: pool.id } : {}),
      slug: current?.slug || slugify(pool.title), title: pool.title,
      home_team: pool.homeTeam, away_team: pool.awayTeam,
      home_image_url: pool.homeImage || null, away_image_url: pool.awayImage || null,
      match_at: pool.matchAt, closes_at: pool.closesAt,
      price_cents: pool.priceCents, pool_per_bet_cents: pool.poolPerBetCents,
      fee_cents: pool.feeCents, carryover_cents: pool.carryoverCents,
      payment_instructions: pool.paymentInstructions, organizer_note: pool.organizerNote || null,
      organizer_contact: pool.organizerContact || null, status: current?.status || "draft",
      created_by: current?.createdBy || session.user.id, updated_at: new Date().toISOString()
    };
    const poolTable = this.client.from("pools");
    const mutation = pool.id ? poolTable.upsert(payload) : poolTable.insert(payload);
    const { data, error } = await mutation.select().single();
    if (error) throw error;
    requireSupabaseUuid(data.id, "pool retornat");
    const specials = pool.specials.map((item, index) => ({
      pool_id: data.id, cell_key: item.cellKey, title: item.title,
      description: item.description || "", sort_order: index + 1
    }));
    const specialResult = await this.client.from("special_bets").upsert(specials, { onConflict: "pool_id,cell_key" });
    if (specialResult.error) throw specialResult.error;
    return this.getPool(data.id);
  }

  async refreshMatchPreview(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.functions.invoke("refresh-match-preview", {
      body: { poolId }
    });
    if (error) {
      let message = typeof data?.message === "string" ? data.message : "";
      if (!message && typeof error.context?.clone === "function") {
        const payload = await error.context.clone().json().catch(() => null);
        if (typeof payload?.message === "string") message = payload.message;
      }
      throw new Error(message.slice(0, 240) || "No s’ha pogut actualitzar la prèvia del partit.");
    }
    return data?.matchPreview || null;
  }

  async saveManualMatchPreview(poolId, matchPreview) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client
      .from("pools")
      .update({ match_preview: matchPreview })
      .eq("id", poolId)
      .select("match_preview")
      .single();
    if (error) throw error;
    return data?.match_preview || null;
  }

  async deleteManualMatchPreview(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { error } = await this.client
      .from("pools")
      .update({ match_preview: null })
      .eq("id", poolId);
    if (error) throw error;
    return null;
  }

  async publishPool(poolId) {
    return this.setPoolStatus(poolId, "open", { published_at: new Date().toISOString() });
  }

  async setPoolStatus(poolId, status, extra = {}) {
    requireSupabaseUuid(poolId, "pool");
    const { error } = await this.client.from("pools").update({ status, ...extra, updated_at: new Date().toISOString() }).eq("id", poolId);
    if (error) throw error;
    return this.getPool(poolId);
  }

  async getPoolState(poolIdOrSlug) {
    if (!(await this.isAdmin())) return this.getPublicPoolState(poolIdOrSlug);
    return this.getAdminPoolState(poolIdOrSlug);
  }

  async getAdminPoolState(poolIdOrSlug) {
    const pool = (await this.listAdminPools()).find(item => item.id === poolIdOrSlug || item.slug === poolIdOrSlug);
    if (!pool) return null;
    const [betsResult, participantsResult, matchResult, specialsResult, prizeResult, awardsResult] = await Promise.all([
      this.client.from("bets").select("*").eq("pool_id", pool.id),
      this.client.from("participants").select("*").eq("pool_id", pool.id),
      this.client.from("match_states").select("*").eq("pool_id", pool.id).single(),
      this.client.from("special_results").select("special_bet_id,status").eq("pool_id", pool.id),
      this.client.from("prize_results").select("*").eq("pool_id", pool.id).maybeSingle(),
      this.client.from("prize_awards").select("*").eq("pool_id", pool.id)
    ]);
    const failure = [betsResult, participantsResult, matchResult, specialsResult, prizeResult, awardsResult].find(result => result.error);
    if (failure) throw failure.error;
    const statusById = Object.fromEntries(specialsResult.data.map(item => [item.special_bet_id, item.status]));
    const bets = betsResult.data.map(item => ({
      id: item.id, poolId: item.pool_id, participantId: item.participant_id,
      cellKey: item.cell_key, paymentStatus: item.payment_status, createdAt: item.created_at
    }));
    const participants = participantsResult.data.map(item => ({
      id: item.id, poolId: item.pool_id, name: item.display_name, createdAt: item.created_at
    }));
    const rawMatch = matchResult.data;
    const match = {
      phase: rawMatch.phase, minute: rawMatch.minute,
      currentHome: rawMatch.current_home, currentAway: rawMatch.current_away,
      halfHome: rawMatch.half_home, halfAway: rawMatch.half_away,
      finalHome: rawMatch.final_home, finalAway: rawMatch.final_away,
      specialStatuses: Object.fromEntries(pool.specials.map(item => [item.cellKey, statusById[item.id] || "pending"]))
    };
    const groupedAwards = new Map();
    for (const row of awardsResult.data) {
      const award = groupedAwards.get(row.bet_id) || { betId: row.bet_id, totalCents: 0, breakdown: [] };
      award.totalCents += row.amount_cents;
      award.breakdown.push({ category: row.category, cents: row.amount_cents });
      groupedAwards.set(row.bet_id, award);
    }
    const savedPrize = prizeResult.data ? {
      ...prizeResult.data.calculation,
      totalPotCents: prizeResult.data.total_pot_cents,
      carryoverCents: prizeResult.data.carryover_cents,
      awards: [...groupedAwards.values()]
    } : null;
    return { pool, bets, participants, match, prizeResult: savedPrize, metrics: poolMetrics(pool, bets) };
  }

  async createReservation({ poolId, name, cellKeys, invitationToken }) {
    const state = await this.getPublicPoolState(poolId);
    if (!state) throw new Error("No s'ha trobat la porra.");
    const participation = participationState(state);
    if (!participation.open) throw new Error(participation.message);
    const { data, error } = await this.client.rpc("create_public_reservation", {
      target_pool_id: poolId,
      participant_name: name,
      selected_cells: cellKeys,
      invitation_token: invitationToken
    });
    if (error) throw error;
    return data;
  }

  async createPoolShareLink(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_create_pool_share_link", { target_pool_id: poolId });
    if (error) throw error;
    return data;
  }

  async getPoolShareLink(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_get_pool_share_link", { target_pool_id: poolId });
    if (error) throw error;
    return data;
  }

  async rotatePoolShareLink(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_rotate_pool_share_link", { target_pool_id: poolId });
    if (error) throw error;
    return data;
  }
  async createPoolInvitation(poolId, expiresAt) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_create_pool_invitation", {
      target_pool_id: poolId,
      invitation_expires_at: expiresAt
    });
    if (error) throw error;
    return data;
  }

  async listPoolInvitations(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_list_pool_invitations", {
      target_pool_id: poolId
    });
    if (error) throw error;
    return data || [];
  }

  async revokePoolInvitation(invitationId) {
    requireSupabaseUuid(invitationId, "invitació");
    const { data, error } = await this.client.rpc("admin_revoke_pool_invitation", {
      target_invitation_id: invitationId
    });
    if (error) throw error;
    return data;
  }

  async getTracking(token) {
    const { data, error } = await this.client.rpc("get_tracking_state", { raw_tracking_token: token });
    if (error) throw error;
    if (!data) return data;
    const state = await this.getPublicPoolState(data.pool.id);
    const preview = state.prizeResult || calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
    return {
      ...data,
      bets: data.bets.map(bet => {
        const prizeFields = trackingPrizeFields(preview, bet.id);
        return { ...bet, ...prizeFields, prizeCents: bet.prizeCents ?? prizeFields.prizeCents };
      })
    };
  }

  async updateBet(betId, patch) {
    requireSupabaseUuid(betId, "aposta");
    const payload = {};
    if (patch.cellKey) payload.cell_key = patch.cellKey;
    if (patch.paymentStatus) {
      payload.payment_status = patch.paymentStatus;
      if (patch.paymentStatus === "paid") payload.paid_at = new Date().toISOString();
      if (patch.paymentStatus === "released") payload.released_at = new Date().toISOString();
    }
    const { data, error } = await this.client.from("bets").update(payload).eq("id", betId).select().single();
    if (error) throw error;
    return data;
  }

  async updateParticipant(participantId, name) {
    requireSupabaseUuid(participantId, "participant");
    const { data, error } = await this.client.from("participants").update({
      display_name: name.trim(), normalized_name: name.trim().toLocaleLowerCase("ca"), updated_at: new Date().toISOString()
    }).eq("id", participantId).select().single();
    if (error) throw error;
    return data;
  }

  async updateReservation(participantId, { name, bets }) {
    requireSupabaseUuid(participantId, "participant");
    bets.forEach(bet => requireSupabaseUuid(bet.id, "aposta"));
    const { data, error } = await this.client.rpc("admin_update_reservation", {
      target_participant_id: participantId,
      participant_name: name,
      bet_updates: bets.map(bet => ({ id: bet.id, cellKey: bet.cellKey }))
    });
    if (error) throw error;
    return data;
  }

  async updateReservationPayment(participantId, paymentStatus) {
    requireSupabaseUuid(participantId, "participant");
    const payload = { payment_status: paymentStatus, updated_at: new Date().toISOString() };
    if (paymentStatus === "paid") payload.paid_at = new Date().toISOString();
    if (paymentStatus === "released") payload.released_at = new Date().toISOString();
    const { data, error } = await this.client.from("bets").update(payload).eq("participant_id", participantId).neq("payment_status", "released").select();
    if (error) throw error;
    return data;
  }

  async updateMatch(poolId, patch) {
    requireSupabaseUuid(poolId, "pool");
    const { data, error } = await this.client.rpc("admin_update_match", {
      target_pool_id: poolId,
      match_patch: patch
    });
    if (error) throw error;
    return data;
  }

  async finalizePool(poolId) {
    requireSupabaseUuid(poolId, "pool");
    const state = await this.getPoolState(poolId);
    if (state.metrics.pendingPlaces > 0) throw new Error("Cal confirmar o alliberar totes les apostes pendents abans de finalitzar.");
    if (state.match.phase !== "final") throw new Error("Cal desar el partit en fase Final abans de publicar els premis.");
    const validation = validateMatchUpdate({ match: state.match });
    if (!validation.valid) throw new Error(validation.errors[0]);
    const result = calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
    const { data, error } = await this.client.rpc("admin_finalize_pool", {
      target_pool_id: poolId,
      prize_calculation: result
    });
    if (error) throw error;
    return data;
  }

  subscribe(poolSlug, listener) {
    let active = true;
    let channel = null;
    let retryTimer = null;

    const connect = () => {
      if (!active) return;
      channel = this.client.channel(`porra-live-${poolSlug}-${Date.now()}`)
        .on("postgres_changes", {
          event: "UPDATE",
          schema: "public",
          table: "pool_revisions",
          filter: `pool_slug=eq.${poolSlug}`
        }, listener)
        .subscribe(status => {
          if (!active) return;
          if (status === "SUBSCRIBED") {
            listener();
            return;
          }
          if (!["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) || retryTimer) return;
          const staleChannel = channel;
          retryTimer = setTimeout(async () => {
            retryTimer = null;
            if (staleChannel) await this.client.removeChannel(staleChannel);
            connect();
          }, 1000);
        });
    };

    connect();
    return () => {
      active = false;
      clearTimeout(retryTimer);
      if (channel) void this.client.removeChannel(channel);
    };
  }
}

export async function createRepository(config = {}) {
  if (config.mode === "supabase" && config.supabaseUrl && config.supabasePublishableKey) {
    if (config.supabaseUrl !== BETA_SUPABASE_URL) {
      throw new Error("Aquesta versió del frontend només es pot connectar a porra-live-beta.");
    }
    return SupabaseRepository.create(config);
  }
  return new DemoRepository();
}

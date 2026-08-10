export const POOL_STATUSES = ["draft", "open", "closed", "finished"];
export const PAYMENT_STATUSES = ["pending", "paid", "released"];
export const SPECIAL_STATUSES = ["pending", "completed", "failed"];
export const SPECIAL_CELLS = ["3-3", "3-4", "4-3", "4-4"];
export const MAX_BETS_PER_PARTICIPANT = 2;
export const MAX_OCCUPANCY_PER_CELL = 2;

export function makeId(prefix = "id") {
  const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `porra-${Date.now()}`;
}

export function toCents(value) {
  const number = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export function formatMoney(cents, locale = "ca-ES") {
  return (Number(cents || 0) / 100).toLocaleString(locale, {
    style: "currency",
    currency: "EUR"
  });
}

export function formatDateTime(value) {
  if (!value) return "Per definir";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Per definir";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ca-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.day}/${parts.month}/${parts.year} · ${parts.hour}:${parts.minute}`;
}

export function resultCell(home, away) {
  return `${Number(home)}-${Number(away)}`;
}

export function isSpecialCell(cellKey) {
  return SPECIAL_CELLS.includes(cellKey);
}

export function listCells() {
  return Array.from({ length: 25 }, (_, index) => {
    const away = Math.floor(index / 5);
    const home = index % 5;
    return resultCell(home, away);
  });
}

export function activeBets(bets) {
  return bets.filter(bet => bet.paymentStatus !== "released");
}

export function paidBets(bets) {
  return bets.filter(bet => bet.paymentStatus === "paid");
}

export function occupancyForCell(bets, cellKey) {
  return activeBets(bets).filter(bet => bet.cellKey === cellKey).length;
}

export function participantBets(bets, participantId) {
  return activeBets(bets).filter(bet => bet.participantId === participantId);
}

export function validateSelection({ pool, bets, participantId, cellKeys, now = new Date() }) {
  const errors = [];
  const unique = [...new Set(cellKeys)];
  if (pool.status !== "open") errors.push("La porra no està oberta.");
  if (pool.closesAt && now >= new Date(pool.closesAt)) errors.push("El termini de participació ha finalitzat.");
  if (cellKeys.length < 1 || cellKeys.length > MAX_BETS_PER_PARTICIPANT) {
    errors.push("Cal seleccionar una o dues apostes.");
  }
  if (unique.length !== cellKeys.length) errors.push("No es pot repetir la mateixa casella.");
  const existing = participantBets(bets, participantId);
  if (existing.length + unique.length > MAX_BETS_PER_PARTICIPANT) {
    errors.push("Cada participant pot tenir un màxim de dues apostes.");
  }
  for (const cellKey of unique) {
    if (!listCells().includes(cellKey)) errors.push(`La casella ${cellKey} no existeix.`);
    if (existing.some(bet => bet.cellKey === cellKey)) errors.push(`Ja tens una aposta a ${cellKey}.`);
    if (occupancyForCell(bets, cellKey) >= MAX_OCCUPANCY_PER_CELL) {
      errors.push(`La casella ${cellKey} ja està completa.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function poolMetrics(pool, bets) {
  const active = activeBets(bets);
  const paid = paidBets(bets);
  const pending = active.filter(bet => bet.paymentStatus === "pending");
  return {
    capacity: 50,
    freePlaces: Math.max(0, 50 - active.length),
    pendingPlaces: pending.length,
    paidPlaces: paid.length,
    confirmedRevenueCents: paid.length * pool.priceCents,
    confirmedPoolCents: paid.length * pool.poolPerBetCents,
    potentialPoolCents: active.length * pool.poolPerBetCents,
    confirmedFeeCents: paid.length * pool.feeCents
  };
}

function allocateEqual(totalCents, winnerIds) {
  const sorted = [...new Set(winnerIds)].sort();
  if (!sorted.length || totalCents <= 0) return new Map();
  const base = Math.floor(totalCents / sorted.length);
  let remainder = totalCents - base * sorted.length;
  return new Map(sorted.map(id => [id, base + (remainder-- > 0 ? 1 : 0)]));
}

function splitPot(totalCents) {
  const categories = [
    { key: "halfBase", weight: 25, order: 0 },
    { key: "finalBase", weight: 50, order: 1 },
    { key: "specialBase", weight: 25, order: 2 }
  ].map(category => {
    const numerator = totalCents * category.weight;
    return { ...category, cents: Math.floor(numerator / 100), remainder: numerator % 100 };
  });
  let undistributed = totalCents - categories.reduce((sum, category) => sum + category.cents, 0);
  [...categories]
    .sort((a, b) => b.remainder - a.remainder || a.order - b.order)
    .forEach(category => {
      if (undistributed > 0) {
        categories.find(item => item.key === category.key).cents += 1;
        undistributed -= 1;
      }
    });
  return Object.fromEntries(categories.map(category => [category.key, category.cents]));
}

function addAwards(target, source, category) {
  for (const [betId, cents] of source) {
    const current = target.get(betId) || { betId, totalCents: 0, breakdown: [] };
    current.totalCents += cents;
    current.breakdown.push({ category, cents });
    target.set(betId, current);
  }
}

export function calculatePrizes({ pool, bets, match }) {
  const eligible = paidBets(bets);
  const totalPotCents = eligible.length * pool.poolPerBetCents + Number(pool.carryoverCents || 0);
  const { halfBase, finalBase, specialBase } = splitPot(totalPotCents);

  const halfKey = match.halfHome == null || match.halfAway == null
    ? null
    : resultCell(match.halfHome, match.halfAway);
  const finalKey = match.finalHome == null || match.finalAway == null
    ? null
    : resultCell(match.finalHome, match.finalAway);
  const halfWinners = halfKey && !isSpecialCell(halfKey)
    ? eligible.filter(bet => bet.cellKey === halfKey).map(bet => bet.id)
    : [];
  const finalWinners = finalKey && !isSpecialCell(finalKey)
    ? eligible.filter(bet => bet.cellKey === finalKey).map(bet => bet.id)
    : [];
  const completedSpecials = new Set(
    Object.entries(match.specialStatuses || {})
      .filter(([, status]) => status === "completed")
      .map(([cellKey]) => cellKey)
  );
  const specialWinners = eligible
    .filter(bet => completedSpecials.has(bet.cellKey))
    .map(bet => bet.id);

  const awards = new Map();
  const allWinnerIds = [...new Set([...halfWinners, ...finalWinners, ...specialWinners])];
  if (!allWinnerIds.length) {
    return {
      totalPotCents,
      carryoverCents: totalPotCents,
      allocations: { halfBase, finalBase, specialBase, finalAvailable: 0 },
      winners: { half: [], final: [], special: [] },
      awards: []
    };
  }

  if (halfWinners.length) addAwards(awards, allocateEqual(halfBase, halfWinners), "half");
  if (specialWinners.length) addAwards(awards, allocateEqual(specialBase, specialWinners), "special");

  let finalAvailable = finalBase;
  if (!halfWinners.length) finalAvailable += halfBase;
  if (!specialWinners.length) finalAvailable += specialBase;

  if (finalWinners.length) {
    addAwards(awards, allocateEqual(finalAvailable, finalWinners), "final");
  } else {
    const redistributionWinners = [...new Set([...halfWinners, ...specialWinners])];
    addAwards(awards, allocateEqual(finalAvailable, redistributionWinners), "final-redistribution");
  }

  const distributed = [...awards.values()].reduce((sum, award) => sum + award.totalCents, 0);
  if (distributed !== totalPotCents) {
    throw new Error(`Prize invariant failed: distributed ${distributed}, expected ${totalPotCents}`);
  }

  return {
    totalPotCents,
    carryoverCents: 0,
    allocations: { halfBase, finalBase, specialBase, finalAvailable },
    winners: { half: halfWinners, final: finalWinners, special: specialWinners },
    awards: [...awards.values()].sort((a, b) => a.betId.localeCompare(b.betId))
  };
}

export function createPool(input = {}) {
  const priceCents = toCents(input.price ?? 4);
  const poolPerBetCents = toCents(input.poolPerBet ?? 3.5);
  const feeCents = toCents(input.fee ?? 0.5);
  if (priceCents !== poolPerBetCents + feeCents) {
    throw new Error("El preu ha de coincidir amb la suma del pot i la gestió.");
  }
  const id = input.id || makeId("pool");
  return {
    id,
    slug: input.slug || slugify(input.title),
    title: String(input.title || "").trim(),
    homeTeam: String(input.homeTeam || "").trim(),
    awayTeam: String(input.awayTeam || "").trim(),
    homeImage: String(input.homeImage || "").trim(),
    awayImage: String(input.awayImage || "").trim(),
    matchAt: input.matchAt || "",
    closesAt: input.closesAt || "",
    priceCents,
    poolPerBetCents,
    feeCents,
    carryoverCents: toCents(input.carryover ?? 0),
    paymentInstructions: String(input.paymentInstructions || "").trim(),
    status: POOL_STATUSES.includes(input.status) ? input.status : "draft",
    publishedAt: input.publishedAt || null,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    specials: SPECIAL_CELLS.map((cellKey, index) => ({
      cellKey,
      title: String(input.specials?.[index]?.title || `Especial ${index + 1}`).trim(),
      description: String(input.specials?.[index]?.description || "").trim()
    }))
  };
}

import { calculatePrizes, hasMatchStarted, isSpecialCell, resultCell } from "./core.js";

export const STARTED_BETS_MESSAGE = "Les apostes estan tancades. El partit ja ha començat.";

export function participationState({ pool, match, now = new Date() }) {
  if (hasMatchStarted(match)) return { open: false, reason: "started", message: STARTED_BETS_MESSAGE };
  if (pool.status !== "open") return { open: false, reason: "status", message: "Les participacions estan tancades." };
  if (pool.closesAt && now >= new Date(pool.closesAt)) return { open: false, reason: "deadline", message: "El termini de participació ha finalitzat." };
  return { open: true, reason: null, message: "" };
}

export function halfTimeResultCell(match) {
  if (!["half", "second", "final"].includes(match?.phase) || match.halfHome == null || match.halfAway == null) return null;
  return resultCell(match.halfHome, match.halfAway);
}

function resolvedHalfResultCell(match) {
  if (!["half", "second", "final"].includes(match?.phase) || match.halfHome == null || match.halfAway == null) return null;
  return resultCell(match.halfHome, match.halfAway);
}

export function halfTimeCellState(match, cellKey) {
  const isResult = halfTimeResultCell(match) === cellKey;
  return { isResult, accessibleLabel: isResult ? "Resultat del descans" : "" };
}

export function finalResultCell(match) {
  if (match?.phase !== "final" || match.finalHome == null || match.finalAway == null) return null;
  return resultCell(match.finalHome, match.finalAway);
}

export function finalResultCellState(match, cellKey) {
  const isResult = finalResultCell(match) === cellKey;
  return { isResult, accessibleLabel: isResult ? "Resultat final" : "" };
}

export function publicPhasePresentation(match) {
  if (match?.phase === "final") return { heading: "FINAL", eyebrow: "Resultat definitiu", showMinute: false };
  if (match?.phase === "half") return { heading: "Descans", eyebrow: "Seguiment en directe", showMinute: true };
  return { heading: "Partit en curs", eyebrow: "Seguiment en directe", showMinute: true };
}

export function showPublicLiveScorebar(match) {
  return !["half", "final"].includes(match?.phase);
}

function publicParticipantForBet({ bet, participants = [], winnerParticipations = [] }) {
  const participant = participants.find(item => item.id === bet?.participantId);
  if (participant) return { key: `participant:${participant.id}`, name: participant.name };
  const publicIndex = winnerParticipations.findIndex(item => item.betIds?.includes(bet?.id));
  if (publicIndex >= 0) return { key: `public:${publicIndex}`, name: winnerParticipations[publicIndex].name };
  return { key: `bet:${bet?.id}`, name: bet?.participantName || "" };
}

function awardCents(result, betId, categories) {
  return result.awards.find(award => award.betId === betId)?.breakdown
    ?.filter(item => categories.includes(item.category))
    .reduce((sum, item) => sum + item.cents, 0) || 0;
}

function winnerEntries(state, result, betIds, categories) {
  return betIds.map(betId => {
    const bet = state.bets.find(item => item.id === betId);
    const participant = publicParticipantForBet({ bet, participants: state.participants, winnerParticipations: state.winnerParticipations });
    return { betId, participantKey: participant.key, name: participant.name, cents: awardCents(result, betId, categories) };
  });
}

export function halfTimeOutcome({ pool, bets, participants = [], winnerParticipations = [], match, prizeResult }) {
  const cellKey = resolvedHalfResultCell(match);
  if (!cellKey) return null;
  const result = prizeResult || calculatePrizes({ pool, bets, match });
  const state = { pool, bets, participants, winnerParticipations, match };
  const winners = winnerEntries(state, result, result.winners.half, ["half"]);
  return {
    cellKey,
    potCents: result.allocations.halfBase,
    winners,
    disposition: winners.length ? "awarded" : "redistribute-to-final",
    ruleText: winners.length
      ? "La franja del descans queda repartida definitivament entre les apostes pagades guanyadores."
      : "La franja del descans es redistribuirà amb la franja del resultat final segons les regles actuals del pot."
  };
}

export function finalSummaryState(state) {
  if (state.match?.phase !== "final") return null;
  const missing = [];
  if (state.match.halfHome == null || state.match.halfAway == null) missing.push("resultat del descans");
  if (state.match.finalHome == null || state.match.finalAway == null) missing.push("resultat final");
  const unresolvedSpecials = state.pool.specials.filter(item => !["completed", "failed"].includes(state.match.specialStatuses?.[item.cellKey]));
  if (unresolvedSpecials.length) missing.push("resolució de totes les especials");
  if (missing.length) return { complete: false, missing };

  const result = state.prizeResult || calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
  const halfWinners = winnerEntries(state, result, result.winners.half, ["half"]);
  const finalWinners = winnerEntries(state, result, result.winners.final, ["final"]);
  const specials = state.pool.specials.map(special => {
    const status = state.match.specialStatuses[special.cellKey];
    const betIds = status === "completed"
      ? result.winners.special.filter(betId => state.bets.find(bet => bet.id === betId)?.cellKey === special.cellKey)
      : [];
    return { ...special, status, winners: winnerEntries(state, result, betIds, ["special"]) };
  });
  const participantTotals = new Map();
  for (const award of result.awards) {
    const bet = state.bets.find(item => item.id === award.betId);
    const participant = publicParticipantForBet({ bet, participants: state.participants, winnerParticipations: state.winnerParticipations });
    const summary = participantTotals.get(participant.key) || { participantKey: participant.key, name: participant.name, totalCents: 0, breakdown: {} };
    summary.totalCents += award.totalCents;
    for (const item of award.breakdown || []) summary.breakdown[item.category] = (summary.breakdown[item.category] || 0) + item.cents;
    participantTotals.set(participant.key, summary);
  }
  const redistributed = result.allocations.finalAvailable > result.allocations.finalBase;
  let finalRuleText = "La franja del resultat final s'ha repartit entre les apostes pagades guanyadores.";
  if (finalWinners.length && redistributed) finalRuleText = "La franja del resultat final incorpora la redistribució prevista per les categories sense guanyador.";
  if (!finalWinners.length && result.carryoverCents > 0) finalRuleText = "Com que no hi ha cap aposta guanyadora en cap categoria, el pot queda acumulat segons les regles actuals.";
  else if (!finalWinners.length) finalRuleText = "La franja del resultat final es redistribueix entre les apostes guanyadores del descans i les especials segons les regles actuals.";
  return {
    complete: true,
    result,
    half: { cellKey: resolvedHalfResultCell(state.match), winners: halfWinners },
    final: { cellKey: finalResultCell(state.match), winners: finalWinners, ruleText: finalRuleText },
    specials,
    participants: [...participantTotals.values()]
  };
}

export function trackingHalfTimeState({ pool, match, bet }) {
  const participation = participationState({ pool, match });
  const cellKey = resolvedHalfResultCell(match);
  const resolved = Boolean(cellKey);
  if (!resolved) return { readOnly: !participation.open, label: "Pendent de resultat", won: false };
  if (bet.paymentStatus !== "paid") {
    return { readOnly: true, label: bet.cellKey === cellKey ? "Resultat coincident, però el pagament no està confirmat" : "No guanyadora al descans", won: false };
  }
  const won = bet.cellKey === cellKey && !isSpecialCell(cellKey) && Number(bet.halfPrizeCents || 0) > 0;
  return { readOnly: true, label: won ? "Guanyadora del descans" : "No guanyadora al descans", won };
}

export function trackingFinalState({ pool, match, bet }) {
  const readOnly = !participationState({ pool, match }).open;
  if (match?.phase !== "final") return { readOnly, pending: true, finalLabel: "Pendent de resultat", specialLabel: "Pendent de resultat" };
  const missing = match.finalHome == null || match.finalAway == null
    || pool.specials.some(item => !["completed", "failed"].includes(match.specialStatuses?.[item.cellKey]));
  if (missing) return { readOnly: true, pending: true, finalLabel: "Pendent de completar des d'Administració", specialLabel: "Pendent de completar des d'Administració" };
  const finalKey = finalResultCell(match);
  const pendingPayment = bet.paymentStatus !== "paid";
  const finalWon = !pendingPayment && bet.cellKey === finalKey && !isSpecialCell(bet.cellKey) && Number(bet.finalPrizeCents || 0) > 0;
  const specialStatus = isSpecialCell(bet.cellKey) ? match.specialStatuses?.[bet.cellKey] : null;
  const specialWon = !pendingPayment && specialStatus === "completed" && Number(bet.specialPrizeCents || 0) > 0;
  return {
    readOnly: true,
    pending: false,
    finalWon,
    specialWon,
    finalLabel: pendingPayment && bet.cellKey === finalKey ? "Resultat coincident, però el pagament no està confirmat" : finalWon ? "Guanyadora del resultat final" : "No guanyadora del resultat final",
    specialLabel: !isSpecialCell(bet.cellKey) ? "No és una aposta especial" : pendingPayment && specialStatus === "completed" ? "Especial completada, però el pagament no està confirmat" : specialWon ? "Guanyadora especial" : specialStatus === "failed" ? "Especial no completada" : "Especial sense premi"
  };
}

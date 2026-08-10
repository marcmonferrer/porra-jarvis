import { calculatePrizes, hasMatchStarted, isSpecialCell, resultCell } from "./core.js";

export const STARTED_BETS_MESSAGE = "Les apostes estan tancades. El partit ja ha començat.";

export function participationState({ pool, match, now = new Date() }) {
  if (hasMatchStarted(match)) return { open: false, reason: "started", message: STARTED_BETS_MESSAGE };
  if (pool.status !== "open") return { open: false, reason: "status", message: "Les participacions estan tancades." };
  if (pool.closesAt && now >= new Date(pool.closesAt)) return { open: false, reason: "deadline", message: "El termini de participació ha finalitzat." };
  return { open: true, reason: null, message: "" };
}

export function halfTimeResultCell(match) {
  if (match?.phase !== "half" || match.halfHome == null || match.halfAway == null) return null;
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

export function halfTimeOutcome({ pool, bets, participants = [], match }) {
  const cellKey = resolvedHalfResultCell(match);
  if (!cellKey) return null;
  const result = calculatePrizes({ pool, bets, match });
  const winners = result.winners.half.map(betId => {
    const bet = bets.find(item => item.id === betId);
    const participant = participants.find(item => item.id === bet?.participantId);
    const cents = result.awards.find(award => award.betId === betId)?.breakdown
      ?.filter(item => item.category === "half")
      .reduce((sum, item) => sum + item.cents, 0) || 0;
    return { betId, participantId: bet?.participantId, name: participant?.name || "Participant", cents };
  });
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

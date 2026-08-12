export const INVALID_INVITATION_MESSAGE = "Aquesta invitació no és vàlida o ja no està disponible.";

const INVITATION_PATTERN = /^[0-9a-f]{64}$/;

export function isInvitationToken(value) {
  return typeof value === "string" && INVITATION_PATTERN.test(value);
}

function cleanInvitationFragment(locationObject, historyObject) {
  const cleanUrl = `${locationObject.pathname || ""}${locationObject.search || ""}`;
  historyObject.replaceState(historyObject.state ?? null, "", cleanUrl);
}

export function captureInvitationFromUrl({ location: locationObject, history: historyObject }) {
  let token = null;
  const rawFragment = String(locationObject?.hash || "");
  const detected = rawFragment.startsWith("#invite=");

  if (detected) {
    const candidate = rawFragment.slice("#invite=".length);
    cleanInvitationFragment(locationObject, historyObject);
    if (isInvitationToken(candidate)) token = candidate;
  }

  return {
    detected,
    valid: Boolean(token),
    hasToken() {
      return Boolean(token);
    },
    value() {
      return token;
    },
    clear() {
      token = null;
    }
  };
}

export function isInvalidInvitationError(error) {
  return error?.message === "Invalid invitation";
}

export function isTerminalReservationError(error) {
  return new Set([
    "Pool not found",
    "Pool is closed",
    "Bets are closed because the match has started"
  ]).has(error?.message);
}

export function buildInvitationUrl({ baseUrl, poolSlug, invitationToken }) {
  if (!isInvitationToken(invitationToken)) throw new Error("Invalid invitation");
  const url = new URL(baseUrl);
  url.search = "";
  if (poolSlug) url.searchParams.set("pool", poolSlug);
  url.hash = `invite=${invitationToken}`;
  return url.toString();
}

export function buildWhatsAppInvitationUrl({ invitationUrl, poolTitle }) {
  const message = `${poolTitle}\nInvitació privada per participar a Porra Live:\n${invitationUrl}`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

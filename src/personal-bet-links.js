export const PERSONAL_BET_STORAGE_KEY = "porra-jarvis-personal-bet-links-v1";
export const INVALID_PERSONAL_BET_MESSAGE = "No s’ha pogut recuperar aquesta aposta.";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const LEGACY_TRACKING_PATTERN = /^[0-9A-Za-z_-]{16,256}$/;
const POOL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export function isValidPersonalBetToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function isValidPoolSlug(value) {
  return typeof value === "string" && POOL_PATTERN.test(value);
}

function currentUrl(locationObject) {
  if (locationObject?.href) return new URL(locationObject.href);
  const origin = locationObject?.origin || "https://local.invalid";
  return new URL(`${origin}${locationObject?.pathname || "/"}${locationObject?.search || ""}${locationObject?.hash || ""}`);
}

function readStoredTokens(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PERSONAL_BET_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([poolSlug, token]) =>
      isValidPoolSlug(poolSlug) && isValidPersonalBetToken(token)
    ));
  } catch {
    return {};
  }
}

function writeStoredTokens(storage, tokens) {
  if (!storage) return;
  if (Object.keys(tokens).length) storage.setItem(PERSONAL_BET_STORAGE_KEY, JSON.stringify(tokens));
  else storage.removeItem?.(PERSONAL_BET_STORAGE_KEY);
}

export function createPersonalBetAccess({ storage = globalThis.localStorage } = {}) {
  return {
    get(poolSlug) {
      return isValidPoolSlug(poolSlug) ? readStoredTokens(storage)[poolSlug] || "" : "";
    },
    save(poolSlug, token) {
      if (!isValidPoolSlug(poolSlug) || !isValidPersonalBetToken(token)) return false;
      writeStoredTokens(storage, { ...readStoredTokens(storage), [poolSlug]: token });
      return true;
    },
    remove(poolSlug) {
      if (!isValidPoolSlug(poolSlug)) return;
      const tokens = readStoredTokens(storage);
      delete tokens[poolSlug];
      writeStoredTokens(storage, tokens);
    }
  };
}

export function capturePersonalBetAccessFromUrl({
  location: locationObject,
  history: historyObject,
  storage = globalThis.localStorage
}) {
  const url = currentUrl(locationObject);
  const access = createPersonalBetAccess({ storage });
  const fragment = url.hash || "";
  const personalDetected = fragment.startsWith("#mybet=");
  const poolSlug = url.searchParams.get("pool") || "";
  const candidate = personalDetected ? fragment.slice("#mybet=".length) : "";
  const personalValid = personalDetected && isValidPoolSlug(poolSlug) && isValidPersonalBetToken(candidate);
  const legacyCandidate = url.searchParams.get("track") || "";
  const legacyToken = LEGACY_TRACKING_PATTERN.test(legacyCandidate) ? legacyCandidate : "";
  const legacyDetected = url.searchParams.has("track");

  if (personalValid) access.save(poolSlug, candidate);

  if (personalDetected || legacyDetected) {
    url.searchParams.delete("track");
    url.hash = "tracking";
    historyObject.replaceState({ navigation: true }, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return {
    access,
    detected: personalDetected || legacyDetected,
    personalDetected,
    valid: personalValid,
    poolSlug,
    token: personalValid ? candidate : "",
    legacyToken
  };
}

export function buildPersonalBetUrl({ baseUrl, poolSlug, recoveryToken }) {
  if (!isValidPoolSlug(poolSlug) || !isValidPersonalBetToken(recoveryToken)) {
    throw new Error("No es pot crear l’enllaç personal.");
  }
  const url = new URL(baseUrl);
  url.search = "";
  url.searchParams.set("pool", poolSlug);
  url.hash = `mybet=${recoveryToken}`;
  return url.toString();
}

export function parsePersonalBetInput(value, fallbackPoolSlug = "") {
  const candidate = String(value || "").trim();
  if (isValidPersonalBetToken(candidate) && isValidPoolSlug(fallbackPoolSlug)) {
    return { kind: "personal", poolSlug: fallbackPoolSlug, token: candidate };
  }
  try {
    const url = new URL(candidate);
    const token = url.hash.startsWith("#mybet=") ? url.hash.slice("#mybet=".length) : "";
    const poolSlug = url.searchParams.get("pool") || "";
    if (isValidPoolSlug(poolSlug) && isValidPersonalBetToken(token)) {
      return { kind: "personal", poolSlug, token };
    }
  } catch {
    // Legacy tracking identifiers are handled below.
  }
  if (LEGACY_TRACKING_PATTERN.test(candidate)) return { kind: "legacy", token: candidate };
  return null;
}

export function generateSecureRecoveryToken(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.getRandomValues) throw new Error("No hi ha una font aleatòria segura disponible.");
  const bytes = new Uint8Array(32);
  cryptoObject.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

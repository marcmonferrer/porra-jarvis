import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  INVALID_INVITATION_MESSAGE,
  buildInvitationUrl,
  buildWhatsAppInvitationUrl,
  captureInvitationFromUrl,
  isInvalidInvitationError,
  isInvitationToken,
  isTerminalReservationError
} from "../src/invitations.js";
import { createRepository } from "../src/repository.js";

const token = "a".repeat(64);

function browserUrl(hash) {
  const calls = [];
  return {
    location: { pathname: "/porra-live/", search: "?pool=beta", hash },
    history: {
      state: { navigation: true },
      replaceState(...args) { calls.push(args); }
    },
    calls
  };
}

test("captura el fragment d'invitació en memòria i neteja immediatament l'URL", () => {
  const browser = browserUrl(`#invite=${token}`);
  const invitation = captureInvitationFromUrl(browser);
  assert.equal(invitation.detected, true);
  assert.equal(invitation.valid, true);
  assert.equal(invitation.value(), token);
  assert.deepEqual(browser.calls, [[{ navigation: true }, "", "/porra-live/?pool=beta"]]);
  invitation.clear();
  assert.equal(invitation.value(), null);
});

test("rebutja i elimina fragments mal formats o uppercase amb el mateix estat públic", () => {
  for (const candidate of ["short", "A".repeat(64), `${token}&extra=1`]) {
    const browser = browserUrl(`#invite=${candidate}`);
    const invitation = captureInvitationFromUrl(browser);
    assert.equal(invitation.detected, true);
    assert.equal(invitation.valid, false);
    assert.equal(invitation.value(), null);
    assert.equal(browser.calls.length, 1);
  }
  assert.equal(isInvalidInvitationError({ message: "Invalid invitation" }), true);
  assert.equal(INVALID_INVITATION_MESSAGE, "Aquesta invitació no és vàlida o ja no està disponible.");
  assert.equal(isTerminalReservationError({ message: "Pool is closed" }), true);
  assert.equal(isTerminalReservationError({ message: "Cell is full" }), false);
});

test("una URL sense invitació no altera la navegació ni crea cap capacitat", () => {
  const browser = browserUrl("#public");
  const invitation = captureInvitationFromUrl(browser);
  assert.equal(invitation.detected, false);
  assert.equal(invitation.hasToken(), false);
  assert.deepEqual(browser.calls, []);
});

test("el token només apareix al fragment de l'enllaç de participació", () => {
  const invitationUrl = buildInvitationUrl({
    baseUrl: "https://example.test/porra-live/?old=value#admin",
    poolSlug: "beta-final",
    invitationToken: token
  });
  const parsed = new URL(invitationUrl);
  assert.equal(parsed.pathname, "/porra-live/");
  assert.equal(parsed.searchParams.get("pool"), "beta-final");
  assert.equal(parsed.search.includes(token), false);
  assert.equal(parsed.hash, `#invite=${token}`);

  const whatsapp = new URL(buildWhatsAppInvitationUrl({ invitationUrl, poolTitle: "Final beta" }));
  const sharedText = whatsapp.searchParams.get("text");
  assert.match(sharedText, /Final beta/);
  assert.match(sharedText, new RegExp(`#invite=${token}$`));
});

test("el mòdul d'invitacions no usa cap persistència, cookie, log ni telemetria", () => {
  const source = readFileSync(new URL("../src/invitations.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|console\.|analytics|telemetry/i);
  assert.equal(isInvitationToken(token), true);
});

test("el mode demo continua disponible sense configuració ni invitació", async () => {
  const repository = await createRepository({ mode: "demo" });
  assert.equal(repository.mode, "demo");
});

test("la configuració pública queda restringida a porra-live-beta i no conté claus secretes", () => {
  const configSource = readFileSync(new URL("../config.public.js", import.meta.url), "utf8");
  const repositorySource = readFileSync(new URL("../src/repository.js", import.meta.url), "utf8");
  assert.match(configSource, /mode: "supabase"/);
  assert.match(configSource, /https:\/\/vczrkalsqdzwitpqwdwc\.supabase\.co/);
  assert.match(configSource, /supabasePublishableKey: "sb_publishable_/);
  assert.doesNotMatch(configSource, /service_role|sb_secret_/i);
  assert.match(repositorySource, /config\.supabaseUrl !== BETA_SUPABASE_URL/);
});

test("l'aplicació captura abans de connectar, neteja el token i integra el flux reutilitzable admin", () => {
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const captureAt = appSource.indexOf("captureInvitationFromUrl({ location, history: window.history })");
  const repositoryAt = appSource.indexOf("await createRepository(config)");
  assert.ok(captureAt >= 0 && captureAt < repositoryAt);
  assert.match(appSource, /invitationToken: repository\.mode === "supabase" \? invitation\.value\(\) : undefined/);
  assert.match(appSource, /invitation\.clear\(\)/);
  assert.match(appSource, /repository\.createPoolShareLink/);
  assert.match(appSource, /repository\.getPoolShareLink/);
  assert.match(appSource, /repository\.rotatePoolShareLink/);
  assert.doesNotMatch(appSource, /console\./);
});

test("la resposta original d'invitació s'oblida en abandonar la pestanya i no es pot recuperar del llistat", () => {
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const repositorySource = readFileSync(new URL("../src/repository.js", import.meta.url), "utf8");
  assert.match(appSource, /activeAdminTab = tab\.dataset\.adminTab;\s*if \(activeAdminTab !== "invitations"\) \{\s*lastCreatedInvitation = null;\s*app\.querySelector\("\.invitation-created"\)\?\.remove\(\);/);
  assert.match(appSource, /lastCreatedInvitation\?\.poolId === pool\.id/);
  assert.doesNotMatch(repositorySource.match(/async listPoolInvitations[\s\S]*?\n  }/)[0], /invitationToken|token_hash/);
});

test("Realtime no pot esborrar la resposta privada de reserva i el tracking mostra el pagament protegit", () => {
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const submittingAt = appSource.indexOf('view = "reservation-submitting"');
  const reservationAt = appSource.indexOf("await repository.createReservation");
  const successAt = appSource.indexOf('view = "reservation-success"');
  const trackingPaymentAt = appSource.indexOf("tracking.pool.paymentInstructions");
  assert.ok(submittingAt >= 0 && submittingAt < reservationAt);
  assert.ok(successAt > reservationAt);
  assert.ok(trackingPaymentAt > successAt);
  assert.match(appSource, /catch \(error\) \{\s*view = "public";/);
});

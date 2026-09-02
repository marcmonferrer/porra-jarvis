import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { captureInvitationFromUrl } from "../src/invitations.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const redirectSource = read("compat/finalissima-porra/redirect.js");
const redirectHtml = read("compat/finalissima-porra/index.html");
const notFoundHtml = read("compat/finalissima-porra/404.html");

function redirectedFrom(url) {
  const parsed = new URL(url);
  let target = "";
  vm.runInNewContext(redirectSource, {
    window: {
      location: {
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
        replace(value) { target = value; }
      }
    }
  });
  return target;
}

test("la redirecció antiga conserva query, fragment i ruta", () => {
  assert.equal(
    redirectedFrom("https://marcmonferrer.github.io/finalissima-porra/?pool=test#invite=dummy"),
    "https://marcmonferrer.github.io/porra-jarvis/?pool=test#invite=dummy"
  );
  assert.equal(
    redirectedFrom("https://marcmonferrer.github.io/finalissima-porra/share.html?pool=test#mybet=dummy"),
    "https://marcmonferrer.github.io/porra-jarvis/share.html?pool=test#mybet=dummy"
  );
});

test("l’aplicació saneja el fragment sintètic després de la redirecció", () => {
  const redirected = new URL(redirectedFrom("https://marcmonferrer.github.io/finalissima-porra/?pool=test#invite=dummy"));
  const calls = [];
  const invitation = captureInvitationFromUrl({
    location: redirected,
    history: { state: null, replaceState(...args) { calls.push(args); } }
  });
  assert.equal(invitation.detected, true);
  assert.equal(invitation.valid, false);
  assert.deepEqual(calls, [[null, "", "/porra-jarvis/?pool=test"]]);
});

test("la compatibilitat és estàtica, no-referrer i no filtra dades", () => {
  for (const html of [redirectHtml, notFoundHtml]) {
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /\/finalissima-porra\/redirect\.js/);
  }
  assert.doesNotMatch(redirectSource, /console\.|fetch\(|XMLHttpRequest|localStorage|sessionStorage|cookie|analytics|telemetry/i);
  assert.match(redirectSource, /window\.location\.replace/);
});

test("el servidor local publica explícitament el base path nou", () => {
  const server = read("scripts/serve.mjs");
  assert.match(server, /const basePath = "\/porra-jarvis"/);
  assert.match(server, /pathname\.startsWith\(`\$\{basePath\}\/`\)/);
});

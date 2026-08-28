import assert from "node:assert/strict";
import test from "node:test";
import { adminShareLinkMarkup, buildPoolShareUrl, copyShareLink } from "../src/share-links.js";

const token = "a".repeat(64);
const escapeHtml = value => String(value);
const formatDateTime = value => value;

test("l’enllaç compartit conserva el token només al fragment", () => {
  const url = buildPoolShareUrl({ baseUrl: "https://example.test/app/", poolSlug: "final", shareToken: token });
  assert.equal(url, `https://example.test/app/?pool=final#invite=${token}`);
});

test("l’estat recarregat no pot recuperar el token cru", () => {
  const html = adminShareLinkMarkup({
    pool: { id: "pool", slug: "final" },
    shareLink: { status: "active", createdAt: "ara", usageCount: 7 },
    createdShareUrl: null, escapeHtml, formatDateTime
  });
  assert.match(html, /Actiu/);
  assert.match(html, /Usos completats/);
  assert.match(html, /no es pot recuperar/);
  assert.doesNotMatch(html, new RegExp(token));
});

test("la resposta de creació mostra una única còpia gran i avís accessible", () => {
  const html = adminShareLinkMarkup({
    pool: { id: "pool" }, shareLink: { status: "active", createdAt: "ara", usageCount: 0 },
    createdShareUrl: `https://example.test/#invite=${token}`, escapeHtml, formatDateTime
  });
  assert.match(html, /Copiar enllaç/);
  assert.match(html, /role="status"/);
  assert.match(html, /no es podrà recuperar/);
});

test("la còpia usa Clipboard API i té fallback accessible", async () => {
  let copied = "";
  assert.equal(await copyShareLink("secret", { clipboard: { async writeText(value) { copied = value; } } }), true);
  assert.equal(copied, "secret");
  const fake = {
    body: { append(node) { node.parent = this; } },
    createElement() { return { style: {}, setAttribute() {}, select() {}, remove() {} }; },
    execCommand(command) { return command === "copy"; }
  };
  assert.equal(await copyShareLink("fallback", { clipboard: null, documentObject: fake }), true);
});


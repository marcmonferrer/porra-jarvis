import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildPoolRules, formatMadridDateTime, normalizeOrganizerText,
  poolRulesMarkup, validatePrizePercentages
} from "../src/pool-rules.js";
import { DemoRepository } from "../src/repository.js";

const pool = {
  priceCents: 400, closesAt: "2026-08-27T17:30:00Z",
  maxEntriesPerParticipant: 2, cellCapacity: 2,
  prizePercentages: { half: 25, final: 50, special: 25 },
  organizerNote: "Respecteu el grup <script>alert(1)</script>",
  organizerContact: "@organitzador",
  specials: [
    { cellKey: "3-3", title: "Primer gol", description: "Marca el local" },
    { cellKey: "3-4", title: "Targeta", description: "Abans del descans" }
  ]
};
const escapeHtml = value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");

test("el model deriva preu, límits, capacitat, hora Madrid, premis i especials", () => {
  const model = buildPoolRules(pool);
  assert.match(model.summary, /4,00/);
  assert.equal(model.maxEntries, 2);
  assert.equal(model.cellCapacity, 2);
  assert.deepEqual(model.prizePercentages, { half: 25, final: 50, special: 25 });
  assert.ok(model.items.some(item => /90 minuts/.test(item)));
  assert.ok(model.items.some(item => /Primer gol: Marca el local/.test(item)));
  assert.ok(model.items.some(item => /pendents.*no verificades.*poden guanyar/.test(item)));
  assert.ok(model.items.some(item => /passa al resultat final/.test(item)));
  assert.ok(model.items.some(item => /Contacte de l’organitzador/.test(item)));
});

test("els percentatges invàlids es rebutgen i els valors legacy usen 25/50/25", () => {
  assert.throws(() => validatePrizePercentages({ half: 30, final: 50, special: 30 }), /sumar exactament 100/);
  assert.throws(() => validatePrizePercentages({ half: 25.5, final: 50, special: 24.5 }), /enters/);
  assert.deepEqual(buildPoolRules({ priceCents: 400 }).prizePercentages, { half: 25, final: 50, special: 25 });
});

test("la data es força a Europe/Madrid", () => {
  assert.match(formatMadridDateTime("2026-08-27T17:30:00Z"), /19:30/);
});

test("la nota és text pla, acotat i no substitueix les regles", () => {
  assert.throws(() => normalizeOrganizerText({ note: "x".repeat(401) }), /400/);
  const html = poolRulesMarkup(pool, { escapeHtml, context: "public" });
  assert.match(html, /Com funciona la porra/);
  assert.match(html, /<ol>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Nota de l’organitzador/);
});

test("public i admin comparteixen exactament el mateix model i llistat semàntic", () => {
  const publicHtml = poolRulesMarkup(pool, { escapeHtml, context: "public" });
  const adminHtml = poolRulesMarkup(pool, { escapeHtml, context: "admin" });
  assert.match(adminHtml, /Vista de les regles/);
  assert.equal((publicHtml.match(/<li>/g) || []).length, (adminHtml.match(/<li>/g) || []).length);
  assert.match(publicHtml, /aria-labelledby/);
  assert.match(adminHtml, /aria-labelledby/);
});

test("els estils de regles són responsive i els controls mantenen 44 px", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.pool-rules ol/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /min-height: 44px/);
});


test("la integració situa les regles abans de la graella i reutilitza el renderer a admin", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const previewAt = app.indexOf("matchPreviewMarkup(pool.matchPreview");
  const rulesAt = app.indexOf('poolRulesMarkup(pool, { escapeHtml, context: "public" })');
  const gridAt = app.indexOf("gridMarkup(state, canPlay)");
  assert.ok(previewAt >= 0 && previewAt < rulesAt && rulesAt < gridAt);
  assert.match(app, /poolRulesMarkup\(formPool \|\| pool \|\| \{\}, \{ escapeHtml, context: "admin" \}\)/);
  assert.match(app, /name="organizerNote" maxlength="400"/);
  assert.match(app, /name="organizerContact" maxlength="120"/);
});

test("el mode demo conserva nota i contacte en editar i recarregar", async () => {
  const storage = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(storage);
  const saved = await repository.savePool({
    title: "Demo", price: 4, poolPerBet: 3.5, fee: .5,
    organizerNote: "Nota pública", organizerContact: "Canal públic"
  });
  const reloaded = new DemoRepository(storage);
  const pool = await reloaded.getPool(saved.id);
  assert.equal(pool.organizerNote, "Nota pública");
  assert.equal(pool.organizerContact, "Canal públic");
});

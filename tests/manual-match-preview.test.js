import assert from "node:assert/strict";
import test from "node:test";
import {
  MANUAL_PREVIEW_LIMITS,
  adminManualMatchPreviewMarkup,
  createManualMatchPreview,
  createManualMatchPreviewController,
  manualMatchPreviewText,
  parseManualMatchPreview
} from "../src/manual-match-preview.js";
import { matchPreviewMarkup } from "../src/match-preview.js";
import { DemoRepository } from "../src/repository.js";

const validText = `LOCAL:

- Pressió alta i recuperació ràpida
- Bon rendiment recent a casa

VISITANT:

- Transicions ofensives perilloses
- Fortalesa en pilota aturada

FONT: Informe de prova
URL: https://example.com/preview`;

const pool = {
  id: "pool-manual",
  homeTeam: "FC Barcelona",
  awayTeam: "Athletic Club",
  homeImage: "/assets/barcelona.svg",
  awayImage: "/assets/athletic.svg",
  matchPreview: null
};

test("el parser accepta 1–4 punts per equip i metadades opcionals", () => {
  assert.deepEqual(parseManualMatchPreview(validText), {
    homeHighlights: ["Pressió alta i recuperació ràpida", "Bon rendiment recent a casa"],
    awayHighlights: ["Transicions ofensives perilloses", "Fortalesa en pilota aturada"],
    sourceLabel: "Informe de prova",
    sourceUrl: "https://example.com/preview"
  });
  const minimal = parseManualMatchPreview("LOCAL:\n- Un punt\nVISITANT:\n- Un altre punt");
  assert.equal(minimal.homeHighlights.length, 1);
  assert.equal(minimal.awayHighlights.length, 1);
  assert.equal(minimal.sourceLabel, "");
  assert.equal(minimal.sourceUrl, "");
});

test("el parser retorna errors catalans clars i aplica tots els límits", () => {
  const cases = [
    ["LOCAL:\n- Punt", /VISITANT/],
    ["LOCAL:\nPunt sense guió\nVISITANT:\n- Punt", /Format no reconegut/],
    [`LOCAL:\n${Array.from({ length: 5 }, (_, index) => `- Punt ${index}`).join("\n")}\nVISITANT:\n- Punt`, /màxim 4 punts/],
    [`LOCAL:\n- ${"x".repeat(MANUAL_PREVIEW_LIMITS.bullet + 1)}\nVISITANT:\n- Punt`, /màxim 180/],
    ["LOCAL:\n- Punt\nVISITANT:\n- Punt\nURL: javascript:alert(1)", /http:\/\/ o https:\/\//],
    ["LOCAL:\n- Punt\nVISITANT:\n- Punt\nURL: https://user:pass@example.com", /credencials/],
    ["x".repeat(MANUAL_PREVIEW_LIMITS.totalText + 1), /4096/]
  ];
  for (const [input, expected] of cases) assert.throws(() => parseManualMatchPreview(input), expected);
});

test("el snapshot manual és compacte, versionat i no desa noms ni escuts", () => {
  const preview = createManualMatchPreview(validText, { now: () => new Date("2026-08-25T08:00:00.000Z") });
  assert.deepEqual(preview, {
    version: "1",
    provider: "manual",
    fetchedAt: "2026-08-25T08:00:00.000Z",
    homeTeam: { highlights: ["Pressió alta i recuperació ràpida", "Bon rendiment recent a casa"] },
    awayTeam: { highlights: ["Transicions ofensives perilloses", "Fortalesa en pilota aturada"] },
    source: { label: "Informe de prova", url: "https://example.com/preview" }
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(preview)).length <= MANUAL_PREVIEW_LIMITS.snapshotBytes);
  assert.doesNotMatch(JSON.stringify(preview), /Barcelona|Athletic|crest|providerId|payload|credential/i);
  assert.deepEqual(parseManualMatchPreview(manualMatchPreviewText(preview)), parseManualMatchPreview(validText));
});

test("el render públic usa equips i escuts configurats, escapa HTML i no mostra res sense prèvia", () => {
  const preview = createManualMatchPreview(validText.replace("Pressió alta", "<script>atac()</script>"), {
    now: () => new Date("2026-08-25T08:00:00.000Z")
  });
  const html = matchPreviewMarkup(preview, {
    crestUrls: { home: pool.homeImage, away: pool.awayImage },
    teamNames: { home: pool.homeTeam, away: pool.awayTeam }
  });
  assert.match(html, /manual-match-preview/);
  assert.match(html, /FC Barcelona/);
  assert.match(html, /Athletic Club/);
  assert.match(html, /\/assets\/barcelona\.svg/);
  assert.match(html, /Actualitzada/);
  assert.match(html, /Informe de prova/);
  assert.match(html, /https:\/\/example\.com\/preview/);
  assert.match(html, /&lt;script&gt;atac\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|providerId|rawPayload/);
  assert.equal(matchPreviewMarkup(null), "");
});

test("l’editor admin és etiquetat, anunciable, navegable i no exposa l’acció automàtica", () => {
  const controller = createManualMatchPreviewController();
  controller.load(pool);
  controller.setText(validText);
  controller.preview();
  const html = adminManualMatchPreviewMarkup(pool, controller.state());
  assert.match(html, /<label[^>]*for="manual-preview-text"[^>]*>Enganxa la prèvia preparada<\/label>/);
  assert.match(html, /<textarea[^>]*id="manual-preview-text"[^>]*maxlength="4096"/);
  assert.match(html, /data-action="preview-manual-match-preview"[^>]*>Previsualitzar/);
  assert.match(html, /data-action="save-manual-match-preview"[^>]*>Desar prèvia/);
  assert.match(html, /data-action="delete-manual-match-preview"[^>]*disabled/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /refresh-match-preview|API-Football|Carregar prèvia automàtica/);
  assert.match(html, /Canvis sense desar/);
  assert.doesNotMatch(html, /Previsualització no desada/);
});

test("un desat correcte sincronitza el snapshot i elimina l’estat pendent", async () => {
  const controller = createManualMatchPreviewController({ now: () => new Date("2026-08-25T08:00:00.000Z") });
  controller.load(pool);
  controller.setText(validText);
  const result = await controller.save((_poolId, snapshot) => snapshot, pool.id);
  const state = controller.state();
  assert.deepEqual(state.savedPreview, result.matchPreview);
  assert.equal(state.draftPreview, null);
  assert.equal(state.dirty, false);
  assert.equal(state.status, "Prèvia desada correctament.");
  const html = adminManualMatchPreviewMarkup(pool, state);
  assert.match(html, /manual-match-preview/);
  assert.doesNotMatch(html, /Canvis sense desar|Previsualització no desada/);
});

test("editar o generar una nova previsualització després del desat marca canvis sense desar", () => {
  const savedPreview = createManualMatchPreview(validText, { now: () => new Date("2026-08-25T08:00:00.000Z") });
  const savedPool = { ...pool, matchPreview: savedPreview };
  const controller = createManualMatchPreviewController({ now: () => new Date("2026-08-25T09:00:00.000Z") });
  controller.load(savedPool);
  controller.setText(manualMatchPreviewText(savedPreview).replace("Informe de prova", "Font editada"));
  assert.equal(controller.state().dirty, true);
  assert.match(adminManualMatchPreviewMarkup(savedPool, controller.state()), /Canvis sense desar/);
  controller.preview();
  assert.equal(controller.state().dirty, true);
  assert.ok(controller.state().draftPreview);
  controller.setText(manualMatchPreviewText(savedPreview));
  assert.equal(controller.state().dirty, false);
  assert.equal(controller.state().draftPreview, null);
  assert.doesNotMatch(adminManualMatchPreviewMarkup(savedPool, controller.state()), /Canvis sense desar/);
});

test("el controlador evita desats duplicats mentre hi ha un desat en curs", async () => {
  const controller = createManualMatchPreviewController({ now: () => new Date("2026-08-25T08:00:00.000Z") });
  controller.load(pool);
  controller.setText(validText);
  let calls = 0;
  let resolveSave;
  const save = (_poolId, snapshot) => {
    calls += 1;
    return new Promise(resolve => { resolveSave = () => resolve(snapshot); });
  };
  const first = controller.save(save, pool.id);
  const duplicate = controller.save(save, pool.id);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(controller.state().saving, true);
  resolveSave();
  assert.equal((await first).matchPreview.provider, "manual");
  assert.equal((await duplicate).matchPreview.provider, "manual");
  assert.equal(controller.state().saving, false);
});

test("un desat fallit conserva el contingut i continua marcat com a no desat", async () => {
  const controller = createManualMatchPreviewController({ now: () => new Date("2026-08-25T08:00:00.000Z") });
  controller.load(pool);
  const editedText = validText.replace("Informe de prova", "Text que s’ha de conservar");
  controller.setText(editedText);
  const failed = await controller.save(() => Promise.reject(new Error("Error de desat")), pool.id);
  const state = controller.state();
  assert.equal(failed.error, "Error de desat");
  assert.equal(state.text, editedText);
  assert.equal(state.dirty, true);
  assert.ok(state.draftPreview);
  assert.match(adminManualMatchPreviewMarkup(pool, state), /Canvis sense desar/);
});

test("eliminació requereix confirmació i neteja només després de l’èxit", async () => {
  const controller = createManualMatchPreviewController();
  controller.load({ ...pool, matchPreview: createManualMatchPreview(validText) });
  let calls = 0;
  assert.deepEqual(await controller.remove(() => { calls += 1; }, pool.id, () => false), { cancelled: true });
  assert.equal(calls, 0);
  assert.deepEqual(await controller.remove(() => { calls += 1; }, pool.id, () => true), { removed: true });
  assert.equal(calls, 1);
  assert.equal(controller.state().text, "");
  assert.equal(controller.state().savedPreview, null);
  assert.equal(controller.state().draftPreview, null);
  assert.equal(controller.state().dirty, false);
  const html = adminManualMatchPreviewMarkup(pool, controller.state());
  assert.doesNotMatch(html, /class="match-preview manual-match-preview"|Canvis sense desar/);
});

test("DemoRepository desa, conserva en editar/publicar/recarregar i elimina la prèvia manual", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  const created = await repository.savePool({
    title: "Demo manual", homeTeam: "Local", awayTeam: "Visitant",
    matchAt: "2026-08-30T19:00:00.000Z", closesAt: "2026-08-30T17:30:00.000Z",
    price: 4, poolPerBet: 3.5, fee: 0.5
  });
  const preview = createManualMatchPreview(validText);
  await repository.saveManualMatchPreview(created.id, preview);
  await repository.savePool({ ...created, title: "Demo manual editada" });
  await repository.publishPool(created.id);
  const reloaded = new DemoRepository(memory);
  assert.deepEqual((await reloaded.getPool(created.id)).matchPreview, preview);
  await reloaded.deleteManualMatchPreview(created.id);
  assert.equal((await reloaded.getPool(created.id)).matchPreview, null);
});

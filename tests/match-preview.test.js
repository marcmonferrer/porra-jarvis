import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDemoMatchPreview,
  matchPreviewMarkup,
  previewFreshness
} from "../src/match-preview.js";
import { DemoRepository } from "../src/repository.js";

const preview = createDemoMatchPreview({ homeTeam: "Local", awayTeam: "Visitant", matchAt: "2026-08-30T19:00:00.000Z" });

test("sense snapshot la vista pública no mostra cap contenidor buit", () => {
  assert.equal(matchPreviewMarkup(null), "");
});

test("la targeta pública presenta dades normalitzades, font i semàntica accessible", () => {
  const html = matchPreviewMarkup({ ...preview, provider: "api-football" }, { now: new Date("2026-08-24T10:00:00.000Z").getTime() });
  assert.match(html, /aria-labelledby="match-preview-title"/);
  assert.match(html, /Prèvia del partit/);
  assert.match(html, /Local/);
  assert.match(html, /Visitant/);
  assert.match(html, /API-Football/);
  assert.match(html, /Victòria/);
  assert.doesNotMatch(html, /providerTeamId|providerFixtureId|competitionId|providerPlayerId/);
  assert.doesNotMatch(html, /cdn\.example/);
  const publicWithConfiguredCrests = matchPreviewMarkup(
    { ...preview, provider: "api-football", homeTeam: { ...preview.homeTeam, crestUrl: "https://cdn.example/provider.png" } },
    { crestUrls: { home: "/home-crest.svg", away: "https://images.example/away.png" } }
  );
  assert.match(publicWithConfiguredCrests, /src="\/home-crest\.svg"/);
  assert.match(publicWithConfiguredCrests, /https:\/\/images\.example\/away\.png/);
  assert.doesNotMatch(publicWithConfiguredCrests, /cdn\.example\/provider\.png/);
  const adminHtml = matchPreviewMarkup({ ...preview, provider: "api-football", homeTeam: { ...preview.homeTeam, crestUrl: "https://cdn.example/crest.png" } }, { context: "admin" });
  assert.match(adminHtml, /https:\/\/cdn\.example\/crest\.png/);
});

test("el render escapa text i rebutja URLs d’escut no HTTPS", () => {
  const hostile = {
    ...preview,
    provider: "api-football",
    competitionName: "<script>attack()</script>",
    homeTeam: { ...preview.homeTeam, name: "<img src=x onerror=attack()>", crestUrl: "javascript:attack()" }
  };
  const html = matchPreviewMarkup(hostile, { context: "admin" });
  assert.doesNotMatch(html, /<script>|<img src=x|javascript:/);
  assert.match(html, /&lt;script&gt;attack\(\)&lt;\/script&gt;/);
});
test("dades antigues, parcials i absents degraden de forma informativa", () => {
  const partial = {
    ...preview,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    homeTeam: { name: "Local", form: [], recentMatches: [] },
    warnings: ["La classificació no està disponible."]
  };
  assert.equal(previewFreshness(partial, new Date("2026-08-24T10:00:00.000Z").getTime()), "stale");
  const html = matchPreviewMarkup(partial, { now: new Date("2026-08-24T10:00:00.000Z").getTime() });
  assert.match(html, /Dades antigues/);
  assert.match(html, /Classificació no disponible/);
  assert.match(html, /Últims resultats no disponibles/);
  assert.match(html, /Dades parcials/);
});

test("DemoRepository genera i persisteix una fixture determinista sense crides externes", async () => {
  const memory = { value: null, getItem() { return this.value; }, setItem(_key, value) { this.value = value; } };
  const repository = new DemoRepository(memory);
  const pool = await repository.savePool({ title: "Demo", homeTeam: "A", awayTeam: "B", matchAt: "2026-08-30T19:00:00Z", price: 4, poolPerBet: 3.5, fee: .5 });
  const first = await repository.refreshMatchPreview(pool.id);
  const second = createDemoMatchPreview(pool);
  assert.deepEqual(first, second);
  assert.match(matchPreviewMarkup(first), /Font: Dades demo/);
assert.deepEqual((await repository.getPool(pool.id)).matchPreview, second);
  await repository.savePool({ ...pool, title: "Demo editada" });
  assert.deepEqual((await repository.getPool(pool.id)).matchPreview, second);
});

test("els estils inclouen una composició responsive sense desbordament forçat", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.preview-teams\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 920px\)[^]*\.preview-teams\s*\{[^}]*grid-template-columns: 1fr/);
  assert.match(css, /\.preview-team\s*\{[^}]*min-width: 0/);
});

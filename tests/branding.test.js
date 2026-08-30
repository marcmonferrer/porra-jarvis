import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const index = read("index.html");
const share = read("share.html");
const app = read("src/app.js");
const invitations = read("src/invitations.js");
const server = read("scripts/serve.mjs");
const readme = read("README.md");
const supabaseReadme = read("supabase/README.md");
const legacyFunctionReadme = read("supabase/functions/sync-live-score/README.md");
const legacySchedule = read("supabase/schedule-live-score.sql");
const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const repository = read("src/repository.js");

test("Porra JARVIS i PJ apareixen a totes les superfícies actives de producte", () => {
  assert.match(index, /<title>Porra JARVIS ·/);
  assert.match(index, /aria-label="Porra JARVIS, inici"/);
  assert.match(index, /<span class="brand__mark">PJ<\/span>/);
  assert.match(index, /<strong>Porra JARVIS<\/strong>/);
  assert.match(index, /Preparant Porra JARVIS/);
  assert.match(share, /Porra JARVIS/);
  assert.match(app, /Administració de Porra JARVIS/);
  assert.match(app, /Gestiona Porra JARVIS/);
  assert.match(invitations, /participar a Porra JARVIS/);
  assert.match(server, /Porra JARVIS running/);
});

test("no queda branding actiu Porra Live ni les inicials PL", () => {
  const active = [index, share, app, invitations, server, readme, supabaseReadme, legacyFunctionReadme, legacySchedule].join("\n");
  assert.doesNotMatch(active, /Porra Live/);
  assert.doesNotMatch(index, />PL<\/span>/);
});

test("el paquet adopta el nom de producte sense canviar identificadors d’infraestructura", () => {
  assert.equal(packageJson.name, "porra-jarvis");
  assert.equal(packageLock.name, "porra-jarvis");
  assert.equal(packageLock.packages[""].name, "porra-jarvis");
  assert.match(repository, /const BETA_SUPABASE_URL = "https:\/\/vczrkalsqdzwitpqwdwc\.supabase\.co"/);
  assert.match(repository, /porra-live-beta/);
  assert.match(repository, /porra-live-demo-v1/);
  assert.match(repository, /porra-live-\$\{poolSlug\}/);
});

test("la ruta publicada actual es conserva i el canvi extern queda documentat", () => {
  assert.match(index, /marcmonferrer\.github\.io\/finalissima-porra\/social-card-porra-live\.png/);
  assert.match(readme, /marcmonferrer\/finalissima-porra/);
  assert.match(readme, /https:\/\/marcmonferrer\.github\.io\/finalissima-porra\//);
  assert.match(readme, /slug desitjat `porra-jarvis`/);
  assert.match(readme, /redirect explícit o domini estable/);
  assert.match(readme, /portfolio\/README/);
});

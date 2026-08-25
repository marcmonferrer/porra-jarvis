import { matchPreviewMarkup } from "./match-preview.js";

export const MANUAL_PREVIEW_LIMITS = Object.freeze({
  totalText: 4096,
  bullet: 180,
  sourceLabel: 120,
  sourceUrl: 2048,
  snapshotBytes: 8192,
  minBullets: 1,
  maxBullets: 4
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function parseSourceUrl(value) {
  if (!value) return "";
  if (value.length > MANUAL_PREVIEW_LIMITS.sourceUrl) {
    throw new Error(`La URL de la font no pot superar ${MANUAL_PREVIEW_LIMITS.sourceUrl} caràcters.`);
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new Error("La URL de la font ha de començar per http:// o https:// i no pot incloure credencials.");
  }
}

export function parseManualMatchPreview(text) {
  const raw = String(text ?? "");
  if (raw.length > MANUAL_PREVIEW_LIMITS.totalText) {
    throw new Error(`La prèvia no pot superar ${MANUAL_PREVIEW_LIMITS.totalText} caràcters.`);
  }
  const result = { homeHighlights: [], awayHighlights: [], sourceLabel: "", sourceUrl: "" };
  let section = "";
  let seenHome = false;
  let seenAway = false;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const upper = line.toLocaleUpperCase("ca");
    if (upper === "LOCAL:") {
      if (seenHome || seenAway) throw new Error(`La capçalera LOCAL: està repetida o fora d’ordre (línia ${index + 1}).`);
      seenHome = true;
      section = "home";
      continue;
    }
    if (upper === "VISITANT:") {
      if (!seenHome || seenAway) throw new Error(`La capçalera VISITANT: ha d’anar després de LOCAL: (línia ${index + 1}).`);
      seenAway = true;
      section = "away";
      continue;
    }
    if (/^FONT\s*:/iu.test(line)) {
      if (!seenAway || result.sourceLabel) throw new Error(`La línia FONT: està repetida o fora d’ordre (línia ${index + 1}).`);
      result.sourceLabel = line.replace(/^FONT\s*:/iu, "").trim();
      if (!result.sourceLabel) throw new Error("FONT: ha d’incloure una etiqueta o s’ha d’ometre.");
      if (result.sourceLabel.length > MANUAL_PREVIEW_LIMITS.sourceLabel) {
        throw new Error(`La font no pot superar ${MANUAL_PREVIEW_LIMITS.sourceLabel} caràcters.`);
      }
      section = "meta";
      continue;
    }
    if (/^URL\s*:/iu.test(line)) {
      if (!seenAway || result.sourceUrl) throw new Error(`La línia URL: està repetida o fora d’ordre (línia ${index + 1}).`);
      const sourceUrl = line.replace(/^URL\s*:/iu, "").trim();
      if (!sourceUrl) throw new Error("URL: ha d’incloure una adreça o s’ha d’ometre.");
      result.sourceUrl = parseSourceUrl(sourceUrl);
      section = "meta";
      continue;
    }
    const bullet = line.match(/^[-–—]\s+(.+)$/u)?.[1]?.trim();
    if (!bullet || !["home", "away"].includes(section)) {
      throw new Error(`Format no reconegut a la línia ${index + 1}. Usa LOCAL:, VISITANT: i punts començats amb “- ”.`);
    }
    if (bullet.length > MANUAL_PREVIEW_LIMITS.bullet) {
      throw new Error(`Cada punt pot tenir com a màxim ${MANUAL_PREVIEW_LIMITS.bullet} caràcters (línia ${index + 1}).`);
    }
    const target = section === "home" ? result.homeHighlights : result.awayHighlights;
    target.push(bullet);
    if (target.length > MANUAL_PREVIEW_LIMITS.maxBullets) {
      throw new Error(`Cada equip pot tenir com a màxim ${MANUAL_PREVIEW_LIMITS.maxBullets} punts.`);
    }
  }
  if (!seenHome || !seenAway) throw new Error("La prèvia ha d’incloure les seccions LOCAL: i VISITANT:.");
  if (result.homeHighlights.length < MANUAL_PREVIEW_LIMITS.minBullets) throw new Error("LOCAL: necessita com a mínim un punt.");
  if (result.awayHighlights.length < MANUAL_PREVIEW_LIMITS.minBullets) throw new Error("VISITANT: necessita com a mínim un punt.");
  return result;
}

export function createManualMatchPreview(text, { now = () => new Date() } = {}) {
  const parsed = parseManualMatchPreview(text);
  const snapshot = {
    version: "1",
    provider: "manual",
    fetchedAt: now().toISOString(),
    homeTeam: { highlights: parsed.homeHighlights },
    awayTeam: { highlights: parsed.awayHighlights },
    source: {
      ...(parsed.sourceLabel ? { label: parsed.sourceLabel } : {}),
      ...(parsed.sourceUrl ? { url: parsed.sourceUrl } : {})
    }
  };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MANUAL_PREVIEW_LIMITS.snapshotBytes) {
    throw new Error("La prèvia preparada supera la mida màxima permesa.");
  }
  return snapshot;
}

export function manualMatchPreviewText(preview) {
  if (preview?.provider !== "manual") return "";
  const bullets = items => (Array.isArray(items) ? items : []).map(item => `- ${item}`).join("\n");
  return [
    "LOCAL:",
    bullets(preview.homeTeam?.highlights),
    "",
    "VISITANT:",
    bullets(preview.awayTeam?.highlights),
    preview.source?.label ? `\nFONT: ${preview.source.label}` : "",
    preview.source?.url ? `URL: ${preview.source.url}` : ""
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
}

export function createManualMatchPreviewController({ now = () => new Date() } = {}) {
  let poolId = null;
  let text = "";
  let savedText = "";
  let savedPreview = null;
  let draftPreview = null;
  let dirty = false;
  let error = "";
  let status = "";
  let saving = false;
  let pending = null;
  return {
    load(pool) {
      const nextPoolId = pool?.id || null;
      const nextSavedPreview = pool?.matchPreview || null;
      const nextSavedText = manualMatchPreviewText(nextSavedPreview);
      if (nextPoolId !== poolId) {
        poolId = nextPoolId;
        text = nextSavedText;
        savedText = nextSavedText;
        savedPreview = nextSavedPreview;
        draftPreview = null;
        dirty = false;
        error = "";
        status = "";
        saving = false;
        pending = null;
        return;
      }
      savedText = nextSavedText;
      savedPreview = nextSavedPreview;
      if (!dirty && !saving) {
        text = savedText;
        draftPreview = null;
      }
    },
    setText(value) {
      const next = String(value ?? "");
      if (next !== text) {
        text = next;
        draftPreview = null;
        dirty = text !== savedText;
        error = "";
        status = "";
      }
    },
    state() { return { poolId, text, savedPreview, draftPreview, dirty, error, status, saving }; },
    preview() {
      try {
        draftPreview = createManualMatchPreview(text, { now });
        dirty = true;
        error = "";
        status = "Previsualització preparada. Encara no s’ha desat.";
        return { matchPreview: draftPreview };
      } catch (cause) {
        draftPreview = null;
        error = cause?.message || "La prèvia no és vàlida.";
        status = "";
        return { error };
      }
    },
    async save(savePreview, targetPoolId) {
      if (pending) return pending;
      let snapshot;
      try {
        snapshot = createManualMatchPreview(text, { now });
      } catch (cause) {
        error = cause?.message || "La prèvia no és vàlida.";
        return { error };
      }
      draftPreview = snapshot;
      dirty = true;
      saving = true;
      error = "";
      status = "Desant la prèvia…";
      pending = Promise.resolve()
        .then(() => savePreview(targetPoolId, snapshot))
        .then(saved => {
          savedPreview = saved || snapshot;
          savedText = manualMatchPreviewText(savedPreview);
          text = savedText;
          draftPreview = null;
          dirty = false;
          status = "Prèvia desada correctament.";
          return { matchPreview: savedPreview };
        })
        .catch(cause => {
          error = cause?.message || "No s’ha pogut desar la prèvia.";
          status = "";
          return { error };
        })
        .finally(() => { saving = false; pending = null; });
      return pending;
    },
    async remove(removePreview, targetPoolId, confirmRemove) {
      if (pending) return pending;
      if (!confirmRemove("Vols eliminar la prèvia desada? Aquesta acció no es pot desfer.")) return { cancelled: true };
      saving = true;
      error = "";
      status = "Eliminant la prèvia…";
      pending = Promise.resolve()
        .then(() => removePreview(targetPoolId))
        .then(() => {
          text = "";
          savedText = "";
          savedPreview = null;
          draftPreview = null;
          dirty = false;
          status = "Prèvia eliminada.";
          return { removed: true };
        })
        .catch(cause => {
          error = cause?.message || "No s’ha pogut eliminar la prèvia.";
          status = "";
          return { error };
        })
        .finally(() => { saving = false; pending = null; });
      return pending;
    }
  };
}

export function adminManualMatchPreviewMarkup(pool, controllerState = {}) {
  if (!pool) return "";
  const displayedPreview = controllerState.draftPreview || controllerState.savedPreview;
  const hasSavedPreview = Boolean(controllerState.savedPreview);
  const saving = Boolean(controllerState.saving);
  return `<section class="admin-preview manual-preview-editor" aria-labelledby="admin-preview-title" aria-busy="${saving}">
    <div class="section-heading"><div><span>Contingut assistit</span><h2 id="admin-preview-title">Prèvia del partit</h2></div></div>
    <p id="manual-preview-help" class="preview-admin-help">Demana una prèvia actualitzada, enganxa-la en el format LOCAL / VISITANT i revisa-la abans de desar.</p>
    <label class="manual-preview-label" for="manual-preview-text">Enganxa la prèvia preparada</label>
    <textarea id="manual-preview-text" data-manual-preview-input rows="14" maxlength="${MANUAL_PREVIEW_LIMITS.totalText}" aria-describedby="manual-preview-help manual-preview-format" spellcheck="true" placeholder="LOCAL:&#10;&#10;- Punt destacat del local&#10;&#10;VISITANT:&#10;&#10;- Punt destacat del visitant&#10;&#10;FONT: Nom de la font&#10;URL: https://exemple.cat/">${escapeHtml(controllerState.text || "")}</textarea>
    <p id="manual-preview-format" class="field-help">Entre 1 i 4 punts breus per equip. FONT i URL són opcionals; la URL ha de ser http o https.</p>
    <div class="manual-preview-actions">
      <button class="button secondary" type="button" data-action="preview-manual-match-preview" ${saving ? "disabled" : ""}>Previsualitzar</button>
      <button class="button primary" type="button" data-action="save-manual-match-preview" ${saving ? "disabled" : ""}>${saving ? "Desant…" : "Desar prèvia"}</button>
      <button class="button danger" type="button" data-action="delete-manual-match-preview" ${saving || !hasSavedPreview ? "disabled" : ""}>Eliminar prèvia</button>
    </div>
    <div class="manual-preview-announcement" role="status" aria-live="polite">${escapeHtml(controllerState.status || "")}</div>
    ${controllerState.error ? `<div class="warning" role="alert"><strong>Revisa el format</strong><p>${escapeHtml(controllerState.error)}</p></div>` : ""}
    ${controllerState.dirty ? `<p class="preview-draft-label">Canvis sense desar</p>` : ""}
    ${displayedPreview ? matchPreviewMarkup(displayedPreview, {
      context: "admin",
      crestUrls: { home: pool.homeImage, away: pool.awayImage },
      teamNames: { home: pool.homeTeam, away: pool.awayTeam }
    }) : `<div class="empty-inline">Encara no hi ha cap prèvia desada.</div>`}
  </section>`;
}

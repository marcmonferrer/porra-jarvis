const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function safeImageUrl(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function resultTone(match) {
  if (match.scoreFor > match.scoreAgainst) return "win";
  if (match.scoreFor < match.scoreAgainst) return "loss";
  return "draw";
}

function recentMatchesMarkup(matches = []) {
  if (!matches.length) return `<p class="preview-muted">Últims resultats no disponibles.</p>`;
  return `<ul class="preview-results">${matches.slice(0, 2).map(match => `<li><span class="form-dot ${resultTone(match)}" aria-hidden="true"></span><span>${escapeHtml(match.venue === "home" ? "vs" : "a")} ${escapeHtml(match.opponent)}</span><strong>${escapeHtml(match.scoreFor)}–${escapeHtml(match.scoreAgainst)}</strong><small>${escapeHtml(match.competitionName)}</small></li>`).join("")}</ul>`;
}

function formMarkup(form = []) {
  if (!form.length) return `<span class="preview-muted">Sense dades</span>`;
  const labels = { W: "Victòria", D: "Empat", L: "Derrota" };
  return `<div class="preview-form" aria-label="Forma dels últims partits">${form.slice(-5).map(result => `<span class="form-badge ${result === "W" ? "win" : result === "L" ? "loss" : "draw"}" title="${labels[result] || "Resultat"}">${escapeHtml(result)}</span>`).join("")}</div>`;
}

function teamMarkup(team = {}, side, crestUrl = "") {
  const crest = safeImageUrl(crestUrl);
  const standing = team.standing;
  return `<article class="preview-team preview-team--${side}">
    <div class="preview-team__identity">${crest ? `<img src="${escapeHtml(crest)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="preview-crest" aria-hidden="true">⚽</span>`}<div><span>${side === "home" ? "Local" : "Visitant"}</span><h3>${escapeHtml(team.name || "Equip")}</h3></div></div>
    ${standing ? `<dl class="preview-standing"><div><dt>Posició</dt><dd>${escapeHtml(standing.position)}a</dd></div><div><dt>Punts</dt><dd>${escapeHtml(standing.points)}</dd></div><div><dt>PJ</dt><dd>${escapeHtml(standing.played)}</dd></div><div><dt>GF/GC</dt><dd>${escapeHtml(standing.goalsFor)}/${escapeHtml(standing.goalsAgainst)}</dd></div></dl>` : `<p class="preview-muted">Classificació no disponible.</p>`}
    <div class="preview-form-row"><span>Forma</span>${formMarkup(team.form)}</div>
    ${recentMatchesMarkup(team.recentMatches)}
    ${team.attackingReference ? `<p class="preview-attacker"><span>Referència ofensiva</span><strong>${escapeHtml(team.attackingReference.name)}</strong> · ${escapeHtml(team.attackingReference.goals)} gols</p>` : ""}
  </article>`;
}

function manualTeamMarkup(team = {}, side, teamName, crestUrl = "") {
  const crest = safeImageUrl(crestUrl);
  const highlights = Array.isArray(team.highlights) ? team.highlights.slice(0, 4) : [];
  return `<article class="preview-team preview-team--${side} manual-preview-team">
    <div class="preview-team__identity">${crest ? `<img src="${escapeHtml(crest)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="preview-crest" aria-hidden="true">⚽</span>`}<div><span>${side === "home" ? "Local" : "Visitant"}</span><h3>${escapeHtml(teamName || (side === "home" ? "Equip local" : "Equip visitant"))}</h3></div></div>
    <ul class="manual-preview-highlights">${highlights.map(highlight => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul>
  </article>`;
}

export function previewFreshness(preview, now = Date.now()) {
  const fetched = new Date(preview?.fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return "unknown";
  return now - fetched > STALE_AFTER_MS ? "stale" : "fresh";
}

export function matchPreviewMarkup(preview, { now = Date.now(), context = "public", crestUrls = {}, teamNames = {} } = {}) {
  if (!preview) return "";
  const freshness = previewFreshness(preview, now);
  const warnings = Array.isArray(preview.warnings) ? preview.warnings.slice(0, 5) : [];
  const fetchedAt = Number.isFinite(new Date(preview.fetchedAt).getTime())
    ? new Intl.DateTimeFormat("ca-ES", { dateStyle: "short", timeStyle: "short" }).format(new Date(preview.fetchedAt))
    : "hora desconeguda";
  if (preview.provider === "manual") {
    const homeHighlights = Array.isArray(preview.homeTeam?.highlights) ? preview.homeTeam.highlights : [];
    const awayHighlights = Array.isArray(preview.awayTeam?.highlights) ? preview.awayTeam.highlights : [];
    if (!homeHighlights.length || !awayHighlights.length) return "";
    const sourceUrl = safeSourceUrl(preview.source?.url);
    const sourceLabel = String(preview.source?.label || "").trim();
    const source = sourceUrl
      ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(sourceLabel || "Font consultada")}</a>`
      : escapeHtml(sourceLabel);
    return `<section class="panel match-preview manual-match-preview" aria-labelledby="match-preview-title" data-preview-context="${escapeHtml(context)}">
      <div class="section-heading preview-heading"><div><span>Claus abans del partit</span><h2 id="match-preview-title">Prèvia del partit</h2></div>${fetchedAt !== "hora desconeguda" ? `<span class="preview-freshness">Actualitzada · ${escapeHtml(fetchedAt)}</span>` : ""}</div>
      <div class="preview-teams">${manualTeamMarkup(preview.homeTeam, "home", teamNames.home, crestUrls.home)}<span class="preview-versus" aria-hidden="true">VS</span>${manualTeamMarkup(preview.awayTeam, "away", teamNames.away, crestUrls.away)}</div>
      ${source ? `<p class="preview-source">Font: ${source}</p>` : ""}
    </section>`;
  }
  return `<section class="panel match-preview ${freshness === "stale" ? "is-stale" : ""}" aria-labelledby="match-preview-title" data-preview-context="${escapeHtml(context)}">
    <div class="section-heading preview-heading"><div><span>Context abans del partit</span><h2 id="match-preview-title">Prèvia del partit</h2></div><span class="preview-freshness">${freshness === "stale" ? "Dades antigues" : "Actualitzada"} · ${escapeHtml(fetchedAt)}</span></div>
    <div class="preview-match-meta"><strong>${escapeHtml(preview.competitionName || "Competició")}</strong><span>Temporada ${escapeHtml(preview.season || "—")}</span></div>
    <div class="preview-teams">${teamMarkup(preview.homeTeam, "home", crestUrls.home || (context === "admin" ? preview.homeTeam?.crestUrl : ""))}<span class="preview-versus" aria-hidden="true">VS</span>${teamMarkup(preview.awayTeam, "away", crestUrls.away || (context === "admin" ? preview.awayTeam?.crestUrl : ""))}</div>
    ${warnings.length ? `<div class="preview-warnings" role="note"><strong>Dades parcials</strong><ul>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
    <p class="preview-source">Font: ${preview.provider === "demo" ? escapeHtml(preview.source?.label || "Dades demo") : `<a href="https://www.api-football.com/" target="_blank" rel="noopener noreferrer nofollow">API-Football</a>`}. Context informatiu; el marcador oficial continua sota control de l’administrador.</p>
  </section>`;
}

export function createDemoMatchPreview(pool) {
  const recent = (opponent, scoreFor, scoreAgainst, venue) => ({
    competitionName: "Lliga demo", opponent, scoreFor, scoreAgainst, venue, playedAt: "2026-08-17T19:00:00.000Z"
  });
  return {
    version: "1",
    provider: "demo",
    competitionName: "Lliga demo",
    season: 2026,
    fetchedAt: "2026-08-24T09:00:00.000Z",
    kickoffAt: pool.matchAt || "2026-08-30T19:00:00.000Z",
    homeTeam: {
      name: pool.homeTeam, standing: { position: 2, points: 68, played: 34, goalsFor: 62, goalsAgainst: 29 },
      form: ["W", "W", "D", "W", "L"], recentMatches: [recent("Atlètic Demo", 2, 0, "home"), recent("Ciutat Demo", 1, 1, "away")],
      attackingReference: { name: "Davanter local", goals: 18 }
    },
    awayTeam: {
      name: pool.awayTeam, standing: { position: 5, points: 57, played: 34, goalsFor: 51, goalsAgainst: 37 },
      form: ["D", "W", "L", "W", "W"], recentMatches: [recent("Unió Demo", 3, 1, "away"), recent("Racing Demo", 0, 0, "home")],
      attackingReference: { name: "Davanter visitant", goals: 14 }
    },
    warnings: [],
    source: { label: "Dades demo", url: "" }
  };
}

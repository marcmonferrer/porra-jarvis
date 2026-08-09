import {
  SPECIAL_CELLS,
  calculatePrizes,
  formatMoney,
  isSpecialCell,
  listCells,
  occupancyForCell,
  poolMetrics,
  resultCell
} from "./core.js";
import { createRepository } from "./repository.js";

const app = document.querySelector("#app");
const toast = document.querySelector("[data-toast]");
const config = window.PORRA_LIVE_CONFIG || { mode: "demo" };
const repository = await createRepository(config);

let view = location.hash.replace("#", "") || "public";
let currentPoolId = new URLSearchParams(location.search).get("pool");
let selectedCells = [];
let lastTrackingToken = new URLSearchParams(location.search).get("track") || "";
let activeAdminTab = "pool";
let subscribedPoolId = null;
let unsubscribeRealtime = null;

if (repository.mode !== "demo") document.querySelector("[data-mode-banner]").hidden = true;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function notify(message, type = "success") {
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("is-visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

function statusLabel(status) {
  return ({ draft: "Esborrany", open: "Oberta", closed: "Tancada", finished: "Finalitzada" })[status] || status;
}

function paymentLabel(status) {
  return ({ pending: "Pendent", paid: "Pagada", released: "Alliberada" })[status] || status;
}

function specialLabel(pool, cellKey) {
  return pool.specials.find(item => item.cellKey === cellKey)?.title || cellKey;
}

function cellLabel(pool, cellKey) {
  return isSpecialCell(cellKey) ? specialLabel(pool, cellKey) : cellKey.replace("-", "–");
}

function matchName(pool) {
  return `${pool.homeTeam || "Equip local"} vs ${pool.awayTeam || "Equip visitant"}`;
}

function dateText(value) {
  if (!value) return "Per definir";
  return new Intl.DateTimeFormat("ca-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ensureRealtime(poolId) {
  if (repository.mode !== "supabase" || subscribedPoolId === poolId) return;
  unsubscribeRealtime?.();
  subscribedPoolId = poolId;
  unsubscribeRealtime = repository.subscribe(poolId, async () => {
    if (view === "public") await renderPublic();
    if (view === "tracking") await renderTracking();
    if (view === "admin" && ["bets", "match", "prizes"].includes(activeAdminTab)) await renderAdmin();
  });
}

function renderTeam(team, image, side) {
  const visual = image
    ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
    : `<span class="team-fallback" aria-hidden="true">${escapeHtml(team.slice(0, 2).toUpperCase())}</span>`;
  return `<div class="team team--${side}">${visual}<strong>${escapeHtml(team)}</strong><small>${side === "home" ? "Primer marcador · local" : "Segon marcador · visitant"}</small></div>`;
}

function hero(pool) {
  return `<section class="match-hero">
    <div class="match-hero__top"><span class="status-pill status-${pool.status}">${statusLabel(pool.status)}</span><span>${dateText(pool.matchAt)}</span></div>
    <h1>${escapeHtml(pool.title)}</h1>
    <div class="versus">${renderTeam(pool.homeTeam, pool.homeImage, "home")}<span>VS</span>${renderTeam(pool.awayTeam, pool.awayImage, "away")}</div>
    <p class="close-note">Participacions fins a ${dateText(pool.closesAt)} · ${formatMoney(pool.priceCents)} per aposta</p>
  </section>`;
}

function metricsMarkup(metrics) {
  return `<div class="metric-grid">
    <article><span>Pot confirmat</span><strong>${formatMoney(metrics.confirmedPoolCents)}</strong><small>Només pagades</small></article>
    <article><span>Pot potencial</span><strong>${formatMoney(metrics.potentialPoolCents)}</strong><small>Pagades + pendents</small></article>
    <article><span>Places lliures</span><strong>${metrics.freePlaces}</strong><small>de 50</small></article>
    <article><span>Estat de pagaments</span><strong>${metrics.paidPlaces} / ${metrics.pendingPlaces}</strong><small>pagades / pendents</small></article>
  </div>`;
}

function gridMarkup(state, interactive = true) {
  const { pool, bets } = state;
  const headers = Array.from({ length: 5 }, (_, index) => `<span class="grid-axis">${index}</span>`).join("");
  const rows = Array.from({ length: 5 }, (_, away) => {
    const cells = Array.from({ length: 5 }, (_, home) => {
      const key = resultCell(home, away);
      const occupancy = occupancyForCell(bets, key);
      const available = 2 - occupancy;
      const selected = selectedCells.includes(key);
      const special = isSpecialCell(key);
      return `<button class="bet-cell ${special ? "is-special" : ""} ${selected ? "is-selected" : ""} ${available === 0 ? "is-full" : ""}"
        type="button" data-cell="${key}" ${!interactive || available === 0 ? "disabled" : ""}
        aria-pressed="${selected}" aria-label="${escapeHtml(cellLabel(pool, key))}, ${available} places lliures">
        <strong>${escapeHtml(cellLabel(pool, key))}</strong>
        ${special ? `<small>${escapeHtml(pool.specials.find(item => item.cellKey === key)?.description || "Aposta especial")}</small>` : ""}
        <span class="occupancy-dots" aria-hidden="true"><i class="${occupancy > 0 ? "filled" : ""}"></i><i class="${occupancy > 1 ? "filled" : ""}"></i></span>
        <em>${available === 0 ? "Completa" : `${available} ${available === 1 ? "plaça" : "places"}`}</em>
      </button>`;
    }).join("");
    return `<span class="grid-axis grid-axis--row">${away}</span>${cells}`;
  }).join("");
  return `<div class="score-key"><span>${escapeHtml(pool.homeTeam)} = primer marcador →</span><span>${escapeHtml(pool.awayTeam)} = segon marcador ↓</span></div>
    <div class="score-grid"><span class="grid-corner">LOCAL<br>VISITANT</span>${headers}${rows}</div>
    <div class="grid-legend"><span><i></i>Dues places</span><span><i class="one"></i>Una ocupada</span><span><i class="two"></i>Completa</span><span><i class="selected"></i>Selecció temporal</span></div>`;
}

async function resolveActivePool() {
  const pools = await repository.listPools();
  if (currentPoolId) {
    const selected = pools.find(pool => pool.id === currentPoolId || pool.slug === currentPoolId);
    if (selected) return selected;
  }
  return pools.find(pool => pool.status === "open") || pools[0] || null;
}

async function renderPublic() {
  const pool = await resolveActivePool();
  if (!pool) {
    app.innerHTML = `<section class="empty-state panel"><span>⚽</span><h1>Encara no hi ha cap porra publicada</h1><p>L’administrador pot crear la primera porra des del panell d’administració.</p><button class="button primary" data-view="admin">Crear una porra</button></section>`;
    return;
  }
  currentPoolId = pool.id;
  ensureRealtime(pool.id);
  const state = await repository.getPoolState(pool.id);
  const canPlay = pool.status === "open" && (!pool.closesAt || Date.now() < new Date(pool.closesAt).getTime());
  const selectionCost = selectedCells.length * pool.priceCents;
  const selectionPool = selectedCells.length * pool.poolPerBetCents;
  app.innerHTML = `${hero(pool)}${metricsMarkup(state.metrics)}
    <div class="public-layout">
      <section class="panel bet-panel">
        <div class="section-heading"><div><span>1 · Tria una o dues apostes</span><h2>Graella de resultats i especials</h2></div><strong>${state.metrics.freePlaces} places lliures</strong></div>
        ${gridMarkup(state, canPlay)}
      </section>
      <aside class="panel checkout-panel">
        <span class="eyebrow">2 · Confirma la participació</span>
        <h2>La teva selecció</h2>
        ${canPlay ? `<label>Nom del participant<input name="participantName" maxlength="50" autocomplete="name" placeholder="El teu nom"></label>
          <div class="selection-summary">${selectedCells.length ? selectedCells.map(key => `<span>${escapeHtml(cellLabel(pool, key))}</span>`).join("") : `<p>Selecciona una o dues caselles diferents.</p>`}</div>
          <dl><div><dt>Cost total</dt><dd>${formatMoney(selectionCost)}</dd></div><div><dt>Destinat al pot</dt><dd>${formatMoney(selectionPool)}</dd></div></dl>
          <button class="button primary wide" data-action="confirm-reservation" ${selectedCells.length ? "" : "disabled"}>Confirmar apostes</button>
          <small>La selecció rosa encara no ocupa plaça. En confirmar, la reserva queda pendent de verificar.</small>`
          : `<div class="notice"><strong>Participacions tancades</strong><p>Pots continuar consultant el marcador i la teva aposta privada.</p></div>`}
        <button class="button secondary wide" data-action="share-pool">Compartir per WhatsApp</button>
      </aside>
    </div>
    ${liveMarkup(state)}`;
}

function liveMarkup(state) {
  const { pool, match } = state;
  if (!match) return "";
  const phases = { pre: "Prepartit", first: "Primera part", half: "Descans", second: "Segona part", final: "Final" };
  return `<section class="panel live-panel">
    <div><span class="live-dot ${["first", "second"].includes(match.phase) ? "active" : ""}"></span><strong>${phases[match.phase] || match.phase}</strong><small>${match.minute ? `Minut ${match.minute}` : ""}</small></div>
    <div class="live-score"><span>${escapeHtml(pool.homeTeam)}</span><strong>${match.currentHome} – ${match.currentAway}</strong><span>${escapeHtml(pool.awayTeam)}</span></div>
    <div class="live-results"><span>Descans: ${match.halfHome == null ? "—" : `${match.halfHome}–${match.halfAway}`}</span><span>Final: ${match.finalHome == null ? "—" : `${match.finalHome}–${match.finalAway}`}</span></div>
  </section>`;
}

async function confirmReservation() {
  const input = app.querySelector("[name='participantName']");
  const name = input?.value.trim();
  if (!name) return notify("Escriu el nom del participant.", "error");
  try {
    const result = await repository.createReservation({ poolId: currentPoolId, name, cellKeys: selectedCells });
    lastTrackingToken = result.token || result.tracking_token;
    selectedCells = [];
    const state = await repository.getPoolState(currentPoolId);
    const trackUrl = `${location.origin}${location.pathname}?track=${encodeURIComponent(lastTrackingToken)}#tracking`;
    app.innerHTML = `${hero(state.pool)}<section class="success-state panel">
      <span class="success-icon">✓</span><p class="eyebrow">Reserva creada</p><h2>Pendent de verificar pagament</h2>
      <p>Has reservat ${result.bets?.length || 0} ${result.bets?.length === 1 ? "aposta" : "apostes"} per un total de <strong>${formatMoney((result.bets?.length || 0) * state.pool.priceCents)}</strong>.</p>
      <div class="payment-box"><strong>Instruccions de pagament</strong><p>${escapeHtml(state.pool.paymentInstructions || "L’administrador encara no ha configurat les instruccions.")}</p></div>
      <p>Desa aquest enllaç privat per consultar l’estat des de qualsevol dispositiu:</p>
      <div class="private-link"><input readonly value="${escapeHtml(trackUrl)}" aria-label="Enllaç privat de seguiment"><button class="button" data-copy="${escapeHtml(trackUrl)}">Copiar</button></div>
      <button class="button primary" data-view="tracking">Veure la meva aposta</button>
    </section>`;
  } catch (error) {
    notify(error.message || "No s'ha pogut crear la reserva.", "error");
    await renderPublic();
  }
}

function poolForm(pool = {}) {
  const specials = pool.specials || SPECIAL_CELLS.map((cellKey, index) => ({ cellKey, title: `Especial ${index + 1}`, description: "" }));
  const localDate = value => {
    if (!value) return "";
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  return `<form class="pool-form" data-form="pool">
    <input type="hidden" name="id" value="${escapeHtml(pool.id || "")}">
    <div class="form-grid">
      <label class="span-2">Títol<input required name="title" value="${escapeHtml(pool.title || "")}" placeholder="Nom de la porra"></label>
      <label>Equip local<input required name="homeTeam" value="${escapeHtml(pool.homeTeam || "")}" placeholder="Primer marcador"></label>
      <label>Equip visitant<input required name="awayTeam" value="${escapeHtml(pool.awayTeam || "")}" placeholder="Segon marcador"></label>
      <label>Imatge local (URL)<input name="homeImage" type="url" value="${escapeHtml(pool.homeImage || "")}" placeholder="https://…"></label>
      <label>Imatge visitant (URL)<input name="awayImage" type="url" value="${escapeHtml(pool.awayImage || "")}" placeholder="https://…"></label>
      <label>Data i hora del partit<input required name="matchAt" type="datetime-local" value="${localDate(pool.matchAt)}"></label>
      <label>Tancament de participacions<input required name="closesAt" type="datetime-local" value="${localDate(pool.closesAt)}"></label>
      <label>Preu per aposta (€)<input required name="price" type="number" step="0.01" min="0" value="${(pool.priceCents ?? 400) / 100}"></label>
      <label>Import al pot (€)<input required name="poolPerBet" type="number" step="0.01" min="0" value="${(pool.poolPerBetCents ?? 350) / 100}"></label>
      <label>Gestió (€)<input required name="fee" type="number" step="0.01" min="0" value="${(pool.feeCents ?? 50) / 100}"></label>
      <label>Pot acumulat anterior (€)<input name="carryover" type="number" step="0.01" min="0" value="${(pool.carryoverCents ?? 0) / 100}"></label>
      <label class="span-2">Instruccions de pagament<textarea required name="paymentInstructions" placeholder="Configura el destinatari i el concepte fora del codi">${escapeHtml(pool.paymentInstructions || "")}</textarea></label>
    </div>
    <fieldset><legend>Quatre apostes especials</legend><div class="special-form-grid">${specials.map((special, index) => `<div><strong>${special.cellKey}</strong><label>Nom<input required name="specialTitle${index}" value="${escapeHtml(special.title)}"></label><label>Condició<textarea name="specialDescription${index}">${escapeHtml(special.description || "")}</textarea></label></div>`).join("")}</div></fieldset>
    <button class="button primary" type="submit">${pool.id ? "Desar canvis" : "Crear esborrany"}</button>
  </form>`;
}

async function renderAdmin() {
  const session = await repository.getSession();
  if (repository.mode !== "demo" && !session?.user) {
    app.innerHTML = `<section class="tracking-entry panel"><span class="eyebrow">Accés protegit</span><h1>Administració de Porra Live</h1><p>Inicia sessió amb l’únic compte administrador configurat a Supabase.</p><form data-form="admin-login"><label>Correu electrònic<input required name="email" type="email" autocomplete="username"></label><label>Contrasenya<input required name="password" type="password" autocomplete="current-password"></label><button class="button primary">Iniciar sessió</button></form></section>`;
    return;
  }
  const pools = await repository.listPools();
  const pool = currentPoolId ? pools.find(item => item.id === currentPoolId) : pools[0];
  if (pool) currentPoolId = pool.id;
  const state = pool ? await repository.getPoolState(pool.id) : null;
  app.innerHTML = `<section class="admin-hero"><div><span class="eyebrow">Panell d’administració</span><h1>Gestiona Porra Live</h1><p>Crea porres, valida pagaments i publica els premis des d’un únic lloc.</p></div><div class="admin-session">${repository.mode === "demo" ? "Sessió demo" : escapeHtml(session.user.email)}${repository.mode === "demo" ? "" : `<button data-action="admin-logout">Sortir</button>`}</div></section>
    <div class="admin-tabs" role="tablist">
      <button data-admin-tab="pool" class="${activeAdminTab === "pool" ? "active" : ""}">1. Porra</button><button data-admin-tab="bets" class="${activeAdminTab === "bets" ? "active" : ""}" ${pool ? "" : "disabled"}>2. Apostes</button><button data-admin-tab="match" class="${activeAdminTab === "match" ? "active" : ""}" ${pool ? "" : "disabled"}>3. Directe</button><button data-admin-tab="prizes" class="${activeAdminTab === "prizes" ? "active" : ""}" ${pool ? "" : "disabled"}>4. Premis</button><button data-admin-tab="history" class="${activeAdminTab === "history" ? "active" : ""}">5. Historial</button>
    </div>
    <section class="panel admin-panel" data-admin-panel="pool" ${activeAdminTab === "pool" ? "" : "hidden"}><div class="section-heading"><div><span>Configuració</span><h2>${pool ? "Editar porra" : "Crear la primera porra"}</h2></div>${pool ? `<span class="status-pill status-${pool.status}">${statusLabel(pool.status)}</span>` : ""}</div>${poolForm(pool || {})}${pool ? `<div class="action-row"><button class="button primary" data-action="publish-pool" ${pool.status === "draft" ? "" : "disabled"}>Publicar</button><button class="button" data-action="toggle-pool" ${["open","closed"].includes(pool.status) ? "" : "disabled"}>${pool.status === "open" ? "Tancar participacions" : pool.status === "closed" ? "Reobrir" : "Estat bloquejat"}</button><button class="button secondary" data-view="public">Obrir vista pública</button></div>` : ""}</section>
    <section class="panel admin-panel" data-admin-panel="bets" ${activeAdminTab === "bets" ? "" : "hidden"}>${state ? adminBetsMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="match" ${activeAdminTab === "match" ? "" : "hidden"}>${state ? adminMatchMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="prizes" ${activeAdminTab === "prizes" ? "" : "hidden"}>${state ? adminPrizesMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="history" ${activeAdminTab === "history" ? "" : "hidden"}>${historyMarkup(pools)}</section>`;
}

function adminBetsMarkup(state) {
  const { pool, bets, participants } = state;
  const rows = bets.filter(bet => bet.paymentStatus !== "released").map(bet => {
    const person = participants.find(item => item.id === bet.participantId);
    const options = listCells().map(cell => `<option value="${cell}" ${cell === bet.cellKey ? "selected" : ""}>${escapeHtml(cellLabel(pool, cell))}</option>`).join("");
    return `<tr><td><input value="${escapeHtml(person?.name || "")}" data-participant-name="${bet.participantId}" aria-label="Nom del participant"></td><td><select data-bet-cell="${bet.id}" aria-label="Aposta">${options}</select></td><td><span class="payment-status ${bet.paymentStatus}">${paymentLabel(bet.paymentStatus)}</span></td><td><button class="button small" data-pay="${bet.id}" ${bet.paymentStatus === "paid" ? "disabled" : ""}>Confirmar</button><button class="button small danger" data-release="${bet.id}">Alliberar</button></td></tr>`;
  }).join("");
  return `<div class="section-heading"><div><span>Pagaments i reserves</span><h2>${state.metrics.pendingPlaces} pendents · ${state.metrics.paidPlaces} pagades</h2></div><strong>${state.metrics.freePlaces} places lliures</strong></div>${metricsMarkup(state.metrics)}${rows ? `<div class="table-wrap"><table><thead><tr><th>Participant</th><th>Aposta</th><th>Pagament</th><th>Accions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-inline">Encara no hi ha cap reserva.</div>`}`;
}

function scoreInput(name, label, value, nullable = false) {
  return `<label>${label}<input name="${name}" type="number" min="0" max="99" ${nullable ? "" : "required"} value="${value ?? ""}"></label>`;
}

function adminMatchMarkup(state) {
  const { pool, match } = state;
  return `<div class="section-heading"><div><span>Control manual</span><h2>${escapeHtml(matchName(pool))}</h2></div><span>El proveïdor automàtic és opcional</span></div><form data-form="match" class="match-form">
    <label>Fase<select name="phase">${[["pre","Prepartit"],["first","Primera part"],["half","Descans"],["second","Segona part"],["final","Final"]].map(([value,label]) => `<option value="${value}" ${match.phase === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    ${scoreInput("minute", "Minut", match.minute)}
    <fieldset><legend>Marcador actual</legend>${scoreInput("currentHome", pool.homeTeam, match.currentHome)}${scoreInput("currentAway", pool.awayTeam, match.currentAway)}</fieldset>
    <fieldset><legend>Resultat exacte al descans</legend>${scoreInput("halfHome", pool.homeTeam, match.halfHome, true)}${scoreInput("halfAway", pool.awayTeam, match.halfAway, true)}</fieldset>
    <fieldset><legend>Resultat exacte final</legend>${scoreInput("finalHome", pool.homeTeam, match.finalHome, true)}${scoreInput("finalAway", pool.awayTeam, match.finalAway, true)}</fieldset>
    <fieldset class="special-statuses"><legend>Estat dels especials</legend>${pool.specials.map(item => `<label>${escapeHtml(item.title)}<select name="special-${item.cellKey}">${[["pending","Pendent"],["completed","Complerta"],["failed","No complerta"]].map(([value,label]) => `<option value="${value}" ${match.specialStatuses?.[item.cellKey] === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`).join("")}</fieldset>
    <button class="button primary" type="submit">Actualitzar directe</button>
  </form>`;
}

function prizePreview(state) {
  try {
    return calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
  } catch {
    return null;
  }
}

function adminPrizesMarkup(state) {
  const preview = state.prizeResult || prizePreview(state);
  const pendingWarning = state.metrics.pendingPlaces > 0 ? `<div class="warning"><strong>No es pot finalitzar</strong><p>Queden ${state.metrics.pendingPlaces} apostes pendents. Confirma-les o allibera-les.</p></div>` : "";
  const participantName = betId => {
    const bet = state.bets.find(item => item.id === betId);
    return state.participants.find(person => person.id === bet?.participantId)?.name || "Participant";
  };
  return `<div class="section-heading"><div><span>Revisió abans de publicar</span><h2>Resultats i premis</h2></div><strong>${formatMoney(preview?.totalPotCents || 0)}</strong></div>${pendingWarning}
    <div class="prize-split"><article><span>Descans · 25%</span><strong>${formatMoney(preview?.allocations?.halfBase || 0)}</strong><small>${preview?.winners?.half?.length || 0} apostes guanyadores</small></article><article><span>Final · 50% + redistribució</span><strong>${formatMoney(preview?.allocations?.finalAvailable || 0)}</strong><small>${preview?.winners?.final?.length || 0} apostes guanyadores</small></article><article><span>Especials · 25%</span><strong>${formatMoney(preview?.allocations?.specialBase || 0)}</strong><small>${preview?.winners?.special?.length || 0} apostes guanyadores</small></article></div>
    ${preview?.awards?.length ? `<div class="award-list">${preview.awards.map(award => `<div><span>${escapeHtml(participantName(award.betId))}</span><strong>${formatMoney(award.totalCents)}</strong></div>`).join("")}</div>` : `<div class="empty-inline">Sense apostes guanyadores: el pot queda acumulat.</div>`}
    <div class="review-check"><label><input type="checkbox" data-prize-review> He revisat el marcador, els especials, els pagaments i els imports.</label><button class="button primary" data-action="finalize-pool" disabled>Publicar premis definitius</button></div>`;
}

function historyMarkup(pools) {
  return `<div class="section-heading"><div><span>Totes les edicions</span><h2>Historial de porres</h2></div><strong>${pools.length}</strong></div>${pools.length ? `<div class="history-list">${pools.map(pool => `<button data-pool="${pool.id}"><span class="status-pill status-${pool.status}">${statusLabel(pool.status)}</span><strong>${escapeHtml(pool.title)}</strong><small>${escapeHtml(matchName(pool))} · ${dateText(pool.matchAt)}</small></button>`).join("")}</div>` : `<div class="empty-inline">Encara no hi ha historial.</div>`}`;
}

async function renderTracking() {
  const token = lastTrackingToken;
  if (!token) {
    app.innerHTML = `<section class="tracking-entry panel"><span class="eyebrow">Keeping track</span><h1>Consulta la teva aposta</h1><p>Enganxa l’identificador o l’enllaç privat que vas rebre en confirmar.</p><form data-form="tracking"><label>Identificador privat<input name="token" autocomplete="off" required></label><button class="button primary">Consultar</button></form></section>`;
    return;
  }
  const tracking = await repository.getTracking(token);
  if (!tracking) {
    app.innerHTML = `<section class="error-state panel"><h1>No hem trobat aquesta participació</h1><p>Comprova que l’enllaç privat sigui complet.</p><button class="button" data-action="clear-tracking">Tornar-ho a provar</button></section>`;
    return;
  }
  const total = tracking.bets.reduce((sum, bet) => sum + tracking.pool.priceCents, 0);
  const chance = bet => {
    if (bet.paymentStatus === "released") return "Reserva alliberada";
    if (bet.paymentStatus === "pending") return "Sense opcions fins que es confirmi el pagament";
    if (tracking.final) return bet.prizeCents > 0 ? "Aposta guanyadora" : "Sense premi";
    if (isSpecialCell(bet.cellKey)) {
      const status = tracking.match.specialStatuses?.[bet.cellKey] || "pending";
      return status === "completed" ? "Guanyadora provisional" : status === "failed" ? "Ja no té opcions" : "Encara té opcions";
    }
    const halfKey = tracking.match.halfHome == null ? null : resultCell(tracking.match.halfHome, tracking.match.halfAway);
    const finalKey = tracking.match.finalHome == null ? null : resultCell(tracking.match.finalHome, tracking.match.finalAway);
    if (bet.cellKey === halfKey || bet.cellKey === finalKey) return "Guanyadora provisional";
    return finalKey ? "Sense premi" : "Encara té opcions";
  };
  app.innerHTML = `${hero(tracking.pool)}<section class="tracking-card panel"><div class="section-heading"><div><span>Seguiment privat</span><h2>${escapeHtml(tracking.participant.name)}</h2></div><strong>${formatMoney(total)}</strong></div>
    <div class="tracking-bets">${tracking.bets.map(bet => `<article><div><strong>${escapeHtml(cellLabel(tracking.pool, bet.cellKey))}</strong><span class="payment-status ${bet.paymentStatus}">${paymentLabel(bet.paymentStatus)}</span></div><dl><div><dt>Estat</dt><dd>${bet.paymentStatus === "paid" ? "Participa en els premis" : bet.paymentStatus === "pending" ? "Pendent de verificar pagament" : "Reserva alliberada"}</dd></div><div><dt>Opcions</dt><dd>${chance(bet)}</dd></div><div><dt>Premi ${tracking.final ? "definitiu" : "provisional"}</dt><dd>${formatMoney(bet.prizeCents || 0)}</dd></div></dl></article>`).join("")}</div>
    ${liveMarkup({ pool: tracking.pool, match: tracking.match })}
    <p class="privacy-note">Aquest enllaç és privat. No el comparteixis públicament.</p></section>`;
}

async function render() {
  document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  app.setAttribute("aria-busy", "true");
  try {
    if (view === "admin") await renderAdmin();
    else if (view === "tracking") await renderTracking();
    else await renderPublic();
  } catch (error) {
    app.innerHTML = `<section class="error-state panel"><h1>No s’ha pogut carregar Porra Live</h1><p>${escapeHtml(error.message || "Error inesperat")}</p><button class="button" data-action="retry">Tornar-ho a provar</button></section>`;
  } finally {
    app.setAttribute("aria-busy", "false");
  }
}

function poolData(form) {
  const data = new FormData(form);
  return {
    id: data.get("id") || undefined,
    title: data.get("title"), homeTeam: data.get("homeTeam"), awayTeam: data.get("awayTeam"),
    homeImage: data.get("homeImage"), awayImage: data.get("awayImage"),
    matchAt: new Date(data.get("matchAt")).toISOString(), closesAt: new Date(data.get("closesAt")).toISOString(),
    price: data.get("price"), poolPerBet: data.get("poolPerBet"), fee: data.get("fee"), carryover: data.get("carryover"),
    paymentInstructions: data.get("paymentInstructions"),
    specials: SPECIAL_CELLS.map((cellKey, index) => ({ cellKey, title: data.get(`specialTitle${index}`), description: data.get(`specialDescription${index}`) }))
  };
}

app.addEventListener("click", async event => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    view = viewButton.dataset.view;
    location.hash = view;
    await render();
    return;
  }
  const cell = event.target.closest("[data-cell]");
  if (cell) {
    const key = cell.dataset.cell;
    selectedCells = selectedCells.includes(key) ? selectedCells.filter(item => item !== key) : selectedCells.length < 2 ? [...selectedCells, key] : selectedCells;
    if (selectedCells.length === 2 && !selectedCells.includes(key)) notify("Màxim dues apostes per participant.", "error");
    await renderPublic();
    return;
  }
  if (event.target.closest("[data-action='confirm-reservation']")) return confirmReservation();
  if (event.target.closest("[data-action='share-pool']")) {
    const pool = await repository.getPoolState(currentPoolId);
    const message = `${pool.pool.title}\n${matchName(pool.pool)}\nParticipa a Porra Live: ${location.origin}${location.pathname}?pool=${pool.pool.slug}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy);
    notify("Enllaç privat copiat.");
  }
  const tab = event.target.closest("[data-admin-tab]");
  if (tab) {
    activeAdminTab = tab.dataset.adminTab;
    document.querySelectorAll("[data-admin-tab]").forEach(item => item.classList.toggle("active", item === tab));
    document.querySelectorAll("[data-admin-panel]").forEach(panel => { panel.hidden = panel.dataset.adminPanel !== tab.dataset.adminTab; });
  }
  if (event.target.closest("[data-action='publish-pool']")) {
    await repository.publishPool(currentPoolId); notify("Porra publicada i oberta."); await renderAdmin();
  }
  if (event.target.closest("[data-action='toggle-pool']")) {
    const state = await repository.getPoolState(currentPoolId);
    await repository.setPoolStatus(currentPoolId, state.pool.status === "open" ? "closed" : "open");
    notify(state.pool.status === "open" ? "Participacions reobertes." : "Participacions tancades."); await renderAdmin();
  }
  const pay = event.target.closest("[data-pay]");
  if (pay) { await repository.updateBet(pay.dataset.pay, { paymentStatus: "paid" }); notify("Pagament confirmat."); await renderAdmin(); }
  const release = event.target.closest("[data-release]");
  if (release) { await repository.updateBet(release.dataset.release, { paymentStatus: "released" }); notify("Reserva alliberada."); await renderAdmin(); }
  const poolButton = event.target.closest("[data-pool]");
  if (poolButton) { currentPoolId = poolButton.dataset.pool; await renderAdmin(); }
  const review = event.target.closest("[data-prize-review]");
  if (review) app.querySelector("[data-action='finalize-pool']").disabled = !review.checked;
  if (event.target.closest("[data-action='finalize-pool']")) {
    try { await repository.finalizePool(currentPoolId); notify("Premis publicats i porra finalitzada."); await renderAdmin(); }
    catch (error) { notify(error.message, "error"); }
  }
  if (event.target.closest("[data-action='clear-tracking']")) { lastTrackingToken = ""; await renderTracking(); }
  if (event.target.closest("[data-action='admin-logout']")) { await repository.signOut(); notify("Sessió tancada."); await renderAdmin(); }
  if (event.target.closest("[data-action='retry']")) await render();
});

app.addEventListener("change", async event => {
  const nameInput = event.target.closest("[data-participant-name]");
  if (nameInput) { await repository.updateParticipant(nameInput.dataset.participantName, nameInput.value); notify("Nom actualitzat."); }
  const betSelect = event.target.closest("[data-bet-cell]");
  if (betSelect) {
    try { await repository.updateBet(betSelect.dataset.betCell, { cellKey: betSelect.value }); notify("Aposta corregida."); }
    catch (error) { notify(error.message, "error"); await renderAdmin(); }
  }
});

app.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.dataset.form === "pool") {
      const pool = await repository.savePool(poolData(form)); currentPoolId = pool.id; notify("Porra desada."); await renderAdmin();
    }
    if (form.dataset.form === "admin-login") {
      const data = new FormData(form);
      await repository.signIn(data.get("email"), data.get("password"));
      notify("Sessió iniciada.");
      await renderAdmin();
    }
    if (form.dataset.form === "tracking") { lastTrackingToken = new FormData(form).get("token").trim(); await renderTracking(); }
    if (form.dataset.form === "match") {
      const data = new FormData(form);
      const nullable = key => data.get(key) === "" ? null : Number(data.get(key));
      await repository.updateMatch(currentPoolId, {
        phase: data.get("phase"), minute: Number(data.get("minute")), currentHome: Number(data.get("currentHome")), currentAway: Number(data.get("currentAway")),
        halfHome: nullable("halfHome"), halfAway: nullable("halfAway"), finalHome: nullable("finalHome"), finalAway: nullable("finalAway"),
        specialStatuses: Object.fromEntries(SPECIAL_CELLS.map(key => [key, data.get(`special-${key}`)]))
      });
      notify("Estat del partit actualitzat."); await renderAdmin();
    }
  } catch (error) { notify(error.message || "No s'han pogut desar els canvis.", "error"); }
});

document.querySelector(".app-header").addEventListener("click", async event => {
  const viewButton = event.target.closest("[data-view]");
  if (!viewButton) return;
  view = viewButton.dataset.view;
  location.hash = view;
  await render();
});

window.addEventListener("hashchange", () => { view = location.hash.replace("#", "") || "public"; render(); });
await render();

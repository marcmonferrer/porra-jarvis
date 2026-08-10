import {
  SPECIAL_CELLS,
  buildHistorySummary,
  calculatePrizes,
  finalReceivesRedistribution,
  formatDateTime,
  formatMoney,
  groupPrizeAwards,
  groupReservations,
  isSpecialCell,
  listCells,
  occupancyForCell,
  poolMetrics,
  resultCell,
  validateMatchUpdate,
  winningBetsText
} from "./core.js";
import { demoResetButtonMarkup, isDemoResetAvailable, preventAccidentalSubmit, resetDemoSafely, validatePoolBeforePublish } from "./demo-reset.js";
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
let historySummaryPoolId = null;
let adminMatchNotice = "";
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
    <div class="match-hero__top"><span class="status-pill status-${pool.status}">${statusLabel(pool.status)}</span><span>${formatDateTime(pool.matchAt)}</span></div>
    <h1>${escapeHtml(pool.title)}</h1>
    <div class="versus">${renderTeam(pool.homeTeam, pool.homeImage, "home")}<span>VS</span>${renderTeam(pool.awayTeam, pool.awayImage, "away")}</div>
    <p class="close-note">Participacions fins a ${formatDateTime(pool.closesAt)} · ${formatMoney(pool.priceCents)} per aposta</p>
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
  const readOnly = pool.status === "finished";
  const specials = pool.specials || SPECIAL_CELLS.map((cellKey, index) => ({ cellKey, title: `Especial ${index + 1}`, description: "" }));
  const localDate = value => {
    if (!value) return "";
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  return `<form class="pool-form" data-form="pool">
    <fieldset class="pool-form-fields" ${readOnly ? "disabled" : ""}>
    <input type="hidden" name="id" value="${escapeHtml(pool.id || "")}">
    <div class="form-grid">
      <label class="span-2">Títol<input required name="title" value="${escapeHtml(pool.title || "")}" placeholder="Nom de la porra"></label>
      <label>Equip local<input required name="homeTeam" value="${escapeHtml(pool.homeTeam || "")}" placeholder="Primer marcador"></label>
      <label>Equip visitant<input required name="awayTeam" value="${escapeHtml(pool.awayTeam || "")}" placeholder="Segon marcador"></label>
      <label>Imatge local (URL)<input name="homeImage" type="url" value="${escapeHtml(pool.homeImage || "")}" placeholder="https://…"></label>
      <label>Imatge visitant (URL)<input name="awayImage" type="url" value="${escapeHtml(pool.awayImage || "")}" placeholder="https://…"></label>
      <label>Data i hora del partit<input required name="matchAt" type="datetime-local" value="${localDate(pool.matchAt)}"><small class="date-preview" data-date-preview="matchAt">Previsualització: ${formatDateTime(pool.matchAt)}</small></label>
      <label>Tancament de participacions<input required name="closesAt" type="datetime-local" value="${localDate(pool.closesAt)}"><small class="date-preview" data-date-preview="closesAt">Previsualització: ${formatDateTime(pool.closesAt)}</small></label>
      <label>Preu per aposta (€)<input required name="price" type="number" step="0.01" min="0" value="${(pool.priceCents ?? 400) / 100}"></label>
      <label>Import al pot (€)<input required name="poolPerBet" type="number" step="0.01" min="0" value="${(pool.poolPerBetCents ?? 350) / 100}"></label>
      <label>Gestió (€)<input required name="fee" type="number" step="0.01" min="0" value="${(pool.feeCents ?? 50) / 100}"></label>
      <label>Pot acumulat anterior (€)<input name="carryover" type="number" step="0.01" min="0" value="${(pool.carryoverCents ?? 0) / 100}"></label>
      <label class="span-2">Instruccions de pagament<textarea required name="paymentInstructions" placeholder="Configura el destinatari i el concepte fora del codi">${escapeHtml(pool.paymentInstructions || "")}</textarea></label>
    </div>
    <fieldset><legend>Quatre apostes especials</legend><div class="special-form-grid">${specials.map((special, index) => `<div><strong>${special.cellKey}</strong><label>Nom<input required name="specialTitle${index}" value="${escapeHtml(special.title)}"></label><label>Condició<textarea name="specialDescription${index}">${escapeHtml(special.description || "")}</textarea></label></div>`).join("")}</div></fieldset>
    </fieldset>
    ${readOnly ? `<div class="notice read-only-note"><strong>Mode només lectura</strong><p>Aquesta porra està finalitzada i no es pot modificar.</p></div>` : `<button class="button primary" type="submit">${pool.id ? "Desar canvis" : "Crear esborrany"}</button>`}
  </form>`;
}

function adminPoolActions(pool) {
  const poolActions = pool ? `<button class="button primary" type="button" data-action="publish-pool" ${pool.status === "draft" ? "" : "disabled"}>Publicar</button><button class="button" type="button" data-action="toggle-pool" ${["open","closed"].includes(pool.status) ? "" : "disabled"}>${pool.status === "open" ? "Tancar participacions" : pool.status === "closed" ? "Reobrir" : "Estat bloquejat"}</button><button class="button secondary" type="button" data-view="public">Obrir vista pública</button>` : "";
  const resetAction = isDemoResetAvailable(repository) ? demoResetButtonMarkup() : "";
  return poolActions || resetAction ? `<div class="action-row">${poolActions}${resetAction}</div>` : "";
}

function clearDemoUiState() {
  currentPoolId = null;
  selectedCells = [];
  lastTrackingToken = "";
  historySummaryPoolId = null;
  adminMatchNotice = "";
  activeAdminTab = "pool";
  view = "admin";
  window.history.replaceState(null, "", `${location.pathname}#admin`);
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
  const historyStates = await Promise.all(pools.map(item => repository.getPoolState(item.id)));
  app.innerHTML = `<section class="admin-hero"><div><span class="eyebrow">Panell d’administració</span><h1>Gestiona Porra Live</h1><p>Crea porres, valida pagaments i publica els premis des d’un únic lloc.</p></div><div class="admin-session">${repository.mode === "demo" ? "Sessió demo" : escapeHtml(session.user.email)}${repository.mode === "demo" ? "" : `<button data-action="admin-logout">Sortir</button>`}</div></section>
    <div class="admin-tabs" role="tablist">
      <button data-admin-tab="pool" class="${activeAdminTab === "pool" ? "active" : ""}">1. Porra</button><button data-admin-tab="bets" class="${activeAdminTab === "bets" ? "active" : ""}" ${pool ? "" : "disabled"}>2. Apostes</button><button data-admin-tab="match" class="${activeAdminTab === "match" ? "active" : ""}" ${pool ? "" : "disabled"}>3. Directe</button><button data-admin-tab="prizes" class="${activeAdminTab === "prizes" ? "active" : ""}" ${pool ? "" : "disabled"}>4. Premis</button><button data-admin-tab="history" class="${activeAdminTab === "history" ? "active" : ""}">5. Historial</button>
    </div>
    <section class="panel admin-panel" data-admin-panel="pool" ${activeAdminTab === "pool" ? "" : "hidden"}><div class="section-heading"><div><span>Configuració</span><h2>${pool ? "Editar porra" : "Crear la primera porra"}</h2></div>${pool ? `<span class="status-pill status-${pool.status}">${statusLabel(pool.status)}</span>` : ""}</div>${poolForm(pool || {})}${adminPoolActions(pool)}</section>
    <section class="panel admin-panel" data-admin-panel="bets" ${activeAdminTab === "bets" ? "" : "hidden"}>${state ? adminBetsMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="match" ${activeAdminTab === "match" ? "" : "hidden"}>${state ? adminMatchMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="prizes" ${activeAdminTab === "prizes" ? "" : "hidden"}>${state ? adminPrizesMarkup(state) : ""}</section>
    <section class="panel admin-panel" data-admin-panel="history" ${activeAdminTab === "history" ? "" : "hidden"}>${historyMarkup(historyStates)}</section>`;
}

function adminBetsMarkup(state) {
  const readOnly = state.pool.status === "finished";
  const reservations = groupReservations(state);
  const pendingReservations = reservations.filter(item => item.paymentStatus === "pending").length;
  const paidReservations = reservations.filter(item => item.paymentStatus === "paid").length;
  const cards = reservations.map(reservation => {
    const selections = reservation.bets.map((bet, index) => {
      const options = listCells().map(cell => `<option value="${cell}" ${cell === bet.cellKey ? "selected" : ""}>${escapeHtml(cellLabel(state.pool, cell))}</option>`).join("");
      return `<label>Selecció ${index + 1}<select name="bet-${bet.id}" data-reservation-bet="${bet.id}" ${readOnly ? "disabled" : ""}>${options}</select></label>`;
    }).join("");
    return `<form class="reservation-card" data-form="reservation" data-participant-id="${reservation.participantId}">
      <div class="reservation-card__heading"><label>Nom<input name="participantName" value="${escapeHtml(reservation.name)}" ${readOnly ? "disabled" : ""}></label><div><strong>${formatMoney(reservation.totalCents)}</strong><span class="payment-status ${reservation.paymentStatus}">${paymentLabel(reservation.paymentStatus)}</span></div></div>
      <div class="reservation-selections">${selections}</div>
      <div class="reservation-actions">${readOnly ? `<span class="saved-indicator">Només lectura</span>` : `<button class="button small" type="submit">Desar canvis</button>${reservation.paymentStatus === "paid" ? "" : `<button class="button small primary" type="button" data-pay-reservation="${reservation.participantId}">Confirmar pagament</button>`}<button class="button small danger" type="button" data-release-reservation="${reservation.participantId}" data-paid="${reservation.paymentStatus === "paid"}">Alliberar reserva</button>`}</div>
    </form>`;
  }).join("");
  return `<div class="section-heading"><div><span>Pagaments i reserves</span><h2>${pendingReservations} ${pendingReservations === 1 ? "reserva pendent" : "reserves pendents"} · ${paidReservations} ${paidReservations === 1 ? "reserva pagada" : "reserves pagades"}</h2></div><strong>${state.metrics.freePlaces} places lliures</strong></div>${metricsMarkup(state.metrics)}${cards ? `<div class="reservation-list">${cards}</div>` : `<div class="empty-inline">Encara no hi ha cap reserva.</div>`}`;
}

function scoreInput(name, label, value, nullable = false, max = 99) {
  return `<label>${label}<input name="${name}" type="number" min="0" max="${max}" ${nullable ? "" : "required"} value="${value ?? ""}"></label>`;
}

function adminMatchMarkup(state) {
  const { pool, match } = state;
  const readOnly = pool.status === "finished";
  return `<div class="section-heading"><div><span>Control manual</span><h2>${escapeHtml(matchName(pool))}</h2></div><span>El proveïdor automàtic és opcional</span></div>${adminMatchNotice ? `<div class="warning"><strong>Revisió del directe</strong><p>${escapeHtml(adminMatchNotice)}</p></div>` : ""}<form data-form="match" class="match-form"><fieldset class="match-form-fields" ${readOnly ? "disabled" : ""}>
    <label>Fase<select name="phase">${[["pre","Prepartit"],["first","Primera part"],["half","Descans"],["second","Segona part"],["final","Final"]].map(([value,label]) => `<option value="${value}" ${match.phase === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    ${scoreInput("minute", "Minut", match.minute, false, 150)}
    <fieldset><legend>Marcador actual</legend>${scoreInput("currentHome", pool.homeTeam, match.currentHome)}${scoreInput("currentAway", pool.awayTeam, match.currentAway)}</fieldset>
    <fieldset><legend>Resultat exacte al descans</legend>${scoreInput("halfHome", pool.homeTeam, match.halfHome, true)}${scoreInput("halfAway", pool.awayTeam, match.halfAway, true)}</fieldset>
    <fieldset><legend>Resultat exacte final</legend>${scoreInput("finalHome", pool.homeTeam, match.finalHome, true)}${scoreInput("finalAway", pool.awayTeam, match.finalAway, true)}</fieldset>
    <fieldset class="special-statuses"><legend>Estat dels especials</legend>${pool.specials.map(item => `<label>${escapeHtml(item.title)}<select name="special-${item.cellKey}">${[["pending","Pendent"],["completed","Completada"],["failed","No completada"]].map(([value,label]) => `<option value="${value}" ${match.specialStatuses?.[item.cellKey] === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`).join("")}</fieldset>
    </fieldset>${readOnly ? `<span class="saved-indicator">Porra finalitzada · només lectura</span>` : `<button class="button primary" type="submit">Actualitzar directe</button>`}
  </form>`;
}

function prizePreview(state) {
  try {
    return calculatePrizes({ pool: state.pool, bets: state.bets, match: state.match });
  } catch {
    return null;
  }
}

function awardCentsFor(preview, category) {
  return (preview?.awards || []).reduce((total, award) => total + (award.breakdown || [])
    .filter(item => item.category === category)
    .reduce((sum, item) => sum + item.cents, 0), 0);
}

function awardParticipantsFor(state, preview, category) {
  const participantIds = new Set((preview?.awards || [])
    .filter(award => award.breakdown?.some(item => item.category === category))
    .map(award => state.bets.find(bet => bet.id === award.betId)?.participantId)
    .filter(Boolean));
  return [...participantIds].map(id => state.participants.find(person => person.id === id)?.name || "Participant");
}

function categoryPrizeMarkup(state, preview) {
  const halfCell = state.match.halfHome == null ? "Per definir" : cellLabel(state.pool, resultCell(state.match.halfHome, state.match.halfAway));
  const finalCell = state.match.finalHome == null ? "Per definir" : cellLabel(state.pool, resultCell(state.match.finalHome, state.match.finalAway));
  const completedSpecials = state.pool.specials.filter(item => state.match.specialStatuses?.[item.cellKey] === "completed").map(item => item.title);
  const finalCategory = preview?.winners?.final?.length ? "final" : "final-redistribution";
  const categories = [
    { key: "half", title: "Descans · 25%", condition: halfCell, winners: preview?.winners?.half?.length || 0 },
    { key: "final", awardKey: finalCategory, title: `Final · 50%${finalReceivesRedistribution(preview) ? " + redistribució" : ""}`, condition: preview?.winners?.final?.length ? finalCell : "Franja redistribuïda", winners: preview?.winners?.final?.length || 0 },
    { key: "special", title: "Especials · 25%", condition: completedSpecials.join(" · ") || "Cap condició completada", winners: preview?.winners?.special?.length || 0 }
  ];
  return categories.map(category => {
    const awardKey = category.awardKey || category.key;
    const participants = awardParticipantsFor(state, preview, awardKey);
    return `<article><span>${category.title}</span><strong>${formatMoney(awardCentsFor(preview, awardKey))}</strong><small>${winningBetsText(category.winners)}</small><dl><div><dt>Aposta o condició</dt><dd>${escapeHtml(category.condition)}</dd></div><div><dt>Participants</dt><dd>${participants.length ? participants.map(escapeHtml).join(" · ") : "Sense guanyadors"}</dd></div></dl></article>`;
  }).join("");
}

function participantPrizeMarkup(state, preview) {
  const labels = { half: "Descans", final: "Final", special: "Especial", "final-redistribution": "Redistribució final" };
  const summaries = groupPrizeAwards({ awards: preview?.awards, bets: state.bets, participants: state.participants });
  if (!summaries.length) return `<div class="empty-inline">Sense apostes guanyadores: el pot queda acumulat.</div>`;
  return `<section class="participant-prizes"><div class="section-heading"><div><span>Pagaments finals</span><h3>Resum per participació</h3></div></div>${summaries.map(summary => `<article><div><strong>${escapeHtml(summary.name)}</strong><b>${formatMoney(summary.totalCents)}</b></div><p>${Object.entries(summary.breakdown).map(([category, cents]) => `${labels[category] || category}: ${formatMoney(cents)}`).join(" · ")}</p></article>`).join("")}</section>`;
}

function adminPrizesMarkup(state) {
  const preview = state.prizeResult || prizePreview(state);
  const pendingWarning = state.metrics.pendingPlaces > 0 ? `<div class="warning"><strong>No es pot finalitzar</strong><p>Queden ${state.metrics.pendingPlaces} apostes pendents. Confirma-les o allibera-les.</p></div>` : "";
  const finalized = state.pool.status === "finished";
  return `<div class="section-heading"><div><span>${finalized ? "Resum definitiu" : "Revisió abans de publicar"}</span><h2>Resultats i premis</h2></div><strong>${formatMoney(preview?.totalPotCents || 0)}</strong></div>${pendingWarning}
    <div class="prize-split">${categoryPrizeMarkup(state, preview)}</div>
    ${participantPrizeMarkup(state, preview)}
    ${finalized ? `<div class="notice read-only-note"><strong>Premis publicats</strong><p>Aquesta porra està finalitzada i el resum és només de lectura.</p></div>` : `<div class="review-check"><label><input type="checkbox" data-prize-review> He revisat el marcador, els especials, els pagaments i els imports.</label><button class="button primary" data-action="finalize-pool" disabled>Publicar premis definitius</button></div>`}`;
}

function historyDetailMarkup(state) {
  const summary = buildHistorySummary(state);
  const preview = state.prizeResult || prizePreview(state);
  const specials = state.pool.specials.map(item => `${item.title}: ${({ pending: "Pendent", completed: "Completada", failed: "No completada" })[state.match.specialStatuses?.[item.cellKey]] || "Pendent"}`).join(" · ");
  return `<section class="history-detail"><div class="section-heading"><div><span>Resum històric · només lectura</span><h3>${escapeHtml(state.pool.title)}</h3></div><span class="status-pill status-${state.pool.status}">${statusLabel(state.pool.status)}</span></div>
    <div class="history-metrics"><article><span>Resultat al descans</span><strong>${state.match.halfHome == null ? "—" : `${state.match.halfHome}–${state.match.halfAway}`}</strong></article><article><span>Resultat final</span><strong>${state.match.finalHome == null ? "—" : `${state.match.finalHome}–${state.match.finalAway}`}</strong></article><article><span>Pot final</span><strong>${formatMoney(summary.finalPotCents)}</strong></article><article><span>Total pagat</span><strong>${formatMoney(summary.distributedCents)}</strong></article><article><span>Acumulat</span><strong>${formatMoney(summary.carryoverCents)}</strong></article></div>
    <div class="history-section"><strong>Especials</strong><p>${escapeHtml(specials)}</p></div>
    <div class="history-section"><strong>Guanyadors i desglossament</strong>${participantPrizeMarkup(state, preview)}</div>
  </section>`;
}

function historyMarkup(states) {
  const sorted = [...states].sort((a, b) => b.pool.createdAt.localeCompare(a.pool.createdAt));
  const selected = sorted.find(state => state.pool.id === historySummaryPoolId);
  const editionText = `${sorted.length} ${sorted.length === 1 ? "edició" : "edicions"}`;
  return `<div class="section-heading"><div><span>Totes les edicions</span><h2>Historial de porres</h2></div><strong>${editionText}</strong></div>${sorted.length ? `<div class="history-list">${sorted.map(state => {
    const summary = buildHistorySummary(state);
    return `<article><span class="status-pill status-${state.pool.status}">${statusLabel(state.pool.status)}</span><div><strong>${escapeHtml(state.pool.title)}</strong><p>${escapeHtml(matchName(state.pool))} · ${formatDateTime(state.pool.matchAt)}</p><small>${summary.paidCount} ${summary.paidCount === 1 ? "aposta pagada" : "apostes pagades"} · Pot final ${formatMoney(summary.finalPotCents)} · Repartit ${formatMoney(summary.distributedCents)} · Acumulat ${formatMoney(summary.carryoverCents)}</small></div><button class="button small" data-history-pool="${state.pool.id}">Veure resum</button></article>`;
  }).join("")}</div>${selected ? historyDetailMarkup(selected) : ""}` : `<div class="empty-inline">Encara no hi ha historial.</div>`}`;
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
  if (event.target.closest("[data-action='reset-demo']")) {
    preventAccidentalSubmit(event);
    await resetDemoSafely({
      repository,
      confirmReset: message => window.confirm(message),
      clearActiveState: clearDemoUiState,
      reloadAdmin: renderAdmin,
      notify
    });
    return;
  }
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
    const message = `${pool.pool.title}\n${matchName(pool.pool)}\nPartit: ${formatDateTime(pool.pool.matchAt)}\nTancament: ${formatDateTime(pool.pool.closesAt)}\nParticipa a Porra Live: ${location.origin}${location.pathname}?pool=${pool.pool.slug}`;
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
    const form = app.querySelector("[data-form='pool']");
    if (!validatePoolBeforePublish(form)) return;
    await repository.publishPool(currentPoolId); notify("Porra publicada i oberta."); await renderAdmin();
  }
  if (event.target.closest("[data-action='toggle-pool']")) {
    const state = await repository.getPoolState(currentPoolId);
    await repository.setPoolStatus(currentPoolId, state.pool.status === "open" ? "closed" : "open");
    notify(state.pool.status === "open" ? "Participacions reobertes." : "Participacions tancades."); await renderAdmin();
  }
  const pay = event.target.closest("[data-pay-reservation]");
  if (pay) {
    await repository.updateReservationPayment(pay.dataset.payReservation, "paid");
    notify("Pagament de tota la reserva confirmat.");
    await renderAdmin();
  }
  const release = event.target.closest("[data-release-reservation]");
  if (release) {
    if (release.dataset.paid === "true" && !window.confirm("Aquesta reserva està pagada. Vols alliberar-la igualment?")) return;
    await repository.updateReservationPayment(release.dataset.releaseReservation, "released");
    notify("Reserva alliberada.");
    await renderAdmin();
  }
  const poolButton = event.target.closest("[data-pool]");
  if (poolButton) { currentPoolId = poolButton.dataset.pool; await renderAdmin(); }
  const historyButton = event.target.closest("[data-history-pool]");
  if (historyButton) { historySummaryPoolId = historyButton.dataset.historyPool; await renderAdmin(); }
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

app.addEventListener("input", event => {
  const dateInput = event.target.closest("input[type='datetime-local']");
  if (!dateInput) return;
  const preview = app.querySelector(`[data-date-preview='${dateInput.name}']`);
  if (preview) preview.textContent = `Previsualització: ${formatDateTime(dateInput.value)}`;
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
    if (form.dataset.form === "reservation") {
      const data = new FormData(form);
      const bets = [...form.querySelectorAll("[data-reservation-bet]")].map(select => ({ id: select.dataset.reservationBet, cellKey: select.value }));
      await repository.updateReservation(form.dataset.participantId, { name: data.get("participantName"), bets });
      notify("Canvis desats.");
      await renderAdmin();
    }
    if (form.dataset.form === "match") {
      const data = new FormData(form);
      const nullable = key => data.get(key) === "" ? null : Number(data.get(key));
      const state = await repository.getPoolState(currentPoolId);
      const validation = validateMatchUpdate({ match: {
        phase: data.get("phase"), minute: Number(data.get("minute")), currentHome: Number(data.get("currentHome")), currentAway: Number(data.get("currentAway")),
        halfHome: nullable("halfHome"), halfAway: nullable("halfAway"), finalHome: nullable("finalHome"), finalAway: nullable("finalAway"),
        specialStatuses: Object.fromEntries(SPECIAL_CELLS.map(key => [key, data.get(`special-${key}`)]))
      }, pendingPlaces: state.metrics.pendingPlaces });
      if (!validation.valid) throw new Error(validation.errors.join(" "));
      await repository.updateMatch(currentPoolId, validation.match);
      adminMatchNotice = validation.warnings.join(" ");
      notify("Canvis desats");
      await renderAdmin();
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

(() => {
  "use strict";

  const SUPABASE_URL = window.PORRA_LIVE_CONFIG?.supabaseUrl;
  const SUPABASE_PUBLISHABLE_KEY = window.PORRA_LIVE_CONFIG?.supabasePublishableKey;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  const ENTRY_PRICE = 4.5;
  const POOL_PER_ENTRY = 4;
  const DEVELOPER_FEE = 0.5;
  const ENTRY_CLOSES_AT = new Date("2026-07-19T20:45:00+02:00");
  const SPECIAL_BETS = {
    "4-4": { short: "Messi ×3", label: "Hat-trick de Messi" },
    "3-4": { short: "Lamine ×2", label: "Doblet de Lamine" },
    "4-3": { short: "+6 gols", label: "Més de 6 gols totals" }
  };

  const defaultState = {
    entries: [],
    match: {
      phase: "pre",
      minute: 0,
      spain: 0,
      argentina: 0,
      halfScore: null,
      regulationScore: null,
      messiHatTrick: false,
      lamineBrace: false,
      moreThanSixGoals: false
    }
  };

  let state = { entries: [], match: JSON.parse(JSON.stringify(defaultState.match)) };
  let selected = [];
  let isAdmin = false;

  const grid = document.querySelector("[data-grid]");
  const nameInput = document.querySelector("#participant-name");
  const assignButton = document.querySelector("[data-action='assign']");
  const selectionText = document.querySelector("[data-selection]");
  const feedback = document.querySelector("[data-feedback]");
  const roster = document.querySelector("[data-roster]");
  const rosterWrap = document.querySelector("[data-roster-wrap]");
  const phaseSelect = document.querySelector("#match-phase");
  const minuteInput = document.querySelector("#match-minute");
  const adminLoginPanel = document.querySelector("[data-admin-login]");
  const adminControls = document.querySelector("[data-admin-controls]");
  const adminEmailInput = document.querySelector("#admin-email");
  const adminPasswordInput = document.querySelector("#admin-password");
  const adminLoginButton = document.querySelector("[data-action='admin-login']");
  const authFeedback = document.querySelector("[data-auth-feedback]");

  function setAuthFeedback(message, isError = false) {
    authFeedback.textContent = message;
    authFeedback.classList.toggle("is-error", isError);
  }

  function applyAdminSession(session) {
    isAdmin = session?.user?.app_metadata?.porra_admin === true;
    adminLoginPanel.hidden = isAdmin;
    adminControls.hidden = !isAdmin;
    if (!isAdmin) {
      adminControls.open = false;
    }
    renderRoster();
  }

  async function loginAdmin() {
    const email = adminEmailInput.value.trim();
    const password = adminPasswordInput.value;

    if (!email || !password) {
      setAuthFeedback("Escriu el correu i la contrasenya.", true);
      return;
    }

    adminLoginButton.disabled = true;
    setAuthFeedback("Comprovant les dades…");
    const { error } = await db.auth.signInWithPassword({ email, password });
    adminLoginButton.disabled = false;

    if (error) {
      setAuthFeedback("El correu o la contrasenya no són correctes.", true);
      return;
    }

    adminPasswordInput.value = "";
    setAuthFeedback("");
  }

  async function logoutAdmin() {
    const { error } = await db.auth.signOut();
    if (error) {
      setFeedback("No s'ha pogut tancar la sessió.", true);
    }
  }

  async function loadRemoteEntries() {
    const { data, error } = await db
      .from("caselles")
      .select("id, nom, espanya, argentina, pagat, created_at")
      .order("created_at", { ascending: true });

    if (error) {
      setFeedback("No s'han pogut carregar les caselles. Torna-ho a provar.", true);
      return;
    }

    const grouped = new Map();
    for (const row of data) {
      const groupKey = row.nom.trim().toLocaleLowerCase("ca");
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          id: `db-${row.id}`,
          name: row.nom,
          scores: [],
          paid: true,
          rowIds: []
        });
      }
      const entry = grouped.get(groupKey);
      entry.scores.push(scoreKey(row.espanya, row.argentina));
      entry.rowIds.push(row.id);
      entry.paid = entry.paid && row.pagat === true;
    }

    state.entries = [...grouped.values()];
    selected = selected.filter(key => !ownerOf(key));
    render();
  }

  function subscribeToEntries() {
    db.channel("caselles-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "caselles" },
        () => loadRemoteEntries()
      )
      .subscribe();
  }

  async function loadRemoteMatch() {
    let { data, error } = await db
      .from("partit")
      .select("id, fase, minut, espanya, argentina, espanya_mitja, argentina_mitja, espanya_90, argentina_90, messi_hat_trick, lamine_doblet, mes_de_sis_gols, provider_status")
      .eq("id", 1)
      .single();

    // Manté la web operativa mentre s'aplica la migració amb els camps nous.
    if (error) {
      ({ data, error } = await db
        .from("partit")
        .select("id, fase, minut, espanya, argentina, espanya_mitja, argentina_mitja, messi_hat_trick, lamine_doblet, provider_status")
        .eq("id", 1)
        .single());
    }

    if (error) {
      setFeedback("El marcador en directe encara no està disponible.", true);
      return;
    }

    state.match = {
      phase: data.fase,
      minute: data.minut,
      spain: data.espanya,
      argentina: data.argentina,
      halfScore: data.espanya_mitja === null || data.argentina_mitja === null
        ? null
        : { spain: data.espanya_mitja, argentina: data.argentina_mitja },
      regulationScore: data.espanya_90 == null || data.argentina_90 == null
        ? null
        : { spain: data.espanya_90, argentina: data.argentina_90 },
      messiHatTrick: data.messi_hat_trick === true,
      lamineBrace: data.lamine_doblet === true,
      moreThanSixGoals: data.mes_de_sis_gols === true,
      providerStatus: data.provider_status
    };
    render();
  }

  function subscribeToMatch() {
    db.channel("partit-live")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "partit", filter: "id=eq.1" },
        () => loadRemoteMatch()
      )
      .subscribe();
  }

  async function updateRemoteMatch(patch) {
    if (!isAdmin) return false;
    const { error } = await db
      .from("partit")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", 1);

    if (error) {
      setFeedback("No s'ha pogut actualitzar el marcador.", true);
      return false;
    }

    return true;
  }

  function scoreKey(spain, argentina) {
    return `${spain}-${argentina}`;
  }

  function isEntriesClosed() {
    return Date.now() >= ENTRY_CLOSES_AT.getTime();
  }

  function isSpecialBet(key) {
    return Boolean(SPECIAL_BETS[key]);
  }

  function scoreResult(key) {
    return key.replace("-", "–");
  }

  function shortScore(key) {
    return SPECIAL_BETS[key]?.short || scoreResult(key);
  }

  function longScore(key) {
    if (SPECIAL_BETS[key]) return SPECIAL_BETS[key].label;
    const [spain, argentina] = key.split("-");
    return `Espanya ${spain}–${argentina} Argentina`;
  }

  function ownerOf(key) {
    return state.entries.find(entry => entry.scores.includes(key));
  }

  function achievedSpecialKeys() {
    const keys = [];
    if (state.match.messiHatTrick) keys.push("4-4");
    if (state.match.lamineBrace) keys.push("3-4");
    if (state.match.moreThanSixGoals) keys.push("4-3");
    return keys;
  }

  function winningKeys() {
    const keys = [];
    if (state.match.halfScore) {
      const halfKey = scoreKey(state.match.halfScore.spain, state.match.halfScore.argentina);
      if (!isSpecialBet(halfKey)) keys.push(halfKey);
    }
    const finalScore = state.match.regulationScore
      || (state.match.phase === "final"
        ? { spain: state.match.spain, argentina: state.match.argentina }
        : null);
    if (finalScore) {
      const finalKey = scoreKey(finalScore.spain, finalScore.argentina);
      if (!isSpecialBet(finalKey)) keys.push(finalKey);
    }
    return [...new Set([...keys, ...achievedSpecialKeys()])];
  }

  function allScores() {
    return Array.from({ length: 25 }, (_, index) => {
      const argentina = Math.floor(index / 5);
      const spain = index % 5;
      return scoreKey(spain, argentina);
    });
  }

  function renderGrid() {
    grid.replaceChildren();
    const corner = document.createElement("div");
    corner.className = "grid-corner";
    corner.innerHTML = "<span>🇪🇸 X →</span><span>🇦🇷 Y ↓</span>";
    grid.appendChild(corner);

    for (let spain = 0; spain <= 4; spain += 1) {
      const axis = document.createElement("div");
      axis.className = "axis";
      axis.textContent = String(spain);
      axis.setAttribute("aria-label", `Espanya ${spain}`);
      grid.appendChild(axis);
    }

    const winners = winningKeys();
    const entriesClosed = isEntriesClosed();
    for (let argentina = 0; argentina <= 4; argentina += 1) {
      const axis = document.createElement("div");
      axis.className = "axis";
      axis.textContent = String(argentina);
      axis.setAttribute("aria-label", `Argentina ${argentina}`);
      grid.appendChild(axis);

      for (let spain = 0; spain <= 4; spain += 1) {
        const key = scoreKey(spain, argentina);
        const owner = ownerOf(key);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "score-cell";
        button.dataset.score = key;
        button.textContent = shortScore(key);
        button.setAttribute("aria-label", longScore(key));
        button.setAttribute("aria-pressed", selected.includes(key) ? "true" : "false");
        if (isSpecialBet(key)) button.classList.add("is-special");
        if (selected.includes(key)) button.classList.add("is-picked");
        if (owner) {
          button.classList.add("is-occupied");
          button.disabled = true;
          button.title = owner.name;
          button.setAttribute("aria-label", `${longScore(key)}, ocupada per ${owner.name}`);
        } else if (entriesClosed) {
          button.disabled = true;
          button.title = "La porra està tancada";
        }
        if (winners.includes(key)) button.classList.add("is-winner");
        grid.appendChild(button);
      }
    }
  }

  function renderStats() {
    const occupied = state.entries.reduce((sum, entry) => sum + entry.scores.length, 0);
    const paidEntries = state.entries.filter(entry => entry.paid);
    const paidCells = paidEntries.reduce((sum, entry) => sum + entry.scores.length, 0);
    const totalOwed = occupied * ENTRY_PRICE;
    const collected = paidCells * ENTRY_PRICE;

    document.querySelector("[data-stat='occupied']").textContent = `${occupied} / 25`;
    document.querySelector("[data-stat='final-prize']").textContent = money(occupied * POOL_PER_ENTRY * .50);
    document.querySelector("[data-stat='half-prize']").textContent = money(occupied * POOL_PER_ENTRY * .25);
    document.querySelector("[data-stat='special-prize']").textContent = money(occupied * POOL_PER_ENTRY * .25);
    const entriesClosed = isEntriesClosed();
    document.querySelector("[data-available]").textContent = entriesClosed
      ? "Porra tancada"
      : `${25 - occupied} lliures`;
    document.querySelector("[data-money='collected']").textContent = money(collected);
    document.querySelector("[data-money='pending']").textContent = money(totalOwed - collected);
    document.querySelector("[data-money='developer']").textContent = money(occupied * DEVELOPER_FEE);
    document.querySelector("[data-paid-summary]").textContent = `${paidEntries.length}/${state.entries.length} pagats`;

    if (entriesClosed) {
      selectionText.textContent = "🔒 La porra està tancada des de les 20:45.";
    } else if (selected.length === 0) {
      selectionText.textContent = "Escriu un nom i tria fins a 2 caselles.";
    } else {
      selectionText.textContent = `${selected.map(longScore).join(" · ")} · ${money(selected.length * ENTRY_PRICE)}`;
    }
    nameInput.disabled = entriesClosed;
    assignButton.disabled = entriesClosed || !nameInput.value.trim() || selected.length === 0;
  }

  function renderRoster() {
    roster.replaceChildren();
    rosterWrap.hidden = state.entries.length === 0;
    state.entries.forEach(entry => {
      const row = document.createElement("div");
      row.className = "person-row";

      const name = document.createElement("strong");
      name.textContent = entry.name;

      const scores = document.createElement("span");
      scores.className = "person-row__scores";
      scores.textContent = `${entry.scores.map(shortScore).join(" · ")} · ${money(entry.scores.length * ENTRY_PRICE)}`;

      const paidLabel = document.createElement("label");
      paidLabel.className = "paid-check";
      const paid = document.createElement("input");
      paid.type = "checkbox";
      paid.checked = entry.paid;
      paid.dataset.paid = entry.id;
      paidLabel.append(paid, document.createTextNode("Pagat"));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-button";
      remove.dataset.remove = entry.id;
      remove.textContent = "Treure";

      if (isAdmin) {
        row.append(name, scores, paidLabel, remove);
      } else {
        const paymentStatus = document.createElement("span");
        paymentStatus.className = `payment-status ${entry.paid ? "is-paid" : ""}`;
        paymentStatus.textContent = entry.paid ? "✅ Pagat" : "⏳ Pendent";
        row.append(name, scores, paymentStatus);
      }
      roster.appendChild(row);
    });
  }

  function renderScoreboard() {
    const { phase, minute, spain, argentina, halfScore, regulationScore, providerStatus } = state.match;
    const regulationKey = regulationScore
      ? scoreKey(regulationScore.spain, regulationScore.argentina)
      : scoreKey(spain, argentina);
    const isExtraTime = ["ET", "BT"].includes(providerStatus);
    const isPenaltyShootout = providerStatus === "P";
    const finishedAfterExtraTime = ["AET", "PEN"].includes(providerStatus);
    const phases = {
      pre: ["PREPARTIT", "—", "El partit encara no ha començat"],
      first: ["EN DIRECTE", `${minute}′`, "Primera part"],
      half: ["MITJA PART", "45′", winnerNote(scoreKey(spain, argentina), "Guanyador provisional")],
      second: isPenaltyShootout
        ? ["PENALS", "—", winnerNote(regulationKey, "Guanyador dels 90 minuts")]
        : isExtraTime
          ? ["PRÒRROGA", `${minute}′`, winnerNote(regulationKey, "Guanyador dels 90 minuts")]
          : ["EN DIRECTE", `${minute}′`, halfScore ? `Mitja part: ${halfScore.spain}–${halfScore.argentina}` : "Segona part"],
      final: ["FINAL", finishedAfterExtraTime ? "120′" : "90′", winnerNote(regulationKey, "Guanyador dels 90 minuts")]
    };
    const [label, clock, note] = phases[phase];
    document.querySelector("[data-live-label]").textContent = label;
    document.querySelector("[data-clock]").textContent = clock;
    document.querySelector("[data-match-note]").textContent = note;
    document.querySelector("[data-live-indicator]").classList.toggle("is-live", phase === "first" || phase === "second");
    document.querySelector("[data-score='spain']").textContent = spain;
    document.querySelector("[data-score='argentina']").textContent = argentina;
    document.querySelector("[data-admin-score='spain']").textContent = spain;
    document.querySelector("[data-admin-score='argentina']").textContent = argentina;
    phaseSelect.value = phase;
    minuteInput.value = minute;
    document.querySelectorAll("[data-special-result]").forEach(input => {
      input.checked = Boolean(state.match[input.dataset.specialResult]);
    });
  }

  function winnerNote(key, prefix) {
    if (isSpecialBet(key)) {
      return `${scoreResult(key)} · marcador substituït per una aposta especial`;
    }
    const owner = ownerOf(key);
    return owner ? `${prefix}: ${owner.name} (${scoreResult(key)})` : `${scoreResult(key)} · casella sense propietari`;
  }

  function render() {
    renderGrid();
    renderStats();
    renderRoster();
    renderScoreboard();
  }

  function money(value) {
    return value.toLocaleString("ca-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }

  function setFeedback(message, isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle("is-error", isError);
  }

  async function assignEntry() {
    if (isEntriesClosed()) {
      selected = [];
      renderGrid();
      renderStats();
      setFeedback("La porra està tancada des de les 20:45.", true);
      return;
    }

    const name = nameInput.value.trim();
    if (!name || selected.length === 0) return;
    if (state.entries.some(entry => entry.name.toLocaleLowerCase("ca") === name.toLocaleLowerCase("ca"))) {
      setFeedback("Aquest nom ja té caselles assignades.", true);
      return;
    }

    assignButton.disabled = true;
    setFeedback("Reservant caselles…");
    const rows = selected.map(key => {
      const [spain, argentina] = key.split("-").map(Number);
      return { nom: name, espanya: spain, argentina, pagat: false };
    });
    const { error } = await db.from("caselles").insert(rows);

    if (error) {
      setFeedback(
        error.code === "23505"
          ? "Una d'aquestes caselles acaba de ser ocupada. Tria'n una altra."
          : "No s'ha pogut fer la reserva. Torna-ho a provar.",
        true
      );
      await loadRemoteEntries();
      return;
    }

    selected = [];
    nameInput.value = "";
    await loadRemoteEntries();
    setFeedback(`${name} ha quedat apuntat/da. Falta confirmar el Bizum.`);
  }

  function inviteMessage() {
    const free = allScores().filter(key => !ownerOf(key));
    return [
      "🏆 FINALÍSSIMA",
      "ESPAÑA 🇪🇸 · ARGENTINA 🇦🇷",
      "",
      "Això passa molt poques vegades a la vida! Per fer la FINALÍSSIMA encara més interessant, he creat una porra interactiva.",
      "",
      "📋 NORMES",
      "💶 4,50 € per casella (se'n juguen 4 €)",
      "✌️ Màxim 2 entrades per persona",
      "🔒 La porra es tanca a les 20:45",
      "📐 Espanya = X · Argentina = Y · Resultat: X–Y",
      "🎁 Especials: hat-trick de Messi · doblet de Lamine · més de 6 gols",
      "⏱️ 25% per al marcador de la mitja part, sempre",
      "🏆 50% per al marcador final, sempre",
      "✨ 25% per a les especials encertades; si no n'hi ha cap, s'afegeix al premi final",
      "🧑‍💻 0,50 € per casella per al developer de l'app",
      "📲 Pagament: consulta les instruccions configurades per l'administrador.",
      "",
      `Caselles disponibles: ${free.map(shortScore).join(", ") || "cap"}`,
      "",
      "Si l'àrbitre la lia, no me'n faig responsable 😂"
    ].join("\n");
  }

  function statusMessage() {
    const occupied = state.entries.reduce((sum, entry) => sum + entry.scores.length, 0);
    const lines = state.entries.length
      ? state.entries.map(entry => `${entry.paid ? "✅" : "⏳"} ${entry.name}: ${entry.scores.map(shortScore).join(", ")}`)
      : ["Encara no hi ha cap casella ocupada."];
    return [
      "⚽ ESTAT DE LA PORRA ESPAÑA–ARGENTINA",
      "",
      ...lines,
      "",
      `Final garantit (50%): ${money(occupied * POOL_PER_ENTRY * .50)}`,
      `Mitja part (25%): ${money(occupied * POOL_PER_ENTRY * .25)}`,
      `Especials o bonus final (25%): ${money(occupied * POOL_PER_ENTRY * .25)}`,
      `Developer: ${money(occupied * DEVELOPER_FEE)}`
    ].join("\n");
  }

  function matchUpdateMessage() {
    const { phase, minute, spain, argentina, halfScore, regulationScore, providerStatus } = state.match;
    const phaseLabels = {
      pre: "PREPARTIT",
      first: `PRIMERA PART · MINUT ${minute}`,
      half: "MITJA PART",
      second: providerStatus === "P"
        ? "TANDA DE PENALS"
        : ["ET", "BT"].includes(providerStatus)
          ? `PRÒRROGA · MINUT ${minute}`
          : `SEGONA PART · MINUT ${minute}`,
      final: "FINAL"
    };
    const key = scoreKey(spain, argentina);
    const owner = isSpecialBet(key) ? null : ownerOf(key);
    const lines = [
      "⚽ ACTUALITZACIÓ FINALÍSSIMA",
      `${phaseLabels[phase] || "PARTIT"}`,
      "",
      `🇪🇸 ESPAÑA ${spain}–${argentina} ARGENTINA 🇦🇷`,
      "",
      owner
        ? `🎯 Ara mateix la casella guanyadora és la de ${owner.name} (${scoreResult(key)}).`
        : isSpecialBet(key)
          ? `👀 El ${scoreResult(key)} s'ha substituït per una aposta especial.`
          : `👀 El ${scoreResult(key)} no té propietari.`
    ];

    if (halfScore && phase !== "half") {
      const halfKey = scoreKey(halfScore.spain, halfScore.argentina);
      const halfOwner = isSpecialBet(halfKey) ? null : ownerOf(halfKey);
      lines.push(
        halfOwner
          ? `⏱️ Mitja part: ${scoreResult(halfKey)} · ${halfOwner.name}.`
          : isSpecialBet(halfKey)
            ? `⏱️ Mitja part: ${scoreResult(halfKey)} · marcador substituït per una aposta especial.`
            : `⏱️ Mitja part: ${scoreResult(halfKey)} · casella sense propietari.`
      );
    }

    if (regulationScore) {
      const regulationKey = scoreKey(regulationScore.spain, regulationScore.argentina);
      const regulationOwner = isSpecialBet(regulationKey) ? null : ownerOf(regulationKey);
      lines.push(
        regulationOwner
          ? `🏁 90 minuts: ${scoreResult(regulationKey)} · ${regulationOwner.name}.`
          : isSpecialBet(regulationKey)
            ? `🏁 90 minuts: ${scoreResult(regulationKey)} · marcador substituït per una aposta especial.`
            : `🏁 90 minuts: ${scoreResult(regulationKey)} · casella sense propietari.`
      );
    }

    const specialLines = achievedSpecialKeys().map(specialKey => {
      const specialOwner = ownerOf(specialKey);
      return specialOwner
        ? `${SPECIAL_BETS[specialKey].label}: ${specialOwner.name}`
        : `${SPECIAL_BETS[specialKey].label}: sense propietari`;
    });
    if (specialLines.length) lines.push(`🎁 Especials completes: ${specialLines.join(" · ")}.`);
    if (phase !== "final") lines.push("🔥 Encara pot passar de tot!");
    return lines.join("\n");
  }

  function shareWhatsApp(message) {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  grid.addEventListener("click", event => {
    const button = event.target.closest("button[data-score]");
    if (!button || button.disabled) return;
    if (isEntriesClosed()) {
      selected = [];
      renderGrid();
      renderStats();
      setFeedback("La porra està tancada des de les 20:45.", true);
      return;
    }
    const key = button.dataset.score;
    if (selected.includes(key)) {
      selected = selected.filter(item => item !== key);
      setFeedback("");
    } else if (selected.length >= 2) {
      setFeedback("Màxim 2 caselles per persona. Desmarca'n una per canviar-la.", true);
      return;
    } else {
      selected.push(key);
      setFeedback("");
    }
    renderGrid();
    renderStats();
  });

  nameInput.addEventListener("input", renderStats);
  nameInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !assignButton.disabled) assignEntry();
  });
  assignButton.addEventListener("click", assignEntry);

  roster.addEventListener("change", async event => {
    const checkbox = event.target.closest("input[data-paid]");
    if (!checkbox || !isAdmin) return;
    const entry = state.entries.find(item => item.id === checkbox.dataset.paid);
    if (!entry) return;

    const previous = entry.paid;
    entry.paid = checkbox.checked;
    renderStats();
    const { error } = await db
      .from("caselles")
      .update({ pagat: entry.paid })
      .in("id", entry.rowIds);

    if (error) {
      entry.paid = previous;
      checkbox.checked = previous;
      renderStats();
      setFeedback("No s'ha pogut actualitzar el pagament.", true);
      return;
    }
    setFeedback(`${entry.name} consta com a ${entry.paid ? "pagat/da" : "pendent"}.`);
  });

  roster.addEventListener("click", async event => {
    const button = event.target.closest("button[data-remove]");
    if (!button || !isAdmin) return;
    const entry = state.entries.find(item => item.id === button.dataset.remove);
    if (!entry) return;

    const { error } = await db.from("caselles").delete().in("id", entry.rowIds);
    if (error) {
      setFeedback("No s'ha pogut treure el participant.", true);
      return;
    }
    await loadRemoteEntries();
    setFeedback(`${entry.name} s'ha tret de la porra.`);
  });

  document.querySelector("[data-action='invite']").addEventListener("click", () => shareWhatsApp(inviteMessage()));
  document.querySelector("[data-action='status']").addEventListener("click", () => shareWhatsApp(statusMessage()));
  document.querySelector("[data-action='match-update']").addEventListener("click", () => shareWhatsApp(matchUpdateMessage()));
  adminLoginButton.addEventListener("click", loginAdmin);
  adminPasswordInput.addEventListener("keydown", event => {
    if (event.key === "Enter") loginAdmin();
  });
  document.querySelector("[data-action='admin-logout']").addEventListener("click", logoutAdmin);

  phaseSelect.addEventListener("change", async () => {
    if (!isAdmin) return;
    const previous = JSON.parse(JSON.stringify(state.match));
    state.match.phase = phaseSelect.value;
    if (state.match.phase === "pre" || state.match.phase === "first") {
      state.match.halfScore = null;
      state.match.regulationScore = null;
    }
    if (state.match.phase === "half") {
      state.match.halfScore = { spain: state.match.spain, argentina: state.match.argentina };
    }
    if (state.match.phase === "final") {
      state.match.regulationScore = { spain: state.match.spain, argentina: state.match.argentina };
    }
    render();
    const patch = {
      fase: state.match.phase,
      espanya_mitja: state.match.halfScore?.spain ?? null,
      argentina_mitja: state.match.halfScore?.argentina ?? null,
      espanya_90: state.match.regulationScore?.spain ?? null,
      argentina_90: state.match.regulationScore?.argentina ?? null
    };
    if (!await updateRemoteMatch(patch)) {
      state.match = previous;
      render();
    }
  });

  minuteInput.addEventListener("change", async () => {
    if (!isAdmin) return;
    const previous = state.match.minute;
    state.match.minute = Math.max(0, Math.min(130, Number(minuteInput.value) || 0));
    renderScoreboard();
    if (!await updateRemoteMatch({ minut: state.match.minute })) {
      state.match.minute = previous;
      renderScoreboard();
    }
  });

  adminControls.addEventListener("change", async event => {
    const input = event.target.closest("input[data-special-result]");
    if (!input || !isAdmin) return;
    const field = input.dataset.specialResult;
    const columns = {
      messiHatTrick: "messi_hat_trick",
      lamineBrace: "lamine_doblet",
      moreThanSixGoals: "mes_de_sis_gols"
    };
    const specialKeys = {
      messiHatTrick: "4-4",
      lamineBrace: "3-4",
      moreThanSixGoals: "4-3"
    };
    const previous = state.match[field];
    state.match[field] = input.checked;
    render();
    if (!await updateRemoteMatch({ [columns[field]]: state.match[field] })) {
      state.match[field] = previous;
      render();
      return;
    }
    setFeedback(`${longScore(specialKeys[field])}: ${state.match[field] ? "completa" : "pendent"}.`);
  });

  adminControls.addEventListener("click", async event => {
    const button = event.target.closest("button[data-goal]");
    if (!button || !isAdmin) return;
    const [team, change] = button.dataset.goal.split(":");
    const previous = state.match[team];
    const previousHalfScore = state.match.halfScore
      ? { ...state.match.halfScore }
      : null;
    const previousRegulationScore = state.match.regulationScore
      ? { ...state.match.regulationScore }
      : null;
    state.match[team] = Math.max(0, state.match[team] + Number(change));
    if (state.match.phase === "half") {
      state.match.halfScore = { spain: state.match.spain, argentina: state.match.argentina };
    }
    if (state.match.phase === "final") {
      state.match.regulationScore = { spain: state.match.spain, argentina: state.match.argentina };
    }
    render();
    const column = team === "spain" ? "espanya" : "argentina";
    const patch = { [column]: state.match[team] };
    if (state.match.phase === "half") {
      patch.espanya_mitja = state.match.halfScore.spain;
      patch.argentina_mitja = state.match.halfScore.argentina;
    }
    if (state.match.phase === "final") {
      patch.espanya_90 = state.match.regulationScore.spain;
      patch.argentina_90 = state.match.regulationScore.argentina;
    }
    button.disabled = true;
    const updated = await updateRemoteMatch(patch);
    button.disabled = false;
    if (!updated) {
      state.match[team] = previous;
      state.match.halfScore = previousHalfScore;
      state.match.regulationScore = previousRegulationScore;
      render();
    }
  });

  const millisecondsUntilClose = ENTRY_CLOSES_AT.getTime() - Date.now();
  if (millisecondsUntilClose > 0) {
    setTimeout(() => {
      selected = [];
      renderGrid();
      renderStats();
      setFeedback("🔒 La porra s'ha tancat a les 20:45.");
    }, millisecondsUntilClose + 250);
  }

  render();
  db.auth.getSession().then(({ data }) => applyAdminSession(data.session));
  db.auth.onAuthStateChange((_event, session) => applyAdminSession(session));
  Promise.all([loadRemoteEntries(), loadRemoteMatch()]).then(() => {
    subscribeToEntries();
    subscribeToMatch();
  });
})();

export const DEFAULT_PRIZE_PERCENTAGES = Object.freeze({ half: 25, final: 50, special: 25 });
export const DEFAULT_MAX_ENTRIES = 2;
export const DEFAULT_CELL_CAPACITY = 2;
export const ORGANIZER_NOTE_MAX_LENGTH = 400;
export const ORGANIZER_CONTACT_MAX_LENGTH = 120;

function plain(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function validatePrizePercentages(value = DEFAULT_PRIZE_PERCENTAGES) {
  const percentages = {
    half: Number(value.half),
    final: Number(value.final),
    special: Number(value.special)
  };
  if (Object.values(percentages).some(item => !Number.isInteger(item) || item < 0 || item > 100)) {
    throw new Error("Els percentatges dels premis han de ser enters entre 0 i 100.");
  }
  if (percentages.half + percentages.final + percentages.special !== 100) {
    throw new Error("Els percentatges dels premis han de sumar exactament 100.");
  }
  return percentages;
}

export function normalizeOrganizerText({ note, contact } = {}) {
  const rawNote = String(note || "");
  const rawContact = String(contact || "");
  if (rawNote.length > ORGANIZER_NOTE_MAX_LENGTH) throw new Error("La nota de l’organitzador no pot superar els 400 caràcters.");
  if (rawContact.length > ORGANIZER_CONTACT_MAX_LENGTH) throw new Error("El contacte públic no pot superar els 120 caràcters.");
  return { note: plain(rawNote, ORGANIZER_NOTE_MAX_LENGTH), contact: plain(rawContact, ORGANIZER_CONTACT_MAX_LENGTH) };
}

export function formatMadridDateTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Per definir";
  return new Intl.DateTimeFormat("ca-ES", {
    timeZone: "Europe/Madrid", dateStyle: "long", timeStyle: "short"
  }).format(new Date(value));
}

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString("ca-ES", { style: "currency", currency: "EUR" });
}

export function buildPoolRules(pool = {}) {
  const prize = validatePrizePercentages(pool.prizePercentages || DEFAULT_PRIZE_PERCENTAGES);
  const maxEntries = Number(pool.maxEntriesPerParticipant || DEFAULT_MAX_ENTRIES);
  const cellCapacity = Number(pool.cellCapacity || DEFAULT_CELL_CAPACITY);
  const organizer = normalizeOrganizerText({ note: pool.organizerNote, contact: pool.organizerContact });
  const specialNames = (pool.specials || []).map(item => {
    const title = plain(item.title, 100) || item.cellKey;
    const description = plain(item.description, 240);
    return description ? `${title}: ${description}` : title;
  });
  const items = [
    `Cada aposta costa ${money(pool.priceCents)}.`,
    `Tries el marcador exacte del partit o una de les apostes especials configurades.`,
    `Cada participant pot tenir com a màxim ${maxEntries} apostes actives.`,
    `Cada casella admet com a màxim ${cellCapacity} apostes.`,
    "Quan una casella és plena queda bloquejada i cal triar-ne una altra.",
    "La reserva queda pendent fins que l’administrador verifica el pagament; només llavors compta per als premis.",
    `La participació es tanca el ${formatMadridDateTime(pool.closesAt)} o abans si comença el partit.`,
    `Al descans, el ${prize.half}% del pot correspon a les apostes pagades amb el marcador exacte del descans.`,
    `Al final, el ${prize.final}% del pot correspon a les apostes pagades amb el marcador final exacte.`,
    "El resultat final es calcula als 90 minuts reglamentaris; no inclou pròrroga ni penals.",
    `Distribució configurada: descans ${prize.half}%, resultat final ${prize.final}% i especials ${prize.special}%.`,
    "Si una categoria té més d’una aposta guanyadora, el seu import es reparteix a parts iguals entre les apostes.",
    "Les apostes pendents, no verificades o alliberades no entren al pot confirmat ni poden guanyar.",
    "Si descans o especials no tenen guanyador, la seva part passa al resultat final. Si no hi ha guanyador final, aquesta part es reparteix entre els guanyadors de descans i especials; si no hi ha cap guanyador, tot queda acumulat.",
    specialNames.length ? `Apostes especials: ${specialNames.join("; ")}.` : "Aquesta porra no té apostes especials configurades.",
    "L’administrador bloqueja les entrades, actualitza el marcador i les especials durant el partit i finalitza els premis quan el resultat és complet.",
    "Per al repartiment, és autoritatiu el resultat oficial registrat per l’administrador, aplicat de manera coherent a totes les participacions."
  ];
  if (organizer.contact) items.push(`Contacte de l’organitzador: ${organizer.contact}.`);
  return {
    summary: `Fins a ${maxEntries} apostes per persona · ${money(pool.priceCents)} cadascuna · tancament ${formatMadridDateTime(pool.closesAt)}.`,
    items,
    organizerNote: organizer.note,
    prizePercentages: prize,
    maxEntries,
    cellCapacity
  };
}

export function poolRulesMarkup(pool, { escapeHtml, context = "public" }) {
  const model = buildPoolRules(pool);
  return `<section class="panel pool-rules pool-rules--${context}" aria-labelledby="pool-rules-title-${context}">
    <div class="section-heading"><div><span>Abans de participar</span><h2 id="pool-rules-title-${context}">${context === "admin" ? "Vista de les regles" : "Com funciona la porra"}</h2></div></div>
    <p class="pool-rules__summary">${escapeHtml(model.summary)}</p>
    <ol>${model.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
    ${model.organizerNote ? `<aside class="organizer-note"><strong>Nota de l’organitzador</strong><p>${escapeHtml(model.organizerNote)}</p></aside>` : ""}
  </section>`;
}

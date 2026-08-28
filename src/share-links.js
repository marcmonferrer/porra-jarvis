import { buildInvitationUrl } from "./invitations.js";

export function shareLinkStateLabel(status) {
  return ({ active: "Actiu", revoked: "Revocat", expired: "Caducat" })[status] || "Sense enllaç";
}

export function buildPoolShareUrl({ baseUrl, poolSlug, shareToken }) {
  return buildInvitationUrl({ baseUrl, poolSlug, invitationToken: shareToken });
}

export async function copyShareLink(text, { clipboard, documentObject = globalThis.document } = {}) {
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return true;
  }
  const input = documentObject.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  documentObject.body.append(input);
  input.select();
  const copied = documentObject.execCommand("copy");
  input.remove();
  return copied;
}

export function adminShareLinkMarkup({ pool, shareLink, createdShareUrl, escapeHtml, formatDateTime }) {
  if (!pool) return '<div class="empty-inline">Crea una porra abans de generar l’enllaç.</div>';
  const active = shareLink?.status === "active";
  const state = shareLink
    ? `<dl class="share-link-status"><div><dt>Estat</dt><dd>${escapeHtml(shareLinkStateLabel(shareLink.status))}</dd></div><div><dt>Creat</dt><dd>${escapeHtml(formatDateTime(shareLink.createdAt))}</dd></div><div><dt>Usos completats</dt><dd>${Number(shareLink.usageCount || 0)}</dd></div></dl>`
    : '<p>Encara no hi ha cap enllaç compartit per a aquesta porra.</p>';
  const secret = createdShareUrl
    ? `<div class="notice share-link-created"><strong>Copia aquest enllaç ara</strong><p>El secret no es desa i no es podrà recuperar després de recarregar.</p><div class="private-link"><input readonly value="${escapeHtml(createdShareUrl)}" aria-label="Enllaç reutilitzable de la porra"><button class="button primary share-copy" type="button" data-copy-share="${escapeHtml(createdShareUrl)}">Copiar enllaç</button></div><p class="sr-status" role="status" aria-live="polite" data-share-copy-status></p></div>`
    : "";
  const action = active
    ? '<button class="button danger" type="button" data-action="rotate-share-link">Revocar i crear-ne un de nou</button>'
    : '<button class="button primary" type="button" data-action="create-share-link">Crear enllaç</button>';
  return `<div class="section-heading"><div><span>Accés privat</span><h2>Enllaç per compartir</h2></div></div>
    <p>Comparteix el mateix enllaç amb el grup. Continua vàlid fins que el revoquis o la porra deixi d’admetre participacions.</p>
    ${state}${secret}<div class="action-row">${action}</div>
    ${active && !createdShareUrl ? '<p class="hint">L’enllaç és actiu, però el secret no es pot recuperar. Si l’has perdut, revoca’l i crea’n un de nou.</p>' : ""}`;
}

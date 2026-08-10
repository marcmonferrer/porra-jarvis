export const DEMO_RESET_CONFIRMATION = "Aquesta acció eliminarà totes les porres, participants, apostes, marcadors i premis guardats localment en aquest navegador. No es pot desfer. Vols reiniciar la demo?";

export function isDemoResetAvailable(repository) {
  return repository?.mode === "demo" && typeof repository.resetDemo === "function";
}

export function demoResetButtonMarkup() {
  return `<button class="button danger demo-reset" type="button" data-action="reset-demo">Reiniciar demo</button>`;
}

export function preventAccidentalSubmit(event) {
  event.preventDefault();
  event.stopPropagation();
}

export function validatePoolBeforePublish(form) {
  return !form || form.reportValidity();
}

export async function resetDemoSafely({ repository, confirmReset, clearActiveState, reloadAdmin, notify }) {
  if (!isDemoResetAvailable(repository)) return { reset: false, reason: "unavailable" };
  if (!await confirmReset(DEMO_RESET_CONFIRMATION)) return { reset: false, reason: "cancelled" };
  await repository.resetDemo();
  clearActiveState();
  await reloadAdmin();
  notify("Demo reiniciada correctament");
  return { reset: true };
}

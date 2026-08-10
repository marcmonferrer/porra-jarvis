export const DEMO_RESET_CONFIRMATION = "Aquesta acció eliminarà totes les porres, participants, apostes, marcadors i premis guardats localment en aquest navegador. No es pot desfer. Vols reiniciar la demo?";

export function isDemoResetAvailable(repository) {
  return repository?.mode === "demo" && typeof repository.resetDemo === "function";
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

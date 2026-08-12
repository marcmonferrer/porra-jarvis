// Copia aquests valors a la configuració injectada pel teu entorn de desplegament.
// No hi posis service-role keys, contrasenyes, telèfons ni dades de pagament.
window.PORRA_LIVE_CONFIG = Object.freeze({
  mode: "supabase",
  supabaseUrl: "https://YOUR_PROJECT.supabase.co",
  supabasePublishableKey: "YOUR_SUPABASE_PUBLISHABLE_KEY"
});

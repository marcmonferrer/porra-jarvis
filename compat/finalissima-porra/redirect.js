(() => {
  "use strict";
  const legacyBase = "/finalissima-porra";
  const targetBase = "https://marcmonferrer.github.io/porra-jarvis";
  const { pathname, search, hash } = window.location;
  const suffix = pathname === legacyBase || pathname === `${legacyBase}/index.html`
    ? "/"
    : pathname.startsWith(`${legacyBase}/`)
      ? pathname.slice(legacyBase.length)
      : "/";
  window.location.replace(`${targetBase}${suffix}${search}${hash}`);
})();

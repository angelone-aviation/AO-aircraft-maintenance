// Applies the saved theme before the first paint. index.html loads this as a
// plain blocking script in <head>, before the app's module, so a reload with
// the dark theme saved never shows a light frame. It is a static file, not an
// inline script, so a `script-src 'self'` Content-Security-Policy allows it.
// It mirrors storedTheme() in src/components/design.tsx: the saved choice,
// else the system preference. initTheme() stays the source of truth once the
// app has loaded.
(function () {
  var theme = null;
  try {
    var saved = localStorage.getItem("angelone-theme");
    if (saved === "dark" || saved === "light") theme = saved;
  } catch (e) {
    // Storage blocked: fall through to the system preference.
  }
  if (!theme)
    try {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch (e) {
      theme = "light";
    }
  if (theme === "dark") document.documentElement.classList.add("dark");
})();

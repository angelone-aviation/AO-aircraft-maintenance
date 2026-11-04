/**
 * Responsibility: Applies the saved theme before the first paint, so a reload
 *   with the dark theme saved never shows a light frame.
 * Layer: UI. Classic blocking script in index.html's <head>, before the app.
 * Dependencies: none.
 *
 * A static file, not an inline script, so the CSP's `script-src 'self'` allows
 * it. It mirrors storedTheme() in src/components/design.tsx, whose initTheme()
 * takes over once the app has loaded.
 */
(function () {
  var theme = null;
  try {
    var saved = localStorage.getItem("angelone-theme");
    if (saved === "dark" || saved === "light") theme = saved;
  } catch {
    // Storage blocked: fall through to the system preference.
  }
  if (!theme)
    try {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch {
      // No usable matchMedia: assume the light theme.
      theme = "light";
    }
  if (theme === "dark") document.documentElement.classList.add("dark");
})();

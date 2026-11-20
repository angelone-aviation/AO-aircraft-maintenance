/**
 * Responsibility: Answers the requests no static asset matches: a missing
 *   bundle under /assets/ gets an uncached 404; any other page, the app shell.
 * Layer: Config. The Cloudflare Worker wrangler.jsonc names; Cloudflare runs
 *   it only after no file in dist/ matched. scripts/serve-dist.mjs mirrors it.
 * Dependencies: none; the Workers runtime's fetch API and ASSETS binding.
 *
 * Without it, a tab still on an old release that asked for a removed bundle
 * got index.html, which the /assets/* rule in _headers marks immutable for a
 * year, so the tab stayed broken until site data was cleared (review C2).
 */

// Where Vite writes its content-hashed bundles. Nothing else is exported:
// Cloudflare reads the main module's named exports as entrypoints.
const BUNDLE_PATH_PREFIX = "/assets/";
const SHELL_PATH = "/";

// The static assets, as Cloudflare binds them (wrangler.jsonc "binding").
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * The Worker's request handler.
 *
 * @returns 404 "Not found", never cached, for a path under /assets/; 405
 *   for a method other than GET or HEAD; else the app shell (index.html)
 *   from the static assets, as single-page-app handling serves it, so a
 *   client that does not mark its navigation still reaches every app route.
 */
async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith(BUNDLE_PATH_PREFIX))
    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return env.ASSETS.fetch(new Request(new URL(SHELL_PATH, url), request));
}

/** The Worker module Cloudflare loads. */
export default { fetch };

/**
 * Responsibility: Pins the published security headers: the CSP in
 *   public/_headers, headers on pages and routes, caching, security.txt,
 *   and no deployment-only files served.
 * Layer: Test. Playwright spec against the production build's static server.
 * Dependencies: @playwright/test, node:fs.
 *
 * The suite is served by scripts/serve-dist.mjs, which applies public/_headers
 * the way Cloudflare does. These checks keep the published policy from being
 * loosened by accident; the CSP itself is exercised by every other spec.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

// Only the app's own scripts; WebAssembly for the PDF.js decoders, no eval.
const SCRIPT_SOURCES = ["'self'", "'wasm-unsafe-eval'"];
const SECURITY_TXT = "/.well-known/security.txt";

test("the published policy keeps scripts, framing and plugins locked down", () => {
  const file = readFileSync("public/_headers", "utf8");
  // The header line, not a "#" comment that names it.
  const policy = file.match(/^\s*Content-Security-Policy: (.+)$/m)?.[1] ?? "";
  const csp = directives(policy);
  expect(csp.get("default-src")).toEqual(["'self'"]);
  expect(csp.get("script-src")).toEqual(SCRIPT_SOURCES);
  expect(csp.get("object-src")).toEqual(["'none'"]);
  expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
  expect(csp.get("base-uri")).toEqual(["'self'"]);
  expect(csp.get("form-action")).toEqual(["'self'"]);
  for (const sources of csp.values()) {
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("http:");
    expect(sources).not.toContain("https:");
  }
  expect(csp.get("connect-src")).toEqual(
    expect.arrayContaining([
      "'self'",
      "https://*.convex.cloud",
      "wss://*.convex.cloud",
      "https://*.convex.site",
    ]),
  );
});

test("pages and app routes carry the security headers", async ({ request }) => {
  for (const path of ["/", "/work-orders", "/aircraft/unknown/records"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    const headers = response.headers();
    const csp = directives(headers["content-security-policy"] ?? "");
    expect(csp.get("script-src"), path).toEqual(SCRIPT_SOURCES);
    expect(csp.get("frame-ancestors"), path).toEqual(["'none'"]);
    expect(headers["strict-transport-security"]).toMatch(
      /max-age=\d{8,}; includeSubDomains/,
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=(self)");
    expect(headers["permissions-policy"]).toContain("microphone=()");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  }
  expect((await request.get("/")).headers()["cache-control"]).toBe("no-cache");
});

test("hashed assets are cached for good; the shell and worker are revalidated", async ({
  request,
}) => {
  const asset = readdirSync("dist/assets").find((name) => name.endsWith(".js"));
  const cached = await request.get(`/assets/${asset}`);
  expect(cached.status()).toBe(200);
  expect(cached.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(cached.headers()["content-security-policy"]).toBeTruthy();
  for (const path of ["/sw.js", "/manifest.webmanifest"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("no-cache");
  }
  const theme = await request.get("/theme-init.js");
  expect(theme.headers()["cache-control"]).not.toContain("immutable");
  // A bundle an older release named is gone: a real 404, never cached.
  const removed = await request.get("/assets/index-removed.js");
  expect(removed.status()).toBe(404);
  expect(removed.headers()["cache-control"]).toBe("no-store");
});

test("security.txt names the security contact and has not expired", async ({
  request,
}) => {
  for (const path of [SECURITY_TXT, "/.well-known/security-policy.txt"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain("text/plain");
  }
  const text = await (await request.get(SECURITY_TXT)).text();
  expect(text).toContain("Contact: mailto:accounts@angeloneonline.org");
  // RFC 9116 says to treat an expired file as absent: renew it before the
  // date (docs/go-live-checklist.md, recurring tasks).
  const expires = Date.parse(text.match(/^Expires: (.+)$/m)?.[1] ?? "");
  expect(expires).toBeGreaterThan(Date.now());
});

test("an installed app still opens security.txt, not the app", async ({
  page,
}) => {
  await page.goto("/");
  // The service worker controls only pages loaded after it activates.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  const controlled = await page.evaluate(
    () => navigator.serviceWorker.controller !== null,
  );
  expect(controlled).toBe(true);
  await page.goto(SECURITY_TXT);
  await expect(page.locator("body")).toContainText("Contact: mailto:");
});

test("deployment-only files are not published", async ({ request }) => {
  for (const path of ["/_headers", "/.assetsignore", "/.htaccess"]) {
    const response = await request.get(path);
    // Unknown paths fall back to the app shell, as on Cloudflare.
    expect(response.headers()["content-type"], path).toContain("text/html");
    expect(await response.text(), path).toContain('<div id="root">');
  }
});

/** A CSP's directives by name, each with its sources in order. */
function directives(policy: string) {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name, sources]),
  );
}

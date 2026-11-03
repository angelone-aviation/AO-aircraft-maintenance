import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

// The suite is served by scripts/serve-dist.mjs, which applies public/_headers
// the way Cloudflare does. These checks keep the published policy from being
// loosened by accident; the CSP itself is exercised by every other spec.
function directives(policy: string) {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name, sources]),
  );
}

test("the published policy keeps scripts, framing and plugins locked down", () => {
  const file = readFileSync("public/_headers", "utf8");
  const policy = file.match(/Content-Security-Policy: (.+)/)?.[1] ?? "";
  const csp = directives(policy);
  expect(csp.get("default-src")).toEqual(["'self'"]);
  expect(csp.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
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
    expect(csp.get("script-src"), path).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
    ]);
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
});

test("deployment-only files are not published", async ({ request }) => {
  for (const path of ["/_headers", "/.assetsignore", "/.htaccess"]) {
    const response = await request.get(path);
    // Unknown paths fall back to the app shell, as on Cloudflare.
    expect(response.headers()["content-type"], path).toContain("text/html");
    expect(await response.text(), path).toContain('<div id="root">');
  }
});

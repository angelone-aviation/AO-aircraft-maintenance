/**
 * Responsibility: Characterizes serve-dist.mjs, the Cloudflare-like server the
 *   browser tests use: _headers rules, ignored assets, redirects, SPA fallback,
 *   the 404 for a missing bundle, caching and CSP report collection.
 * Layer: Test. Starts the script on a fixture build and requests it over HTTP.
 * Dependencies: vitest, scripts/serve-dist.mjs.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "serve-dist.mjs");
const INDEX = "<h1>app</h1>";
const HEADERS = `# Fixture rules
/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; img-src 'self'; connect-src 'self'
  X-Multi: one
/assets/*
  Cache-Control: public, max-age=31536000, immutable
  X-Multi: two
  ! X-Frame-Options
/users/:id
  X-User: yes
`;
const ASSETS_IGNORE = "# Fixture globs\n*.map\nreadme.txt\n";

let parent: string;
let root: string;
const servers: ChildProcess[] = [];
let plain: string;
let reporting: string;

beforeAll(async () => {
  parent = mkdtempSync(path.join(tmpdir(), "serve-dist-"));
  root = path.join(parent, "dist");
  writeFixture("index.html", INDEX);
  writeFixture("about.html", "about");
  writeFixture("data.json", "{}");
  writeFixture("assets/app.js", "app()");
  writeFixture("assets/app.js.map", "{}");
  writeFixture("notes/readme.txt", "notes");
  writeFixture("_headers", HEADERS);
  writeFixture(".assetsignore", ASSETS_IGNORE);
  writeFileSync(path.join(parent, "outside.txt"), "outside");
  plain = await startServer([]);
  reporting = await startServer(["--report-csp"]);
});

afterAll(() => {
  for (const server of servers) server.kill();
  rmSync(parent, { recursive: true, force: true });
});

describe("serve-dist.mjs", () => {
  it("serves a file with its type, rule headers and the default cache", async () => {
    const response = await fetch(`${plain}/data.json`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-multi")).toBe("one");
    expect(response.headers.get("content-length")).toBe("2");
  });

  it("lets a later rule add to, override and detach headers", async () => {
    const response = await fetch(`${plain}/assets/app.js`);

    expect(response.headers.get("x-multi")).toBe("one, two");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.has("x-frame-options")).toBe(false);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  it("matches a :placeholder to exactly one path segment", async () => {
    const one = await fetch(`${plain}/users/42`);
    const two = await fetch(`${plain}/users/42/edit`);

    expect(one.headers.get("x-user")).toBe("yes");
    expect(two.headers.has("x-user")).toBe(false);
  });

  it("redirects .html paths that exist, keeping the query", async () => {
    const index = await fetch(`${plain}/index.html?tab=1`, {
      redirect: "manual",
    });
    const about = await fetch(`${plain}/about.html`, { redirect: "manual" });

    expect(index.status).toBe(307);
    expect(index.headers.get("location")).toBe("/?tab=1");
    expect(about.status).toBe(307);
    expect(about.headers.get("location")).toBe("/about");
    expect(await (await fetch(`${plain}/about`)).text()).toBe("about");
  });

  it.each([
    "/work-orders",
    "/missing.html",
    "/_headers",
    "/.assetsignore",
    "/notes/readme.txt",
    "/..%2Foutside.txt",
    "/__csp-report",
  ])("answers %s with index.html", async (pathname) => {
    const response = await fetch(`${plain}${pathname}`, {
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX);
  });

  it.each(["/assets/index-0ld.js", "/assets/app.js.map"])(
    "answers the missing bundle %s with an uncached 404, as the Worker does",
    async (pathname) => {
      const response = await fetch(`${plain}${pathname}`);

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("x-multi")).toBe(false);
      expect(await response.text()).toBe("Not found");
    },
  );

  it("answers 304 to a matching ETag and no body to HEAD", async () => {
    const first = await fetch(`${plain}/data.json`);
    const etag = first.headers.get("etag") ?? "";
    const again = await fetch(`${plain}/data.json`, {
      headers: { "If-None-Match": etag },
    });
    const head = await fetch(`${plain}/data.json`, { method: "HEAD" });

    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(again.status).toBe(304);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("2");
    expect(await head.text()).toBe("");
  });

  it("refuses other methods and undecodable paths", async () => {
    const post = await fetch(`${plain}/data.json`, { method: "POST" });
    const malformed = await fetch(`${plain}/%E0%A4%A`);

    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(malformed.status).toBe(400);
  });

  it("with --report-csp, allows the local backend and adds a report-uri", async () => {
    const response = await fetch(`${reporting}/`);

    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' http://127.0.0.1:3210; " +
        "connect-src 'self' http://127.0.0.1:3210 ws://127.0.0.1:3210 " +
        "http://127.0.0.1:3211; report-uri /__csp-report",
    );
  });

  it("with --report-csp, collects reports, keeping unreadable ones", async () => {
    const report = {
      "effective-directive": "img-src",
      "blocked-uri": "https://cdn.example.org/a.png",
      "document-uri": "http://127.0.0.1/",
    };
    const posts = [JSON.stringify({ "csp-report": report }), "not json"];
    for (const body of posts) {
      const sent = await fetch(`${reporting}/__csp-report`, {
        method: "POST",
        body,
      });
      expect(sent.status).toBe(204);
    }

    const collected = await fetch(`${reporting}/__csp-report`);

    expect(collected.headers.get("x-csp-report-collector")).toBe("1");
    expect(collected.headers.get("content-type")).toBe("application/json");
    expect(await collected.json()).toEqual([
      report,
      { unreadable: "not json" },
    ]);
  });

  it.each([
    ["X-Frame-Options: DENY\n", "_headers: only path patterns are supported"],
    ["  X-Frame-Options: DENY\n", "_headers: header before any path"],
    ["/*\n  X-Frame-Options DENY\n", '_headers: expected "Name: value"'],
  ])("refuses to start on a bad _headers line", (headers, message) => {
    const bad = path.join(parent, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "_headers"), headers);

    const run = spawnSync(process.execPath, [SCRIPT, "--dir", bad], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
  });
});

function writeFixture(relativePath: string, text: string) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function startServer(flags: string[]): Promise<string> {
  const port = await findFreePort();
  const server = spawn(process.execPath, [
    SCRIPT,
    "--dir",
    root,
    "--port",
    String(port),
    ...flags,
  ]);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("Serving ")) resolve();
    });
    server.on("exit", () => reject(new Error("serve-dist.mjs exited")));
  });
  return `http://127.0.0.1:${port}`;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

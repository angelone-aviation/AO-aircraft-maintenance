#!/usr/bin/env node
// Serve the production build the way Cloudflare Workers Static Assets does
// (wrangler.jsonc): files from dist/, the response headers in dist/_headers,
// .assetsignore, the /index.html -> / redirect and the single-page-app
// fallback to index.html. The browser tests run against it so that every spec
// runs under the production Content-Security-Policy.
//
//   node scripts/serve-dist.mjs [--port 4173] [--host 127.0.0.1] [--dir dist]
//                               [--report-csp]
//
// --report-csp adds a report-uri to the policy, collects the browser's
// violation reports and returns them from GET /__csp-report. It also allows
// the local Convex backend (npm run dev:local) so the optional live test can
// connect; the published policy is unchanged.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(option("--port", "4173"));
const host = option("--host", "127.0.0.1");
const root = resolve(option("--dir", "dist"));
const reportCsp = args.includes("--report-csp");
const reportPath = "/__csp-report";
const localBackend =
  "http://127.0.0.1:3210 ws://127.0.0.1:3210 http://127.0.0.1:3211";

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Cloudflare _headers: a path pattern line, then indented "Name: value" lines. */
function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      if (!line.startsWith("/"))
        throw Error(`_headers: only path patterns are supported: ${line}`);
      const pattern = line
        .split(/(\*|:[A-Za-z]\w*)/)
        .map((part) =>
          part === "*"
            ? "(.*)"
            : part.startsWith(":")
              ? "([^/]+)"
              : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      rules.push({ match: new RegExp(`^${pattern}$`), set: [], detach: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) throw Error(`_headers: header before any path: ${line}`);
    if (line.startsWith("!")) {
      rule.detach.push(line.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) throw Error(`_headers: expected "Name: value": ${line}`);
    rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** Headers for a request path; repeated headers are joined with ", ". */
function headersFor(rules, path) {
  const headers = new Map();
  for (const rule of rules) {
    if (!rule.match.test(path)) continue;
    for (const name of rule.detach) headers.delete(name);
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      const old = headers.get(key);
      headers.set(key, [name, old ? `${old[1]}, ${value}` : value]);
    }
  }
  return [...headers.values()];
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const rules = parseHeaders(readOptional(join(root, "_headers")));
const ignored = readOptional(join(root, ".assetsignore"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map(
    (glob) =>
      new RegExp(
        `^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
      ),
  );
const isIgnored = (relative) =>
  ["_headers", "_redirects", ".assetsignore"].includes(relative) ||
  ignored.some((glob) => glob.test(relative) || glob.test(basename(relative)));

function fileFor(pathname) {
  const candidates = pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}.html`];
  for (const candidate of candidates) {
    const file = resolve(join(root, candidate));
    if (file !== root && !file.startsWith(root + sep)) return null;
    const relative = file
      .slice(root.length + 1)
      .split(sep)
      .join("/");
    if (isIgnored(relative)) continue;
    try {
      const stats = statSync(file);
      if (stats.isFile()) return { file, stats };
    } catch {
      // Not found: try the next candidate.
    }
  }
  return null;
}

const reports = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (reportCsp && url.pathname === reportPath) {
    response.setHeader("X-CSP-Report-Collector", "1");
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        try {
          const report = JSON.parse(body)["csp-report"] ?? JSON.parse(body);
          reports.push(report);
          console.error(
            `CSP violation: ${report["effective-directive"] ?? report["violated-directive"]} blocked ${report["blocked-uri"]} on ${report["document-uri"]}`,
          );
        } catch {
          reports.push({ unreadable: body });
        }
        response.writeHead(204).end();
      });
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reports));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  for (const [name, value] of headersFor(rules, pathname)) {
    let content = value;
    if (reportCsp && name.toLowerCase() === "content-security-policy")
      content = `${value
        .replace(/(connect-src [^;]*)/, `$1 ${localBackend}`)
        .replace(
          /(img-src [^;]*)/,
          `$1 http://127.0.0.1:3210`,
        )}; report-uri ${reportPath}`;
    response.setHeader(name, content);
  }
  // html_handling "auto-trailing-slash": /index.html -> /, /page.html -> /page.
  const html = pathname.match(/^(.*\/)index\.html$|^(.+)\.html$/);
  if (html && fileFor(pathname)) {
    response
      .writeHead(307, { Location: (html[1] ?? html[2]) + url.search })
      .end();
    return;
  }
  // not_found_handling "single-page-application": unknown paths get index.html.
  const found = fileFor(pathname) ?? fileFor("/");
  if (!found) {
    response.writeHead(404).end();
    return;
  }
  const { file, stats } = found;
  const etag = `"${stats.size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"`;
  response.setHeader(
    "Content-Type",
    types[extname(file)] ?? "application/octet-stream",
  );
  response.setHeader("ETag", etag);
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304).end();
    return;
  }
  response.setHeader("Content-Length", stats.size);
  response.writeHead(200);
  response.end(request.method === "HEAD" ? undefined : readFileSync(file));
});

server.listen(port, host, () => {
  console.log(
    `Serving ${root} at http://${host}:${port} with ${rules.length} _headers rules${reportCsp ? " (collecting CSP reports)" : ""}`,
  );
});

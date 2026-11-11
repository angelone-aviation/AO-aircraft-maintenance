#!/usr/bin/env node
/**
 * Responsibility: Serves a production build the way Cloudflare Workers Static
 *   Assets does (wrangler.jsonc), so every browser test runs under the
 *   production Content-Security-Policy.
 * Layer: Script. Local test server only; never deployed.
 * Dependencies: Node.js built-ins (node:http, node:fs, node:path).
 *
 *   node scripts/serve-dist.mjs [--port 4173] [--host 127.0.0.1] [--dir dist]
 *                               [--report-csp]
 *
 * Mirrors _headers, .assetsignore, the /index.html -> / redirect and the
 * single-page-app fallback. --report-csp adds a report-uri, collects reports
 * at GET /__csp-report and allows the local Convex backend (npm run
 * dev:local); the published policy is unchanged.
 */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

const REPORT_PATH = "/__csp-report";
const LOCAL_BACKEND =
  "http://127.0.0.1:3210 ws://127.0.0.1:3210 http://127.0.0.1:3211";
// Cloudflare's default for static assets that _headers does not override.
const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";
// Read as configuration, never served as assets.
const CONFIG_FILES = ["_headers", "_redirects", ".assetsignore"];
const CONTENT_TYPES = {
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
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const args = process.argv.slice(2);
const port = Number(option("--port", "4173"));
const host = option("--host", "127.0.0.1");
const root = resolve(option("--dir", "dist"));
const reportCsp = args.includes("--report-csp");
const rules = parseHeaders(readOptional(join(root, "_headers")));
const ignored = parseAssetsIgnore(readOptional(join(root, ".assetsignore")));
const reports = [];

createServer(handleRequest).listen(port, host, () => {
  console.log(
    `Serving ${root} at http://${host}:${port} with ${rules.length} _headers rules${reportCsp ? " (collecting CSP reports)" : ""}`,
  );
});

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

// A build without _headers or .assetsignore is served as if the file were
// empty, as Cloudflare does.
function readOptional(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// Cloudflare _headers: a path pattern line, then indented "Name: value" lines;
// "! Name" removes a header that an earlier matching rule set.
function parseHeaders(text) {
  const parsed = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\s/.test(raw)) addHeaderLine(parsed.at(-1), line);
    else parsed.push(parsePathLine(line));
  }
  return parsed;
}

function parsePathLine(line) {
  if (!line.startsWith("/"))
    throw Error(`_headers: only path patterns are supported: ${line}`);
  const pattern = line
    .split(/(\*|:[A-Za-z]\w*)/)
    .map(patternPart)
    .join("");
  return { match: new RegExp(`^${pattern}$`), set: [], detach: [] };
}

// "*" matches anything, "/" included; ":name" matches one path segment.
function patternPart(part) {
  if (part === "*") return "(.*)";
  if (part.startsWith(":")) return "([^/]+)";
  return escapeLiteral(part);
}

function addHeaderLine(rule, line) {
  if (!rule) throw Error(`_headers: header before any path: ${line}`);
  if (line.startsWith("!")) {
    rule.detach.push(line.slice(1).trim().toLowerCase());
    return;
  }
  const colon = line.indexOf(":");
  if (colon < 1) throw Error(`_headers: expected "Name: value": ${line}`);
  rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
}

// Each line is a glob whose "*" stays within one path segment.
function parseAssetsIgnore(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(
      (glob) => new RegExp(`^${escapeLiteral(glob).replace(/\*/g, "[^/]*")}$`),
    );
}

// Leaves "*" alone: parseAssetsIgnore turns it into a segment wildcard.
function escapeLiteral(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (reportCsp && url.pathname === REPORT_PATH)
    return handleReports(request, response);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const pathname = decodePath(url.pathname);
  if (pathname === null) {
    response.writeHead(400).end();
    return;
  }
  setRuleHeaders(response, pathname);
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
  sendFile(request, response, found);
}

function handleReports(request, response) {
  response.setHeader("X-CSP-Report-Collector", "1");
  if (request.method !== "POST") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(reports));
    return;
  }
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    recordReport(body);
    response.writeHead(204).end();
  });
}

function recordReport(body) {
  try {
    const report = JSON.parse(body)["csp-report"] ?? JSON.parse(body);
    reports.push(report);
    console.error(
      `CSP violation: ${report["effective-directive"] ?? report["violated-directive"]} blocked ${report["blocked-uri"]} on ${report["document-uri"]}`,
    );
  } catch {
    // Kept anyway: the browser-test teardown fails on any report.
    reports.push({ unreadable: body });
  }
}

function decodePath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function setRuleHeaders(response, pathname) {
  response.setHeader("Cache-Control", DEFAULT_CACHE_CONTROL);
  for (const [name, value] of headersFor(pathname)) {
    const isPolicy =
      reportCsp && name.toLowerCase() === "content-security-policy";
    response.setHeader(name, isPolicy ? withLocalReporting(value) : value);
  }
}

// Every matching rule applies in file order; a repeated header is joined
// with ", ".
function headersFor(pathname) {
  const headers = new Map();
  for (const rule of rules) {
    if (!rule.match.test(pathname)) continue;
    for (const name of rule.detach) headers.delete(name);
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      const old = headers.get(key);
      headers.set(key, [name, old ? `${old[1]}, ${value}` : value]);
    }
  }
  return [...headers.values()];
}

function withLocalReporting(policy) {
  const connect = policy.replace(/(connect-src [^;]*)/, `$1 ${LOCAL_BACKEND}`);
  const images = connect.replace(/(img-src [^;]*)/, `$1 http://127.0.0.1:3210`);
  return `${images}; report-uri ${REPORT_PATH}`;
}

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
    const stats = statIfPresent(file);
    if (stats?.isFile()) return { file, stats };
  }
  return null;
}

function isIgnored(relative) {
  return (
    CONFIG_FILES.includes(relative) ||
    ignored.some((glob) => glob.test(relative) || glob.test(basename(relative)))
  );
}

function statIfPresent(file) {
  try {
    return statSync(file);
  } catch {
    // Not found: the caller tries its next candidate.
    return undefined;
  }
}

function sendFile(request, response, { file, stats }) {
  const etag = `"${stats.size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"`;
  response.setHeader(
    "Content-Type",
    CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
  );
  response.setHeader("ETag", etag);
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304).end();
    return;
  }
  response.setHeader("Content-Length", stats.size);
  response.writeHead(200);
  response.end(request.method === "HEAD" ? undefined : readFileSync(file));
}

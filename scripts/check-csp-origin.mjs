#!/usr/bin/env node
/**
 * Responsibility: Checks that the Content-Security-Policy in public/_headers
 *   lets the app reach a Convex deployment (`check-csp-origin.mjs <url>`) or a
 *   Sentry DSN's ingest host (`check-csp-origin.mjs --sentry-dsn <dsn>`).
 * Layer: Script. Read-only release check; exits 1 when the policy blocks it.
 * Dependencies: node:fs.
 *
 * A source allows its exact host or, written `*.host`, any subdomain of it; a
 * source with a port or a path never matches. An empty DSN passes, because
 * error reporting is then off.
 */
import { readFileSync } from "node:fs";

// HTTPS and WebSocket connections, and file-storage images.
const CONVEX_SOURCES = [
  ["connect-src", "https"],
  ["connect-src", "wss"],
  ["img-src", "https"],
];
// The SDK only posts events to the DSN's host.
const SENTRY_SOURCES = [["connect-src", "https"]];
const HOST_SOURCE = /^([a-z]+):\/\/(\*\.)?([^/:]+)$/;

const policy = readPolicy();
const args = process.argv.slice(2);
if (args[0] === "--sentry-dsn") checkSentryDsn(args[1]);
else checkOrigin(parseUrl(args[0], "The Convex URL"), "", CONVEX_SOURCES);

function checkSentryDsn(dsn) {
  if (dsn === undefined)
    exitWithError("Usage: check-csp-origin.mjs --sentry-dsn <dsn>");
  if (dsn === "") {
    console.log("No Sentry DSN: error reporting stays off.");
    return;
  }
  const target = parseUrl(dsn, "The Sentry DSN");
  checkOrigin(target, "Sentry ingest host ", SENTRY_SOURCES);
}

function checkOrigin(target, label, required) {
  const name = label + target.origin;
  if (target.protocol !== "https:") exitWithError(`${name} must use https.`);
  const missing = required.filter(
    ([directive, scheme]) => !allows(directive, scheme, target.hostname),
  );
  if (missing.length)
    exitWithError(describeMissing(name, target.hostname, missing));
  console.log(`${name} is allowed by the Content-Security-Policy.`);
}

function readPolicy() {
  const headers = readFileSync(
    new URL("../public/_headers", import.meta.url),
    "utf8",
  );
  return headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? "";
}

function parseUrl(text, name) {
  if (!URL.canParse(text ?? "")) exitWithError(`${name} is not a valid URL.`);
  return new URL(text);
}

function allows(directive, scheme, hostname) {
  return sourcesOf(directive).some((source) => {
    const match = source.match(HOST_SOURCE);
    if (!match || match[1] !== scheme) return false;
    return match[2] ? hostname.endsWith(`.${match[3]}`) : hostname === match[3];
  });
}

function sourcesOf(directive) {
  return (
    policy
      .match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]+)`))?.[1]
      .split(/\s+/) ?? []
  );
}

function describeMissing(name, hostname, required) {
  const sources = required
    .map(([directive, scheme]) => `${directive} ${scheme}://${hostname}`)
    .join(", ");
  return `${name} is not allowed by public/_headers: ${sources}. Add it to the Content-Security-Policy before deploying.`;
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

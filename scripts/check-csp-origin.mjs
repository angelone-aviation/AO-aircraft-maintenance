#!/usr/bin/env node
/**
 * Responsibility: Checks that the Content-Security-Policy in public/_headers
 *   lets the app reach a Convex deployment (`check-csp-origin.mjs <url>`).
 * Layer: Script. Read-only release check; exits 1 when the policy blocks it.
 * Dependencies: node:fs.
 *
 * A source allows its exact host or, written `*.host`, any subdomain of it; a
 * source with a port or a path never matches.
 */
import { readFileSync } from "node:fs";

// HTTPS and WebSocket connections, and file-storage images.
const REQUIRED_SOURCES = [
  ["connect-src", "https"],
  ["connect-src", "wss"],
  ["img-src", "https"],
];
const HOST_SOURCE = /^([a-z]+):\/\/(\*\.)?([^/:]+)$/;

const target = new URL(process.argv[2] ?? "");
const policy = readPolicy();
const missing = REQUIRED_SOURCES.filter(
  ([directive, scheme]) => !allows(directive, scheme),
);
if (target.protocol !== "https:")
  exitWithError(`${target.origin} must use https.`);
if (missing.length) exitWithError(describeMissing(missing));
console.log(`${target.origin} is allowed by the Content-Security-Policy.`);

function readPolicy() {
  const headers = readFileSync(
    new URL("../public/_headers", import.meta.url),
    "utf8",
  );
  return headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? "";
}

function allows(directive, scheme) {
  return sourcesOf(directive).some((source) => {
    const match = source.match(HOST_SOURCE);
    if (!match || match[1] !== scheme) return false;
    return match[2]
      ? target.hostname.endsWith(`.${match[3]}`)
      : target.hostname === match[3];
  });
}

function sourcesOf(directive) {
  return (
    policy
      .match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]+)`))?.[1]
      .split(/\s+/) ?? []
  );
}

function describeMissing(required) {
  const sources = required
    .map(([directive, scheme]) => `${directive} ${scheme}://${target.hostname}`)
    .join(", ");
  return `${target.origin} is not allowed by public/_headers: ${sources}. Add it to the Content-Security-Policy before deploying.`;
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

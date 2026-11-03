#!/usr/bin/env node
// Usage: node scripts/check-csp-origin.mjs <convex-url>
// Exits non-zero unless the Content-Security-Policy in public/_headers lets the
// app reach the Convex deployment: HTTPS and WebSocket in connect-src, and
// file-storage images in img-src. The Deploy workflow runs it before pushing.
import { readFileSync } from "node:fs";

const target = new URL(process.argv[2] ?? "");
const policy =
  readFileSync(new URL("../public/_headers", import.meta.url), "utf8").match(
    /Content-Security-Policy:\s*(.+)/,
  )?.[1] ?? "";
const sources = (directive) =>
  policy
    .match(new RegExp(`(?:^|;)\\s*${directive}\\s+([^;]+)`))?.[1]
    .split(/\s+/) ?? [];

function allows(directive, scheme) {
  return sources(directive).some((source) => {
    const match = source.match(/^([a-z]+):\/\/(\*\.)?([^/:]+)$/);
    if (!match || match[1] !== scheme) return false;
    return match[2]
      ? target.hostname.endsWith(`.${match[3]}`)
      : target.hostname === match[3];
  });
}

const missing = [
  ["connect-src", "https"],
  ["connect-src", "wss"],
  ["img-src", "https"],
].filter(([directive, scheme]) => !allows(directive, scheme));
if (target.protocol !== "https:") {
  console.error(`${target.origin} must use https.`);
  process.exit(1);
}
if (missing.length) {
  console.error(
    `${target.origin} is not allowed by public/_headers: ${missing
      .map(
        ([directive, scheme]) => `${directive} ${scheme}://${target.hostname}`,
      )
      .join(", ")}. Add it to the Content-Security-Policy before deploying.`,
  );
  process.exit(1);
}
console.log(`${target.origin} is allowed by the Content-Security-Policy.`);

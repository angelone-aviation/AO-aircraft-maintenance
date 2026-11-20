#!/usr/bin/env node
/**
 * Responsibility: Checks that the Content-Security-Policy in public/_headers
 *   lets the app reach a Convex deployment and its file links
 *   (`check-csp-origin.mjs <url> [site-url]`) or a Sentry DSN's ingest host
 *   (`check-csp-origin.mjs --sentry-dsn <dsn>`).
 * Layer: Script. Read-only release check; exits 1 when the policy blocks it.
 * Dependencies: node:fs.
 *
 * A source allows its exact host or, written `*.host`, any subdomain of it; a
 * source with a port or a path never matches. A source without a port covers
 * only the scheme's default port, so a URL naming another port is refused.
 * An empty DSN passes, because error reporting is then off.
 */
import { readFileSync } from "node:fs";

// The cloud host carries the API over HTTPS and WebSocket. Files open
// through short-lived links on the deployment's site host, which the app both
// fetches and draws as images (docs/file-links.md); no image loads from
// storage on the cloud host.
const CLOUD_SOURCES = [
  ["connect-src", "https"],
  ["connect-src", "wss"],
];
const SITE_SOURCES = [
  ["connect-src", "https"],
  ["img-src", "https"],
];
// The SDK only posts events to the DSN's host.
const SENTRY_SOURCES = [["connect-src", "https"]];
const HOST_SOURCE = /^([a-z]+):\/\/(\*\.)?([^/:]+)$/;
const CLOUD_SUFFIX = ".convex.cloud";
const SITE_SUFFIX = ".convex.site";

const policy = readPolicy();
const args = process.argv.slice(2);
if (args[0] === "--sentry-dsn") checkSentryDsn(args[1]);
else checkConvex(args[0], args[1]);

function checkConvex(urlText, siteText) {
  const cloud = parseUrl(urlText, "The Convex URL");
  assertDefaultHttps(cloud.origin, cloud);
  const site =
    siteText === undefined
      ? siteOf(cloud)
      : parseUrl(siteText, "The Convex site URL");
  assertDefaultHttps(site.origin, site);
  checkOrigin(cloud.origin, [
    ...onHost(CLOUD_SOURCES, cloud.hostname),
    ...onHost(SITE_SOURCES, site.hostname),
  ]);
}

function checkSentryDsn(dsn) {
  if (dsn === undefined)
    exitWithError("Usage: check-csp-origin.mjs --sentry-dsn <dsn>");
  if (dsn === "") {
    console.log("No Sentry DSN: error reporting stays off.");
    return;
  }
  const target = parseUrl(dsn, "The Sentry DSN");
  const name = `Sentry ingest host ${target.origin}`;
  assertDefaultHttps(name, target);
  checkOrigin(name, onHost(SENTRY_SOURCES, target.hostname));
}

function checkOrigin(name, required) {
  const missing = required.filter(
    ([directive, scheme, hostname]) => !allows(directive, scheme, hostname),
  );
  if (missing.length) exitWithError(describeMissing(name, missing));
  console.log(`${name} is allowed by the Content-Security-Policy.`);
}

function assertDefaultHttps(name, target) {
  if (target.protocol !== "https:") exitWithError(`${name} must use https.`);
  if (target.port)
    exitWithError(
      `${name} must use the default https port (443): the policy's sources name no port.`,
    );
}

// A deployment at <name>.convex.cloud answers its HTTP actions at
// <name>.convex.site; a custom domain's site cannot be guessed.
function siteOf(cloud) {
  const name = cloud.hostname.slice(0, -CLOUD_SUFFIX.length);
  if (!cloud.hostname.endsWith(CLOUD_SUFFIX) || !name)
    exitWithError(
      `${cloud.origin} is not a Convex cloud deployment (<name>${CLOUD_SUFFIX}); pass its HTTP actions URL as a second argument.`,
    );
  return new URL(`https://${name}${SITE_SUFFIX}`);
}

function onHost(sources, hostname) {
  return sources.map(([directive, scheme]) => [directive, scheme, hostname]);
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

function describeMissing(name, required) {
  const sources = required
    .map(
      ([directive, scheme, hostname]) => `${directive} ${scheme}://${hostname}`,
    )
    .join(", ");
  return `${name} is not allowed by public/_headers: ${sources}. Add it to the Content-Security-Policy before deploying.`;
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Responsibility: Narrows the built Content-Security-Policy to one Convex
 *   deployment: `pin-csp-origin.mjs <convex-url> [headers-file]` rewrites the
 *   `*.convex.cloud` and `*.convex.site` sources to that deployment's hosts.
 * Layer: Script. Deploy step on dist/_headers (the default file); exits 1,
 *   leaving the file unchanged, on any refusal.
 * Dependencies: node:fs.
 *
 * public/_headers keeps the wildcards, because local, demo and browser-test
 * builds talk to other deployments or none; only the published build names
 * production's own hosts, so no other Convex deployment can be reached from
 * the live site (security review C3).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_HEADERS = fileURLToPath(
  new URL("../dist/_headers", import.meta.url),
);
const CLOUD_SUFFIX = ".convex.cloud";
const SITE_SUFFIX = ".convex.site";
const POLICY_LINE = /^(\s*Content-Security-Policy:\s*)(.+)$/m;

const [url, file = DEFAULT_HEADERS] = process.argv.slice(2);
const cloud = deploymentHost(url);
const site = cloud.slice(0, -CLOUD_SUFFIX.length) + SITE_SUFFIX;
const headers = readFileSync(file, "utf8");
const policy = headers.match(POLICY_LINE)?.[2];
if (!policy) exitWithError(`${file} has no Content-Security-Policy.`);
const pinned = pinSources(policy, {
  "https://*.convex.cloud": `https://${cloud}`,
  "wss://*.convex.cloud": `wss://${cloud}`,
  "https://*.convex.site": `https://${site}`,
});
if (pinned.includes("*.convex."))
  exitWithError(`${file} still allows other Convex deployments: ${pinned}`);
writeFileSync(
  file,
  headers.replace(POLICY_LINE, (_line, prefix) => prefix + pinned),
);
console.log(`Content-Security-Policy pinned to ${cloud} and ${site}.`);

// Production's URL is https://<name>[.<region>].convex.cloud; its HTTP actions
// answer on the same name under convex.site.
function deploymentHost(text) {
  if (!URL.canParse(text ?? ""))
    exitWithError("The Convex URL is not a valid URL.");
  const target = new URL(text);
  if (target.protocol !== "https:")
    exitWithError(`${target.origin} must use https.`);
  const name = target.hostname.slice(0, -CLOUD_SUFFIX.length);
  if (!target.hostname.endsWith(CLOUD_SUFFIX) || !name)
    exitWithError(
      `${target.origin} is not a Convex cloud deployment (<name>${CLOUD_SUFFIX}); pin a custom domain in public/_headers by hand.`,
    );
  return target.hostname;
}

// Every wildcard must be present before and gone after, so a policy edited
// out of step with this script stops the deploy instead of shipping unpinned.
function pinSources(text, replacements) {
  const sources = text.split(/(\s+)/);
  for (const wildcard of Object.keys(replacements))
    if (!sources.includes(wildcard) && !sources.includes(`${wildcard};`))
      exitWithError(`${file} has no ${wildcard} source to pin.`);
  return sources
    .map((source) => {
      const bare = source.replace(/;$/, "");
      const exact = replacements[bare];
      return exact ? source.replace(bare, exact) : source;
    })
    .join("");
}

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

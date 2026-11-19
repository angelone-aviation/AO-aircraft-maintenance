#!/usr/bin/env node
/**
 * Responsibility: The load test's hard guard: refuses to run unless the app,
 *   the Convex CLI and the browser's app address all stay on this machine.
 * Layer: Script. First call of every load-test entry script, imported or run
 *   by the shell scripts (`node scripts/loadtest/guard.mjs`); never the app.
 * Dependencies: node:fs, node:path, node:url.
 *
 * The load test imports, replaces and deletes table rows. Aimed at a cloud
 * deployment it would overwrite real maintenance records, so it checks the
 * URL the app uses, the deployment the CLI would use and the variables that
 * would send the CLI elsewhere, before anything else runs.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Plain http to localhost or 127.0.0.1 with a port: a backend on this machine. */
export const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1):/;

/** The repository root, whose .env.local names the backend. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Where `node scripts/serve-dist.mjs --report-csp --port 4391` serves the build. */
export const DEFAULT_APP_URL = "http://127.0.0.1:4391/";

// `convex dev --local` writes "local:…", or "anonymous:…" when signed out.
const LOCAL_DEPLOYMENT = /^(local|anonymous):/;
// Each one points the Convex CLI at a deployment other than .env.local's.
const REMOTE_CLI_VARIABLES = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
];
const REFUSAL = "The load test runs only against a local Convex backend";

/**
 * Checks the backend the load test would reach, before it does anything.
 *
 * @param env - The process environment; CONVEX_DEPLOYMENT here wins over
 *   .env.local's, as it does for the Convex CLI.
 * @param root - The repository root.
 * @returns The local backend URL (VITE_CONVEX_URL from .env.local).
 * @throws {Error} "The load test runs only against a local Convex backend:
 *   <what>." naming the first variable that is not local; a credential is
 *   named, never printed.
 */
export function localBackendUrl(env = process.env, root = REPO_ROOT) {
  const remote = REMOTE_CLI_VARIABLES.find((name) => env[name]);
  if (remote)
    refuse(`${remote} is set and would send the Convex CLI elsewhere`);
  const file = readEnvFile(path.join(root, ".env.local"));
  const url = file.VITE_CONVEX_URL ?? "";
  if (!LOCAL_URL.test(url)) refuse(`VITE_CONVEX_URL is ${url || "not set"}`);
  const deployment = env.CONVEX_DEPLOYMENT || file.CONVEX_DEPLOYMENT || "";
  if (!LOCAL_DEPLOYMENT.test(deployment))
    refuse(`CONVEX_DEPLOYMENT is ${deployment || "not set"}`);
  return url;
}

/**
 * The address of the production build the browser scripts drive, once the
 * backend behind it has passed {@link localBackendUrl}.
 *
 * @param env - The process environment; ANGELONE_URL overrides the default.
 * @returns ANGELONE_URL, or {@link DEFAULT_APP_URL}.
 * @throws {Error} As {@link localBackendUrl}, or "…: ANGELONE_URL is <url>."
 */
export function localAppUrl(env = process.env) {
  localBackendUrl(env);
  const url = env.ANGELONE_URL || DEFAULT_APP_URL;
  if (!LOCAL_URL.test(url)) refuse(`ANGELONE_URL is ${url}`);
  return url;
}

// Convex writes `NAME=value # comment`; only the value counts.
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const entries = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=([^#]*)/))
    .filter(Boolean)
    .map(([, name, value]) => [name, value.trim()]);
  return Object.fromEntries(entries);
}

function refuse(reason) {
  throw new Error(`${REFUSAL}: ${reason}.`);
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) process.exitCode = checkFromShell();

// From the shell, ANGELONE_URL is checked too when it is set.
function checkFromShell() {
  try {
    const backend = localBackendUrl();
    if (process.env.ANGELONE_URL) localAppUrl();
    console.log(`Local Convex backend: ${backend}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

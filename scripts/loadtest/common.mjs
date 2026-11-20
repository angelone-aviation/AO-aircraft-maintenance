/**
 * Responsibility: What the load-test scripts share: the repository and data
 *   folders, signing in to the local backend, the Convex CLI and result lines.
 * Layer: Script. Imported by the load-test entry scripts only; every helper
 *   that reaches a backend checks it with ./guard.mjs first.
 * Dependencies: convex/browser, convex/_generated/api.js, ./guard.mjs,
 *   node:child_process, node:fs, node:path.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { localBackendUrl, REPO_ROOT } from "./guard.mjs";

export { api, REPO_ROOT };

/**
 * The load test's own folder (LOADTEST_DIR): the volume model, generated
 * data, test accounts, results, screenshots and logs.
 *
 * @throws {Error} At import, "Set LOADTEST_DIR …" when it is unset.
 */
export const DATA_DIR = readDataDir();

// `convex data` and `convex import` can print whole tables.
const CLI_OUTPUT_LIMIT_BYTES = 1 << 28;

/**
 * Signs a test account in to the local backend with its password.
 *
 * @param email - The account's email.
 * @param password - Its password; never printed.
 * @returns A client carrying the account's session.
 * @throws {Error} As the guard, before any request; "Sign-in failed for
 *   <email>" when the backend returns no token.
 */
export async function signIn(email, password) {
  const client = new ConvexHttpClient(localBackendUrl());
  const login = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", email, password },
  });
  if (!login.tokens?.token) throw new Error("Sign-in failed for " + email);
  client.setAuth(login.tokens.token);
  return client;
}

/**
 * Runs the Convex CLI in the repository against the local backend, without
 * throwing on its exit code.
 *
 * @param args - The arguments after `npx convex`.
 * @returns The spawnSync result.
 * @throws {Error} As the guard, before the CLI starts.
 */
export function spawnConvex(args) {
  localBackendUrl();
  return spawnSync("npx", ["convex", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: CLI_OUTPUT_LIMIT_BYTES,
  });
}

/**
 * Runs the Convex CLI as {@link spawnConvex} does and times it.
 *
 * @param args - The arguments after `npx convex`.
 * @returns Its standard output and how long it took.
 * @throws {Error} "convex <args> failed:" with both outputs, on a non-zero
 *   exit.
 */
export function runConvex(args) {
  const started = Date.now();
  const result = spawnConvex(args);
  if (result.status !== 0)
    throw new Error(
      `convex ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  return { out: result.stdout, ms: Date.now() - started };
}

/**
 * Names a step of the sweep by the years of history loaded: 3 is "y03".
 *
 * @param years - Years loaded, 1 to 20.
 */
export function sliceName(years) {
  return "y" + String(years).padStart(2, "0");
}

/**
 * Reads a JSON file.
 *
 * @param file - Its path.
 * @throws {Error} When it is missing or not JSON.
 */
export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Appends one measurement to DATA_DIR/results/<area>.jsonl, in the line
 * format of scripts/loadtest/README.md.
 *
 * @param line - The measurement; its `area` ("server" or "browser") names
 *   the file.
 */
export function appendResult(line) {
  const folder = path.join(DATA_DIR, "results");
  mkdirSync(folder, { recursive: true });
  appendFileSync(
    path.join(folder, `${line.area}.jsonl`),
    JSON.stringify(line) + "\n",
  );
}

/**
 * Where a screenshot goes: DATA_DIR/shots/<name>, the folder made if needed.
 *
 * @param name - The file name.
 */
export function shotPath(name) {
  const folder = path.join(DATA_DIR, "shots");
  mkdirSync(folder, { recursive: true });
  return path.join(folder, name);
}

/**
 * A failure's message as recorded: a ConvexError's data, else its message.
 *
 * @param error - What was thrown.
 * @param limit - The most characters kept.
 */
export function errorText(error, limit) {
  return String(error?.data ?? error?.message ?? error).slice(0, limit);
}

function readDataDir() {
  const folder = process.env.LOADTEST_DIR;
  if (!folder)
    throw new Error(
      "Set LOADTEST_DIR to the folder for the load test's data and results.",
    );
  return path.resolve(folder);
}

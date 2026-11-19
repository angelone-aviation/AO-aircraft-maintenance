/**
 * Responsibility: Pins the load test's hard guard: it passes only when the
 *   app's URL, the Convex CLI's deployment and the browser's app address are
 *   all on this machine, and names what it refused.
 * Layer: Test. Runs a copy of scripts/loadtest/guard.mjs beside a temporary
 *   .env.local.
 * Dependencies: vitest, scripts/loadtest/guard.mjs.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = path.resolve(__dirname, "loadtest", "guard.mjs");
const LOCAL_ENV = [
  "# Deployment used by `npx convex dev`",
  "CONVEX_DEPLOYMENT=anonymous:anonymous-angel-one # team: none",
  "VITE_CONVEX_URL=http://127.0.0.1:3210",
].join("\n");
const REFUSAL = "The load test runs only against a local Convex backend";
// Variables the CLI would follow to a deployment other than .env.local's.
const NO_REMOTE_VARIABLES = {
  CONVEX_DEPLOY_KEY: "",
  CONVEX_DEPLOYMENT_TOKEN: "",
  CONVEX_SELF_HOSTED_URL: "",
  CONVEX_DEPLOYMENT: "",
  ANGELONE_URL: "",
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "loadtest-guard-"));
  mkdirSync(path.join(root, "scripts", "loadtest"), { recursive: true });
  copyFileSync(GUARD, path.join(root, "scripts", "loadtest", "guard.mjs"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scripts/loadtest/guard.mjs", () => {
  it("passes a local backend that the CLI also reaches locally", () => {
    const run = guard(LOCAL_ENV);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("Local Convex backend: http://127.0.0.1:3210\n");
  });

  it("passes localhost and a signed-in local deployment", () => {
    const env = [
      "CONVEX_DEPLOYMENT=local:local-team-angel_one",
      "VITE_CONVEX_URL=http://localhost:3210",
    ].join("\n");

    expect(guard(env).status).toBe(0);
  });

  it.each([
    ["a cloud deployment", "https://happy-otter-123.convex.cloud"],
    ["https on this machine", "https://127.0.0.1:3210"],
    ["a host that only starts with localhost", "http://localhost.example:80"],
    ["a host that only starts with 127.0.0.1", "http://127.0.0.1.nip.io:80"],
    ["no port", "http://127.0.0.1"],
  ])("refuses %s as the app's URL", (_, url) => {
    const run = guard(LOCAL_ENV.replace("http://127.0.0.1:3210", url));

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`${REFUSAL}: VITE_CONVEX_URL is ${url}.\n`);
  });

  it("refuses a cloud deployment for the CLI behind a local URL", () => {
    const run = guard(
      LOCAL_ENV.replace(
        "anonymous:anonymous-angel-one # team: none",
        "prod:happy-otter-123",
      ),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `${REFUSAL}: CONVEX_DEPLOYMENT is prod:happy-otter-123.\n`,
    );
  });

  it("follows CONVEX_DEPLOYMENT from the shell, as the CLI does", () => {
    const run = guard(LOCAL_ENV, { CONVEX_DEPLOYMENT: "dev:happy-otter-123" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("CONVEX_DEPLOYMENT is dev:happy-otter-123.");
  });

  it.each([
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
  ])("refuses when %s is set, without printing it", (name) => {
    const run = guard(LOCAL_ENV, { [name]: "prod:secret-value" });

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `${REFUSAL}: ${name} is set and would send the Convex CLI elsewhere.\n`,
    );
  });

  it("refuses when there is no .env.local", () => {
    const run = guard(undefined);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`${REFUSAL}: VITE_CONVEX_URL is not set.\n`);
  });

  it("refuses a browser app address that is not on this machine", () => {
    const run = guard(LOCAL_ENV, { ANGELONE_URL: "https://ops.example.org/" });

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `${REFUSAL}: ANGELONE_URL is https://ops.example.org/.\n`,
    );
  });
});

function guard(envFile: string | undefined, env: Record<string, string> = {}) {
  if (envFile !== undefined)
    writeFileSync(path.join(root, ".env.local"), envFile);
  const script = path.join(root, "scripts", "loadtest", "guard.mjs");
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...NO_REMOTE_VARIABLES, ...env },
  });
}

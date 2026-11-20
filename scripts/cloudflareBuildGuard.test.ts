/**
 * Responsibility: Pins that a build refuses to run in Cloudflare's Git
 *   builder and runs everywhere else.
 * Layer: Test. Calls the guard, and starts `vite build` once with the
 *   builder's variable set; that build stops before writing anything.
 * Dependencies: vitest, node:child_process, node:fs, node:os,
 *   scripts/cloudflareBuildGuard.ts, vite.config.ts.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNotCloudflareGitBuild,
  CLOUDFLARE_BUILD_REFUSAL,
  WORKERS_BUILDS_VARIABLE,
} from "./cloudflareBuildGuard";

const REPO_ROOT = path.resolve(__dirname, "..");
const VITE_BUILD_TIMEOUT_MS = 60_000;

describe("assertNotCloudflareGitBuild", () => {
  it("refuses when Workers Builds' variable is set", () => {
    expect(() =>
      assertNotCloudflareGitBuild({ [WORKERS_BUILDS_VARIABLE]: "1" }),
    ).toThrow(CLOUDFLARE_BUILD_REFUSAL);
  });

  it("allows CI, Deploy and demo builds, which lack the variable", () => {
    for (const env of [
      {},
      { CI: "true", GITHUB_ACTIONS: "true" },
      { VITE_ALLOW_DEMO: "true" },
      { [WORKERS_BUILDS_VARIABLE]: "" },
    ])
      expect(() => assertNotCloudflareGitBuild(env)).not.toThrow();
  });
});

it(
  "stops vite build in Cloudflare's Git builder",
  () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "cf-build-"));
    const result = spawnSync("npx", ["vite", "build", "--outDir", outDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, [WORKERS_BUILDS_VARIABLE]: "1" },
    });
    rmSync(outDir, { recursive: true, force: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(CLOUDFLARE_BUILD_REFUSAL);
  },
  VITE_BUILD_TIMEOUT_MS,
);

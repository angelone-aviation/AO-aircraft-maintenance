/**
 * Responsibility: Pins the Deploy workflow's release guards: only the newest
 *   commit on main is released, and a manual run needs a green CI run for
 *   that commit unless the emergency override is ticked.
 * Layer: Test. Runs the two guard steps' shell from deploy.yml against a
 *   throwaway git repository and a fake `gh`; never contacts GitHub.
 * Dependencies: vitest, git, bash, jq, .github/workflows/deploy.yml.
 *
 * The workflow itself only runs on GitHub, so this is the one place its
 * guards are exercised before a release depends on them. The suite is skipped
 * where jq is missing; CI's runner has it.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOW = path.resolve(__dirname, "../.github/workflows/deploy.yml");
const NEWEST_STEP = "Require the newest commit on main";
const GREEN_CI_STEP = "Require green CI for a manual run";
const REPOSITORY = "example-org/example-repo";
const OTHER_SHA = "f".repeat(40);
// The indentation of a step's script lines under `run: |` in deploy.yml.
const SCRIPT_INDENT = " ".repeat(10);

// `gh api <url> --jq <filter>`: answers from runs.json through the real jq,
// so the workflow's own filter is what selects the runs.
const FAKE_GH = `#!/bin/sh
echo "$2" >> "$FAKE_DIR/gh-calls.log"
if [ -n "$FAKE_GH_FAILS" ]; then
  echo "HTTP 502: Bad Gateway" >&2
  exit 1
fi
exec jq -r "$4" "$FAKE_DIR/runs.json"
`;

interface CiRun {
  readonly head_sha: string;
  readonly event: string;
  readonly head_branch: string;
  readonly conclusion: string | null;
}

const jqInstalled = spawnSync("jq", ["--version"]).status === 0;

let dir: string;
let older: string;
let newest: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deploy-workflow-"));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "gh"), FAKE_GH);
  chmodSync(path.join(dir, "bin", "gh"), 0o755);
  git("init", "--quiet");
  older = commit("older release");
  newest = commit("newest release");
  git("update-ref", "refs/remotes/origin/main", newest);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Deploy: only the newest commit on main", () => {
  it("releases the newest commit", () => {
    expect(runStep(NEWEST_STEP, { DEPLOY_SHA: newest }).status).toBe(0);
  });

  it("stops for an older commit, as a re-run of an old CI or Deploy run names", () => {
    const run = runStep(NEWEST_STEP, { DEPLOY_SHA: older });

    expect(run.status).toBe(1);
    expect(run.output).toContain(
      `::error::Commit ${older.slice(0, 12)} is not the newest commit on main (${newest.slice(0, 12)})`,
    );
  });
});

describe.skipIf(!jqInstalled)("Deploy: a manual run needs green CI", () => {
  it("passes when CI passed for this commit's push to main", () => {
    const run = runGreenCiStep([ciRun({})]);

    expect(run.status).toBe(0);
    expect(run.ghCalls).toEqual([
      `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${newest}&per_page=100`,
    ]);
  });

  it.each<[string, Partial<CiRun>]>([
    ["CI failed", { conclusion: "failure" }],
    ["CI is still running", { conclusion: null }],
    ["only a pull-request run passed", { event: "pull_request" }],
    ["the green run was for another branch", { head_branch: "topic" }],
    ["the green run was for another commit", { head_sha: OTHER_SHA }],
  ])("stops when %s", (_case, difference) => {
    const result = runGreenCiStep([ciRun(difference)]);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `::error::CI has not passed for commit ${newest.slice(0, 12)}`,
    );
  });

  it("stops when CI never ran for this commit", () => {
    expect(runGreenCiStep([]).status).toBe(1);
  });

  it("stops when the CI runs cannot be read", () => {
    const run = runGreenCiStep([ciRun({})], { FAKE_GH_FAILS: "yes" });

    expect(run.status).toBe(1);
    expect(run.output).toContain("::error::Could not read the CI runs");
  });

  it("deploys without green CI only with the emergency override, and says so", () => {
    const run = runGreenCiStep([ciRun({ conclusion: "failure" })], {
      WITHOUT_GREEN_CI: "true",
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain("::warning::Emergency override");
    expect(run.ghCalls).toEqual([]);
  });
});

function ciRun(overrides: Partial<CiRun>): CiRun {
  return {
    head_sha: newest,
    event: "push",
    head_branch: "main",
    conclusion: "success",
    ...overrides,
  };
}

function runGreenCiStep(runs: readonly CiRun[], env: NodeJS.ProcessEnv = {}) {
  writeFileSync(
    path.join(dir, "runs.json"),
    JSON.stringify({ workflow_runs: runs }),
  );
  writeFileSync(path.join(dir, "gh-calls.log"), "");
  const run = runStep(GREEN_CI_STEP, {
    DEPLOY_SHA: newest,
    GITHUB_REPOSITORY: REPOSITORY,
    WITHOUT_GREEN_CI: "false",
    FAKE_DIR: dir,
    ...env,
  });
  const calls = readFileSync(path.join(dir, "gh-calls.log"), "utf8").trim();
  return { ...run, ghCalls: calls === "" ? [] : calls.split("\n") };
}

// GitHub runs a step's `run:` script with these bash options on Linux.
function runStep(name: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepScript(name)],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
        ...env,
      },
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Reads one step's `run: |` block out of deploy.yml: the lines indented under
 * it, up to the next line indented less.
 */
function stepScript(name: string): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const step = lines.indexOf(`      - name: ${name}`);
  const run = lines.indexOf("        run: |", step);
  if (step < 0 || run < 0) throw new Error(`deploy.yml has no step "${name}".`);
  const body = lines.slice(run + 1);
  const end = body.findIndex(
    (line) => line.trim() !== "" && !line.startsWith(SCRIPT_INDENT),
  );
  return body
    .slice(0, end < 0 ? body.length : end)
    .map((line) => line.slice(SCRIPT_INDENT.length))
    .join("\n");
}

function commit(message: string): string {
  git("commit", "--quiet", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD").trim();
}

function git(...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

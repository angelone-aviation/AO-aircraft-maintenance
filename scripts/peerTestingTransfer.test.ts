/**
 * Responsibility: Characterizes peer-testing-transfer.mjs: target checks, the
 *   empty-target guard, call order, kept keys, redaction and the site build.
 * Layer: Test. Runs a copy of the script in a temporary repository tree with
 *   fake npx, python3 and npm first on PATH.
 * Dependencies: vitest, scripts/peer-testing-transfer.mjs, jose.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "peer-testing-transfer.mjs");
const NODE_MODULES = path.resolve(__dirname, "..", "node_modules");
const DEPLOYMENT = "https://happy-otter-123.convex.cloud";
const DEPLOY_KEY = "prod:happy-otter-123|fixture-deploy-secret";
const ADMIN_KEY = "fixture-local-admin-key";
const SITE = "https://peers.example.org";
const HTACCESS = "RewriteEngine On\n";
const FAILED = "No automatic overwrite or retry was performed.";

// `export` prints the admin key and `deploy` the deploy key, so the output
// shows whether they were redacted.
const FAKE_NPX = `#!/bin/sh
echo "npx $*" >> "$FAKE_ROOT/calls.log"
shift
[ "$1" = "$FAKE_FAIL" ] && exit 1
case "$1" in
  export) cat "$3"; : > "$6" ;;
  data)
    if [ "$2" = --env-file ]; then printf '%s' "$FAKE_TABLES"
    else printf '%s' "\${FAKE_ROWS:-[]}"; fi ;;
  deploy) cat "$FAKE_ROOT/.env.peer-testing" ;;
  env)
    if [ "$2" = get ]; then
      case " $FAKE_STORED " in *" $3 "*) echo "stored-$3" ;; esac
    else cat > "$FAKE_ROOT/set-$3"; fi ;;
esac
exit 0
`;
const FAKE_PYTHON = `#!/bin/sh
if [ -n "$4" ]; then
  echo "python3 counts $3 $4" >> "$FAKE_ROOT/calls.log"
  printf '%s' "$FAKE_COUNTS" > "$4"
else
  echo "python3 archive" >> "$FAKE_ROOT/calls.log"
fi
`;
const FAKE_NPM = `#!/bin/sh
echo "npm $* $VITE_CONVEX_URL $VITE_DEMO_MODE" >> "$FAKE_ROOT/calls.log"
mkdir -p dist-peer-testing
`;

interface Fakes {
  readonly tables?: string;
  readonly rows?: string;
  readonly stored?: string;
  readonly counts?: string;
  readonly fail?: string;
}

let root: string;
let area: string;
let envFile: string;
let snapshot: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "peer-testing-")));
  area = path.join(root, ".convex", "peer-testing");
  envFile = path.join(root, ".env.peer-testing");
  snapshot = path.join(area, "local-1.zip");
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "public"));
  copyFileSync(SCRIPT, path.join(root, "scripts", "peer-testing-transfer.mjs"));
  symlinkSync(NODE_MODULES, path.join(root, "node_modules"));
  writeExecutable("npx", FAKE_NPX);
  writeExecutable("python3", FAKE_PYTHON);
  writeExecutable("npm", FAKE_NPM);
  writeFileSync(path.join(root, "public", ".htaccess"), HTACCESS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("export", () => {
  it("saves the local backend and points transfer at the snapshot", () => {
    writeJson(".convex/local/default/config.json", { adminKey: ADMIN_KEY });

    const run = runScript("export");

    expect(run.status).toBe(0);
    const [exportCall, countsCall] = run.calls;
    const match = exportCall.match(
      /^npx convex export --env-file (\S+) --include-file-storage --path (\S+)$/,
    );
    expect(match?.[2]).toMatch(new RegExp(`^${area}/local-\\d+\\.zip$`));
    expect(existsSync(match?.[1] ?? "")).toBe(false);
    expect(countsCall).toBe(
      `python3 counts ${match?.[2]} ${area}/source-counts.json`,
    );
    expect(readFileSync(path.join(area, "latest-snapshot.txt"), "utf8")).toBe(
      match?.[2],
    );
    expect(run.stdout).toContain(
      "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\n" +
        "CONVEX_SELF_HOSTED_ADMIN_KEY=<REDACTED>",
    );
    expect(run.stdout).not.toContain(ADMIN_KEY);
    expect(run.stdout).toContain(
      `Local data and attachments saved to ${match?.[2]}`,
    );
  });
});

describe("target checks", () => {
  it.each([
    [
      { VITE_CONVEX_URL: "http://happy-otter-123.convex.cloud" },
      "Use the HTTPS Convex deployment URL.",
    ],
    [
      { VITE_CONVEX_URL: "https://convex.example.org" },
      "Use the HTTPS Convex deployment URL.",
    ],
    [
      { SITE_URL: "https://peers.example.org/app" },
      "Use an HTTPS domain or subdomain root for A2 testing.",
    ],
    [
      { SITE_URL: "https://peers.example.org/?x=1" },
      "Use an HTTPS domain or subdomain root for A2 testing.",
    ],
    [
      { CONVEX_DEPLOY_KEY: "prod:other-deployment-9|secret" },
      "The production deploy key must match the specified deployment URL.",
    ],
    [
      { CONVEX_DEPLOY_KEY: "dev:happy-otter-123|secret" },
      "The production deploy key must match the specified deployment URL.",
    ],
  ])("refuses %o before any command", (override, message) => {
    writeTargetEnv(override);

    const run = runScript("transfer");

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
    expect(run.calls).toEqual([]);
  });

  it("refuses an unknown mode after checking the target", () => {
    writeTargetEnv();

    const run = runScript("publish");

    expect(run.status).toBe(1);
    expect(run.stderr).toBe("Choose export, transfer, or build.\n");
    expect(run.calls).toEqual([]);
  });
});

describe("transfer", () => {
  beforeEach(() => {
    writeTargetEnv();
    writeJson(".convex/peer-testing/source-counts.json", {
      workOrders: 2,
      management: 3,
    });
    writeFileSync(snapshot, "zip");
    writeFileSync(path.join(area, "latest-snapshot.txt"), `${snapshot}\n`);
  });

  it("refuses an export without work orders or components", () => {
    writeJson(".convex/peer-testing/source-counts.json", {
      workOrders: 2,
      management: 0,
    });

    const run = runScript("transfer");

    expect(run.stderr).toBe(
      "This export lacks the expected work orders or components. Identify the correct source database before transferring.\n",
    );
    expect(run.calls).toEqual([]);
  });

  it("refuses a target table that holds data", () => {
    const run = runScript("transfer", {
      tables: "users\naircraft\n",
      rows: '[{"_id":"1"}]',
    });

    expect(run.stderr).toBe(
      "Target table users contains data. Use an empty peer-testing deployment.\n",
    );
    expect(run.calls).toEqual([
      `npx convex data --env-file ${envFile}`,
      `npx convex data users --limit 1 --format json --env-file ${envFile}`,
    ]);
  });

  it("refuses a table listing it cannot read", () => {
    const run = runScript("transfer", { tables: "There are no tables." });

    expect(run.stderr).toBe(
      "Could not verify the target is empty. Check it in the Convex dashboard.\n",
    );
  });

  it("refuses a snapshot that no longer exists", () => {
    rmSync(snapshot);

    const run = runScript("transfer", { tables: "" });

    expect(run.stderr).toBe("Export the local database first.\n");
    expect(run.calls).toEqual([`npx convex data --env-file ${envFile}`]);
  });

  it("refuses to repeat a completed transfer", () => {
    writeJson(".convex/peer-testing/transfer-complete.json", {
      deployment: DEPLOYMENT,
    });

    const run = runScript("transfer", { tables: "" });

    expect(run.stderr).toBe(
      "A transfer was already completed. Use the build command to rebuild the website; do not repeat the import.\n",
    );
    expect(run.calls).toEqual([`npx convex data --env-file ${envFile}`]);
  });

  it("deploys, imports, sets missing keys, then builds the site", () => {
    const run = runScript("transfer", { tables: "aircraft\n" });

    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      `npx convex data --env-file ${envFile}`,
      `npx convex data aircraft --limit 1 --format json --env-file ${envFile}`,
      `npx convex deploy --yes --env-file ${envFile}`,
      `npx convex import ${snapshot} --env-file ${envFile}`,
      `npx convex env get JWT_PRIVATE_KEY --env-file ${envFile}`,
      `npx convex env set JWT_PRIVATE_KEY --env-file ${envFile}`,
      `npx convex env set JWKS --env-file ${envFile}`,
      `npx convex env get CREDENTIALS_ENCRYPTION_KEY --env-file ${envFile}`,
      `npx convex env set CREDENTIALS_ENCRYPTION_KEY --env-file ${envFile}`,
      `npx convex env set SITE_URL --env-file ${envFile}`,
      `npm run build -- --outDir dist-peer-testing ${DEPLOYMENT} false`,
      "python3 archive",
    ]);
    expect(readSet("SITE_URL")).toBe(SITE);
    expect(readSet("JWT_PRIVATE_KEY")).toMatch(/^-----BEGIN PRIVATE KEY----- /);
    expect(JSON.parse(readSet("JWKS")).keys[0]).toMatchObject({ use: "sig" });
    expect(
      Buffer.from(readSet("CREDENTIALS_ENCRYPTION_KEY"), "base64"),
    ).toHaveLength(32);
    const record = JSON.parse(
      readFileSync(path.join(area, "transfer-complete.json"), "utf8"),
    );
    expect(record).toMatchObject({ deployment: DEPLOYMENT, snapshot });
    expect(
      readFileSync(path.join(root, "dist-peer-testing", ".htaccess"), "utf8"),
    ).toBe(HTACCESS);
    expect(run.stdout).toContain("CONVEX_DEPLOY_KEY=<REDACTED>");
    expect(run.stdout).not.toContain(DEPLOY_KEY);
    expect(run.stdout).toContain("New credential encryption key set.");
    expect(run.stdout).toContain(
      "Cloud copy complete. Local configuration and records are unchanged.",
    );
  });

  it("keeps signing and encryption keys the target already has", () => {
    const run = runScript("transfer", {
      tables: "",
      stored: "JWT_PRIVATE_KEY CREDENTIALS_ENCRYPTION_KEY",
    });

    expect(run.status).toBe(0);
    expect(run.calls.filter((call) => call.includes(" env set "))).toEqual([
      `npx convex env set SITE_URL --env-file ${envFile}`,
    ]);
    expect(run.stdout).not.toContain("New credential encryption key set.");
  });

  it("stops at the first command that fails", () => {
    const run = runScript("transfer", { tables: "", fail: "deploy" });

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`npx failed. ${FAILED}\n`);
    expect(run.calls.at(-1)).toBe(
      `npx convex deploy --yes --env-file ${envFile}`,
    );
    expect(existsSync(path.join(area, "transfer-complete.json"))).toBe(false);
  });
});

describe("build", () => {
  beforeEach(() => {
    writeTargetEnv();
  });

  it("refuses a deployment that was not transferred to", () => {
    writeJson(".convex/peer-testing/transfer-complete.json", {
      deployment: "https://other-deployment-9.convex.cloud",
    });

    const run = runScript("build");

    expect(run.stderr).toBe(
      "Complete transfer to this deployment before building.\n",
    );
    expect(run.calls).toEqual([]);
  });

  it("rebuilds the site without touching the deployment", () => {
    writeJson(".convex/peer-testing/transfer-complete.json", {
      deployment: DEPLOYMENT,
    });

    const run = runScript("build");

    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      `npm run build -- --outDir dist-peer-testing ${DEPLOYMENT} false`,
      "python3 archive",
    ]);
    expect(run.stdout).toContain(
      "Upload only .convex/peer-testing/a2-website.zip to A2. Never upload the database snapshot or .env files.",
    );
  });
});

function runScript(mode: string, fakes: Fakes = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "peer-testing-transfer.mjs"), mode],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
        FAKE_ROOT: root,
        FAKE_TABLES: fakes.tables ?? "",
        FAKE_ROWS: fakes.rows ?? "",
        FAKE_STORED: fakes.stored ?? "",
        FAKE_COUNTS: fakes.counts ?? "{}",
        FAKE_FAIL: fakes.fail ?? "",
      },
    },
  );
  return { ...result, calls: readCalls() };
}

function writeTargetEnv(override: Record<string, string> = {}) {
  const values = {
    VITE_CONVEX_URL: DEPLOYMENT,
    SITE_URL: SITE,
    CONVEX_DEPLOY_KEY: DEPLOY_KEY,
    ...override,
  };
  const lines = Object.entries(values).map(
    ([name, value]) => `${name}=${value}`,
  );
  writeFileSync(envFile, `${lines.join("\n")}\n`);
}

function writeJson(relativePath: string, value: object) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeExecutable(name: string, source: string) {
  const file = path.join(root, "bin", name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function readCalls(): string[] {
  const log = path.join(root, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n");
}

function readSet(name: string): string {
  return readFileSync(path.join(root, `set-${name}`), "utf8");
}

/**
 * Responsibility: Pins configure-auth.mjs's promises: existing signing and
 *   encryption keys and an existing site address are kept, a failed read
 *   stops it before anything is made or changed, and no key is printed.
 * Layer: Test. Runs the script against a fake `npx convex` first on PATH.
 * Dependencies: vitest, scripts/configure-auth.mjs.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "configure-auth.mjs");
const SITE_URL = "https://ops.example.org";
const SITE_URL_NAME = "SITE_URL";
const LOCAL_SITE_URL = "http://localhost:5173";
const NO_SITE_URL_IN_SHELL = "";
const SIGNING_KEY = "JWT_PRIVATE_KEY";
const ENCRYPTION_KEY = "CREDENTIALS_ENCRYPTION_KEY";
const NETWORK_FAILURE = "fetch failed: network unreachable";

// Matches Convex CLI 1.49: `env get` of an unset variable writes only a notice
// to stderr and exits 0, so a non-zero exit is always a failed read. `env set`
// keeps its stdin in a file named after the variable.
const FAKE_NPX = `#!/bin/sh
shift
echo "$*" >> "$FAKE_DIR/calls.log"
if [ "$2" = get ]; then
  if [ "$3" = "$FAKE_FAIL_GET" ]; then
    echo "${NETWORK_FAILURE}" >&2
    exit 1
  fi
  case " $FAKE_STORED " in
    *" $3 "*) echo "\${FAKE_VALUE:-stored-$3}"; exit 0 ;;
  esac
  echo "Environment variable \\"$3\\" not found" >&2
  exit 0
fi
cat > "$FAKE_DIR/$3"
`;

interface Deployment {
  readonly stored?: readonly string[];
  readonly failGet?: string;
  readonly value?: string;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "configure-auth-"));
  writeFileSync(path.join(dir, "npx"), FAKE_NPX);
  chmodSync(path.join(dir, "npx"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("configure-auth.mjs", () => {
  it("stops before making keys when the signing key cannot be read", () => {
    const run = runScript({ failGet: SIGNING_KEY });

    expect(run.status).toBe(1);
    expect(run.calls).toEqual([`env get ${SIGNING_KEY}`]);
    expect(run.output).toContain(NETWORK_FAILURE);
  });

  it("stops before making a key when the encryption key cannot be read", () => {
    const run = runScript({
      stored: [SIGNING_KEY],
      failGet: ENCRYPTION_KEY,
    });

    expect(run.status).toBe(1);
    expect(run.calls).toEqual([
      `env get ${SIGNING_KEY}`,
      `env get ${ENCRYPTION_KEY}`,
    ]);
    expect(run.output).toContain(NETWORK_FAILURE);
  });

  it("keeps existing keys and sets only the site address", () => {
    const run = runScript({ stored: [SIGNING_KEY, ENCRYPTION_KEY] });

    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      `env get ${SIGNING_KEY}`,
      `env get ${ENCRYPTION_KEY}`,
      "env set SITE_URL",
    ]);
    expect(stored("SITE_URL")).toBe(SITE_URL);
    expect(run.output).toContain("Existing signing key retained.");
    expect(run.output).toContain(
      "Existing credential encryption key retained.",
    );
  });

  it("makes missing keys and never prints them", () => {
    const run = runScript({});

    expect(run.status).toBe(0);
    expect(run.calls).toEqual(CALLS_WHEN_UNSET);
    const privateKey = stored(SIGNING_KEY);
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY----- \S/);
    expect(privateKey).not.toContain("\n");
    const jwks = JSON.parse(stored("JWKS"));
    expect(jwks.keys).toEqual([
      expect.objectContaining({ use: "sig", kty: "RSA", e: "AQAB" }),
    ]);
    const encryptionKey = stored(ENCRYPTION_KEY);
    expect(Buffer.from(encryptionKey, "base64")).toHaveLength(32);
    expect(run.output).not.toContain(privateKey.split(" ")[3]);
    expect(run.output).not.toContain(encryptionKey);
  });

  it("keeps an existing site address when SITE_URL is not in the shell", () => {
    const run = runScript(
      {
        stored: [SIGNING_KEY, ENCRYPTION_KEY, SITE_URL_NAME],
        value: SITE_URL,
      },
      NO_SITE_URL_IN_SHELL,
    );

    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      `env get ${SIGNING_KEY}`,
      `env get ${ENCRYPTION_KEY}`,
      `env get ${SITE_URL_NAME}`,
    ]);
    expect(run.output).toContain(`Existing site URL kept: ${SITE_URL}.`);
    expect(run.output).not.toContain(LOCAL_SITE_URL);
  });

  it("replaces an existing site address when SITE_URL is given", () => {
    const run = runScript({
      stored: [SIGNING_KEY, ENCRYPTION_KEY, SITE_URL_NAME],
      value: "https://old.example.org",
    });

    expect(run.status).toBe(0);
    expect(stored(SITE_URL_NAME)).toBe(SITE_URL);
    expect(run.output).toContain(`Site URL set to ${SITE_URL}.`);
  });

  it("sets the local default only when no site address is stored", () => {
    const run = runScript(
      { stored: [SIGNING_KEY, ENCRYPTION_KEY] },
      NO_SITE_URL_IN_SHELL,
    );

    expect(run.status).toBe(0);
    expect(run.calls.slice(-2)).toEqual([
      `env get ${SITE_URL_NAME}`,
      `env set ${SITE_URL_NAME}`,
    ]);
    expect(stored(SITE_URL_NAME)).toBe(LOCAL_SITE_URL);
    expect(run.output).toContain(
      `Site URL set to ${LOCAL_SITE_URL}, the local default.`,
    );
  });

  it("stops without setting a site address when the stored one cannot be read", () => {
    const run = runScript(
      { stored: [SIGNING_KEY, ENCRYPTION_KEY], failGet: SITE_URL_NAME },
      NO_SITE_URL_IN_SHELL,
    );

    expect(run.status).toBe(1);
    expect(run.calls).not.toContain(`env set ${SITE_URL_NAME}`);
    expect(run.output).toContain(NETWORK_FAILURE);
  });

  it("characterizes current behaviour: a stored value of null counts as unset", () => {
    const run = runScript({
      stored: [SIGNING_KEY, ENCRYPTION_KEY],
      value: "null",
    });

    expect(run.status).toBe(0);
    expect(run.calls).toEqual(CALLS_WHEN_UNSET);
  });
});

const CALLS_WHEN_UNSET = [
  `env get ${SIGNING_KEY}`,
  `env set ${SIGNING_KEY}`,
  "env set JWKS",
  `env get ${ENCRYPTION_KEY}`,
  `env set ${ENCRYPTION_KEY}`,
  "env set SITE_URL",
];

function runScript(deployment: Deployment, siteUrlInShell = SITE_URL) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      FAKE_DIR: dir,
      FAKE_STORED: (deployment.stored ?? []).join(" "),
      FAKE_FAIL_GET: deployment.failGet ?? "",
      FAKE_VALUE: deployment.value ?? "",
      SITE_URL: siteUrlInShell,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readCalls(),
  };
}

function readCalls(): string[] {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n");
}

function stored(name: string): string {
  return readFileSync(path.join(dir, name), "utf8");
}

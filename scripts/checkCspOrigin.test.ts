/**
 * Responsibility: Pins check-csp-origin.mjs's rules: https on its default
 *   port only, the three Convex sources, the Sentry DSN's one, exact and `*.`
 *   hosts, and the refusal messages.
 * Layer: Test. Runs a copy of the script beside a temporary public/_headers.
 * Dependencies: vitest, scripts/check-csp-origin.mjs, public/_headers.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-csp-origin.mjs");
const DEPLOYMENT = "https://happy-otter-123.convex.cloud";
const CONVEX_POLICY =
  "default-src 'self'; img-src 'self' https://*.convex.cloud; " +
  "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud";
const SENTRY_DSN = "https://publickey@o1.ingest.us.sentry.io/1";
const SENTRY_HOST = "https://o1.ingest.us.sentry.io";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "check-csp-origin-"));
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "public"));
  copyFileSync(SCRIPT, path.join(dir, "scripts", "check-csp-origin.mjs"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-csp-origin.mjs", () => {
  it("allows a deployment under `*.` sources", () => {
    const run = check(DEPLOYMENT, CONVEX_POLICY);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `${DEPLOYMENT} is allowed by the Content-Security-Policy.\n`,
    );
  });

  it("matches an exact host, but not its subdomains", () => {
    const policy =
      "img-src https://api.example.org; " +
      "connect-src https://api.example.org wss://api.example.org";

    expect(check("https://api.example.org", policy).status).toBe(0);
    expect(check("https://eu.api.example.org", policy).status).toBe(1);
  });

  it("does not let `*.host` cover the bare host", () => {
    expect(check("https://convex.cloud", CONVEX_POLICY).status).toBe(1);
  });

  it("never matches a source with a port or a path", () => {
    const policy =
      "img-src https://*.convex.cloud/; " +
      "connect-src https://*.convex.cloud:443 wss://*.convex.cloud";

    const run = check(DEPLOYMENT, policy);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "connect-src https://happy-otter-123.convex.cloud, " +
        "img-src https://happy-otter-123.convex.cloud.",
    );
  });

  it("names every missing source in required order", () => {
    const run = check(DEPLOYMENT, "connect-src https://*.convex.cloud");

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `${DEPLOYMENT} is not allowed by public/_headers: ` +
        "connect-src wss://happy-otter-123.convex.cloud, " +
        "img-src https://happy-otter-123.convex.cloud. " +
        "Add it to the Content-Security-Policy before deploying.\n",
    );
  });

  it("refuses a URL that is not https, even when the policy allows it", () => {
    const run = check("http://happy-otter-123.convex.cloud", CONVEX_POLICY);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      "http://happy-otter-123.convex.cloud must use https.\n",
    );
  });

  it("refuses a URL with a port, which sources without one never cover (OP-12)", () => {
    const run = check(`${DEPLOYMENT}:8443`, CONVEX_POLICY);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `${DEPLOYMENT}:8443 must use the default https port (443): ` +
        "the policy's sources name no port.\n",
    );
  });

  it("passes the default port written out", () => {
    expect(check(`${DEPLOYMENT}:443`, CONVEX_POLICY).status).toBe(0);
  });

  it("refuses a value that is not a URL", () => {
    const run = check("not a url", CONVEX_POLICY);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe("The Convex URL is not a valid URL.\n");
  });

  it("passes a Convex cloud deployment against the shipped policy", () => {
    const run = spawnSync(process.execPath, [SCRIPT, DEPLOYMENT], {
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
  });
});

describe("check-csp-origin.mjs --sentry-dsn", () => {
  it("needs only connect-src https for the DSN's ingest host", () => {
    const run = checkDsn(
      SENTRY_DSN,
      "connect-src 'self' https://*.ingest.us.sentry.io",
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      `Sentry ingest host ${SENTRY_HOST} is allowed by the ` +
        "Content-Security-Policy.\n",
    );
  });

  it("refuses a DSN whose host the policy does not allow, without its key", () => {
    const run = checkDsn(SENTRY_DSN, CONVEX_POLICY);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      `Sentry ingest host ${SENTRY_HOST} is not allowed by public/_headers: ` +
        `connect-src ${SENTRY_HOST}. ` +
        "Add it to the Content-Security-Policy before deploying.\n",
    );
  });

  it("refuses a DSN whose ingest host has a port", () => {
    const run = checkDsn(
      "https://publickey@o1.ingest.us.sentry.io:8443/1",
      "connect-src 'self' https://*.ingest.us.sentry.io",
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${SENTRY_HOST}:8443 must use the default`);
  });

  it("passes an empty DSN, because error reporting is then off", () => {
    const run = checkDsn("", CONVEX_POLICY);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("No Sentry DSN: error reporting stays off.\n");
  });

  it("refuses a DSN that is missing, not a URL or not https", () => {
    const missing = run(["--sentry-dsn"], CONVEX_POLICY);
    const invalid = checkDsn("publickey", CONVEX_POLICY);
    const http = checkDsn(SENTRY_DSN.replace("https:", "http:"), CONVEX_POLICY);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe(
      "Usage: check-csp-origin.mjs --sentry-dsn <dsn>\n",
    );
    expect(invalid.stderr).toBe("The Sentry DSN is not a valid URL.\n");
    expect(http.stderr).toBe(
      "Sentry ingest host http://o1.ingest.us.sentry.io must use https.\n",
    );
  });
});

function check(url: string, policy: string) {
  return run([url], policy);
}

function checkDsn(dsn: string, policy: string) {
  return run(["--sentry-dsn", dsn], policy);
}

function run(args: string[], policy: string) {
  writeFileSync(
    path.join(dir, "public", "_headers"),
    `/*\n  Content-Security-Policy: ${policy}\n`,
  );
  const script = path.join(dir, "scripts", "check-csp-origin.mjs");
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

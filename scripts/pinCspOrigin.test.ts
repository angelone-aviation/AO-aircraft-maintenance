/**
 * Responsibility: Pins pin-csp-origin.mjs, the deploy step that narrows the
 *   built Content-Security-Policy to the production Convex deployment: the
 *   sources it rewrites, what it leaves alone, its refusals, and that Deploy
 *   runs it on the build it publishes.
 * Layer: Test. Runs the script on temporary headers files.
 * Dependencies: vitest, scripts/pin-csp-origin.mjs, public/_headers,
 *   .github/workflows/deploy.yml.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "pin-csp-origin.mjs");
const SHIPPED = path.resolve(__dirname, "../public/_headers");
const WORKFLOW = path.resolve(__dirname, "../.github/workflows/deploy.yml");
const DEPLOYMENT = "https://happy-otter-123.convex.cloud";
const HEADERS = `# Fixture
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data: https://*.convex.cloud; connect-src 'self' blob: https://*.convex.cloud wss://*.convex.cloud https://*.convex.site; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pin-csp-origin-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pin-csp-origin.mjs", () => {
  it("narrows the Convex sources to the deployment's own hosts, changing nothing else", () => {
    const { run, after } = pin(DEPLOYMENT, HEADERS);

    expect(run.status).toBe(0);
    expect(after).toBe(
      HEADERS.replace(
        "img-src 'self' data: https://*.convex.cloud",
        "img-src 'self' data: https://happy-otter-123.convex.cloud",
      ).replace(
        "https://*.convex.cloud wss://*.convex.cloud https://*.convex.site",
        "https://happy-otter-123.convex.cloud wss://happy-otter-123.convex.cloud https://happy-otter-123.convex.site",
      ),
    );
    expect(run.stdout).toBe(
      "Content-Security-Policy pinned to happy-otter-123.convex.cloud and happy-otter-123.convex.site.\n",
    );
  });

  it("keeps a regional deployment's region in both hosts", () => {
    const { after } = pin("https://calm-fox-9.eu-west-1.convex.cloud", HEADERS);

    expect(after).toContain("wss://calm-fox-9.eu-west-1.convex.cloud");
    expect(after).toContain("https://calm-fox-9.eu-west-1.convex.site");
  });

  it("pins every Convex wildcard in the shipped policy", () => {
    const { run, after } = pin(DEPLOYMENT, readFileSync(SHIPPED, "utf8"));

    expect(run.status).toBe(0);
    const policy = after.match(/Content-Security-Policy: (.+)/)![1];
    expect(policy).not.toContain("*");
    expect(sourcesOf(policy, "connect-src")).toEqual(
      expect.arrayContaining([
        "https://happy-otter-123.convex.cloud",
        "wss://happy-otter-123.convex.cloud",
        "https://happy-otter-123.convex.site",
      ]),
    );
    expect(sourcesOf(policy, "img-src")).toContain(
      "https://happy-otter-123.convex.cloud",
    );
  });

  it.each([
    ["http://happy-otter-123.convex.cloud", "must use https"],
    ["https://api.example.org", "is not a Convex cloud deployment"],
    ["https://convex.cloud", "is not a Convex cloud deployment"],
    ["not a url", "is not a valid URL"],
  ])("refuses %s and leaves the file as it was", (url, message) => {
    const { run, after } = pin(url, HEADERS);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(message);
    expect(after).toBe(HEADERS);
  });

  it("refuses a policy with no Convex wildcard left to pin", () => {
    const pinned = pin(DEPLOYMENT, HEADERS).after;
    const { run, after } = pin(DEPLOYMENT, pinned);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("has no https://*.convex.cloud source to pin");
    expect(after).toBe(pinned);
  });

  it("runs in Deploy on the build it publishes, with the deployment's URL", () => {
    const build = readFileSync(WORKFLOW, "utf8");
    const steps = [
      "npm run build",
      'node scripts/pin-csp-origin.mjs "$VITE_CONVEX_URL"',
    ];

    const [buildAt, pinAt] = steps.map((line) => build.indexOf(line));
    expect(buildAt).toBeGreaterThan(-1);
    expect(pinAt).toBeGreaterThan(buildAt);
  });
});

function pin(url: string, headers: string) {
  const file = path.join(dir, `${crypto.randomUUID()}_headers`);
  writeFileSync(file, headers);
  const run = spawnSync(process.execPath, [SCRIPT, url, file], {
    encoding: "utf8",
  });
  return { run, after: readFileSync(file, "utf8") };
}

function sourcesOf(policy: string, directive: string) {
  const found = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === directive);
  return found?.slice(1) ?? [];
}

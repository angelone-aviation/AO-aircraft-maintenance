/**
 * Responsibility: Copies the local Convex backend to an empty peer-testing
 *   cloud deployment once, and builds the website for A2 hosting.
 * Layer: Script. Operator tooling, never imported; every secret it learns is
 *   redacted from what it prints.
 * Dependencies: jose, Node.js built-ins, the Convex CLI, npm, python3.
 *
 *   node scripts/peer-testing-transfer.mjs export|transfer|build
 *
 * Files live in git-ignored .convex/peer-testing/. Transfer also builds; build
 * only rebuilds the site for the deployment already transferred to.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";

const ROOT = resolve(import.meta.dirname, "..");
const AREA = join(ROOT, ".convex", "peer-testing");
const TARGET_ENV_FILE = ".env.peer-testing";
const COUNTS_FILE = join(AREA, "source-counts.json");
const SNAPSHOT_POINTER = join(AREA, "latest-snapshot.txt");
const TRANSFER_RECORD = join(AREA, "transfer-complete.json");
const LOCAL_BACKEND_URL = "http://127.0.0.1:3210";
// `management` holds components, stock, locations and vendors.
const COUNT_TABLES_PYTHON =
  "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=['aircraft','workOrders','management','users','_storage']; counts={t:len(z.read(t+'/documents.jsonl').splitlines()) if t+'/documents.jsonl' in z.namelist() else 0 for t in names}; print(json.dumps(counts,indent=2)); open(sys.argv[2],'w').write(json.dumps(counts))";
const ZIP_WEBSITE_PYTHON =
  "import shutil; shutil.make_archive('.convex/peer-testing/a2-website', 'zip', 'dist-peer-testing')";
const CONVEX_CLOUD_HOST = /^[a-z0-9-]+\.convex\.cloud$/;
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// convex/secrets.ts refuses a credential key of any other length.
const AES_256_KEY_BYTES = 32;

const secrets = [];

process.chdir(ROOT);
mkdirSync(AREA, { recursive: true, mode: 0o700 });
main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});

async function main() {
  const mode = process.argv[2];
  if (mode === "export") return exportLocalBackend();
  const target = readTarget();
  if (mode === "transfer") await transfer(target);
  else if (mode !== "build")
    throw new Error("Choose export, transfer, or build.");
  buildWebsite(target);
}

function exportLocalBackend() {
  const { adminKey } = JSON.parse(
    readFileSync(".convex/local/default/config.json", "utf8"),
  );
  secrets.push(adminKey);
  const temp = mkdtempSync(join(tmpdir(), "angel-one-export-"));
  const envFile = join(temp, ".env");
  const snapshot = join(AREA, `local-${Date.now()}.zip`);
  try {
    // A private file keeps the admin key out of process arguments.
    writeFileSync(
      envFile,
      `CONVEX_SELF_HOSTED_URL=${LOCAL_BACKEND_URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}\n`,
      { mode: 0o600 },
    );
    run("npx", [
      "convex",
      "export",
      "--env-file",
      envFile,
      "--include-file-storage",
      "--path",
      snapshot,
    ]);
    run("python3", ["-c", COUNT_TABLES_PYTHON, snapshot, COUNTS_FILE]);
    writeFileSync(SNAPSHOT_POINTER, snapshot, { mode: 0o600 });
    console.log(`Local data and attachments saved to ${snapshot}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readTarget() {
  const config = parseEnv(readFileSync(TARGET_ENV_FILE, "utf8"));
  const key = config.CONVEX_DEPLOY_KEY;
  if (key) secrets.push(key);
  const url = new URL(config.VITE_CONVEX_URL);
  const site = new URL(config.SITE_URL);
  assertTarget(url, site, key);
  const envFile = resolve(TARGET_ENV_FILE);
  const convex = (args, options) =>
    run("npx", ["convex", ...args, "--env-file", envFile], options);
  return { url, site, convex };
}

function assertTarget(url, site, key) {
  if (
    url.protocol !== "https:" ||
    !CONVEX_CLOUD_HOST.test(url.hostname) ||
    url.pathname !== "/"
  )
    throw new Error("Use the HTTPS Convex deployment URL.");
  if (
    site.protocol !== "https:" ||
    site.pathname !== "/" ||
    site.search ||
    site.hash
  )
    throw new Error("Use an HTTPS domain or subdomain root for A2 testing.");
  // A production deploy key names its deployment: prod:<name>|<secret>.
  if (!key?.startsWith(`prod:${url.hostname.split(".")[0]}|`))
    throw new Error(
      "The production deploy key must match the specified deployment URL.",
    );
}

async function transfer({ url, site, convex }) {
  assertSourceHasRecords();
  // Every table is checked before any schema is deployed or record imported.
  assertTargetEmpty(convex);
  const snapshot = readFileSync(SNAPSHOT_POINTER, "utf8").trim();
  if (!existsSync(snapshot))
    throw new Error("Export the local database first.");
  if (existsSync(TRANSFER_RECORD))
    throw new Error(
      "A transfer was already completed. Use the build command to rebuild the website; do not repeat the import.",
    );
  convex(["deploy", "--yes"]);
  convex(["import", snapshot]);
  await ensureSigningKeys(convex);
  ensureEncryptionKey(convex);
  convex(["env", "set", "SITE_URL"], { input: site.origin });
  writeFileSync(
    TRANSFER_RECORD,
    JSON.stringify(
      { deployment: url.origin, snapshot, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(
    "Cloud copy complete. Local configuration and records are unchanged.",
  );
}

function assertSourceHasRecords() {
  const counts = JSON.parse(readFileSync(COUNTS_FILE, "utf8"));
  if (!counts.workOrders || !counts.management)
    throw new Error(
      "This export lacks the expected work orders or components. Identify the correct source database before transferring.",
    );
}

function assertTargetEmpty(convex) {
  const tables = convex(["data"], { quiet: true })
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  for (const table of tables) {
    // Anything else is CLI output that is not a table list.
    if (!TABLE_NAME.test(table))
      throw new Error(
        "Could not verify the target is empty. Check it in the Convex dashboard.",
      );
    const raw = convex(["data", table, "--limit", "1", "--format", "json"], {
      quiet: true,
    });
    const rows = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows) || rows.length)
      throw new Error(
        `Target table ${table} contains data. Use an empty peer-testing deployment.`,
      );
  }
}

async function ensureSigningKeys(convex) {
  if (isSet(convex, "JWT_PRIVATE_KEY")) return;
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privatePem = (await exportPKCS8(privateKey)).trim().replace(/\n/g, " ");
  secrets.push(privatePem);
  convex(["env", "set", "JWT_PRIVATE_KEY"], { input: privatePem });
  convex(["env", "set", "JWKS"], {
    input: JSON.stringify({
      keys: [{ use: "sig", ...(await exportJWK(publicKey)) }],
    }),
  });
}

function ensureEncryptionKey(convex) {
  if (isSet(convex, "CREDENTIALS_ENCRYPTION_KEY")) return;
  const key = randomBytes(AES_256_KEY_BYTES).toString("base64");
  secrets.push(key);
  convex(["env", "set", "CREDENTIALS_ENCRYPTION_KEY"], { input: key });
  console.log(
    "New credential encryption key set. Re-enter Aircraft Spruce, FAA and address-lookup keys that were saved encrypted locally.",
  );
}

function isSet(convex, name) {
  const value = convex(["env", "get", name], { quiet: true });
  return value !== "" && value !== "null";
}

function buildWebsite({ url }) {
  const completed = JSON.parse(readFileSync(TRANSFER_RECORD, "utf8"));
  if (completed.deployment !== url.origin)
    throw new Error("Complete transfer to this deployment before building.");
  run("npm", ["run", "build", "--", "--outDir", "dist-peer-testing"], {
    env: {
      ...process.env,
      VITE_CONVEX_URL: url.origin,
      VITE_DEMO_MODE: "false",
    },
  });
  writeFileSync(
    "dist-peer-testing/.htaccess",
    readFileSync("public/.htaccess"),
  );
  run("python3", ["-c", ZIP_WEBSITE_PYTHON]);
  console.log(
    "Upload only .convex/peer-testing/a2-website.zip to A2. Never upload the database snapshot or .env files.",
  );
}

// Prints the command's output (unless quiet) with every known secret hidden.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!options.quiet) console.log(redact(output));
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed. No automatic overwrite or retry was performed.`,
    );
  return result.stdout.trim();
}

function redact(text) {
  return secrets.reduce((s, key) => s.replaceAll(key, "<REDACTED>"), text);
}

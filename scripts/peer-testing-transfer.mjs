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

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const area = join(root, ".convex", "peer-testing");
mkdirSync(area, { recursive: true, mode: 0o700 });
const secrets = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!options.quiet)
    console.log(
      secrets.reduce((s, key) => s.replaceAll(key, "<REDACTED>"), output),
    );
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed. No automatic overwrite or retry was performed.`,
    );
  return result.stdout.trim();
}
async function main() {
  if (process.argv[2] === "export") {
    const config = JSON.parse(
      readFileSync(".convex/local/default/config.json", "utf8"),
    );
    secrets.push(config.adminKey);
    const temp = mkdtempSync(join(tmpdir(), "angel-one-export-"));
    const envFile = join(temp, ".env");
    const snapshot = join(area, `local-${Date.now()}.zip`);
    try {
      writeFileSync(
        envFile,
        `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=${config.adminKey}\n`,
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
      run("python3", [
        "-c",
        "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=['aircraft','workOrders','management','users','_storage']; counts={t:len(z.read(t+'/documents.jsonl').splitlines()) if t+'/documents.jsonl' in z.namelist() else 0 for t in names}; print(json.dumps(counts,indent=2)); open(sys.argv[2],'w').write(json.dumps(counts))",
        snapshot,
        join(area, "source-counts.json"),
      ]);
      writeFileSync(join(area, "latest-snapshot.txt"), snapshot, {
        mode: 0o600,
      });
      console.log(`Local data and attachments saved to ${snapshot}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    return;
  }
  const config = parseEnv(readFileSync(".env.peer-testing", "utf8"));
  const key = config.CONVEX_DEPLOY_KEY;
  if (key) secrets.push(key);
  const url = new URL(config.VITE_CONVEX_URL);
  const site = new URL(config.SITE_URL);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.convex\.cloud$/.test(url.hostname) ||
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
  if (!key?.startsWith(`prod:${url.hostname.split(".")[0]}|`))
    throw new Error(
      "The production deploy key must match the specified deployment URL.",
    );
  const envFile = resolve(".env.peer-testing");
  const convex = (args, options) =>
    run("npx", ["convex", ...args, "--env-file", envFile], options);
  if (process.argv[2] === "transfer") {
    const counts = JSON.parse(
      readFileSync(join(area, "source-counts.json"), "utf8"),
    );
    if (!counts.workOrders || !counts.management)
      throw new Error(
        "This export lacks the expected work orders or components. Identify the correct source database before transferring.",
      );
    // Check all existing tables before deploying any schema or importing records.
    const tables = convex(["data"], { quiet: true })
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    for (const table of tables) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(table))
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
    const snapshot = readFileSync(
      join(area, "latest-snapshot.txt"),
      "utf8",
    ).trim();
    if (!existsSync(snapshot))
      throw new Error("Export the local database first.");
    if (existsSync(join(area, "transfer-complete.json")))
      throw new Error(
        "A transfer was already completed. Use the build command to rebuild the website; do not repeat the import.",
      );
    convex(["deploy", "--yes"]);
    convex(["import", snapshot]);
    const existing = convex(["env", "get", "JWT_PRIVATE_KEY"], { quiet: true });
    if (!existing || existing === "null") {
      const { privateKey, publicKey } = await generateKeyPair("RS256", {
        extractable: true,
      });
      const privatePem = (await exportPKCS8(privateKey))
        .trim()
        .replace(/\n/g, " ");
      secrets.push(privatePem);
      convex(["env", "set", "JWT_PRIVATE_KEY"], { input: privatePem });
      convex(["env", "set", "JWKS"], {
        input: JSON.stringify({
          keys: [{ use: "sig", ...(await exportJWK(publicKey)) }],
        }),
      });
    }
    const encryption = convex(["env", "get", "CREDENTIALS_ENCRYPTION_KEY"], {
      quiet: true,
    });
    if (!encryption || encryption === "null") {
      const key = randomBytes(32).toString("base64");
      secrets.push(key);
      convex(["env", "set", "CREDENTIALS_ENCRYPTION_KEY"], { input: key });
      console.log(
        "New credential encryption key set. Re-enter Aircraft Spruce, FAA and address-lookup keys that were saved encrypted locally.",
      );
    }
    convex(["env", "set", "SITE_URL"], { input: site.origin });
    writeFileSync(
      join(area, "transfer-complete.json"),
      JSON.stringify(
        { deployment: url.origin, snapshot, at: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(
      "Cloud copy complete. Local configuration and records are unchanged.",
    );
  } else if (process.argv[2] !== "build")
    throw new Error("Choose export, transfer, or build.");
  const completed = JSON.parse(
    readFileSync(join(area, "transfer-complete.json"), "utf8"),
  );
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
  run("python3", [
    "-c",
    "import shutil; shutil.make_archive('.convex/peer-testing/a2-website', 'zip', 'dist-peer-testing')",
  ]);
  console.log(
    "Upload only .convex/peer-testing/a2-website.zip to A2. Never upload the database snapshot or .env files.",
  );
}
main().catch((error) => {
  console.error(
    secrets.reduce((s, key) => s.replaceAll(key, "<REDACTED>"), error.message),
  );
  process.exitCode = 1;
});

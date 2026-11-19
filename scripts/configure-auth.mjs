/**
 * Responsibility: Sets up Convex Auth on the selected deployment: signing keys,
 *   the credential encryption key and SITE_URL (`npm run setup:auth`).
 * Layer: Script. Operator tooling, never imported; it never prints a key.
 * Dependencies: jose, node:child_process, node:crypto, the Convex CLI.
 *
 * Safe to repeat: a key that exists is kept, because replacing it would void
 * issued sign-in tokens or make saved credentials unreadable. So a failed read
 * stops the run instead of counting as unset. The signing keys count as
 * existing only as a pair: JWT_PRIVATE_KEY and JWKS both set. A SITE_URL that
 * exists is kept too, unless SITE_URL is in the shell.
 */
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// convex/secrets.ts refuses a credential key of any other length.
const AES_256_KEY_BYTES = 32;

// Vite's development server (`npm run dev`).
const LOCAL_SITE_URL = "http://localhost:5173";

await ensureSigningKeys();
ensureEncryptionKey();
ensureSiteUrl();
console.log("No signing secrets were printed.");

// Half a pair (a run that stopped between the two writes) signs tokens
// nothing can verify, so no working session depends on it: make a new pair.
async function ensureSigningKeys() {
  const hasPrivateKey = isSet("JWT_PRIVATE_KEY");
  if (hasPrivateKey && isSet("JWKS")) {
    console.log("Existing signing keys retained.");
    return;
  }
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privatePem = (await exportPKCS8(privateKey)).trim().replace(/\n/g, " ");
  const publicJwk = await exportJWK(publicKey);
  convex(["env", "set", "JWT_PRIVATE_KEY"], privatePem);
  convex(
    ["env", "set", "JWKS"],
    JSON.stringify({ keys: [{ use: "sig", ...publicJwk }] }),
  );
  console.log(
    hasPrivateKey
      ? "The signing key had no JWKS, so a new key pair was configured."
      : "Convex Auth signing keys configured.",
  );
}

function ensureEncryptionKey() {
  if (isSet("CREDENTIALS_ENCRYPTION_KEY")) {
    console.log("Existing credential encryption key retained.");
    return;
  }
  convex(
    ["env", "set", "CREDENTIALS_ENCRYPTION_KEY"],
    randomBytes(AES_256_KEY_BYTES).toString("base64"),
  );
  console.log("Credential encryption key configured.");
}

// SITE_URL from the shell always wins. Without it, an address already on the
// deployment stays: a rerun against production must not swap its address for
// the local default, which breaks sign-in redirects and the links in emails.
function ensureSiteUrl() {
  const requested = process.env.SITE_URL;
  const existing = requested ? "" : readVariable("SITE_URL");
  if (existing) {
    console.log(
      `Existing site URL kept: ${existing}. To change it, run again with SITE_URL=<address>.`,
    );
    return;
  }
  convex(["env", "set", "SITE_URL"], requested || LOCAL_SITE_URL);
  console.log(
    requested
      ? `Site URL set to ${requested}.`
      : `Site URL set to ${LOCAL_SITE_URL}, the local default. For any other site, run again with SITE_URL=<address>.`,
  );
}

function isSet(name) {
  return readVariable(name) !== "";
}

// Returns "" for an unset variable: the CLI then writes nothing to stdout and
// exits 0. A non-zero exit means the read itself failed, and convex() throws.
function readVariable(name) {
  const value = convex(["env", "get", name]).trim();
  return value === "null" ? "" : value;
}

// Values go over stdin, never in arguments, which other processes can read.
function convex(args, input) {
  const result = spawnSync("npx", ["convex", ...args], {
    input,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr ||
        "Convex command failed. Start npm run dev:backend first.",
    );
  return result.stdout;
}

/**
 * Responsibility: Sets up Convex Auth on the selected deployment: signing keys,
 *   the credential encryption key and SITE_URL (`npm run setup:auth`).
 * Layer: Script. Operator tooling, never imported; it never prints a key.
 * Dependencies: jose, node:child_process, node:crypto, the Convex CLI.
 *
 * Safe to repeat: a key that exists is kept, because replacing it would void
 * issued sign-in tokens or make saved credentials unreadable. So a failed read
 * stops the run instead of counting as unset.
 */
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// convex/secrets.ts refuses a credential key of any other length.
const AES_256_KEY_BYTES = 32;

await ensureSigningKeys();
ensureEncryptionKey();
convex(
  ["env", "set", "SITE_URL"],
  process.env.SITE_URL || "http://localhost:5173",
);
console.log("Site URL configured. No signing secrets were printed.");

async function ensureSigningKeys() {
  if (isSet("JWT_PRIVATE_KEY")) {
    console.log("Existing signing key retained.");
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
  console.log("Convex Auth signing keys configured.");
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

// For an unset variable the CLI writes nothing to stdout and exits 0; a
// non-zero exit means the read itself failed, and convex() throws.
function isSet(name) {
  const value = convex(["env", "get", name]).trim();
  return value !== "" && value !== "null";
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

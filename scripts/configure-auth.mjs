/**
 * Responsibility: Sets up Convex Auth on the selected deployment: signing keys,
 *   the credential encryption key and SITE_URL (`npm run setup:auth`).
 * Layer: Script. Operator tooling, never imported; it never prints a key.
 * Dependencies: jose, node:child_process, node:crypto, the Convex CLI.
 *
 * Safe to repeat: an existing key is kept, so a failed read must stop the run.
 * Treating it as unset would replace a working key.
 */
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
// Do not rotate a configured deployment's signing keys on a repeat invocation.
const existing = convex(["env", "get", "JWT_PRIVATE_KEY"]).trim();
if (existing && existing !== "null") {
  console.log("Existing signing key retained.");
} else {
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
// Encrypts stored third-party credentials. Never rotate it here: existing
// ciphertext would become unreadable.
const encryption = convex(["env", "get", "CREDENTIALS_ENCRYPTION_KEY"]).trim();
if (encryption && encryption !== "null") {
  console.log("Existing credential encryption key retained.");
} else {
  convex(
    ["env", "set", "CREDENTIALS_ENCRYPTION_KEY"],
    randomBytes(32).toString("base64"),
  );
  console.log("Credential encryption key configured.");
}
convex(
  ["env", "set", "SITE_URL"],
  process.env.SITE_URL || "http://localhost:5173",
);
console.log("Site URL configured. No signing secrets were printed.");

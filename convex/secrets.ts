import { ConvexError } from "convex/values";
// AES-256-GCM for third-party credentials at rest. Seal in actions before the
// commit mutation; open only in actions that call the provider.
//
// Format v2: `enc:v2:<keyId>:<iv>:<ciphertext>`. The additional data binds the
// value to its key id, table, Flight Program and field, so a value copied to
// another row or field does not decrypt. Format v1 (`enc:v1:<iv>:<data>`, no
// additional data, key k1) is still read; the secretsMigration re-seals it.
//
// Keys (see docs/runbooks/credentials-key.md):
//   CREDENTIALS_ENCRYPTION_KEY     key k1 (and the only key for v1 values)
//   CREDENTIALS_ENCRYPTION_KEYS    more keys, `k2=<base64>,k3=<base64>`
//   CREDENTIALS_ENCRYPTION_KEY_ID  key id used to seal (default k1)
const LEGACY_ENV = "CREDENTIALS_ENCRYPTION_KEY";
const KEYS_ENV = "CREDENTIALS_ENCRYPTION_KEYS";
const ACTIVE_ENV = "CREDENTIALS_ENCRYPTION_KEY_ID";
const LEGACY_KEY_ID = "k1";
const V1 = "enc:v1:";
const V2 = "enc:v2:";
const KEY_ID = /^[a-z0-9]{1,16}$/;
export type SecretContext = {
  table: "faaCredentials" | "addressVerificationSettings" | "spruceAccounts";
  // "" for deployment-wide credentials.
  programUuid: string;
  field: string;
};
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
function keyring() {
  const keys = new Map<string, string>();
  const legacy = process.env[LEGACY_ENV]?.trim();
  if (legacy) keys.set(LEGACY_KEY_ID, legacy);
  for (const entry of (process.env[KEYS_ENV] ?? "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.indexOf("=");
    const id = entry.slice(0, at).trim();
    if (at < 0 || !KEY_ID.test(id) || keys.has(id))
      throw new ConvexError(
        `${KEYS_ENV} must list distinct key ids as id=base64 pairs (see docs/runbooks/credentials-key.md).`,
      );
    keys.set(id, entry.slice(at + 1).trim());
  }
  return keys;
}
export function activeKeyId() {
  const id = process.env[ACTIVE_ENV]?.trim() || LEGACY_KEY_ID;
  if (!KEY_ID.test(id))
    throw new ConvexError(`${ACTIVE_ENV} must be a short lowercase key id.`);
  return id;
}
async function encryptionKey(id: string, usage: "encrypt" | "decrypt") {
  const raw = keyring().get(id);
  if (!raw)
    throw new ConvexError(
      id === LEGACY_KEY_ID && usage === "encrypt"
        ? `Credential encryption is not configured. Set ${LEGACY_ENV} in the Convex environment (see README) before saving third-party credentials.`
        : `Credential encryption key ${id} is not configured (see docs/runbooks/credentials-key.md).`,
    );
  const bytes = fromBase64(raw);
  if (bytes.length !== 32)
    throw new ConvexError(
      `Credential encryption key ${id} must be 32 random bytes, base64-encoded.`,
    );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}
const additionalData = (keyId: string, c: SecretContext) =>
  new TextEncoder().encode(
    JSON.stringify(["enc:v2", keyId, c.table, c.programUuid, c.field]),
  );
export async function sealSecret(plain: string, context: SecretContext) {
  const keyId = activeKeyId();
  const key = await encryptionKey(keyId, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(keyId, context) },
    key,
    new TextEncoder().encode(plain),
  );
  return `${V2}${keyId}:${toBase64(iv)}:${toBase64(new Uint8Array(data))}`;
}
// Shape of a v2 value, for commit mutations that accept only sealed input.
export const SEALED_V2 =
  /^enc:v2:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;
export const isSealed = (value: string) =>
  value.startsWith(V1) || value.startsWith(V2);
// True unless the value is v2 under the key currently used for sealing.
export const needsReseal = (value: string) =>
  !value.startsWith(`${V2}${activeKeyId()}:`);
async function decrypt(
  keyId: string,
  iv: string,
  data: string,
  aad?: Uint8Array,
) {
  const key = await encryptionKey(keyId, "decrypt");
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(iv),
        ...(aad ? { additionalData: aad } : {}),
      },
      key,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new ConvexError(
      "A saved credential could not be decrypted. An administrator must enter it again.",
    );
  }
}
// `legacyPlaintext` accepts a value saved before encryption existed. Only
// openStoredSecret (until the v2 migration has run) and the migration pass it.
export async function openSecret(
  stored: string,
  context: SecretContext,
  options: { legacyPlaintext?: boolean } = {},
) {
  if (stored.startsWith(V2)) {
    const [keyId, iv, data] = stored.slice(V2.length).split(":");
    return decrypt(keyId, iv, data, additionalData(keyId, context));
  }
  if (stored.startsWith(V1)) {
    const [iv, data] = stored.slice(V1.length).split(":");
    return decrypt(LEGACY_KEY_ID, iv, data);
  }
  if (!options.legacyPlaintext)
    throw new ConvexError(
      "A saved credential is not encrypted. An administrator must enter it again.",
    );
  // Never log the value itself.
  console.warn(
    `Unencrypted legacy credential read from ${context.table}.${context.field}; run secretsMigration:reseal.`,
  );
  return stored;
}

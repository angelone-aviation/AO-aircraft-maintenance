/**
 * Responsibility: Seals and opens third-party credentials at rest with
 *   AES-256-GCM under keys held in the Convex environment.
 * Layer: Server. Seal in actions before the commit mutation; open only in
 *   actions that call the provider.
 * Dependencies: convex/values (ConvexError).
 *
 * The one format, `enc:v2:<keyId>:<iv>:<ciphertext>`, binds each value to its
 * key id, table, Flight Program and field, so a copy in another row or field
 * does not decrypt. Older v1 and plaintext values predate production's empty
 * start on 2026-11-03 and are refused (docs/architecture/t21-inventory.md).
 * Keys: docs/runbooks/credentials-key.md.
 */
import { ConvexError } from "convex/values";

// Holds key k1, the first key and the default one.
const LEGACY_ENV = "CREDENTIALS_ENCRYPTION_KEY";
// More keys, as `k2=<base64>,k3=<base64>`.
const KEYS_ENV = "CREDENTIALS_ENCRYPTION_KEYS";
// The key id new values are sealed with; k1 when unset.
const ACTIVE_ENV = "CREDENTIALS_ENCRYPTION_KEY_ID";
const LEGACY_KEY_ID = "k1";
const V2 = "enc:v2:";
const KEY_ID = /^[a-z0-9]{1,16}$/;
const AES_256_KEY_BYTES = 32;
// 96 bits, the IV length GCM is designed for (NIST SP 800-38D).
const GCM_IV_BYTES = 12;

/** The row and field a credential is stored in, which sealing binds it to. */
export type SecretContext = {
  table: "faaCredentials" | "addressVerificationSettings" | "spruceAccounts";
  /** "" for deployment-wide credentials. */
  programUuid: string;
  field: string;
};

/**
 * Names the key that new values are sealed with.
 *
 * @returns CREDENTIALS_ENCRYPTION_KEY_ID, trimmed, or "k1" when unset or blank.
 * @throws {ConvexError} "CREDENTIALS_ENCRYPTION_KEY_ID must be a short
 *   lowercase key id." unless it is 1–16 lowercase letters or digits.
 */
export function activeKeyId(): string {
  const id = process.env[ACTIVE_ENV]?.trim() || LEGACY_KEY_ID;
  if (!KEY_ID.test(id))
    throw new ConvexError(`${ACTIVE_ENV} must be a short lowercase key id.`);
  return id;
}

/**
 * Encrypts a credential under the active key, bound to where it is stored.
 *
 * @param plain - The credential as entered.
 * @param context - The row and field it will be stored in.
 * @returns A v2 value matching {@link SEALED_V2}; a fresh random IV each call.
 * @throws {ConvexError} "Credential encryption is not configured. Set …" when
 *   k1 is active and unset; "Credential encryption key <id> is not configured
 *   …" for another unset key; "… must be 32 random bytes, base64-encoded."; or
 *   the {@link activeKeyId} and CREDENTIALS_ENCRYPTION_KEYS format errors.
 */
export async function sealSecret(
  plain: string,
  context: SecretContext,
): Promise<string> {
  const keyId = activeKeyId();
  const key = await importKey(keyId, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bindContext(keyId, context) },
    key,
    new TextEncoder().encode(plain),
  );
  return `${V2}${keyId}:${toBase64(iv)}:${toBase64(new Uint8Array(data))}`;
}

/** Shape of a v2 value, for commit mutations that accept only sealed input. */
export const SEALED_V2 =
  /^enc:v2:[a-z0-9]{1,16}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/;

/**
 * Tells whether a key rotation must re-seal a stored credential.
 *
 * @param value - A stored credential.
 * @returns True unless it is v2 under the active key.
 * @throws {ConvexError} From {@link activeKeyId}.
 */
export const needsReseal = (value: string): boolean =>
  !value.startsWith(`${V2}${activeKeyId()}:`);

/**
 * Decrypts a stored credential for a provider call.
 *
 * @param stored - The value as stored.
 * @param context - The row and field it was read from; must match the seal.
 * @returns The plaintext credential.
 * @throws {ConvexError} "A saved credential is not encrypted. An administrator
 *   must enter it again." for any value that is not v2, plaintext and v1
 *   included; "A saved credential could not be decrypted. An administrator
 *   must enter it again." for a wrong key, context or damaged value;
 *   "Credential encryption key <id> is not configured …" when its key is
 *   unset; or a key format error.
 */
export async function openSecret(
  stored: string,
  context: SecretContext,
): Promise<string> {
  if (!stored.startsWith(V2))
    throw new ConvexError(
      "A saved credential is not encrypted. An administrator must enter it again.",
    );
  const [keyId, iv, data] = stored.slice(V2.length).split(":");
  return decrypt(keyId, iv, data, bindContext(keyId, context));
}

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function readKeyring(): Map<string, string> {
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

async function importKey(
  id: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const raw = readKeyring().get(id);
  if (!raw)
    throw new ConvexError(
      id === LEGACY_KEY_ID && usage === "encrypt"
        ? `Credential encryption is not configured. Set ${LEGACY_ENV} in the Convex environment (see README) before saving third-party credentials.`
        : `Credential encryption key ${id} is not configured (see docs/runbooks/credentials-key.md).`,
    );
  const bytes = fromBase64(raw);
  if (bytes.length !== AES_256_KEY_BYTES)
    throw new ConvexError(
      `Credential encryption key ${id} must be 32 random bytes, base64-encoded.`,
    );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [usage]);
}

// Every stored v2 value was sealed with exactly this encoding; any change
// makes them all undecryptable.
function bindContext(
  keyId: string,
  { table, programUuid, field }: SecretContext,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify(["enc:v2", keyId, table, programUuid, field]),
  );
}

async function decrypt(
  keyId: string,
  iv: string,
  data: string,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await importKey(keyId, "decrypt");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData },
      key,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // A wrong key, a value moved to another row or field, and a damaged value
    // all fail alike; none can be repaired without the plaintext.
    throw new ConvexError(
      "A saved credential could not be decrypted. An administrator must enter it again.",
    );
  }
}

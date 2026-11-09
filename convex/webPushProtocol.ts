/**
 * Responsibility: Builds a Web Push request: the message encrypted for one
 *   device (RFC 8291, aes128gcm) and the VAPID authorization that proves the
 *   deployment sent it (RFC 8292).
 * Layer: Server. Pure Web Crypto helpers with no Convex context, so the push
 *   sender and its tests share them.
 * Dependencies: none beyond the runtime's Web Crypto.
 *
 * Written against the RFCs rather than a push library so the deployment
 * carries no extra dependency (ADR-0012); convex/webPushProtocol.test.ts
 * checks the RFC 8291 test vector byte for byte.
 */

/** Bytes over their own buffer, as Web Crypto and fetch accept them. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** A device's subscription as the push service and browser agreed it. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The deployment's VAPID identity, from the Convex environment. */
export interface VapidKeys {
  /** base64url, the 65-byte uncompressed P-256 public point. */
  publicKey: string;
  /** base64url, the 32-byte private scalar. */
  privateKey: string;
  /** A mailto: or https: URL the push service may contact. */
  subject: string;
}

/** A request ready for fetch. */
export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Bytes;
}

/** Inputs a test fixes; production draws them at random. */
export interface EncryptionNonce {
  salt: Bytes;
  senderKeys: CryptoKeyPair;
}

/** How long the push service may hold an undelivered message. */
export const PUSH_TTL_SECONDS = 24 * 3600;

// RFC 8292 caps a VAPID token at 24 hours; 12 leaves room for clock skew.
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 3600;
const RECORD_SIZE = 4096;
const SALT_LENGTH = 16;
const CEK_BITS = 128;
const NONCE_BITS = 96;
const IKM_BITS = 256;
const P256_POINT_LENGTH = 65;
const P256_COORDINATE_LENGTH = 32;
const PADDING_DELIMITER = 0x02;
const encoder = new TextEncoder();
const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * The request that delivers one message to one device.
 *
 * @param target - The device's subscription.
 * @param payload - The message, UTF-8 encoded and encrypted.
 * @param vapid - The deployment's VAPID keys.
 * @param now - The time (epoch ms), for the token's expiry.
 * @param nonce - A fixed salt and sender key pair, for tests only.
 * @returns The endpoint, the headers (aes128gcm encoding, TTL of one day,
 *   high urgency, VAPID authorization) and the encrypted body.
 * @throws {Error} For a subscription key or VAPID key of the wrong length.
 */
export async function buildPushRequest(
  target: PushTarget,
  payload: string,
  vapid: VapidKeys,
  now = Date.now(),
  nonce?: EncryptionNonce,
): Promise<PushRequest> {
  const body = await encryptPushMessage(target, encoder.encode(payload), nonce);
  const token = await vapidToken(vapid, new URL(target.endpoint).origin, now);
  return {
    url: target.endpoint,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: "high",
      Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
    },
    body,
  };
}

/**
 * Encrypts a message for a device as RFC 8291 describes, in one record.
 *
 * @param target - The device's subscription keys.
 * @param plaintext - The message bytes.
 * @param nonce - A fixed salt and sender key pair, for tests only.
 * @returns The aes128gcm body: the 86-byte header (salt, record size, the
 *   sender's public key) then the ciphertext of the padded plaintext.
 * @throws {Error} "Push subscription keys are malformed." for keys of the
 *   wrong length.
 */
export async function encryptPushMessage(
  target: Pick<PushTarget, "keys">,
  plaintext: Bytes,
  nonce?: EncryptionNonce,
): Promise<Bytes> {
  const receiverPublic = fromBase64Url(target.keys.p256dh);
  const authSecret = fromBase64Url(target.keys.auth);
  if (receiverPublic.length !== P256_POINT_LENGTH || authSecret.length !== 16)
    throw new Error("Push subscription keys are malformed.");
  const salt =
    nonce?.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const sender = nonce?.senderKeys ?? (await generateSenderKeys());
  const senderPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", sender.publicKey),
  );
  const secret = await agreeSecret(sender.privateKey, receiverPublic);
  const ikm = await deriveIkm(secret, authSecret, receiverPublic, senderPublic);
  const cek = await deriveBits(
    ikm,
    salt,
    "Content-Encoding: aes128gcm\0",
    CEK_BITS,
  );
  const iv = await deriveBits(
    ikm,
    salt,
    "Content-Encoding: nonce\0",
    NONCE_BITS,
  );
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const padded = concat(plaintext, new Uint8Array([PADDING_DELIMITER]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, padded),
  );
  return concat(header(salt, senderPublic), ciphertext);
}

/**
 * A signed VAPID token for one push service (RFC 8292).
 *
 * @param vapid - The deployment's keys.
 * @param audience - The push service's origin.
 * @param now - The time (epoch ms); the token expires 12 hours later.
 * @returns The compact JWS (ES256).
 * @throws {Error} "VAPID keys are malformed." for keys of the wrong length.
 */
export async function vapidToken(
  vapid: VapidKeys,
  audience: string,
  now = Date.now(),
): Promise<string> {
  const key = await importVapidPrivateKey(vapid);
  const header = toBase64Url(
    encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
        sub: vapid.subject,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Decodes base64url text, with or without padding.
 *
 * @returns The bytes.
 */
export function fromBase64Url(text: string): Bytes {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Encodes bytes as base64url without padding.
 *
 * @returns The text.
 */
export function toBase64Url(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A fresh sender (application server) key pair for one message. */
export function generateSenderKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(EC, true, ["deriveBits"]);
}

async function agreeSecret(privateKey: CryptoKey, receiverPublic: Bytes) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    EC,
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey },
      privateKey,
      IKM_BITS,
    ),
  );
}

// RFC 8291 §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" ||
// 0x00 || ua_public || as_public, 32).
async function deriveIkm(
  secret: Bytes,
  authSecret: Bytes,
  receiverPublic: Bytes,
  senderPublic: Bytes,
) {
  const info = concat(
    encoder.encode("WebPush: info\0"),
    receiverPublic,
    senderPublic,
  );
  return hkdf(secret, authSecret, info, IKM_BITS);
}

async function deriveBits(ikm: Bytes, salt: Bytes, info: string, bits: number) {
  return hkdf(ikm, salt, encoder.encode(info), bits);
}

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, bits: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      bits,
    ),
  );
}

// RFC 8188 §2.1: salt (16), record size (4, big-endian), key id length (1),
// key id (the sender's public key).
function header(salt: Bytes, senderPublic: Bytes) {
  const fixed = new Uint8Array(SALT_LENGTH + 4 + 1);
  fixed.set(salt);
  new DataView(fixed.buffer).setUint32(SALT_LENGTH, RECORD_SIZE);
  fixed[SALT_LENGTH + 4] = senderPublic.length;
  return concat(fixed, senderPublic);
}

async function importVapidPrivateKey(vapid: VapidKeys) {
  const publicKey = fromBase64Url(vapid.publicKey);
  const privateKey = fromBase64Url(vapid.privateKey);
  if (
    publicKey.length !== P256_POINT_LENGTH ||
    privateKey.length !== P256_COORDINATE_LENGTH
  )
    throw new Error("VAPID keys are malformed.");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(publicKey.slice(1, 1 + P256_COORDINATE_LENGTH)),
      y: toBase64Url(publicKey.slice(1 + P256_COORDINATE_LENGTH)),
      d: toBase64Url(privateKey),
    },
    SIGNING,
    false,
    ["sign"],
  );
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

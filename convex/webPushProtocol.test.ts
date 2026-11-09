/**
 * Responsibility: Pins the Web Push request builder against the RFC 8291
 *   test vector and RFC 8292's token shape.
 * Layer: Test. Vitest over the pure Web Crypto helpers.
 * Dependencies: convex/webPushProtocol.ts.
 */
import { describe, expect, it } from "vitest";
import {
  buildPushRequest,
  encryptPushMessage,
  fromBase64Url,
  PUSH_TTL_SECONDS,
  toBase64Url,
  vapidToken,
  type VapidKeys,
} from "./webPushProtocol";

// RFC 8291 Appendix A: inputs and the expected output.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};
const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const SIGNING = { name: "ECDSA", namedCurve: "P-256" } as const;
const NOW = Date.parse("2026-11-09T12:00:00Z");
const TWELVE_HOURS = 12 * 3600;

async function rfcSenderKeys(): Promise<CryptoKeyPair> {
  const point = fromBase64Url(RFC.senderPublic);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33)),
  };
  return {
    publicKey: await crypto.subtle.importKey("raw", point, EC, true, []),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: RFC.senderPrivate },
      EC,
      false,
      ["deriveBits"],
    ),
  };
}

async function vapidKeys(): Promise<{ keys: VapidKeys; verify: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(SIGNING, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    keys: {
      publicKey: toBase64Url(raw),
      privateKey: jwk.d!,
      subject: "mailto:alerts@example.test",
    },
    verify: pair.publicKey,
  };
}

describe("message encryption", () => {
  it("reproduces the RFC 8291 example byte for byte", async () => {
    const body = await encryptPushMessage(
      { keys: { p256dh: RFC.receiverPublic, auth: RFC.authSecret } },
      new TextEncoder().encode(RFC.plaintext),
      { salt: fromBase64Url(RFC.salt), senderKeys: await rfcSenderKeys() },
    );
    const expected = new Uint8Array([
      ...fromBase64Url(RFC.header),
      ...fromBase64Url(RFC.ciphertext),
    ]);
    expect(toBase64Url(body)).toBe(toBase64Url(expected));
  });

  it("draws a fresh salt and key pair for every message", async () => {
    const target = {
      keys: { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
    };
    const text = new TextEncoder().encode("same");
    const first = await encryptPushMessage(target, text);
    const second = await encryptPushMessage(target, text);
    expect(toBase64Url(first)).not.toBe(toBase64Url(second));
    expect(first.length).toBe(second.length);
  });

  it("refuses malformed subscription keys", async () => {
    await expect(
      encryptPushMessage(
        { keys: { p256dh: RFC.receiverPublic.slice(1), auth: RFC.authSecret } },
        new Uint8Array(0),
      ),
    ).rejects.toThrow("Push subscription keys are malformed.");
  });
});

describe("VAPID", () => {
  it("signs a token for the push service that its public key verifies", async () => {
    const { keys, verify } = await vapidKeys();
    const token = await vapidToken(keys, "https://push.example.test", NOW);
    const [header, claims, signature] = token.split(".");
    const decode = (part: string) =>
      JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    expect(decode(header)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decode(claims)).toEqual({
      aud: "https://push.example.test",
      exp: NOW / 1000 + TWELVE_HOURS,
      sub: "mailto:alerts@example.test",
    });
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verify,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it("builds the request with the aes128gcm headers and the authorization", async () => {
    const { keys } = await vapidKeys();
    const payload = JSON.stringify({ title: "Ops: 1 urgent alert" });
    const request = await buildPushRequest(
      {
        endpoint: "https://push.example.test/send/abc",
        keys: { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
      },
      payload,
      keys,
      NOW,
    );
    expect(request.url).toBe("https://push.example.test/send/abc");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: "high",
    });
    expect(request.headers.Authorization).toMatch(
      new RegExp(
        `^vapid t=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+, k=${keys.publicKey}$`,
      ),
    );
    // 86-byte header, the payload, the delimiter and the 16-byte tag.
    expect(request.body.length).toBe(86 + payload.length + 1 + 16);
  });

  it("refuses malformed VAPID keys", async () => {
    await expect(
      vapidToken(
        { publicKey: "AAAA", privateKey: "AAAA", subject: "mailto:x@y" },
        "https://push.example.test",
      ),
    ).rejects.toThrow("VAPID keys are malformed.");
  });
});

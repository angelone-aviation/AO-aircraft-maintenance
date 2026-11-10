/**
 * Responsibility: The shape of a device's Web Push subscription as the
 *   browser hands it over, the push services it may name, and the limits
 *   one account may hold.
 * Layer: Domain. Pure zod schema; no I/O, no React.
 * Dependencies: zod.
 */
import { z } from "zod";

/** The most devices one account may have alerted at a time. */
export const MAX_PUSH_DEVICES = 10;

const ENDPOINT_MAX_LENGTH = 2048;
const USER_AGENT_MAX_LENGTH = 300;
// RFC 8291: an uncompressed P-256 point (65 bytes) and a 16-byte secret,
// as the browser's PushSubscription.toJSON() encodes them (base64url, no
// padding).
const P256DH_LENGTH = 87;
const AUTH_LENGTH = 22;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The push services browsers subscribe through; an endpoint's host must be
 * one of these or a subdomain of one. Chrome, Edge and other Chromium
 * browsers use Firebase Cloud Messaging (fcm.googleapis.com); Firefox uses
 * Mozilla's autopush (updates.push.services.mozilla.com); Safari on macOS 13
 * and iOS 16.4 or later uses web.push.apple.com; legacy Edge used Windows
 * Push Notification Services (<region>.notify.windows.com). Sources: the
 * endpoints each browser's PushManager.subscribe() returns, as listed in
 * MDN "Push API" and the vendors' Web Push documentation (checked
 * 2026-11-10). The server POSTs to the endpoint, so any other host would let
 * a member aim the deployment's requests where they choose.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
  "web.push.apple.com",
];

/** The refusal for an endpoint outside {@link PUSH_SERVICE_HOSTS}. */
export const UNSUPPORTED_PUSH_SERVICE =
  "This browser's alert service is not supported. Use Chrome, Edge, Firefox or Safari.";

/**
 * Whether an endpoint belongs to a browser's push service: https on the
 * default port, no user name or password, and a host in
 * {@link PUSH_SERVICE_HOSTS} or below one.
 *
 * @param endpoint - The subscription's endpoint URL.
 * @returns False also for text that is not a URL.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  const url = parseUrl(endpoint);
  if (!url || url.protocol !== "https:" || url.port) return false;
  if (url.username || url.password) return false;
  return PUSH_SERVICE_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith("." + host),
  );
}

/**
 * A push subscription from `PushSubscription.toJSON()`: the push service's
 * https endpoint for the device, its two keys, and the browser's user agent
 * for the device list.
 *
 * @throws {z.ZodError} From `parse()` on anything but a push service's
 *   endpoint ({@link isPushServiceEndpoint}) of at most 2048 characters, a
 *   65-byte `p256dh` and 16-byte `auth` in base64url, and a user agent of at
 *   most 300 characters.
 */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z
    .string()
    .max(ENDPOINT_MAX_LENGTH)
    .refine(isPushServiceEndpoint, UNSUPPORTED_PUSH_SERVICE),
  keys: z.object({
    p256dh: z.string().length(P256DH_LENGTH).regex(BASE64URL),
    auth: z.string().length(AUTH_LENGTH).regex(BASE64URL),
  }),
  userAgent: z.string().max(USER_AGENT_MAX_LENGTH).optional(),
});

/** A parsed push subscription. */
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch (error) {
    // The URL constructor's TypeError is the expected answer for text that
    // is not a URL; anything else is a fault.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * Responsibility: The shape of a device's Web Push subscription as the
 *   browser hands it over, and the limits one account may hold.
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
 * A push subscription from `PushSubscription.toJSON()`: the push service's
 * https endpoint for the device, its two keys, and the browser's user agent
 * for the device list.
 *
 * @throws {z.ZodError} From `parse()` on anything but an https endpoint of
 *   at most 2048 characters, a 65-byte `p256dh` and 16-byte `auth` in
 *   base64url, and a user agent of at most 300 characters.
 */
export const pushSubscriptionInputSchema = z.object({
  endpoint: z
    .string()
    .max(ENDPOINT_MAX_LENGTH)
    .url()
    .refine((url) => url.startsWith("https://"), "Endpoint must use https."),
  keys: z.object({
    p256dh: z.string().length(P256DH_LENGTH).regex(BASE64URL),
    auth: z.string().length(AUTH_LENGTH).regex(BASE64URL),
  }),
  userAgent: z.string().max(USER_AGENT_MAX_LENGTH).optional(),
});

/** A parsed push subscription. */
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

/**
 * Responsibility: Pins which push endpoints a device may register: the
 *   browsers' own push services only, over https, without credentials or a
 *   port.
 * Layer: Test. Vitest suite; never shipped.
 * Dependencies: src/domain/pushSubscription.ts.
 */
import { expect, it } from "vitest";
import {
  isPushServiceEndpoint,
  pushSubscriptionInputSchema,
} from "./pushSubscription";

const KEYS = { p256dh: "p".repeat(87), auth: "a".repeat(22) };

it("accepts the endpoints Chrome, Edge, Firefox and Safari hand out", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/dXw6:APA91b",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
    "https://web.push.apple.com/QGuQyavXutnMH2",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
    "https://FCM.googleapis.com:443/fcm/send/x",
  ])
    expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
});

it("refuses any other host, plain http, credentials, a port and look-alikes", () => {
  for (const endpoint of [
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1:8443/admin",
    "https://localhost/internal",
    "https://10.0.0.5/",
    "https://[::1]/",
    "https://user:secret@fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com:8443/fcm/send/x",
    "http://fcm.googleapis.com/fcm/send/x",
    "https://evilfcm.googleapis.com.example.test/x",
    "https://fcm.googleapis.com.example.test/x",
    "https://notfcm.googleapis.com/x",
    "https://push.example.test/send/1",
    "not a url",
  ])
    expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false);
});

it("refuses a subscription whose endpoint is not a push service", () => {
  const parse = (endpoint: string) =>
    pushSubscriptionInputSchema.safeParse({ endpoint, keys: KEYS }).success;
  expect(parse("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
  expect(parse("https://push.example.test/send/1")).toBe(false);
});

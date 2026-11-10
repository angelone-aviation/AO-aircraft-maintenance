/**
 * Responsibility: Pins this device's alerts: an endpoint outside the
 *   browsers' push services refused before the server hears of it, the
 *   switch showing the account's subscription under the current key, a
 *   subscription under an old key replaced, and sign-out releasing the
 *   device.
 * Layer: Test. Vitest suite with stubbed browser push APIs; never shipped.
 * Dependencies: src/data/pushDevice.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import {
  deviceAlertsOn,
  enablePushAlerts,
  releasePushDevice,
} from "./pushDevice";

// A 65-byte P-256 public key in base64url, and another one.
const KEY = "B" + "A".repeat(86);
const OTHER_KEY = "B" + "Q".repeat(86);
const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) =>
    c.charCodeAt(0),
  ).buffer;

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(
  endpoint: string,
  existing?: { key: string; endpoint: string },
) {
  const old = existing && {
    endpoint: existing.endpoint,
    options: { applicationServerKey: keyBytes(existing.key) },
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const subscription = {
    endpoint,
    options: { applicationServerKey: keyBytes(KEY) },
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    }),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(old ?? null),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };
  vi.stubGlobal("navigator", {
    userAgent: "Test browser",
    serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue({ pushManager }),
    },
  });
  const Notification = {
    requestPermission: vi.fn().mockResolvedValue("granted"),
  };
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("window", { PushManager: {}, Notification });
  return { subscription, old, pushManager };
}

it("refuses a browser whose push service is not supported, before the server hears of it", async () => {
  const { subscription } = stubBrowser("https://push.example.test/send/1");
  const subscribePush = vi.fn();
  await expect(
    enablePushAlerts({ subscribePush } as never, KEY),
  ).rejects.toThrow(
    "This browser's alert service is not supported. Use Chrome, Edge, Firefox or Safari.",
  );
  expect(subscribePush).not.toHaveBeenCalled();
  expect(subscription.unsubscribe).toHaveBeenCalled();
});

it("records a push service's subscription on the account", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
  const { subscription } = stubBrowser(endpoint);
  const subscribePush = vi.fn().mockResolvedValue(null);
  await enablePushAlerts({ subscribePush } as never, KEY);
  expect(subscribePush).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint }),
  );
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});

const PHONE = "https://fcm.googleapis.com/fcm/send/phone";

it("replaces a subscription made under an earlier key, after the key pair is rotated", async () => {
  const { old, pushManager } = stubBrowser(PHONE, {
    key: OTHER_KEY,
    endpoint: "https://fcm.googleapis.com/fcm/send/old",
  });
  const subscribePush = vi.fn().mockResolvedValue(null);
  await enablePushAlerts({ subscribePush } as never, KEY);
  expect(old!.unsubscribe).toHaveBeenCalled();
  expect(pushManager.subscribe).toHaveBeenCalled();
  expect(subscribePush).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: PHONE }),
  );
});

it("shows alerts on only while this account holds the device under the current key", async () => {
  stubBrowser(PHONE, { key: KEY, endpoint: PHONE });
  const pushDeviceHeld = vi.fn().mockResolvedValue(true);
  expect(await deviceAlertsOn({ pushDeviceHeld } as never, KEY)).toBe(true);
  expect(pushDeviceHeld).toHaveBeenCalledWith(PHONE);
  // Someone else's subscription on a shared device.
  pushDeviceHeld.mockResolvedValue(false);
  expect(await deviceAlertsOn({ pushDeviceHeld } as never, KEY)).toBe(false);
  // A subscription under the key before a rotation can never arrive.
  pushDeviceHeld.mockResolvedValue(true);
  expect(await deviceAlertsOn({ pushDeviceHeld } as never, OTHER_KEY)).toBe(
    false,
  );
});

it("releases the device at sign-out, in the browser even when the server cannot be told", async () => {
  const { old } = stubBrowser(PHONE, { key: KEY, endpoint: PHONE });
  const unsubscribePush = vi.fn().mockRejectedValue(new Error("Offline."));
  await releasePushDevice({ unsubscribePush } as never);
  expect(unsubscribePush).toHaveBeenCalledWith(PHONE);
  expect(old!.unsubscribe).toHaveBeenCalled();
});

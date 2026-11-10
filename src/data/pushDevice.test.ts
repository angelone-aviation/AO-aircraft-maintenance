/**
 * Responsibility: Pins turning alerts on for this device: an endpoint
 *   outside the browsers' push services is refused with a plain message and
 *   undone in the browser before the server hears of it.
 * Layer: Test. Vitest suite with stubbed browser push APIs; never shipped.
 * Dependencies: src/data/pushDevice.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { enablePushAlerts } from "./pushDevice";

const KEY = "B".repeat(87);

afterEach(() => vi.unstubAllGlobals());

function stubBrowser(endpoint: string) {
  const subscription = {
    endpoint,
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({
      endpoint,
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    }),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };
  vi.stubGlobal("navigator", {
    userAgent: "Test browser",
    serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue({ pushManager }),
    },
  });
  vi.stubGlobal("Notification", {
    requestPermission: vi.fn().mockResolvedValue("granted"),
  });
  return subscription;
}

it("refuses a browser whose push service is not supported, before the server hears of it", async () => {
  const subscription = stubBrowser("https://push.example.test/send/1");
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
  const subscription = stubBrowser(endpoint);
  const subscribePush = vi.fn().mockResolvedValue(null);
  await enablePushAlerts({ subscribePush } as never, KEY);
  expect(subscribePush).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint }),
  );
  expect(subscription.unsubscribe).not.toHaveBeenCalled();
});

/**
 * Responsibility: Pins the device-alert paths the main push suite leaves out:
 *   switching on without a worker or permission, a refusal undone in the
 *   browser, reuse of a current subscription, switching off, the endpoint
 *   read, and which devices must be added to the Home Screen first.
 * Layer: Test. Vitest suite with stubbed browser push APIs; never shipped.
 * Dependencies: src/data/pushDevice.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentPushEndpoint,
  disablePushAlerts,
  enablePushAlerts,
  needsHomeScreenInstall,
  releasePushDevice,
} from "./pushDevice";

// A 65-byte P-256 public key in base64url.
const KEY = "B" + "A".repeat(86);
const PHONE = "https://fcm.googleapis.com/fcm/send/phone";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

afterEach(() => vi.unstubAllGlobals());

describe("switching alerts on", () => {
  it("asks for a reload when the service worker is not registered", async () => {
    const { subscribePush } = stubBrowser({ registered: false });
    await expect(enablePushAlerts(backend(subscribePush), KEY)).rejects.toThrow(
      "Reload the app once online so it can receive alerts, then try again.",
    );
    expect(subscribePush).not.toHaveBeenCalled();
  });

  it("explains a refused permission and subscribes nothing", async () => {
    const { pushManager, subscribePush } = stubBrowser({
      permission: "denied",
    });
    await expect(enablePushAlerts(backend(subscribePush), KEY)).rejects.toThrow(
      "This device blocks alerts from Angel One. Allow them in the browser's site settings, then try again.",
    );
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("keeps a subscription already made under the current key", async () => {
    const { pushManager, subscribePush, subscription } = stubBrowser({
      existing: true,
    });
    await enablePushAlerts(backend(subscribePush), KEY);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(subscribePush).toHaveBeenCalledWith({
      endpoint: PHONE,
      keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
      userAgent: "Test browser",
    });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("undoes the browser's subscription when the server refuses it", async () => {
    const refusal = new Error("Sign in again.");
    const { subscribePush, subscription } = stubBrowser({});
    subscribePush.mockRejectedValue(refusal);
    await expect(enablePushAlerts(backend(subscribePush), KEY)).rejects.toBe(
      refusal,
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it("refuses an incomplete subscription from the browser, and undoes it", async () => {
    const { subscribePush, subscription } = stubBrowser({ keys: false });
    await expect(enablePushAlerts(backend(subscribePush), KEY)).rejects.toThrow(
      "The browser returned an incomplete subscription.",
    );
    expect(subscribePush).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
});

describe("switching alerts off", () => {
  it("forgets the device on the account, then in the browser", async () => {
    const { subscription } = stubBrowser({ existing: true });
    const order: string[] = [];
    const unsubscribePush = vi.fn(async () => void order.push("server"));
    subscription.unsubscribe.mockImplementation(async () => {
      order.push("browser");
      return true;
    });
    await disablePushAlerts({ unsubscribePush } as never);
    expect(unsubscribePush).toHaveBeenCalledWith(PHONE);
    expect(order).toEqual(["server", "browser"]);
  });

  it("tells nobody when the device holds no subscription", async () => {
    stubBrowser({});
    const unsubscribePush = vi.fn();
    await disablePushAlerts({ unsubscribePush } as never);
    await releasePushDevice({ unsubscribePush } as never);
    expect(unsubscribePush).not.toHaveBeenCalled();
  });
});

describe("the current endpoint", () => {
  it("is the subscription's endpoint, or null without one", async () => {
    stubBrowser({ existing: true });
    expect(await currentPushEndpoint()).toBe(PHONE);
    stubBrowser({});
    expect(await currentPushEndpoint()).toBeNull();
  });

  it("is null in a browser without push support", async () => {
    vi.stubGlobal("navigator", { userAgent: "Old browser" });
    vi.stubGlobal("window", {});
    expect(await currentPushEndpoint()).toBeNull();
  });
});

describe("adding the app to the Home Screen first", () => {
  it.each([
    ["an iPhone tab", IPHONE, "", 0, false, true],
    ["the installed iPhone app", IPHONE, "", 0, true, false],
    ["an iPad tab that reports a Mac", MAC, "MacIntel", 5, false, true],
    ["a Mac", MAC, "MacIntel", 0, false, false],
    [
      "an Android phone",
      "Mozilla/5.0 (Linux; Android 14)",
      "",
      5,
      false,
      false,
    ],
  ])(
    "decides for %s",
    (_, userAgent, platform, maxTouchPoints, standalone, needed) => {
      vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints });
      vi.stubGlobal("window", {
        matchMedia: (query: string) => ({
          matches: standalone && query === "(display-mode: standalone)",
        }),
      });
      expect(needsHomeScreenInstall()).toBe(needed);
    },
  );
});

function backend(subscribePush: ReturnType<typeof vi.fn>) {
  return { subscribePush } as never;
}

function keyBytes(key: string) {
  return Uint8Array.from(atob(key + "="), (c) => c.charCodeAt(0)).buffer;
}

// A browser with push support. `existing` puts this device's subscription
// (under KEY) in place; `keys: false` makes the browser omit its keys.
function stubBrowser(options: {
  registered?: boolean;
  permission?: string;
  existing?: boolean;
  keys?: boolean;
}) {
  const subscription = {
    endpoint: PHONE,
    options: { applicationServerKey: keyBytes(KEY) },
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({
      endpoint: PHONE,
      keys:
        options.keys === false
          ? undefined
          : { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    }),
  };
  const pushManager = {
    getSubscription: vi
      .fn()
      .mockResolvedValue(options.existing ? subscription : null),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };
  const registration =
    options.registered === false ? undefined : { pushManager };
  vi.stubGlobal("navigator", {
    userAgent: "Test browser",
    serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration) },
  });
  const Notification = {
    requestPermission: vi
      .fn()
      .mockResolvedValue(options.permission ?? "granted"),
  };
  vi.stubGlobal("Notification", Notification);
  vi.stubGlobal("window", { PushManager: {}, Notification });
  return { subscription, pushManager, subscribePush: vi.fn() };
}

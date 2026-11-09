/**
 * Responsibility: This device's urgent-alert subscription: whether the
 *   browser can receive push messages, whether it is subscribed, and turning
 *   that on or off through the service worker and the Backend.
 * Layer: Data. Browser push APIs and the Backend; no React.
 * Dependencies: src/data/backend.ts (types), src/domain/pushSubscription.ts
 *   (types).
 *
 * iOS delivers push messages only to an app added to the Home Screen (iOS
 * 16.4 and later), never to a Safari tab; the Settings block says so.
 */
import type { Backend } from "./backend";
import type { PushSubscriptionInput } from "../domain/pushSubscription";

const DENIED =
  "This device blocks alerts from Angel One. Allow them in the browser's site settings, then try again.";
const NOT_INSTALLED =
  "Reload the app once online so it can receive alerts, then try again.";

/**
 * Whether this browser can subscribe to push messages at all.
 *
 * @returns True with a service worker, a push manager and the alert
 *   permission API.
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Whether the device is an iPhone or iPad running in a browser tab, where
 * push messages arrive only after the app is added to the Home Screen.
 *
 * @returns True for iOS and iPadOS outside the installed app.
 */
export function needsHomeScreenInstall(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return false;
  const apple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return apple && !window.matchMedia("(display-mode: standalone)").matches;
}

/**
 * The endpoint this device is subscribed with, if any.
 *
 * @returns The endpoint, or null without a registration or subscription.
 */
export async function currentPushEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

/**
 * Subscribes this device and records the subscription on the account. A
 * subscription the server refuses is undone in the browser.
 *
 * @param backend - The signed-in Backend.
 * @param publicKey - The deployment's public push key (base64url).
 * @throws {Error} "This device blocks alerts from Angel One. …" when the
 *   permission is refused; "Reload the app once online …" without a service
 *   worker registration; the server's refusal.
 */
export async function enablePushAlerts(
  backend: Backend,
  publicKey: string,
): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error(NOT_INSTALLED);
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error(DENIED);
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    }));
  try {
    await backend.subscribePush(toInput(subscription));
  } catch (error) {
    // The server did not record the device, so the browser must not keep a
    // subscription nobody will send to.
    await subscription.unsubscribe();
    throw error;
  }
}

/**
 * Unsubscribes this device and forgets it on the account.
 *
 * @param backend - The signed-in Backend.
 */
export async function disablePushAlerts(backend: Backend): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await backend.unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
}

function toInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
    throw new Error("The browser returned an incomplete subscription.");
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent,
  };
}

// base64url, as web-push's generate-vapid-keys prints it.
function decodeKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

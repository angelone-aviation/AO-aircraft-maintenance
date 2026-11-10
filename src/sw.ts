/**
 * Responsibility: The service worker: the offline app shell (precache, the
 *   on-demand document cache, the navigation fallback) and urgent alerts
 *   pushed to the device.
 * Layer: UI (entry). Built by vite-plugin-pwa's injectManifest from
 *   vite.config.ts; it runs outside the page, with no access to the
 *   workspace or the Backend.
 * Dependencies: workbox-precaching, workbox-routing, workbox-strategies,
 *   workbox-expiration.
 *
 * The caching here is the same as the generateSW worker it replaced
 * (vite.config.ts "workbox" options before ADR-0012); keep it so, since the
 * offline and PWA browser specs pin it. Only the push handlers are new.
 */
/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

/** What an urgent push message carries (src/domain/alertDigest.ts). */
interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// TypeScript's DOM types omit `renotify`; Chromium honours it and other
// browsers ignore it.
interface AlertCardOptions extends NotificationOptions {
  renotify?: boolean;
}

const APP_SHELL = "/index.html";
const ON_DEMAND_CACHE = "on-demand-documents";
const ON_DEMAND_MAX_ENTRIES = 40;
const ALERTS_URL = "/alerts";
const ICON = "/icon-192.png";

// The page's registerSW posts this to apply an update (prompt strategy).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") void self.skipWaiting();
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// security.txt and the disclosure policy (SECURITY.md) must open as
// themselves even in an installed app, not as the app shell.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(APP_SHELL), {
    denylist: [/^\/\.well-known\//],
  }),
);

// The PDF viewer, PDF export and the print font are cached the first time
// they are used online instead of at install (see globIgnores).
registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/pdfjs/") ||
    url.pathname.startsWith("/fonts/") ||
    /^\/assets\/(pdfRuntime-|jspdf|html2canvas-)/.test(url.pathname),
  new CacheFirst({
    cacheName: ON_DEMAND_CACHE,
    plugins: [new ExpirationPlugin({ maxEntries: ON_DEMAND_MAX_ENTRIES })],
  }),
);

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  const options: AlertCardOptions = {
    body: payload.body,
    icon: ICON,
    badge: ICON,
    data: { url: payload.url },
    // One alert card per program: a newer message replaces the older, and
    // still sounds, since it carries a new alert.
    tag: payload.tag,
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(readUrl(event.notification.data), self.location.origin);
  event.waitUntil(openApp(url.href));
});

// A message the server did not send (or an empty one) still shows a card
// that opens the alerts screen, so nothing arrives silently.
function readPayload(event: PushEvent): PushPayload {
  const fallback = {
    title: "Angel One alerts",
    body: "",
    url: ALERTS_URL,
    tag: "urgent",
  };
  try {
    const data = event.data?.json() as Partial<PushPayload> | null;
    return {
      title: typeof data?.title === "string" ? data.title : fallback.title,
      body: typeof data?.body === "string" ? data.body : fallback.body,
      url: typeof data?.url === "string" ? data.url : fallback.url,
      // A message from before tags were sent shares one card.
      tag: typeof data?.tag === "string" ? data.tag : fallback.tag,
    };
  } catch {
    return fallback;
  }
}

function readUrl(data: unknown): string {
  return data && typeof data === "object" && "url" in data
    ? String((data as { url: unknown }).url)
    : ALERTS_URL;
}

// Focus an open app window and navigate it; open one otherwise.
async function openApp(href: string): Promise<void> {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const client = windows.find((w) => w.url.startsWith(self.location.origin));
  if (client) {
    await client.focus();
    await client.navigate(href);
    return;
  }
  await self.clients.openWindow(href);
}

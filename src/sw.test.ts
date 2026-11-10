/**
 * Responsibility: Pins the service worker's push cards (one card per program,
 *   the fallback for a message it cannot read), where a tapped card opens,
 *   the update message and which requests the on-demand cache takes.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/sw.ts (workbox modules mocked).
 *
 * The worker registers its handlers when it loads, so the suite loads it once
 * against a fake `self` and calls the handlers it registered.
 */
// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://angelone.example";
const PROGRAM_TAG = "urgent:11111111-1111-4111-8111-111111111111";

type Handler = (event: unknown) => void;
type Matcher = (request: { url: URL }) => boolean;

const worker = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => void>(),
  routes: [] as unknown[],
  navigationOptions: undefined as unknown,
}));

vi.mock("workbox-precaching", () => ({
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(),
  precacheAndRoute: vi.fn(),
}));
vi.mock("workbox-routing", () => ({
  NavigationRoute: class {
    constructor(_handler: unknown, options: unknown) {
      worker.navigationOptions = options;
    }
  },
  registerRoute: (route: unknown) => worker.routes.push(route),
}));
vi.mock("workbox-strategies", () => ({ CacheFirst: class {} }));
vi.mock("workbox-expiration", () => ({ ExpirationPlugin: class {} }));

const showNotification = vi.fn(async () => {});
const skipWaiting = vi.fn(async () => {});
const matchAll = vi.fn(async (): Promise<FakeWindow[]> => []);
const openWindow = vi.fn(async () => null);

interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

beforeAll(async () => {
  vi.stubGlobal("self", {
    __WB_MANIFEST: [],
    location: new URL(ORIGIN),
    registration: { showNotification },
    clients: { matchAll, openWindow },
    skipWaiting,
    addEventListener: (type: string, handler: Handler) =>
      worker.handlers.set(type, handler),
  });
  await import("./sw");
});

beforeEach(() => vi.clearAllMocks());

describe("an urgent push message", () => {
  it("shows one card per program that replaces the last and still sounds", async () => {
    await push({
      json: () => ({
        title: "N206MA grounded",
        body: "Annual inspection overdue",
        url: "/alerts?aircraft=a1",
        tag: PROGRAM_TAG,
      }),
    });
    expect(showNotification).toHaveBeenCalledWith("N206MA grounded", {
      body: "Annual inspection overdue",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: "/alerts?aircraft=a1" },
      tag: PROGRAM_TAG,
      renotify: true,
    });
  });

  it("puts a message sent before tags existed on one shared card", async () => {
    await push({ json: () => ({ title: "Alert", body: "b", url: "/x" }) });
    expect(cardOptions().tag).toBe("urgent");
  });

  it("still shows a card that opens the alerts screen for an unreadable message", async () => {
    await push({
      json: () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    expect(showNotification).toHaveBeenCalledWith(
      "Angel One alerts",
      expect.objectContaining({ body: "", data: { url: "/alerts" } }),
    );
  });

  it("falls back field by field when a message has the wrong types", async () => {
    await push({ json: () => ({ title: 7, body: "kept", url: null, tag: 1 }) });
    expect(showNotification).toHaveBeenCalledWith(
      "Angel One alerts",
      expect.objectContaining({
        body: "kept",
        data: { url: "/alerts" },
        tag: "urgent",
      }),
    );
  });

  it("shows the fallback card for a message with no data", async () => {
    await push(null);
    expect(showNotification).toHaveBeenCalledWith(
      "Angel One alerts",
      expect.objectContaining({ tag: "urgent" }),
    );
  });
});

describe("a tapped alert card", () => {
  it("focuses an open app window and takes it to the card's page", async () => {
    const elsewhere = fakeWindow("https://other.example/");
    const app = fakeWindow(`${ORIGIN}/fleet`);
    matchAll.mockResolvedValueOnce([elsewhere, app]);
    const close = await click({ url: "/alerts?aircraft=a1" });
    expect(close).toHaveBeenCalled();
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).toHaveBeenCalledWith(`${ORIGIN}/alerts?aircraft=a1`);
    expect(elsewhere.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window on the alerts screen when the card has no page", async () => {
    await click(undefined);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/alerts`);
  });
});

it("applies a waiting update only when the page asks for it", () => {
  handler("message")({ data: { type: "OTHER" } });
  expect(skipWaiting).not.toHaveBeenCalled();
  handler("message")({ data: { type: "SKIP_WAITING" } });
  expect(skipWaiting).toHaveBeenCalledOnce();
});

it("keeps the disclosure files out of the app shell's navigation route", () => {
  const { denylist } = worker.navigationOptions as { denylist: RegExp[] };
  expect(denylist.some((re) => re.test("/.well-known/security.txt"))).toBe(
    true,
  );
  expect(denylist.some((re) => re.test("/fleet"))).toBe(false);
});

it("caches only the PDF viewer, PDF export and print font on first use", () => {
  const matches = worker.routes.find(
    (route): route is Matcher => typeof route === "function",
  );
  const cached = (path: string) => matches?.({ url: new URL(path, ORIGIN) });
  expect(cached("/pdfjs/pdf.worker.mjs")).toBe(true);
  expect(cached("/fonts/print.ttf")).toBe(true);
  expect(cached("/assets/pdfRuntime-abc.js")).toBe(true);
  expect(cached("/assets/jspdf.es.min-abc.js")).toBe(true);
  expect(cached("/assets/html2canvas-abc.js")).toBe(true);
  expect(cached("/assets/index-abc.js")).toBe(false);
  expect(cached("/fleet")).toBe(false);
});

function handler(type: string): Handler {
  const registered = worker.handlers.get(type);
  if (!registered) throw new Error(`The worker registered no ${type} handler.`);
  return registered;
}

async function push(data: { json: () => unknown } | null): Promise<void> {
  const waited: Promise<unknown>[] = [];
  handler("push")({ data, waitUntil: (p: Promise<unknown>) => waited.push(p) });
  await Promise.all(waited);
}

async function click(data: unknown): Promise<ReturnType<typeof vi.fn>> {
  const close = vi.fn();
  const waited: Promise<unknown>[] = [];
  handler("notificationclick")({
    notification: { close, data },
    waitUntil: (p: Promise<unknown>) => waited.push(p),
  });
  await Promise.all(waited);
  return close;
}

function cardOptions(): { tag?: string } {
  const [, options] = showNotification.mock.calls[0] as unknown as [
    string,
    { tag?: string },
  ];
  return options;
}

function fakeWindow(url: string): FakeWindow {
  return { url, focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) };
}

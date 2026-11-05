/**
 * Responsibility: Pins error reporting's switch and privacy rules: nothing
 *   loads without a DSN; with one, the Sentry settings, what beforeSend strips
 *   and which errors are forwarded.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/errorReporting.ts, vitest (mocks @sentry/react).
 */
import type { BrowserOptions, ErrorEvent } from "@sentry/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DSN = "https://public@o1.ingest.us.sentry.io/1";

const sdk = vi.hoisted(() => ({
  loaded: false,
  failLoad: false,
  init: vi.fn<(options: BrowserOptions) => void>(),
  captureException: vi.fn(),
  rootHandler: vi.fn(),
}));

// Registered for each load, so every test imports the SDK afresh.
function mockSentry() {
  if (sdk.failLoad)
    throw new Error("Failed to fetch dynamically imported module");
  sdk.loaded = true;
  return {
    init: sdk.init,
    captureException: sdk.captureException,
    reactErrorHandler: () => sdk.rootHandler,
    makeFetchTransport: "fetch",
    makeBrowserOfflineTransport: (inner: unknown) => ({ offlineOver: inner }),
  };
}

beforeEach(() => {
  sdk.loaded = false;
  sdk.failLoad = false;
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("without a DSN", () => {
  it("reports nothing and never loads the SDK", async () => {
    const reporting = await load("");

    await reporting.initErrorReporting();
    reporting.captureError(new Error("registration failed"));

    expect(reporting.reactErrorHandlers()).toEqual({});
    expect(sdk.loaded).toBe(false);
  });
});

describe("with a DSN", () => {
  it("starts Sentry once, offline-capable, without personal data or replay", async () => {
    const reporting = await load(DSN);

    await reporting.initErrorReporting();
    await reporting.initErrorReporting();

    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sentOptions()).toMatchObject({
      dsn: DSN,
      environment: "production",
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      transport: { offlineOver: "fetch" },
      transportOptions: { flushAtStartup: true },
    });
    expect(sentOptions().integrations).toBeUndefined();
  });

  it("strips the user, query strings, cookies and headers before sending", async () => {
    const reporting = await load(DSN);
    await reporting.initErrorReporting();
    const event: ErrorEvent = {
      type: undefined,
      user: { id: "user-1", email: "pilot@example.org" },
      request: {
        url: "https://ops.example.org/work-orders?code=one-time#top",
        cookies: { session: "abc" },
        headers: { Referer: "https://ops.example.org/?code=one-time" },
      },
      breadcrumbs: [
        { category: "navigation", data: { from: "/?code=x", to: "/fleet#t" } },
        { category: "fetch", data: { url: "/api?token=y", method: "GET" } },
      ],
    };

    const sent = sentOptions().beforeSend?.(event, {});

    expect(sent).toEqual({
      type: undefined,
      request: { url: "https://ops.example.org/work-orders" },
      breadcrumbs: [
        { category: "navigation", data: { from: "/", to: "/fleet" } },
        { category: "fetch", data: { url: "/api", method: "GET" } },
      ],
    });
  });

  it("forwards React root errors and other failures", async () => {
    const reporting = await load(DSN);
    const error = new Error("render failed");
    const errorInfo = { componentStack: "\n    at Workspace" };

    const { onUncaughtError, onCaughtError } = reporting.reactErrorHandlers();
    onUncaughtError?.(error, errorInfo);
    onCaughtError?.(error, errorInfo);
    reporting.captureError(error);

    await vi.waitFor(() => {
      expect(sdk.rootHandler).toHaveBeenCalledTimes(2);
      expect(sdk.captureException).toHaveBeenCalledWith(error);
    });
    expect(sdk.rootHandler).toHaveBeenCalledWith(error, errorInfo);
    expect(sdk.init).toHaveBeenCalledOnce();
  });

  it("stays off for the page load when the SDK cannot load", async () => {
    sdk.failLoad = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reporting = await load(DSN);

    await reporting.initErrorReporting();
    reporting.captureError(new Error("registration failed"));

    expect(sdk.init).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

async function load(dsn: string) {
  vi.stubEnv("VITE_SENTRY_DSN", dsn);
  vi.doMock("@sentry/react", mockSentry);
  return import("./errorReporting");
}

function sentOptions(): BrowserOptions {
  return sdk.init.mock.calls[0][0];
}

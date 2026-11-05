/**
 * Responsibility: Reports browser errors to Sentry, scrubbed of personal data,
 *   when the build names a DSN; without one it does nothing and loads nothing.
 * Layer: Data. Browser start-up side effect; no rendering, no domain rules.
 * Dependencies: @sentry/react (imported on demand), react-dom/client (types).
 *
 * No replay, no user identity and no query strings leave the device: a URL can
 * carry a one-time sign-in code (docs/runbooks/monitoring.md).
 */
import type { RootOptions } from "react-dom/client";
import type { Breadcrumb, BrowserOptions, ErrorEvent } from "@sentry/react";

type Sentry = typeof import("@sentry/react");
type Reporter = Pick<Sentry, "captureException" | "reactErrorHandler">;
type RootErrorHandlers = Pick<RootOptions, "onUncaughtError" | "onCaughtError">;
// The offline transport reads its settings from transportOptions, which
// BrowserOptions types for the plain fetch transport only.
type OfflineTransportOptions = Parameters<
  ReturnType<Sentry["makeBrowserOfflineTransport"]>
>[0];

// Set at build time only by the production deploy, so tests, the demo and
// builds without keys leave the SDK out of the bundle entirely.
const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE as string | undefined;
const BREADCRUMB_URL_KEYS = ["url", "from", "to"] as const;

let reporter: Promise<Reporter | undefined> | undefined;

/**
 * Starts error reporting when the build names a Sentry DSN. Events recorded
 * offline wait in IndexedDB and are sent at the next start-up.
 *
 * @returns Resolves once Sentry is running, or at once when reporting is off;
 *   never rejects (an SDK that fails to load leaves reporting off).
 */
export async function initErrorReporting(): Promise<void> {
  if (!DSN) return;
  await loadSentry(DSN);
}

/**
 * The React root's error hooks, which send render errors to Sentry.
 *
 * @returns `onUncaughtError` and `onCaughtError` for `createRoot`, which
 *   replace React's console logging of those errors; no hooks when reporting
 *   is off, so React keeps logging them.
 */
export function reactErrorHandlers(): RootErrorHandlers {
  if (!DSN) return {};
  const forward = (error: unknown, errorInfo: { componentStack?: string }) =>
    void loadSentry(DSN).then((sentry) =>
      sentry?.reactErrorHandler()(error, errorInfo),
    );
  return { onUncaughtError: forward, onCaughtError: forward };
}

/**
 * Sends an error that no React hook or global handler sees, such as a failed
 * service worker registration. Does nothing when reporting is off.
 *
 * @param error The thrown value, sent as is.
 */
export function captureError(error: unknown): void {
  if (!DSN) return;
  void loadSentry(DSN).then((sentry) => sentry?.captureException(error));
}

function loadSentry(dsn: string): Promise<Reporter | undefined> {
  // Named exports only, so the bundle keeps what these use and leaves out the
  // SDK's replay and feedback code.
  reporter ??= import("@sentry/react").then(
    ({
      init,
      makeBrowserOfflineTransport,
      makeFetchTransport,
      captureException,
      reactErrorHandler,
    }) => {
      const transport = makeBrowserOfflineTransport(makeFetchTransport);
      init(sentryOptions(dsn, transport));
      return { captureException, reactErrorHandler };
    },
    (error: unknown) => {
      // The SDK chunk can be missing offline before the service worker cached
      // it; the app must run regardless, and the next start-up tries again.
      console.warn("Error reporting is off for this visit.", error);
      return undefined;
    },
  );
  return reporter;
}

function sentryOptions(
  dsn: string,
  transport: BrowserOptions["transport"],
): BrowserOptions {
  const transportOptions: Partial<OfflineTransportOptions> = {
    flushAtStartup: true,
  };
  return {
    dsn,
    environment: "production",
    release: RELEASE || undefined,
    // Sentry 11 replaced sendDefaultPii with these settings, and their
    // defaults collect user details, the IP address, cookies, headers and
    // query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    transport,
    transportOptions,
    beforeSend: scrubEvent,
  };
}

function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  event.breadcrumbs?.forEach(scrubBreadcrumb);
  return event;
}

function scrubBreadcrumb({ data }: Breadcrumb): void {
  for (const key of BREADCRUMB_URL_KEYS)
    if (typeof data?.[key] === "string") data[key] = withoutQuery(data[key]);
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

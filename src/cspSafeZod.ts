/**
 * Responsibility: The browser build's "zod" (vite.config.ts alias): zod with
 *   its eval-based object parsers turned off.
 * Layer: Config. Ships in the bundle in place of "zod"; no app logic.
 * Dependencies: zod/v4.
 *
 * The production Content-Security-Policy (public/_headers) has no
 * 'unsafe-eval'. Without this setting zod probes with `new Function`, which
 * the browser reports as a CSP violation even though zod catches the error.
 * zod reads the setting when a schema is created, so it must run before any
 * module defines one; every such module imports "zod", so it imports this
 * module, which runs first.
 */
import { z } from "zod/v4";

z.config({ jitless: true });

export * from "zod/v4";

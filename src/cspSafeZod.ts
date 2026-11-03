// The browser build resolves "zod" to this module (vite.config.ts).
//
// The production Content-Security-Policy (public/_headers) has no
// 'unsafe-eval'. Turn off zod's compiled object parsers so zod never probes
// with `new Function`, which the browser reports as a CSP violation even
// though zod catches the error. zod reads the setting when a schema is
// created, so it must run before any module that defines one; every such
// module imports "zod", so it imports this module, which runs first.
import { z } from "zod/v4";

z.config({ jitless: true });

export * from "zod/v4";

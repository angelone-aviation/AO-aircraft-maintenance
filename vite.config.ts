/**
 * Responsibility: Builds and serves the app: the eval-free zod alias, the
 *   PDF.js files published beside the bundle, the offline PWA from its own
 *   service worker (src/sw.ts), Sentry source maps when the release build
 *   has an upload token, and no build at all in Cloudflare's Git builder.
 * Layer: Config. Build tooling only; nothing here ships in the bundle.
 * Dependencies: vite, @vitejs/plugin-react, vite-plugin-pwa,
 *   @sentry/vite-plugin, pdfjs-dist, src/cspSafeZod.ts, src/sw.ts,
 *   src/data/pdfCompatibility.js, scripts/cloudflareBuildGuard.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version as pdfVersion } from "pdfjs-dist/package.json";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { assertNotCloudflareGitBuild } from "./scripts/cloudflareBuildGuard";

const PDF_ROOT = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const PDF_VIEWER_FILES = collectPdfViewerFiles();
// Only the production deploy has it (docs/runbooks/monitoring.md); without it
// the build makes no source maps at all.
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const LOCAL_ONLY = "localhost";

/** The app's build, dev server and offline service worker. */
export default defineConfig({
  define: {
    // The PDF viewer files fetched on demand, which src/data/pdfOffline.ts
    // caches ahead of need for manuals kept on the device.
    __PDF_VIEWER_FILES__: JSON.stringify(
      [...PDF_VIEWER_FILES.keys()].filter(
        (name) => !/LICENSE|quickjs/.test(name),
      ),
    ),
  },
  resolve: {
    // Load zod with eval-free parsing so the app runs under the production
    // Content-Security-Policy without violations (src/cspSafeZod.ts).
    alias: [
      {
        find: /^zod$/,
        replacement: fileURLToPath(
          new URL("./src/cspSafeZod.ts", import.meta.url),
        ),
      },
    ],
  },
  // This computer only (security review S18): the hangar Wi-Fi is shared.
  // The development container passes --host 0.0.0.0 behind a port it
  // publishes on the host's loopback only (README).
  server: {
    host: LOCAL_ONLY,
    port: 5173,
    strictPort: true,
    // Container-mounted edits do not always produce filesystem notifications.
    watch: { usePolling: true, interval: 500 },
  },
  preview: { host: LOCAL_ONLY },
  build: {
    // Hidden: no bundle names its map, and the Sentry plugin deletes the maps
    // after uploading them, so none is published.
    sourcemap: SENTRY_AUTH_TOKEN ? "hidden" : false,
  },
  plugins: [
    refuseCloudflareGitBuild(),
    publishPdfViewerFiles(),
    retireOfflineWorkerInDevelopment(),
    react(),
    VitePWA({
      registerType: "prompt",
      // Our own worker (src/sw.ts): the same caching generateSW produced,
      // plus the push handlers for urgent alerts (ADR-0012).
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Angel One Aircraft Operations",
        short_name: "Angel One",
        description: "Aircraft flights, discrepancies, and maintenance status",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,mjs,css,html,png,webp,svg,woff2,ttf,wasm}"],
        // Keep the install download small on older phones: the PDF viewer,
        // PDF export and the print font are cached the first time they are
        // used online instead of at install (src/sw.ts). Screens and the QR
        // scanner stay precached so the app still works offline out of the
        // box.
        globIgnores: [
          "pdfjs/**",
          "fonts/*.ttf",
          "assets/pdfRuntime-*.js",
          "assets/jspdf*.js",
          "assets/html2canvas-*.js",
        ],
        // Otherwise it follows build.sourcemap and publishes sw.js with a
        // visible map; the worker runs no Sentry code, so it needs none.
        sourcemap: false,
      },
    }),
    uploadSourceMapsToSentry(),
  ],
});

// Last plugin, so it sees the finished bundle. A failed upload is only logged,
// so a Sentry outage never blocks a release (its stack traces stay minified),
// and the maps are deleted either way.
function uploadSourceMapsToSentry(): PluginOption {
  if (!SENTRY_AUTH_TOKEN) return false;
  return sentryVitePlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: SENTRY_AUTH_TOKEN,
    release: { name: process.env.VITE_SENTRY_RELEASE },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
    telemetry: false,
  });
}

// First plugin, so the refusal comes before any work. Builds only: the dev
// server and vitest never publish.
function refuseCloudflareGitBuild(): Plugin {
  return {
    name: "refuse-cloudflare-git-build",
    apply: "build",
    config() {
      assertNotCloudflareGitBuild(process.env);
    },
  };
}

// PDF.js image decoders and its worker, keyed by the path the app fetches.
function collectPdfViewerFiles(): Map<string, Buffer> {
  const prefix = `pdfjs/${pdfVersion}/`;
  const files = new Map(
    readdirSync(join(PDF_ROOT, "wasm")).map((name) => [
      `${prefix}wasm/${name}`,
      readFileSync(join(PDF_ROOT, "wasm", name)),
    ]),
  );
  // Keep the worker as an ES module with its exports intact for PDF.js's
  // main-thread fallback, and include the same compatibility shim as the page.
  files.set(
    `${prefix}pdf.worker.compat.mjs`,
    Buffer.concat([
      readFileSync(new URL("./src/data/pdfCompatibility.js", import.meta.url)),
      Buffer.from("\n"),
      readFileSync(join(PDF_ROOT, "legacy/build/pdf.worker.min.mjs")),
    ]),
  );
  return files;
}

// Serves the PDF.js files in development and emits them into the build.
function publishPdfViewerFiles(): Plugin {
  return {
    name: "pdf-image-decoders",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split("?")[0].replace(/^\//, "");
        const data = name && PDF_VIEWER_FILES.get(name);
        if (!data) return next();
        res.setHeader("Content-Type", contentTypeOf(name));
        res.end(data);
      });
    },
    generateBundle() {
      for (const [fileName, source] of PDF_VIEWER_FILES)
        this.emitFile({ type: "asset", fileName, source });
    },
  };
}

// Replaces a previously installed production worker when development uses the
// same address, while keeping app data and offline caches intact.
function retireOfflineWorkerInDevelopment(): Plugin {
  return {
    name: "retire-offline-worker-in-development",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/sw.js") return next();
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(`
            self.addEventListener("install", () => self.skipWaiting());
            self.addEventListener("activate", (event) => {
              event.waitUntil(self.registration.unregister());
            });
            self.addEventListener("fetch", (event) => {
              event.respondWith(fetch(event.request));
            });
          `);
      });
    },
  };
}

function contentTypeOf(name: string): string {
  if (name.endsWith(".wasm")) return "application/wasm";
  if (/\.m?js$/.test(name)) return "application/javascript";
  return "text/plain";
}

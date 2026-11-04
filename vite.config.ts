/**
 * Responsibility: Builds and serves the app: the eval-free zod alias, the
 *   PDF.js files published beside the bundle, and the offline PWA.
 * Layer: Config. Build tooling only; nothing here ships in the bundle.
 * Dependencies: vite, @vitejs/plugin-react, vite-plugin-pwa, pdfjs-dist,
 *   src/cspSafeZod.ts, src/data/pdfCompatibility.js.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version as pdfVersion } from "pdfjs-dist/package.json";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const PDF_ROOT = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const PDF_VIEWER_FILES = collectPdfViewerFiles();

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
  server: {
    port: 5173,
    strictPort: true,
    // Container-mounted edits do not always produce filesystem notifications.
    watch: { usePolling: true, interval: 500 },
  },
  plugins: [
    publishPdfViewerFiles(),
    retireOfflineWorkerInDevelopment(),
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Angel One Aircraft Operations",
        short_name: "Angel One",
        description: "Aircraft flights, discrepancies, and maintenance status",
        theme_color: "#0b1434",
        background_color: "#f3f4f8",
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
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,png,svg,woff2,ttf,wasm}"],
        // Keep the install download small on older phones: the PDF viewer,
        // PDF export and the print font are cached the first time they are
        // used online instead of at install. Screens and the QR scanner stay
        // precached so the app still works offline out of the box.
        globIgnores: [
          "pdfjs/**",
          "fonts/*.ttf",
          "assets/pdfRuntime-*.js",
          "assets/jspdf*.js",
          "assets/html2canvas-*.js",
        ],
        runtimeCaching: [
          {
            // Workbox copies this function's source into sw.js, so it must
            // not use names from this file.
            urlPattern: ({ url }) =>
              url.pathname.startsWith("/pdfjs/") ||
              url.pathname.startsWith("/fonts/") ||
              /^\/assets\/(pdfRuntime-|jspdf|html2canvas-)/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "on-demand-documents",
              expiration: { maxEntries: 40 },
            },
          },
        ],
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});

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

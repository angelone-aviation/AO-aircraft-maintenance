import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { version as pdfVersion } from "pdfjs-dist/package.json";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
const pdfRoot = dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const decoderPrefix = `pdfjs/${pdfVersion}/wasm/`;
const decoderFiles = new Map(
  readdirSync(join(pdfRoot, "wasm")).map((name) => [
    decoderPrefix + name,
    readFileSync(join(pdfRoot, "wasm", name)),
  ]),
);
// Keep the worker as an ES module with its exports intact for PDF.js's
// main-thread fallback, and include the same compatibility shim as the page.
decoderFiles.set(
  `pdfjs/${pdfVersion}/pdf.worker.compat.mjs`,
  Buffer.concat([
    readFileSync(new URL("./src/data/pdfCompatibility.js", import.meta.url)),
    Buffer.from("\n"),
    readFileSync(join(pdfRoot, "legacy/build/pdf.worker.min.mjs")),
  ]),
);
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // Container-mounted edits do not always produce filesystem notifications.
    watch: { usePolling: true, interval: 500 },
  },
  plugins: [
    {
      name: "pdf-image-decoders",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const name = req.url?.split("?")[0].replace(/^\//, "");
          const data = name && decoderFiles.get(name);
          if (!data) return next();
          res.setHeader(
            "Content-Type",
            name.endsWith(".wasm")
              ? "application/wasm"
              : /\.m?js$/.test(name)
                ? "application/javascript"
                : "text/plain",
          );
          res.end(data);
        });
      },
      generateBundle() {
        for (const [fileName, source] of decoderFiles)
          this.emitFile({ type: "asset", fileName, source });
      },
    },
    {
      name: "retire-offline-worker-in-development",
      apply: "serve",
      configureServer(server) {
        // Replace a previously installed production worker when using the same
        // address for development. Keep app data and offline caches intact.
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
    },
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

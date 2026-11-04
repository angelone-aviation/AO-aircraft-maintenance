/**
 * Responsibility: Fetches the PDF viewer's files through the service worker
 *   ahead of need, so kept manuals open offline.
 * Layer: Data. Browser-only; no React.
 * Dependencies: src/data/pdfRuntime.ts (loaded on demand).
 *
 * The service worker caches the viewer's runtime chunk, worker and image
 * decoders the first time they are fetched online ("on-demand-documents" in
 * vite.config.ts), not at install. A kept manual must also render on a device
 * that has never opened a manual online.
 */
let warmed: Promise<void> | undefined;

/**
 * Loads the PDF viewer runtime and fetches each viewer file once, so the
 * service worker caches them. Cached files are served without a download.
 *
 * @returns Resolves when every fetch has settled; failures are ignored. Calls
 *   made while a warm-up runs share it; a later call starts another. Resolves
 *   at once when no service worker controls the page.
 */
export function warmPdfViewer() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller)
    return Promise.resolve();
  return (warmed ??= fetchViewerFiles().finally(() => {
    // Allow another attempt later in this session (e.g. after reconnecting).
    warmed = undefined;
  }));
}

async function fetchViewerFiles(): Promise<void> {
  const files =
    typeof __PDF_VIEWER_FILES__ === "undefined" ? [] : __PDF_VIEWER_FILES__;
  // Best effort: a file that fails now is fetched again when a manual opens.
  await Promise.all([
    import("./pdfRuntime").catch(() => undefined),
    ...files.map((file) =>
      fetch(import.meta.env.BASE_URL + file)
        .then((response) => response.arrayBuffer())
        .catch(() => undefined),
    ),
  ]);
}

// The PDF viewer's runtime chunk, worker and image decoders are cached by the
// service worker the first time they are fetched online ("on-demand-documents"
// in vite.config.ts), not at install. A kept manual must also render on a
// device that has never opened a manual online, so keeping one, and starting
// the app while manuals are kept (for instance after an update), fetches them
// through the service worker ahead of need. Cached files are served from the
// cache without a download.
let warmed: Promise<void> | undefined;
export function warmPdfViewer() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller)
    return Promise.resolve();
  return (warmed ??= (async () => {
    const files =
      typeof __PDF_VIEWER_FILES__ === "undefined" ? [] : __PDF_VIEWER_FILES__;
    await Promise.all([
      import("./pdfRuntime").catch(() => undefined),
      ...files.map((file) =>
        fetch(import.meta.env.BASE_URL + file)
          .then((response) => response.arrayBuffer())
          .catch(() => undefined),
      ),
    ]);
  })().finally(() => {
    // Allow another attempt later in this session (e.g. after reconnecting).
    warmed = undefined;
  }));
}

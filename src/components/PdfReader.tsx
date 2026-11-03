import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { version as pdfVersion } from "pdfjs-dist/package.json";
import "./pdfReader.css";

/** Render the selected page ourselves: native iPad PDF embeds ignore #page. */
export function PdfReader({
  url,
  initialPage,
  title,
  onLoadError,
}: {
  url: string;
  initialPage: number;
  title: string;
  /** The document could not be opened (not called for password prompts). */
  onLoadError?: () => void;
}) {
  const loadErrorHandler = useRef(onLoadError);
  useEffect(() => {
    loadErrorHandler.current = onLoadError;
  });
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [entry, setEntry] = useState(String(initialPage));
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(initialPage);
    setEntry(String(initialPage));
  }, [initialPage, url]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () =>
      setWidth(Math.max(200, Math.round(element.clientWidth - 24)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false;
    let passworded = false;
    let task:
      ReturnType<(typeof import("pdfjs-dist"))["getDocument"]> | undefined;
    setDocument(null);
    setError("");
    setLoading(true);
    setText("");
    void import("../data/pdfRuntime")
      .then(async (pdfjs) => {
        if (canceled) return;
        task = pdfjs.getDocument({
          url,
          useSystemFonts: true,
          wasmUrl: new URL(
            `${import.meta.env.BASE_URL}pdfjs/${pdfVersion}/wasm/`,
            window.location.origin,
          ).href,
          // Surface image decode failures instead of presenting a blank success.
          stopAtErrors: true,
        });
        task.onPassword = () => {
          passworded = true;
          if (!canceled) {
            setError(
              "This PDF requires a password. Download it to open it in a PDF reader.",
            );
            setLoading(false);
          }
          void task?.destroy();
        };
        const pdf = await task.promise;
        if (!canceled) setDocument(pdf);
      })
      .catch((e) => {
        if (!canceled) {
          setError(e instanceof Error ? e.message : "Unable to load PDF.");
          setLoading(false);
          // Only the document itself failing, not the viewer runtime.
          if (task && !passworded) loadErrorHandler.current?.();
        }
      });
    return () => {
      canceled = true;
      void task?.destroy();
    };
  }, [url]);
  useEffect(() => {
    const host = surface.current;
    host?.replaceChildren();
    setText("");
    if (!document || !host) return;
    let canceled = false,
      render: RenderTask | undefined;
    setError("");
    setLoading(true);
    if (!Number.isInteger(page) || page < 1 || page > document.numPages) {
      setError(`Enter a page from 1 to ${document.numPages}.`);
      setLoading(false);
      return;
    }
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (canceled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({
        scale: (width / base.width) * zoom,
      });
      // Bound canvas memory for iPads, especially during zoom and rotation.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
      );
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${title} — PDF page ${page}`);
      render = pdfPage.render({
        canvas,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await render.promise;
      if (canceled) return;
      host.replaceChildren(canvas);
      setLoading(false);
      // Safari supports getReader(), but not ReadableStream async iteration
      // used by PDF.js getTextContent(). Keep optional text separate from rendering.
      const reader = pdfPage.streamTextContent().getReader();
      const parts: string[] = [];
      try {
        while (!canceled) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items)
            if ("str" in item) parts.push(item.str);
        }
        if (!canceled) setText(parts.join(" "));
      } catch {
        // Text extraction is optional; the rendered manual remains usable.
      } finally {
        if (canceled) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })().catch((e) => {
      if (!canceled) {
        setError(
          e instanceof Error ? e.message : "Unable to display this page.",
        );
        setLoading(false);
      }
    });
    return () => {
      canceled = true;
      render?.cancel();
    };
  }, [document, page, width, zoom, title]);
  const navigate = (next: number) => {
    setPage(next);
    setEntry(String(next));
  };
  return (
    <section className="pdf-reader" aria-label="PDF reader">
      <div className="pdf-reader-toolbar">
        <button
          type="button"
          className="button"
          disabled={!document || page <= 1}
          onClick={() => navigate(page - 1)}
        >
          Previous page
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate(Number(entry));
          }}
        >
          <label>
            PDF page{" "}
            <input
              aria-label="PDF viewer page number"
              type="number"
              min={1}
              max={document?.numPages}
              step={1}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              required
            />
          </label>
          <span>of {document?.numPages.toLocaleString() ?? "…"}</span>
          <button className="button" disabled={!document}>
            Go
          </button>
        </form>
        <button
          type="button"
          className="button"
          disabled={!document || page >= document.numPages}
          onClick={() => navigate(page + 1)}
        >
          Next page
        </button>
        <label>
          Zoom{" "}
          <select
            aria-label="PDF zoom"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            <option value={1}>Fit width</option>
            <option value={1.25}>125%</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
            <option value={3}>300%</option>
          </select>
        </label>
      </div>
      <div className="pdf-reader-viewport" ref={container} aria-busy={loading}>
        {loading && <p role="status">Loading PDF page {page}…</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div ref={surface} className="pdf-reader-surface" />
      </div>
      {text && (
        <details className="pdf-reader-text">
          <summary>Page text</summary>
          <p>{text}</p>
        </details>
      )}
      <p className="muted">
        PDF page numbers may differ from the printed page labels in the manual.
      </p>
    </section>
  );
}

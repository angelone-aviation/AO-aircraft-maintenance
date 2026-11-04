/**
 * Responsibility: Shows a PDF one page at a time on a canvas, with page
 *   navigation, zoom and the page's text.
 * Layer: UI. React component; loads PDF.js on demand through src/data.
 * Dependencies: react, pdfjs-dist (types, version), src/data/pdfRuntime.ts,
 *   ./ui.tsx, ./pdfReader.css.
 *
 * Pages are rendered here because native iPad PDF embeds ignore #page.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  PageViewport,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import { version as pdfVersion } from "pdfjs-dist/package.json";
import { errorText } from "./ui";
import "./pdfReader.css";

const MIN_PAGE_WIDTH = 200;
// The viewport's 12px padding on each side (pdfReader.css).
const VIEWPORT_PADDING = 24;
// Bound canvas memory for iPads, especially during zoom and rotation.
const MAX_PIXEL_RATIO = 2;
const MAX_CANVAS_PIXELS = 4_000_000;
const ZOOM_OPTIONS = [
  [1, "Fit width"],
  [1.25, "125%"],
  [1.5, "150%"],
  [2, "200%"],
  [3, "300%"],
] as const;

type PdfRuntime = typeof import("../data/pdfRuntime");
type LoadingTask = ReturnType<(typeof import("pdfjs-dist"))["getDocument"]>;
type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type PageControls = ReturnType<typeof usePageControls>;
type ToolbarProps = { controls: PageControls; pageCount: number | undefined };
type PageRequest = { page: number; width: number; zoom: number; title: string };
type StatusSetters = {
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  setText: (text: string) => void;
};
/** One document load; the effect's cleanup cancels it. */
type DocumentAttempt = {
  canceled: boolean;
  passworded: boolean;
  task?: LoadingTask;
};
/** One render of one page; the effect's cleanup cancels it. */
type PageJob = { canceled: boolean; render?: RenderTask };

/**
 * A PDF reader that renders the chosen page itself, with previous, next and
 * go-to-page controls, zoom and a "Page text" disclosure.
 *
 * @param props.url - The PDF; a new url reloads the document.
 * @param props.initialPage - Page to show; a new value (or url) moves there.
 * @param props.title - Names each rendered page: "<title> — PDF page <n>".
 * @param props.onLoadError - Called when the document cannot be opened; not
 *   for a password prompt or a viewer runtime that fails to load.
 * @returns The reader section; load and page errors show inside it.
 */
export function PdfReader({
  url,
  initialPage,
  title,
  onLoadError,
}: {
  url: string;
  initialPage: number;
  title: string;
  onLoadError?: () => void;
}) {
  const controls = usePageControls(initialPage, url);
  const { page, zoom } = controls;
  const view = usePdfView(url, onLoadError, { page, zoom, title });
  const { pdf, loading, error, text, container, surface } = view;
  return (
    <section className="pdf-reader" aria-label="PDF reader">
      <PdfToolbar controls={controls} pageCount={pdf?.numPages} />
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

/** The toolbar's state: the shown page, the page-number box and the zoom. */
function usePageControls(initialPage: number, url: string) {
  const [page, setPage] = useState(initialPage);
  const [entry, setEntry] = useState(String(initialPage));
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    setPage(initialPage);
    setEntry(String(initialPage));
  }, [initialPage, url]);
  const navigate = (next: number) => {
    setPage(next);
    setEntry(String(next));
  };
  return { page, entry, setEntry, navigate, zoom, setZoom };
}

// Keep the document effect before the page effect: when both run in one
// commit, the page effect's status updates land last.
function usePdfView(
  url: string,
  onLoadError: (() => void) | undefined,
  { page, zoom, title }: Omit<PageRequest, "width">,
) {
  const loadErrorHandler = useRef(onLoadError);
  useEffect(() => {
    loadErrorHandler.current = onLoadError;
  });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const width = useFitWidth(container);
  useEffect(() => {
    setPdf(null);
    setError("");
    setLoading(true);
    setText("");
    const view = { setPdf, setError, setLoading, setText };
    return openDocument(url, view, () => loadErrorHandler.current?.());
  }, [url]);
  useEffect(() => {
    const request = { page, width, zoom, title };
    const view = { setError, setLoading, setText };
    return showPage(surface.current, pdf, request, view);
  }, [pdf, page, width, zoom, title]);
  return { pdf, loading, error, text, container, surface };
}

function useFitWidth(container: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => {
      const fit = Math.round(element.clientWidth - VIEWPORT_PADDING);
      setWidth(Math.max(MIN_PAGE_WIDTH, fit));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);
  return width;
}

function openDocument(
  url: string,
  view: StatusSetters & { setPdf: (pdf: PDFDocumentProxy) => void },
  onDocumentError: () => void,
): () => void {
  const attempt: DocumentAttempt = { canceled: false, passworded: false };
  void import("../data/pdfRuntime")
    .then(async (pdfjs) => {
      if (attempt.canceled) return;
      const task = startLoading(pdfjs, url);
      attempt.task = task;
      task.onPassword = () => {
        attempt.passworded = true;
        if (!attempt.canceled) {
          view.setError(
            "This PDF requires a password. Download it to open it in a PDF reader.",
          );
          view.setLoading(false);
        }
        void task.destroy();
      };
      const pdf = await task.promise;
      if (!attempt.canceled) view.setPdf(pdf);
    })
    .catch((e) => {
      if (attempt.canceled) return;
      view.setError(errorText(e, "Unable to load PDF."));
      view.setLoading(false);
      // Only the document itself failing, not the viewer runtime.
      if (attempt.task && !attempt.passworded) onDocumentError();
    });
  return () => {
    attempt.canceled = true;
    void attempt.task?.destroy();
  };
}

function startLoading(pdfjs: PdfRuntime, url: string): LoadingTask {
  return pdfjs.getDocument({
    url,
    useSystemFonts: true,
    wasmUrl: new URL(
      `${import.meta.env.BASE_URL}pdfjs/${pdfVersion}/wasm/`,
      window.location.origin,
    ).href,
    // Surface image decode failures instead of presenting a blank success.
    stopAtErrors: true,
  });
}

function showPage(
  host: HTMLDivElement | null,
  pdf: PDFDocumentProxy | null,
  request: PageRequest,
  view: StatusSetters,
): (() => void) | undefined {
  host?.replaceChildren();
  view.setText("");
  if (!pdf || !host) return;
  view.setError("");
  view.setLoading(true);
  const { page } = request;
  if (!Number.isInteger(page) || page < 1 || page > pdf.numPages) {
    view.setError(`Enter a page from 1 to ${pdf.numPages}.`);
    view.setLoading(false);
    return;
  }
  const job: PageJob = { canceled: false };
  void drawPage(pdf, host, request, job, view).catch((e) => {
    if (job.canceled) return;
    view.setError(errorText(e, "Unable to display this page."));
    view.setLoading(false);
  });
  return () => {
    job.canceled = true;
    job.render?.cancel();
  };
}

async function drawPage(
  pdf: PDFDocumentProxy,
  host: HTMLDivElement,
  { page, width, zoom, title }: PageRequest,
  job: PageJob,
  view: StatusSetters,
) {
  const pdfPage = await pdf.getPage(page);
  if (job.canceled) return;
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: (width / base.width) * zoom });
  const ratio = Math.min(
    window.devicePixelRatio || 1,
    MAX_PIXEL_RATIO,
    Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
  );
  const label = `${title} — PDF page ${page}`;
  const canvas = createPageCanvas(viewport, ratio, label);
  const transform = [ratio, 0, 0, ratio, 0, 0];
  job.render = pdfPage.render({ canvas, viewport, transform });
  await job.render.promise;
  if (job.canceled) return;
  host.replaceChildren(canvas);
  view.setLoading(false);
  await showPageText(pdfPage, job, view.setText);
}

function createPageCanvas(
  viewport: PageViewport,
  ratio: number,
  label: string,
): HTMLCanvasElement {
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  return canvas;
}

async function showPageText(
  pdfPage: PDFPageProxy,
  job: PageJob,
  setText: (text: string) => void,
) {
  // Safari supports getReader(), but not ReadableStream async iteration
  // used by PDF.js getTextContent(). Keep optional text separate from rendering.
  const reader: ReadableStreamDefaultReader<TextContent> = pdfPage
    .streamTextContent()
    .getReader();
  try {
    const parts = await readTextItems(reader, job);
    if (!job.canceled) setText(parts.join(" "));
  } catch {
    // Text extraction is optional; the rendered manual remains usable.
  } finally {
    // Cancel rejects once the stream has errored; the page is shown anyway.
    if (job.canceled) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readTextItems(
  reader: ReadableStreamDefaultReader<TextContent>,
  job: PageJob,
): Promise<string[]> {
  const chunks: TextContent[] = [];
  while (!job.canceled) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks
    .flatMap((chunk) => chunk.items)
    .flatMap((item) => ("str" in item ? [item.str] : []));
}

function PdfToolbar({ controls, pageCount }: ToolbarProps) {
  const { page, navigate } = controls;
  return (
    <div className="pdf-reader-toolbar">
      <button
        type="button"
        className="button"
        disabled={pageCount === undefined || page <= 1}
        onClick={() => navigate(page - 1)}
      >
        Previous page
      </button>
      <PageForm controls={controls} pageCount={pageCount} />
      <button
        type="button"
        className="button"
        disabled={pageCount === undefined || page >= pageCount}
        onClick={() => navigate(page + 1)}
      >
        Next page
      </button>
      <ZoomSelect controls={controls} />
    </div>
  );
}

function PageForm({ controls, pageCount }: ToolbarProps) {
  const { entry, setEntry, navigate } = controls;
  return (
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
          max={pageCount}
          step={1}
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          required
        />
      </label>
      <span>of {pageCount?.toLocaleString() ?? "…"}</span>
      <button className="button" disabled={pageCount === undefined}>
        Go
      </button>
    </form>
  );
}

function ZoomSelect({ controls }: { controls: PageControls }) {
  return (
    <label>
      Zoom{" "}
      <select
        aria-label="PDF zoom"
        value={controls.zoom}
        onChange={(e) => controls.setZoom(Number(e.target.value))}
      >
        {ZOOM_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

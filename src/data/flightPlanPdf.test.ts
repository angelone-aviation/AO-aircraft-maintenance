/**
 * Responsibility: Pins the flight-plan PDF import: the ICAO fixture parses on
 *   older browsers, steps are reported in order, and bad uploads are refused.
 * Layer: Test. Runs PDF.js's legacy build under Node with @napi-rs/canvas.
 * Dependencies: vitest, src/data/flightPlanPdf.ts, src/data/manualPdf.ts,
 *   jspdf, tests/fixtures/icao-flight-plan.pdf.
 *
 * @vitest-environment node
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { jsPDF } from "jspdf";
import { expect, it, vi } from "vitest";
import type { PdfText } from "../domain/pdf/icao";

const SUCCESS_STAGES = [
  "Validate file",
  "Read file bytes",
  "Calculate file fingerprint",
  "Create PDF reader",
  "Open PDF",
  "Read first page",
  "Extract PDF text",
  "Normalize PDF text coordinates",
  "Parse flight-plan fields",
  "Close PDF reader",
];
const MIB = 1024 * 1024;

it("imports the original ICAO PDF without modern Promise APIs", async () => {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers")!;
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const { readFlightPlanPdf } = await import("./flightPlanPdf");
    const { GlobalWorkerOptions } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ).href;
    const bytes = await readFile("tests/fixtures/icao-flight-plan.pdf");
    const result = await readFlightPlanPdf(
      new File([bytes], "ipad-flight-plan.pdf", { type: "application/pdf" }),
    );
    expect(result).toMatchObject({
      registration: "N626KB",
      origin: "MZBZ",
      destination: "KCHA",
      sourceName: "ipad-flight-plan.pdf",
    });
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    const { inspectManualPdf } = await import("./manualPdf");
    expect(
      await inspectManualPdf(
        new File([bytes], "manual.pdf", { type: "application/pdf" }),
      ),
    ).toBe(1);
  } finally {
    Object.defineProperty(Promise, "withResolvers", descriptor);
  }
});

it("extracts flight-plan text without ReadableStream async iteration (Safari 18.6)", async () => {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const descriptor = Object.getOwnPropertyDescriptor(
    ReadableStream.prototype,
    Symbol.asyncIterator,
  )!;
  Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator);
  try {
    const { readFlightPlanPdf } = await import("./flightPlanPdf");
    const { GlobalWorkerOptions } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ).href;
    const bytes = await readFile("tests/fixtures/icao-flight-plan.pdf");
    const result = await readFlightPlanPdf(
      new File([bytes], "ipad-flight-plan.pdf", { type: "application/pdf" }),
    );
    expect(result).toMatchObject({
      registration: "N626KB",
      origin: "MZBZ",
      destination: "KCHA",
    });
  } finally {
    Object.defineProperty(
      ReadableStream.prototype,
      Symbol.asyncIterator,
      descriptor,
    );
  }
});

it("reports each step in order and fingerprints the file's bytes", async () => {
  const readFlightPlanPdf = await loadImporter();
  const bytes = await readFile("tests/fixtures/icao-flight-plan.pdf");
  const stages: string[] = [];

  const result = await readFlightPlanPdf(
    new File([bytes], "plan.PDF"),
    (stage) => stages.push(stage),
  );

  expect(stages).toEqual(SUCCESS_STAGES);
  expect(result.sourceHash).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
});

it.each([
  ["plan.txt", 1],
  ["plan.pdf", 10 * MIB + 1],
])("refuses %s of %i bytes before reading it", async (name, size) => {
  const readFlightPlanPdf = await loadImporter();
  const stages: string[] = [];

  await expect(
    readFlightPlanPdf(new File([new Uint8Array(size)], name), (stage) =>
      stages.push(stage),
    ),
  ).rejects.toThrow("Choose a PDF smaller than 10 MiB.");
  expect(stages).toEqual(["Validate file"]);
});

it("accepts exactly 10 MiB, then closes the reader quietly when PDF.js fails", async () => {
  const readFlightPlanPdf = await loadImporter();
  const stages: string[] = [];

  await expect(
    readFlightPlanPdf(new File([new Uint8Array(10 * MIB)], "plan.pdf"), (s) =>
      stages.push(s),
    ),
  ).rejects.toThrow(/PDF/);
  expect(stages).toEqual(SUCCESS_STAGES.slice(0, 5));
  // Builds and parses a 10 MiB file: seconds of work, past vitest's 5 s
  // default on a busy machine.
}, 30_000);

it("refuses a PDF of more than one page", async () => {
  const readFlightPlanPdf = await loadImporter();
  const doc = new jsPDF();
  doc.addPage();
  const stages: string[] = [];

  await expect(
    readFlightPlanPdf(
      new File([doc.output("arraybuffer")], "plan.pdf"),
      (stage) => stages.push(stage),
    ),
  ).rejects.toThrow("Upload the single-page ICAO flight-plan form.");
  expect(stages.at(-1)).toBe("Open PDF");
});

it("scales text from another page size to the planning app's page", async () => {
  const parsed: PdfText[][] = [];
  vi.resetModules();
  vi.doMock("../domain/pdf/icao", () => ({
    parseIcao: (items: PdfText[]) => (parsed.push(items), {}),
  }));
  try {
    const readFlightPlanPdf = await loadImporter();
    const letter = new jsPDF({ unit: "pt", format: "letter" });
    letter.text("MARK", 306, 396);

    await readFlightPlanPdf(
      new File([letter.output("arraybuffer")], "plan.pdf"),
    );

    const mark = parsed[0].find((item) => item.str === "MARK");
    expect(mark?.x).toBeCloseTo((306 * 594.95996) / 612, 2);
    expect(mark?.y).toBeCloseTo((396 * 841.91998) / 792, 2);
  } finally {
    vi.doUnmock("../domain/pdf/icao");
    vi.resetModules();
  }
});

it("closes the reader on failure without letting a close error hide it", async () => {
  const destroy = vi.fn(() => Promise.reject(new Error("close failed")));
  vi.resetModules();
  vi.doMock("./pdfRuntime", () => ({
    getDocument: () => ({
      promise: Promise.reject(new Error("unreadable")),
      destroy,
    }),
  }));
  try {
    const { readFlightPlanPdf } = await import("./flightPlanPdf");

    await expect(
      readFlightPlanPdf(new File(["%PDF"], "plan.pdf")),
    ).rejects.toThrow("unreadable");
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    vi.doUnmock("./pdfRuntime");
    vi.resetModules();
  }
});

async function loadImporter() {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { readFlightPlanPdf } = await import("./flightPlanPdf");
  const { GlobalWorkerOptions } =
    await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  ).href;
  return readFlightPlanPdf;
}

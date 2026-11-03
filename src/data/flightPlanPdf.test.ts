// @vitest-environment node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { expect, it } from "vitest";

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

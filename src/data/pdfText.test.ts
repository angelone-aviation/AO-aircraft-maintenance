/**
 * Responsibility: Pins how a page's text stream is collected: chunk order,
 *   merged styles, the first language, and the released lock.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pdfText.ts.
 */
import { expect, it } from "vitest";
import { readPdfText } from "./pdfText";

function pageStreaming(chunks: object[], failure?: Error) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (failure) controller.error(failure);
      else controller.close();
    },
  });
  return { stream, page: { streamTextContent: () => stream } };
}

it("joins chunks in order, merges styles and keeps the first language", async () => {
  const { stream, page } = pageStreaming([
    { items: [{ str: "N101AO" }], styles: { f1: { fontFamily: "serif" } } },
    { items: [{ str: "Hobbs" }, { str: "2,441.2" }], styles: {}, lang: "en" },
    {
      items: [{ str: "h" }],
      styles: { f1: { fontFamily: "sans" } },
      lang: "fr",
    },
  ]);
  expect(await readPdfText(page)).toEqual({
    items: [
      { str: "N101AO" },
      { str: "Hobbs" },
      { str: "2,441.2" },
      { str: "h" },
    ],
    styles: { f1: { fontFamily: "sans" } },
    lang: "en",
  });
  expect(stream.locked).toBe(false);
});

it("releases the stream when reading fails", async () => {
  const { stream, page } = pageStreaming(
    [{ items: [], styles: {} }],
    new Error("Bad XRef entry"),
  );
  await expect(readPdfText(page)).rejects.toThrow("Bad XRef entry");
  expect(stream.locked).toBe(false);
});

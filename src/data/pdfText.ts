/**
 * Responsibility: Reads the text of one PDF page through PDF.js.
 * Layer: Data. PDF parsing helper for the importers; no React.
 * Dependencies: pdfjs-dist (types only).
 *
 * Reads the text stream with getReader(): Safari 18.6 does not implement the
 * stream async iterator that PDF.js's own getTextContent() uses.
 */
import type { PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

/**
 * Collects a page's text content, in the shape getTextContent() returns.
 *
 * @param page - The PDF.js page; only its text stream is read.
 * @returns The items of every chunk in stream order, their styles merged, and
 *   `lang` from the first chunk that has one. The stream's lock is released
 *   even when reading fails.
 */
export async function readPdfText(
  page: Pick<PDFPageProxy, "streamTextContent">,
): Promise<TextContent> {
  const reader = page.streamTextContent().getReader();
  try {
    return await collectTextContent(reader);
  } finally {
    reader.releaseLock();
  }
}

async function collectTextContent(
  reader: ReadableStreamDefaultReader<TextContent>,
): Promise<TextContent> {
  const content: TextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) return content;
    content.lang ??= value.lang;
    Object.assign(content.styles, value.styles);
    content.items.push(...value.items);
  }
}

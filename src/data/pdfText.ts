import type { PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

/**
 * Read PDF text using getReader(): Safari 18.6 does not implement the stream
 * async iterator used internally by PDF.js's getTextContent().
 */
export async function readPdfText(
  page: Pick<PDFPageProxy, "streamTextContent">,
): Promise<TextContent> {
  const reader = page.streamTextContent().getReader();
  const content: TextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return content;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
}

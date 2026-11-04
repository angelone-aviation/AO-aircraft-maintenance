/**
 * Responsibility: An in-memory Cache Storage and streamed PDF responses for
 *   unit tests of kept manuals and cached files.
 * Layer: Test. Vitest fixture; no browser.
 * Dependencies: none (Fetch API globals).
 *
 * `put` consumes the response body the way the browser does (a failing
 * stream rejects the put and stores nothing), and `quota` simulates a device
 * without room for another file.
 */

const PDF_HEADER = "%PDF-1.7\n";
const BYTE_PATTERN_PERIOD = 251;

interface CachedEntry {
  body: Uint8Array<ArrayBuffer>;
  headers: [string, string][];
}

class MemoryCache {
  readonly entries = new Map<string, CachedEntry>();
  constructor(private readonly storage: MemoryCacheStorage) {}
  async match(request: RequestInfo | URL) {
    const entry = this.entries.get(requestKey(request));
    return entry
      ? new Response(entry.body, { headers: entry.headers })
      : undefined;
  }
  async put(request: RequestInfo | URL, response: Response) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (
      this.storage.quota !== undefined &&
      this.storage.used() + body.byteLength > this.storage.quota
    )
      throw Object.assign(new Error("The quota has been exceeded."), {
        name: "QuotaExceededError",
      });
    this.entries.set(requestKey(request), {
      body,
      headers: [...response.headers],
    });
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(requestKey(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

/**
 * Stands in for the global `caches` (`open`, `has`, `delete`, `keys`). A put
 * that would take the stored bytes past `quota` throws a `QuotaExceededError`,
 * as a full device does.
 */
export class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>();
  /** Total bytes the device holds; unlimited when undefined. */
  quota?: number;
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) this.caches.set(name, (cache = new MemoryCache(this)));
    return cache;
  }
  async has(name: string) {
    return this.caches.has(name);
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  /** Bytes stored across every cache. */
  used() {
    let total = 0;
    for (const cache of this.caches.values())
      for (const entry of cache.entries.values())
        total += entry.body.byteLength;
    return total;
  }
  /** Every stored URL, as `cache name → URLs`, for assertions. */
  contents() {
    return Object.fromEntries(
      [...this.caches].map(([name, cache]) => [
        name,
        [...cache.entries.keys()],
      ]),
    );
  }
}

/**
 * A PDF-like body of `size` bytes: the PDF header (cut short if `size` is
 * smaller), then a repeating byte pattern.
 */
export function pdfBytes(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(PDF_HEADER).slice(0, size));
  for (let i = PDF_HEADER.length; i < size; i++)
    bytes[i] = i % BYTE_PATTERN_PERIOD;
  return bytes;
}

/**
 * A PDF response whose body streams `bytes` in at most `chunks` pieces of
 * `ceil(length / chunks)` bytes, pulled one at a time as a download is.
 */
export function streamedResponse(bytes: Uint8Array, chunks = 4) {
  const step = Math.max(1, Math.ceil(bytes.byteLength / chunks));
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + step));
        offset += step;
      },
    }),
    { headers: { "Content-Type": "application/pdf" } },
  );
}

/** Cache entries are keyed by URL, however the request names it. */
function requestKey(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

// In-memory Cache Storage for unit tests. `put` consumes the response body the
// way the browser does (a failing stream rejects the put and stores nothing),
// and `quota` simulates a device without room for another file.
const key = (request: RequestInfo | URL) =>
  typeof request === "string"
    ? request
    : request instanceof URL
      ? request.href
      : request.url;

class MemoryCache {
  readonly entries = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; headers: [string, string][] }
  >();
  constructor(private readonly storage: MemoryCacheStorage) {}
  async match(request: RequestInfo | URL) {
    const entry = this.entries.get(key(request));
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
    this.entries.set(key(request), { body, headers: [...response.headers] });
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(key(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

export class MemoryCacheStorage {
  readonly caches = new Map<string, MemoryCache>();
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

/** A PDF-like body of `size` bytes delivered in `chunks` pieces. */
export function pdfBytes(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n").slice(0, size));
  for (let i = 9; i < size; i++) bytes[i] = i % 251;
  return bytes;
}
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

/**
 * Responsibility: Pins which step an Aircraft Spruce download failure names,
 *   and the export size limit.
 * Layer: Test. Vitest with a stubbed fetch; no Convex backend.
 * Dependencies: convex/spruceHttp.
 */
import { afterEach, expect, it, vi } from "vitest";
import { downloadSpruce } from "./spruceHttp";

const credentials = {
  userid: "private-user",
  password: "private-password",
  apikey: "private-key",
  currency: "USD",
};
const EXPORT = { url: "https://www.aircraftspruce.com/downloads/export.csv" };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(...responses: Response[]) {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function failure(step: string) {
  return {
    data: `Aircraft Spruce download failed: ${step}. Check the account details, API access and connection, then retry.`,
  };
}

it("names the HTTP status of a failed export request", async () => {
  stubFetch(new Response("", { status: 503 }));
  await expect(downloadSpruce("orders", credentials)).rejects.toMatchObject(
    failure("export request (HTTP 503)"),
  );
});

it("reports only the provider's three-digit code from a rejection", async () => {
  stubFetch(Response.json({ status: false, error: "401 private-key" }));
  await expect(downloadSpruce("orders", credentials)).rejects.toMatchObject(
    failure("export response rejected (provider code 401)"),
  );
});

it("refuses a download address off the provider's downloads path", async () => {
  for (const url of [
    "http://www.aircraftspruce.com/downloads/x.csv",
    "https://www.aircraftspruce.com:8443/downloads/x.csv",
    "https://user:pass@www.aircraftspruce.com/downloads/x.csv",
    "https://www.aircraftspruce.com/api/x.csv",
  ]) {
    const fetcher = stubFetch(Response.json({ url }));
    await expect(downloadSpruce("orders", credentials)).rejects.toMatchObject(
      failure("validating the download address"),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("names the HTTP status of a failed file fetch", async () => {
  stubFetch(Response.json(EXPORT), new Response("", { status: 404 }));
  await expect(downloadSpruce("orders", credentials)).rejects.toMatchObject(
    failure("export file (HTTP 404)"),
  );
});

it("stops reading an export over 50 MB", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(50_000_001));
    },
    cancel,
  });
  stubFetch(Response.json(EXPORT), new Response(body));
  await expect(downloadSpruce("products", credentials)).rejects.toMatchObject(
    failure("export exceeded the 50 MB limit"),
  );
  expect(cancel).toHaveBeenCalled();
});

it("accepts an export of exactly 50 MB", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(50_000_000).fill(65));
      controller.close();
    },
  });
  stubFetch(Response.json(EXPORT), new Response(body));
  expect(await downloadSpruce("products", credentials)).toHaveLength(
    50_000_000,
  );
});

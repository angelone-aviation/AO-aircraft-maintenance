/**
 * Responsibility: Pins the Cloudflare Worker that answers what no static
 *   asset matches: an uncached 404 for a missing bundle, the app shell for
 *   any other page, nothing for other methods.
 * Layer: Test. Calls the Worker's fetch with a fake ASSETS binding.
 * Dependencies: vitest, worker/assets.ts.
 */
import { describe, expect, it, vi } from "vitest";
import worker from "../worker/assets";

const SITE = "https://ops.example.test";
const SHELL = '<div id="root"></div>';

function fakeAssets() {
  return {
    fetch: vi.fn(async (_request: Request) => new Response(SHELL)),
  };
}

describe("worker/assets.ts", () => {
  it.each(["/assets/index-0ld.js", "/assets/app.js.map", "/assets/"])(
    "answers a missing bundle %s with a 404 that is never cached",
    async (pathname) => {
      const assets = fakeAssets();
      const response = await worker.fetch(new Request(SITE + pathname), {
        ASSETS: assets,
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(assets.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD"])(
    "answers %s for any other page with the app shell",
    async (method) => {
      const assets = fakeAssets();
      const response = await worker.fetch(
        new Request(`${SITE}/work-orders/12?tab=parts`, { method }),
        { ASSETS: assets },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL);
      const [shell] = assets.fetch.mock.calls[0];
      expect([shell.url, shell.method]).toEqual([`${SITE}/`, method]);
    },
  );

  it("refuses other methods", async () => {
    const assets = fakeAssets();
    const response = await worker.fetch(
      new Request(`${SITE}/work-orders`, { method: "POST", body: "x" }),
      { ASSETS: assets },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

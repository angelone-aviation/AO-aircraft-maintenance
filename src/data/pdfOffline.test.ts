/**
 * Responsibility: Pins when the PDF viewer warm-up fetches, shares and
 *   retries its files.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/pdfOffline.ts (pdfRuntime.ts mocked).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { warmPdfViewer } from "./pdfOffline";

vi.mock("./pdfRuntime", () => ({ getDocument: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
  vi.stubGlobal("__PDF_VIEWER_FILES__", ["a.mjs", "b.wasm"]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x")),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("fetches every viewer file once per warm-up, sharing one in flight", async () => {
  const first = warmPdfViewer();
  expect(warmPdfViewer()).toBe(first);
  await first;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith("/a.mjs");
  await warmPdfViewer();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("ignores failed fetches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(new TypeError("offline"))),
  );
  await expect(warmPdfViewer()).resolves.toBeUndefined();
});

it("does nothing when no service worker controls the page", async () => {
  vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
  await warmPdfViewer();
  expect(fetch).not.toHaveBeenCalled();
});

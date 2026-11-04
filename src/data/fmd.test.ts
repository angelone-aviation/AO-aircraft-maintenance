/**
 * Responsibility: Pins the .fmd codec's size limits, refusal messages and
 *   file shape.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/fmd.ts, src/domain/checklists.ts.
 *
 * Round trips of real files are in src/domain/checklists.test.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { exportFmd, importFmd } from "./fmd";
import { emptyChecklist } from "../domain/checklists";

const SIZE_ERROR =
  "Invalid FMD file size. Choose a ForeFlight .fmd checklist under 2 MB.";
const HTTPS_ERROR = "FMD import/export requires HTTPS or localhost.";
const MAX_BYTES = 2 * 1024 * 1024;

afterEach(() => vi.unstubAllGlobals());

async function encryptJson(value: unknown): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("81e06e41a93f3848"),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(16);
  const data = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return new Blob([iv, data]).arrayBuffer();
}

it("accepts 32 bytes to 2 MiB in whole AES blocks", async () => {
  for (const size of [16, 33, MAX_BYTES + 16])
    await expect(importFmd(new ArrayBuffer(size))).rejects.toThrow(SIZE_ERROR);
  await expect(importFmd(new ArrayBuffer(MAX_BYTES))).rejects.toThrow(
    "Unable to read this FMD file. It may be damaged or use an unsupported format.",
  );
});

it("names the first problem in content that is not a checklist", async () => {
  await expect(importFmd(await encryptJson({ type: "x" }))).rejects.toThrow(
    /^Unsupported checklist content: .+\. No checklist was imported\.$/,
  );
});

it("writes a fresh IV before the encrypted checklist", async () => {
  const first = await exportFmd(emptyChecklist());
  const second = await exportFmd(emptyChecklist());
  expect(first.type).toBe("application/octet-stream");
  expect(first.size % 16).toBe(0);
  const iv = async (blob: Blob) =>
    new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  expect(await iv(first)).not.toEqual(await iv(second));
});

it("asks for HTTPS when Web Crypto is unavailable", async () => {
  const checklist = emptyChecklist();
  vi.stubGlobal("crypto", {
    getRandomValues: (a: Uint8Array) => a,
  });
  await expect(importFmd(new ArrayBuffer(32))).rejects.toThrow(HTTPS_ERROR);
  await expect(exportFmd(checklist)).rejects.toThrow(HTTPS_ERROR);
});

/**
 * Responsibility: Downloads an Aircraft Spruce products or orders export.
 * Layer: Server. Network helper for actions only; no Convex functions.
 * Dependencies: convex/values (ConvexError), src/domain/aircraftSpruce.
 *
 * Provider errors may echo the credentials, so every failure is reported as
 * the step that failed, never as the provider's or the runtime's own text.
 */
import { ConvexError } from "convex/values";
import { spruceCredentials } from "../src/domain/aircraftSpruce";
import type { z } from "zod";

const SPRUCE_HOST = "www.aircraftspruce.com";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_EXPORT_BYTES = 50_000_000;

// A rejection starts with a three-digit code, e.g. "401 Invalid key". Only the
// code is reported; the rest may echo the credentials.
const PROVIDER_ERROR_CODE = /^\d{3}(?=\s|$)/;

type ExportResponse = { status?: unknown; url?: unknown; error?: unknown };

/** The step a download reached, named in the error if it fails there. */
type Progress = { stage: string };

/**
 * Asks Aircraft Spruce for an export, then fetches the file it points to.
 *
 * @param kind - Which export: the catalog or the account's orders.
 * @param credentials - The program's decrypted Aircraft Spruce account.
 * @param extra - More fields for the export request body.
 * @returns The export file's text.
 * @throws {ConvexError} "Aircraft Spruce download failed: <step>. Check the
 *   account details, API access and connection, then retry." on any failure,
 *   including a download address off www.aircraftspruce.com/downloads/ or a
 *   file over 50 MB.
 */
export async function downloadSpruce(
  kind: "products" | "orders",
  credentials: z.infer<typeof spruceCredentials>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const progress: Progress = { stage: "requesting the export" };
  try {
    const url = await requestExportUrl(progress, kind, credentials, extra);
    return await fetchExportFile(progress, url);
  } catch {
    throw new ConvexError(
      `Aircraft Spruce download failed: ${progress.stage}. Check the account details, API access and connection, then retry.`,
    );
  }
}

async function requestExportUrl(
  progress: Progress,
  kind: "products" | "orders",
  credentials: z.infer<typeof spruceCredentials>,
  extra: Record<string, unknown>,
): Promise<URL> {
  const response = await fetch(`https://${SPRUCE_HOST}/api/download/${kind}`, {
    method: "POST",
    // A followed 307 would post the credentials on to another address.
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userid: credentials.userid,
      password: credentials.password,
      apikey: credentials.apikey,
      ...extra,
    }),
  });
  progress.stage = `export request (HTTP ${response.status})`;
  if (!response.ok) throw new Error();
  const data = (await response.json()) as ExportResponse;
  progress.stage = "export response rejected";
  const code = readProviderErrorCode(data);
  if (code) progress.stage += ` (provider code ${code})`;
  if (!isExportReady(data)) throw new Error();
  progress.stage = "validating the download address";
  const url = new URL(data.url);
  if (!isSpruceDownload(url)) throw new Error();
  return url;
}

async function fetchExportFile(progress: Progress, url: URL): Promise<string> {
  progress.stage = "fetching the export file";
  const file = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  progress.stage = `export file (HTTP ${file.status})`;
  if (!file.ok || !file.body) throw new Error();
  progress.stage = "reading the export file";
  const reader = file.body.getReader();
  const text = await readUpTo(reader, MAX_EXPORT_BYTES);
  if (text !== undefined) return text;
  progress.stage = "export exceeded the 50 MB limit";
  await reader.cancel();
  throw new Error();
}

function readProviderErrorCode(data: ExportResponse): string | undefined {
  if (typeof data.error !== "string") return undefined;
  return data.error.match(PROVIDER_ERROR_CODE)?.[0];
}

// Aircraft Spruce omits status when it returns an existing cached export, so
// only an absent status or explicit success is valid; false or 0 still fails.
function isExportReady(
  data: ExportResponse,
): data is ExportResponse & { url: string } {
  const succeeded =
    data.status === undefined || data.status === true || data.status === 1;
  return succeeded && typeof data.url === "string";
}

function isSpruceDownload(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === SPRUCE_HOST &&
    !url.port &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith("/downloads/")
  );
}

async function readUpTo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    size += chunk.value.byteLength;
    if (size > maxBytes) return undefined;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

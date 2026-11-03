import { ConvexError } from "convex/values";
import { spruceCredentials } from "../src/domain/aircraftSpruce";
import type { z } from "zod";

// This module is used only by server actions. Provider errors may echo secrets.
export async function downloadSpruce(
  kind: "products" | "orders",
  credentials: z.infer<typeof spruceCredentials>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  let stage = "requesting the export";
  try {
    const response = await fetch(
      `https://www.aircraftspruce.com/api/download/${kind}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(90000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userid: credentials.userid,
          password: credentials.password,
          apikey: credentials.apikey,
          ...extra,
        }),
      },
    );
    stage = `export request (HTTP ${response.status})`;
    if (!response.ok) throw Error();
    const data = await response.json();
    stage = "export response rejected";
    if (typeof data.error === "string") {
      const code = data.error.match(/^\d{3}(?=\s|$)/)?.[0];
      if (code) stage += ` (provider code ${code})`;
    }
    // Aircraft Spruce omits status when returning an existing cached export.
    // Only an absent status or explicit success is valid; false/0 still fails.
    if (
      (data.status !== undefined &&
        data.status !== true &&
        data.status !== 1) ||
      typeof data.url !== "string"
    )
      throw Error();
    stage = "validating the download address";
    const url = new URL(data.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.aircraftspruce.com" ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith("/downloads/")
    )
      throw Error();
    stage = "fetching the export file";
    const file = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    });
    stage = `export file (HTTP ${file.status})`;
    if (!file.ok || !file.body) throw Error();
    stage = "reading the export file";
    const reader = file.body.getReader(),
      decoder = new TextDecoder();
    let size = 0,
      text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 50_000_000) {
        stage = "export exceeded the 50 MB limit";
        await reader.cancel();
        throw Error();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    throw new ConvexError(
      `Aircraft Spruce download failed: ${stage}. Check the account details, API access and connection, then retry.`,
    );
  }
}

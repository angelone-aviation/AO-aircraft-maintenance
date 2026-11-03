import { fmdSchema, type ChecklistDocument } from "../domain/checklists";
// Public FMD format constants documented by EFIS Editor:
// https://github.com/rdamazio/efis-editor/blob/main/src/model/formats/foreflight-utils.ts
const keyBytes = new TextEncoder().encode("81e06e41a93f3848");
async function key(usage: KeyUsage) {
  if (!globalThis.crypto?.subtle)
    throw new Error("FMD import/export requires HTTPS or localhost.");
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    usage,
  ]);
}
export async function importFmd(
  bytes: ArrayBuffer,
): Promise<ChecklistDocument> {
  if (
    bytes.byteLength < 32 ||
    bytes.byteLength > 2 * 1024 * 1024 ||
    bytes.byteLength % 16 !== 0
  )
    throw new Error(
      "Invalid FMD file size. Choose a ForeFlight .fmd checklist under 2 MB.",
    );
  const cipherKey = await key("decrypt");
  let decoded: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: bytes.slice(0, 16) },
      cipherKey,
      bytes.slice(16),
    );
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plain),
    );
  } catch {
    throw new Error(
      "Unable to read this FMD file. It may be damaged or use an unsupported format.",
    );
  }
  const result = fmdSchema.safeParse(decoded);
  if (!result.success)
    throw new Error(
      `Unsupported checklist content: ${result.error.issues[0]?.message ?? "Invalid checklist structure"}. No checklist was imported.`,
    );
  return result.data;
}
export async function exportFmd(document: ChecklistDocument) {
  const validated = fmdSchema.parse(document);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const data = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    await key("encrypt"),
    new TextEncoder().encode(JSON.stringify(validated)),
  );
  return new Blob([iv, data], { type: "application/octet-stream" });
}

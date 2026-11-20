/**
 * Responsibility: Reads and writes ForeFlight .fmd checklist files.
 * Layer: Data. Browser file codec over Web Crypto; no React.
 * Dependencies: src/domain/checklists.ts.
 *
 * An .fmd file is a 16-byte AES-CBC IV followed by the encrypted checklist
 * JSON. The key is ForeFlight's public format constant, documented in
 * src/model/formats/foreflight-utils.ts of
 * https://github.com/rdamazio/efis-editor.
 */
import { fmdSchema, type ChecklistDocument } from "../domain/checklists";

const FMD_KEY = new TextEncoder().encode("81e06e41a93f3848");
const AES_BLOCK_BYTES = 16;
const IV_BYTES = AES_BLOCK_BYTES;
const MIN_FMD_BYTES = IV_BYTES + AES_BLOCK_BYTES;
const MAX_FMD_BYTES = 2 * 1024 * 1024;

/**
 * Decrypts an .fmd file and validates the checklist inside.
 *
 * @param bytes - The file's contents.
 * @returns The checklist document, as {@link fmdSchema} parses it.
 * @throws {Error} "Invalid FMD file size. Choose a ForeFlight .fmd checklist
 *   under 2 MiB." for a size outside 32 bytes–2 MiB or not a whole number of
 *   AES blocks; "Unable to read this FMD file. It may be damaged or use an
 *   unsupported format." when it does not decrypt to UTF-8 JSON;
 *   "Unsupported checklist content: <first issue>. No checklist was
 *   imported." when the JSON is not a valid checklist; "FMD import/export
 *   requires HTTPS or localhost." without Web Crypto (an insecure context).
 */
export async function importFmd(
  bytes: ArrayBuffer,
): Promise<ChecklistDocument> {
  if (
    bytes.byteLength < MIN_FMD_BYTES ||
    bytes.byteLength > MAX_FMD_BYTES ||
    bytes.byteLength % AES_BLOCK_BYTES !== 0
  )
    throw new Error(
      "Invalid FMD file size. Choose a ForeFlight .fmd checklist under 2 MiB.",
    );
  const decoded = await decryptJson(bytes, await importKey("decrypt"));
  const result = fmdSchema.safeParse(decoded);
  if (!result.success)
    throw new Error(
      `Unsupported checklist content: ${result.error.issues[0]?.message ?? "Invalid checklist structure"}. No checklist was imported.`,
    );
  return result.data;
}

/**
 * Encrypts a checklist as an .fmd file, under a fresh random IV.
 *
 * @param document - The checklist; validated before it is written.
 * @returns The file, typed application/octet-stream.
 * @throws {z.ZodError} When the checklist fails {@link fmdSchema}.
 * @throws {Error} "FMD import/export requires HTTPS or localhost." without
 *   Web Crypto (an insecure context).
 */
export async function exportFmd(document: ChecklistDocument) {
  const validated = fmdSchema.parse(document);
  const key = await importKey("encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    new TextEncoder().encode(JSON.stringify(validated)),
  );
  return new Blob([iv, data], { type: "application/octet-stream" });
}

async function importKey(usage: KeyUsage): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle)
    throw new Error("FMD import/export requires HTTPS or localhost.");
  return crypto.subtle.importKey("raw", FMD_KEY, { name: "AES-CBC" }, false, [
    usage,
  ]);
}

async function decryptJson(
  bytes: ArrayBuffer,
  key: CryptoKey,
): Promise<unknown> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: bytes.slice(0, IV_BYTES) },
      key,
      bytes.slice(IV_BYTES),
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    // Wrong padding, invalid UTF-8 and bad JSON all mean an unreadable file.
    throw new Error(
      "Unable to read this FMD file. It may be damaged or use an unsupported format.",
    );
  }
}

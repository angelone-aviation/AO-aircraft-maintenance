/**
 * Responsibility: Streams documents out of a Convex snapshot export ZIP, one
 *   table at a time, without loading the archive into memory.
 * Layer: Script. Local file reads for the backup scripts; no network.
 * Dependencies: node:fs/promises, fflate.
 *
 * Reads `npx convex export --include-file-storage` output: a
 * `<table>/documents.jsonl` (one JSON document per line) per table, and
 * `_storage/` with the files' metadata and the files, which are only counted.
 */
import { open, type FileHandle } from "node:fs/promises";
import { Inflate } from "fflate";

/** One file in the ZIP, as its central directory describes it. */
interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Where the tables and stored files of an export sit in its ZIP. */
export interface ExportContents {
  /** Table name → its documents.jsonl entry. */
  tables: Map<string, ZipEntry>;
  /** Stored files (manuals, photos, attachments) in `_storage`. */
  storageFiles: number;
  /** `_storage/documents.jsonl`, the stored files' metadata, if present. */
  storageIndex?: ZipEntry;
}

const DOCUMENTS_FILE = "documents.jsonl";
const READ_CHUNK_BYTES = 1 << 20;
const STORED = 0;
const DEFLATED = 8;

// Signatures and fixed sizes from PKWARE's APPNOTE.TXT, the ZIP specification.
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_BYTES = 46;
const END_SIGNATURE = 0x06054b50;
const END_BYTES = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_END_BYTES = 56;
const ZIP64_EXTRA_FIELD_ID = 1;
const MAX_COMMENT_BYTES = 0xffff;

// A 16- or 32-bit field at its maximum means the value is in a ZIP64 record.
const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;

// The ZIP64 extra field holds 8-byte values for only the saturated fields,
// in this order.
const ZIP64_FIELD_ORDER = [
  "uncompressedSize",
  "compressedSize",
  "localHeaderOffset",
] as const;

type DirectoryLocation = Record<"count" | "length" | "offset", number>;
type EntrySizes = Record<(typeof ZIP64_FIELD_ORDER)[number], number>;

/**
 * Finds the tables and stored files in a Convex export without decompressing
 * anything.
 *
 * @param zipPath - Path of the export ZIP.
 * @returns Each table's entry, keyed by the folder holding its
 *   documents.jsonl. Folders starting with "_" and everything under
 *   `_components/` are left out.
 * @throws {Error} "The export is not a ZIP file.", "The export ZIP ends
 *   unexpectedly.", "The export ZIP directory is damaged.", "The export ZIP64
 *   directory is missing." or "… is damaged.", or "The ZIP holds no tables.
 *   Expected a Convex export with <table>/documents.jsonl folders."
 */
export async function exportContents(zipPath: string): Promise<ExportContents> {
  const fh = await open(zipPath, "r");
  try {
    const contents: ExportContents = { tables: new Map(), storageFiles: 0 };
    for (const entry of await readCentralDirectory(fh))
      addEntry(contents, entry);
    if (!contents.tables.size)
      throw new Error(
        "The ZIP holds no tables. Expected a Convex export with <table>/documents.jsonl folders.",
      );
    return contents;
  } finally {
    await fh.close();
  }
}

/**
 * Streams the documents of one documents.jsonl entry, in file order, reading
 * the ZIP 1 MiB at a time.
 *
 * @param zipPath - Path of the export ZIP.
 * @param entry - An entry from {@link exportContents}.
 * @param onDocument - Called with each non-blank line, parsed as JSON.
 * @throws {Error} "The export entry <name> is damaged.", "The export entry
 *   <name> uses an unsupported compression method." (only stored and deflated
 *   are read), or "The export ZIP ends unexpectedly."
 * @throws {SyntaxError} At a line that is not JSON; earlier lines have
 *   already been delivered.
 */
export async function readDocuments(
  zipPath: string,
  entry: ZipEntry,
  onDocument: (doc: Record<string, unknown>) => void,
): Promise<void> {
  const fh = await open(zipPath, "r");
  try {
    await streamDocuments(fh, entry, onDocument);
  } finally {
    await fh.close();
  }
}

// A read can return fewer bytes than asked, so it loops until it has them all.
async function readAt(
  fh: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(
      buffer,
      done,
      length - done,
      position + done,
    );
    if (!bytesRead) throw new Error("The export ZIP ends unexpectedly.");
    done += bytesRead;
  }
  return buffer;
}

function addEntry(contents: ExportContents, entry: ZipEntry): void {
  const parts = entry.name.split("/").filter(Boolean);
  if (parts.length < 2 || parts.includes("_components")) return;
  const [folder, file] = parts.slice(-2);
  if (folder === "_storage" && file === DOCUMENTS_FILE)
    contents.storageIndex = entry;
  else if (folder === "_storage") contents.storageFiles++;
  else if (file === DOCUMENTS_FILE && !folder.startsWith("_"))
    contents.tables.set(folder, entry);
}

async function readCentralDirectory(fh: FileHandle): Promise<ZipEntry[]> {
  const { count, length, offset } = await locateCentralDirectory(fh);
  const directory = await readAt(fh, offset, length);
  const entries: ZipEntry[] = [];
  let position = 0;
  for (let n = 0; n < count; n++) {
    const { entry, headerLength } = parseCentralHeader(directory, position);
    entries.push(entry);
    position += headerLength;
  }
  return entries;
}

async function locateCentralDirectory(
  fh: FileHandle,
): Promise<DirectoryLocation> {
  const { size } = await fh.stat();
  const tailLength = Math.min(
    size,
    MAX_COMMENT_BYTES + END_BYTES + ZIP64_LOCATOR_BYTES,
  );
  const tail = await readAt(fh, size - tailLength, tailLength);
  const end = findEndRecord(tail);
  const location = {
    count: tail.readUInt16LE(end + 10),
    length: tail.readUInt32LE(end + 12),
    offset: tail.readUInt32LE(end + 16),
  };
  const isZip64 =
    location.count === SATURATED_16 ||
    location.length === SATURATED_32 ||
    location.offset === SATURATED_32;
  return isZip64 ? readZip64Location(fh, tail, end) : location;
}

// Scans backwards: a comment of up to 64 KiB may follow the record, and file
// data before it may hold the same signature.
function findEndRecord(tail: Buffer): number {
  for (let i = tail.length - END_BYTES; i >= 0; i--)
    if (tail.readUInt32LE(i) === END_SIGNATURE) return i;
  throw new Error("The export is not a ZIP file.");
}

async function readZip64Location(
  fh: FileHandle,
  tail: Buffer,
  end: number,
): Promise<DirectoryLocation> {
  const locator = end - ZIP64_LOCATOR_BYTES;
  if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE)
    throw new Error("The export ZIP64 directory is missing.");
  const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
  const record = await readAt(fh, recordOffset, ZIP64_END_BYTES);
  if (record.readUInt32LE(0) !== ZIP64_END_SIGNATURE)
    throw new Error("The export ZIP64 directory is damaged.");
  return {
    count: Number(record.readBigUInt64LE(32)),
    length: Number(record.readBigUInt64LE(40)),
    offset: Number(record.readBigUInt64LE(48)),
  };
}

function parseCentralHeader(
  directory: Buffer,
  start: number,
): { entry: ZipEntry; headerLength: number } {
  if (directory.readUInt32LE(start) !== CENTRAL_HEADER_SIGNATURE)
    throw new Error("The export ZIP directory is damaged.");
  const nameLength = directory.readUInt16LE(start + 28);
  const extraLength = directory.readUInt16LE(start + 30);
  const commentLength = directory.readUInt16LE(start + 32);
  const nameEnd = start + CENTRAL_HEADER_BYTES + nameLength;
  const sizes = applyZip64Extra(directory, nameEnd, nameEnd + extraLength, {
    uncompressedSize: directory.readUInt32LE(start + 24),
    compressedSize: directory.readUInt32LE(start + 20),
    localHeaderOffset: directory.readUInt32LE(start + 42),
  });
  return {
    entry: {
      name: directory.toString("utf8", start + CENTRAL_HEADER_BYTES, nameEnd),
      method: directory.readUInt16LE(start + 10),
      compressedSize: sizes.compressedSize,
      localHeaderOffset: sizes.localHeaderOffset,
    },
    headerLength:
      CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength,
  };
}

function applyZip64Extra(
  directory: Buffer,
  start: number,
  end: number,
  header: EntrySizes,
): EntrySizes {
  let sizes = header;
  for (let x = start; x + 4 <= end; x += 4 + directory.readUInt16LE(x + 2))
    if (directory.readUInt16LE(x) === ZIP64_EXTRA_FIELD_ID)
      sizes = readZip64Values(directory, x + 4, sizes);
  return sizes;
}

function readZip64Values(
  directory: Buffer,
  start: number,
  header: EntrySizes,
): EntrySizes {
  const sizes = { ...header };
  let position = start;
  for (const field of ZIP64_FIELD_ORDER) {
    if (sizes[field] !== SATURATED_32) continue;
    sizes[field] = Number(directory.readBigUInt64LE(position));
    position += 8;
  }
  return sizes;
}

async function streamDocuments(
  fh: FileHandle,
  entry: ZipEntry,
  onDocument: (doc: Record<string, unknown>) => void,
): Promise<void> {
  const start = await findEntryData(fh, entry);
  if (entry.method !== STORED && entry.method !== DEFLATED)
    throw new Error(
      `The export entry ${entry.name} uses an unsupported compression method.`,
    );
  const decode = createJsonlDecoder(onDocument);
  const inflater = entry.method === DEFLATED ? new Inflate(decode) : undefined;
  const size = entry.compressedSize;
  for (let read = 0; read < size; read += READ_CHUNK_BYTES) {
    const length = Math.min(READ_CHUNK_BYTES, size - read);
    const chunk = await readAt(fh, start + read, length);
    const last = read + length >= size;
    if (inflater) inflater.push(chunk, last);
    else decode(chunk, last);
  }
}

// The local header's extra field can differ in length from the central
// directory's, so the data offset comes from the local header itself.
async function findEntryData(fh: FileHandle, entry: ZipEntry): Promise<number> {
  const local = await readAt(fh, entry.localHeaderOffset, LOCAL_HEADER_BYTES);
  if (local.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE)
    throw new Error(`The export entry ${entry.name} is damaged.`);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  return (
    entry.localHeaderOffset + LOCAL_HEADER_BYTES + nameLength + extraLength
  );
}

// Chunks can split a line or a UTF-8 character, so text is decoded in stream
// mode and a partial last line waits for the next chunk.
function createJsonlDecoder(
  onDocument: (doc: Record<string, unknown>) => void,
): (data: Uint8Array, final: boolean) => void {
  const decoder = new TextDecoder();
  let pending = "";
  return (data, final) => {
    pending += decoder.decode(data, { stream: !final });
    const lines = pending.split("\n");
    pending = final ? "" : (lines.pop() ?? "");
    for (const line of lines)
      if (line.trim()) onDocument(JSON.parse(line) as Record<string, unknown>);
  };
}

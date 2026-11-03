// Reads a Convex snapshot export ZIP (`npx convex export --include-file-storage`)
// without loading it into memory: one folder per table holding
// `<table>/documents.jsonl` (one JSON document per line), plus a `_storage`
// folder with `documents.jsonl` (file metadata) and the stored files
// themselves, named by storage ID. Component tables live under
// `_components/` and are ignored. Only the tables asked for are decompressed;
// stored files never are.
import { open, type FileHandle } from "node:fs/promises";
import { Inflate } from "fflate";

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}
export interface ExportContents {
  /** Table name → path of its documents.jsonl inside the ZIP. */
  tables: Map<string, ZipEntry>;
  /** Stored files (manuals, photos, attachments) in `_storage`. */
  storageFiles: number;
  storageIndex?: ZipEntry;
}

const CHUNK = 1 << 20;
async function readAt(fh: FileHandle, position: number, length: number) {
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

async function centralDirectory(fh: FileHandle) {
  const { size } = await fh.stat();
  const tailLength = Math.min(size, 0xffff + 22 + 20);
  const tail = await readAt(fh, size - tailLength, tailLength);
  let end = -1;
  for (let i = tailLength - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("The export is not a ZIP file.");
  let count = tail.readUInt16LE(end + 10);
  let length = tail.readUInt32LE(end + 12);
  let offset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50)
      throw new Error("The export ZIP64 directory is missing.");
    const record = await readAt(
      fh,
      Number(tail.readBigUInt64LE(locator + 8)),
      56,
    );
    if (record.readUInt32LE(0) !== 0x06064b50)
      throw new Error("The export ZIP64 directory is damaged.");
    count = Number(record.readBigUInt64LE(32));
    length = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  const directory = await readAt(fh, offset, length);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (directory.readUInt32LE(p) !== 0x02014b50)
      throw new Error("The export ZIP directory is damaged.");
    const method = directory.readUInt16LE(p + 10);
    let compressedSize = directory.readUInt32LE(p + 20);
    let uncompressedSize = directory.readUInt32LE(p + 24);
    const nameLength = directory.readUInt16LE(p + 28);
    const extraLength = directory.readUInt16LE(p + 30);
    const commentLength = directory.readUInt16LE(p + 32);
    let localHeaderOffset = directory.readUInt32LE(p + 42);
    const name = directory.toString("utf8", p + 46, p + 46 + nameLength);
    // ZIP64 extended information: only the fields saturated above, in order.
    for (
      let x = p + 46 + nameLength;
      x + 4 <= p + 46 + nameLength + extraLength;
    ) {
      const id = directory.readUInt16LE(x);
      const size = directory.readUInt16LE(x + 2);
      if (id === 1) {
        let y = x + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = Number(directory.readBigUInt64LE(y));
          y += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(directory.readBigUInt64LE(y));
          y += 8;
        }
        if (localHeaderOffset === 0xffffffff)
          localHeaderOffset = Number(directory.readBigUInt64LE(y));
      }
      x += 4 + size;
    }
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function exportContents(zipPath: string): Promise<ExportContents> {
  const fh = await open(zipPath, "r");
  try {
    const contents: ExportContents = { tables: new Map(), storageFiles: 0 };
    for (const entry of await centralDirectory(fh)) {
      const parts = entry.name.split("/").filter(Boolean);
      if (parts.length < 2 || parts.includes("_components")) continue;
      const [folder, file] = parts.slice(-2);
      if (folder === "_storage") {
        if (file === "documents.jsonl") contents.storageIndex = entry;
        else contents.storageFiles++;
      } else if (file === "documents.jsonl" && !folder.startsWith("_"))
        contents.tables.set(folder, entry);
    }
    if (!contents.tables.size)
      throw new Error(
        "The ZIP holds no tables. Expected a Convex export with <table>/documents.jsonl folders.",
      );
    return contents;
  } finally {
    await fh.close();
  }
}

/** Calls `onDocument` for every line of one documents.jsonl, streaming. */
export async function readDocuments(
  zipPath: string,
  entry: ZipEntry,
  onDocument: (doc: Record<string, unknown>) => void,
) {
  const fh = await open(zipPath, "r");
  try {
    const local = await readAt(fh, entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50)
      throw new Error(`The export entry ${entry.name} is damaged.`);
    const start =
      entry.localHeaderOffset +
      30 +
      local.readUInt16LE(26) +
      local.readUInt16LE(28);
    const decoder = new TextDecoder();
    let pending = "";
    const take = (text: string, last: boolean) => {
      pending += text;
      const lines = pending.split("\n");
      pending = last ? "" : lines.pop()!;
      for (const line of lines)
        if (line.trim())
          onDocument(JSON.parse(line) as Record<string, unknown>);
    };
    if (entry.method !== 0 && entry.method !== 8)
      throw new Error(
        `The export entry ${entry.name} uses an unsupported compression method.`,
      );
    let inflater: Inflate | undefined;
    if (entry.method === 8)
      inflater = new Inflate((data, final) =>
        take(decoder.decode(data, { stream: !final }), final),
      );
    for (let read = 0; read < entry.compressedSize; read += CHUNK) {
      const length = Math.min(CHUNK, entry.compressedSize - read);
      const chunk = await readAt(fh, start + read, length);
      const last = read + length >= entry.compressedSize;
      if (inflater) inflater.push(chunk, last);
      else take(decoder.decode(chunk, { stream: !last }), last);
    }
    if (!entry.compressedSize) take("", true);
  } finally {
    await fh.close();
  }
}

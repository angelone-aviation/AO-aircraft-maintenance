/**
 * Responsibility: Pins how the export reader finds tables and streams their
 *   documents, including ZIP64 archives, and every error it reports.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: scripts/backup/convexExport.ts, fflate.
 */
// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync, strToU8, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportContents, readDocuments } from "./convexExport";

const STORED = 0;
const DEFLATED = 8;
const SATURATED_16 = 0xffff;
const SATURATED_32 = 0xffffffff;

let dir: string;
let files = 0;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "convex-export-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function save(bytes: Uint8Array): Promise<string> {
  const file = path.join(dir, `export-${files++}.zip`);
  await writeFile(file, bytes);
  return file;
}

async function documentsOf(zipPath: string, table: string) {
  const entry = (await exportContents(zipPath)).tables.get(table);
  if (!entry) throw new Error(`No ${table} table`);
  const docs: Record<string, unknown>[] = [];
  await readDocuments(zipPath, entry, (doc) => docs.push(doc));
  return docs;
}

const jsonl = (...docs: object[]) =>
  docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n";

type Zip64Mode = "none" | "all" | "offset";
interface Entry {
  name: string;
  text: string;
  method?: number;
}
interface PackedFile {
  fileName: Buffer;
  method: number;
  rawLength: number;
  data: Buffer;
}

// Writes a ZIP by hand so tests can reach what fflate never writes: ZIP64
// records, foreign extra fields, entry comments and other methods. "all"
// saturates every size and offset; "offset" only the offsets.
function buildZip(entries: Entry[], zip64: Zip64Mode = "none", comment = "") {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const file = pack(entry);
    const local = localHeader(file, zip64);
    parts.push(local, file.data);
    directory.push(centralHeader(file, zip64, offset));
    offset += local.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const trailer = endRecords(entries.length, centralDirectory, offset, zip64);
  const zipComment = Buffer.from(comment);
  trailer.at(-1)!.writeUInt16LE(zipComment.length, 20);
  return Buffer.concat([...parts, centralDirectory, ...trailer, zipComment]);
}

function pack({ name, text, method = DEFLATED }: Entry): PackedFile {
  const raw = Buffer.from(text);
  const data = method === DEFLATED ? Buffer.from(deflateSync(raw)) : raw;
  return { fileName: Buffer.from(name), method, rawLength: raw.length, data };
}

function localHeader(file: PackedFile, zip64: Zip64Mode): Buffer {
  const all = zip64 === "all";
  const sizes = [file.rawLength, file.data.length];
  const extra = all ? extraField(1, sizes) : none();
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(file.method, 8);
  header.writeUInt32LE(all ? SATURATED_32 : file.data.length, 18);
  header.writeUInt32LE(all ? SATURATED_32 : file.rawLength, 22);
  header.writeUInt16LE(file.fileName.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, file.fileName, extra]);
}

function centralHeader(file: PackedFile, zip64: Zip64Mode, offset: number) {
  const all = zip64 === "all";
  const values = all ? [file.rawLength, file.data.length, offset] : [offset];
  const extra =
    zip64 === "none"
      ? none()
      : Buffer.concat([extraField(0x5455, [7]), extraField(1, values)]);
  const note = Buffer.from("entry comment");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(file.method, 10);
  header.writeUInt32LE(all ? SATURATED_32 : file.data.length, 20);
  header.writeUInt32LE(all ? SATURATED_32 : file.rawLength, 24);
  header.writeUInt16LE(file.fileName.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(note.length, 32);
  header.writeUInt32LE(zip64 === "none" ? offset : SATURATED_32, 42);
  return Buffer.concat([header, file.fileName, extra, note]);
}

function endRecords(
  count: number,
  directory: Buffer,
  offset: number,
  zip64: Zip64Mode,
): Buffer[] {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 === "all" ? SATURATED_16 : count, 8);
  end.writeUInt16LE(zip64 === "all" ? SATURATED_16 : count, 10);
  end.writeUInt32LE(zip64 === "all" ? SATURATED_32 : directory.length, 12);
  end.writeUInt32LE(zip64 === "none" ? offset : SATURATED_32, 16);
  if (zip64 === "none") return [end];
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return [record, locator, end];
}

function extraField(id: number, values: number[]): Buffer {
  const field = Buffer.alloc(4 + 8 * values.length);
  field.writeUInt16LE(id, 0);
  field.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, i) =>
    field.writeBigUInt64LE(BigInt(value), 4 + 8 * i),
  );
  return field;
}

const none = () => Buffer.alloc(0);

// Repetitive, so its deflated size is far below its raw size: reading one as
// the other runs past the end of the ZIP.
const fleet = Array.from({ length: 300 }, (_, i) => ({ tail: `N${i % 2}AO` }));
const aircraft = jsonl(...fleet);
const programs = jsonl({ name: "Coastal" });
const sample: Entry[] = [
  { name: "aircraft/documents.jsonl", text: aircraft },
  { name: "programs/documents.jsonl", text: programs, method: STORED },
  { name: "_storage/documents.jsonl", text: jsonl({ _id: "kg1" }) },
  { name: "_storage/kg1", text: "%PDF-1.4" },
];

describe("exportContents", () => {
  it("lists tables by folder and counts stored files, skipping the rest", async () => {
    const zip = zipSync({
      "README.md": strToU8("export"),
      "aircraft/": new Uint8Array(),
      "aircraft/documents.jsonl": strToU8(aircraft),
      "aircraft/generated_schema.jsonl": strToU8('"aircraft"\n'),
      "snapshot/programs/documents.jsonl": strToU8(programs),
      "_tables/documents.jsonl": strToU8(jsonl({ name: "aircraft" })),
      "_components/workpool/runs/documents.jsonl": strToU8(jsonl({ id: 1 })),
      "_components/workpool/_storage/kg9": strToU8("component file"),
      "_storage/documents.jsonl": strToU8(jsonl({ _id: "kg1" })),
      "_storage/kg1": strToU8("%PDF-1.4"),
      "_storage/kg2": strToU8("%PDF-1.4"),
    } satisfies Zippable);
    const contents = await exportContents(await save(zip));
    expect([...contents.tables.keys()].sort()).toEqual([
      "aircraft",
      "programs",
    ]);
    expect(contents.storageFiles).toBe(2);
    expect(contents.storageIndex?.name).toBe("_storage/documents.jsonl");
  });

  it("reads a ZIP that ends in a comment", async () => {
    const zipPath = await save(
      buildZip(sample, "none", "x".repeat(SATURATED_16)),
    );
    expect((await exportContents(zipPath)).tables.size).toBe(2);
  });

  it("finds the last end record when a stored file holds its signature", async () => {
    const decoy = {
      name: "_storage/kg2",
      text: "PK\u0005\u0006",
      method: STORED,
    };
    const zipPath = await save(buildZip([...sample, decoy]));
    expect((await exportContents(zipPath)).storageFiles).toBe(2);
  });

  it.each(["all", "offset"] as const)(
    "reads ZIP64 records when %s fields are saturated",
    async (mode) => {
      const zipPath = await save(buildZip(sample, mode));
      const contents = await exportContents(zipPath);
      expect(contents.storageFiles).toBe(1);
      expect(await documentsOf(zipPath, "aircraft")).toEqual(fleet);
      expect(await documentsOf(zipPath, "programs")).toEqual([
        { name: "Coastal" },
      ]);
    },
  );

  it("refuses a file that is not a ZIP", async () => {
    await expect(
      exportContents(await save(strToU8("not a zip"))),
    ).rejects.toThrow("The export is not a ZIP file.");
  });

  it("refuses a ZIP without tables", async () => {
    const zip = buildZip([sample[2], { name: "README.md", text: "export" }]);
    await expect(exportContents(await save(zip))).rejects.toThrow(
      "The ZIP holds no tables. Expected a Convex export with <table>/documents.jsonl folders.",
    );
  });

  it("refuses a directory that runs past the end of the file", async () => {
    const zip = buildZip(sample);
    zip.writeUInt32LE(zip.length, zip.length - 6);
    await expect(exportContents(await save(zip))).rejects.toThrow(
      "The export ZIP ends unexpectedly.",
    );
  });

  it("refuses a directory offset that points elsewhere", async () => {
    const zip = buildZip(sample);
    zip.writeUInt32LE(0, zip.length - 6);
    await expect(exportContents(await save(zip))).rejects.toThrow(
      "The export ZIP directory is damaged.",
    );
  });

  it("refuses a saturated count without a ZIP64 locator", async () => {
    const zip = buildZip(sample);
    zip.writeUInt16LE(SATURATED_16, zip.length - 12);
    await expect(exportContents(await save(zip))).rejects.toThrow(
      "The export ZIP64 directory is missing.",
    );
  });

  it("refuses a ZIP64 locator that points elsewhere", async () => {
    const zip = buildZip(sample, "all");
    zip.writeBigUInt64LE(0n, zip.length - 22 - 12);
    await expect(exportContents(await save(zip))).rejects.toThrow(
      "The export ZIP64 directory is damaged.",
    );
  });
});

describe("readDocuments", () => {
  it("delivers each non-blank line in order, stored or deflated", async () => {
    const text = '{"n":1}\n\n  \n{"n":2}\n{"n":3}';
    const zipPath = await save(
      zipSync({
        "deflated/documents.jsonl": strToU8(text),
        "stored/documents.jsonl": [strToU8(text), { level: 0 }],
      }),
    );
    const expected = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(await documentsOf(zipPath, "deflated")).toEqual(expected);
    expect(await documentsOf(zipPath, "stored")).toEqual(expected);
  });

  it("joins lines and characters split across 1 MiB reads", async () => {
    // 3-byte characters, so the first read boundary falls inside one.
    const big = { text: "✈".repeat(400_000) };
    const text = jsonl(big, { n: 2 });
    const zipPath = await save(
      zipSync({
        "deflated/documents.jsonl": strToU8(text),
        "stored/documents.jsonl": [strToU8(text), { level: 0 }],
      }),
    );
    expect(await documentsOf(zipPath, "deflated")).toEqual([big, { n: 2 }]);
    expect(await documentsOf(zipPath, "stored")).toEqual([big, { n: 2 }]);
  });

  it("delivers nothing for an empty entry", async () => {
    const zipPath = await save(
      zipSync({ "empty/documents.jsonl": [new Uint8Array(), { level: 0 }] }),
    );
    expect(await documentsOf(zipPath, "empty")).toEqual([]);
  });

  it("refuses an entry whose local header is not where the directory says", async () => {
    const zipPath = await save(buildZip(sample));
    const entry = (await exportContents(zipPath)).tables.get("aircraft")!;
    const moved = { ...entry, localHeaderOffset: entry.localHeaderOffset + 1 };
    await expect(readDocuments(zipPath, moved, () => {})).rejects.toThrow(
      "The export entry aircraft/documents.jsonl is damaged.",
    );
  });

  it("refuses compression other than stored or deflated", async () => {
    const zipPath = await save(
      buildZip([
        { name: "aircraft/documents.jsonl", text: aircraft, method: 12 },
      ]),
    );
    const entry = (await exportContents(zipPath)).tables.get("aircraft")!;
    await expect(readDocuments(zipPath, entry, () => {})).rejects.toThrow(
      "The export entry aircraft/documents.jsonl uses an unsupported compression method.",
    );
  });

  it("throws a SyntaxError at a line that is not JSON, after the lines before it", async () => {
    const zipPath = await save(
      buildZip([
        {
          name: "aircraft/documents.jsonl",
          text: '{"n":1}\nnot json\n{"n":3}\n',
        },
      ]),
    );
    const entry = (await exportContents(zipPath)).tables.get("aircraft")!;
    const docs: unknown[] = [];
    await expect(
      readDocuments(zipPath, entry, (doc) => docs.push(doc)),
    ).rejects.toThrow(SyntaxError);
    expect(docs).toEqual([{ n: 1 }]);
  });
});

/**
 * Responsibility: Pins that the storage-reference list misses no place a file
 *   is named: every storage id the schema types, nested or not; every field
 *   named like one, whatever its type; any stored-payload key named like one;
 *   and that every path creating a file files its reference within a day.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: convex/storageReferences, convex/schema, convex/fileSweep,
 *   convex/manuals, convex/values, node:fs, node:path, node:url.
 *
 * The unreferenced-file sweep deletes any day-old file the list does not
 * name, so a reference this suite cannot see is a file the sweep would take.
 */
// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { v } from "convex/values";
import { expect, it } from "vitest";
import schema from "./schema";
import { STORAGE_REFERENCES } from "./storageReferences";
import { UNREFERENCED_FILE_AGE } from "./fileSweep";
import { UPLOAD_TTL } from "./manuals";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LISTED = STORAGE_REFERENCES.map((r) => `${r.table}.${r.field}`);

// The sweep's own cursor holds ids of files it has checked: positions, not
// references.
const NOT_REFERENCES = ["fileSweep.checkedIds[]"];

// Every place that creates a file, and how it files a reference to it within
// a day of storing it, before the sweep may look at it.
const FILE_CREATORS: Record<string, string> = {
  "convex/attachments.ts":
    "storeThenFinish files it in the same action, or deletes it",
  "convex/aircraftSpruceActions.ts":
    "refresh commits the catalog in the same action, or deletes it",
  "convex/sampleDocuments.ts":
    "upload attaches the samples in the same action, or deletes them",
  "convex/manuals.ts":
    "an upload URL's blob is claimed by its ticket within UPLOAD_TTL",
};

it("finds every storage id the schema types, nested ones included, in the reference list", () => {
  const found = tables()
    .flatMap(([table, validator]) => storagePaths(validator, table))
    .filter((path) => !NOT_REFERENCES.includes(path));
  expect(found.sort()).toEqual([...LISTED].sort());
});

it("finds every field named like a storage id, whatever its type and depth, in the reference list", () => {
  const named = tables().flatMap(([table, validator]) =>
    namedPaths(validator, table),
  );
  expect(named.filter((path) => !LISTED.includes(path))).toEqual([]);
});

it("flags a plain string field named like a storage id, and leaves other names alone", () => {
  const scratch = v.object({
    storageId: v.string(),
    pages: v.array(v.object({ photoFileId: v.string() })),
    notes: v.optional(v.object({ blob_id: v.string(), FILEIDS: v.string() })),
    profileId: v.string(),
    catalogId: v.string(),
  });
  expect(namedPaths(scratch as unknown as Validator, "scratch").sort()).toEqual(
    [
      "scratch.notes.FILEIDS",
      "scratch.notes.blob_id",
      "scratch.pages[].photoFileId",
      "scratch.storageId",
    ],
  );
});

it("keeps storage ids out of every stored-payload shape: src/domain names none", () => {
  const hits = sourceFiles("src/domain").flatMap((file) =>
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .flatMap((line, i) =>
        (line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
          .filter(namedLikeStorageId)
          .map((name) => `${file}:${i + 1} ${name}`),
      ),
  );
  expect(hits).toEqual([]);
});

it("creates files only where a reference is filed within a day of storing them", () => {
  const creators = sourceFiles("convex").filter((file) =>
    /\.storage\.store\(|\.generateUploadUrl\(/.test(
      readFileSync(join(ROOT, file), "utf8"),
    ),
  );
  expect(creators.sort()).toEqual(Object.keys(FILE_CREATORS).sort());
  expect(UPLOAD_TTL).toBeLessThan(UNREFERENCED_FILE_AGE);
});

// The parts of a Convex validator that can hold another validator.
type Validator = {
  kind: string;
  tableName?: string;
  fields?: Record<string, Validator>;
  element?: Validator;
  members?: Validator[];
  value?: Validator;
};

function tables(): [string, Validator][] {
  return Object.entries(schema.tables).map(([table, def]) => [
    table,
    (def as unknown as { validator: Validator }).validator,
  ]);
}

// "table.field" for a top-level id; a nested one gets a longer path, which
// the reference list (top-level fields only) can never match.
function storagePaths(v: Validator, path: string): string[] {
  if (v.kind === "id") return v.tableName === "_storage" ? [path] : [];
  return [
    ...Object.entries(v.fields ?? {}).flatMap(([name, field]) =>
      storagePaths(field, `${path}.${name}`),
    ),
    ...(v.element ? storagePaths(v.element, `${path}[]`) : []),
    ...(v.members ?? []).flatMap((member) => storagePaths(member, path)),
    ...(v.value ? storagePaths(v.value, `${path}{}`) : []),
  ];
}

// The path of every field, at any depth, whose name reads as a storage id.
function namedPaths(v: Validator, path: string): string[] {
  return [
    ...Object.entries(v.fields ?? {}).flatMap(([name, field]) => [
      ...(namedLikeStorageId(name) ? [`${path}.${name}`] : []),
      ...namedPaths(field, `${path}.${name}`),
    ]),
    ...(v.element ? namedPaths(v.element, `${path}[]`) : []),
    ...(v.members ?? []).flatMap((member) => namedPaths(member, path)),
    ...(v.value ? namedPaths(v.value, `${path}{}`) : []),
  ];
}

// A whole name (storageId, FILEIDS, blob_id) or a camel-case ending
// (photoStorageId, pdfFileIds); "profileId" ends in a small "f", so it is not.
function namedLikeStorageId(name: string): boolean {
  return (
    /^(?:storage|file|blob)_?ids?$/i.test(name) ||
    /(?:Storage|File|Blob)_?I[dD]s?$/.test(name)
  );
}

// Production TypeScript under `dir`, relative to the repository root.
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        !file.includes("_generated"),
    );
}

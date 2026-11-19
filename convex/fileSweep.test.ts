/**
 * Responsibility: Pins the hourly clean-up of stored files nothing refers
 *   to: the age a file must reach, that a file any record refers to is never
 *   deleted, that every storage id in the schema is in the reference list,
 *   and the bounded batch that resumes where the last run stopped.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/fileSweep, convex/manuals (cleanupUploads),
 *   convex/storageReferences, convex/schema.
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { FILES_PER_RUN, UNREFERENCED_FILE_AGE } from "./fileSweep";
import { STORAGE_REFERENCES } from "./storageReferences";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

afterEach(() => vi.useRealTimers());

function setup() {
  const t = convexTest(schema, modules);
  // Runs the clean-up as the hourly job does, `ms` later than the last run.
  const cleanUpAfter = async (ms: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ms);
    await t.mutation(internal.manuals.cleanupUploads, {});
  };
  const exists = (id: Id<"_storage">) =>
    t.run(async (ctx) => !!(await ctx.db.system.get(id)));
  const store = (text: string) =>
    t.run((ctx) => ctx.storage.store(new Blob([text])));
  return { t, cleanUpAfter, exists, store };
}

it("deletes a stored file nothing refers to once it is more than a day old", async () => {
  const { cleanUpAfter, exists, store } = setup();
  expect(UNREFERENCED_FILE_AGE).toBe(DAY);
  const older = await store("a link upload whose bytes matched no ticket");
  await cleanUpAfter(DAY - HOUR);
  expect(await exists(older)).toBe(true);
  const younger = await store("an upload an hour from filing");
  await cleanUpAfter(2 * HOUR);
  expect(await exists(older)).toBe(false);
  expect(await exists(younger)).toBe(true);
  await cleanUpAfter(DAY);
  expect(await exists(younger)).toBe(false);
});

it("never deletes a file a record, attachment, manual, photo, Form 337 or queued upload refers to, however old", async () => {
  const { t, cleanUpAfter, exists, store } = setup();
  const sweepAt = Date.now() + 30 * DAY;
  const referenced = await t.run((ctx) => referEveryWay(ctx, sweepAt));
  const orphan = await store("orphan");
  await cleanUpAfter(30 * DAY);
  expect(Object.keys(referenced).sort()).toEqual(
    STORAGE_REFERENCES.map((r) => r.table).sort(),
  );
  for (const [table, id] of Object.entries(referenced))
    expect(await exists(id), table).toBe(true);
  expect(await exists(orphan)).toBe(false);
});

it(`checks at most ${FILES_PER_RUN} files a run and resumes after the last one checked`, async () => {
  const { t, cleanUpAfter, exists, store } = setup();
  const filed = await t.run(async (ctx) => {
    const ids: Id<"_storage">[] = [];
    for (let i = 0; i < FILES_PER_RUN; i++) {
      const storageId = await ctx.storage.store(new Blob([`page ${i}`]));
      await ctx.db.insert("workOrderFiles", {
        workOrderUuid: "wo",
        storageId,
        name: `page-${i}.pdf`,
        size: 1,
        uploadedAt: 1,
      });
      ids.push(storageId);
    }
    return ids;
  });
  const orphan = await store("orphan");
  await cleanUpAfter(2 * DAY);
  expect(await exists(orphan)).toBe(true);
  await cleanUpAfter(HOUR);
  expect(await exists(orphan)).toBe(false);
  for (const id of filed) expect(await exists(id)).toBe(true);
});

it("finds every storage id in the schema, nested ones included, in the reference list", () => {
  const found = Object.entries(schema.tables).flatMap(([table, def]) =>
    storagePaths((def as unknown as { validator: Validator }).validator, table),
  );
  expect(found.sort()).toEqual(
    STORAGE_REFERENCES.map((r) => `${r.table}.${r.field}`).sort(),
  );
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

// One file referred to from each storage table, by table name.
async function referEveryWay(
  ctx: MutationCtx,
  sweepAt: number,
): Promise<Partial<Record<TableNames, Id<"_storage">>>> {
  const file = (name: string) => ctx.storage.store(new Blob([name]));
  const row = { name: "a.pdf", type: "application/pdf", size: 1 };
  const userId = await ctx.db.insert("users", {
    name: "Member",
    active: true,
    isAdmin: false,
    groupIds: [],
  });
  const ids = {
    aircraftFiles: await file("Form 337"),
    aircraftPhotos: await file("photo"),
    certificationFiles: await file("license"),
    inventoryFiles: await file("inventory"),
    manualUploads: await file("queued manual"),
    manuals: await file("manual"),
    poFiles: await file("purchase order"),
    spruceAccounts: await file("catalog"),
    taskEvidence: await file("evidence"),
    workOrderFiles: await file("work order"),
  };
  await ctx.db.insert("aircraftFiles", {
    ...row,
    aircraftUuid: "a",
    category: "form-337",
    storageId: ids.aircraftFiles,
    uploadedAt: 1,
  });
  await ctx.db.insert("aircraftPhotos", {
    aircraftUuid: "a",
    storageId: ids.aircraftPhotos,
  });
  await ctx.db.insert("certificationFiles", {
    ...row,
    userId,
    kind: "mechanic",
    storageId: ids.certificationFiles,
    uploadedAt: 1,
  });
  await ctx.db.insert("inventoryFiles", {
    ...row,
    stockUuid: "s",
    storageId: ids.inventoryFiles,
    uploadedAt: 1,
  });
  // Issued within the day of the sweep, so the ticket sweep keeps it too.
  await ctx.db.insert("manualUploads", {
    payload: "{}",
    userId,
    createdAt: sweepAt,
    storageId: ids.manualUploads,
  });
  await ctx.db.insert("manuals", {
    uuid: "m",
    aircraftUuid: "a",
    title: "Manual",
    documentNumber: "",
    revision: "1",
    revisionDate: "",
    filename: "manual.pdf",
    size: 1,
    pageCount: 1,
    storageId: ids.manuals,
    uploadedAt: 1,
    uploadedBy: userId,
  });
  await ctx.db.insert("poFiles", {
    ...row,
    poUuid: "po",
    programUuid: "p",
    storageId: ids.poFiles,
    uploadedAt: 1,
  });
  await ctx.db.insert("spruceAccounts", {
    programUuid: "p",
    version: 1,
    catalogId: ids.spruceAccounts,
  });
  await ctx.db.insert("taskEvidence", {
    taskCardUuid: "tc",
    storageId: ids.taskEvidence,
    name: "a.pdf",
    size: 1,
    uploadedAt: 1,
    category: "photo",
  });
  await ctx.db.insert("workOrderFiles", {
    workOrderUuid: "wo",
    storageId: ids.workOrderFiles,
    name: "a.pdf",
    size: 1,
    uploadedAt: 1,
  });
  return ids;
}

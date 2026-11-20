/**
 * Responsibility: Pins the hourly clean-up of stored files nothing refers
 *   to: its off, report and delete modes, the start day before which it
 *   touches nothing, the age a file must reach, that a file any storage table
 *   refers to is never deleted, and the bounded batch that resumes where the
 *   last run stopped, a page edge between files of equal creation time
 *   included. storageReferences.test.ts pins the list itself.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/fileSweep, convex/crons, convex/storageReferences,
 *   convex/schema.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import type { Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import crons from "./crons";
import {
  FILES_PER_RUN,
  pageAfter,
  SWEEP_FILES,
  UNREFERENCED_FILE_AGE,
  type SweepCursor,
} from "./fileSweep";
import { STORAGE_REFERENCES } from "./storageReferences";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// A fixed morning: each test's first sweep runs on this UTC day.
const FIRST_RUN = Date.UTC(2026, 10, 19, 10);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// A deployment with FILE_SWEEP set to `mode`, or unset, on the morning of
// FIRST_RUN; the sweep has not run yet.
function setup(mode: string | undefined) {
  vi.stubEnv("FILE_SWEEP", mode);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIRST_RUN);
  const t = convexTest(schema, modules);
  // Runs the sweep as its hourly job does, `ms` later than the last run.
  const sweepAfter = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    await t.mutation(SWEEP_FILES, {});
  };
  const metadata = (id: Id<"_storage">) =>
    t.run(async (ctx) => await ctx.db.system.get(id));
  const exists = async (id: Id<"_storage">) => !!(await metadata(id));
  const store = (text: string) =>
    t.run((ctx) => ctx.storage.store(new Blob([text])));
  return { t, sweepAfter, metadata, exists, store };
}

// What the sweep logs for a file, as it reads it from storage.
async function logged(
  metadata: (id: Id<"_storage">) => Promise<{
    _id: Id<"_storage">;
    _creationTime: number;
    size: number;
    contentType?: string;
  } | null>,
  id: Id<"_storage">,
) {
  const file = (await metadata(id))!;
  return {
    storageId: file._id,
    size: file.size,
    contentType: file.contentType,
    _creationTime: file._creationTime,
  };
}

it("runs as an hourly job of its own, apart from the manual-ticket clean-up", () => {
  const jobs = Object.values(
    (crons as unknown as { crons: Record<string, { name: string }> }).crons,
  ).map((job) => job.name);
  expect(jobs).toContain("fileSweep:sweepFiles");
  expect(jobs).toContain("manuals:cleanupUploads");
});

it("deletes a stored file nothing refers to once it is more than a day old", async () => {
  const { sweepAfter, exists, store } = setup("delete");
  expect(UNREFERENCED_FILE_AGE).toBe(DAY);
  await sweepAfter(0);
  const older = await store("a link upload whose bytes matched no ticket");
  await sweepAfter(DAY - HOUR);
  expect(await exists(older)).toBe(true);
  const younger = await store("an upload an hour from filing");
  await sweepAfter(2 * HOUR);
  expect(await exists(older)).toBe(false);
  expect(await exists(younger)).toBe(true);
  await sweepAfter(DAY);
  expect(await exists(younger)).toBe(false);
});

it("only reports what it would delete until FILE_SWEEP is delete", async () => {
  const { sweepAfter, metadata, exists, store } = setup(undefined);
  await sweepAfter(0);
  const orphan = await store("orphan");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sweepAfter(2 * DAY);
  expect(await exists(orphan)).toBe(true);
  expect(log).toHaveBeenCalledWith(
    "fileSweep would delete",
    await logged(metadata, orphan),
  );
  expect(log).toHaveBeenCalledWith("fileSweep run", {
    mode: "report",
    checked: 1,
    unreferenced: 1,
  });
});

it("logs every file it deletes with FILE_SWEEP=delete", async () => {
  const { sweepAfter, metadata, exists, store } = setup("delete");
  await sweepAfter(0);
  const orphan = await store("orphan");
  const expected = await logged(metadata, orphan);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sweepAfter(2 * DAY);
  expect(await exists(orphan)).toBe(false);
  expect(log).toHaveBeenCalledWith("fileSweep deleted", expected);
});

it("does nothing at all with FILE_SWEEP=off", async () => {
  const { t, sweepAfter, exists, store } = setup("off");
  const orphan = await store("orphan");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sweepAfter(30 * DAY);
  expect(await exists(orphan)).toBe(true);
  expect(log).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("fileSweep").collect())).toEqual([]);
});

it("reports, and warns, for a FILE_SWEEP value it does not know", async () => {
  const { sweepAfter, exists, store } = setup("yes");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sweepAfter(0);
  const orphan = await store("orphan");
  await sweepAfter(2 * DAY);
  expect(await exists(orphan)).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    "fileSweep: FILE_SWEEP is not off, report or delete; reporting only.",
  );
});

it("never touches a file created before the day of its first run, however old", async () => {
  const { sweepAfter, exists, store } = setup("delete");
  vi.setSystemTime(FIRST_RUN - DAY);
  const yesterday = await store("in storage before the sweep existed");
  vi.setSystemTime(FIRST_RUN - 2 * HOUR);
  const thisMorning = await store("stored earlier on the first day");
  vi.setSystemTime(FIRST_RUN);
  await sweepAfter(0);
  await sweepAfter(30 * DAY);
  expect(await exists(yesterday)).toBe(true);
  expect(await exists(thisMorning)).toBe(false);
});

it("walks again from its start when switched from report to delete, so files it only reported go", async () => {
  const { sweepAfter, exists, store } = setup("report");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sweepAfter(0);
  const orphan = await store("orphan");
  await sweepAfter(2 * DAY);
  expect(await exists(orphan)).toBe(true);
  vi.stubEnv("FILE_SWEEP", "delete");
  await sweepAfter(HOUR);
  expect(await exists(orphan)).toBe(false);
});

it("never deletes a file a record, attachment, manual, photo, Form 337 or queued upload refers to, however old", async () => {
  const { t, sweepAfter, exists, store } = setup("delete");
  await sweepAfter(0);
  const sweepAt = Date.now() + 30 * DAY;
  const referenced = await t.run((ctx) => referEveryWay(ctx, sweepAt));
  const orphan = await store("orphan");
  await sweepAfter(30 * DAY);
  expect(Object.keys(referenced).sort()).toEqual(
    STORAGE_REFERENCES.map((r) => r.table).sort(),
  );
  for (const [table, id] of Object.entries(referenced))
    expect(await exists(id), table).toBe(true);
  expect(await exists(orphan)).toBe(false);
});

it(`checks at most ${FILES_PER_RUN} files a run and resumes after the last one checked`, async () => {
  const { t, sweepAfter, metadata, exists, store } = setup("delete");
  await sweepAfter(0);
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
  await sweepAfter(2 * DAY);
  expect(await exists(orphan)).toBe(true);
  const last = (await metadata(filed.at(-1)!))!;
  expect(
    await t.run(async (ctx) => await ctx.db.query("fileSweep").unique()),
  ).toMatchObject({
    checkedThrough: last._creationTime,
    checkedIds: [last._id],
  });
  await sweepAfter(HOUR);
  expect(await exists(orphan)).toBe(false);
  for (const id of filed) expect(await exists(id)).toBe(true);
});

describe("the page after the cursor", () => {
  const file = (id: string, at: number) => ({
    _id: id as Id<"_storage">,
    _creationTime: at,
  });
  const ids = (files: { _id: string }[]) => files.map((f) => f._id);
  const start = { checkedThrough: 0, checkedIds: [] };

  it("picks up the rest of a group of files that share a creation time across a page edge", () => {
    const files = [file("a", 1), file("b", 2), file("c", 2), file("d", 3)];
    const first = pageAfter(files, start, 2);
    expect(ids(first.page)).toEqual(["a", "b"]);
    expect(first.next).toEqual({ checkedThrough: 2, checkedIds: ["b"] });
    // Read again from time 2 on, inclusive: a cursor of time alone would
    // skip "c" for good.
    const second = pageAfter(files.slice(1), first.next, 2);
    expect(ids(second.page)).toEqual(["c", "d"]);
    expect(second.next).toEqual({ checkedThrough: 3, checkedIds: ["d"] });
  });

  it("keeps every id checked at one time across several pages", () => {
    const files = [file("b", 2), file("c", 2), file("e", 2)];
    let cursor: SweepCursor = start;
    const pages: string[][] = [];
    for (let run = 0; run < 3; run++) {
      const { page, next } = pageAfter(files, cursor, 1);
      pages.push(ids(page));
      cursor = next;
    }
    expect(pages).toEqual([["b"], ["c"], ["e"]]);
    expect(cursor).toEqual({ checkedThrough: 2, checkedIds: ["b", "c", "e"] });
  });

  it("returns no page and the same cursor once every candidate is checked", () => {
    const cursor = { checkedThrough: 2, checkedIds: ["b" as Id<"_storage">] };
    expect(pageAfter([file("b", 2)], cursor, 5)).toEqual({
      page: [],
      next: cursor,
    });
  });
});

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

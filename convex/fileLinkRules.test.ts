/**
 * Responsibility: Pins who may open each kind of stored file through a link:
 *   exactly the files their own snapshot lists, for every role, the owner
 *   portal and a member who is both owner and board member included.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/fileLinks, convex/sampleProgram (fixture data),
 *   convex/operations (snapshot), convex/schema, convex/_generated,
 *   src/domain/fileLinks.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { FILE_LINKS } from "../tests/fixtures/fileLinks";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Snapshot } from "../src/domain/model";
import type { FileRef } from "../src/domain/fileLinks";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const ROOT = "root@example.test";
const DAY_MS = 86_400_000;
const SAMPLE_PDFS = 4;
// The kinds the snapshot lists; the others are listed on request and pinned
// with their features (manuals, purchase orders, certifications).
type Kind = Exclude<FileRef["kind"], "manual" | "poFile" | "certificationFile">;
type Role =
  "reader" | "owner" | "ownerAndBoard" | "board" | "programAdmin" | "admin";
const links = FILE_LINKS;

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("issues links for exactly the files each role's snapshot lists, of every kind", async () => {
  const { t, program, refs, subjects } = await fixture();
  const seen: Record<Role, Record<Kind, number>> = {} as never;
  for (const role of Object.keys(subjects) as Role[]) {
    const as = t.withIdentity({ subject: subjects[role] });
    const snapshot = (await as.query(api.operations.snapshot, {}))!;
    seen[role] = {} as Record<Kind, number>;
    for (const kind of Object.keys(refs) as Kind[]) {
      const listed = listedIds(snapshot, kind).sort();
      seen[role][kind] = listed.length;
      if (role === "board") continue;
      const files = refs[kind].map((id) => ({ kind, id }));
      const issued = await as.mutation(links, { programUuid: program, files });
      const opened = refs[kind].filter((_, i) => issued[i] !== null).sort();
      expect(opened, `${role} ${kind}`).toEqual(listed);
    }
  }
  // Guards against a check that passes because nobody lists anything.
  const some = (role: Role, kinds: Kind[]) =>
    kinds.map((kind) => [role, kind, seen[role][kind] > 0]);
  const none = (role: Role, kinds: Kind[]) =>
    kinds.map((kind) => [role, kind, seen[role][kind] === 0]);
  const everyKind = Object.keys(refs) as Kind[];
  const shop: Kind[] = ["workOrderFile", "taskEvidence", "inventoryFile"];
  expect(
    [
      some("reader", ["aircraftFile", "aircraftPhoto", "workOrderFile"]),
      some("reader", ["taskEvidence"]),
      none("reader", ["inventoryFile"]),
      some("owner", ["aircraftFile", "aircraftPhoto"]),
      none("owner", shop),
      some("ownerAndBoard", ["aircraftFile", "aircraftPhoto"]),
      none("ownerAndBoard", shop),
      none("board", everyKind),
      some("programAdmin", everyKind),
      some("admin", everyKind),
    ]
      .flat()
      .filter(([, , holds]) => !holds),
  ).toEqual([]);
  expect(seen.owner.aircraftFile).toBeLessThan(seen.reader.aircraftFile);
});

it("refuses a board member, whose view lists no file", async () => {
  const { t, program, refs, subjects } = await fixture();
  const board = t.withIdentity({ subject: subjects.board });
  await expect(
    board.mutation(links, {
      programUuid: program,
      files: [{ kind: "aircraftPhoto", id: refs.aircraftPhoto[0] }],
    }),
  ).rejects.toThrow("Files are not available in the board view.");
});

// The ids a snapshot gives each kind of file it lists.
function listedIds(s: Snapshot, kind: Kind): string[] {
  const uuids = (files?: { uuid: string }[]) =>
    (files ?? []).map((f) => f.uuid);
  if (kind === "aircraftPhoto")
    return s.aircraft.filter((a) => a.hasPhoto).map((a) => a.uuid);
  if (kind === "aircraftFile") return uuids(s.aircraftFiles);
  if (kind === "workOrderFile") return uuids(s.workOrderAttachments);
  if (kind === "taskEvidence") return uuids(s.taskEvidence);
  return uuids(s.inventoryAttachments);
}

/**
 * The hosted sample program and its files, plus one of every kind on its
 * first aircraft (a current and an archived Form 337 copy, a logbook page
 * photo, the aircraft photo, a work order file, job card evidence) and one on
 * a stock record; a member of each role. The references name every stored
 * file of each kind.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Root",
      email: ROOT,
      active: true,
      isAdmin: true,
      groupIds: [],
    }),
  );
  await t.mutation(internal.sampleProgram.seed, { email: ROOT });
  const pdfs = await t.run(async (ctx) => {
    const stored = [];
    for (let i = 0; i < SAMPLE_PDFS; i++)
      stored.push({ storageId: await storePdf(ctx), size: 8 });
    return stored;
  });
  await t.mutation(internal.sampleProgram.attach, { files: pdfs, email: ROOT });
  const seeded = await t.run(async (ctx) => ({
    program: (await ctx.db.query("programs").first())!.uuid,
    refs: await addFiles(ctx),
  }));
  const subjects = await t.run((ctx) => addMembers(ctx, seeded.program));
  await t.mutation(internal.memberships.backfill, {});
  return { t, ...seeded, subjects };
}

async function addFiles(ctx: MutationCtx): Promise<Record<Kind, string[]>> {
  const aircraft = await ctx.db.query("aircraft").collect();
  const first = aircraft[0].uuid;
  const order = (await ctx.db.query("workOrders").collect()).find(
    (w) => w.aircraftUuid === first,
  )!;
  const card = (await ctx.db.query("taskCards").collect()).find(
    (c) => c.aircraftUuid === first,
  )!;
  const stock = (await ctx.db.query("management").collect()).find(
    (r) => r.kind === "stock",
  )!;
  // Owners see completed work orders but never their files: completing the
  // one the file is filed on leaves only that rule to keep them out.
  await ctx.db.patch(order._id, {
    payload: JSON.stringify({
      ...JSON.parse(order.payload),
      status: "completed",
      completionDate: "2026-01-02",
    }),
  });
  const file = { name: "file.pdf", size: 8, uploadedAt: 1 };
  const document = async (
    category: "form-337" | "logbook-page",
    archived = false,
  ) =>
    ctx.db.insert("aircraftFiles", {
      aircraftUuid: first,
      category,
      storageId: await storePdf(ctx),
      type: "application/pdf",
      ...file,
      ...(category === "logbook-page"
        ? { linkedKind: "work-order" as const, linkedUuid: order.uuid }
        : {}),
      ...(archived ? { archivedAt: 2, archiveReason: "Superseded" } : {}),
    });
  await ctx.db.insert("aircraftPhotos", {
    aircraftUuid: first,
    storageId: await storePdf(ctx),
  });
  await document("form-337");
  await document("form-337", true);
  await document("logbook-page");
  await ctx.db.insert("workOrderFiles", {
    workOrderUuid: order.uuid,
    aircraftUuid: first,
    storageId: await storePdf(ctx),
    ...file,
  });
  await ctx.db.insert("taskEvidence", {
    taskCardUuid: card.uuid,
    aircraftUuid: first,
    storageId: await storePdf(ctx),
    category: "photo",
    ...file,
  });
  await ctx.db.insert("inventoryFiles", {
    stockUuid: stock.uuid,
    storageId: await storePdf(ctx),
    type: "application/pdf",
    ...file,
  });
  const ids = async (
    table:
      "aircraftFiles" | "workOrderFiles" | "taskEvidence" | "inventoryFiles",
  ) => (await ctx.db.query(table).collect()).map((f) => f._id as string);
  return {
    aircraftFile: await ids("aircraftFiles"),
    aircraftPhoto: aircraft.map((a) => a.uuid),
    workOrderFile: await ids("workOrderFiles"),
    taskEvidence: await ids("taskEvidence"),
    inventoryFile: await ids("inventoryFiles"),
  };
}

async function addMembers(
  ctx: MutationCtx,
  program: string,
): Promise<Record<Role, string>> {
  const first = (await ctx.db.query("aircraft").first())!.uuid;
  const group = (fields: {
    owner?: boolean;
    board?: boolean;
    programAdmin?: boolean;
    aircraftIds?: string[];
  }) =>
    ctx.db.insert("groups", {
      programUuid: program,
      name: JSON.stringify(fields),
      permissions: fields.programAdmin ? ["read", "maintenance"] : ["read"],
      aircraftIds: [],
      ...fields,
    });
  const owners = await group({ owner: true, aircraftIds: [first] });
  const board = await group({ board: true });
  const member = async (
    groupIds: Awaited<ReturnType<typeof group>>[],
    isAdmin = false,
  ) => {
    const userId = await ctx.db.insert("users", {
      name: "Member",
      active: true,
      isAdmin,
      activeProgramUuid: program,
      groupIds,
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY_MS,
    });
    return `${userId}|${session}`;
  };
  return {
    reader: await member([await group({ aircraftIds: [first] })]),
    owner: await member([owners]),
    ownerAndBoard: await member([owners, board]),
    board: await member([board]),
    programAdmin: await member([await group({ programAdmin: true })]),
    admin: await member([], true),
  };
}

function storePdf(ctx: MutationCtx) {
  return ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
}

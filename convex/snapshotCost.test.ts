/**
 * Responsibility: Pins what the workspace snapshot costs to build and that
 *   making it cheaper changed nothing any role receives.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts, convex/schema.ts,
 *   tests/fixtures/programVolume.ts, tests/fixtures/storedCollections.ts,
 *   src/data/demo.ts, src/domain/model.ts (types).
 *
 * convex-test enforces none of Convex's per-function limits (16 MiB read, the
 * index-range count, one second), so reads are counted here through a proxy
 * over ctx.db: lookups (each query or get), documents, and their JSON size,
 * which tracks the byte count Convex limits. The output goldens were recorded
 * before the snapshot was made cheaper.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { snapshot as snapshotQuery } from "./operations";
import {
  addOlderHistory,
  seedProgramVolume,
  VOLUME,
  type VolumeAccounts,
} from "../tests/fixtures/programVolume";
import {
  PROGRAM,
  seedStoredCollections,
} from "../tests/fixtures/storedCollections";
import type { Snapshot } from "../src/domain/model";
import { demoSnapshot } from "../src/data/demo";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const N206 = demoSnapshot().aircraft[0].uuid;
const SECOND_CARD = "00000000-0000-4000-8000-00000000beef";
const ROLES = ["admin", "pilot", "owner", "board"] as const;
// A kept work order's job cards, archived job cards, costs and files.
const LOOKUPS_PER_ORDER = 4;
// Seeding about ten thousand rows takes a while on a shared machine.
const VOLUME_TIMEOUT_MS = 120_000;
// Tables the owner and board whitelists never pass, so never worth reading.
const NOT_FOR_REDUCED_VIEWS = [
  "flights",
  "audit",
  "flightPlans",
  "faaMonitors",
  "purchaseOrders",
  "checklists",
  "componentTemplates",
  "componentSetups",
  "inspectionTemplates",
  "expiringItems",
  "taskEvidence",
  "workOrderFiles",
  "inventoryFiles",
];
// What prices issued parts: the board totals spend from the cost ledger
// instead (ADR-0013), and reads only the budgets of the cost records.
const NOT_FOR_REDUCED_COSTS = [
  "taskCards",
  "archivedTaskCards",
  "partsRequests",
];

type Role = (typeof ROLES)[number];

interface Reads {
  lookups: number;
  documents: number;
  bytes: number;
  tables: string[];
}

afterEach(() => vi.useRealTimers());

describe("the workspace snapshot at one year of records", () => {
  let t: ReturnType<typeof convexTest>;
  let accounts: VolumeAccounts;
  const reads = {} as Record<Role, Reads>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
    t = convexTest(schema, modules);
    accounts = (await t.run((ctx) => seedProgramVolume(ctx, SEEDED_AT)))
      .accounts;
    for (const role of ROLES) reads[role] = await measure(t, accounts[role]);
    vi.useRealTimers();
  }, VOLUME_TIMEOUT_MS);

  it("returns every role what it returned before", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
    const digests: Record<string, { bytes: number; sha256: string }> = {};
    for (const role of ROLES)
      digests[role] = await digest(
        await t
          .withIdentity({ subject: accounts[role] })
          .query(api.operations.snapshot, {}),
      );
    await expect(JSON.stringify(digests, null, 1)).toMatchFileSnapshot(
      "./__golden__/snapshot.volume.json",
    );
  });

  it("leaves out of the owner and board reads what their views never show", () => {
    const among = (role: Role, tables: string[]) =>
      reads[role].tables.filter((table) => tables.includes(table));
    expect(among("owner", NOT_FOR_REDUCED_VIEWS)).toEqual([]);
    expect(among("board", NOT_FOR_REDUCED_VIEWS)).toEqual([]);
    expect(among("owner", NOT_FOR_REDUCED_COSTS)).toEqual([]);
    expect(among("board", NOT_FOR_REDUCED_COSTS)).toEqual([]);
    expect(reads.board.tables).toEqual(
      expect.arrayContaining(["costLedger", "costs"]),
    );
  });

  it("reads less for an owner or a board member than for the workspace", () => {
    // Recorded at this volume: the owner and the board each read about a
    // seventh of the workspace's bytes; the board's cost totals come from the
    // cost ledger, not the job cards and requests that price parts.
    expect(reads.owner.bytes * 4).toBeLessThan(reads.admin.bytes);
    expect(reads.owner.documents * 3).toBeLessThan(reads.admin.documents);
    expect(reads.board.bytes * 4).toBeLessThan(reads.admin.bytes);
    expect(reads.board.documents * 3).toBeLessThan(reads.admin.documents);
  });

  it("reads nothing more for history the window leaves out (S7)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
    const before = { pilot: reads.pilot, admin: reads.admin };
    await t.run((ctx) => addOlderHistory(ctx, SEEDED_AT, 100));
    for (const role of ["pilot", "admin"] as const) {
      const after = await measure(t, accounts[role]);
      expect(after.lookups, role).toBe(before[role].lookups);
      expect(after.documents, role).toBe(before[role].documents);
    }
  });

  // Since S7 a kept record's files are looked up by the record: one lookup
  // per job card, and a work order's cards, removed cards, costs and files.
  it("keeps the pilot's lookups to a few per aircraft and table, and per kept record", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
    const s = (await t
      .withIdentity({ subject: accounts.pilot })
      .query(api.operations.snapshot, {}))!;
    const cards = s.taskCards!.length + s.archivedTaskCards!.length;
    expect(reads.pilot.lookups).toBeLessThan(
      VOLUME.aircraft * 30 + cards + LOOKUPS_PER_ORDER * s.workOrders!.length,
    );
  });
});

it("returns the owner and board views it returned before", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    const { admin } = await seedStoredCollections(ctx);
    await ctx.db.insert("taskEvidence", {
      taskCardUuid: (await ctx.db.query("taskCards").first())!.uuid,
      storageId: await ctx.storage.store(new Blob(["%PDF-1.4"])),
      name: "evidence.pdf",
      size: 8,
      uploadedAt: SEEDED_AT,
      category: "photo",
    });
    return {
      admin: admin.subject,
      owner: await reducedAccount(ctx, { owner: true, aircraftIds: [N206] }),
      board: await reducedAccount(ctx, { board: true, aircraftIds: [] }),
    };
  });
  for (const view of ["owner", "board"] as const) {
    const s = await t
      .withIdentity({ subject: subjects[view] })
      .query(api.operations.snapshot, {});
    expect(s!.aircraft.length, view).toBeGreaterThan(0);
    await expect(JSON.stringify(s, null, 1)).toMatchFileSnapshot(
      `./__golden__/snapshot.${view}.json`,
    );
  }
});

it("keeps each job card's evidence together, in job-card order", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    const { admin } = await seedStoredCollections(ctx);
    const first = (await ctx.db.query("taskCards").first())!;
    await ctx.db.insert("taskCards", {
      uuid: SECOND_CARD,
      aircraftUuid: first.aircraftUuid,
      payload: first.payload.replace(first.uuid, SECOND_CARD),
    });
    const blob = await ctx.storage.store(new Blob(["%PDF-1.4"]));
    // b1 was filed before files carried their aircraft, as older rows were.
    const filed: [string, string, string | undefined][] = [
      [SECOND_CARD, "b1", undefined],
      [first.uuid, "a1", first.aircraftUuid],
      [SECOND_CARD, "b2", first.aircraftUuid],
    ];
    for (const [card, name, aircraftUuid] of filed)
      await ctx.db.insert("taskEvidence", {
        taskCardUuid: card,
        aircraftUuid,
        storageId: blob,
        name,
        size: 8,
        uploadedAt: SEEDED_AT,
        category: "photo",
      });
    return admin.subject;
  });
  const s = await t
    .withIdentity({ subject })
    .query(api.operations.snapshot, {});
  expect(s!.taskEvidence!.map((e) => e.name)).toEqual(["a1", "b1", "b2"]);
});

async function reducedAccount(
  ctx: Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0],
  group: { owner?: boolean; board?: boolean; aircraftIds: string[] },
) {
  const groupId = await ctx.db.insert("groups", {
    programUuid: PROGRAM,
    name: group.owner ? "Owners" : "Board",
    permissions: ["read"],
    ...group,
  });
  const id = await ctx.db.insert("users", {
    name: group.owner ? "Owner" : "Board member",
    active: true,
    isAdmin: false,
    activeProgramUuid: PROGRAM,
    groupIds: [groupId],
  });
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: Date.now() + 86_400_000,
  });
  return `${id}|${session}`;
}

// Runs the snapshot handler as `subject` with every read counted. Convex
// keeps a registered function's handler on `_handler`; calling it directly is
// the only way to hand it a traced ctx.
async function measure(
  t: ReturnType<typeof convexTest>,
  subject: string,
): Promise<Reads> {
  const handler = (
    snapshotQuery as unknown as {
      _handler: (ctx: QueryCtx, args: object) => Promise<Snapshot | null>;
    }
  )._handler;
  return t.withIdentity({ subject }).run(async (ctx) => {
    const reads = {
      lookups: 0,
      documents: 0,
      bytes: 0,
      tables: [] as string[],
    };
    const result = await handler(traceReads(ctx, reads), {});
    expect(result).not.toBeNull();
    return { ...reads, tables: [...new Set(reads.tables)].sort() };
  });
}

function traceReads(ctx: QueryCtx, reads: Reads): QueryCtx {
  const count = (doc: unknown) => {
    if (!doc) return;
    reads.documents++;
    reads.bytes += JSON.stringify(doc).length;
  };
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "query")
        return (table: string) => {
          reads.lookups++;
          reads.tables.push(table);
          return traceQuery(target.query(table as "audit"), count);
        };
      if (key !== "get") return value.bind(target);
      return async (...args: unknown[]) => {
        reads.lookups++;
        const doc = await (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        count(doc);
        return doc;
      };
    },
  });
  return { ...ctx, db };
}

// Follows a query's builder chain and counts what its last step returns.
function traceQuery<T extends object>(
  query: T,
  count: (doc: unknown) => void,
): T {
  return new Proxy(query, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(out instanceof Promise))
          return typeof out === "object" && out ? traceQuery(out, count) : out;
        return out.then((rows: unknown) => {
          const docs = Array.isArray(rows)
            ? rows
            : rows && typeof rows === "object" && "page" in rows
              ? (rows as { page: unknown[] }).page
              : [rows];
          docs.forEach(count);
          return rows;
        });
      };
    },
  });
}

// syncedAt is the query's clock reading, not a record.
async function digest(s: Snapshot | null) {
  const text = JSON.stringify({ ...s, syncedAt: undefined });
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const sha256 = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { bytes: text.length, sha256 };
}

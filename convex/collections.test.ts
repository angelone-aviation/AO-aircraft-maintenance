/**
 * Responsibility: Pins the collection codec: decode, lenient decode and
 *   encode, and that hydrate and the snapshot query read every stored
 *   collection exactly as before it.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/collections.ts, convex/runCommand.ts,
 *   convex/programContext.ts, convex/schema.ts, zod,
 *   tests/fixtures/storedCollections.ts, src/data/demo.ts, src/domain
 *   stored-record schemas.
 *
 * The snapshot golden files were recorded from the query before it decoded
 * through the codec; LEGACY_DECODERS is the decoding hydrate used before it.
 */
import { convexTest } from "convex-test";
import { ZodError } from "zod";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { hydrate, type Need } from "./runCommand";
import { checkContext, inspectionDocs, managementDocs } from "./programContext";
import {
  decode,
  decodeLenient,
  encode,
  type PayloadCollection,
} from "./collections";
import {
  PROGRAM,
  seedStoredCollections,
} from "../tests/fixtures/storedCollections";
import type { Snapshot } from "../src/domain/model";
import { demoSnapshot } from "../src/data/demo";
import { recordSchema } from "../src/domain/management";
import { taskCardSchema } from "../src/domain/taskCards";
import { workOrderSchema } from "../src/domain/workOrders";
import { adSchema } from "../src/domain/airworthiness";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import { costRecordSchema } from "../src/domain/costs";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);

// Decoders by collection, as hydrate wrote them before the codec.
const LEGACY_DECODERS: Partial<Record<Need, (payload: string) => unknown>> = {
  management: (p) => recordSchema.parse(JSON.parse(p)),
  taskCards: (p) => taskCardSchema.parse(JSON.parse(p)),
  archivedTaskCards: (p) => taskCardSchema.parse(JSON.parse(p)),
  workOrders: (p) => workOrderSchema.parse(JSON.parse(p)),
  airworthiness: (p) => adSchema.parse(JSON.parse(p)),
  partsRequests: (p) => partsRequestSchema.parse(JSON.parse(p)),
  purchaseOrders: (p) => poSchema.parse(JSON.parse(p)),
  checklists: (p) => checklistRecordSchema.parse(JSON.parse(p)),
  componentTemplates: (p) => JSON.parse(p),
  componentSetups: (p) => JSON.parse(p),
  inspectionTemplates: (p) => inspectionTemplateSchema.parse(JSON.parse(p)),
  costs: (p) => costRecordSchema.parse(JSON.parse(p)),
};
const PAYLOAD_COLLECTIONS: PayloadCollection[] = [
  "management",
  "taskCards",
  "archivedTaskCards",
  "workOrders",
  "airworthiness",
  "partsRequests",
  "purchaseOrders",
  "checklists",
  "componentTemplates",
  "componentSetups",
  "inspectionTemplates",
  "costs",
  "faaMonitors",
  "flightPlans",
];
const NEEDS: Need[] = [
  "management",
  "inspections",
  "taskCards",
  "archivedTaskCards",
  "workOrders",
  "discrepancies",
  "airworthiness",
  "partsRequests",
  "purchaseOrders",
  "checklists",
  "componentTemplates",
  "componentSetups",
  "inspectionTemplates",
  "costs",
];

beforeEach(() => {
  // Fixed ids and times, so the golden files compare byte for byte.
  vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
  let next = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++next).padStart(12, "1")}`,
  );
  vi.stubEnv("FAA_DRS_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// The snapshot's other fields, which hydrate leaves as the context had them.
const untouched = (s: Snapshot) =>
  JSON.stringify(
    Object.entries(s).filter(([key]) => !NEEDS.includes(key as Need)),
  );

async function fixture() {
  const t = convexTest(schema, modules);
  const accounts = await t.run((ctx) => seedStoredCollections(ctx));
  return {
    t,
    admin: t.withIdentity({ subject: accounts.admin.subject }),
    member: t.withIdentity({ subject: accounts.member.subject }),
  };
}

it("decodes a payload through its schema, in row order", () => {
  const vendor = (uuid: string, name: string) => ({
    payload: JSON.stringify({ uuid, version: 1, kind: "vendor", name }),
  });
  expect(
    decode("management", [vendor("b", " Second "), vendor("a", "First")]),
  ).toEqual([
    expect.objectContaining({ uuid: "b", name: "Second", website: "" }),
    expect.objectContaining({ uuid: "a", name: "First", notes: "" }),
  ]);
  expect(() => decode("management", [vendor("c", "")])).toThrow(ZodError);
  expect(() => decode("costs", [{ payload: "{" }])).toThrow(SyntaxError);
});

it("decodes component templates and setups as written", () => {
  const written = { uuid: "not-a-uuid", rows: [], legacyNote: "kept" };
  const rows = [{ payload: JSON.stringify(written) }];
  expect(decode("componentTemplates", rows)).toEqual([written]);
  expect(decode("componentSetups", rows)).toEqual([written]);
});

it("hydrates every collection as the pre-codec decoders did", async () => {
  const { admin } = await fixture();
  // Compared inside the transaction: results leaving it have their keys
  // sorted, and key order reaches stored change-log JSON.
  const compared = await admin.run(async (ctx) => {
    const state = await checkContext(ctx, PROGRAM);
    const { snapshot, docs } = await hydrate(ctx, state, NEEDS);
    const collections = NEEDS.map((need) => {
      const rows: object[] = docs[need];
      const decode = LEGACY_DECODERS[need];
      const expected = decode
        ? rows.map((r) => decode((r as { payload: string }).payload))
        : rows;
      return {
        need,
        rows: rows.length,
        actual: JSON.stringify(snapshot[need]),
        expected: JSON.stringify(expected),
      };
    });
    return {
      collections,
      untouched: [untouched(snapshot), untouched(state)],
    };
  });
  for (const { need, rows, actual, expected } of compared.collections) {
    expect(rows, need).toBeGreaterThan(0);
    expect(actual, need).toBe(expected);
  }
  const [after, before] = compared.untouched;
  expect(after).toBe(before);
});

it("returns the snapshot it returned before the codec, to an administrator and a member", async () => {
  const { admin, member } = await fixture();
  for (const [view, as] of [
    ["admin", admin],
    ["member", member],
  ] as const) {
    const snapshot = await as.query(api.operations.snapshot, {});
    await expect(JSON.stringify(snapshot, null, 1)).toMatchFileSnapshot(
      `./__golden__/snapshot.${view}.json`,
    );
  }
});

it("decodes leniently: a matching payload decoded, any other as stored", () => {
  const vendor = { uuid: "a", version: 1, kind: "vendor", name: " Vendor " };
  expect(decodeLenient("management", vendor)).toEqual({
    valid: true,
    record: expect.objectContaining({ name: "Vendor", website: "" }),
  });
  const damaged = { ...vendor, name: "" };
  expect(decodeLenient("management", damaged)).toEqual({
    valid: false,
    stored: damaged,
  });
  expect(decodeLenient("componentSetups", damaged)).toEqual({
    valid: true,
    record: damaged,
  });
});

it("encodes every stored row as the app wrote it, and decodes it back", async () => {
  const { t } = await fixture();
  const rows = await t.run(async (ctx) => {
    const all = [];
    for (const collection of PAYLOAD_COLLECTIONS)
      for (const { _id, _creationTime, ...row } of await ctx.db
        .query(collection)
        .collect())
        all.push({ collection, row: row as { payload: string } });
    return all;
  });
  expect(new Set(rows.map((r) => r.collection)).size).toBe(
    PAYLOAD_COLLECTIONS.length,
  );
  for (const { collection, row } of rows) {
    expect(encode(collection, JSON.parse(row.payload)), collection).toEqual(
      row,
    );
    const [record] = decode(collection, [row]);
    const encoded = encode(collection, record);
    expect(encoded.payload, collection).toBe(JSON.stringify(record));
    expect(JSON.stringify(decode(collection, [encoded])), collection).toBe(
      JSON.stringify([record]),
    );
  }
});

it("refuses to encode a component template without a Flight Program", () => {
  const template = { uuid: "t", version: 1, name: "T", make: "M", model: "M" };
  expect(() => encode("componentTemplates", { ...template, rows: [] })).toThrow(
    "Component template t has no Flight Program.",
  );
});

const SPARE_PROP = {
  kind: "component",
  uuid: "spare-prop",
  version: 0,
  aircraftUuid: "",
  componentType: "Propeller",
  partNumber: "P-1",
  serial: "S-1",
  manufacturer: "",
  notes: "",
  trackTime: true,
  trackCycles: false,
  trackCalendar: false,
  installed: false,
  partsLocation: "Shelf",
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 0,
  timeSinceOverhaul: null,
  timeSinceRepair: null,
  cyclesSinceNew: 0,
  serviceDaysBase: 0,
};

// One stored form for every writer: the management mutation and the transfer
// used to drop the empty column.
it("stores a spare's management row as encode does, through a save and a transfer", async () => {
  const { t, admin } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("programs", {
      ...demoSnapshot().programs![0],
      uuid: "other-program",
      name: "Other",
    }),
  );
  const stored = async () => {
    const row = await t.run((ctx) =>
      ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", SPARE_PROP.uuid))
        .unique(),
    );
    const { _id, _creationTime, ...fields } = row!;
    return fields;
  };
  await admin.mutation(api.management.execute, {
    programUuid: PROGRAM,
    payload: JSON.stringify({
      requestUuid: crypto.randomUUID(),
      reason: "Spare received",
      action: "record.save",
      record: SPARE_PROP,
    }),
  });
  const saved = await stored();
  expect(saved).toHaveProperty("aircraftUuid", "");
  expect(encode("management", JSON.parse(saved.payload))).toEqual(saved);
  await admin.mutation(api.programs.transfer, {
    programUuid: PROGRAM,
    kind: "component",
    uuid: SPARE_PROP.uuid,
    destination: "other-program",
    reason: "New base",
  });
  const moved = await stored();
  expect(moved).toMatchObject({
    programUuid: "other-program",
    aircraftUuid: "",
  });
  expect(encode("management", JSON.parse(moved.payload))).toEqual(moved);
});

// Why the form is free to choose: no index covers the column, and its one
// reader finds a removed component's inspections either way.
it("loads a removed component's inspections whether its aircraftUuid is empty or absent", async () => {
  const { t } = await fixture();
  const [inspection] = demoSnapshot().inspections;
  const found = await t.run(async (ctx) => {
    for (const [uuid, aircraftUuid] of [
      ["empty-column", ""],
      ["no-column", undefined],
    ]) {
      await ctx.db.insert("management", {
        uuid: uuid!,
        programUuid: PROGRAM,
        kind: "component",
        aircraftUuid,
        payload: "{}",
      });
      await ctx.db.insert("inspections", {
        ...inspection,
        uuid: `${uuid}-inspection`,
        aircraftUuid: "",
        componentUuid: uuid,
      });
    }
    const management = await managementDocs(ctx, PROGRAM);
    return (await inspectionDocs(ctx, [], management)).map((d) => d.uuid);
  });
  expect(found.sort()).toEqual([
    "empty-column-inspection",
    "no-column-inspection",
  ]);
});

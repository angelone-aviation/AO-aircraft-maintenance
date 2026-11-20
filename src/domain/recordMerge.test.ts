/**
 * Responsibility: Pins what "Keep mine" combines: only the user's changed
 *   fields over the current record, item by item in lists, never a
 *   server-owned part, and a refusal when both changed one fact; and the
 *   rules each reviewed record kind declares.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/recordMerge.ts, src/domain/keepMineRules.ts,
 *   src/domain/airworthiness.ts, src/domain/model.ts,
 *   src/domain/workOrders.ts.
 */
import { expect, it } from "vitest";
import { mergeKeepMine, type MergeRules } from "./recordMerge";
import {
  AD_KEEP_MINE,
  COMPONENT_KEEP_MINE,
  INSPECTION_KEEP_MINE,
  PO_KEEP_MINE,
  WORK_ORDER_KEEP_MINE,
  workOrderEdit,
  type WorkOrderEdit,
} from "./keepMineRules";
import { blankAD, blankADTask, type AD } from "./airworthiness";
import type { Inspection } from "./model";
import type { WorkOrder } from "./workOrders";
import type { Component } from "./management";
import type { PODraft } from "./purchaseOrders";

interface Line {
  uuid: string;
  part: string;
  quantity: number;
  note?: string;
}
interface Order {
  uuid: string;
  version: number;
  updatedAt?: number;
  vendor: string;
  notes: string;
  address?: { city: string; zip: string };
  lines: Line[];
  receipts?: string[];
  number?: string;
}

const base: Order = {
  uuid: "o1",
  version: 1,
  vendor: "Acme",
  notes: "",
  address: { city: "Tulsa", zip: "74101" },
  lines: [
    { uuid: "l1", part: "MS-1", quantity: 1 },
    { uuid: "l2", part: "MS-2", quantity: 2 },
  ],
};
const edit = (change: (o: Order) => void) => {
  const copy = structuredClone(base);
  change(copy);
  return copy;
};
const outcome = (merge: ReturnType<typeof mergeKeepMine<Order>>) =>
  Object.fromEntries(
    merge.fields.map((f) => [f.key, `${f.changedBy}:${f.keeps}`]),
  );

it("saves only the fields the user changed on top of the current record", () => {
  const mine = edit((o) => {
    o.notes = "Call before delivery";
    o.lines[0].quantity = 5;
  });
  const theirs = edit((o) => {
    o.vendor = "Bolt Supply";
    o.address!.zip = "74103";
    o.lines[1].note = "Backordered";
    o.version = 2;
    o.updatedAt = 99;
  });
  const merge = mergeKeepMine({ base, mine, theirs });
  expect(merge.blocked).toEqual([]);
  expect(merge.merged).toEqual({
    uuid: "o1",
    version: 2,
    vendor: "Bolt Supply",
    notes: "Call before delivery",
    address: { city: "Tulsa", zip: "74103" },
    lines: [
      { uuid: "l1", part: "MS-1", quantity: 5 },
      { uuid: "l2", part: "MS-2", quantity: 2, note: "Backordered" },
    ],
  });
  expect(outcome(merge)).toEqual({
    vendor: "them:theirs",
    notes: "you:mine",
    "address.zip": "them:theirs",
    "lines.l1.quantity": "you:mine",
    "lines.l2.note": "them:theirs",
  });
});

it("names nested fields and list items in words and shows both values", () => {
  const mine = edit((o) => (o.lines[0].quantity = 5));
  const theirs = edit((o) => (o.address!.zip = "74103"));
  const merge = mergeKeepMine(
    { base, mine, theirs },
    {
      specs: {
        address: { label: "Ship to", fields: { zip: "ZIP code" } },
        lines: {
          label: "Lines",
          item: (l, i) => `Line ${i + 1} (${l.part})`,
          fields: { quantity: "Quantity" },
        },
      },
    },
  );
  expect(merge.fields).toEqual([
    {
      key: "address.zip",
      label: "Ship to · ZIP code",
      mine: "74101",
      theirs: "74103",
      changedBy: "them",
      keeps: "theirs",
    },
    {
      key: "lines.l1.quantity",
      label: "Line 1 (MS-1) · Quantity",
      mine: "5",
      theirs: "1",
      changedBy: "you",
      keeps: "mine",
    },
  ]);
});

it("takes the user's value for a field both changed, and says so", () => {
  const mine = edit((o) => (o.notes = "Mine"));
  const theirs = edit((o) => (o.notes = "Theirs"));
  const merge = mergeKeepMine({ base, mine, theirs });
  expect(merge.merged?.notes).toBe("Mine");
  expect(outcome(merge)).toEqual({ notes: "both:mine" });
  // The same edit made twice is no difference at all.
  expect(mergeKeepMine({ base, mine, theirs: mine }).fields).toEqual([]);
});

it("merges only the fields the draft carries and keeps bookkeeping as stored", () => {
  const { uuid, version, vendor, address } = base;
  const draft = { uuid, version, vendor, notes: "Mine", address } as Order;
  const theirs = { ...base, version: 4, updatedAt: 7, number: "PO-1" };
  const merge = mergeKeepMine({ base, mine: draft, theirs });
  expect(merge.merged).toEqual({
    uuid: "o1",
    version: 4,
    vendor: "Acme",
    notes: "Mine",
    address: { city: "Tulsa", zip: "74101" },
  });
  expect(outcome(merge)).toEqual({ notes: "you:mine" });
});

it("merges lists item by item: additions and removals by either person", () => {
  const mine = edit((o) => {
    o.lines = [o.lines[1], { uuid: "l3", part: "MS-3", quantity: 3 }];
  });
  const theirs = edit((o) => {
    o.lines.push({ uuid: "l4", part: "MS-4", quantity: 4 });
  });
  const merge = mergeKeepMine({ base, mine, theirs });
  expect(merge.merged?.lines.map((l) => l.uuid)).toEqual(["l2", "l4", "l3"]);
  expect(merge.fields.map((f) => [f.key, f.mine, f.theirs, f.keeps])).toEqual([
    ["lines.l1", "Removed", "Unchanged", "mine"],
    ["lines.l4", "—", "Added", "theirs"],
    ["lines.l3", "Added", "—", "mine"],
  ]);
  const removedByThem = mergeKeepMine({
    base,
    mine: base,
    theirs: edit((o) => o.lines.pop()),
  });
  expect(removedByThem.merged?.lines.map((l) => l.uuid)).toEqual(["l1"]);
  expect(outcome(removedByThem)).toEqual({ "lines.l2": "them:theirs" });
});

it("refuses when one person removed a list item the other changed", () => {
  const removed = edit((o) => o.lines.shift());
  const changed = edit((o) => (o.lines[0].quantity = 9));
  for (const [mine, theirs] of [
    [removed, changed],
    [changed, removed],
  ]) {
    const merge = mergeKeepMine({ base, mine, theirs });
    expect(merge.merged).toBeUndefined();
    expect(merge.blocked).toEqual([
      "Lines 1: one of you removed it and the other changed it.",
    ]);
    expect(outcome(merge)).toEqual({ "lines.l1": "both:neither" });
  }
});

it("never takes a server-owned field from the draft", () => {
  const rules: MergeRules<Order> = { serverOwned: ["receipts"] };
  const mine = edit((o) => {
    o.receipts = ["forged"];
    o.notes = "Mine";
  });
  const unchanged = mergeKeepMine({ base, mine, theirs: base }, { rules });
  expect(unchanged.merged).toEqual({ ...base, notes: "Mine" });
  expect(outcome(unchanged)).toEqual({ notes: "you:mine" });
  const theirs = edit((o) => (o.receipts = ["R-1"]));
  const appended = mergeKeepMine({ base, mine, theirs }, { rules });
  expect(appended.merged?.receipts).toEqual(["R-1"]);
  expect(outcome(appended)).toEqual({
    notes: "you:mine",
    receipts: "them:theirs",
  });
});

it("refuses when both changed fields of one fact, judged item by item", () => {
  const rules: MergeRules<Order> = {
    together: [
      { what: "the address", fields: ["address"] },
      { what: "this line's order", fields: ["lines.part", "lines.quantity"] },
    ],
  };
  const mine = edit((o) => {
    o.address!.city = "Owasso";
    o.lines[0].quantity = 5;
    o.lines[1].quantity = 6;
  });
  const apart = edit((o) => (o.lines[0].note = "Their note"));
  expect(
    mergeKeepMine({ base, mine, theirs: apart }, { rules }).blocked,
  ).toEqual([]);
  const theirs = edit((o) => {
    o.address!.zip = "74055";
    o.lines[0].part = "MS-1A";
  });
  const merge = mergeKeepMine({ base, mine, theirs }, { rules });
  expect(merge.merged).toBeUndefined();
  expect(merge.blocked).toEqual([
    "you both changed the address.",
    "Lines 1: you both changed this line's order.",
  ]);
  expect(outcome(merge)).toEqual({
    "address.city": "you:neither",
    "address.zip": "them:theirs",
    "lines.l1.part": "them:theirs",
    "lines.l1.quantity": "you:neither",
    "lines.l2.quantity": "you:mine",
  });
});

const TASK = "11111111-1111-4111-8111-111111111111";
function trackedAD(): AD {
  const ad = blankAD("a1");
  ad.version = 1;
  ad.source.number = "2026-01-01";
  ad.source.subject = "Inspect attachment fittings";
  ad.applicability = "Applicable";
  ad.tasks = [
    {
      ...blankADTask(),
      uuid: TASK,
      description: "Inspect fittings",
      recurrence: "Recurring",
      dueHours: 2300,
      intervalHours: 100,
    },
  ];
  return ad;
}
// What recording compliance at 2,340 h stores: the entry and the next due.
function complied(ad: AD): AD {
  const next = structuredClone(ad);
  next.version++;
  next.tasks[0].dueHours = 2440;
  next.history.push({
    uuid: "22222222-2222-4222-8222-222222222222",
    taskUuid: TASK,
    date: "2026-01-02",
    hours: 2340,
    cycles: null,
    method: "Inspected",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "A. Mechanic",
    certificate: "",
    evidence: "",
    recordedAt: 5,
    recordedBy: "u1",
  });
  return next;
}

it("AD: a subject edit keeps the next due and history a compliance set", () => {
  const loaded = trackedAD();
  const mine = structuredClone(loaded);
  mine.source.subject = "Inspect wing attachment fittings";
  const theirs = complied(loaded);
  const merge = mergeKeepMine(
    { base: loaded, mine, theirs },
    { rules: AD_KEEP_MINE },
  );
  expect(merge.blocked).toEqual([]);
  expect(merge.merged?.tasks[0].dueHours).toBe(2440);
  expect(merge.merged?.history).toHaveLength(1);
  expect(merge.merged?.source.subject).toBe("Inspect wing attachment fittings");
  expect(merge.fields.map((f) => [f.key, f.changedBy, f.keeps])).toEqual([
    ["source.subject", "you", "mine"],
    [`tasks.${TASK}.dueHours`, "them", "theirs"],
    ["history", "them", "theirs"],
  ]);
});

it("AD: due limits edited under a compliance on the same action are refused", () => {
  const loaded = trackedAD();
  const mine = structuredClone(loaded);
  mine.tasks[0].intervalHours = 150;
  const merge = mergeKeepMine(
    { base: loaded, mine, theirs: complied(loaded) },
    { rules: AD_KEEP_MINE },
  );
  expect(merge.merged).toBeUndefined();
  expect(merge.blocked).toEqual([
    "Tasks 1: you both changed the due limits or intervals of this action.",
  ]);
  // A forged or stale history in the draft never replaces the stored one.
  mine.tasks[0].intervalHours = 100;
  mine.history = [];
  const forged = mergeKeepMine(
    { base: complied(loaded), mine, theirs: complied(loaded) },
    { rules: AD_KEEP_MINE },
  );
  expect(forged.merged?.history).toHaveLength(1);
});

const inspection: Inspection = {
  uuid: "i1",
  version: 1,
  aircraftUuid: "a1",
  reference: "100-hour",
  description: "Airframe",
  intervalSeconds: 360000,
  lastSeconds: 8280000,
  lastDate: "2026-01-01",
  dueSeconds: 8640000,
};

it("inspection: a due value under an interval is derived, never a difference", () => {
  // The form leaves the due field blank while an interval is set.
  const mine = { ...inspection, description: "Engine", dueSeconds: undefined };
  const theirs = {
    ...inspection,
    version: 2,
    lastSeconds: 8424000,
    dueSeconds: 8784000,
  };
  const merge = mergeKeepMine(
    { base: inspection, mine, theirs },
    { rules: INSPECTION_KEEP_MINE },
  );
  expect(merge.fields.map((f) => [f.key, f.changedBy])).toEqual([
    ["description", "you"],
    ["lastSeconds", "them"],
  ]);
  expect(merge.merged).toMatchObject({
    description: "Engine",
    lastSeconds: 8424000,
    dueSeconds: undefined,
  });
});

it("inspection: a completion recorded under another completion is refused", () => {
  const mine = { ...inspection, lastSeconds: 8460000, lastDate: "2026-01-09" };
  const theirs = { ...inspection, version: 2, lastSeconds: 8424000 };
  const merge = mergeKeepMine(
    { base: inspection, mine, theirs },
    { rules: INSPECTION_KEEP_MINE },
  );
  expect(merge.merged).toBeUndefined();
  expect(merge.blocked).toEqual([
    "you both changed the last compliance or the due limits.",
  ]);
});

const order = {
  uuid: "33333333-3333-4333-8333-333333333333",
  version: 1,
  number: "WO-2026-0001",
  aircraftUuid: "a1",
  dateOpened: "2026-01-01",
  supervisor: "First supervisor",
  scope: "",
  priority: "routine",
  status: "open",
  completionDate: "",
  releaseOutcome: "",
  componentReadings: [{ componentUuid: "c1" }],
  tasks: [
    {
      uuid: TASK,
      source: { kind: "manual", uuid: TASK },
      description: "Inspect cabin fittings",
      status: "requested",
      notes: "",
      partsDelay: "",
    },
  ],
} as unknown as WorkOrder;

it("work order: a supervisor edit keeps a task's progress saved meanwhile", () => {
  const loaded = workOrderEdit(order);
  expect(loaded.componentUuids).toEqual(["c1"]);
  expect(loaded.componentWork).toEqual([]);
  const mine: WorkOrderEdit = { ...loaded, supervisor: "Second supervisor" };
  const theirs = structuredClone(loaded);
  theirs.version = 2;
  theirs.tasks[0].status = "parts-delay";
  theirs.tasks[0].partsDelay = "Awaiting replacement fitting";
  const merge = mergeKeepMine(
    { base: loaded, mine, theirs },
    { rules: WORK_ORDER_KEEP_MINE },
  );
  expect(merge.merged?.supervisor).toBe("Second supervisor");
  expect(merge.merged?.tasks[0]).toMatchObject({
    status: "parts-delay",
    partsDelay: "Awaiting replacement fitting",
  });
  const clash = structuredClone(mine);
  clash.tasks[0].status = "completed";
  expect(
    mergeKeepMine(
      { base: loaded, mine: clash, theirs },
      { rules: WORK_ORDER_KEEP_MINE },
    ).blocked,
  ).toEqual([
    "Tasks 1: you both changed the status or parts delay of this work item.",
  ]);
});

it("component and purchase order: placement and vendor are each one fact", () => {
  const stored = {
    uuid: "c1",
    version: 1,
    notes: "",
    installed: true,
    installPosition: "LEFT",
    timeSinceNew: 100,
  } as unknown as Component;
  const component = mergeKeepMine(
    {
      base: stored,
      mine: { ...stored, installPosition: "RIGHT" },
      theirs: { ...stored, installed: false, removedDate: "2026-01-05" },
    },
    { rules: COMPONENT_KEEP_MINE },
  );
  expect(component.blocked).toEqual([
    "you both changed where the component is installed or stored.",
  ]);
  const draft = {
    uuid: "p1",
    version: 1,
    vendor: "Acme",
    vendorContact: "",
  } as PODraft;
  const po = mergeKeepMine(
    {
      base: draft,
      mine: { ...draft, vendor: "Bolt Supply" },
      theirs: { ...draft, vendorContact: "Dana" },
    },
    { rules: PO_KEEP_MINE },
  );
  expect(po.blocked).toEqual(["you both changed the vendor."]);
});

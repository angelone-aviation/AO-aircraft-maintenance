/**
 * Responsibility: Pins purchase orders: drafting, issuing, shipping,
 *   receiving and cancelling, core returns, every refusal in order, and the
 *   history and change log each change records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/purchaseOrders.ts, ./management, ./components,
 *   ./partsRequests, ./rejection; src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyPOCommand,
  poDraftSchema,
  poStatus,
  onOrder,
  coreReturnRows,
  type POCommand,
  type PODraft,
  type POLine,
  type PurchaseOrder,
} from "./purchaseOrders";
import { applyManagement } from "./management";
import { componentSchema, type Component } from "./components";
import { applyRequestCommand, requestDraftSchema } from "./partsRequests";
import { Rejection, STALE_RECORD_MESSAGE } from "./rejection";
/** A program with a store, one tire in stock and a draft order for 3 tires. */
export function poFixture() {
  const s = demoSnapshot();
  s.user.isAdmin = true;
  applyManagement(s, {
    action: "record.save",
    requestUuid: crypto.randomUUID(),
    reason: "Opening location",
    record: {
      uuid: "store",
      version: 0,
      kind: "location",
      name: "Store",
      address: "",
      contact: "",
    },
  });
  applyManagement(s, {
    action: "record.save",
    requestUuid: crypto.randomUUID(),
    reason: "Opening stock",
    record: {
      uuid: "tire",
      version: 0,
      kind: "stock",
      partNumber: "TIRE",
      description: "Tire",
      category: "part",
      condition: "new",
      locationUuid: "store",
      quantity: 1,
      minimum: 0,
      alternates: "",
    },
  });
  const d = poDraftSchema.parse({
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: "Vendor A",
    vendorContact: "vendor@example.test",
    shipTo: "Main hangar",
    expectedDate: "",
    currency: "USD",
    shippingCents: 1000,
    notes: "",
    lines: [
      {
        uuid: "line",
        stockUuid: "tire",
        locationUuid: "store",
        partNumber: "TIRE",
        description: "Tire",
        quantity: 3,
        unitCents: 25000,
        kind: "part",
      },
    ],
  });
  return { s, d };
}
const request = () => crypto.randomUUID();
const now = Date.parse("2026-10-15T12:00:00Z");
describe("purchase orders", () => {
  it("issues, ships, partially receives, replays safely, and closes without ordering increasing stock", () => {
    const { s, d } = poFixture();
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: request(), drafts: [d] },
      now,
    );
    const run = (kind: "issue" | "close") => {
      [p] = applyPOCommand(
        s,
        {
          kind,
          requestUuid: request(),
          uuid: p.uuid,
          version: p.version,
          reason: "",
        },
        now,
      );
    };
    run("issue");
    expect(onOrder(s, "tire")).toBe(3);
    expect(s.management?.find((r) => r.uuid === "tire")).toMatchObject({
      quantity: 1,
    });
    [p] = applyPOCommand(
      s,
      {
        kind: "ship",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        date: "2026-10-15",
        carrier: "UPS",
        tracking: "123",
        lines: [{ lineUuid: "line", quantity: 3 }],
      },
      now,
    );
    expect(poStatus(p)).toBe("Shipped");
    const receive: POCommand = {
      kind: "receive",
      requestUuid: request(),
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-15",
      invoice: "INV1",
      notes: "",
      lines: [{ lineUuid: "line", quantity: 1, condition: "new", serials: [] }],
    };
    [p] = applyPOCommand(s, receive, now);
    expect(poStatus(p)).toBe("Partially received");
    const audit = s.audit.length;
    applyPOCommand(s, receive, now);
    expect(s.audit).toHaveLength(audit);
    expect(s.management?.find((r) => r.uuid === "tire")).toMatchObject({
      quantity: 2,
    });
    expect(() => run("close")).toThrow("Receive or cancel");
    [p] = applyPOCommand(
      s,
      {
        ...receive,
        requestUuid: request(),
        version: p.version,
        lines: [
          { lineUuid: "line", quantity: 2, condition: "new", serials: [] },
        ],
      },
      now,
    );
    expect(poStatus(p)).toBe("Received");
    run("close");
    expect(poStatus(p)).toBe("Closed");
    expect(onOrder(s, "tire")).toBe(0);
    expect(s.management?.find((r) => r.uuid === "tire")).toMatchObject({
      quantity: 4,
    });
  });
  it("rejects over-receipt, stale updates and unauthorized access without changing inventory", () => {
    const { s, d } = poFixture();
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: request(), drafts: [d] },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    const before = JSON.stringify(s);
    expect(() =>
      applyPOCommand(
        s,
        {
          kind: "receive",
          requestUuid: request(),
          uuid: p.uuid,
          version: p.version,
          date: "2026-10-15",
          invoice: "",
          notes: "",
          lines: [
            { lineUuid: "line", quantity: 4, condition: "new", serials: [] },
          ],
        },
        now,
      ),
    ).toThrow("outstanding");
    expect(JSON.stringify(s)).toBe(before);
    expect(() =>
      applyPOCommand(
        s,
        {
          kind: "cancel",
          requestUuid: request(),
          uuid: p.uuid,
          version: 0,
          reason: "cancel",
        },
        now,
      ),
    ).toThrow("changed");
    s.user.isAdmin = false;
    s.groups = [];
    expect(() =>
      applyPOCommand(
        s,
        { kind: "save", requestUuid: request(), drafts: [d] },
        now,
      ),
    ).toThrow("administrator");
  });
  it("creates distinct vendor orders and rejects cross-program stock", () => {
    const { s, d } = poFixture();
    const results = applyPOCommand(
      s,
      {
        kind: "save",
        requestUuid: request(),
        drafts: [d, { ...d, uuid: request(), vendor: "Vendor B" }],
      },
      now,
    );
    expect(results.map((p) => p.number)).toEqual(["PO-00001", "PO-00002"]);
    expect(results.map((p) => p.vendor)).toEqual(["Vendor A", "Vendor B"]);
    const location = s.management!.find((r) => r.uuid === "store")!;
    location.programUuid = "other";
    expect(() =>
      applyPOCommand(
        s,
        {
          kind: "save",
          requestUuid: request(),
          drafts: [{ ...d, uuid: request() }],
        },
        now,
      ),
    ).toThrow("location");
  });
  it("receives serialized components into inventory and rejects duplicate serials atomically", () => {
    const { s, d } = poFixture();
    d.lines[0] = {
      ...d.lines[0],
      kind: "component",
      stockUuid: "",
      quantity: 2,
    };
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: request(), drafts: [d] },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    const command: POCommand = {
      kind: "receive",
      requestUuid: request(),
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-15",
      invoice: "I",
      notes: "",
      lines: [
        {
          lineUuid: "line",
          quantity: 2,
          condition: "overhauled",
          serials: [
            { serial: "S1", hours: 12, cycles: 4 },
            { serial: "S1", hours: 12, cycles: 4 },
          ],
        },
      ],
    };
    expect(() => applyPOCommand(s, command, now)).toThrow("already exist");
    expect(s.management?.filter((r) => r.kind === "component")).toHaveLength(0);
    command.lines[0].serials[1].serial = "S2";
    [p] = applyPOCommand(s, command, now);
    expect(p.receipts[0].lines[0].itemUuids).toHaveLength(2);
    expect(s.management?.filter((r) => r.kind === "component")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serial: "S1",
          installed: false,
          locationUuid: "store",
          timeSinceNew: 43200,
        }),
      ]),
    );
  });
  it("cancels remaining quantities while retaining receipts and revision history", () => {
    const { s, d } = poFixture();
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: request(), drafts: [d] },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "revise",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "Vendor quote changed",
      },
      now,
    );
    expect(p.revision).toBe(2);
    expect(p.phase).toBe("draft");
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "receive",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        date: "2026-10-15",
        invoice: "",
        notes: "",
        lines: [
          { lineUuid: "line", quantity: 1, condition: "new", serials: [] },
        ],
      },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "cancel",
        requestUuid: request(),
        uuid: p.uuid,
        version: p.version,
        reason: "Balance unavailable",
      },
      now,
    );
    expect(p.lines[0].cancelled).toBe(2);
    expect(p.phase).toBe("closed");
    expect(p.receipts).toHaveLength(1);
  });
});

function issuedExchange(coreDueDays?: number) {
  const { s, d } = poFixture();
  d.lines[0] = { ...d.lines[0], exchange: true, coreDueDays };
  // Ordered before the receipts these tests date from 1 October.
  const orderedAt = Date.parse("2026-09-30T12:00:00Z");
  let [p] = applyPOCommand(
    s,
    { kind: "save", requestUuid: "save", drafts: [d] },
    orderedAt,
  );
  [p] = applyPOCommand(
    s,
    {
      kind: "issue",
      requestUuid: "issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    },
    orderedAt,
  );
  const run = (c: POCommand) => ([p] = applyPOCommand(s, c, now));
  const receive = (quantity: number, date = "2026-10-15") =>
    run({
      kind: "receive",
      requestUuid: crypto.randomUUID(),
      uuid: p.uuid,
      version: p.version,
      date,
      invoice: "INV",
      notes: "",
      lines: [{ lineUuid: "line", quantity, condition: "new", serials: [] }],
    });
  const core = (
    status: "shipped" | "credited",
    date: string,
    tracking = "",
    coreUuid = p.coreReturns![0].uuid,
  ): POCommand => ({
    kind: "core",
    requestUuid: crypto.randomUUID(),
    uuid: p.uuid,
    version: p.version,
    coreUuid,
    status,
    date,
    tracking,
    notes: "",
  });
  return { s, run, receive, core, po: () => p as PurchaseOrder };
}
describe("core returns", () => {
  it("creates a pending core on each exchange receipt due 30 days later by default", () => {
    const { receive, po } = issuedExchange();
    receive(1, "2026-10-01");
    receive(2, "2026-10-10");
    expect(po().coreReturns).toEqual([
      expect.objectContaining({
        partNumber: "TIRE",
        quantity: 1,
        dueDate: "2026-10-31",
        status: "pending",
      }),
      expect.objectContaining({ quantity: 2, dueDate: "2026-11-09" }),
    ]);
    const rows = coreReturnRows([po()], "2026-11-01");
    expect(rows.map((r) => [r.vendor, r.poNumber, r.overdue])).toEqual([
      ["Vendor A", po().number, true],
      ["Vendor A", po().number, false],
    ]);
  });
  it("uses the line's core due period and ignores non-exchange lines", () => {
    const custom = issuedExchange(10);
    custom.receive(1, "2026-10-01");
    expect(custom.po().coreReturns![0].dueDate).toBe("2026-10-11");
    const { s, d } = poFixture();
    let [p] = applyPOCommand(
      s,
      { kind: "save", requestUuid: "s", drafts: [d] },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "issue",
        requestUuid: "i",
        uuid: p.uuid,
        version: p.version,
        reason: "",
      },
      now,
    );
    [p] = applyPOCommand(
      s,
      {
        kind: "receive",
        requestUuid: "r",
        uuid: p.uuid,
        version: p.version,
        date: "2026-10-15",
        invoice: "",
        notes: "",
        lines: [
          { lineUuid: "line", quantity: 1, condition: "new", serials: [] },
        ],
      },
      now,
    );
    expect(p.coreReturns ?? []).toEqual([]);
  });
  it("moves pending → shipped (with tracking) → credited and rejects other transitions", () => {
    const { run, receive, core, po } = issuedExchange();
    receive(3);
    expect(() => run(core("credited", "2026-10-15"))).toThrow(
      "Ship the core before",
    );
    expect(() => run(core("shipped", "2026-10-15"))).toThrow("tracking");
    expect(() => run(core("shipped", "2026-10-30", "1Z"))).toThrow("future");
    expect(() => run(core("shipped", "2026-10-15", "1Z", "missing"))).toThrow(
      "Core return not found",
    );
    run(core("shipped", "2026-10-14", "1Z999"));
    expect(po().coreReturns![0]).toMatchObject({
      status: "shipped",
      tracking: "1Z999",
      shippedDate: "2026-10-14",
    });
    expect(() => run(core("shipped", "2026-10-15", "1Z"))).toThrow(
      "Only pending",
    );
    expect(() => run(core("credited", "2026-10-13"))).toThrow("precede");
    run(core("credited", "2026-10-15"));
    expect(po().coreReturns![0]).toMatchObject({
      status: "credited",
      creditedDate: "2026-10-15",
    });
    expect(() => run(core("credited", "2026-10-15"))).toThrow();
  });
  it("is admin-only and isolated to the PO's Flight Program", () => {
    const { s, run, receive, core } = issuedExchange();
    receive(1);
    const shipped = core("shipped", "2026-10-15", "1Z");
    s.user.isAdmin = false;
    expect(() => run(shipped)).toThrow("administrator");
    s.user.isAdmin = true;
    s.programs = [
      ...(s.programs ?? []),
      { ...s.programs![0], uuid: "other-program", name: "Other" },
    ];
    s.activeProgramUuid = s.user.activeProgramUuid = "other-program";
    expect(() => run(shipped)).toThrow("Purchase order not found");
  });
  it("rejects exchange on repair-return lines", () => {
    const { s, d } = poFixture();
    d.lines[0] = { ...d.lines[0], exchange: true, repairComponentUuid: "c" };
    expect(() =>
      applyPOCommand(s, { kind: "save", requestUuid: "x", drafts: [d] }, now),
    ).toThrow("Repair returns cannot be exchange lines");
  });
});

const pump = () =>
  componentSchema.parse({
    uuid: "pump",
    version: 1,
    programUuid: "demo-program",
    kind: "component",
    aircraftUuid: "",
    componentType: "Appliance",
    partNumber: "PUMP",
    serial: "SN1",
    manufacturer: "Maker",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: false,
    locationUuid: "store",
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 360000,
    timeSinceOverhaul: 180000,
    timeSinceRepair: 36000,
    cyclesSinceNew: 100,
    serviceDaysBase: 0,
  });

/**
 * The fixture with a parts request for 5 tires, a pump in inventory with a
 * repair request, and three orders: a draft, an issued order for 3 tires and
 * an issued repair order for the pump.
 */
function world() {
  const { s, d } = poFixture();
  const run = (c: POCommand) => applyPOCommand(s, c, now)[0];
  const requestDraft = requestDraftSchema.parse({
    uuid: "request",
    version: 0,
    source: { kind: "stock" },
    mode: "parts",
    date: "2026-10-15",
    engineer: "Engineer",
    priority: "P2 Routine",
    requiredBy: "",
    vendor: "Vendor A",
    currency: "USD",
    shipTo: "Main hangar",
    lines: [
      { uuid: "item", partNumber: "TIRE", description: "Tire", quantity: 5 },
    ],
  });
  applyRequestCommand(
    s,
    { kind: "save", requestUuid: "create-request", draft: requestDraft },
    now,
  );
  s.management!.push(pump());
  applyRequestCommand(
    s,
    {
      kind: "save",
      requestUuid: "create-repair",
      draft: {
        ...requestDraft,
        uuid: "repair",
        mode: "repair",
        lines: [
          {
            ...requestDraft.lines[0],
            uuid: "fix",
            partNumber: "PUMP",
            description: "Pump",
            quantity: 1,
            componentUuid: "pump",
            defect: "Leak",
            workRequested: "Repair leak",
          },
        ],
      },
    },
    now,
  );
  const draft = run({
    kind: "save",
    requestUuid: "save-draft",
    drafts: [{ ...d, uuid: "draft" }],
  });
  const issue = (p: PurchaseOrder) =>
    run({
      kind: "issue",
      requestUuid: `issue-${p.uuid}`,
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
  const issued = issue(
    run({
      kind: "save",
      requestUuid: "save-issued",
      drafts: [{ ...d, uuid: "issued" }],
    }),
  );
  const repairLine: POLine = {
    ...d.lines[0],
    uuid: "repair-line",
    stockUuid: "",
    partNumber: "PUMP",
    description: "Pump repair",
    quantity: 1,
    kind: "component",
    repairComponentUuid: "pump",
    repairWork: "repair",
    requestAllocations: [
      { requestUuid: "repair", lineUuid: "fix", quantity: 1 },
    ],
  };
  const repair = issue(
    run({
      kind: "save",
      requestUuid: "save-repair",
      drafts: [{ ...d, uuid: "repair-po", lines: [repairLine] }],
    }),
  );
  return { s, d, run, draft, issued, repair, repairLine };
}
type World = ReturnType<typeof world>;
type SaveCommand = Extract<POCommand, { kind: "save" }>;

const act = (
  p: PurchaseOrder,
  kind: "issue" | "revise" | "close" | "cancel",
  reason = "Reason",
): POCommand => ({
  kind,
  requestUuid: request(),
  uuid: p.uuid,
  version: p.version,
  reason,
});
const ship = (p: PurchaseOrder, extra: object = {}): POCommand => ({
  kind: "ship",
  requestUuid: request(),
  uuid: p.uuid,
  version: p.version,
  date: "2026-10-15",
  carrier: "Courier",
  tracking: "T1",
  lines: [{ lineUuid: p.lines[0].uuid, quantity: 1 }],
  ...extra,
});
type ReceiptLine = Extract<POCommand, { kind: "receive" }>["lines"][number];
const receive = (
  p: PurchaseOrder,
  line: Partial<ReceiptLine> = {},
  extra: object = {},
): POCommand => ({
  kind: "receive",
  requestUuid: request(),
  uuid: p.uuid,
  version: p.version,
  date: "2026-10-15",
  invoice: "INV",
  notes: "",
  lines: [
    {
      lineUuid: p.lines[0].uuid,
      quantity: 1,
      condition: "new",
      serials: [],
      ...line,
    },
  ],
  ...extra,
});
const saveDraft = (w: World, draft: Partial<PODraft>): POCommand => ({
  kind: "save",
  requestUuid: request(),
  drafts: [{ ...w.d, uuid: "new-po", ...draft }],
});
const withLine = (w: World, line: Partial<POLine>) =>
  saveDraft(w, { lines: [{ ...w.d.lines[0], ...line }] });
const allocated = (w: World, quantity: number, line: Partial<POLine> = {}) =>
  withLine(w, {
    quantity,
    requestAllocations: [
      { requestUuid: "request", lineUuid: "item", quantity },
    ],
    ...line,
  });
const shippedRepair = (w: World) => w.run(ship(w.repair));
const allocatedOrder = (w: World, quantity = 2) => {
  const [p] = applyPOCommand(w.s, allocated(w, quantity), now);
  return w.run(act(p, "issue", ""));
};
const exchangeCore = (w: World) => {
  const [p] = applyPOCommand(
    w.s,
    withLine(w, { uuid: "x", exchange: true }),
    now,
  );
  const issued = w.run(act(p, "issue", ""));
  return w.run(receive(issued));
};
const core = (
  p: PurchaseOrder,
  status: "shipped" | "credited",
  extra: object = {},
): POCommand => ({
  kind: "core",
  requestUuid: request(),
  uuid: p.uuid,
  version: p.version,
  coreUuid: p.coreReturns![0].uuid,
  status,
  date: "2026-10-15",
  tracking: "1Z",
  notes: "",
  ...extra,
});

// Each refusal, triggered alone; applyPOCommand checks them in this order.
const refusals: [string, (w: World) => POCommand][] = [
  [
    "Inventory administrator access is required for purchase orders.",
    (w) => {
      w.s.user.isAdmin = false;
      w.s.groups = [];
      return act(w.issued, "close");
    },
  ],
  [
    "Request identifier already used.",
    (w) => ({ ...act(w.issued, "close"), requestUuid: "save-draft" }),
  ],
  [
    "Duplicate lines are not allowed.",
    (w) => ({
      kind: "save",
      requestUuid: request(),
      drafts: [w.d, w.d],
    }),
  ],
  [
    "Only draft purchase orders in this program can be edited.",
    (w) => saveDraft(w, { uuid: "issued", version: w.issued.version }),
  ],
  [STALE_RECORD_MESSAGE, (w) => saveDraft(w, { uuid: "draft", version: 0 })],
  [
    "Draft lines cannot contain cancelled quantities.",
    (w) => withLine(w, { cancelled: 1 }),
  ],
  [
    "Choose a vendor in this Flight Program.",
    (w) => saveDraft(w, { vendorUuid: "missing" }),
  ],
  [
    "Order total exceeds the supported amount.",
    (w) => withLine(w, { quantity: 1000000, unitCents: 100000000000 }),
  ],
  [
    "Duplicate lines are not allowed.",
    (w) => saveDraft(w, { lines: [w.d.lines[0], w.d.lines[0]] }),
  ],
  [
    "PO-00004, line TIRE: Choose a delivery inventory location in this Flight Program.",
    (w) => withLine(w, { locationUuid: "nowhere" }),
  ],
  [
    "PO-00004, line OTHER: Selected stock must match the part, category and location.",
    (w) => withLine(w, { partNumber: "OTHER" }),
  ],
  [
    "PO-00004, line TIRE: Aircraft is outside this Flight Program.",
    (w) => withLine(w, { aircraftUuid: "nowhere" }),
  ],
  [
    "PO-00004, line TIRE: Inspection does not match the aircraft.",
    (w) => withLine(w, { inspectionUuid: "nowhere" }),
  ],
  [
    "PO-00004, line TIRE: Work order does not match the aircraft.",
    (w) => withLine(w, { workOrderUuid: "nowhere" }),
  ],
  [
    "Purchase order not found.",
    (w) => ({ ...act(w.issued, "close"), uuid: "missing" }),
  ],
  [STALE_RECORD_MESSAGE, (w) => ({ ...act(w.issued, "close"), version: 0 })],
  ["Only drafts can be issued.", (w) => act(w.issued, "issue")],
  [
    "Only unshipped, unreceived orders can return to draft for revision.",
    (w) => act(w.draft, "revise"),
  ],
  ["Enter the revision reason.", (w) => act(w.issued, "revise", "")],
  [
    "Receive or cancel all outstanding quantities before closing.",
    (w) => act(w.issued, "close"),
  ],
  [
    "Receive all components back from repair before cancelling the order.",
    (w) => act(shippedRepair(w), "cancel"),
  ],
  [
    "Order is already closed or cancelled.",
    (w) => act(w.run(act(w.draft, "cancel")), "cancel"),
  ],
  ["Enter a cancellation reason.", (w) => act(w.issued, "cancel", "")],
  [
    "Core return not found.",
    (w) => core(exchangeCore(w), "shipped", { coreUuid: "missing" }),
  ],
  [
    "Core shipment and credit dates cannot be in the future.",
    (w) => core(exchangeCore(w), "shipped", { date: "2026-10-30" }),
  ],
  [
    "Only pending cores can be marked shipped.",
    (w) => {
      const p = w.run(core(exchangeCore(w), "shipped"));
      return core(p, "shipped");
    },
  ],
  [
    "Enter the core shipment tracking number.",
    (w) => core(exchangeCore(w), "shipped", { tracking: "" }),
  ],
  [
    "Ship the core before marking it credited.",
    (w) => core(exchangeCore(w), "credited"),
  ],
  [
    "Credit date cannot precede the core shipment.",
    (w) => {
      const p = w.run(core(exchangeCore(w), "shipped"));
      return core(p, "credited", { date: "2026-10-14" });
    },
  ],
  ["Issue the order before shipping or receiving.", (w) => ship(w.draft)],
  [
    "Shipment and receipt dates cannot be in the future.",
    (w) => ship(w.issued, { date: "2026-10-30" }),
  ],
  [
    "Receipt date cannot precede the order date.",
    (w) => receive(w.issued, {}, { date: "2026-10-14" }),
  ],
  [
    "Duplicate lines are not allowed.",
    (w) =>
      ship(w.issued, {
        lines: [
          { lineUuid: "line", quantity: 1 },
          { lineUuid: "line", quantity: 1 },
        ],
      }),
  ],
  [
    "PO line not found.",
    (w) => ship(w.issued, { lines: [{ lineUuid: "missing", quantity: 1 }] }),
  ],
  [
    "Quantity exceeds the outstanding balance.",
    (w) => ship(w.issued, { lines: [{ lineUuid: "line", quantity: 4 }] }),
  ],
  [
    "Repair component must be in inventory and available before shipment.",
    (w) => {
      const c = w.s.management!.find((r) => r.uuid === "pump") as Component;
      c.installed = true;
      return ship(w.repair);
    },
  ],
  [
    "Repair shipment date cannot precede the request date.",
    (w) => ship(w.repair, { date: "2026-10-14" }),
  ],
  [
    "Receive the original shipped component using its existing serial number.",
    (w) =>
      receive(w.repair, {
        serials: [{ serial: "SN1", hours: 101, cycles: 101 }],
      }),
  ],
  [
    "Verified total time and cycles cannot decrease on a repair return.",
    (w) =>
      receive(shippedRepair(w), {
        serials: [{ serial: "SN1", hours: 99, cycles: 101 }],
      }),
  ],
  [
    "Return date cannot precede repair shipment.",
    (w) =>
      receive(
        w.run(ship(w.repair, { date: "2026-10-16" })),
        { serials: [{ serial: "SN1", hours: 101, cycles: 101 }] },
        { date: "2026-10-15" },
      ),
  ],
  [
    "Enter one serial number and verified time/cycles for each component received.",
    (w) => {
      const [p] = applyPOCommand(
        w.s,
        withLine(w, { kind: "component", stockUuid: "" }),
        now,
      );
      return receive(w.run(act(p, "issue", "")));
    },
  ],
  [
    "Serial numbers are only for trackable components.",
    (w) =>
      receive(w.issued, { serials: [{ serial: "S", hours: 1, cycles: 1 }] }),
  ],
  [
    "Requested parts must be received in serviceable condition before being reserved.",
    (w) => receive(allocatedOrder(w), { condition: "core" }),
  ],
  [
    "Receiving allocation is unavailable.",
    (w) => {
      const p = allocatedOrder(w);
      w.s.partsRequests = w.s.partsRequests!.filter(
        (r) => r.uuid !== "request",
      );
      return receive(p);
    },
  ],
  [
    "PO-00004, line TIRE: Request allocations exceed PO quantity.",
    (w) =>
      withLine(w, {
        quantity: 1,
        requestAllocations: [
          { requestUuid: "request", lineUuid: "item", quantity: 2 },
        ],
      }),
  ],
  [
    "PO-00004, line PUMP: Component already has an outstanding repair PO.",
    (w) => saveDraft(w, { lines: [w.repairLine] }),
  ],
  [
    "PO-00004, line PUMP: The repair component is no longer in inventory under this part number. Update its repair request and this line.",
    (w) =>
      saveDraft(w, {
        lines: [{ ...w.repairLine, repairComponentUuid: "missing" }],
      }),
  ],
  [
    "PO-00004, line PUMP: Repair PO lines must reference one existing component and its repair request.",
    (w) => {
      w.run(act(w.repair, "cancel"));
      return saveDraft(w, { lines: [{ ...w.repairLine, quantity: 2 }] });
    },
  ],
  [
    "PO-00004, line TIRE: PO allocation does not match the parts request.",
    (w) => allocated(w, 1, { aircraftUuid: w.s.aircraft[0].uuid }),
  ],
  [
    "PO-00004, line TIRE: Use stock parts for parts requests; use a repair request for an existing serialized component.",
    (w) => allocated(w, 1, { kind: "component", stockUuid: "" }),
  ],
  [
    "PO-00004, line TIRE: Request vendor, currency and ship-to must match the PO.",
    (w) => ({
      kind: "save",
      requestUuid: request(),
      drafts: [
        {
          ...(allocated(w, 1) as Extract<POCommand, { kind: "save" }>)
            .drafts[0],
          currency: "EUR",
        },
      ],
    }),
  ],
  [
    "PO-00004, line PUMP: Repair allocation does not match the original component and work requested.",
    (w) =>
      allocated(w, 1, {
        requestAllocations: [
          { requestUuid: "repair", lineUuid: "fix", quantity: 1 },
        ],
        partNumber: "PUMP",
        stockUuid: "",
      }),
  ],
  [
    "PO-00004, line TIRE: PO quantity exceeds the uncommitted request balance.",
    (w) => allocated(w, 6, { quantity: 6 }),
  ],
];

describe("purchase order refusals", () => {
  it.each(refusals)("refuses: %s", (message, build) => {
    const w = world();
    const command = build(w);
    const before = JSON.stringify(w.s);
    let error: unknown;
    try {
      applyPOCommand(w.s, command, now);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Rejection);
    expect((error as Error).message).toBe(message);
    expect(JSON.stringify(w.s)).toBe(before);
  });
});

describe("purchase order results", () => {
  it("numbers new orders and records each change in history and the change log", () => {
    const w = world();
    const command = saveDraft(w, {});
    const [p] = applyPOCommand(w.s, command, now);
    expect(p).toMatchObject({
      number: "PO-00004",
      phase: "draft",
      version: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(p.history).toEqual([
      {
        at: now,
        actorId: w.s.user.id,
        action: "Draft saved",
        reason: "",
        requestUuid: command.requestUuid,
        detail: JSON.stringify(command),
      },
    ]);
    const closed = w.run(act(w.run(act(p, "issue", "")), "cancel", "Gone"));
    expect(closed.history.at(-1)).toMatchObject({
      action: "cancel",
      reason: "Gone",
    });
    expect(w.s.audit[0]).toEqual({
      uuid: `${closed.history.at(-1)!.requestUuid}-new-po`,
      programUuid: "demo-program",
      at: now,
      actorId: w.s.user.id,
      action: "po.cancel",
      entityUuid: "new-po",
      after: JSON.stringify(closed),
    });
  });
  it("shows an order's phase, then its shipping and receiving progress", () => {
    const w = world();
    expect([poStatus(w.draft), poStatus(w.issued)]).toEqual([
      "Draft",
      "Issued",
    ]);
    const partly = w.run(ship(w.issued));
    expect(poStatus(partly)).toBe("Partially shipped");
    const cancelled = w.run(act(w.draft, "cancel"));
    expect(poStatus(cancelled)).toBe("Cancelled");
  });
  it("accepts a receipt dated the order's day in any time zone (PT-6)", () => {
    const w = world();
    // 02:00 UTC on 15 Oct was still 14 Oct in the furthest-behind zone.
    const issuedAt = Date.parse("2026-10-15T02:00:00Z");
    const [p] = applyPOCommand(w.s, act(w.draft, "issue", ""), issuedAt);
    expect(() => w.run(receive(p, {}, { date: "2026-10-13" }))).toThrow(
      new Rejection("Receipt date cannot precede the order date."),
    );
    expect(w.run(receive(p, {}, { date: "2026-10-14" })).receipts).toHaveLength(
      1,
    );
  });
  it("dates an order stored without an issue time from when it was made", () => {
    const w = world();
    const stored = w.s.purchaseOrders!.find((p) => p.uuid === "issued")!;
    delete stored.issuedAt;
    stored.createdAt = Date.parse("2026-10-01T12:00:00Z");
    expect(
      w.run(receive(stored, {}, { date: "2026-10-02" })).receipts,
    ).toHaveLength(1);
  });
  it("receives another condition into a new stock lot priced from the line", () => {
    const w = world();
    const p = w.run(receive(w.issued, { condition: "overhauled" }));
    const lot = w.s.management!.find(
      (r) => r.uuid === p.receipts[0].lines[0].itemUuids[0],
    );
    expect(lot).toMatchObject({
      kind: "stock",
      condition: "overhauled",
      quantity: 1,
      poRef: p.number,
      invoiceNumber: "INV",
      cost: 250,
    });
    expect(w.s.management!.find((r) => r.uuid === "tire")).toMatchObject({
      quantity: 1,
    });
    expect(p.lines[0].stockUuid).toBe("tire");
  });
});

const correct = (w: World, uuid: string, change: object) => {
  const record = w.s.management!.find((r) => r.uuid === uuid)!;
  applyManagement(
    w.s,
    {
      action: "record.save",
      requestUuid: request(),
      reason: "Correction",
      record: { ...record, ...change } as typeof record,
    },
    now,
  );
};

describe("orders keep the references they were issued with", () => {
  it("receives into the ordered lot after its part number and category are corrected", () => {
    const w = world();
    const shipped = w.run(ship(w.issued));
    correct(w, "tire", { partNumber: "TIRE-600", category: "supply" });
    const p = w.run(receive(shipped));
    expect(p.lines[0].partNumber).toBe("TIRE");
    expect(p.receipts[0].lines[0].itemUuids).toEqual(["tire"]);
    expect(w.s.management!.find((r) => r.uuid === "tire")).toMatchObject({
      partNumber: "TIRE-600",
      quantity: 2,
    });
    expect(
      w.s.audit.find((a) => a.action === "stock.move.receive"),
    ).toMatchObject({
      reason: "Receipt PO-00002 (ordered as TIRE); invoice INV",
    });
  });
  it("ships and receives a line whose aircraft has left the Flight Program", () => {
    const w = world();
    const aircraftUuid = w.s.aircraft[0].uuid;
    const [saved] = applyPOCommand(w.s, withLine(w, { aircraftUuid }), now);
    const issued = w.run(act(saved, "issue", ""));
    w.s.aircraft[0].programUuid = "other-program";
    const p = w.run(receive(w.run(ship(issued))));
    expect(p.receipts).toHaveLength(1);
  });
  it("leaves other orders alone when a component on a repair order is corrected", () => {
    const w = world();
    correct(w, "pump", { partNumber: "PUMP-2" });
    expect(w.run(saveDraft(w, {})).number).toBe("PO-00004");
    expect(w.run(ship(w.issued)).shipments).toHaveLength(1);
    const shipped = w.run(ship(w.repair));
    expect(shipped.lines[0].partNumber).toBe("PUMP");
    const back = w.run(
      receive(shipped, {
        serials: [{ serial: "SN1", hours: 101, cycles: 101 }],
      }),
    );
    expect(poStatus(back)).toBe("Received");
  });
  it("refuses to issue a draft whose repair component changed, naming the order and line", () => {
    const w = world();
    const draft = w.run(act(w.repair, "revise"));
    correct(w, "pump", { partNumber: "PUMP-2" });
    expect(() => w.run(act(draft, "issue", ""))).toThrow(
      "PO-00003, line PUMP: The repair component is no longer in inventory under this part number. Update its repair request and this line.",
    );
    expect(w.run(act(draft, "cancel")).phase).toBe("cancelled");
  });
  it("refuses to ship a repair component that was attached to an assembly", () => {
    const w = world();
    const c = w.s.management!.find((r) => r.uuid === "pump") as Component;
    c.parentComponentUuid = "engine";
    expect(() => w.run(ship(w.repair))).toThrow(
      "Repair component must be in inventory and available before shipment.",
    );
  });
  it("refuses a receipt whose delivery location has left the Flight Program", () => {
    const w = world();
    w.s.management!.find((r) => r.uuid === "store")!.programUuid = "other";
    expect(() => w.run(receive(w.issued))).toThrow(
      "PO-00002, line TIRE: Choose a delivery inventory location in this Flight Program.",
    );
  });
});

describe("a parts request after its purchase order is cancelled", () => {
  const resave = (w: World, change: object) => {
    const stored = w.s.partsRequests!.find((r) => r.uuid === "request")!;
    return applyRequestCommand(
      w.s,
      {
        kind: "save",
        requestUuid: request(),
        draft: { ...requestDraftSchema.parse(stored), ...change },
      },
      now,
    );
  };
  const LOCKED =
    "Release reservations and remove draft PO allocations before changing lines or purchasing details. Fulfilled lines are retained for traceability.";
  it("can change vendor and lines, and be ordered from the new vendor", () => {
    const w = world();
    const p = allocatedOrder(w);
    expect(() => resave(w, { vendor: "Vendor B" })).toThrow(LOCKED);
    w.run(act(p, "cancel"));
    const saved = resave(w, {
      vendor: "Vendor B",
      lines: [
        { uuid: "item", partNumber: "TIRE", description: "Tire", quantity: 4 },
      ],
    });
    expect(saved).toMatchObject({ vendor: "Vendor B" });
    expect(saved.lines[0].quantity).toBe(4);
    const [reordered] = applyPOCommand(
      w.s,
      {
        kind: "save",
        requestUuid: request(),
        drafts: [
          {
            ...(allocated(w, 4, { quantity: 4 }) as SaveCommand).drafts[0],
            uuid: "reorder",
            vendor: "Vendor B",
          },
        ],
      },
      now,
    );
    expect(reordered).toMatchObject({ vendor: "Vendor B", phase: "draft" });
  });
  it("stays fixed while units received on the order remain allocated to it", () => {
    const w = world();
    const received = w.run(receive(allocatedOrder(w)));
    w.run(act(received, "cancel"));
    expect(() => resave(w, { vendor: "Vendor B" })).toThrow(LOCKED);
  });
});

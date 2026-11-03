import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyPOCommand,
  poDraftSchema,
  poStatus,
  onOrder,
  coreReturnRows,
  type POCommand,
  type PurchaseOrder,
} from "./purchaseOrders";
import { applyManagement } from "./management";
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
  let [p] = applyPOCommand(
    s,
    { kind: "save", requestUuid: "save", drafts: [d] },
    now,
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
    now,
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

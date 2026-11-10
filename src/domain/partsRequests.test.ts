/**
 * Responsibility: Pins parts requests: stock reservations, issues and
 *   cancellation, purchase-order progress, request status, source labels and
 *   every refusal.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/partsRequests.ts, ./purchaseOrders, ./components,
 *   ./airworthiness, ./addresses, ./management, ./programs, ./rejection,
 *   src/data/demo.ts.
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement } from "./management";
import {
  applyRequestCommand,
  requestDraftSchema,
  requestLineProgress,
  requestLineSchema,
  requestPurchases,
  requestStatus,
  resolveRequestSource,
  type PartsRequest,
  type RequestCommand,
  type RequestDraft,
  type RequestSource,
} from "./partsRequests";
import {
  applyPOCommand,
  poDraftSchema,
  type POCommand,
  type PurchaseOrder,
} from "./purchaseOrders";
import {
  componentSchema,
  serviceComponent,
  type Component,
  type ComponentRequirement,
} from "./components";
import { activeProgram, scopedSnapshot } from "./programs";
import { blankAD, blankADTask } from "./airworthiness";
import { addressSchema, formatAddress } from "./addresses";
import { Rejection } from "./rejection";
const now = Date.parse("2026-10-20T12:00:00Z");
function fixture() {
  const s = demoSnapshot();
  s.user.isAdmin = true;
  s.management = [
    {
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      kind: "location",
      name: "Main store",
      address: "Hangar",
      contact: "",
    },
    {
      uuid: "stock",
      version: 1,
      programUuid: "demo-program",
      kind: "stock",
      partNumber: "TIRE",
      description: "Tire",
      category: "part",
      condition: "new",
      locationUuid: "store",
      quantity: 2,
      minimum: 0,
      alternates: "",
    },
  ];
  const draft = requestDraftSchema.parse({
    uuid: "request",
    version: 0,
    source: { kind: "stock" },
    mode: "parts",
    date: "2026-10-20",
    engineer: "Engineer",
    priority: "P2 Routine",
    requiredBy: "",
    vendor: "Vendor",
    currency: "USD",
    shipTo: "Hangar",
    lines: [
      { uuid: "item", partNumber: "TIRE", description: "Tire", quantity: 5 },
    ],
  });
  const r = applyRequestCommand(
    s,
    { kind: "save", requestUuid: "create", draft },
    now,
  );
  const draftPO = (qty: number, uuid = "po") =>
    poDraftSchema.parse({
      uuid,
      version: 0,
      vendor: "Vendor",
      vendorContact: "",
      currency: "USD",
      shipTo: "Hangar",
      expectedDate: "",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "line",
          stockUuid: "stock",
          locationUuid: "store",
          partNumber: "TIRE",
          description: "Tire",
          quantity: qty,
          unitCents: 100,
          kind: "part",
          requestAllocations: [
            { requestUuid: r.uuid, lineUuid: "item", quantity: qty },
          ],
        },
      ],
    });
  const po = (c: POCommand) => applyPOCommand(s, c, now)[0];
  return { s, draft, r, draftPO, po };
}
describe("shared parts requests", () => {
  it("reserves stock, purchases only the shortage, receives in stages and issues without duplicating stock", () => {
    const { s, draftPO, po } = fixture();
    const action = (kind: "reserve" | "issue", quantity: number) =>
      applyRequestCommand(
        s,
        {
          kind,
          requestUuid: crypto.randomUUID(),
          uuid: "request",
          version: s.partsRequests![0].version,
          lineUuid: "item",
          stockUuid: "stock",
          quantity,
          alternateConfirmed: false,
        },
        now,
      );
    action("reserve", 2);
    const stock = () =>
      s.management!.find((x) => x.kind === "stock" && x.uuid === "stock")!;
    expect(stock()).toMatchObject({ quantity: 2, reservedQuantity: 2 });
    expect(requestLineProgress(s, s.partsRequests![0], "item").toOrder).toBe(3);
    let p = po({ kind: "save", requestUuid: "po-save", drafts: [draftPO(3)] });
    expect(() =>
      po({
        kind: "save",
        requestUuid: "duplicate",
        drafts: [draftPO(1, "po2")],
      }),
    ).toThrow(/uncommitted/);
    p = po({
      kind: "issue",
      requestUuid: "po-issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
    action("issue", 2);
    const receipt: POCommand = {
      kind: "receive",
      requestUuid: "receipt1",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      invoice: "INV",
      notes: "",
      lines: [{ lineUuid: "line", quantity: 1, condition: "new", serials: [] }],
    };
    p = po(receipt);
    po(receipt);
    expect(stock()).toMatchObject({ quantity: 1, reservedQuantity: 1 });
    expect(requestLineProgress(s, s.partsRequests![0], "item").toOrder).toBe(0);
    p = po({
      ...receipt,
      requestUuid: "receipt2",
      version: p.version,
      lines: [{ lineUuid: "line", quantity: 2, condition: "new", serials: [] }],
    });
    action("issue", 3);
    expect(stock()).toMatchObject({ quantity: 0, reservedQuantity: 0 });
    expect(requestStatus(s, s.partsRequests![0])).toBe("Fulfilled");
    expect(s.partsRequests![0].issues.reduce((n, x) => n + x.quantity, 0)).toBe(
      5,
    );
  });
  it("stores the calendar date an issue was made on, which must be today somewhere", () => {
    const { s } = fixture();
    // 19:00 on 31 December in Chicago, 01:00 on 1 January in UTC.
    const evening = Date.parse("2027-01-01T01:00:00Z");
    const run = (kind: "reserve" | "issue", extra: object = {}) =>
      applyRequestCommand(
        s,
        {
          kind,
          requestUuid: crypto.randomUUID(),
          uuid: "request",
          version: s.partsRequests![0].version,
          lineUuid: "item",
          stockUuid: "stock",
          quantity: 1,
          alternateConfirmed: false,
          ...extra,
        },
        evening,
      );
    run("reserve");
    run("reserve");
    expect(() => run("issue", { date: "2026-12-29" })).toThrow(
      new Rejection("The issue date must be today."),
    );
    const issued = {
      lineUuid: "item",
      stockUuid: "stock",
      quantity: 1,
      at: evening,
      actorId: s.user.id,
    };
    expect(run("issue", { date: "2026-12-31" }).issues).toEqual([
      { ...issued, date: "2026-12-31" },
    ]);
    expect(run("issue").issues[1]).toStrictEqual(issued);
  });
  it("protects reservations from direct stock changes and rejects stale requests atomically", () => {
    const { s, r } = fixture();
    const cmd: RequestCommand = {
      kind: "reserve",
      requestUuid: "reserve",
      uuid: r.uuid,
      version: r.version,
      lineUuid: "item",
      stockUuid: "stock",
      quantity: 2,
      alternateConfirmed: false,
    };
    applyRequestCommand(s, cmd, now);
    applyRequestCommand(s, cmd, now);
    const before = JSON.stringify(s);
    expect(() =>
      applyRequestCommand(s, { ...cmd, requestUuid: "stale" }, now),
    ).toThrow(/changed/);
    const stock = s.management!.find((x) => x.kind === "stock")!;
    expect(() =>
      applyManagement(
        s,
        {
          action: "stock.move",
          requestUuid: crypto.randomUUID(),
          uuid: stock.uuid,
          version: stock.version,
          operation: "issue",
          quantity: 1,
          reason: "Other work",
        },
        now,
      ),
    ).toThrow(/stock/);
    expect(() =>
      applyManagement(
        s,
        {
          action: "record.save",
          requestUuid: crypto.randomUUID(),
          record: { ...stock, reservedQuantity: 0 },
          reason: "Edit",
        },
        now,
      ),
    ).toThrow(/reservations/);
    expect(JSON.stringify(s)).toBe(before);
  });
  it("requires explicit alternate confirmation and releases reservations on cancellation", () => {
    const { s } = fixture();
    s.partsRequests![0].lines[0].alternateNumber = "ALT";
    const stock = s.management!.find((x) => x.kind === "stock")!;
    if (stock.kind === "stock") stock.partNumber = "ALT";
    const command: RequestCommand = {
      kind: "reserve",
      requestUuid: "alt",
      uuid: "request",
      version: 1,
      lineUuid: "item",
      stockUuid: "stock",
      quantity: 1,
      alternateConfirmed: false,
    };
    expect(() => applyRequestCommand(s, command, now)).toThrow(/alternate/);
    applyRequestCommand(s, { ...command, alternateConfirmed: true }, now);
    applyRequestCommand(
      s,
      {
        kind: "cancel",
        requestUuid: "cancel",
        uuid: "request",
        version: 2,
        reason: "No longer needed",
      },
      now,
    );
    expect(s.management!.find((x) => x.kind === "stock")).toMatchObject({
      reservedQuantity: 0,
      quantity: 2,
    });
    expect(requestStatus(s, s.partsRequests![0])).toBe("Cancelled");
  });
  it("records reserve, release, issue and cancel in the stock item's own history (#49)", () => {
    const { s, draftPO, po } = fixture();
    const command = (
      kind: "reserve" | "release" | "issue",
      quantity: number,
    ): RequestCommand => ({
      kind,
      requestUuid: crypto.randomUUID(),
      uuid: "request",
      version: s.partsRequests![0].version,
      lineUuid: "item",
      stockUuid: "stock",
      quantity,
      alternateConfirmed: false,
    });
    const act = (kind: "reserve" | "release" | "issue", quantity: number) =>
      applyRequestCommand(s, command(kind, quantity), now);
    const stockHistory = () =>
      s.audit
        .filter((a) => a.entityUuid === "stock")
        .reverse()
        .map((a) => ({
          action: a.action,
          reason: a.reason,
          before: JSON.parse(a.before!),
          after: JSON.parse(a.after!),
        }));
    const reserve = command("reserve", 2);
    applyRequestCommand(s, reserve, now);
    applyRequestCommand(s, reserve, now); // replay: no second entry
    act("release", 1);
    act("issue", 1);
    expect(stockHistory()).toEqual([
      expect.objectContaining({
        action: "stock.reserve",
        reason: "Reserved 2 for PR-00001",
        before: expect.objectContaining({ quantity: 2, version: 1 }),
        after: expect.objectContaining({
          quantity: 2,
          reservedQuantity: 2,
          version: 2,
        }),
      }),
      expect.objectContaining({
        action: "stock.release",
        reason: "Released 1 from PR-00001",
        before: expect.objectContaining({ reservedQuantity: 2 }),
        after: expect.objectContaining({ quantity: 2, reservedQuantity: 1 }),
      }),
      expect.objectContaining({
        action: "stock.issue",
        reason: "Issued 1 for PR-00001",
        before: expect.objectContaining({ quantity: 2, reservedQuantity: 1 }),
        after: expect.objectContaining({ quantity: 1, reservedQuantity: 0 }),
      }),
    ]);
    // The request keeps its own entries as before.
    expect(
      s.audit.filter((a) => a.entityUuid === "request").map((a) => a.action),
    ).toEqual([
      "partsRequest.issue",
      "partsRequest.release",
      "partsRequest.reserve",
      "partsRequest.save",
    ]);
    expect(
      new Set(
        s.audit
          .filter((a) => ["request", "stock"].includes(a.entityUuid))
          .map((a) => a.programUuid),
      ),
    ).toEqual(new Set([activeProgram(s)]));
    // A PO receipt that reserves for the request is recorded too.
    let p = po({ kind: "save", requestUuid: "po-save", drafts: [draftPO(1)] });
    p = po({
      kind: "issue",
      requestUuid: "po-issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
    po({
      kind: "receive",
      requestUuid: "receipt",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      invoice: "INV",
      notes: "",
      lines: [{ lineUuid: "line", quantity: 1, condition: "new", serials: [] }],
    });
    expect(stockHistory().slice(3)).toEqual([
      expect.objectContaining({ action: "stock.move.receive" }),
      expect.objectContaining({
        action: "stock.reserve",
        reason: `Received and reserved 1 for PR-00001 from ${p.number}`,
        after: expect.objectContaining({ quantity: 2, reservedQuantity: 1 }),
      }),
    ]);
    applyRequestCommand(
      s,
      {
        kind: "cancel",
        requestUuid: "cancel",
        uuid: "request",
        version: s.partsRequests![0].version,
        reason: "No longer needed",
      },
      now,
    );
    expect(stockHistory().at(-1)).toEqual(
      expect.objectContaining({
        action: "stock.release",
        reason:
          "Released 1 from PR-00001: request cancelled (No longer needed)",
        after: expect.objectContaining({ quantity: 2, reservedQuantity: 0 }),
      }),
    );
  });
  it("enforces vendor/ship-to/program matching and scopes request visibility", () => {
    const { s, draftPO, po } = fixture();
    expect(() =>
      po({
        kind: "save",
        requestUuid: "bad-vendor",
        drafts: [{ ...draftPO(1), vendor: "Other" }],
      }),
    ).toThrow(/vendor/);
    expect(() =>
      po({
        kind: "save",
        requestUuid: "bad-address",
        drafts: [{ ...draftPO(1), shipTo: "Elsewhere" }],
      }),
    ).toThrow(/ship-to/);
    s.partsRequests!.push({
      ...s.partsRequests![0],
      uuid: "foreign",
      programUuid: "foreign-program",
    });
    expect(scopedSnapshot(s).partsRequests?.map((r) => r.uuid)).toEqual([
      "request",
    ]);
    expect(() =>
      applyRequestCommand(
        s,
        {
          kind: "cancel",
          requestUuid: "bad-program",
          uuid: "foreign",
          version: 1,
          reason: "test",
        },
        now,
      ),
    ).toThrow(/outside/);
  });
  it("cancels outstanding PO quantities without losing received reservations or receipt history", () => {
    const { s, po, draftPO } = fixture();
    let p = po({ kind: "save", requestUuid: "save", drafts: [draftPO(5)] });
    p = po({
      kind: "issue",
      requestUuid: "issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
    expect(() =>
      applyRequestCommand(
        s,
        {
          kind: "cancel",
          requestUuid: "cancel-request",
          uuid: "request",
          version: 1,
          reason: "No longer needed",
        },
        now,
      ),
    ).toThrow(/outstanding/);
    p = po({
      kind: "receive",
      requestUuid: "receive",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      invoice: "INV",
      notes: "",
      lines: [{ lineUuid: "line", quantity: 2, condition: "new", serials: [] }],
    });
    po({
      kind: "cancel",
      requestUuid: "cancel-po",
      uuid: p.uuid,
      version: p.version,
      reason: "Cancel backorder",
    });
    expect(requestLineProgress(s, s.partsRequests![0], "item")).toMatchObject({
      reserved: 2,
      received: 2,
      toOrder: 3,
    });
    applyRequestCommand(
      s,
      {
        kind: "cancel",
        requestUuid: "cancel-request",
        uuid: "request",
        version: s.partsRequests![0].version,
        reason: "No longer needed",
      },
      now,
    );
    expect(s.purchaseOrders![0].receipts).toHaveLength(1);
    expect(s.management!.find((x) => x.uuid === "stock")).toMatchObject({
      quantity: 4,
      reservedQuantity: 0,
    });
  });
  it("ships and returns the same serialized component, blocking installation and cancellation while away", () => {
    const { s, draft, po } = fixture();
    s.partsRequests = [];
    const component = componentSchema.parse({
      uuid: "component",
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
    // A TSR interval not performed by the repair keeps its remaining time.
    const tsr: ComponentRequirement = {
      kind: "componentRequirement",
      uuid: "tsr-inspection",
      version: 1,
      programUuid: "demo-program",
      aircraftUuid: "",
      componentUuid: component.uuid,
      requirementType: "Inspection Requirement",
      description: "Leak check",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSR",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      intervalSeconds: 50 * 3600,
      dueSeconds: 50 * 3600,
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    };
    s.management!.push(component, tsr);
    applyRequestCommand(
      s,
      {
        kind: "save",
        requestUuid: "repair-request",
        draft: {
          ...draft,
          mode: "repair",
          lines: [
            {
              ...draft.lines[0],
              partNumber: "PUMP",
              description: "Pump",
              quantity: 1,
              componentUuid: component.uuid,
              defect: "Leak",
              workRequested: "Repair leak",
            },
          ],
        },
      },
      now,
    );
    const d = poDraftSchema.parse({
      uuid: "repair-po",
      version: 0,
      vendor: "Vendor",
      vendorContact: "",
      currency: "USD",
      shipTo: "Hangar",
      expectedDate: "",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "line",
          locationUuid: "store",
          partNumber: "PUMP",
          description: "Pump repair",
          quantity: 1,
          unitCents: 1000,
          kind: "component",
          repairComponentUuid: component.uuid,
          repairWork: "repair",
          requestAllocations: [
            { requestUuid: "request", lineUuid: "item", quantity: 1 },
          ],
        },
      ],
    });
    let p = po({ kind: "save", requestUuid: "save", drafts: [d] });
    p = po({
      kind: "issue",
      requestUuid: "issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
    const receive: POCommand = {
      kind: "receive",
      requestUuid: "return",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      invoice: "INV",
      notes: "Repair certificate",
      lines: [
        {
          lineUuid: "line",
          quantity: 1,
          condition: "overhauled",
          serials: [{ serial: "SN1", hours: 101, cycles: 101 }],
        },
      ],
    };
    expect(() => po(receive)).toThrow(/shipped/);
    p = po({
      kind: "ship",
      requestUuid: "ship",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      carrier: "Courier",
      tracking: "TRACK",
      lines: [{ lineUuid: "line", quantity: 1 }],
    });
    expect(requestStatus(s, s.partsRequests![0])).toBe("Out for repair");
    const away = s.management!.find((x) => x.kind === "component")!;
    if (away.kind !== "component") throw Error("component missing");
    expect(() =>
      serviceComponent(
        s,
        away,
        {
          operation: "install",
          date: "2026-10-20",
          aircraftUuid: s.aircraft[0].uuid,
          installPosition: "MAIN",
        },
        now,
      ),
    ).toThrow(/repair/);
    expect(() =>
      po({
        kind: "cancel",
        requestUuid: "cancel",
        uuid: p.uuid,
        version: p.version,
        reason: "Cancel",
      }),
    ).toThrow(/back from repair/);
    po({ ...receive, version: p.version });
    const returned = s.management!.filter((x) => x.kind === "component");
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({
      uuid: component.uuid,
      installed: false,
      serial: "SN1",
      timeSinceNew: 363600,
      timeSinceRepair: 0,
    });
    expect(returned[0]).not.toHaveProperty("outForRepair");
    // TSR was 10 h + 1 h at the shop when reset: 50 h due leaves 39 h.
    expect(
      s.management!.find((x) => x.uuid === "tsr-inspection"),
    ).toMatchObject({
      version: 2,
      timeResetSeconds: 11 * 3600,
      dueSeconds: 39 * 3600,
    });
    expect(requestStatus(s, s.partsRequests![0])).toBe("Fulfilled");
    expect(requestLineProgress(s, s.partsRequests![0], "item").toOrder).toBe(0);
  });
});
describe("request status (#55)", () => {
  type Line = {
    quantity?: number;
    ordered?: number;
    received?: number;
    shipped?: number;
    reserved?: number;
    issued?: number;
  };
  // One request whose lines have the given progress; purchases are supplied
  // as the snapshot's request purchases, as a non-administrator receives them.
  function status(mode: "parts" | "repair", ...lines: Line[]) {
    const { s } = fixture();
    const r = s.partsRequests![0];
    r.mode = mode;
    r.lines = lines.map((l, i) => ({
      ...r.lines[0],
      uuid: `line-${i}`,
      quantity: l.quantity ?? 5,
    }));
    r.reservations = lines.flatMap((l, i) =>
      l.reserved
        ? [{ lineUuid: `line-${i}`, stockUuid: "stock", quantity: l.reserved }]
        : [],
    );
    r.issues = lines.flatMap((l, i) =>
      l.issued
        ? [
            {
              lineUuid: `line-${i}`,
              stockUuid: "stock",
              quantity: l.issued,
              at: now,
              actorId: s.user.id,
            },
          ]
        : [],
    );
    s.purchaseOrders = [];
    s.partsRequestPurchases = lines.flatMap((l, i) =>
      l.ordered
        ? [
            {
              requestUuid: r.uuid,
              lineUuid: `line-${i}`,
              poUuid: "po",
              number: "PO-00001",
              phase: "issued",
              quantity: l.ordered,
              received: l.received ?? 0,
              shipped: l.shipped ?? 0,
              expectedDate: "",
              purchasedDate: "",
              purchasedBy: "",
            },
          ]
        : [],
    );
    return requestStatus(s, r);
  }
  it.each<[string, Line[], string]>([
    ["nothing yet", [{}], "Requested"],
    ["stock reserved", [{ reserved: 2 }], "Reserved"],
    ["shortage on a PO", [{ ordered: 3 }], "On purchase order"],
    [
      "reserved and on a PO",
      [{ reserved: 2, ordered: 3 }],
      "On purchase order",
    ],
    [
      "received parts held for issue",
      [{ ordered: 5, received: 2, reserved: 2 }],
      "Received / awaiting issue",
    ],
    [
      "some received parts still held",
      [{ ordered: 5, received: 2, reserved: 1, issued: 1 }],
      "Received / awaiting issue",
    ],
    [
      "awaiting issue on one line, nothing on another",
      [{ ordered: 5, received: 1, reserved: 1 }, {}],
      "Received / awaiting issue",
    ],
    [
      "every received part issued, more on order (the bug)",
      [{ ordered: 5, received: 2, issued: 2 }],
      "Partially issued",
    ],
    [
      "received parts issued, other stock reserved since",
      [{ ordered: 5, received: 2, issued: 2, reserved: 1 }],
      "Partially issued",
    ],
    ["issued from stock", [{ issued: 2 }], "Partially issued"],
    [
      "issued from stock, rest reserved",
      [{ issued: 2, reserved: 3 }],
      "Partially issued",
    ],
    [
      "received reservation released",
      [{ ordered: 5, received: 2 }],
      "On purchase order",
    ],
    ["all issued", [{ issued: 5 }], "Fulfilled"],
    [
      "all received and issued",
      [{ ordered: 5, received: 5, issued: 5 }],
      "Fulfilled",
    ],
    [
      "one line done, another partly issued",
      [{ issued: 5 }, { ordered: 5, received: 1, issued: 1 }],
      "Partially issued",
    ],
  ])("parts request: %s", (_, lines, expected) => {
    expect(status("parts", ...lines)).toBe(expected);
  });
  it.each<[string, Line[], string]>([
    ["not yet ordered", [{ quantity: 1 }], "Requested"],
    ["on a PO", [{ quantity: 1, ordered: 1 }], "On purchase order"],
    [
      "shipped to the vendor",
      [{ quantity: 1, ordered: 1, shipped: 1 }],
      "Out for repair",
    ],
    [
      "returned",
      [{ quantity: 1, ordered: 1, shipped: 1, received: 1 }],
      "Fulfilled",
    ],
    [
      "one of two returned",
      [
        { quantity: 1, ordered: 1, shipped: 1, received: 1 },
        { quantity: 1, ordered: 1 },
      ],
      "Received / awaiting issue",
    ],
  ])("repair request: %s", (_, lines, expected) => {
    expect(status("repair", ...lines)).toBe(expected);
  });
  it("shows Partially issued once received parts are issued while more are on order", () => {
    const { s, draftPO, po } = fixture();
    const request = () => s.partsRequests![0];
    let p = po({ kind: "save", requestUuid: "save", drafts: [draftPO(5)] });
    p = po({
      kind: "issue",
      requestUuid: "issue",
      uuid: p.uuid,
      version: p.version,
      reason: "",
    });
    expect(requestStatus(s, request())).toBe("On purchase order");
    po({
      kind: "receive",
      requestUuid: "receive",
      uuid: p.uuid,
      version: p.version,
      date: "2026-10-20",
      invoice: "INV",
      notes: "",
      lines: [{ lineUuid: "line", quantity: 2, condition: "new", serials: [] }],
    });
    expect(requestStatus(s, request())).toBe("Received / awaiting issue");
    applyRequestCommand(
      s,
      {
        kind: "issue",
        requestUuid: "issue-received",
        uuid: "request",
        version: request().version,
        lineUuid: "item",
        stockUuid: "stock",
        quantity: 2,
        alternateConfirmed: false,
      },
      now,
    );
    expect(requestLineProgress(s, request(), "item")).toMatchObject({
      ordered: 5,
      received: 2,
      issued: 2,
      reserved: 0,
    });
    expect(requestStatus(s, request())).toBe("Partially issued");
  });
});

type Fixture = ReturnType<typeof fixture>;
const AIRCRAFT_UUID = demoSnapshot().aircraft[0].uuid;
const save = ({ s, draft }: Fixture, fields: Partial<RequestDraft>) =>
  applyRequestCommand(
    s,
    {
      kind: "save",
      requestUuid: crypto.randomUUID(),
      draft: { ...draft, ...fields },
    },
    now,
  );
const saveNew = (f: Fixture, fields: Partial<RequestDraft>) =>
  save(f, { uuid: "new", version: 0, ...fields });
const change = (
  { s }: Fixture,
  kind: "reserve" | "release" | "issue",
  fields: object = {},
) =>
  applyRequestCommand(
    s,
    {
      kind,
      requestUuid: crypto.randomUUID(),
      uuid: "request",
      version: 1,
      lineUuid: "item",
      stockUuid: "stock",
      quantity: 1,
      alternateConfirmed: false,
      ...fields,
    },
    now,
  );
const cancel = ({ s }: Fixture, version = 1) =>
  applyRequestCommand(
    s,
    {
      kind: "cancel",
      requestUuid: crypto.randomUUID(),
      uuid: "request",
      version,
      reason: "x",
    },
    now,
  );
const stored = ({ s }: Fixture, fields: Partial<PartsRequest>) =>
  Object.assign(s.partsRequests![0], fields);
const repairLine = requestLineSchema.parse({
  uuid: "item",
  partNumber: "PUMP",
  description: "Pump",
  quantity: 1,
  componentUuid: "component",
  defect: "Leak",
  workRequested: "Repair",
});
const withComponent = (f: Fixture, fields: Partial<Component> = {}) => {
  f.s.management!.push(
    componentSchema.parse({
      uuid: "component",
      version: 1,
      programUuid: "demo-program",
      kind: "component",
      aircraftUuid: "",
      componentType: "Pump",
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
      timeSinceNew: 0,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 0,
      serviceDaysBase: 0,
      ...fields,
    }),
  );
  return f;
};
const withStock = (f: Fixture, fields: object) => {
  Object.assign(
    f.s.management!.find((x) => x.uuid === "stock")!,
    fields,
  );
  return f;
};
const asMechanic = (f: Fixture) => {
  f.s.user = {
    ...f.s.user,
    isAdmin: false,
    groupIds: ["mechanic"],
    activeProgramUuid: "demo-program",
  };
  f.s.groups = [
    {
      id: "mechanic",
      name: "Mechanic",
      programUuid: "demo-program",
      aircraftIds: [AIRCRAFT_UUID],
      permissions: ["read", "maintenance"],
    },
  ];
  return f;
};

// Each refusal applyRequestCommand throws itself, in the order it checks.
const REFUSALS: Record<string, (f: Fixture) => unknown> = {
  "Choose a Flight Program.": (f) => {
    f.s.user.activeProgramUuid = "";
    return saveNew(f, {});
  },
  "Recurring parts require a recurring inspection, service or AD task.": (f) =>
    saveNew(f, { recurring: true }),
  "Request identifier already used.": (f) =>
    applyRequestCommand(
      f.s,
      {
        kind: "save",
        requestUuid: "create",
        draft: { ...f.draft, engineer: "Other" },
      },
      now,
    ),
  "Request is outside this Flight Program.": (f) => {
    stored(f, { programUuid: "other-program" });
    return save(f, { version: 1 });
  },
  "Request changed. Reopen it before saving.": (f) => save(f, {}),
  "Save the work-order task before requesting parts.": (f) =>
    saveNew(f, {
      source: { kind: "workTask", uuid: "task", workOrderUuid: "order" },
    }),
  "AD task is unavailable.": (f) =>
    saveNew(f, {
      source: { kind: "airworthiness", uuid: "task", workOrderUuid: "" },
    }),
  "Linked item is unavailable.": (f) =>
    saveNew(f, {
      source: { kind: "discrepancy", uuid: "missing", workOrderUuid: "" },
    }),
  "Linked item is outside this Flight Program.": (f) =>
    saveNew(withComponent(f, { programUuid: "other-program" }), {
      source: { kind: "component", uuid: "component", workOrderUuid: "" },
    }),
  "Stock item is unavailable.": (f) =>
    saveNew(f, {
      source: { kind: "stock", uuid: "missing", workOrderUuid: "" },
    }),
  "Aircraft is outside this Flight Program.": (f) => {
    const report = f.s.discrepancies[0];
    const a = f.s.aircraft.find((a) => a.uuid === report.aircraftUuid)!;
    a.programUuid = "other-program";
    return saveNew(f, {
      source: { kind: "discrepancy", uuid: report.uuid, workOrderUuid: "" },
    });
  },
  "Maintenance access is required.": (f) => saveNew(asMechanic(f), {}),
  "Cancelled requests are read-only.": (f) => {
    stored(f, { cancelled: true });
    return save(f, { version: 1 });
  },
  "Create a separate recurring parts list; an existing request cannot change its recurrence type.":
    (f) => {
      stored(f, { recurring: true });
      return save(f, { version: 1 });
    },
  "Request date cannot be in the future.": (f) =>
    saveNew(f, { date: "2099-01-01" }),
  "Duplicate request lines.": (f) =>
    saveNew(f, { lines: [f.draft.lines[0], f.draft.lines[0]] }),
  "Request source cannot change.": (f) =>
    save(f, {
      version: 1,
      source: { kind: "stock", uuid: "stock", workOrderUuid: "" },
    }),
  "Release reservations and remove draft PO allocations before changing lines or purchasing details. Fulfilled lines are retained for traceability.":
    (f) => {
      change(f, "reserve");
      return save(f, { version: 2, vendor: "Other vendor" });
    },
  "Choose an uninstalled serialized component in this Flight Program; repair quantity must be one.":
    (f) => saveNew(f, { mode: "repair", lines: [repairLine] }),
  "This component already has an open repair request.": (f) => {
    saveNew(withComponent(f), { mode: "repair", lines: [repairLine] });
    return saveNew(f, { uuid: "second", mode: "repair", lines: [repairLine] });
  },
  "Enter the defect and work requested for repair.": (f) =>
    saveNew(withComponent(f), {
      mode: "repair",
      lines: [{ ...repairLine, defect: "" }],
    }),
  "Use a repair request for an existing serialized component.": (f) =>
    saveNew(f, {
      lines: [{ ...f.draft.lines[0], componentUuid: "component" }],
    }),
  "Request not found.": (f) =>
    change(f, "reserve", { uuid: "missing", version: 0 }),
  "Reserve or issue parts against an occurrence request, not the recurring list.":
    (f) => {
      stored(f, { recurring: true });
      return change(f, "reserve");
    },
  "Inventory administrator access is required to reserve, issue or cancel requests.":
    (f) => {
      stored(f, { aircraftUuid: AIRCRAFT_UUID });
      return change(asMechanic(f), "reserve");
    },
  "Remove draft allocations or cancel outstanding PO quantities first.": (
    f,
  ) => {
    f.po({ kind: "save", requestUuid: "po-save", drafts: [f.draftPO(5)] });
    return cancel(f);
  },
  "Reserved stock is unavailable.": (f) => {
    change(f, "reserve");
    f.s.management = f.s.management!.filter((x) => x.uuid !== "stock");
    return cancel(f, 2);
  },
  "Repair components are shipped and received through their purchase order.": (
    f,
  ) => {
    stored(f, { mode: "repair" });
    return change(f, "reserve");
  },
  "Select a stock item in this Flight Program.": (f) =>
    change(f, "reserve", { stockUuid: "missing" }),
  "Select the requested part or explicitly confirm its listed alternate.": (
    f,
  ) => change(withStock(f, { partNumber: "OTHER" }), "reserve"),
  "Only serviceable stock can be reserved.": (f) =>
    change(withStock(f, { condition: "core" }), "reserve"),
  "Quantity exceeds uncommitted demand or available stock.": (f) =>
    change(f, "reserve", { quantity: 3 }),
  "Quantity exceeds this request’s reservation.": (f) => change(f, "release"),
};

describe("refusals", () => {
  it.each(Object.entries(REFUSALS))("%s", (message, refuse) => {
    const refusal = () => refuse(fixture());
    expect(refusal).toThrow(new Error(message));
    expect(refusal).toThrow(Rejection);
  });
});

it("labels each source by what it links to", () => {
  const f = withComponent(fixture());
  const ad = blankAD(AIRCRAFT_UUID);
  ad.source.number = "2026-01-01";
  ad.tasks = [{ ...blankADTask(), description: "Inspect" }];
  f.s.airworthiness = [ad];
  const report = f.s.discrepancies[0];
  const resolve = (kind: RequestSource["kind"], uuid = "") =>
    resolveRequestSource(f.s, { kind, uuid, workOrderUuid: "" });
  expect(resolve("stock").label).toBe("Inventory stock request");
  expect(resolve("stock", "stock").label).toBe("Inventory: TIRE");
  expect(resolve("discrepancy", report.uuid).label).toBe(report.description);
  expect(resolve("airworthiness", ad.tasks[0].uuid).label).toBe(
    "AD 2026-01-01: Inspect",
  );
  expect(resolve("component", "component")).toMatchObject({
    label: "PUMP · S/N SN1",
    componentUuid: "component",
  });
});

it("replaces a free-text address with its structured details on save", () => {
  const details = addressSchema.parse({ street: "1 Main St", city: "Town" });
  const saved = saveNew(fixture(), { shipTo: "Old", shipToDetails: details });
  expect(saved.shipTo).toBe(formatAddress(details));
  expect(saved.shipTo).not.toBe("Old");
});

it("cancels units off the last allocations and receives into the first", () => {
  const allocation = (requestUuid: string, quantity: number) => ({
    requestUuid,
    lineUuid: "item",
    quantity,
  });
  const order = {
    uuid: "po",
    lines: [
      {
        uuid: "line",
        quantity: 5,
        cancelled: 1,
        requestAllocations: [allocation("first", 2), allocation("last", 3)],
      },
    ],
    receipts: [{ lines: [{ lineUuid: "line", quantity: 3 }] }],
    shipments: [],
    history: [],
  } as unknown as PurchaseOrder;
  expect(
    requestPurchases([order]).map((p) => [
      p.requestUuid,
      p.quantity,
      p.received,
    ]),
  ).toEqual([
    ["first", 2, 2],
    ["last", 2, 1],
  ]);
});

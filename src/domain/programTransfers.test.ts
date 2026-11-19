/**
 * Responsibility: Pins Flight Program transfers: what moves with each record,
 *   the refusals users see, the reason limit, and the change log left
 *   untouched.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/programTransfers.ts, programs.ts, auditHistory.ts,
 *   partsRequests.ts, purchaseOrders.ts, checklists.ts, fleet.ts, rejection.ts;
 *   src/data/demo.ts and tests/fixtures/workOrders.ts (fixtures).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import {
  TRANSFER_REASON_MAX_LENGTH,
  transferProgram,
  type ProgramTransfer,
} from "./programTransfers";
import { fleetCommandSchema } from "./fleet";
import { auditVisible } from "./programs";
import { canPageAuditFilter } from "./auditHistory";
import type { AuditEntry } from "./model";
import { partsRequestSchema, requestDraftSchema } from "./partsRequests";
import { poDraftSchema, poSchema } from "./purchaseOrders";
import { emptyChecklist } from "./checklists";
import { Rejection } from "./rejection";

// The demo backend mirrors the server: transfers append, never re-tag.
it("transfers leave change-log entries untouched and History follows the aircraft's current owner", () => {
  const s = demoSnapshot();
  const plane = s.aircraft[0];
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "other", name: "Other" },
  ];
  s.user.activeProgramUuid = "demo-program";
  const row = (
    uuid: string,
    fields: Partial<AuditEntry> & { entityUuid: string },
  ): AuditEntry => ({ uuid, actorId: "a", at: 1, action: "x", ...fields });
  s.audit = [
    row("tagged", {
      programUuid: "demo-program",
      aircraftUuid: plane.uuid,
      entityUuid: "wo",
    }),
    row("legacy", { aircraftUuid: plane.uuid, entityUuid: "flight" }),
    row("orphan", { programUuid: "demo-program", entityUuid: "gone" }),
  ];
  const history = JSON.stringify(s.audit);
  const seen = () => s.audit.filter(auditVisible(s)).map((e) => e.uuid);
  expect(seen()).toEqual(["tagged", "legacy"]);
  transferProgram(s, {
    kind: "aircraft",
    uuid: plane.uuid,
    destination: "other",
    reason: "Base move",
  });
  expect(JSON.stringify(s.audit.slice(1))).toBe(history);
  expect(s.audit[0]).toMatchObject({
    action: "program.transferred",
    programUuid: "other",
  });
  expect(seen()).toEqual([]);
  expect(
    canPageAuditFilter(auditVisible(s), { aircraftUuid: plane.uuid }),
  ).toBe(false);
  s.user.activeProgramUuid = "other";
  expect(seen()).toEqual([s.audit[0].uuid, "tagged", "legacy"]);
  expect(
    canPageAuditFilter(auditVisible(s), { aircraftUuid: plane.uuid }),
  ).toBe(true);
  expect(canPageAuditFilter(auditVisible(s), { entityUuid: plane.uuid })).toBe(
    true,
  );
  expect(canPageAuditFilter(auditVisible(s), { entityUuid: "unknown" })).toBe(
    false,
  );
});

// #48: a location's stock may be reserved for this program's parts requests,
// and open purchase-order lines deliver into it. Like an aircraft with open
// parts requests, the location stays until they are settled.
function locationWithCommitments() {
  const s = demoSnapshot();
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "other", name: "Other" },
  ];
  const stock = (reservedQuantity: number) => ({
    kind: "stock" as const,
    uuid: "S1",
    programUuid: "demo-program",
    version: 1,
    locationUuid: "L1",
    partNumber: "FILTER-1",
    description: "Oil filter",
    quantity: 5,
    reservedQuantity,
    minimum: 0,
    alternates: "",
    category: "part" as const,
    condition: "new" as const,
  });
  s.management = [
    {
      kind: "location",
      uuid: "L1",
      programUuid: "demo-program",
      version: 1,
      name: "Main hangar",
      address: "",
      contact: "",
    },
    stock(3),
  ];
  const request = partsRequestSchema.parse({
    ...requestDraftSchema.parse({
      uuid: "request",
      version: 0,
      source: { kind: "stock", uuid: "S1" },
      mode: "parts",
      date: "2026-11-03",
      engineer: "Engineer",
      priority: "P2 Routine",
      requiredBy: "",
      vendor: "",
      currency: "USD",
      lines: [
        {
          uuid: "line",
          partNumber: "FILTER-1",
          description: "Oil filter",
          quantity: 3,
        },
      ],
    }),
    version: 1,
    programUuid: "demo-program",
    aircraftUuid: "",
    sourceLabel: "Stock",
    aircraftRegistration: "",
    aircraftSerial: "",
    aircraftModel: "",
    number: "PR-00001",
    requesterId: "demo-admin",
    createdAt: 1,
    updatedAt: 1,
    cancelled: false,
    reservations: [{ lineUuid: "line", stockUuid: "S1", quantity: 3 }],
    issues: [],
    history: [],
  });
  const order = (
    phase: "draft" | "issued" | "cancelled",
    received = 0,
    cancelled = 0,
  ) =>
    poSchema.parse({
      ...poDraftSchema.parse({
        uuid: "po",
        version: 1,
        vendor: "Vendor",
        vendorContact: "",
        shipTo: "Main hangar",
        expectedDate: "",
        currency: "USD",
        shippingCents: 0,
        notes: "",
        lines: [
          {
            uuid: "po-line",
            stockUuid: "S1",
            locationUuid: "L1",
            partNumber: "FILTER-1",
            description: "Oil filter",
            quantity: 2,
            unitCents: 100,
            kind: "part",
            cancelled,
          },
        ],
      }),
      programUuid: "demo-program",
      number: "PO-00001",
      phase,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      shipments: [],
      receipts: received
        ? [
            {
              uuid: "receipt",
              date: "2026-11-03",
              invoice: "",
              notes: "",
              actorId: "demo-admin",
              lines: [
                {
                  lineUuid: "po-line",
                  quantity: received,
                  condition: "new",
                  itemUuids: [],
                  serials: [],
                },
              ],
            },
          ]
        : [],
      history: [],
    });
  return { s, stock, request, order };
}
it("refuses to transfer a storage location while its stock is reserved or an open purchase order delivers to it", () => {
  const { s, stock, request, order } = locationWithCommitments();
  s.partsRequests = [request];
  s.purchaseOrders = [order("issued")];
  const move = () => {
    const copy = structuredClone(s);
    transferProgram(copy, {
      kind: "location",
      uuid: "L1",
      destination: "other",
      reason: "Base consolidation",
    });
    return copy;
  };
  expect(move).toThrow(Rejection);
  expect(move).toThrow(
    "Release reserved stock (FILTER-1 for PR-00001) and receive or cancel open purchase order lines (FILTER-1 on PO-00001) before transferring this location.",
  );
  // Released, the open order still delivers here.
  s.partsRequests = [{ ...request, reservations: [] }];
  s.management![1] = stock(0);
  expect(move).toThrow(
    "Receive or cancel open purchase order lines (FILTER-1 on PO-00001) before transferring this location.",
  );
  // Partly received is still open.
  s.purchaseOrders = [order("issued", 1)];
  expect(move).toThrow(/FILTER-1 on PO-00001/);
  // Fully received, fully cancelled, a cancelled order or a draft is not.
  for (const po of [
    order("issued", 2),
    order("issued", 0, 2),
    order("cancelled"),
    order("draft"),
  ]) {
    s.purchaseOrders = [po];
    expect(move().management!.find((r) => r.uuid === "S1")).toMatchObject({
      programUuid: "other",
      version: 2,
    });
  }
  // Reserved stock alone blocks too.
  s.purchaseOrders = [];
  s.partsRequests = [request];
  s.management![1] = stock(3);
  expect(move).toThrow(
    "Release reserved stock (FILTER-1 for PR-00001) before transferring this location.",
  );
});

const toOther = (kind: ProgramTransfer["kind"], uuid: string) => ({
  kind,
  uuid,
  destination: "other",
  reason: "Base move",
});

it("refuses a transfer the user may not make", () => {
  const { s } = locationWithCommitments();
  const attempt =
    (change: Partial<ProgramTransfer>, user = s.user) =>
    () =>
      transferProgram(
        { ...structuredClone(s), user },
        { ...toOther("location", "L1"), ...change },
      );
  const cases: [() => unknown, string][] = [
    [
      attempt({}, { ...s.user, isAdmin: false }),
      "System administrator required for Flight Program transfers.",
    ],
    [attempt({ reason: " " }), "A transfer reason is required."],
    [attempt({ destination: "gone" }), "Destination Flight Program not found."],
    [
      attempt({ destination: "demo-program" }),
      "Select a different Flight Program.",
    ],
    [
      attempt({ kind: "aircraft", uuid: "gone" }),
      "Aircraft not found in active Flight Program.",
    ],
    [attempt({ uuid: "gone" }), "Record not found in active Flight Program."],
  ];
  for (const [move, message] of cases) {
    expect(move).toThrow(Rejection);
    expect(move).toThrow(Error(message));
  }
});

// convex/programs.test.ts pins the component setups that go with it.
it("moves an aircraft with its components, inspections and checklists once its parts requests are closed", () => {
  const { s, request } = locationWithCommitments();
  const plane = s.aircraft[0];
  const engine = { ...workOrderComponent(), programUuid: "demo-program" };
  s.management!.push(engine);
  s.partsRequests = [{ ...request, aircraftUuid: plane.uuid }];
  s.checklists = [
    {
      uuid: "list",
      version: 1,
      programUuid: "demo-program",
      aircraftUuid: plane.uuid,
      sourceName: "",
      updatedAt: 1,
      updatedBy: "",
      document: emptyChecklist(),
    },
  ];
  const move = () => transferProgram(s, toOther("aircraft", plane.uuid));
  expect(move).toThrow(Rejection);
  expect(move).toThrow(
    "Cancel or fulfill this aircraft's open parts requests before transferring it.",
  );
  s.partsRequests = [{ ...request, aircraftUuid: plane.uuid, cancelled: true }];
  const inspections = s.inspections.filter(
    (i) => i.aircraftUuid === plane.uuid,
  );
  const versions = inspections.map((i) => (i.version ?? 0) + 1);
  const planeVersion = plane.version;
  expect(move()).toEqual(new Set([plane.uuid, "list", "engine"]));
  expect(s.checklists[0]).toMatchObject({ programUuid: "other", version: 2 });
  expect(plane).toMatchObject({
    programUuid: "other",
    program: "Other",
    version: planeVersion + 1,
  });
  expect(inspections.map((i) => [i.programUuid, i.version])).toEqual(
    versions.map((v) => ["other", v]),
  );
  expect(engine).toMatchObject({
    programUuid: "other",
    version: 1,
    aircraftUuid: plane.uuid,
  });
});

it("moves the program's expiring dates for an aircraft with it, one change-log row each, newest first", () => {
  const { s } = locationWithCommitments();
  const plane = s.aircraft[0];
  const date = (uuid: string, aircraftUuid?: string, programUuid?: string) => ({
    uuid,
    programUuid,
    aircraftUuid,
    kind: "registration" as const,
    label: uuid,
    expiresOn: "2027-01-01",
    warnDays: 60,
    version: 1,
  });
  s.expiringItems = [
    date("registration", plane.uuid, "demo-program"),
    date("other-aircraft", s.aircraft[1].uuid, "demo-program"),
    date("program-wide", undefined, "demo-program"),
    date("system-wide"),
  ];
  const earlier = s.audit.length;
  const moved = transferProgram(s, toOther("aircraft", plane.uuid));
  expect(moved).toContain("registration");
  expect(
    s.expiringItems.map((i) => [i.uuid, i.programUuid, i.version]),
  ).toEqual([
    ["registration", "other", 2],
    ["other-aircraft", "demo-program", 1],
    ["program-wide", "demo-program", 1],
    ["system-wide", undefined, 1],
  ]);
  expect(s.audit.length).toBe(earlier + 2);
  expect(s.audit.slice(0, 2).map((e) => [e.action, e.entityUuid])).toEqual([
    ["program.transferred", plane.uuid],
    ["expiring-date.transferred", "registration"],
  ]);
  expect(s.audit[1]).toMatchObject({
    programUuid: "other",
    aircraftUuid: plane.uuid,
    reason: toOther("aircraft", plane.uuid).reason,
  });
});

// A tracked engine stored in Main hangar, last fitted to the first aircraft.
// convex/programs.test.ts pins the requirements that go with it.
function storedEngine(partsLocation = "") {
  const { s } = locationWithCommitments();
  const engine = {
    ...workOrderComponent(),
    programUuid: "demo-program",
    installed: false,
    locationUuid: "L1",
    partsLocation,
  };
  s.management!.push(engine);
  return { s, engine };
}

it("moves a stored component off its aircraft and out of its location, but not one in use there", () => {
  const { s, engine } = storedEngine();
  const input = toOther("component", "engine");
  expect(transferProgram(s, input)).toEqual(new Set(["engine"]));
  expect(engine).toMatchObject({
    programUuid: "other",
    version: 1,
    aircraftUuid: "",
    partsLocation: "Main hangar",
  });
  expect(engine.locationUuid).toBeUndefined();
  const named = storedEngine("Bin A");
  transferProgram(named.s, input);
  expect(named.engine.partsLocation).toBe("Bin A");
  const installed = storedEngine();
  installed.engine.installed = true;
  const scheduled = storedEngine();
  scheduled.s.inspections[0].componentUuid = "engine";
  for (const [s, move, message] of [
    [
      installed.s,
      input,
      "Remove the component before transferring it, or transfer its aircraft.",
    ],
    [
      scheduled.s,
      input,
      "Transfer the associated aircraft while this component has linked inspection schedules.",
    ],
    [
      storedEngine().s,
      toOther("location", "L1"),
      "Move tracked components to another inventory location before transferring this location.",
    ],
  ] as const) {
    expect(() => transferProgram(s, move)).toThrow(Rejection);
    expect(() => transferProgram(s, move)).toThrow(Error(message));
  }
});

it("caps a transfer reason where other change-log reasons stop", () => {
  const save = (reason: string) =>
    fleetCommandSchema.safeParse({
      requestUuid: crypto.randomUUID(),
      reason,
      action: "program.save",
      program: demoSnapshot().programs![0],
    }).success;
  expect(save("x".repeat(TRANSFER_REASON_MAX_LENGTH))).toBe(true);
  expect(save("x".repeat(TRANSFER_REASON_MAX_LENGTH + 1))).toBe(false);
});

it("refuses a transfer reason longer than the form allows, changing nothing", () => {
  const s = demoSnapshot();
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "other", name: "Other" },
  ];
  s.user.activeProgramUuid = "demo-program";
  const move = (reason: string) =>
    transferProgram(s, {
      kind: "aircraft",
      uuid: s.aircraft[0].uuid,
      destination: "other",
      reason,
    });
  const before = structuredClone(s);
  const tooLong = () => move("x".repeat(TRANSFER_REASON_MAX_LENGTH + 1));
  expect(tooLong).toThrow(Rejection);
  expect(tooLong).toThrow(
    Error("Keep the transfer reason to 2000 characters or fewer."),
  );
  expect(s).toEqual(before);
  const reason = "x".repeat(TRANSFER_REASON_MAX_LENGTH);
  move(reason);
  expect(s.audit[0]).toMatchObject({ action: "program.transferred", reason });
});

it("refuses to transfer an aircraft while an issued purchase-order line names it", () => {
  const { s, order } = locationWithCommitments();
  const plane = s.aircraft[0];
  const naming = (...args: Parameters<typeof order>) => {
    const po = order(...args);
    po.lines[0].aircraftUuid = plane.uuid;
    return po;
  };
  const move = () =>
    transferProgram(structuredClone(s), toOther("aircraft", plane.uuid));
  s.purchaseOrders = [naming("issued", 1)];
  expect(move).toThrow(Rejection);
  expect(move).toThrow(
    "Receive or cancel open purchase order lines (FILTER-1 on PO-00001) before transferring this aircraft.",
  );
  // An order for another aircraft, a draft and a settled order do not wait.
  for (const po of [
    order("issued"),
    naming("draft"),
    naming("issued", 2),
    naming("issued", 0, 2),
    naming("cancelled"),
  ]) {
    s.purchaseOrders = [po];
    expect(move()).toContain(plane.uuid);
  }
});

it("refuses to transfer a component that is out for repair or has an open repair request or order", () => {
  const { s, engine } = storedEngine();
  const { request, order } = locationWithCommitments();
  const repair = {
    ...request,
    mode: "repair" as const,
    reservations: [],
    lines: [{ ...request.lines[0], quantity: 1, componentUuid: "engine" }],
  };
  const repairOrder = (
    phase: "draft" | "issued" | "cancelled",
    received = 0,
  ) => {
    const po = order(phase, received);
    po.lines[0] = {
      ...po.lines[0],
      quantity: 1,
      repairComponentUuid: "engine",
      requestAllocations: [
        { requestUuid: "request", lineUuid: "line", quantity: 1 },
      ],
    };
    return po;
  };
  const move = (kind: "component" | "aircraft" = "component") =>
    transferProgram(
      structuredClone(s),
      toOther(kind, kind === "component" ? "engine" : s.aircraft[0].uuid),
    );
  s.partsRequests = [repair];
  expect(move).toThrow(Rejection);
  expect(move).toThrow(
    "Cancel or complete the open repair requests and orders for PN S/N SN (PR-00001) before transferring it.",
  );
  s.purchaseOrders = [repairOrder("draft")];
  expect(move).toThrow(
    "Cancel or complete the open repair requests and orders for PN S/N SN (PR-00001, PO-00001) before transferring it.",
  );
  engine.outForRepair = { poUuid: "po", date: "2026-11-03" };
  s.purchaseOrders = [repairOrder("issued")];
  expect(move).toThrow(
    "Receive PN S/N SN back from repair on PO-00001 before transferring it.",
  );
  // The component would leave with its aircraft, so the aircraft waits too.
  expect(() => move("aircraft")).toThrow(
    "Receive PN S/N SN back from repair on PO-00001 before transferring it.",
  );
  // Back from repair, or with the request cancelled, it can go.
  delete engine.outForRepair;
  s.purchaseOrders = [repairOrder("issued", 1)];
  expect(move()).toContain("engine");
  s.purchaseOrders = [repairOrder("cancelled")];
  s.partsRequests = [{ ...repair, cancelled: true }];
  expect(move()).toContain("engine");
});

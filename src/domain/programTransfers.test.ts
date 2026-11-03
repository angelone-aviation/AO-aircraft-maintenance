import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { transferProgram } from "./programTransfers";
import { auditVisible } from "./programs";
import { canPageAuditFilter } from "./auditHistory";
import type { AuditEntry } from "./model";
import { partsRequestSchema, requestDraftSchema } from "./partsRequests";
import { poDraftSchema, poSchema } from "./purchaseOrders";

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

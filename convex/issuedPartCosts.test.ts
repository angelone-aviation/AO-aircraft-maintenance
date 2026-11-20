/**
 * Responsibility: Pins issue prices on the server (PT-12, decision D13): an
 *   issue writes its price to the work order's cost record with a change-log
 *   row, a stock cost correction leaves it, and only administrators read it.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/partsRequests, convex/management, convex/workOrders,
 *   convex/operations, src/domain (costs, partsRequests, workOrders),
 *   tests/fixtures (sampleRoles, workOrders).
 */
import { it, expect, vi } from "vitest";
import { api } from "./_generated/api";
import {
  OWNED_AIRCRAFT,
  PROGRAM,
  seedSampleRoles,
  type SampleRoles,
} from "../tests/fixtures/sampleRoles";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { workOrderCosts, type WorkOrderCost } from "../src/domain/costs";
import { requestDraftSchema } from "../src/domain/partsRequests";
import { newWorkTask } from "../src/domain/workOrders";

const TODAY = "2026-06-15";
// A price no timestamp, uuid or count can contain as a whole number, so
// finding it in a role's snapshot means it leaked.
const ISSUED_DOLLARS = 1234.57;
const ISSUED_CENTS = 123_457;
const CORRECTED_DOLLARS = 1500;
const CORRECTED_CENTS = 150_000;
const LEAKED_PRICE = /\b(123457|1234\.57)\b/;
const LOT = {
  uuid: "d13-lot",
  version: 1,
  programUuid: PROGRAM,
  kind: "stock",
  partNumber: "CYL-1",
  description: "Cylinder",
  category: "part",
  condition: "new",
  locationUuid: "sample-location-1",
  quantity: 4,
  minimum: 0,
  alternates: "",
  cost: ISSUED_DOLLARS,
};

type Client = SampleRoles["manager"];

it("records each issue's price once on the work order's cost record and shows it to administrators only", async () => {
  // The clock stands still, so both issues share a time and pair with their
  // prices in order.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`));
  try {
    const roles = await seedSampleRoles();
    const { t, manager } = roles;
    await t.run((ctx) =>
      ctx.db.insert("management", {
        uuid: LOT.uuid,
        programUuid: PROGRAM,
        kind: "stock",
        payload: JSON.stringify(LOT),
      }),
    );
    const order = await openOrder(manager);
    const boardBefore = await boardYearCents(roles);
    await issue(manager, 1);
    await correctCost(manager, CORRECTED_DOLLARS);
    await issue(manager, 1);
    await correctCost(manager, ISSUED_DOLLARS);

    const rows = await t.run(async (ctx) => ({
      costs: (await ctx.db.query("costs").collect())
        .map((d) => JSON.parse(d.payload) as WorkOrderCost)
        .filter((r) => r.workOrderUuid === order.uuid),
      audit: await ctx.db.query("audit").collect(),
    }));
    // One record: the second issue found the first one's.
    expect(rows.costs).toHaveLength(1);
    expect(rows.costs[0].issuedParts?.map((p) => p.unitCents)).toEqual([
      ISSUED_CENTS,
      CORRECTED_CENTS,
    ]);
    const priced = rows.audit.filter((a) => a.action === "cost.part.issue");
    expect(priced.map((a) => a.entityUuid)).toEqual([
      rows.costs[0].uuid,
      rows.costs[0].uuid,
    ]);
    expect(priced.every((a) => a.aircraftUuid === undefined)).toBe(true);

    const managerView = (await manager.query(api.operations.snapshot, {}))!;
    const saved = managerView.workOrders!.find((w) => w.uuid === order.uuid)!;
    expect(workOrderCosts(managerView, saved).partsCents).toBe(
      ISSUED_CENTS + CORRECTED_CENTS,
    );
    expect(await boardYearCents(roles)).toBe(
      boardBefore + ISSUED_CENTS + CORRECTED_CENTS,
    );
    for (const role of [
      "observer",
      "pilot",
      "tech",
      "owner",
      "board",
    ] as const) {
      const view = await roles[role].query(api.operations.snapshot, {});
      expect(JSON.stringify(view), role).not.toMatch(LEAKED_PRICE);
    }
  } finally {
    vi.useRealTimers();
  }
});

// Opens a work order on the owned aircraft with one manual task, and raises
// a request for the lot's part on that task.
async function openOrder(manager: Client) {
  const order = workOrderCommand();
  order.fields.aircraftUuid = OWNED_AIRCRAFT;
  order.fields.dateOpened = TODAY;
  order.tasks = [
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, "Cylinder"),
  ];
  await manager.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(order),
  });
  await request(manager, {
    kind: "save",
    requestUuid: crypto.randomUUID(),
    draft: requestDraftSchema.parse({
      uuid: "d13-request",
      version: 0,
      source: {
        kind: "workTask",
        uuid: order.tasks[0].uuid,
        workOrderUuid: order.uuid,
      },
      mode: "parts",
      date: TODAY,
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        { uuid: "line", partNumber: "CYL-1", description: "Cyl", quantity: 4 },
      ],
    }),
  });
  return order;
}

async function issue(manager: Client, quantity: number) {
  for (const kind of ["reserve", "issue"])
    await request(manager, {
      kind,
      requestUuid: crypto.randomUUID(),
      uuid: "d13-request",
      version: await requestVersion(manager),
      lineUuid: "line",
      stockUuid: LOT.uuid,
      quantity,
      alternateConfirmed: false,
      date: TODAY,
    });
}

async function correctCost(manager: Client, cost: number) {
  const view = (await manager.query(api.operations.snapshot, {}))!;
  const lot = view.management!.find((r) => r.uuid === LOT.uuid)!;
  await manager.mutation(api.management.execute, {
    programUuid: PROGRAM,
    payload: JSON.stringify({
      action: "record.save",
      requestUuid: crypto.randomUUID(),
      reason: "Vendor invoice",
      record: { ...lot, cost },
    }),
  });
}

async function request(manager: Client, command: object) {
  await manager.mutation(api.partsRequests.execute, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
}

async function requestVersion(manager: Client) {
  const view = (await manager.query(api.operations.snapshot, {}))!;
  return view.partsRequests!.find((r) => r.uuid === "d13-request")!.version;
}

async function boardYearCents({ board }: SampleRoles) {
  const view = (await board.query(api.operations.snapshot, {}))!;
  return view.boardCosts!.find((c) => c.aircraftUuid === OWNED_AIRCRAFT)!
    .yearCents;
}

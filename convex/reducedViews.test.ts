/**
 * Responsibility: Pins that reduced-view groups never add up to the
 *   workspace: a user holding only an aircraft owner group and a board group
 *   reads the owner portal for the owner group's aircraft, the board view
 *   for the rest, and nothing else; every other call is refused.
 * Layer: Test. convex-test suite; never shipped.
 * Dependencies: convex/operations.ts, convex/auditHistory.ts,
 *   convex/costs.ts, tests/fixtures/sampleRoles.ts.
 */
import { expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Snapshot } from "../src/domain/model";
import {
  addMember,
  OWNED_AIRCRAFT,
  PROGRAM,
  seedSampleRoles,
} from "../tests/fixtures/sampleRoles";

/** The record lists both reduced views carry, each record with a uuid. */
const RECORD_LISTS = [
  "discrepancies",
  "inspections",
  "airworthiness",
  "management",
  "workOrders",
] as const;

async function ownerOnTheBoard() {
  const world = await seedSampleRoles();
  const { owners, board } = world.groups;
  // A budget, so that the board totals are not all empty.
  await world.manager.mutation(api.costs.execute, {
    programUuid: PROGRAM,
    payload: JSON.stringify({
      action: "budget.set",
      aircraftUuid: OWNED_AIRCRAFT,
      year: new Date().getFullYear(),
      amountCents: 500_000,
    }),
  });
  // A Form 337 copy on the owned aircraft and on one the board alone reads.
  for (const aircraftUuid of [OWNED_AIRCRAFT, "sample-aircraft-2"])
    await world.tech.action(api.aircraftFiles.upload, {
      aircraftUuid,
      programUuid: PROGRAM,
      category: "form-337",
      name: "337.pdf",
      type: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer,
    });
  const who = await world.t.run((ctx) =>
    addMember(ctx, "both", [owners, board]),
  );
  const read = async (client: typeof world.owner) =>
    (await client.query(api.operations.snapshot, {})) as Snapshot;
  return {
    world,
    both: await read(world.t.withIdentity(who)),
    owner: await read(world.owner),
    board: await read(world.board),
    client: world.t.withIdentity(who),
  };
}

// Server time and the member's own record differ between two reads.
const OWN = ["user", "members", "groups", "syncedAt", "authenticatedAt"];

it("sends an owner who sits on the board the two reduced views side by side, field by field", async () => {
  const { both, owner, board } = await ownerOnTheBoard();
  // No key beyond the two whitelists.
  expect(Object.keys(both).sort()).toEqual(
    [...new Set([...Object.keys(owner), ...Object.keys(board)])].sort(),
  );
  // The owner portal's records for the owned aircraft, the board's for the
  // rest: never the richer owner record for an aircraft they do not own.
  for (const list of RECORD_LISTS) {
    const owned = owner[list] ?? [];
    const ownedUuids = new Set(owned.map((r) => r.uuid));
    const rest = (board[list] ?? []).filter((r) => !ownedUuids.has(r.uuid));
    // The sample program has no completed work order to summarize.
    if (list !== "workOrders") expect(rest.length, list).toBeGreaterThan(0);
    expect(both[list], list).toEqual([...owned, ...rest]);
  }
  expect(both.aircraft).toEqual(
    board.aircraft.map(
      (a) => owner.aircraft.find((mine) => mine.uuid === a.uuid) ?? a,
    ),
  );
  expect(owner.aircraft.map((a) => a.uuid)).toEqual([OWNED_AIRCRAFT]);
  expect(both.aircraftFiles).toEqual(owner.aircraftFiles);
  expect(both.aircraftFiles?.map((f) => f.aircraftUuid)).toEqual([
    OWNED_AIRCRAFT,
  ]);
  expect(both.boardCosts).toEqual(board.boardCosts);
  expect(both.boardCosts?.[0].budgetCents).toBe(500_000);
  expect(both.offsiteBackupAt).toEqual(board.offsiteBackupAt);
  const shared = Object.keys(both).filter(
    (key) =>
      !OWN.includes(key) &&
      !["aircraft", "aircraftFiles", "boardCosts", ...RECORD_LISTS].includes(
        key,
      ),
  ) as (keyof Snapshot)[];
  for (const key of shared) expect(both[key], key).toEqual(board[key]);
});

it("gives them none of the workspace", async () => {
  const { both } = await ownerOnTheBoard();
  expect(both.flights).toEqual([]);
  expect(both.audit).toEqual([]);
  expect(both.members.map((m) => m.name)).toEqual(["both"]);
  expect(both.groups.map((g) => g.name).sort()).toEqual([
    "Aircraft owners",
    "Board (read-only)",
  ]);
  for (const key of [
    "taskCards",
    "archivedTaskCards",
    "taskEvidence",
    "manuals",
    "workOrderAttachments",
    "inventoryAttachments",
    "costs",
    "flightPlans",
    "checklists",
    "partsRequests",
    "purchaseOrders",
    "expiringItems",
    "faaMonitors",
  ] as const)
    expect(both[key], key).toBeUndefined();
  expect(both.workOrders?.every((w) => w.tasks.length === 0)).toBe(true);
  // File links only for the owned aircraft's Form 337 copies and photo.
  const urls = JSON.stringify(both).match(/https?:\/\/[^"]+/g) ?? [];
  const allowed = [
    ...(both.aircraftFiles ?? []).map((f) => f.url),
    ...both.aircraft.flatMap((a) => (a.photoUrl ? [a.photoUrl] : [])),
    ...(both.programs ?? []).map((p) => p.website),
  ];
  expect(urls.filter((url) => !allowed.includes(url))).toEqual([]);
  expect(
    both.aircraft.filter((a) => a.photoUrl).map((a) => a.uuid),
  ).not.toContain("sample-aircraft-2");
});

it("refuses them every program call, as it refuses an owner and a board member", async () => {
  const { world, client } = await ownerOnTheBoard();
  const page = { programUuid: PROGRAM, cursor: null, numItems: 5 };
  await expect(
    world.owner.query(api.auditHistory.page, page),
  ).rejects.toMatchObject({ data: "Aircraft owner access is read-only." });
  await expect(
    world.board.query(api.auditHistory.page, page),
  ).rejects.toMatchObject({ data: "Board access is read-only." });
  await expect(client.query(api.auditHistory.page, page)).rejects.toMatchObject(
    { data: "Aircraft owner access is read-only." },
  );
  await expect(
    client.query(api.savedAddresses.list, { programUuid: PROGRAM }),
  ).rejects.toMatchObject({ data: "Aircraft owner access is read-only." });
});

it("keeps each reduced view to the aircraft its own groups cover", async () => {
  const world = await seedSampleRoles();
  const { owners, board } = world.groups;
  // The board group reads only aircraft 2; the owner group names aircraft 1.
  await world.t.run((ctx) =>
    ctx.db.patch(board, { aircraftIds: ["sample-aircraft-2"] }),
  );
  const who = await world.t.run((ctx) =>
    addMember(ctx, "both", [owners, board]),
  );
  const both = (await world.t
    .withIdentity(who)
    .query(api.operations.snapshot, {})) as Snapshot;
  expect(both.aircraft.map((a) => a.uuid)).toEqual([
    OWNED_AIRCRAFT,
    "sample-aircraft-2",
  ]);
  // Spend is the board's: no totals for an aircraft only the owner group
  // names.
  expect(both.boardCosts?.map((c) => c.aircraftUuid)).toEqual([
    "sample-aircraft-2",
  ]);
  const owner = (await world.owner.query(
    api.operations.snapshot,
    {},
  )) as Snapshot;
  const ownedInspections = owner.inspections.map((i) => i.uuid);
  expect(ownedInspections.length).toBeGreaterThan(0);
  expect(
    both.inspections.filter((i) => ownedInspections.includes(i.uuid)),
  ).toEqual(owner.inspections);
});

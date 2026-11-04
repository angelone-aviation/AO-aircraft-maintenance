/**
 * Responsibility: Pins who gets the owner portal, the read-only rule for owner
 *   groups, and what the owner snapshot keeps and clears.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/ownerView.ts, ./model, ./programs, ./components,
 *   ./ownerDue, ./rejection, src/data/demo.ts (seed), tests/fixtures.
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot, withDemoUser } from "../data/demo";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { can, type Group, type Snapshot } from "./model";
import { scopedSnapshot } from "./programs";
import type { WorkOrder } from "./workOrders";
import type { ManagedRecord } from "./management";
import { requirementSchema } from "./components";
import { isOwnerView, validateOwnerGroup } from "./ownerView";
import { ownerDueItems } from "./ownerDue";
import { Rejection } from "./rejection";

const owned = "demo-206";
function workOrder(status: WorkOrder["status"], uuid: string): WorkOrder {
  return {
    uuid,
    version: 1,
    recordedAt: 1,
    createdBy: "demo-admin",
    number: "WO-" + uuid,
    aircraftUuid: owned,
    dateOpened: "2026-01-01",
    completionDate: status === "completed" ? "2026-02-01" : "",
    status,
    priority: "routine",
    scope: "Annual inspection",
    supervisor: "Chief inspector",
    releaseOutcome: "Internal release note",
    finalReview: "Internal review note",
    aircraft: {
      registration: "N206MA",
      make: "Cessna",
      model: "206",
      serial: "1",
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [
      {
        uuid: crypto.randomUUID(),
        source: { kind: "discrepancy", uuid: "x" },
        description: "Replace part",
        status: "completed",
        notes: "Internal task note",
        partsDelay: "",
      },
    ],
  };
}
function engineRequirement(): ManagedRecord {
  return requirementSchema.parse({
    uuid: "engine-life",
    kind: "componentRequirement",
    version: 1,
    componentUuid: "engine",
    aircraftUuid: owned,
    requirementType: "Life Limits",
    description: "Life limit",
    notes: "Internal requirement note",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    dueSeconds: 3600,
    warningCalendarMonths: 0,
    warningSeconds: 0,
    warningCycles: 0,
    requiredParts: [
      { locationUuid: "parts-location", stockUuid: "parts-stock", quantity: 1 },
    ],
  });
}
function ownerState(aircraftIds = [owned]): Snapshot {
  const s = partsFixture();
  const engine: ManagedRecord = {
    ...workOrderComponent(),
    notes: "Internal component note",
    locationUuid: "parts-location",
  };
  s.management = [...(s.management ?? []), engine];
  s.user = {
    ...s.user,
    id: "owner",
    isAdmin: false,
    groupIds: ["owners"],
  };
  s.members = [...s.members, s.user];
  s.groups = [
    ...s.groups,
    {
      id: "owners",
      name: "Aircraft owners",
      programUuid: "demo-program",
      owner: true,
      aircraftIds,
      permissions: ["read"],
    },
  ];
  s.discrepancies = [
    ...s.discrepancies,
    {
      uuid: "resolved",
      aircraftUuid: owned,
      description: "Old fix",
      status: "resolved",
      authorId: "demo-pilot",
      createdAt: 1,
      resolution: "Internal resolution",
    },
    {
      uuid: "other",
      aircraftUuid: "demo-208",
      description: "Other aircraft",
      status: "open",
      authorId: "demo-pilot",
      createdAt: 1,
    },
  ];
  s.workOrders = [
    workOrder("completed", crypto.randomUUID()),
    workOrder("open", crypto.randomUUID()),
  ];
  s.audit = [
    {
      uuid: "a",
      aircraftUuid: owned,
      actorId: "demo-admin",
      at: 1,
      action: "flight.created",
      entityUuid: "f",
    },
  ];
  s.purchaseOrders = [
    {
      uuid: "po",
      programUuid: "demo-program",
      phase: "issued",
      lines: [],
      receipts: [],
      shipments: [],
    },
  ] as never;
  s.partsRequests = [
    { uuid: "pr", programUuid: "demo-program", aircraftUuid: owned },
  ] as never;
  s.savedAddresses = [{ programUuid: "demo-program" }] as never;
  return s;
}

describe("owner view", () => {
  it("recognises only explicit owner-only membership in the active program", () => {
    const s = ownerState();
    expect(isOwnerView(s)).toBe(true);
    expect(isOwnerView({ ...s, user: { ...s.user, isAdmin: true } })).toBe(
      false,
    );
    // Mixed roles keep the full workspace.
    expect(
      isOwnerView({
        ...s,
        user: { ...s.user, groupIds: ["owners", "demo-pilots"] },
      }),
    ).toBe(false);
    // A read-only group without the owner flag is not inferred to be an owner.
    expect(
      isOwnerView({
        ...s,
        groups: s.groups.map((g) => ({ ...g, owner: false })),
      }),
    ).toBe(false);
  });

  it("counts only groups with read access in the active program, and never an inactive user", () => {
    const s = ownerState();
    const group = (
      id: string,
      programUuid: string,
      permissions: Group["permissions"],
    ): Group => ({ id, name: id, programUuid, aircraftIds: [], permissions });
    const elsewhere = {
      ...s,
      user: { ...s.user, groupIds: ["owners", "pilots-elsewhere", "no-read"] },
      groups: [
        ...s.groups,
        group("pilots-elsewhere", "other-program", ["read", "flight"]),
        group("no-read", "demo-program", []),
      ],
    };
    expect(isOwnerView(elsewhere)).toBe(true);
    expect(isOwnerView({ ...s, user: { ...s.user, active: false } })).toBe(
      false,
    );
  });

  it("scopes the snapshot to owned aircraft and strips management data", () => {
    const o = scopedSnapshot(ownerState());
    expect(o.aircraft.map((a) => a.uuid)).toEqual([owned]);
    expect(o.management?.map((r) => r.kind)).toEqual(["component"]);
    const engine = o.management![0];
    expect(engine.kind === "component" && engine.notes).toBe("");
    expect(engine.kind === "component" && engine.locationUuid).toBe(undefined);
    expect(o.purchaseOrders).toBeUndefined();
    expect(o.partsRequests).toBeUndefined();
    expect(o.savedAddresses).toBeUndefined();
    expect(o.partsInventory).toBeUndefined();
    expect(o.audit).toEqual([]);
    expect(o.flights).toEqual([]);
    expect(o.members.map((m) => m.id)).toEqual(["owner"]);
    expect(o.groups.map((g) => g.id)).toEqual(["owners"]);
    expect(o.discrepancies).toEqual([
      {
        uuid: "parts-report",
        aircraftUuid: owned,
        description: "Replace cabin filter",
        status: "open",
        createdAt: expect.any(Number),
        authorId: "",
      },
    ]);
    expect(o.workOrders).toHaveLength(1);
    const w = o.workOrders![0];
    expect(w.status).toBe("completed");
    expect(w.tasks).toEqual([]);
    expect(JSON.stringify(w)).not.toMatch(/Internal|Chief/);
    expect(JSON.stringify(o)).not.toMatch(/Internal|Private vendor/);
  });

  it("keeps what the owner's status needs: grounding, deferrals, requirements and unarchived inspections", () => {
    const s = ownerState();
    const deferral = {
      type: "mel" as const,
      melItem: "21-1",
      category: "C" as const,
      placard: "INOP",
      deferredOn: "2026-01-01",
      deferredAt: 0,
      deferredBy: "demo-admin",
      deferredByName: "Alex Morgan",
    };
    s.discrepancies = s.discrepancies.map((d) => ({
      ...d,
      grounding: true,
      deferral,
    }));
    s.management = [...(s.management ?? []), engineRequirement()];
    const inspection = { ...s.inspections[0], aircraftUuid: owned };
    s.inspections = [
      { ...inspection, uuid: "kept", materials: "Internal materials" },
      { ...inspection, uuid: "archived", archived: true },
    ];
    const o = scopedSnapshot(s);
    expect(o.discrepancies[0]).toEqual(
      expect.objectContaining({ grounding: true, deferral }),
    );
    expect(o.management?.map((r) => r.kind)).toEqual([
      "component",
      "componentRequirement",
    ]);
    expect(o.inspections.map((i) => i.uuid)).toEqual(["kept"]);
    expect(JSON.stringify(o)).not.toMatch(/Internal|parts-stock/);
  });

  it("shows the owner the current Form 337 copies of owned aircraft only", () => {
    const s = ownerState();
    const file = (aircraftUuid: string) => ({
      uuid: aircraftUuid + "-337",
      aircraftUuid,
      category: "form-337" as const,
      name: "337.pdf",
      type: "application/pdf",
      size: 10,
      uploadedAt: 1,
      url: "https://files.example.test/337.pdf",
    });
    s.aircraftFiles = [
      ...s.aircraft.map((a) => file(a.uuid)),
      // Archived copies stay in the app but are not shown to owners.
      {
        ...file(owned),
        uuid: "archived-337",
        archivedAt: 2,
        archivedBy: { userId: "demo-admin", name: "Alex Morgan" },
        archiveReason: "Superseded",
      },
    ];
    expect(s.aircraft.length).toBeGreaterThan(1);
    expect(scopedSnapshot(s).aircraftFiles).toEqual([file(owned)]);
  });

  it("treats an owner group without aircraft as no aircraft", () => {
    const s = ownerState([]);
    expect(scopedSnapshot(s).aircraft).toEqual([]);
    expect(can(s, owned, "read")).toBe(false);
  });

  it("grants no write permission", () => {
    const s = ownerState();
    for (const p of [
      "flight",
      "discrepancy",
      "resolve",
      "maintenance",
    ] as const)
      expect(can(s, owned, p)).toBe(false);
    expect(can(s, owned, "read")).toBe(true);
    expect(can(s, "demo-208", "read")).toBe(false);
  });

  it("keeps other users' snapshots unchanged", () => {
    const s = ownerState();
    const pilot = { ...s, user: { ...s.user, groupIds: ["demo-pilots"] } };
    const scoped = scopedSnapshot(pilot);
    expect(scoped.aircraft).toHaveLength(3);
    expect(scoped.audit).toHaveLength(1);
    expect(scoped.workOrders).toHaveLength(2);
    expect(scoped.discrepancies.some((d) => d.resolution)).toBe(true);
  });

  it("rejects owner groups with write or administrator permissions", () => {
    expect(() =>
      validateOwnerGroup({ owner: true, permissions: ["read"] }),
    ).not.toThrow();
    expect(() =>
      validateOwnerGroup({ owner: true, permissions: ["read", "maintenance"] }),
    ).toThrow("read-only");
    expect(() =>
      validateOwnerGroup({
        owner: true,
        programAdmin: true,
        permissions: ["read"],
      }),
    ).toThrow("read-only");
    const flight = () =>
      validateOwnerGroup({ owner: true, permissions: ["read", "flight"] });
    expect(flight).toThrow(Rejection);
    expect(flight).toThrow(
      /^Aircraft owner groups are read-only: remove administrator and write permissions\.$/,
    );
    expect(() =>
      validateOwnerGroup({ permissions: ["read", "maintenance"] }),
    ).not.toThrow();
  });

  it("lists due items worst first with remaining values", () => {
    const s = demoSnapshot();
    const a = s.aircraft.find((x) => x.uuid === owned)!;
    const items = ownerDueItems(s, a, "2026-01-01");
    expect(items.map((i) => i.label)).toEqual([
      "100-hour inspection",
      "Annual inspection",
    ]);
    expect(items[0].status).toBe("due-soon");
    expect(items[0].remaining).toBe("8.8 h");
  });

  it("previews the demo as a sample owner and switches back", () => {
    const owner = scopedSnapshot(withDemoUser(demoSnapshot(), true));
    expect(isOwnerView(owner)).toBe(true);
    expect(owner.aircraft.map((a) => a.uuid)).toEqual([owned]);
    const admin = scopedSnapshot(
      withDemoUser(withDemoUser(demoSnapshot(), true), false),
    );
    expect(admin.user.isAdmin).toBe(true);
    expect(admin.aircraft).toHaveLength(3);
  });
});

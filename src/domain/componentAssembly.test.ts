/**
 * Responsibility: Pins assemblies of attached parts: they move only with their
 *   parent, keep their own life limits, and freeze at a removal's readings.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/components.ts, ./management, ./workOrders, ./model,
 *   src/data/demo.ts, tests/fixtures/workOrders.ts,
 *   tests/fixtures/componentMovement.ts.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import {
  applyThroughWorkOrder,
  movementOrderCommand,
} from "../../tests/fixtures/componentMovement";
import { saveWorkOrder } from "./workOrders";
import { totalSeconds } from "./model";
import { applyManagement, type ManagedRecord } from "./management";
import {
  componentTotals,
  validateComponent,
  type Component,
  type ComponentRequirement,
} from "./components";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const TODAY = "2026-10-16";
const HOUR_SECONDS = 3600;
const STORE_UUID = "store";

/**
 * An installed engine (MAIN) with an attached disk that holds a hub; the disk
 * has a 1,000-hour TSN life limit, and a "store" location takes removals.
 */
function fixture() {
  const s = demoSnapshot();
  const parent = {
    ...workOrderComponent(),
    programUuid: "demo-program",
    installPosition: "MAIN" as const,
  };
  const child: Component = {
    ...parent,
    uuid: "disk",
    parentComponentUuid: parent.uuid,
    model: "Compressor disk",
    partNumber: "DISK",
    serial: "D1",
    timeSinceNew: 50 * HOUR_SECONDS,
    timeSinceOverhaul: null,
  };
  const grandchild: Component = {
    ...child,
    uuid: "hub",
    parentComponentUuid: child.uuid,
    partNumber: "HUB",
    serial: "H1",
  };
  const requirement = diskLifeLimit(parent.aircraftUuid, child.uuid);
  s.management = [parent, child, grandchild, requirement, storeLocation()];
  return { s, parent, child, grandchild, requirement };
}

function diskLifeLimit(
  aircraftUuid: string,
  componentUuid: string,
): ComponentRequirement {
  return {
    kind: "componentRequirement",
    uuid: "disk-life",
    version: 1,
    programUuid: "demo-program",
    aircraftUuid,
    componentUuid,
    requirementType: "Life Limits",
    description: "Disk life limit",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    intervalSeconds: 1000 * HOUR_SECONDS,
    dueSeconds: 1000 * HOUR_SECONDS,
    warningCalendarMonths: 1,
    warningSeconds: 100 * HOUR_SECONDS,
    warningCycles: 100,
  };
}

function storeLocation(): ManagedRecord {
  return {
    kind: "location",
    uuid: STORE_UUID,
    version: 1,
    programUuid: "demo-program",
    name: "Store",
    address: "",
    contact: "",
  };
}
it("moves nested attached parts through removal and installation work orders, preserving independent life limits", () => {
  const { s, parent, child, grandchild } = fixture();
  const before = componentTotals(child, s.aircraft[0], TODAY);
  const move = (
    uuid: string,
    operation: "install" | "remove",
    aircraftUuid?: string,
  ) => {
    const c = s.management!.find((r) => r.uuid === uuid) as Component;
    return applyThroughWorkOrder(
      s,
      {
        action: "component.service",
        requestUuid: crypto.randomUUID(),
        reason: "Verified assembly movement",
        uuid,
        version: c.version,
        operation,
        date: TODAY,
        aircraftUuid,
        locationUuid: operation === "remove" ? STORE_UUID : undefined,
        installPosition: operation === "install" ? "MAIN" : undefined,
      },
      NOW,
    );
  };
  move(parent.uuid, "remove");
  for (const id of [child.uuid, grandchild.uuid]) {
    const c = s.management!.find((r) => r.uuid === id) as Component;
    expect(c).toMatchObject({ installed: false, locationUuid: STORE_UUID });
    expect(componentTotals(c, s.aircraft[0], TODAY).timeSinceNew).toBe(
      before.timeSinceNew,
    );
  }
  const second = s.aircraft[1];
  move(parent.uuid, "install", second.uuid);
  const installed = s.management!.find(
    (r) => r.uuid === child.uuid,
  ) as Component;
  expect(installed).toMatchObject({
    installed: true,
    aircraftUuid: second.uuid,
    parentComponentUuid: parent.uuid,
  });
  expect(componentTotals(installed, second, TODAY).timeSinceNew).toBe(
    before.timeSinceNew,
  );
  expect(s.management!.find((r) => r.uuid === "disk-life")).toMatchObject({
    aircraftUuid: second.uuid,
    dueSeconds: 1000 * HOUR_SECONDS,
  });
  second.currentHobbs += HOUR_SECONDS;
  second.cycles += 1;
  expect(componentTotals(installed, second, TODAY).timeSinceNew).toBe(
    before.timeSinceNew! + HOUR_SECONDS,
  );
  expect(
    s
      .management!.filter(
        (r) => r.kind === "componentMovement" && r.componentUuid === child.uuid,
      )
      .map((r) => r.kind === "componentMovement" && r.action),
  ).toEqual(expect.arrayContaining(["REMOVE", "INSTALL"]));
});
it("rejects independent movements, reparenting, cross-program parents, and location mismatch", () => {
  const { s, parent, child } = fixture();
  expect(() =>
    validateComponent(
      s,
      { ...child, parentComponentUuid: undefined },
      child,
      NOW,
    ),
  ).toThrow(/parent/);
  expect(() =>
    validateComponent(
      s,
      { ...child, locationUuid: STORE_UUID },
      undefined,
      NOW,
    ),
  ).toThrow();
  const other = { ...parent, uuid: "other", programUuid: "another-program" };
  s.management!.push(other);
  expect(() =>
    validateComponent(
      s,
      { ...child, parentComponentUuid: "other" },
      undefined,
      NOW,
    ),
  ).toThrow(/same Flight Program/);
  expect(() =>
    applyThroughWorkOrder(
      s,
      {
        action: "component.service",
        requestUuid: crypto.randomUUID(),
        reason: "Remove just the child",
        uuid: child.uuid,
        version: child.version,
        operation: "remove",
        date: TODAY,
        locationUuid: STORE_UUID,
      },
      NOW,
    ),
  ).toThrow(/parent/);
});
it("parent overhaul does not reset child TSN or life requirements", () => {
  const { s, parent, child } = fixture();
  applyThroughWorkOrder(
    s,
    {
      action: "component.service",
      requestUuid: crypto.randomUUID(),
      reason: "Remove assembly for shop",
      uuid: parent.uuid,
      version: parent.version,
      operation: "remove",
      date: TODAY,
      locationUuid: STORE_UUID,
    },
    NOW,
  );
  const before = structuredClone(
    s.management!.find((r) => r.uuid === child.uuid),
  );
  const requirement = structuredClone(
    s.management!.find((r) => r.uuid === "disk-life"),
  );
  const p = s.management!.find((r) => r.uuid === parent.uuid) as Component;
  applyManagement(
    s,
    {
      action: "component.service",
      requestUuid: crypto.randomUUID(),
      reason: "Parent overhauled in shop",
      uuid: p.uuid,
      version: p.version,
      operation: "overhaul",
      date: TODAY,
    },
    NOW,
  );
  expect(s.management!.find((r) => r.uuid === child.uuid)).toEqual(before);
  expect(s.management!.find((r) => r.uuid === "disk-life")).toEqual(
    requirement,
  );
});
it("freezes attached parts at the completion readings of a backdated removal", () => {
  const { s, parent, child } = fixture();
  const a = s.aircraft[0];
  const before = componentTotals(child, a, "2026-10-15");
  const completionReadings = {
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cycles: a.cycles,
  };
  const close = movementOrderCommand(s, {
    action: "component.service",
    requestUuid: crypto.randomUUID(),
    reason: "Verified assembly movement",
    uuid: parent.uuid,
    version: parent.version,
    operation: "remove",
    date: "2026-10-15",
    locationUuid: STORE_UUID,
  });
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
    },
    NOW,
  );
  // Flights after the backdated removal must not accrue to the attached part.
  a.currentHobbs += 2 * HOUR_SECONDS;
  a.cycles += 2;
  saveWorkOrder(
    s,
    { ...close, version: open.version, completionReadings },
    NOW,
  );
  const removed = s.management!.find((r) => r.uuid === child.uuid) as Component;
  expect(componentTotals(removed, a, TODAY)).toMatchObject({
    timeSinceNew: before.timeSinceNew,
    cyclesSinceNew: before.cyclesSinceNew,
  });
});

import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import {
  applyThroughWorkOrder,
  movementOrderCommand,
} from "../../tests/fixtures/componentMovement";
import { saveWorkOrder } from "./workOrders";
import { totalSeconds } from "./model";
import { applyManagement } from "./management";
import {
  componentTotals,
  validateComponent,
  type Component,
  type ComponentRequirement,
} from "./components";
const now = Date.parse("2026-10-16T12:00:00Z"),
  date = "2026-10-16";
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
    timeSinceNew: 50 * 3600,
    timeSinceOverhaul: null,
  };
  const grandchild: Component = {
    ...child,
    uuid: "hub",
    parentComponentUuid: child.uuid,
    partNumber: "HUB",
    serial: "H1",
  };
  const requirement: ComponentRequirement = {
    kind: "componentRequirement",
    uuid: "disk-life",
    version: 1,
    programUuid: "demo-program",
    aircraftUuid: parent.aircraftUuid,
    componentUuid: child.uuid,
    requirementType: "Life Limits",
    description: "Disk life limit",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    intervalSeconds: 1000 * 3600,
    dueSeconds: 1000 * 3600,
    warningCalendarMonths: 1,
    warningSeconds: 100 * 3600,
    warningCycles: 100,
  };
  s.management = [
    parent,
    child,
    grandchild,
    requirement,
    {
      kind: "location",
      uuid: "store",
      version: 1,
      programUuid: "demo-program",
      name: "Store",
      address: "",
      contact: "",
    },
  ];
  return { s, parent, child, grandchild, requirement };
}
it("moves nested attached parts through removal and installation work orders, preserving independent life limits", () => {
  const { s, parent, child, grandchild } = fixture();
  const before = componentTotals(child, s.aircraft[0], date);
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
        date,
        aircraftUuid,
        locationUuid: operation === "remove" ? "store" : undefined,
        installPosition: operation === "install" ? "MAIN" : undefined,
      },
      now,
    );
  };
  move(parent.uuid, "remove");
  for (const id of [child.uuid, grandchild.uuid]) {
    const c = s.management!.find((r) => r.uuid === id) as Component;
    expect(c).toMatchObject({ installed: false, locationUuid: "store" });
    expect(componentTotals(c, s.aircraft[0], date).timeSinceNew).toBe(
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
  expect(componentTotals(installed, second, date).timeSinceNew).toBe(
    before.timeSinceNew,
  );
  expect(s.management!.find((r) => r.uuid === "disk-life")).toMatchObject({
    aircraftUuid: second.uuid,
    dueSeconds: 1000 * 3600,
  });
  second.currentHobbs += 3600;
  second.cycles += 1;
  expect(componentTotals(installed, second, date).timeSinceNew).toBe(
    before.timeSinceNew! + 3600,
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
      now,
    ),
  ).toThrow(/parent/);
  expect(() =>
    validateComponent(s, { ...child, locationUuid: "store" }, undefined, now),
  ).toThrow();
  const other = { ...parent, uuid: "other", programUuid: "another-program" };
  s.management!.push(other);
  expect(() =>
    validateComponent(
      s,
      { ...child, parentComponentUuid: "other" },
      undefined,
      now,
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
        date,
        locationUuid: "store",
      },
      now,
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
      date,
      locationUuid: "store",
    },
    now,
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
      date,
    },
    now,
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
    locationUuid: "store",
  });
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
    },
    now,
  );
  // Flights after the backdated removal must not accrue to the attached part.
  a.currentHobbs += 7200;
  a.cycles += 2;
  saveWorkOrder(
    s,
    { ...close, version: open.version, completionReadings },
    now,
  );
  const removed = s.management!.find((r) => r.uuid === child.uuid) as Component;
  expect(componentTotals(removed, a, date)).toMatchObject({
    timeSinceNew: before.timeSinceNew,
    cyclesSinceNew: before.cyclesSinceNew,
  });
});

/**
 * Responsibility: Pins that a component's shop service and baseline entries
 *   in its movement history carry the user's local date, not the date of the
 *   server's clock, which is already the next day on a US evening.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/management.ts, components.ts, model.ts,
 *   src/data/demo.ts, tests/fixtures/workOrders.ts.
 */
import { expect, it } from "vitest";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { demoSnapshot } from "../data/demo";
import type { Component, ComponentMovement } from "./components";
import { applyManagement, type ManagementCommand } from "./management";

// 18:00 on 10 Nov in Los Angeles is 02:00 on 11 Nov in UTC.
const NOW = Date.parse("2026-11-11T02:00:00Z");
const USER_TODAY = "2026-11-10";

function inventoryEngine() {
  const s = demoSnapshot();
  s.inspections = [];
  const engine: Component = {
    ...workOrderComponent(),
    programUuid: "demo-program",
    installed: false,
    aircraftUuid: "",
    locationUuid: undefined,
    partsLocation: "Shelf 1",
  };
  s.management = [engine];
  return { s, engine };
}

function movements(s: ReturnType<typeof demoSnapshot>) {
  return (s.management ?? []).filter(
    (r): r is ComponentMovement => r.kind === "componentMovement",
  );
}

const common = (engine: Component) => ({
  requestUuid: crypto.randomUUID(),
  reason: "Overhauled by the shop, 8130 on file",
  uuid: engine.uuid,
  version: engine.version,
});

it("dates a shop overhaul's movement on the date entered", () => {
  const { s, engine } = inventoryEngine();
  applyManagement(
    s,
    {
      ...common(engine),
      action: "component.service",
      operation: "overhaul",
      date: USER_TODAY,
    },
    NOW,
  );
  expect(movements(s)).toMatchObject([
    { action: "OVERHAUL", date: USER_TODAY },
  ]);
});

it("dates a baseline's movement on the user's date, and refuses another day", () => {
  const { s, engine } = inventoryEngine();
  const baseline = (date?: string): ManagementCommand => ({
    ...common(engine),
    action: "component.baseline",
    installedSeconds: engine.installedSeconds,
    installedCycles: engine.installedCycles,
    timeSinceNew: engine.timeSinceNew,
    timeSinceOverhaul: engine.timeSinceOverhaul,
    timeSinceRepair: engine.timeSinceRepair,
    cyclesSinceNew: engine.cyclesSinceNew,
    serviceDaysBase: engine.serviceDaysBase,
    date,
  });
  expect(() => applyManagement(s, baseline("2026-11-01"), NOW)).toThrow(
    "The baseline date must be today.",
  );
  applyManagement(s, baseline(USER_TODAY), NOW);
  expect(movements(s)).toMatchObject([
    { action: "BASELINE", date: USER_TODAY },
  ]);
});

it("still accepts a baseline from a client that sends no date", () => {
  const { s, engine } = inventoryEngine();
  const command: ManagementCommand = {
    ...common(engine),
    action: "component.baseline",
    installedSeconds: engine.installedSeconds,
    installedCycles: engine.installedCycles,
    timeSinceNew: engine.timeSinceNew,
    timeSinceOverhaul: engine.timeSinceOverhaul,
    timeSinceRepair: engine.timeSinceRepair,
    cyclesSinceNew: engine.cyclesSinceNew,
    serviceDaysBase: engine.serviceDaysBase,
  };
  applyManagement(s, command, NOW);
  expect(movements(s)).toHaveLength(1);
});

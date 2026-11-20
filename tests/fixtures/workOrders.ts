/**
 * Responsibility: A new work-order save command and an installed engine for
 *   work-order tests.
 * Layer: Test. Fixture over the demo seed.
 * Dependencies: src/data/demo (demoSnapshot), src/domain (workOrders and
 *   components types, model totalSeconds).
 */
import { demoSnapshot } from "../../src/data/demo";
import type {
  WorkOrderCommand,
  WorkOrderFields,
} from "../../src/domain/workOrders";
import type { Component } from "../../src/domain/components";
import { totalSeconds } from "../../src/domain/model";

const HOUR_SECONDS = 3600;

/**
 * A save for a new, open, routine order on the demo's first aircraft, opened
 * 2026-01-01, with no number, tasks or components; tests fill in the rest.
 * @returns A fresh command with a new order id on each call.
 */
export function workOrderCommand(): Extract<
  WorkOrderCommand,
  { action: "save" }
> {
  const fields: WorkOrderFields = {
    number: "",
    aircraftUuid: demoSnapshot().aircraft[0].uuid,
    dateOpened: "2026-01-01",
    supervisor: "Supervisor",
    scope: "Annual maintenance",
    priority: "routine",
    status: "open",
    completionDate: "",
    releaseOutcome: "",
  };
  return {
    action: "save",
    uuid: crypto.randomUUID(),
    version: 0,
    fields,
    componentUuids: [],
    tasks: [],
  };
}

/**
 * An engine (uuid "engine", serial SN) installed on the first demo aircraft 10
 * hours and 10 cycles ago, with 100 hours since new and 20 since overhaul at
 * installation, so it reads 110 and 30 hours now.
 */
export function workOrderComponent(): Component {
  const a = demoSnapshot().aircraft[0];
  return {
    uuid: "engine",
    version: 0,
    kind: "component",
    aircraftUuid: a.uuid,
    componentType: "Engine",
    partNumber: "PN",
    serial: "SN",
    manufacturer: "",
    notes: "",
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a) - 10 * HOUR_SECONDS,
    installedCycles: a.cycles - 10,
    timeSinceNew: 100 * HOUR_SECONDS,
    timeSinceOverhaul: 20 * HOUR_SECONDS,
    timeSinceRepair: null,
    cyclesSinceNew: 30,
    serviceDaysBase: 0,
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
  };
}

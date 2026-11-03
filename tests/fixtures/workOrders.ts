import { demoSnapshot } from "../../src/data/demo";
import type {
  WorkOrderCommand,
  WorkOrderFields,
} from "../../src/domain/workOrders";
import type { Component } from "../../src/domain/components";
import { totalSeconds } from "../../src/domain/model";
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
    finalReview: "",
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
    installedSeconds: totalSeconds(a) - 36000,
    installedCycles: a.cycles - 10,
    timeSinceNew: 100 * 3600,
    timeSinceOverhaul: 20 * 3600,
    timeSinceRepair: null,
    cyclesSinceNew: 30,
    serviceDaysBase: 0,
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
  };
}

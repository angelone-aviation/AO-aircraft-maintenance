/**
 * Responsibility: Pins close-out component corrections: the replay at
 *   completion, later usage kept, and every refusal with its message.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrderComponentCorrections.ts, ./workOrders,
 *   ./components, ./logbook, ./rejection, src/data/demo.ts (seed),
 *   tests/fixtures/workOrders.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
} from "./workOrders";
import {
  componentTotals,
  type Component,
  type ComponentRequirement,
} from "./components";
import {
  previewComponentCorrection,
  type ComponentCorrectionCommand,
} from "./workOrderComponentCorrections";
import type { Snapshot } from "./model";
import { logbookText } from "./logbook";
import { Rejection, STALE_RECORD_MESSAGE } from "./rejection";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup(
  action: "overhaul" | "repair" | "service" | "both" = "overhaul",
) {
  const s = demoSnapshot();
  const c = { ...workOrderComponent(), timeSinceRepair: 5 * 3600 };
  const requirement: ComponentRequirement = {
    uuid: "overhaul-due",
    version: 1,
    kind: "componentRequirement",
    componentUuid: c.uuid,
    aircraftUuid: c.aircraftUuid,
    requirementType: "Overhaul Requirement",
    description: "Overhaul due",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    calendarIntervalValue: 12,
    lastDate: "2025-01-01",
    dueDate: "2026-01-31",
    lastSeconds: 0,
    lastCycles: 0,
    timeBasis: "TSO",
    timeLimitMode: "FROM_LAST_COMPLIED",
    intervalSeconds: 100 * 3600,
    dueSeconds: 100 * 3600,
    intervalCycles: 100,
    dueCycles: 100,
    cycleLimitMode: "FROM_LAST_COMPLIED",
    warningCalendarMonths: 1,
    warningSeconds: 0,
    warningCycles: 0,
  };
  s.management = [c, requirement];
  const cmd = workOrderCommand();
  cmd.componentUuids = [c.uuid];
  const open = saveWorkOrder(s, cmd, now);
  const closed = saveWorkOrder(
    s,
    {
      ...cmd,
      version: open.version,
      fields: {
        ...workOrderFieldsSchema.parse(open),
        status: "completed",
        completionDate: "2026-10-02",
        releaseOutcome: "Reviewed",
        finalReview: "Reviewed",
      },
      componentWork: [
        {
          componentUuid: c.uuid,
          version: c.version,
          action,
          description: "Bench work",
          reference: "AMM",
        },
      ],
    },
    now,
  );
  return { s, closed, c, requirement };
}
function command(
  s: Snapshot,
  order: WorkOrder,
  action: ComponentCorrectionCommand["choice"]["action"] = "repair",
): ComponentCorrectionCommand {
  const c = s.management!.find((r) => r.kind === "component")!;
  return {
    action: "correctComponent",
    uuid: order.uuid,
    version: order.version,
    aircraftVersion: s.aircraft[0].version,
    reason: "Selection was incorrect",
    choice: {
      componentUuid: c.uuid,
      version: c.version,
      action,
      description: "Correct work",
      reference: "AMM",
    },
  };
}
it("restores overhaul baseline and requirements, resets repair at completion, and retains later flight usage", () => {
  const { s, closed, c, requirement } = setup();
  const before = closed.closeout!.componentWork![0].before;
  s.aircraft[0].currentHobbs += 2 * 3600;
  s.aircraft[0].cycles += 3;
  s.aircraft[0].version++;
  const snapshot = structuredClone(s);
  const preview = previewComponentCorrection(
    s,
    closed,
    command(s, closed),
    now + 1000,
  );
  expect(s).toEqual(snapshot);
  expect(preview.correction.completionAfter.timeSinceOverhaul).toBe(
    before.timeSinceOverhaul,
  );
  expect(preview.correction.completionAfter.timeSinceRepair).toBe(0);
  expect(preview.correction.currentAfter.timeSinceOverhaul).toBe(
    before.timeSinceOverhaul! + 7200,
  );
  expect(preview.correction.currentAfter.timeSinceRepair).toBe(7200);
  const corrected = saveWorkOrder(s, command(s, closed), now + 1000);
  expect(corrected.closeout).toEqual(closed.closeout);
  const current = s.management!.find((r) => r.uuid === c.uuid) as Component;
  expect(componentTotals(current, s.aircraft[0]).timeSinceRepair).toBe(7200);
  const restored = s.management!.find((r) => r.uuid === requirement.uuid)!;
  expect(restored).toEqual({ ...requirement, version: 3 });
  const originalMovement = s.management!.find(
    (r) => r.kind === "componentMovement" && r.action === "OVERHAUL",
  );
  expect(originalMovement).toHaveProperty("supersededByCorrection");
  const text = logbookText(s, corrected, "maintenance", {
    name: "Tech",
    licenseNumber: "123",
    certificateType: "A&P",
  });
  expect(text).toContain("Overhauled corrected to Repaired");
  expect(text).toContain("COMPONENT TRACKING CORRECTIONS");
  const second = saveWorkOrder(s, command(s, corrected, "service"), now + 2000);
  expect(second.componentCorrections).toHaveLength(2);
  expect(second.componentCorrections![1].currentAfter.timeSinceRepair).toBe(
    before.timeSinceRepair! + 7200,
  );
});
it.each(["service", "repair", "overhaul", "both"] as const)(
  "corrects %s to another action without changing lifetime usage",
  (action) => {
    const { s, closed } = setup(action);
    const next = action === "repair" ? "overhaul" : "repair";
    const result = previewComponentCorrection(
      s,
      closed,
      command(s, closed, next),
      now + 1000,
    ).correction;
    expect(result.currentAfter.timeSinceNew).toBe(
      result.currentBefore.timeSinceNew,
    );
    expect(result.currentAfter.cyclesSinceNew).toBe(
      result.currentBefore.cyclesSinceNew,
    );
    expect(result.currentAfter.serviceDays).toBe(
      result.currentBefore.serviceDays,
    );
  },
);
it.each([
  "component",
  "requirement",
  "movement",
  "laterOrder",
  "legacy",
  "staleAircraft",
  "staleOrder",
  "reason",
  "permissions",
] as const)("blocks unsafe %s corrections atomically", (mode) => {
  const { s, closed } = setup();
  const cmd = command(s, closed);
  if (mode === "component") s.management![0].version++;
  if (mode === "requirement") s.management![1].version++;
  if (mode === "movement") {
    const m = s.management!.find((r) => r.kind === "componentMovement")!;
    s.management!.push({ ...m, uuid: "later", at: now + 1000 });
  }
  if (mode === "laterOrder")
    s.workOrders!.push({ ...closed, uuid: crypto.randomUUID() });
  if (mode === "legacy")
    delete closed.closeout!.componentWork![0].trackingBaseline;
  if (mode === "staleAircraft") s.aircraft[0].version++;
  if (mode === "staleOrder") cmd.version--;
  if (mode === "reason") cmd.reason = " ";
  if (mode === "permissions") {
    s.user.isAdmin = false;
    s.user.groupIds = [];
    s.groups = [];
  }
  const before = structuredClone(s);
  expect(() => saveWorkOrder(s, cmd, now + 2000)).toThrow();
  expect(s).toEqual(before);
});
it.each([
  [
    "open order",
    "A completed work order with saved closeout readings is required.",
  ],
  ["staleOrder", STALE_RECORD_MESSAGE],
  ["otherComponent", "This component was not recorded at closeout."],
  ["movement", "Record component movement changes through a new work order."],
  [
    "legacy",
    "Manual review required: this older closeout does not contain the pre-service component and requirement records needed for a safe tracking correction.",
  ],
  [
    "unchanged",
    "Change the component work performed before previewing a correction.",
  ],
  ["staleComponent", STALE_RECORD_MESSAGE],
  [
    "requirement",
    "Manual review required: component tracking or service requirements changed after this closeout. Later records will not be overwritten.",
  ],
  [
    "laterOrder",
    "Manual review required: later component maintenance or movement exists. Review those events before correcting this closeout.",
  ],
] as const)("refuses a %s correction with its message", (mode, message) => {
  const { s, closed } = setup();
  let order = closed;
  const cmd = command(s, closed);
  if (mode === "open order") order = { ...closed, status: "open" };
  if (mode === "staleOrder") cmd.version--;
  if (mode === "otherComponent") cmd.choice.componentUuid = "other";
  if (mode === "movement") cmd.choice.action = "remove";
  if (mode === "legacy")
    delete closed.closeout!.componentWork![0].trackingBaseline;
  if (mode === "unchanged")
    cmd.choice = {
      ...cmd.choice,
      action: "overhaul",
      description: "Bench work",
    };
  if (mode === "staleComponent") cmd.choice.version++;
  if (mode === "requirement") s.management![1].version++;
  if (mode === "laterOrder")
    s.workOrders!.push({ ...closed, uuid: crypto.randomUUID() });
  const preview = () => previewComponentCorrection(s, order, cmd, now + 1000);
  expect(preview).toThrow(Rejection);
  expect(preview).toThrow(
    new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  );
});

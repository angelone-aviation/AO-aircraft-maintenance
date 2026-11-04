/**
 * Responsibility: Pins component removal and installation through work orders:
 *   the inventory tag, cancellation, stale closeouts and access refusals.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrders.ts, ./management, ./inventoryPrinting,
 *   tests/fixtures/requiredParts.ts, tests/fixtures/workOrders.ts,
 *   tests/fixtures/componentMovement.ts.
 */
import { expect, it } from "vitest";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { movementOrderCommand } from "../../tests/fixtures/componentMovement";
import { saveWorkOrder } from "./workOrders";
import { applyManagement } from "./management";
import { inventoryTagFields } from "./inventoryPrinting";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const TODAY = "2026-10-08";

/**
 * An engine installed LEFT, a command removing it today to the parts location
 * (bin A), and the completed work order that carries that removal.
 */
function setup() {
  const s = partsFixture();
  const c = { ...workOrderComponent(), installPosition: "LEFT" as const };
  s.management!.push(c);
  const service = {
    action: "component.service" as const,
    uuid: c.uuid,
    version: c.version,
    operation: "remove" as const,
    date: TODAY,
    reason: "Removed for workshop inspection",
    requestUuid: crypto.randomUUID(),
    locationUuid: "parts-location",
    partsLocation: "Bin A",
  };
  const close = movementOrderCommand(s, service);
  return { s, c, service, close };
}
it("requires a work order, leaves planned removals installed, and preserves aircraft tag and logbook history", () => {
  const { s, c, service, close } = setup();
  expect(() => applyManagement(s, service, NOW)).toThrow(
    "through a work order",
  );
  expect(() =>
    applyManagement(
      s,
      {
        action: "record.save",
        record: { ...c, uuid: "new-installed" },
        requestUuid: crypto.randomUUID(),
        reason: "Try direct installation",
      },
      NOW,
    ),
  ).toThrow("through a work order");
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
      tasks: close.tasks.map((t) => ({ ...t, status: "requested" })),
    },
    NOW,
  );
  expect(s.management!.find((r) => r.uuid === c.uuid)).toEqual(c);
  const final = saveWorkOrder(s, { ...close, version: open.version }, NOW);
  const stored = s.management!.find((r) => r.uuid === c.uuid)!;
  if (stored.kind !== "component") throw new Error("Missing component");
  expect(stored).toMatchObject({
    installed: false,
    locationUuid: "parts-location",
    partsLocation: "Bin A",
  });
  const tag = inventoryTagFields(s, stored);
  expect(tag).toMatchObject({
    lastOperator: s.aircraft[0].registration,
    nhaSerial: s.aircraft[0].serial,
    position: "LEFT",
    removalDate: TODAY,
    reference: final.number,
  });
  s.aircraft[0].registration = "CHANGED";
  s.aircraft[0].serial = "CHANGED";
  expect(inventoryTagFields(s, stored)).toEqual(tag);
  expect(final.closeout!.workPerformed).toContain("Removed from aircraft");
  expect(final.closeout!.workPerformed).toContain(c.serial);
  expect(final.closeout!.workPerformed).toContain(tag.lastOperator);
  expect(
    s.management!.find((r) => r.kind === "componentMovement"),
  ).toMatchObject({ workOrderUuid: final.uuid, installPosition: "LEFT" });
});
it("cancellation leaves inventory unchanged; stale closeout fails atomically", () => {
  const { s, c, close } = setup();
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
    },
    NOW,
  );
  saveWorkOrder(
    s,
    {
      ...close,
      version: open.version,
      fields: { ...close.fields, status: "cancelled" },
      tasks: close.tasks.map((t) => ({ ...t, status: "cancelled" })),
    },
    NOW,
  );
  expect(s.management!.find((r) => r.uuid === c.uuid)).toEqual(c);
  const next = {
    ...close,
    uuid: crypto.randomUUID(),
    fields: { ...close.fields, status: "open" as const, completionDate: "" },
  };
  c.version++;
  const before = structuredClone(s);
  expect(() => saveWorkOrder(s, next, NOW)).toThrow("tracking changed");
  expect(s).toEqual(before);
});
it("uses saved manual incoming tag details before a system removal", () => {
  const { s, c } = setup();
  c.installed = false;
  const manual = {
    ...c,
    aircraftUuid: "",
    incomingTag: {
      lastOperator: "N12345",
      nhaSerial: "AIRFRAME-77",
      reference: "8130 received",
      reason: "Overhaul paperwork",
    },
  };
  expect(inventoryTagFields(s, manual)).toMatchObject(manual.incomingTag);
});

it("rejects foreign-program stock and inaccessible source aircraft when planning installation", () => {
  const { s, c, close } = setup();
  c.installed = false;
  c.programUuid = "other-program";
  const plan = {
    ...close,
    fields: { ...close.fields, status: "open" as const, completionDate: "" },
    componentWork: close.componentWork!.map((w) => ({
      ...w,
      action: "install" as const,
      installPosition: "LEFT" as const,
    })),
  };
  expect(() => saveWorkOrder(s, plan, NOW)).toThrow(
    "maintenance access denied",
  );
  c.programUuid = s.aircraft[0].programUuid;
  c.aircraftUuid = s.aircraft[1].uuid;
  s.user.isAdmin = false;
  s.user.groupIds = ["limited"];
  s.groups = [
    {
      id: "limited",
      name: "Limited maintenance",
      programUuid: s.aircraft[0].programUuid,
      aircraftIds: [s.aircraft[0].uuid],
      permissions: ["read", "maintenance"],
    },
  ];
  expect(() => saveWorkOrder(s, plan, NOW)).toThrow(
    "Component maintenance access denied",
  );
});

it("retains long work descriptions in the movement and logbook", () => {
  const { s, close } = setup();
  close.componentWork![0].description = "Detailed maintenance work. ".repeat(
    100,
  );
  const open = saveWorkOrder(
    s,
    {
      ...close,
      fields: { ...close.fields, status: "open", completionDate: "" },
    },
    NOW,
  );
  const final = saveWorkOrder(s, { ...close, version: open.version }, NOW);
  expect(final.closeout!.workPerformed).toContain(
    close.componentWork![0].description.trim(),
  );
});

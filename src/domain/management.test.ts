import { applyThroughWorkOrder } from "../../tests/fixtures/componentMovement";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyManagement,
  componentTotals,
  inspectionCounters,
  validateMaintenanceTotals,
  type Component,
  type ManagementCommand,
  type Stock,
} from "./management";
import { totalSeconds } from "./model";
const common = () => ({
  requestUuid: crypto.randomUUID(),
  reason: "Maintenance record verified",
});
const component = (aircraftUuid: string): Component => ({
  kind: "component",
  componentType: "Engine",
  manufacturer: "",
  notes: "",
  trackTime: true,
  trackCycles: true,
  trackCalendar: true,
  timeSinceRepair: null,
  serviceDaysBase: 0,
  uuid: "component-1",
  version: 0,
  aircraftUuid,
  partNumber: "P1",
  serial: "S1",
  installed: false,
  partsLocation: "Shelf A",
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 360000,
  timeSinceOverhaul: 180000,
  cyclesSinceNew: 100,
});
function setupStock() {
  const s = demoSnapshot();
  applyThroughWorkOrder(s, {
    ...common(),
    action: "record.save",
    record: {
      kind: "location",
      uuid: "store",
      version: 0,
      name: "Main store",
      address: "",
      contact: "",
    },
  });
  applyThroughWorkOrder(s, {
    ...common(),
    action: "record.save",
    record: {
      kind: "stock",
      uuid: "stock",
      version: 0,
      partNumber: "Oil",
      description: "Oil",
      alternates: "",
      category: "supply",
      condition: "new",
      locationUuid: "store",
      quantity: 0,
      minimum: 2,
    },
  });
  return s;
}
describe("maintenance and inventory domain", () => {
  it.each(["100H", "", "  "])(
    "recalculates recurring inspections and archives completions with reference %j",
    (reference) => {
      const s = demoSnapshot(),
        a = s.aircraft[0];
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.save",
        record: {
          uuid: "check",
          version: 0,
          aircraftUuid: a.uuid,
          reference,
          description: "Inspect",
          materials: "Oil",
          archived: false,
          intervalSeconds: 360000,
          intervalCycles: 100,
          intervalMonths: 12,
          lastSeconds: 0,
          lastCycles: 0,
          lastDate: "2024-02-12",
        },
      });
      expect(s.inspections.find((i) => i.uuid === "check")?.dueDate).toBe(
        "2025-02-28",
      );
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.complete",
        uuid: "check",
        version: 1,
        date: "2026-01-10",
        seconds: totalSeconds(a),
        cycles: a.cycles,
      });
      expect(s.inspections.find((i) => i.uuid === "check")).toMatchObject({
        dueSeconds: totalSeconds(a) + 360000,
        dueCycles: a.cycles + 100,
        dueDate: "2027-01-31",
        version: 2,
      });
      const once = s.inspections[0];
      applyThroughWorkOrder(s, {
        ...common(),
        action: "inspection.complete",
        uuid: once.uuid,
        version: 0,
        date: "2026-01-10",
        seconds: totalSeconds(a),
        cycles: a.cycles,
      });
      expect(s.inspections.find((i) => i.uuid === once.uuid)?.archived).toBe(
        true,
      );
    },
  );
  it("preserves component usage through installation, removal, and overhaul", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    applyThroughWorkOrder(s, {
      ...common(),
      action: "record.save",
      record: component(a.uuid),
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 1,
      operation: "install",
      installPosition: "MAIN",
      date: new Date().toISOString().slice(0, 10),
    });
    a.currentHobbs += 7200;
    a.cycles += 3;
    const installed = s.management!.find(
      (r) => r.kind === "component",
    )! as Component;
    expect(componentTotals(installed, a)).toMatchObject({
      timeSinceNew: 367200,
      timeSinceOverhaul: 187200,
      cyclesSinceNew: 103,
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 2,
      operation: "remove",
      partsLocation: "Shelf A",
      date: new Date().toISOString().slice(0, 10),
    });
    a.currentHobbs += 3600;
    expect(
      componentTotals(
        s.management!.find((r) => r.kind === "component")! as Component,
        a,
      ).timeSinceNew,
    ).toBe(367200);
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 3,
      operation: "overhaul",
      date: new Date().toISOString().slice(0, 10),
    });
    expect(s.management!.find((r) => r.kind === "component")!).toMatchObject({
      timeSinceNew: 367200,
      timeSinceOverhaul: 0,
      cyclesSinceNew: 103,
    });
  });
  it("uses component time for inspections and rejects flight corrections before installations", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    applyThroughWorkOrder(s, {
      ...common(),
      action: "record.save",
      record: component(a.uuid),
    });
    applyThroughWorkOrder(s, {
      ...common(),
      action: "component.service",
      uuid: "component-1",
      version: 1,
      operation: "install",
      installPosition: "MAIN",
      date: new Date().toISOString().slice(0, 10),
    });
    expect(
      inspectionCounters(
        {
          uuid: "i",
          aircraftUuid: a.uuid,
          reference: "Engine",
          description: "Check",
          componentUuid: "component-1",
        },
        a,
        s.management,
      ).seconds,
    ).toBe(360000);
    expect(() =>
      validateMaintenanceTotals(
        { ...a, currentHobbs: a.currentHobbs - 360 },
        s.management!,
        [],
      ),
    ).toThrow("installation");
  });
  it("rejects stale changes and insufficient stock without changing balances", () => {
    const s = setupStock();
    const receive: ManagementCommand = {
      ...common(),
      action: "stock.move",
      uuid: "stock",
      version: 1,
      operation: "receive",
      quantity: 5,
    };
    applyThroughWorkOrder(s, receive);
    expect(() => applyThroughWorkOrder(s, receive)).toThrow("changed");
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "stock.move",
        uuid: "stock",
        version: 2,
        operation: "issue",
        quantity: 6,
      }),
    ).toThrow("Insufficient");
    expect(
      (s.management!.find((r) => r.uuid === "stock") as Stock).quantity,
    ).toBe(5);
    applyThroughWorkOrder(s, {
      ...common(),
      action: "stock.move",
      uuid: "stock",
      version: 2,
      operation: "adjust",
      quantity: 0,
    });
    expect(
      (s.management!.find((r) => r.uuid === "stock") as Stock).quantity,
    ).toBe(0);
  });
  it("denies pilots maintenance writes and inventory access", () => {
    const s = demoSnapshot();
    s.user = s.members.find((m) => !m.isAdmin)!;
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "record.save",
        record: component(s.aircraft[0].uuid),
      }),
    ).toThrow("Permission");
    expect(() =>
      applyThroughWorkOrder(s, {
        ...common(),
        action: "record.save",
        record: {
          kind: "location",
          uuid: "x",
          version: 0,
          name: "Store",
          address: "",
          contact: "",
        },
      }),
    ).toThrow("Permission");
  });
});

it("allows explicit initial setup for a new installed component but cannot bypass movement rules", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const record: Component = {
    ...component(a.uuid),
    installed: true,
    partsLocation: undefined,
    installedDate: "2025-01-01",
    installPosition: "MAIN",
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
  };
  expect(() =>
    applyManagement(s, { ...common(), action: "record.save", record }),
  ).toThrow("work order");
  applyManagement(s, {
    ...common(),
    action: "record.save",
    record,
    initialAircraftSetup: true,
  });
  const saved = s.management!.find((r) => r.uuid === record.uuid)!;
  expect(saved.kind === "component" && saved.installed).toBe(true);
  expect(saved.kind === "component" && saved.aircraftUuid).toBe(a.uuid);
  expect(() =>
    applyManagement(s, {
      ...common(),
      action: "record.save",
      record: saved,
      initialAircraftSetup: true,
    }),
  ).toThrow("only for a new");
  if (saved.kind !== "component") throw Error("Missing component");
  expect(() =>
    applyManagement(s, {
      ...common(),
      action: "record.save",
      record: { ...saved, installed: false, partsLocation: "Shelf A" },
    }),
  ).toThrow();
});

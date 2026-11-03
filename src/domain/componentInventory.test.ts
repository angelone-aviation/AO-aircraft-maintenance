import { applyThroughWorkOrder } from "../../tests/fixtures/componentMovement";
import { expect, it } from "vitest";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { applyManagement } from "./management";
import { componentTotals, type Component } from "./components";
import { componentStorage } from "./componentInventory";
import { scopedSnapshot } from "./programs";
import { transferProgram } from "./programTransfers";

it("removes and reinstalls one tracked component without duplicating stock or losing totals and movement history", () => {
  const s = partsFixture();
  const c = workOrderComponent();
  s.management!.push(c);
  const before = componentTotals(c, s.aircraft[0]);
  const service = (operation: "install" | "remove", version: number) =>
    applyThroughWorkOrder(s, {
      action: "component.service",
      uuid: c.uuid,
      version,
      operation,
      date: new Date().toISOString().slice(0, 10),
      requestUuid: crypto.randomUUID(),
      reason: "Component inventory movement",
      ...(operation === "remove"
        ? { locationUuid: "parts-location", partsLocation: "Bin A" }
        : {
            aircraftUuid: s.aircraft[0].uuid,
            installPosition: "LEFT" as const,
          }),
    });
  service("remove", 0);
  const stored = s.management!.find((r) => r.uuid === c.uuid) as Component;
  expect(stored).toMatchObject({
    installed: false,
    locationUuid: "parts-location",
    partsLocation: "Bin A",
    serial: c.serial,
    timeSinceNew: before.timeSinceNew,
    cyclesSinceNew: before.cyclesSinceNew,
  });
  expect(componentStorage(s, stored)).toBe("Main hangar · Bin A");
  expect(s.management!.filter((r) => r.kind === "component")).toHaveLength(1);
  expect(s.management!.filter((r) => r.kind === "stock")).toHaveLength(2);
  service("install", 1);
  const installed = s.management!.find((r) => r.uuid === c.uuid) as Component;
  expect(installed.installed).toBe(true);
  expect(installed.locationUuid).toBeUndefined();
  expect(installed.partsLocation).toBeUndefined();
  expect(componentTotals(installed, s.aircraft[0]).timeSinceNew).toBe(
    before.timeSinceNew,
  );
  expect(
    s
      .management!.filter((r) => r.kind === "componentMovement")
      .map((r) => r.action),
  ).toEqual(["REMOVE", "INSTALL"]);
  expect(
    s.management!.find(
      (r) => r.kind === "componentMovement" && r.action === "REMOVE",
    ),
  ).toMatchObject({ locationUuid: "parts-location", partsLocation: "Bin A" });
});
it("rejects missing and foreign locations and keeps legacy storage descriptions readable", () => {
  const s = partsFixture();
  const component = {
    ...workOrderComponent(),
    installed: false,
    installPosition: undefined,
    locationUuid: "missing",
    partsLocation: "Shelf A",
  };
  const save = () =>
    applyThroughWorkOrder(s, {
      action: "record.save",
      record: component,
      requestUuid: crypto.randomUUID(),
      reason: "Inventory component",
    });
  expect(save).toThrow("inventory location");
  component.locationUuid = "parts-location";
  const location = s.management!.find((r) => r.uuid === "parts-location")!;
  location.programUuid = "foreign";
  expect(save).toThrow("Flight Program");
  expect(componentStorage(s, { ...component, locationUuid: undefined })).toBe(
    "Unassigned location · Shelf A",
  );
});
it("retains component attachments for inventory admins only and protects location transfers", () => {
  const s = partsFixture();
  s.management!.push({
    ...workOrderComponent(),
    installed: false,
    locationUuid: "parts-location",
    partsLocation: "Bin B",
  });
  s.inventoryAttachments = [
    {
      uuid: "file",
      stockUuid: "engine",
      name: "certificate.pdf",
      size: 10,
      type: "application/pdf",
      uploadedAt: Date.now(),
      url: "https://example.test/file",
    },
  ];
  expect(scopedSnapshot(s).inventoryAttachments).toHaveLength(1);
  s.programs!.push({ ...s.programs![0], uuid: "other" });
  expect(() =>
    transferProgram(s, {
      kind: "location",
      uuid: "parts-location",
      destination: "other",
      reason: "Transfer store",
    }),
  ).toThrow("Move tracked components");
  s.user.isAdmin = false;
  s.user.groupIds = ["maintenance"];
  s.groups = [
    {
      id: "maintenance",
      name: "Maintenance",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    },
  ];
  expect(scopedSnapshot(s).inventoryAttachments).toHaveLength(0);
});

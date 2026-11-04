/**
 * Responsibility: Pins the demo's group saves: a group keeps its aircraft
 *   after they leave the program, and an unscoped group gets one program.
 * Layer: Test. Vitest suite over fake-indexeddb; never shipped in the build.
 * Dependencies: src/data/store.ts, src/data/local.ts, src/data/demo.ts,
 *   src/domain/model.ts (types).
 *
 * The demo mirrors convex/admin.ts saveGroup (#34; #45 retired by Batch 414).
 */
import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Permission } from "../domain/model";

it("the demo keeps a group restricted after its aircraft leave the program and assigns unscoped groups", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const namespace = "demo-groups-test";
  const s = demoSnapshot();
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "second", name: "Second program" },
  ];
  s.groups.push(
    {
      id: "n206-crew",
      name: "N206 crew",
      programUuid: "demo-program",
      aircraftIds: ["demo-206"],
      permissions: ["read", "flight"],
    },
    {
      id: "legacy",
      name: "Legacy maintenance",
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    },
  );
  await saveSnapshot(namespace + ":all", s);
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true });
  const backend = useWorkspace.getState().backend!;
  const group = async (id: string) =>
    (await readSnapshot(namespace + ":all"))!.groups.find((g) => g.id === id);
  await backend.transferProgram({
    kind: "aircraft",
    uuid: "demo-206",
    destination: "second",
    reason: "Aircraft moved to the second program.",
  });
  const crew = {
    id: "n206-crew",
    programUuid: "demo-program",
    name: "N206 crew (renamed)",
    permissions: ["read", "flight"] as Permission[],
  };
  await expect(backend.saveGroup({ ...crew, aircraftIds: [] })).rejects.toThrow(
    /all aircraft in this program/,
  );
  await expect(
    backend.saveGroup({ ...crew, aircraftIds: ["demo-206"] }),
  ).rejects.toThrow(/must belong/);
  expect(await group("n206-crew")).toMatchObject({
    name: "N206 crew",
    aircraftIds: ["demo-206"],
  });
  await backend.saveGroup({ ...crew, aircraftIds: [], allAircraft: true });
  const widened = await group("n206-crew");
  expect(widened).toMatchObject({ name: crew.name, aircraftIds: [] });
  expect(widened).not.toHaveProperty("allAircraft");
  // Batch 414 retired the unscoped-group path: a group stored without a
  // Flight Program cannot be given one, as on the server.
  const legacy = {
    id: "legacy",
    programUuid: "demo-program",
    name: "Legacy maintenance",
    aircraftIds: [],
    permissions: ["read", "maintenance"] as Permission[],
  };
  await expect(backend.saveGroup(legacy)).rejects.toThrow(/cannot be moved/);
  expect(await group("legacy")).not.toHaveProperty("programUuid");
  vi.unstubAllGlobals();
});

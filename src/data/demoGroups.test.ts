import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Permission } from "../domain/model";

// The demo backend mirrors convex/admin.ts saveGroup (#34, #45).
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
  // An unscoped group gets its first program, audited; then it is fixed.
  const legacy = {
    id: "legacy",
    programUuid: "demo-program",
    name: "Legacy maintenance",
    aircraftIds: [],
    permissions: ["read", "maintenance"] as Permission[],
  };
  await backend.saveGroup(legacy);
  expect(await group("legacy")).toMatchObject({ programUuid: "demo-program" });
  expect((await readSnapshot(namespace + ":all"))!.audit[0]).toMatchObject({
    action: "group.program_assigned",
    entityUuid: "legacy",
    before: JSON.stringify({ programUuid: null }),
    after: JSON.stringify({ programUuid: "demo-program" }),
  });
  await expect(
    backend.saveGroup({ ...legacy, programUuid: "second" }),
  ).rejects.toThrow(/cannot be moved/);
  vi.unstubAllGlobals();
});

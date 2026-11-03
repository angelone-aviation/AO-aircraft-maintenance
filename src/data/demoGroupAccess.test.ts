import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Permission } from "../domain/model";

// The demo backend mirrors convex/groupAudit.ts and the change-log entries
// convex/admin.ts saveGroup writes (follow-up to #34).
it("the demo finds a group an edit before the fix widened, and records the explicit choice that clears it", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const namespace = "demo-group-access-test";
  const s = demoSnapshot();
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "second", name: "Second program" },
  ];
  s.aircraft = s.aircraft.map((a) =>
    a.uuid === "demo-206" ? { ...a, programUuid: "second" } : a,
  );
  const crew = {
    name: "N206 crew",
    programUuid: "demo-program",
    permissions: ["read", "flight"] as Permission[],
  };
  s.groups.push({ id: "n206-crew", ...crew, aircraftIds: [] });
  s.members = s.members.map((m) =>
    m.id === "demo-pilot" ? { ...m, groupIds: ["n206-crew"] } : m,
  );
  const entry = (
    at: number,
    before: string[] | undefined,
    after: string[],
  ) => ({
    uuid: crypto.randomUUID(),
    at,
    actorId: "demo-admin",
    action: "group.saved",
    entityUuid: "n206-crew",
    before: before && JSON.stringify({ ...crew, aircraftIds: before }),
    after: JSON.stringify({ ...crew, aircraftIds: after }),
  });
  s.audit = [
    entry(2000, ["demo-206"], []),
    entry(1000, undefined, ["demo-206"]),
  ];
  await saveSnapshot(namespace + ":all", s);
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true });
  const backend = useWorkspace.getState().backend!;

  expect(await backend.groupAccessReview()).toMatchObject([
    {
      groupId: "n206-crew",
      flag: "widened",
      reason: "aircraft_removed",
      savedAt: 2000,
      savedBy: { id: "demo-admin", name: "Alex Morgan" },
      aircraftBefore: [
        {
          registration: "N206MA",
          programName: "Second program",
          transferredAway: true,
        },
      ],
      members: [{ id: "demo-pilot", name: "Jordan Lee" }],
    },
  ]);

  // Saving it again without a choice (a client from before #34) keeps it.
  await backend.saveGroup({ id: "n206-crew", ...crew, aircraftIds: [] });
  expect(await backend.groupAccessReview()).toHaveLength(1);
  await backend.saveGroup({
    id: "n206-crew",
    ...crew,
    aircraftIds: [],
    allAircraft: true,
  });
  expect(await backend.groupAccessReview()).toEqual([]);
  const latest = (await readSnapshot(namespace + ":all"))!.audit[0];
  expect(JSON.parse(latest.before!)).toMatchObject({ aircraftIds: [] });
  expect(JSON.parse(latest.after!)).toMatchObject({
    aircraftIds: [],
    allAircraft: true,
  });

  // A new program's default all-aircraft groups are not flagged.
  await backend.fleet({
    action: "program.save",
    requestUuid: crypto.randomUUID(),
    reason: "Program created.",
    program: { ...s.programs![0], uuid: "third", name: "Third", version: 0 },
  });
  const groups = (await readSnapshot(namespace + ":all"))!.groups;
  expect(groups.filter((g) => g.programUuid === "third")).not.toEqual([]);
  expect(await backend.groupAccessReview()).toEqual([]);

  // Only system administrators may ask.
  useWorkspace.setState({
    snapshot: {
      ...useWorkspace.getState().snapshot!,
      user: { ...useWorkspace.getState().snapshot!.user, isAdmin: false },
    },
  });
  await expect(backend.groupAccessReview()).rejects.toThrow(
    "Administrator permission required.",
  );
});

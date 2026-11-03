import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { ensureDefaultGroups } from "./defaultGroups";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

// Follow-up to #34: groups an edit before the fix had already opened to every
// aircraft in their Flight Program are found from their group.saved entries.
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["A", "B"])
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: `Program ${uuid}`,
        email: `${uuid}@example.test`,
      });
    for (const [uuid, program] of [
      ["plane-A1", "A"],
      ["plane-A2", "A"],
      ["plane-B", "B"],
    ])
      await ctx.db.insert("aircraft", {
        ...demoSnapshot().aircraft[0],
        uuid,
        registration: uuid.toUpperCase(),
        programUuid: program,
        program,
      });
    const managersA = await ctx.db.insert("groups", {
      name: "A managers",
      programUuid: "A",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    const users: Record<string, Id<"users">> = {};
    const sessions: Record<string, Id<"authSessions">> = {};
    for (const [name, isAdmin, groupIds] of [
      ["system", true, []],
      ["programAdmin", false, [managersA]],
      ["crew", false, []],
    ] as const) {
      users[name] = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active: true,
        isAdmin,
        groupIds: [...groupIds],
        activeProgramUuid: "A",
      });
      sessions[name] = await ctx.db.insert("authSessions", {
        userId: users[name],
        expirationTime: Date.now() + 86400000,
      });
      for (const groupId of groupIds)
        await ctx.db.insert("memberships", {
          userId: users[name],
          groupId,
          programUuid: "A",
        });
    }
    return { users, sessions };
  });
  const as = (name: string) =>
    t.withIdentity({ subject: `${ids.users[name]}|${ids.sessions[name]}` });
  // A group as an administrator created it, with the change-log entry
  // saveGroup writes (before the explicit choice was recorded).
  const createGroup = (name: string, aircraftIds: string[], member = true) =>
    t.run(async (ctx) => {
      const fields = {
        programUuid: "A",
        programAdmin: false,
        owner: false,
        name,
        aircraftIds,
        permissions: ["read" as const, "flight" as const],
      };
      const id = await ctx.db.insert("groups", fields);
      await ctx.db.insert("audit", {
        programUuid: "A",
        uuid: crypto.randomUUID(),
        actorId: ids.users.system,
        action: "group.saved",
        entityUuid: id,
        at: Date.now(),
        after: JSON.stringify(fields),
      });
      if (member) {
        const crew = (await ctx.db.get(ids.users.crew))!;
        await ctx.db.patch(crew._id, { groupIds: [...crew.groupIds!, id] });
        await ctx.db.insert("memberships", {
          userId: crew._id,
          groupId: id,
          programUuid: "A",
        });
      }
      return id;
    });
  // What saveGroup did before #34 when the form dropped a transferred
  // aircraft: it saved the empty list, recording before and after.
  const editBeforeFix = (id: Id<"groups">, actor: string, at = Date.now()) =>
    t.run(async (ctx) => {
      const before = (await ctx.db.get(id))!;
      const fields = {
        programUuid: before.programUuid,
        programAdmin: false,
        owner: false,
        name: before.name,
        aircraftIds: [],
        permissions: before.permissions,
      };
      await ctx.db.patch(id, fields);
      await ctx.db.insert("audit", {
        programUuid: "A",
        uuid: crypto.randomUUID(),
        actorId: ids.users[actor],
        action: "group.saved",
        entityUuid: id,
        at,
        before: JSON.stringify(before),
        after: JSON.stringify(fields),
      });
    });
  const transferA1 = () =>
    as("system").mutation(api.programs.transfer, {
      programUuid: "A",
      kind: "aircraft",
      uuid: "plane-A1",
      destination: "B",
      reason: "Aircraft moved to program B.",
    });
  const check = async () => {
    const result = await t.query(internal.groupAudit.findWidenedGroups, {});
    expect(result.isDone).toBe(true);
    return result;
  };
  return { t, ids, as, createGroup, editBeforeFix, transferA1, check };
}

const saveArgs = (
  id: Id<"groups">,
  name: string,
  aircraftIds: string[],
  allAircraft?: boolean,
) => ({
  id,
  programUuid: "A",
  programAdmin: false,
  owner: false,
  name,
  aircraftIds,
  ...(allAircraft === undefined ? {} : { allAircraft }),
  permissions: ["read" as const, "flight" as const],
});

it("finds a group an edit before the fix widened after its aircraft was transferred, and changes nothing", async () => {
  const { t, ids, as, createGroup, editBeforeFix, transferA1, check } =
    await setup();
  const crew = await createGroup("A1 crew", ["plane-A1", "plane-A2"]);
  await transferA1();
  const editedAt = Date.now() - 1000;
  await editBeforeFix(crew, "programAdmin", editedAt);
  const stored = () =>
    t.run(async (ctx) => ({
      group: await ctx.db.get(crew),
      audit: (await ctx.db.query("audit").collect()).length,
    }));
  const beforeCheck = await stored();

  const result = await check();
  expect(result.review).toEqual([]);
  expect(result.widened).toEqual([
    {
      groupId: crew,
      groupName: "A1 crew",
      programUuid: "A",
      programName: "Program A",
      flag: "widened",
      reason: "aircraft_removed",
      savedAt: editedAt,
      savedBy: { id: ids.users.programAdmin, name: "programAdmin" },
      aircraftBefore: [
        {
          uuid: "plane-A1",
          registration: "PLANE-A1",
          programUuid: "B",
          programName: "Program B",
          transferredAway: true,
        },
        {
          uuid: "plane-A2",
          registration: "PLANE-A2",
          programUuid: "A",
          programName: "Program A",
          transferredAway: false,
        },
      ],
      members: [
        {
          id: ids.users.crew,
          name: "crew",
          email: "crew@example.test",
          active: true,
        },
      ],
      summary: `A1 crew (Program A): Limited to PLANE-A1 (now in Program B) and PLANE-A2 until programAdmin saved it with no aircraft on ${new Date(editedAt).toISOString()}.`,
    },
  ]);
  // Administration lists the same group.
  const { summary: _summary, ...report } = result.widened[0];
  expect(await as("system").query(api.groupAudit.groupsToReview, {})).toEqual([
    report,
  ]);
  // Read-only: the group and the change log are untouched.
  expect(await stored()).toEqual(beforeCheck);
});

it("reports a group created with all aircraft before the fix for review without calling it widened", async () => {
  const { as, createGroup, check } = await setup();
  const all = await createGroup("Line crew", []);
  const result = await check();
  expect(result.widened).toEqual([]);
  expect(result.review).toMatchObject([
    {
      groupId: all,
      flag: "review",
      reason: "created_all",
      aircraftBefore: [],
    },
  ]);
  // Choosing all aircraft explicitly in the fixed form clears it.
  await as("system").mutation(
    api.admin.saveGroup,
    saveArgs(all, "Line crew", [], true),
  );
  expect(await check()).toMatchObject({ widened: [], review: [] });
});

it("does not flag groups re-restricted later, chosen explicitly, or created as program defaults", async () => {
  const { t, as, createGroup, editBeforeFix, transferA1, check } =
    await setup();
  const restricted = await createGroup("Restricted again", ["plane-A1"]);
  const confirmed = await createGroup("Confirmed", ["plane-A1"]);
  await transferA1();
  for (const id of [restricted, confirmed])
    await editBeforeFix(id, "programAdmin");
  expect((await check()).widened).toHaveLength(2);

  await as("programAdmin").mutation(
    api.admin.saveGroup,
    saveArgs(restricted, "Restricted again", ["plane-A2"]),
  );
  await as("system").mutation(
    api.admin.saveGroup,
    saveArgs(confirmed, "Confirmed", [], true),
  );
  // The default groups every new program receives cover all aircraft by design.
  await t.run((ctx) => ensureDefaultGroups(ctx, "B", "system"));
  expect(await check()).toMatchObject({ widened: [], review: [] });
  // The explicit choice is what the change log now records.
  const entries = await t.run((ctx) =>
    ctx.db
      .query("audit")
      .withIndex("entity", (q) => q.eq("entityUuid", confirmed))
      .collect(),
  );
  expect(JSON.parse(entries.at(-1)!.after!)).toMatchObject({
    aircraftIds: [],
    allAircraft: true,
  });
});

it("keeps flagging a widened group renamed without an explicit choice, and groups with no change log", async () => {
  const { t, as, createGroup, editBeforeFix, transferA1, check } =
    await setup();
  const crew = await createGroup("A1 crew", ["plane-A1"], false);
  await transferA1();
  await editBeforeFix(crew, "programAdmin");
  // A client from before #34 omits the choice; an unchanged all-aircraft
  // group can still be saved that way.
  await as("system").mutation(
    api.admin.saveGroup,
    saveArgs(crew, "A1 crew (renamed)", []),
  );
  const unlogged = await t.run((ctx) =>
    ctx.db.insert("groups", {
      programUuid: "A",
      name: "Imported",
      aircraftIds: [],
      permissions: ["read"],
    }),
  );
  const result = await check();
  expect(result.widened).toMatchObject([
    { groupId: crew, groupName: "A1 crew (renamed)", members: [] },
  ]);
  expect(result.review).toMatchObject([
    { groupId: unlogged, reason: "no_history" },
  ]);
});

it("pages through groups with a cursor", async () => {
  const { t, createGroup } = await setup();
  for (const name of ["One", "Two", "Three"]) await createGroup(name, []);
  const found: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; ; pages++) {
    const result: {
      review: { groupName: string }[];
      groupsScanned: number;
      isDone: boolean;
      continueCursor: string;
    } = await t.query(internal.groupAudit.findWidenedGroups, {
      cursor,
      numItems: 2,
    });
    expect(result.groupsScanned).toBeLessThanOrEqual(2);
    found.push(...result.review.map((r) => r.groupName));
    if (result.isDone) break;
    cursor = result.continueCursor;
    expect(pages).toBeLessThan(5);
  }
  expect(found.sort()).toEqual(["One", "Three", "Two"]);
});

it("refuses the Administration query to anyone but a system administrator", async () => {
  const { t, ids, as } = await setup();
  for (const name of ["programAdmin", "crew"])
    await expect(
      as(name).query(api.groupAudit.groupsToReview, {}),
    ).rejects.toThrow("Administrator permission required.");
  await expect(t.query(api.groupAudit.groupsToReview, {})).rejects.toThrow();
  // A disabled system administrator is refused too.
  await t.run((ctx) => ctx.db.patch(ids.users.system, { active: false }));
  await expect(
    as("system").query(api.groupAudit.groupsToReview, {}),
  ).rejects.toThrow();
});

/**
 * Responsibility: Seeds a convex-test deployment with the sample Flight
 *   Program (convex/sampleProgram.ts) and one signed-in member per default
 *   group, for the suites that compare what each role reads.
 * Layer: Test. Fixture for convex-test suites; never shipped.
 * Dependencies: convex-test, convex/schema.ts, convex/sampleProgram.ts,
 *   convex/memberships.ts, convex/_generated.
 */
import { convexTest, type TestConvex } from "convex-test";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { PROGRAM } from "../../convex/sampleProgram";
import { syncMemberships } from "../../convex/memberships";

const modules = import.meta.glob([
  "../../convex/**/*.ts",
  "../../convex/_generated/*.js",
  "!../../convex/**/*.test.ts",
  "!../../convex/**/*.d.ts",
]);
const SESSION_MS = 86_400_000;
const PDF = "%PDF-1.4";
const SAMPLE_FILES = 4;
const ROOT_EMAIL = "root@example.test";

/** The sample program's uuid. */
export { PROGRAM };
/** The one aircraft the seeded Aircraft owners group names. */
export const OWNED_AIRCRAFT = "sample-aircraft-1";

type Convex = TestConvex<typeof schema>;

/**
 * Adds an active, signed-in member of the sample program.
 *
 * @param name - The member's name; the email is derived from it.
 * @param groupIds - The member's permission groups.
 * @returns The user id and the identity subject to sign in with.
 */
export async function addMember(
  ctx: MutationCtx,
  name: string,
  groupIds: Id<"groups">[],
) {
  const id = await ctx.db.insert("users", {
    name,
    email: `${name}@example.test`,
    active: true,
    isAdmin: false,
    groupIds,
    activeProgramUuid: PROGRAM,
  });
  await syncMemberships(ctx, id);
  return { id, subject: await signIn(ctx, id) };
}

/**
 * Seeds the sample program, narrows its Aircraft owners group to
 * {@link OWNED_AIRCRAFT}, and signs in one member per default group and the
 * system administrator.
 *
 * @returns The deployment, the default groups' ids, and a signed-in client
 *   per role: `root` (system administrator), `observer`, `pilot`, `tech`,
 *   `manager` (program administrator), `owner` and `board`.
 */
export async function seedSampleRoles() {
  const t: Convex = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Root",
      email: ROOT_EMAIL,
      active: true,
      isAdmin: true,
      groupIds: [],
    }),
  );
  await t.mutation(internal.sampleProgram.seed, { email: ROOT_EMAIL });
  await t.mutation(internal.sampleProgram.attach, {
    files: await storeSampleFiles(t),
    email: ROOT_EMAIL,
  });
  const people = await t.run(seedMembers);
  const as = (who: { subject: string }) => t.withIdentity(who);
  return {
    t,
    groups: people.groups,
    ids: people.ids,
    root: as(people.root),
    observer: as(people.observer),
    pilot: as(people.pilot),
    tech: as(people.tech),
    manager: as(people.manager),
    owner: as(people.owner),
    board: as(people.board),
  };
}

/** The seeded world, as {@link seedSampleRoles} returns it. */
export type SampleRoles = Awaited<ReturnType<typeof seedSampleRoles>>;

async function storeSampleFiles(t: Convex) {
  return t.run(async (ctx) => {
    const stored = [];
    for (let i = 0; i < SAMPLE_FILES; i++)
      stored.push({
        storageId: await ctx.storage.store(
          new Blob([PDF], { type: "application/pdf" }),
        ),
        size: PDF.length,
      });
    return stored;
  });
}

async function seedMembers(ctx: MutationCtx) {
  const all = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", PROGRAM))
    .collect();
  const byName = (name: string) => all.find((g) => g.name === name)!._id;
  const groups = {
    observers: byName("Observers"),
    pilots: byName("Pilots"),
    techs: byName("Maintenance technicians"),
    managers: byName("Program managers"),
    owners: byName("Aircraft owners"),
    board: byName("Board (read-only)"),
  };
  await ctx.db.patch(groups.owners, { aircraftIds: [OWNED_AIRCRAFT] });
  const root = (await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", ROOT_EMAIL))
    .unique())!;
  const members = {
    observer: await addMember(ctx, "observer", [groups.observers]),
    pilot: await addMember(ctx, "pilot", [groups.pilots]),
    tech: await addMember(ctx, "tech", [groups.techs]),
    manager: await addMember(ctx, "manager", [groups.managers]),
    owner: await addMember(ctx, "owner", [groups.owners]),
    board: await addMember(ctx, "board", [groups.board]),
  };
  return {
    groups,
    root: { subject: await signIn(ctx, root._id) },
    ...members,
    ids: {
      root: root._id,
      observer: members.observer.id,
      pilot: members.pilot.id,
      tech: members.tech.id,
      manager: members.manager.id,
      owner: members.owner.id,
      board: members.board.id,
    },
  };
}

async function signIn(ctx: MutationCtx, userId: Id<"users">) {
  const session = await ctx.db.insert("authSessions", {
    userId,
    expirationTime: Date.now() + SESSION_MS,
  });
  return `${userId}|${session}`;
}

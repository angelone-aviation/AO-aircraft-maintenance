/**
 * Responsibility: Seeds a convex-test deployment with two Flight Programs,
 *   one overdue inspection each, and signed-in members of each, for the
 *   suites that send alerts.
 * Layer: Test. Fixture for convex-test suites; never shipped.
 * Dependencies: convex-test, convex/schema.ts, convex/_generated,
 *   convex/memberships.ts, src/data/demo.ts, vitest.
 */
import { convexTest, type TestConvex } from "convex-test";
import { vi } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { demoSnapshot } from "../../src/data/demo";

const DAY_MS = 86_400_000;
// Overdue for years: the inspection also grounds its aircraft, so each
// member sees two urgent alerts.
const OVERDUE_ON = "2000-01-01";

/** The convex-test modules glob every suite uses. */
export const modules = import.meta.glob([
  "../../convex/**/*.ts",
  "../../convex/_generated/*.js",
  "!../../convex/**/*.test.ts",
  "!../../convex/**/*.d.ts",
]);

/** The demo program's uuid, as the seed stores it. */
export const DEMO_PROGRAM = "demo-program";

/** The second program's uuid. */
export const OTHER_PROGRAM = "other-program";

type Convex = TestConvex<typeof schema>;

/**
 * Seeds the alert world: the demo program with its first aircraft and the
 * other program with the second, an inspection overdue since 2000 on each,
 * and three members with sessions: `a` (demo program administrator),
 * `reader` (demo, read only) and `b` (other program administrator).
 *
 * @returns The deployment, each member's user id and signed-in client, and
 *   the demo aircraft's uuid.
 */
export async function seedAlertProgram() {
  const t: Convex = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const demo = demoSnapshot();
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: OTHER_PROGRAM,
      name: "Other",
    });
    const [ours, theirs] = demo.aircraft;
    await ctx.db.insert("aircraft", ours);
    await ctx.db.insert("aircraft", { ...theirs, programUuid: OTHER_PROGRAM });
    for (const a of [ours, theirs])
      await ctx.db.insert("inspections", {
        uuid: "insp-" + a.uuid,
        aircraftUuid: a.uuid,
        reference: "Annual " + a.registration,
        description: "Calendar inspection",
        dueDate: OVERDUE_ON,
      });
    const member = async (
      name: string,
      programUuid: string,
      admin: boolean,
    ) => {
      const groupId = await ctx.db.insert("groups", {
        programUuid,
        name: name + " group",
        programAdmin: admin,
        aircraftIds: [],
        permissions: ["read"],
      });
      const userId = await ctx.db.insert("users", {
        active: true,
        isAdmin: false,
        name,
        email: name + "@example.test",
        groupIds: [groupId],
        activeProgramUuid: programUuid,
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + DAY_MS,
      });
      return { userId, identity: { subject: `${userId}|${session}` } };
    };
    return {
      aircraftUuid: ours.uuid,
      a: await member("admin", DEMO_PROGRAM, true),
      reader: await member("reader", DEMO_PROGRAM, false),
      b: await member("other", OTHER_PROGRAM, true),
    };
  });
  // Accounts inserted directly predate the memberships index; backfill it.
  await t.mutation(internal.memberships.backfill, {});
  return {
    t,
    ids,
    a: t.withIdentity(ids.a.identity),
    reader: t.withIdentity(ids.reader.identity),
    b: t.withIdentity(ids.b.identity),
  };
}

/** The seeded world, as {@link seedAlertProgram} returns it. */
export type AlertWorld = Awaited<ReturnType<typeof seedAlertProgram>>;

/**
 * Stubs Resend's environment and replaces fetch with a mock answering every
 * request with `status`.
 *
 * @returns The fetch mock, to inspect the requests made.
 */
export function stubResend(status = 200) {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_FROM", "Angel One <alerts@example.test>");
  vi.stubEnv("SITE_URL", "https://app.example.test");
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(JSON.stringify({ id: "1" }), { status }),
    );
  vi.stubGlobal("fetch", request);
  return request;
}

/** The JSON body of each email the mock saw, in order. */
export function sentEmails(request: ReturnType<typeof stubResend>) {
  return request.mock.calls.map(
    ([, init]) =>
      JSON.parse(String(init?.body)) as {
        to: string[];
        subject: string;
        text: string;
        html: string;
      },
  );
}

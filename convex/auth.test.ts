/**
 * Responsibility: Pins that sign-in refusals stay plain Errors, which
 *   production hides alike, so their class reveals nothing about an account.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/auth.ts, convex/admin.ts, convex/schema.ts.
 */
import { convexTest } from "convex-test";
import { it, vi, expect } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Provisioning hashes real passwords (scrypt); allow for a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PASSWORD = "correct-horse-battery-1";

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("refuses sign-up, a disabled account and a wrong password, none as a ConvexError", async () => {
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {
      name: "System",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    return `${user}|${session}`;
  });
  const system = t.withIdentity({ subject });
  const provision = async (email: string) =>
    (await system.action(api.admin.createUser, {
      email,
      name: "Pilot",
      password: PASSWORD,
    })) as Id<"users">;
  const disabled = await provision("disabled@example.test");
  await provision("active@example.test");
  await system.mutation(api.admin.updateUser, {
    id: disabled,
    active: false,
    isAdmin: false,
    groupIds: [],
  });
  const signIn = (flow: string, email: string, password: string) =>
    refusal(
      t.action(api.auth.signIn, {
        provider: "password",
        params: { flow, email, password },
      }),
    );
  const signUp = await signIn("signUp", "new@example.test", PASSWORD);
  const off = await signIn("signIn", "disabled@example.test", PASSWORD);
  const wrong = await signIn("signIn", "active@example.test", `${PASSWORD}x`);
  expect(signUp).toMatchObject({
    message: "Accounts are managed by your administrator.",
  });
  expect(off).toMatchObject({ message: "Invalid credentials" });
  for (const error of [signUp, off, wrong]) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConvexError);
  }
});

/**
 * Responsibility: Pins what the offline outbox does with each refusal the
 *   server raises for a queued entry: held with its message, or retried.
 * Layer: Test. convex-test suite plus the device outbox; never shipped.
 * Dependencies: convex/operations.ts (submit), convex/schema.ts,
 *   src/data/store.ts and src/data/local.ts (the outbox), src/data/demo.ts.
 *
 * The outbox holds an entry when its failure is final (a ConvexError, or any
 * message the Convex client prefixes "[CONVEX ") and retries anything else.
 */
import "fake-indexeddb/auto";
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { Backend } from "../src/data/backend";
import type { Operation } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const [COVERED, UNCOVERED] = demoSnapshot().aircraft;

// Signs in one account per case, each holding one group of the demo program.
async function server() {
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    for (const a of [COVERED, UNCOVERED]) await ctx.db.insert("aircraft", a);
    const account = async (group?: { owner: boolean }) => {
      const groupIds = group
        ? [
            await ctx.db.insert("groups", {
              programUuid: PROGRAM,
              name: group.owner ? "Owners" : "Pilots",
              owner: group.owner,
              aircraftIds: [COVERED.uuid],
              permissions: ["read", "flight", "discrepancy"],
            }),
          ]
        : [];
      const id = await ctx.db.insert("users", {
        name: "Pilot",
        active: true,
        isAdmin: false,
        activeProgramUuid: PROGRAM,
        groupIds,
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { id, subject: `${id}|${session}` };
    };
    return {
      pilot: await account({ owner: false }),
      owner: await account({ owner: true }),
      unassigned: await account(),
    };
  });
  // The error operations.submit refuses one queued report with.
  const submit = async (
    who: { id: string; subject: string } | undefined,
    entry: { programUuid?: string; aircraftUuid?: string } = {},
  ) => {
    const operation = {
      programUuid: PROGRAM,
      kind: "discrepancy" as const,
      uuid: crypto.randomUUID(),
      authorId: who?.id ?? "nobody",
      aircraftUuid: COVERED.uuid,
      description: "Left landing light is intermittent.",
      ...entry,
    };
    const as = who ? t.withIdentity({ subject: who.subject }) : t;
    return as.mutation(api.operations.submit, { operation }).then(
      () => {
        throw new Error("Expected a refusal.");
      },
      (error: unknown) => error,
    );
  };
  return { submit, ...subjects };
}

// What the Convex browser client (convex 1.49, `mutation` in
// browser/sync/client.js) rejects with for a production failure: the message
// is redacted and prefixed, and only a ConvexError keeps its data.
function asProductionClientSees(error: unknown) {
  const message =
    "[CONVEX M(operations:submit)] [Request ID: x] Server Error\n  Called by client";
  if (!(error instanceof ConvexError)) return new Error(message);
  return Object.assign(new ConvexError(message), { data: error.data });
}

// Queues one report on the device, flushes it against a backend that rejects
// it with `clientError`, and returns the entry's error ("" when kept to retry).
async function outboxError(clientError: Error) {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("../src/data/store");
  const { persistOperation, readQueue } = await import("../src/data/local");
  const snapshot = demoSnapshot();
  const namespace = `outbox-refusal-${crypto.randomUUID()}`;
  const operation: Operation = {
    programUuid: PROGRAM,
    kind: "discrepancy",
    uuid: crypto.randomUUID(),
    authorId: snapshot.user.id,
    aircraftUuid: COVERED.uuid,
    description: "Queued offline",
  };
  await persistOperation(namespace, { operation, queuedAt: 1 });
  await useWorkspace.getState().initialize(namespace, false);
  const submit = vi.fn(async () => {
    throw clientError;
  });
  useWorkspace.setState({
    snapshot,
    online: true,
    connected: true,
    blocked: false,
    backend: { submit } as unknown as Backend,
  });
  await useWorkspace.getState().flush();
  const [entry] = await readQueue(namespace);
  vi.unstubAllGlobals();
  expect(submit).toHaveBeenCalledOnce();
  return entry.error ?? "";
}

it("holds an entry the server refuses, showing the refusal's message", async () => {
  const s = await server();
  const refusals = {
    "Flight Program permission denied.": await s.submit(s.unassigned),
    "Aircraft owner access is read-only.": await s.submit(s.owner),
    "Flight Program changed. Reopen the form in the correct program.":
      await s.submit(s.pilot, { programUuid: "another-program" }),
    "You do not have permission for this aircraft.": await s.submit(s.pilot, {
      aircraftUuid: UNCOVERED.uuid,
    }),
  };
  for (const [message, error] of Object.entries(refusals)) {
    expect(error).toMatchObject({ name: "ConvexError", data: message });
    expect(await outboxError(asProductionClientSees(error))).toBe(message);
  }
});

it("Characterizes current behaviour: holds an entry refused for a lapsed session, with the generic error text", async () => {
  const s = await server();
  const lapsed = await s.submit(undefined);
  expect(lapsed).toMatchObject({
    message: "An active account and session are required.",
  });
  // A plain Error, so a ConvexError-only rule in the outbox would retry it.
  expect(lapsed).not.toBeInstanceOf(ConvexError);
  // Batch 418: the outbox stores errorText, never the "[CONVEX …]" wrapper.
  expect(await outboxError(asProductionClientSees(lapsed))).toBe(
    "Something went wrong. Try again, and tell an administrator if it keeps happening.",
  );
});

it("retries an entry whose failure never reached the server", async () => {
  expect(await outboxError(new Error("WebSocket closed"))).toBe("");
});

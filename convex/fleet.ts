/**
 * Responsibility: The fleet mutation: saving an aircraft or a Flight Program,
 *   with the installed components an aircraft's readings move.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/fleet.
 * Dependencies: convex/values, ./_generated, ./access, ./runCommand,
 *   ./defaultGroups, src/domain (fleet, model, programs).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { currentUser } from "./access";
import {
  runCommand,
  hydrate,
  writeChanged,
  validationErrors,
  type CommandLog,
} from "./runCommand";
import { ensureDefaultGroups } from "./defaultGroups";
import {
  applyFleet,
  fleetCommandSchema,
  type Program,
} from "../src/domain/fleet";
import type { Aircraft } from "../src/domain/model";
import { activeProgram } from "../src/domain/programs";

/**
 * Saves an aircraft or a Flight Program once per request id. A new program
 * gets its default permission groups; an aircraft's new readings move the
 * baselines of the components installed on it.
 *
 * @param payload - The fleet command, as JSON, with its request id.
 * @throws {ConvexError} A domain Rejection; a refused field as its issue
 *   text ("Use tenths of an hour.", …); "Aircraft belongs to another Flight
 *   Program." or "This registration cannot be used." for an aircraft uuid or
 *   registration held elsewhere; runCommand's refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      actor: await currentUser(ctx),
      parse: () => fleetCommandSchema.parse(JSON.parse(payload)),
      request: (command) => ({ uuid: command.requestUuid, payload }),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["management", "inspections"]),
      apply: ({ snapshot }, command) => applyFleet(snapshot, command),
      expose: validationErrors,
      persist: async ({ ctx, state, log }, { docs }, result) => {
        if (result.aircraft)
          await saveAircraft(ctx, state.aircraft, result.aircraft);
        if (result.program)
          await saveProgram(ctx, state.programs, result.program, log);
        await writeChanged(
          ctx,
          "management",
          docs.management,
          result.components,
        );
      },
      audit: (log, { snapshot }, result) =>
        log.replay(snapshot.audit, {
          programUuid: result.program?.uuid ?? activeProgram(snapshot),
        }),
    }),
});

/**
 * Checks that an aircraft's uuid and registration are free before it is
 * saved. Program state is tenant-scoped, so identifiers and registrations
 * are checked globally here without revealing which other program holds
 * them.
 *
 * @param existing - The stored aircraft of the caller's program, if any.
 * @throws {ConvexError} "Aircraft belongs to another Flight Program." for a
 *   new aircraft whose uuid is stored; "This registration cannot be used."
 *   for a registration another aircraft holds.
 */
export async function assertAvailableAircraft(
  ctx: MutationCtx,
  next: { uuid: string; registration: string },
  existing?: Doc<"aircraft">,
) {
  if (
    !existing &&
    (await ctx.db
      .query("aircraft")
      .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
      .first())
  )
    throw new ConvexError("Aircraft belongs to another Flight Program.");
  const holder = await ctx.db
    .query("aircraft")
    .withIndex("registration", (q) => q.eq("registration", next.registration))
    .first();
  if (holder && holder.uuid !== next.uuid)
    throw new ConvexError("This registration cannot be used.");
}

async function saveAircraft(
  ctx: MutationCtx,
  stored: Doc<"aircraft">[],
  aircraft: Aircraft,
) {
  const existing = stored.find((a) => a.uuid === aircraft.uuid);
  await assertAvailableAircraft(ctx, aircraft, existing);
  // The applier's aircraft can still carry the stored document's system fields.
  const { _id, _creationTime, ...fields } = aircraft as Aircraft & {
    _id?: unknown;
    _creationTime?: number;
  };
  if (existing) await ctx.db.replace(existing._id, fields);
  else await ctx.db.insert("aircraft", fields);
}

async function saveProgram(
  ctx: MutationCtx,
  stored: Doc<"programs">[],
  program: Program,
  log: CommandLog,
) {
  const existing = stored.find((p) => p.uuid === program.uuid);
  if (existing) return ctx.db.replace(existing._id, program);
  await ctx.db.insert("programs", program);
  await ensureDefaultGroups(ctx, program.uuid, log.actorId, log);
}

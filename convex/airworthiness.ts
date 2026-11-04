/**
 * Responsibility: The AD-record mutation: saves, compliance and corrections,
 *   through the airworthiness domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/airworthiness.
 * Dependencies: convex/values, ./_generated, ./runCommand,
 *   src/domain/airworthiness.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate, writeChanged } from "./runCommand";
import { adCommandSchema, applyADCommand } from "../src/domain/airworthiness";

/**
 * Applies one AD command in the active Flight Program and writes an
 * "ad.<kind>" change-log row for each AD record it changed, with the record
 * before and after.
 *
 * @param payload - The AD command, as JSON.
 * @returns How many AD records the command changed.
 * @throws {ConvexError} A domain Rejection; "AD record belongs to another
 *   Flight Program." for an AD uuid another program holds; runCommand's
 *   program refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => adCommandSchema.parse(JSON.parse(args.payload)),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, ["airworthiness", "management", "workOrders"]),
      apply: ({ snapshot }, command) => applyADCommand(snapshot, command),
      persist: ({ ctx }, { docs }, changed) =>
        writeChanged(
          ctx,
          "airworthiness",
          docs.airworthiness,
          changed,
          "AD record belongs to another Flight Program.",
        ),
      // The applier lists its entries newest first, as the change log does;
      // rows are written in the order the ADs changed.
      audit: (log, { snapshot }) => log.replay([...snapshot.audit].reverse()),
      returns: (changed) => changed.length,
    }),
});

/**
 * Responsibility: The AD-record mutation: saves, compliance and corrections,
 *   through the airworthiness domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/airworthiness.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   src/domain/airworthiness.
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { runCommand, hydrate, writeChanged } from "./runCommand";
import { decode } from "./collections";
import {
  adAuditRecord,
  adCommandReason,
  adCommandSchema,
  applyADCommand,
} from "../src/domain/airworthiness";

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
      audit: (log, { docs }, changed, command) => {
        for (const r of changed) {
          const old = docs.airworthiness.find((d) => d.uuid === r.uuid);
          log.entry("ad." + command.kind, r.uuid, {
            aircraftUuid: r.aircraftUuid,
            programUuid: r.programUuid,
            reason: adCommandReason(command),
            before: old
              ? adAuditRecord(decode("airworthiness", [old])[0])
              : undefined,
            after: adAuditRecord(r),
          });
        }
      },
      returns: (changed) => changed.length,
    }),
});

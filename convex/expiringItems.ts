/**
 * Responsibility: Saving and archiving expiring dates (insurance,
 *   registration, service keys, secrets) for a Flight Program or the
 *   deployment.
 * Layer: Server. One public mutation through runCommand; the rules are the
 *   domain's applyExpiringCommand.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./urgentAlerts,
 *   src/domain/expiringItems.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import {
  hydrate,
  requestOf,
  runCommand,
  validationErrors,
  writeChanged,
} from "./runCommand";
import { scheduleSystemAlerts, scheduleUrgentAlerts } from "./urgentAlerts";
import {
  applyExpiringCommand,
  expiringCommandSchema,
} from "../src/domain/expiringItems";

/**
 * Saves or archives one expiring date, as the domain allows, and writes its
 * `expiring-date.saved` or `expiring-date.archived` change-log row. A
 * replayed request id changes nothing. Afterwards the program's urgent
 * alerts are checked, since an expired date is one, and for a deployment-wide
 * date the system administrators' check too.
 *
 * @param payload - The command, as JSON (`expiringCommandSchema`).
 * @param programUuid - The caller's active Flight Program; undefined for a
 *   system administrator working in none.
 * @returns The item's uuid and new version; nothing for a replay.
 * @throws {ConvexError} The domain's refusals, such as "Flight Program
 *   administrator required." and "This expiring date changed. Refresh and
 *   try again."; the zod issue text for a malformed command; "Record belongs
 *   to another Flight Program." for a new uuid another program holds;
 *   runCommand's program refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const saved = await runCommand(ctx, {
      programUuid,
      parse: () => expiringCommandSchema.parse(JSON.parse(payload)),
      request: (command) => requestOf(command.requestUuid, payload),
      load: ({ ctx, state }) => hydrate(ctx, state, ["expiringItems"]),
      apply: ({ snapshot }, command) => applyExpiringCommand(snapshot, command),
      expose: validationErrors,
      persist: ({ ctx }, { docs }, item) =>
        writeChanged(ctx, "expiringItems", docs.expiringItems, [item]),
      audit: (log, { snapshot }) => log.replayOldestFirst(snapshot.audit),
      returns: (item) => ({ uuid: item.uuid, version: item.version }),
    });
    await scheduleUrgentAlerts(ctx, programUuid);
    // A deployment-wide date alerts system administrators in its own check,
    // whichever program the caller works in, or none.
    const command = expiringCommandSchema.parse(JSON.parse(payload));
    if (command.action === "save" && !command.item.programUuid)
      await scheduleSystemAlerts(ctx);
    return saved;
  },
});

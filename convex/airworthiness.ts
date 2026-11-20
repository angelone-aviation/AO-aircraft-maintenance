/**
 * Responsibility: The AD-record mutation: saves, compliance and corrections,
 *   through the airworthiness domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/airworthiness.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./workingSet, ./urgentAlerts, src/domain/airworthiness.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  runCommand,
  hydrate,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode } from "./collections";
import { workOrderDocsByUuid } from "./workingSet";
import { scheduleUrgentAlerts } from "./urgentAlerts";
import {
  adCommandSchema,
  applyADCommand,
  type ADCommand,
} from "../src/domain/airworthiness";

/**
 * Applies one AD command in the active Flight Program and writes an
 * "ad.<kind>" change-log row for each AD record it changed, with the record
 * before and after. A replayed request id changes nothing. Afterwards the
 * program's urgent alerts are checked (convex/urgentAlerts.ts).
 *
 * @param payload - The AD command, as JSON, with its request id.
 * @returns How many AD records the command changed; nothing for a replay.
 * @throws {ConvexError} A domain Rejection; "Record belongs to another Flight
 *   Program." for an AD uuid another program holds; runCommand's program
 *   refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const changed = await runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => adCommandSchema.parse(JSON.parse(args.payload)),
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: ({ ctx, state }, command) => loadAD(ctx, state, command),
      apply: ({ snapshot }, command) => applyADCommand(snapshot, command),
      persist: ({ ctx }, { docs }, changed) =>
        writeChanged(ctx, "airworthiness", docs.airworthiness, changed),
      audit: (log, { snapshot }) => log.replayOldestFirst(snapshot.audit),
      returns: (changed) => changed.length,
    });
    await scheduleUrgentAlerts(ctx, args.programUuid);
    return changed;
  },
});

// The ADs and component records whole, and only the work orders the
// command's actions or compliance entry name, the one check that reads
// orders (ADR-0013).
async function loadAD(
  ctx: MutationCtx,
  state: ProgramContext,
  command: ADCommand,
) {
  const { snapshot, docs } = await hydrate(ctx, state, [
    "airworthiness",
    "management",
  ]);
  const orders = await workOrderDocsByUuid(
    ctx,
    namedWorkOrders(command),
    state.aircraft,
  );
  return {
    snapshot: { ...snapshot, workOrders: decode("workOrders", orders) },
    docs,
  };
}

// A save's actions name their work orders; compliance and a correction, the
// entry's; an import names none.
function namedWorkOrders(command: ADCommand): string[] {
  if (command.kind === "save")
    return command.record.tasks.map((t) => t.workOrderUuid);
  if (command.kind === "import") return [];
  return [command.entry.workOrderUuid];
}

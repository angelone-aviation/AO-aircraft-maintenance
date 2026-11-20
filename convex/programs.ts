/**
 * Responsibility: Choosing the caller's active Flight Program, and moving an
 *   aircraft, component or location with its dependent records to another.
 * Layer: Server. Convex mutations; the selection and transfer rules live in
 *   src/domain (programSelection, programTransfers).
 * Dependencies: convex/values, ./_generated, ./access, ./programContext,
 *   ./runCommand, ./collections, ./urgentAlerts, ./userErrors, src/domain
 *   (model, programSelection, programTransfers).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, type ObjectType } from "convex/values";
import { currentUser, writeAudit } from "./access";
import {
  context,
  managementDocs,
  checklistDocs,
  componentSetupDocs,
  partsRequestDocs,
  purchaseOrderDocs,
  expiringItemDocs,
} from "./programContext";
import {
  runCommand,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode } from "./collections";
import { scheduleUrgentAlerts } from "./urgentAlerts";
import { exposeRejections } from "./userErrors";
import { selectProgram } from "../src/domain/programSelection";
import { transferProgram } from "../src/domain/programTransfers";
import type { Snapshot } from "../src/domain/model";

/**
 * Makes a Flight Program the caller's active one, or, for a system
 * administrator, an empty uuid for unassigned records. Writes a
 * "program.selected" change-log row.
 *
 * @param programUuid - The program to activate, or "".
 * @throws {ConvexError} "Flight Program access denied." for a program that
 *   does not exist or that the caller is not a member of.
 */
export const select = mutation({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const user = await currentUser(ctx),
      state = await context(ctx, user);
    const entry = exposeRejections(() => selectProgram(state, programUuid));
    await ctx.db.patch(user._id, { activeProgramUuid: programUuid });
    await writeAudit(ctx, entry);
  },
});

const transferArgs = {
  programUuid: v.optional(v.string()),
  kind: v.union(
    v.literal("aircraft"),
    v.literal("component"),
    v.literal("location"),
  ),
  uuid: v.string(),
  destination: v.string(),
  reason: v.string(),
  requestUuid: v.optional(v.string()),
};
type TransferArgs = ObjectType<typeof transferArgs>;

/**
 * A system administrator moves an aircraft, component or location from the
 * active Flight Program to `destination`, with the records that depend on
 * it, as transferProgram decides. Writes one transfer change-log row.
 *
 * ADR-0005: existing change-log rows are never edited. History follows each
 * record's current owner (visibleScope): the destination sees the moved
 * records' rows, and the source keeps only rows that also concern what it
 * still holds. Rows the destination's own program and aircraft indexes would
 * not reach are listed in `transferredAudit` for its History feed. Schedules
 * the urgent-alert check for both programs. A replayed request id changes
 * nothing.
 *
 * @param reason - Why the records move; required.
 * @param requestUuid - The request id, when the client sends one.
 * @throws {ConvexError} transferProgram's refusals, such as "System
 *   administrator required for Flight Program transfers."; runCommand's
 *   program refusals.
 */
export const transfer = mutation({
  args: transferArgs,
  handler: async (ctx, args) => {
    const result = await runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => args,
      request: ({ programUuid: _program, requestUuid, ...transfer }) =>
        requestOf(requestUuid, JSON.stringify(transfer)),
      load: ({ ctx, state }) => loadTransfer(ctx, state, args),
      apply: ({ s }, input) => transferProgram(s, input),
      persist: async ({ ctx, state }, working, entities) => {
        await persistTransfer(ctx, state, working);
        await listTransferredAudit(ctx, args, entities);
      },
      // The transfer's rows are written after the listing above, so they are
      // never listed there.
      audit: (log, { s }) => log.replay(s.audit),
    });
    // What arrived overdue or grounded is news to the destination's members;
    // the source's check forgets the alerts that left with it.
    await scheduleUrgentAlerts(ctx, args.programUuid);
    await scheduleUrgentAlerts(ctx, args.destination);
    return result;
  },
});

type TransferState = Awaited<ReturnType<typeof loadTransfer>>;

// Reads what the moved record may take along, and keeps the stored documents
// and versions to find what the transfer changed.
async function loadTransfer(
  ctx: MutationCtx,
  state: ProgramContext,
  args: TransferArgs,
) {
  const program = args.programUuid;
  const aircraftKind = args.kind === "aircraft";
  const documents = await managementDocs(ctx, program);
  const inspections = await transferredInspections(ctx, args);
  const checklists = aircraftKind ? await checklistDocs(ctx, program) : [];
  const setups = aircraftKind ? await componentSetupDocs(ctx, program) : [];
  const expiring = aircraftKind
    ? await expiringItemDocs(ctx, program, false)
    : [];
  const s: Snapshot = {
    ...state,
    management: decode("management", documents),
    inspections,
    ...(await loadCommitments(ctx, program)),
    checklists: decode("checklists", checklists),
    componentSetups: decode("componentSetups", setups),
    expiringItems: decode("expiringItems", expiring),
    audit: [],
  };
  return {
    s,
    documents,
    inspections,
    checklists,
    setups,
    expiring,
    originals: new Map(state.aircraft.map((a) => [a.uuid, JSON.stringify(a)])),
    versions: new Map(inspections.map((i) => [i._id, i.version])),
  };
}

async function transferredInspections(
  ctx: MutationCtx,
  { kind, uuid }: TransferArgs,
) {
  if (kind === "aircraft")
    return ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", uuid))
      .collect();
  if (kind === "component")
    return ctx.db
      .query("inspections")
      .withIndex("component", (q) => q.eq("componentUuid", uuid))
      .collect();
  return [];
}

// Aircraft wait for their open requests and order lines; components for
// their repair requests and orders; locations for reserved stock and open
// order lines delivering there (transferProgram).
async function loadCommitments(
  ctx: MutationCtx,
  program: string | undefined,
): Promise<Pick<Snapshot, "partsRequests" | "purchaseOrders">> {
  return {
    partsRequests: decode(
      "partsRequests",
      await partsRequestDocs(ctx, program),
    ),
    purchaseOrders: decode(
      "purchaseOrders",
      await purchaseOrderDocs(ctx, program),
    ),
  };
}

// Writes only what the transfer changed: aircraft and inspections are patched,
// payload rows replaced with their encoded row.
async function persistTransfer(
  ctx: MutationCtx,
  state: ProgramContext,
  working: TransferState,
) {
  const { s, documents, inspections, checklists, setups, expiring } = working;
  await patchMovedAircraft(ctx, state.aircraft, working.originals);
  await writeChanged(ctx, "management", documents, s.management ?? []);
  for (const i of inspections)
    if (i.version !== working.versions.get(i._id))
      await ctx.db.patch(i._id, {
        programUuid: i.programUuid,
        version: i.version,
      });
  await writeChanged(
    ctx,
    "checklists",
    checklists,
    moved(s.checklists ?? [], checklists),
  );
  await writeChanged(
    ctx,
    "componentSetups",
    setups,
    moved(s.componentSetups ?? [], setups),
  );
  await writeChanged(ctx, "expiringItems", expiring, s.expiringItems ?? []);
}

// transferProgram changes only an aircraft's program and version, so only
// those are patched.
async function patchMovedAircraft(
  ctx: MutationCtx,
  aircraft: ProgramContext["aircraft"],
  originals: Map<string, string>,
) {
  for (const a of aircraft)
    if (JSON.stringify(a) !== originals.get(a.uuid))
      await ctx.db.patch(a._id, {
        programUuid: a.programUuid,
        program: a.program,
        version: a.version,
      });
}

// Checklists and component setups move with their aircraft by program alone;
// the rest of the program's are left as stored.
function moved<R extends { uuid: string; programUuid: string }>(
  records: R[],
  documents: { uuid: string; programUuid: string }[],
) {
  return records.filter(
    (r) =>
      r.programUuid !== documents.find((d) => d.uuid === r.uuid)!.programUuid,
  );
}

// ponytail: one transaction; a very long record history may need batching.
async function listTransferredAudit(
  ctx: MutationCtx,
  args: TransferArgs,
  entities: Set<string>,
) {
  const rows: Doc<"audit">[] = [];
  for (const uuid of entities)
    rows.push(
      ...(await ctx.db
        .query("audit")
        .withIndex("entity", (q) => q.eq("entityUuid", uuid))
        .collect()),
    );
  const listed = new Set<string>();
  for (const row of rows) {
    if (listed.has(row._id) || !leavesWithTransfer(row, args)) continue;
    listed.add(row._id);
    await ctx.db.insert("transferredAudit", {
      programUuid: args.destination,
      auditId: row._id,
      auditCreationTime: row._creationTime,
    });
  }
}

// A row the destination's own program or aircraft index already reaches is
// not listed.
function leavesWithTransfer(row: Doc<"audit">, args: TransferArgs) {
  return (
    row.programUuid !== args.destination &&
    !(args.kind === "aircraft" && row.aircraftUuid === args.uuid)
  );
}

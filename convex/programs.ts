/**
 * Responsibility: Choosing the caller's active Flight Program, and moving an
 *   aircraft, component or location with its dependent records to another.
 * Layer: Server. Convex mutations; the transfer rules live in
 *   src/domain/programTransfers.
 * Dependencies: convex/values, ./_generated, ./access, ./programContext,
 *   ./runCommand, ./collections, src/domain (model, programs,
 *   programTransfers).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError, type ObjectType } from "convex/values";
import { currentUser, audit } from "./access";
import {
  context,
  managementDocs,
  checklistDocs,
  componentSetupDocs,
  partsRequestDocs,
  purchaseOrderDocs,
} from "./programContext";
import { runCommand, type ProgramContext } from "./runCommand";
import { decode } from "./collections";
import { programIds } from "../src/domain/programs";
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
    if (!maySelect(user, state, programUuid))
      throw new ConvexError("Flight Program access denied.");
    await ctx.db.patch(user._id, { activeProgramUuid: programUuid });
    await audit(
      ctx,
      user._id,
      "program.selected",
      programUuid || "unassigned",
      { programUuid: programUuid || undefined },
    );
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
 * not reach are listed in `transferredAudit` for its History feed.
 *
 * @param reason - Why the records move; required.
 * @throws {ConvexError} transferProgram's refusals, such as "System
 *   administrator required for Flight Program transfers."; runCommand's
 *   program refusals.
 */
export const transfer = mutation({
  args: transferArgs,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => args,
      load: ({ ctx, state }) => loadTransfer(ctx, state, args),
      apply: ({ s }, input) => transferProgram(s, input),
      persist: async ({ ctx, state }, working, entities) => {
        await persistTransfer(ctx, state, working);
        await listTransferredAudit(ctx, args, entities);
      },
      // The transfer's own row is written after the listing above, so it is
      // never listed there.
      audit: (log, { s }) => log.replay(s.audit.slice(0, 1)),
    }),
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
  const s: Snapshot = {
    ...state,
    management: decode("management", documents),
    inspections,
    ...(await loadCommitments(ctx, program, args.kind)),
    checklists: decode("checklists", checklists),
    componentSetups: decode("componentSetups", setups),
    audit: [],
  };
  return {
    s,
    documents,
    inspections,
    checklists,
    setups,
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

// Aircraft wait for their open requests; locations for reserved stock and
// open order lines delivering there (transferProgram).
async function loadCommitments(
  ctx: MutationCtx,
  program: string | undefined,
  kind: TransferArgs["kind"],
): Promise<Pick<Snapshot, "partsRequests" | "purchaseOrders">> {
  if (kind === "component") return { partsRequests: [], purchaseOrders: [] };
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

// Patches only what the transfer changed; other columns stay as stored.
async function persistTransfer(
  ctx: MutationCtx,
  state: ProgramContext,
  working: TransferState,
) {
  const { s, documents, inspections, checklists, setups } = working;
  for (const a of state.aircraft)
    if (JSON.stringify(a) !== working.originals.get(a.uuid))
      await ctx.db.patch(a._id, {
        programUuid: a.programUuid,
        program: a.program,
        version: a.version,
      });
  await patchManagement(ctx, s.management ?? [], documents);
  for (const i of inspections)
    if (i.version !== working.versions.get(i._id))
      await ctx.db.patch(i._id, {
        programUuid: i.programUuid,
        version: i.version,
      });
  await patchOwner(ctx, s.checklists ?? [], checklists);
  await patchOwner(ctx, s.componentSetups ?? [], setups);
}

async function patchManagement(
  ctx: MutationCtx,
  records: NonNullable<Snapshot["management"]>,
  documents: Doc<"management">[],
) {
  for (const r of records) {
    const d = documents.find((d) => d.uuid === r.uuid)!;
    if (JSON.stringify(r) === d.payload) continue;
    await ctx.db.patch(d._id, {
      programUuid: r.programUuid,
      aircraftUuid:
        "aircraftUuid" in r ? r.aircraftUuid || undefined : undefined,
      payload: JSON.stringify(r),
    });
  }
}

// Checklists and component setups move with their aircraft by program alone.
async function patchOwner(
  ctx: MutationCtx,
  records: { uuid: string; programUuid: string }[],
  documents: Doc<"checklists" | "componentSetups">[],
) {
  for (const r of records) {
    const d = documents.find((d) => d.uuid === r.uuid)!;
    if (r.programUuid !== d.programUuid)
      await ctx.db.patch(d._id, {
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
      });
  }
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

// "" selects the unassigned records, which only a system administrator sees;
// any other program must exist, and a non-administrator must be a member.
function maySelect(
  user: Doc<"users">,
  state: Awaited<ReturnType<typeof context>>,
  programUuid: string,
) {
  if (!programUuid) return user.isAdmin === true;
  if (!state.programs.some((p) => p.uuid === programUuid)) return false;
  return (
    user.isAdmin === true ||
    programIds(state.user, state.groups).includes(programUuid)
  );
}

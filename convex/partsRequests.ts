/**
 * Responsibility: The parts-request mutation: saving, reserving, releasing,
 *   issuing and cancelling, through the parts-request domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/partsRequests.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./workingSet, src/domain (model, management, partsRequests, programs).
 */
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  runCommand,
  hydrate,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode, encode } from "./collections";
import {
  archivedCardDocs,
  archivedCardDocsByUuid,
  discrepancyDocsByUuid,
  inLoadOrder,
  openWorkOrderDocs,
  taskCardDocsByUuid,
  workOrderCardDocs,
  workOrderCostDocs,
  workOrderDocsByUuid,
} from "./workingSet";
import {
  applyRequestCommand,
  requestCommandSchema,
  type PartsRequest,
} from "../src/domain/partsRequests";
import { activeProgram } from "../src/domain/programs";
import type { Snapshot } from "../src/domain/model";
import type { ManagedRecord } from "../src/domain/management";

/**
 * Applies one parts-request command in the active Flight Program, with the
 * stock it moves. Saving an active recurring list also writes the requests
 * the applier creates for the open work orders on its aircraft, each with its
 * change-log row.
 *
 * @param payload - The request command, as JSON.
 * @returns The uuid of the request the command changed.
 * @throws {ConvexError} A domain Rejection; "Record belongs to another Flight
 *   Program." for a request uuid another Flight Program holds; runCommand's
 *   program refusals.
 */
export const execute = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => JSON.parse(args.payload),
      load: ({ ctx, state }, command) => loadRequest(ctx, state, command),
      apply: ({ snapshot }, command) => applyRequestCommand(snapshot, command),
      persist: async ({ ctx }, { snapshot: s, docs }, r) => {
        await writeChanged(
          ctx,
          "partsRequests",
          docs.partsRequests,
          changedRequests(s, docs.partsRequests, r),
        );
        await patchStock(ctx, docs.management, s.management ?? []);
      },
      audit: (log, { snapshot }) => log.record(snapshot.audit),
      returns: (r) => r.uuid,
    }),
});

// The command's request, then the occurrences the applier created for a saved
// list: the requests with no stored row. Only these are written, so a loaded
// row the command left alone is never rewritten.
function changedRequests(
  s: Snapshot,
  loaded: Doc<"partsRequests">[],
  saved: PartsRequest,
) {
  const stored = new Set(loaded.map((d) => d.uuid));
  return (s.partsRequests ?? []).filter(
    (r) => r.uuid === saved.uuid || !stored.has(r.uuid),
  );
}

// Parts commands change stock quantities, never a record's columns, so a
// changed record's row keeps the columns it was written with.
async function patchStock(
  ctx: MutationCtx,
  docs: Doc<"management">[],
  records: ManagedRecord[],
) {
  for (const record of records) {
    const prior = docs.find((d) => d.uuid === record.uuid);
    const { payload } = encode("management", record);
    if (prior && prior.payload !== payload)
      await ctx.db.patch(prior._id, { payload });
  }
}

// The bounded working set (ADR-0013). Stock, parts requests, purchase orders,
// ADs and inspections load whole (H5 keeps requests and orders complete). Of
// history, only what the request's source names: its work order, its job
// card (live or archived) and the order owning that card, with those orders'
// cards, archived cards and cost records; its problem report; and the
// program's open work orders, which a saved recurring list serves.
async function loadRequest(
  ctx: MutationCtx,
  state: ProgramContext,
  command: unknown,
) {
  const fleet = state.aircraft;
  const { snapshot, docs } = await hydrate(ctx, state, [
    "management",
    "partsRequests",
    "purchaseOrders",
    "airworthiness",
    "inspections",
  ]);
  const named = sourcesNamed(command, snapshot.partsRequests ?? []);
  const ownCards = await taskCardDocsByUuid(ctx, named.jobCards, fleet);
  const ownArchived = await archivedCardDocsByUuid(ctx, named.jobCards, fleet);
  const orders = [
    ...named.workOrders,
    ...decode("taskCards", ownCards).map((c) => c.workOrderUuid),
    ...decode("archivedTaskCards", ownArchived).map((c) => c.workOrderUuid),
  ];
  const loaded = {
    workOrders: inLoadOrder(
      [
        ...(await workOrderDocsByUuid(ctx, orders, fleet)),
        ...(await openWorkOrderDocs(ctx, fleet)),
      ],
      fleet,
    ),
    taskCards: inLoadOrder(
      [...ownCards, ...(await workOrderCardDocs(ctx, orders, fleet))],
      fleet,
    ),
    archivedTaskCards: inLoadOrder(
      [...ownArchived, ...(await archivedCardDocs(ctx, orders, fleet))],
      fleet,
    ),
    costs: await programCostDocs(ctx, state, orders),
    discrepancies: await discrepancyDocsByUuid(ctx, named.discrepancies, fleet),
  };
  return {
    snapshot: {
      ...snapshot,
      workOrders: decode("workOrders", loaded.workOrders),
      taskCards: decode("taskCards", loaded.taskCards),
      archivedTaskCards: decode("archivedTaskCards", loaded.archivedTaskCards),
      costs: decode("costs", loaded.costs),
      discrepancies: loaded.discrepancies,
    },
    docs: { ...docs, ...loaded },
  };
}

// The work orders, job cards and problem reports the command's draft and the
// stored request name as their source. A command that does not parse names
// none; the applier refuses it.
function sourcesNamed(command: unknown, requests: PartsRequest[]) {
  const parsed = requestCommandSchema.safeParse(command);
  const c = parsed.success ? parsed.data : undefined;
  const draft = c?.kind === "save" ? c.draft : undefined;
  const uuid = draft?.uuid ?? (c && "uuid" in c ? c.uuid : undefined);
  const stored = requests.find((r) => r.uuid === uuid);
  const sources = [draft?.source, stored?.source].filter(
    (source) => source !== undefined,
  );
  const of = (kind: string) =>
    sources.filter((s) => s.kind === kind).map((s) => s.uuid);
  return {
    workOrders: sources.map((s) => s.workOrderUuid),
    jobCards: of("jobCard"),
    discrepancies: of("discrepancy"),
  };
}

function programCostDocs(
  ctx: MutationCtx,
  state: ProgramContext,
  orders: string[],
) {
  const program = activeProgram(state);
  return program ? workOrderCostDocs(ctx, program, orders) : [];
}

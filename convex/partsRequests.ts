/**
 * Responsibility: The parts-request mutation: saving, reserving, releasing,
 *   issuing and cancelling, through the parts-request domain applier.
 * Layer: Server. Convex mutation over runCommand; the rules live in
 *   src/domain/partsRequests.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./workingSet, ./costLedger, src/domain (model, management,
 *   partsRequests, programs).
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
  highestRequestDocs,
  inLoadOrder,
  inProgramOrder,
  openWorkOrderDocs,
  orderDocsByKey,
  partsRequestDocsOn,
  requestDocsByKey,
  requestDocsByUuid,
  taskCardDocsByUuid,
  workOrderCardDocs,
  workOrderCostDocs,
  workOrderDocsByUuid,
} from "./workingSet";
import {
  applyRequestCommand,
  requestCommandSchema,
  type PartsRequest,
  type RequestCommand,
} from "../src/domain/partsRequests";
import { activeProgram } from "../src/domain/programs";
import { syncWorkOrderLedger } from "./costLedger";
import type { Snapshot } from "../src/domain/model";
import type { ManagedRecord } from "../src/domain/management";

/**
 * Applies one parts-request command in the active Flight Program, with the
 * stock it moves. An issue also writes the work-order cost records that
 * record its price (decision D13), and those orders' cost ledger rows.
 * Saving an active recurring list also
 * writes the requests the applier creates for the open work orders on its
 * aircraft. Each change has its change-log row.
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
        const priced = pricedCosts(s, docs.costs);
        await writeChanged(ctx, "costs", docs.costs, priced);
        for (const record of priced)
          if (record.kind === "workOrder")
            await syncWorkOrderLedger(ctx, record.workOrderUuid);
      },
      audit: (log, { snapshot }) => log.record(snapshot.audit),
      returns: (r) => r.uuid,
    }),
});

// Stock, the ADs a request's source may name, and the inspections; the rest
// is read by what the command names.
const STANDING = ["management", "airworthiness", "inspections"] as const;

type Loaded = Awaited<ReturnType<typeof sourceHistory>> & {
  partsRequests: Doc<"partsRequests">[];
  purchaseOrders: Doc<"purchaseOrders">[];
};

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

// The cost records an issue priced: new ones, and stored ones at a new
// version. Only these are written, so a loaded row the command left alone is
// never rewritten.
function pricedCosts(s: Snapshot, loaded: Doc<"costs">[]) {
  const stored = new Map(
    decode("costs", loaded).map((r) => [r.uuid, r.version]),
  );
  return (s.costs ?? []).filter((r) => stored.get(r.uuid) !== r.version);
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

// The bounded working set (ADR-0013, H5). Stock, ADs and inspections load
// whole. Of the program's requests, those its rules read (requestsRead) and,
// for a recurring list, what it serves (listsServed); of its orders, those
// allocated to the requests read, which their progress and status count. Of
// history, only what the request's source names: its work order, its job
// card (live or archived) and the order owning that card, with those orders'
// cards, archived cards and cost records, which an issue's price goes on
// (D13); its problem report; and the program's open work orders, which a
// saved recurring list serves.
async function loadRequest(
  ctx: MutationCtx,
  state: ProgramContext,
  command: unknown,
) {
  const c = requestCommandSchema.safeParse(command).data;
  // Without an active program the applier refuses the command, and no
  // request or order is stored under "", so nothing more is read.
  const program = activeProgram(state) ?? "";
  const { snapshot, docs } = await hydrate(ctx, state, STANDING);
  const read = await requestsRead(ctx, program, c);
  const requests = decode("partsRequests", read);
  const history = await sourceHistory(ctx, state, sourcesNamed(c, requests));
  const served = await listsServed(ctx, program, c, requests, history);
  const loaded = {
    ...history,
    partsRequests: inProgramOrder([...read, ...served]),
    purchaseOrders: await orderDocsByKey(
      ctx,
      program,
      "allocation",
      read.map((d) => d.uuid),
    ),
  };
  return {
    snapshot: { ...snapshot, ...decodeLoaded(loaded) },
    docs: { ...docs, ...loaded },
  };
}

// The program's requests the applier's rules read: the one the command
// names, those whose history holds its request id (a replay, or an id used
// before), those naming a component its draft lines repair (an open
// repair), and the highest-numbered, which a new number continues from.
async function requestsRead(
  ctx: MutationCtx,
  program: string,
  c: RequestCommand | undefined,
) {
  const named = c?.kind === "save" ? c.draft.uuid : (c?.uuid ?? "");
  const lines = c?.kind === "save" ? c.draft.lines : [];
  return inProgramOrder([
    ...(await requestDocsByUuid(ctx, program, [named])),
    ...(await requestDocsByKey(ctx, program, "requestId", [
      c?.requestUuid ?? "",
    ])),
    ...(await requestDocsByKey(
      ctx,
      program,
      "component",
      lines.map((l) => l.componentUuid),
    )),
    ...(await highestRequestDocs(ctx, program)),
  ]);
}

// Saving or resending an active recurring list serves the open work orders
// on its aircraft (finishCommand): every active list there, and the requests
// raised on those orders, which say what each list has served already.
async function listsServed(
  ctx: MutationCtx,
  program: string,
  c: RequestCommand | undefined,
  read: PartsRequest[],
  { workOrders }: { workOrders: Doc<"workOrders">[] },
) {
  const recurring = c?.kind === "save" && c.draft.recurring;
  if (!recurring && !read.some((r) => r.recurring && !r.cancelled)) return [];
  const aircraft = workOrders.map((w) => w.aircraftUuid);
  return [
    ...(await requestDocsByKey(ctx, program, "list", aircraft)),
    ...(await partsRequestDocsOn(ctx, program, {
      workOrderUuids: workOrders.map((w) => w.uuid),
      sourceUuids: [],
    })),
  ];
}

// The work order, job card (live or archived) and problem report the
// request's source names, the orders owning those cards, their cards and
// cost records, and the program's open work orders.
async function sourceHistory(
  ctx: MutationCtx,
  state: ProgramContext,
  named: ReturnType<typeof sourcesNamed>,
) {
  const fleet = state.aircraft;
  const ownCards = await taskCardDocsByUuid(ctx, named.jobCards, fleet);
  const ownArchived = await archivedCardDocsByUuid(ctx, named.jobCards, fleet);
  const orders = [
    ...named.workOrders,
    ...decode("taskCards", ownCards).map((c) => c.workOrderUuid),
    ...decode("archivedTaskCards", ownArchived).map((c) => c.workOrderUuid),
  ];
  return {
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
}

function decodeLoaded(loaded: Loaded) {
  return {
    workOrders: decode("workOrders", loaded.workOrders),
    taskCards: decode("taskCards", loaded.taskCards),
    archivedTaskCards: decode("archivedTaskCards", loaded.archivedTaskCards),
    costs: decode("costs", loaded.costs),
    discrepancies: loaded.discrepancies,
    partsRequests: decode("partsRequests", loaded.partsRequests),
    purchaseOrders: decode("purchaseOrders", loaded.purchaseOrders),
  };
}

// The work orders, job cards and problem reports the command's draft and the
// stored request name as their source. A command that does not parse names
// none; the applier refuses it.
function sourcesNamed(c: RequestCommand | undefined, requests: PartsRequest[]) {
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

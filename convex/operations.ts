/**
 * Responsibility: The workspace snapshot query, the offline outbox's submit,
 *   and the problem-report and flight-review mutations.
 * Layer: Server. Convex query and mutations; the rules live in src/domain.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./programContext, ./access, ./aircraftFiles, ./backups, ./faaCredentials,
 *   ./memberships, ./validators, src/domain (model, programs, flightSubmission,
 *   flightReview, ownerView, boardView, deferrals, requiredParts,
 *   aircraftStatus).
 */
import { v } from "convex/values";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { runCommand, hydrate, errorsOf, requestOf } from "./runCommand";
import { decode } from "./collections";
import {
  context,
  managementDocs,
  inspectionDocs,
  flightDocs,
  discrepancyDocs,
  taskCardDocs,
  archivedTaskCardDocs,
  workOrderDocs,
  flightPlanDocs,
  faaMonitorDocs,
  airworthinessDocs,
  partsRequestDocs,
  purchaseOrderDocs,
  checklistDocs,
  componentTemplateDocs,
  componentSetupDocs,
  inspectionTemplateDocs,
  costDocs,
  auditDocs,
  expiringItemDocs,
} from "./programContext";
import { authorized, aircraftByUuid, member, activeIdentity } from "./access";
import { aircraftFileList } from "./aircraftFiles";
import { faaCredentialStatus } from "./faaCredentials";
import { scheduleUrgentAlerts } from "./urgentAlerts";
import { programUsers } from "./memberships";
import { flightFields, operationValidator } from "./validators";
import {
  submitOperation,
  FlightRejection,
  type SubmissionChanges,
} from "../src/domain/flightSubmission";
import {
  assertReviewer,
  reviewFlight as applyReview,
  type FlightReview,
  type ReviewChanges,
} from "../src/domain/flightReview";
import {
  saveDiscrepancyParts as applyDiscrepancyParts,
  requiredPartsSchema,
} from "../src/domain/requiredParts";
import {
  scopedSnapshot,
  activeProgram,
  programPermission,
} from "../src/domain/programs";
import {
  isOwnerView,
  ownerPortalAircraft,
  ownerPortalFiles,
} from "../src/domain/ownerView";
import { isBoardView } from "../src/domain/boardView";
import { latestCopy } from "./backups";
import { earliestLocalDate } from "../src/domain/aircraftStatus";
import {
  deferCommandSchema,
  deferDiscrepancy as applyDeferral,
  resolveDiscrepancy as applyResolution,
  resolvedFields,
} from "../src/domain/deferrals";
import {
  can,
  operationSchema,
  type Aircraft,
  type Flight,
  type FlightInput,
  type Operation,
  type Snapshot,
} from "../src/domain/model";

type Ctx = QueryCtx | MutationCtx;

/**
 * The caller's workspace: the active Flight Program's records, narrowed by
 * scopedSnapshot to what the caller may see, with photo and attachment URLs.
 *
 * @returns null without an active account and session. An aircraft owner
 *   gets the owner whitelist, with file links only for their aircraft's
 *   photo and documents; a board member the board whitelist, with the newest
 *   off-site backup's time; a user who is both, the two side by side.
 * @throws {z.ZodError} When a stored payload no longer parses.
 */
export const snapshot = query({
  args: {},
  handler: async (ctx): Promise<Snapshot | null> => {
    const identity = await activeIdentity(ctx);
    if (!identity) return null;
    const snapshot = scopedSnapshot(await fullSnapshot(ctx, identity));
    if (isOwnerView(snapshot) || isBoardView(snapshot))
      return addReducedViewExtras(ctx, snapshot);
    snapshot.aircraft = await withPhotoUrls(ctx, snapshot.aircraft);
    snapshot.inventoryAttachments = await inventoryAttachments(ctx, snapshot);
    snapshot.workOrderAttachments = await workOrderAttachments(
      ctx,
      snapshot.workOrders ?? [],
    );
    snapshot.taskEvidence = await taskEvidence(ctx, [
      ...(snapshot.taskCards ?? []),
      ...(snapshot.archivedTaskCards ?? []),
    ]);
    snapshot.aircraftFiles = await aircraftFileList(ctx, snapshot);
    return snapshot;
  },
});

/**
 * Applies one offline outbox entry, a flight or a problem report, through
 * submitOperation. Idempotent on the entry's uuid. A flight that conflicts
 * with the aircraft is stored held for review, its totals unchanged.
 * Afterwards the program's urgent alerts are checked
 * (convex/urgentAlerts.ts).
 *
 * @returns The entry's status.
 * @throws {ConvexError} A FlightRejection's message, the program refusals of
 *   checkContext, or "You do not have permission for this aircraft."
 * @throws {Error} The session refusal, or "This offline entry belongs to a
 *   different user. Sign in with the original account."
 */
export const submit = mutation({
  args: { operation: operationValidator },
  handler: async (ctx, { operation: raw }) => {
    const operation = operationSchema.parse(raw);
    const submitted = await runCommand(ctx, {
      programUuid: operation.programUuid,
      parse: () => operation,
      load: ({ ctx, state }) => submissionState(ctx, state, operation),
      apply: ({ snapshot }) =>
        submitOperation(snapshot, operation, {
          now: Date.now(),
          // The earliest zone's date never rejects what the device accepted.
          today: earliestLocalDate(),
        }),
      expose: errorsOf(FlightRejection),
      persist: ({ ctx }, { aircraft, management }, { changes }) =>
        persistSubmission(ctx, aircraft, management, changes),
      audit: (log, _, { changes }) => log.replay(changes?.audit ?? []),
      returns: ({ status }) => ({ status }),
    });
    // New hours or a grounding report can make an alert urgent.
    await scheduleUrgentAlerts(ctx, operation.programUuid);
    return submitted;
  },
});

/**
 * Resolves an open problem report with a description of the repair, as the
 * deferrals domain allows, and writes a "discrepancy.resolved" change-log row.
 * A replayed request id changes nothing.
 *
 * @param requestUuid - The request id, when the client sends one.
 * @throws {Error} "Report not found."
 * @throws {ConvexError} The refusals of checkContext; "You do not have
 *   permission for this aircraft." without the resolve permission; the
 *   domain's "Describe the repair in 1–5000 characters." and "This report is
 *   already resolved."
 */
export const resolveDiscrepancy = mutation({
  args: {
    uuid: v.string(),
    resolution: v.string(),
    programUuid: v.optional(v.string()),
    requestUuid: v.optional(v.string()),
  },
  handler: (ctx, { uuid, resolution, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => uuid,
      request: () =>
        requestOf(requestUuid, JSON.stringify({ uuid, resolution })),
      load: ({ ctx, state }) => loadReport(ctx, state, uuid),
      apply: ({ s }) => applyResolution(s, uuid, resolution),
      persist: async ({ ctx }, { d }, next) => {
        await ctx.db.patch(d._id, resolvedFields(next));
      },
      audit: (log, { s }) => log.replayOldestFirst(s.audit),
    }),
});

/**
 * Records a deferral on a problem report, as the deferrals domain allows,
 * and writes a "discrepancy.deferred" change-log row. A replayed request id
 * changes nothing.
 *
 * @param payload - The deferral command, as JSON, with its request id.
 * @throws {Error} "Report not found."; a ZodError for a malformed command.
 * @throws {ConvexError} The refusals of checkContext; "You do not have
 *   permission for this aircraft." without the resolve permission; the
 *   domain's refusals, such as "This discrepancy is already deferred."
 */
export const deferDiscrepancy = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => deferCommandSchema.parse(JSON.parse(payload)),
      request: (command) => requestOf(command.requestUuid, payload),
      load: ({ ctx, state }, command) => loadReport(ctx, state, command.uuid),
      apply: ({ s }, command) => applyDeferral(s, command),
      persist: async ({ ctx }, { d }, next) => {
        await ctx.db.patch(d._id, { deferral: next.deferral });
      },
      audit: (log, { s }) => log.replayOldestFirst(s.audit),
    }),
});

const reviewArgs = {
  uuid: v.string(),
  programUuid: v.optional(v.string()),
  requestUuid: v.optional(v.string()),
  decision: v.union(v.literal("accept"), v.literal("reject")),
  reason: v.string(),
  input: v.object(flightFields),
};

/**
 * A program administrator accepts or rejects a flight, with corrections, as
 * the domain's reviewFlight allows. The aircraft's totals are rebuilt from its
 * flights, and the change log gets "flight.reviewed" plus "flight.resequenced"
 * for each other flight whose readings moved. A replayed request id changes
 * nothing.
 *
 * @param requestUuid - The request id, when the client sends one.
 * @throws {ConvexError} The refusals of checkContext; "Flight Program
 *   administrator required."; "You do not have permission for this
 *   aircraft."; then reviewFlight's refusals, such as "Flight not found."
 * @throws {Error} checkContext's session refusal.
 */
export const reviewFlight = mutation({
  args: reviewArgs,
  handler: async (ctx, { programUuid, requestUuid, ...review }) => {
    await runCommand(ctx, {
      programUuid,
      parse: () => review,
      request: () => requestOf(requestUuid, JSON.stringify(review)),
      load: ({ ctx, state }) => loadReview(ctx, state, review),
      apply: ({ snapshot }) => applyReview(snapshot, review),
      persist: ({ ctx }, working, changes) =>
        persistReview(ctx, working, review.uuid, changes),
      audit: (log, _, { audit }) => log.replay(audit),
    });
    // An accepted held flight adds its hours to the aircraft.
    await scheduleUrgentAlerts(ctx, programUuid);
  },
});

/**
 * Saves the parts a problem report needs, and writes a "discrepancy.parts"
 * change-log row. The domain checks maintenance permission and the parts
 * version. A replayed request id changes nothing.
 *
 * @param version - The parts version the client edited.
 * @param payload - The required parts, as JSON.
 * @param requestUuid - The request id, when the client sends one.
 * @throws {Error} "Report not found."; a ZodError for a malformed list.
 * @throws {ConvexError} The refusals of checkContext; the domain's refusals,
 *   such as "Parts changed. Reopen the report and try again."
 */
export const saveDiscrepancyParts = mutation({
  args: {
    uuid: v.string(),
    version: v.number(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
    requestUuid: v.optional(v.string()),
  },
  handler: (ctx, { uuid, version, payload, programUuid, requestUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => payload,
      request: () =>
        requestOf(requestUuid, JSON.stringify({ uuid, version, payload })),
      load: async ({ ctx, state }) => {
        const d = await reportByUuid(ctx, uuid);
        const { snapshot } = await hydrate(ctx, state, ["management"]);
        snapshot.discrepancies = [reportOf(d)];
        return { d, snapshot };
      },
      apply: ({ snapshot }, payload) =>
        applyDiscrepancyParts(
          snapshot,
          uuid,
          version,
          requiredPartsSchema.parse(JSON.parse(payload)),
        ),
      persist: async ({ ctx }, { d }, result) => {
        await ctx.db.patch(d._id, {
          requiredParts: result.requiredParts,
          partsVersion: result.partsVersion,
        });
      },
      audit: (log, { snapshot }) => log.replayOldestFirst(snapshot.audit),
    }),
});

// A reduced view is already its whitelist, so only what is named here is
// added: the backup time for the board, and for an owner the photo and the
// documents of the aircraft their owner groups name. No other file URL is.
async function addReducedViewExtras(ctx: QueryCtx, snapshot: Snapshot) {
  if (isBoardView(snapshot))
    snapshot.offsiteBackupAt = (await latestCopy(ctx))?.completedAt;
  if (!isOwnerView(snapshot)) return snapshot;
  const owned = ownerPortalAircraft(snapshot);
  const withPhotos = await withPhotoUrls(ctx, owned);
  snapshot.aircraft = snapshot.aircraft.map(
    (a) => withPhotos.find((photo) => photo.uuid === a.uuid) ?? a,
  );
  snapshot.aircraftFiles = ownerPortalFiles(
    await aircraftFileList(ctx, { ...snapshot, aircraft: owned }),
    owned,
  );
  return snapshot;
}

// Everything the active program holds, before scopedSnapshot narrows it.
async function fullSnapshot(
  ctx: QueryCtx,
  { user, session }: { user: Doc<"users">; session: Doc<"authSessions"> },
): Promise<Snapshot> {
  const state = await context(ctx, user);
  const program = activeProgram(state);
  const aircraft = state.aircraft;
  const management = await managementDocs(ctx, program);
  const flights = await flightDocs(ctx, aircraft);
  return {
    ...state,
    faaCredential: await faaCredentialStatus(ctx),
    user: member(user),
    authenticatedAt: session._creationTime,
    members: (await snapshotMembers(ctx, user, program, flights)).map(member),
    flights,
    ...(await aircraftRecords(ctx, aircraft)),
    ...(await programRecords(ctx, program)),
    inspections: await inspectionDocs(ctx, aircraft, management),
    management: decode("management", management),
    audit: await auditDocs(ctx, program, aircraft),
    // scopedSnapshot strips rates and money for non-administrators.
    costs: decode("costs", await costDocs(ctx, program, aircraft)),
    expiringItems: decode(
      "expiringItems",
      await expiringItemDocs(ctx, program, user.isAdmin === true),
    ),
    aircraft: aircraft.map((a) => ({
      ...a,
      program:
        state.programs.find((p) => p.uuid === a.programUuid)?.name ?? a.program,
    })),
  };
}

// System administrators manage every account; everyone else sees the active
// program's members (via the memberships index), themselves, and pilots
// recorded on this program's flights.
async function snapshotMembers(
  ctx: QueryCtx,
  user: Doc<"users">,
  program: string | undefined,
  flights: Flight[],
) {
  if (user.isAdmin) return ctx.db.query("users").collect();
  const pilots = await Promise.all(
    [...new Set(flights.flatMap((f) => [f.pilotId, f.copilotId]))].map((id) =>
      id ? existingUser(ctx, id) : null,
    ),
  );
  const users = [
    user,
    ...(program ? await programUsers(ctx, program) : []),
    ...pilots.filter((p): p is Doc<"users"> => p !== null),
  ];
  return [...new Map(users.map((u) => [u._id, u])).values()];
}

async function aircraftRecords(ctx: QueryCtx, aircraft: Aircraft[]) {
  return {
    taskCards: decode("taskCards", await taskCardDocs(ctx, aircraft)),
    archivedTaskCards: decode(
      "archivedTaskCards",
      await archivedTaskCardDocs(ctx, aircraft),
    ),
    faaMonitors: decode("faaMonitors", await faaMonitorDocs(ctx, aircraft)),
    airworthiness: decode(
      "airworthiness",
      await airworthinessDocs(ctx, aircraft),
    ),
    workOrders: decode("workOrders", await workOrderDocs(ctx, aircraft)),
    flightPlans: decode("flightPlans", await flightPlanDocs(ctx, aircraft)),
    discrepancies: await discrepancyDocs(ctx, aircraft),
  };
}

async function programRecords(ctx: QueryCtx, program: string | undefined) {
  return {
    partsRequests: decode(
      "partsRequests",
      await partsRequestDocs(ctx, program),
    ),
    purchaseOrders: decode(
      "purchaseOrders",
      await purchaseOrderDocs(ctx, program),
    ),
    checklists: decode("checklists", await checklistDocs(ctx, program)),
    componentTemplates: decode(
      "componentTemplates",
      await componentTemplateDocs(ctx, program),
    ),
    componentSetups: decode(
      "componentSetups",
      await componentSetupDocs(ctx, program),
    ),
    inspectionTemplates: decode(
      "inspectionTemplates",
      await inspectionTemplateDocs(ctx, program),
    ),
  };
}

async function withPhotoUrls(ctx: QueryCtx, aircraft: Aircraft[]) {
  return Promise.all(
    aircraft.map(async (a) => {
      const photo = await ctx.db
        .query("aircraftPhotos")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", a.uuid))
        .unique();
      return {
        ...a,
        photoUrl: photo
          ? ((await ctx.storage.getUrl(photo.storageId)) ?? undefined)
          : undefined,
      };
    }),
  );
}

// Only program administrators see the files kept with stock and components.
async function inventoryAttachments(ctx: QueryCtx, snapshot: Snapshot) {
  const records = (snapshot.management ?? []).filter(
    (r) =>
      programPermission(snapshot, "admin") &&
      (r.kind === "stock" || r.kind === "component"),
  );
  const lists = await Promise.all(
    records.map(async (stock) => {
      const files = await ctx.db
        .query("inventoryFiles")
        .withIndex("stock", (q) => q.eq("stockUuid", stock.uuid))
        .collect();
      return Promise.all(
        files.map(async (f) => ({
          uuid: f._id,
          stockUuid: f.stockUuid,
          name: f.name,
          type: f.type,
          size: f.size,
          uploadedAt: f.uploadedAt,
          url: await fileUrl(ctx, f.storageId),
        })),
      );
    }),
  );
  return lists.flat();
}

async function workOrderAttachments(
  ctx: QueryCtx,
  workOrders: NonNullable<Snapshot["workOrders"]>,
) {
  const lists = await Promise.all(
    workOrders.map(async (w) => {
      const files = await ctx.db
        .query("workOrderFiles")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", w.uuid))
        .collect();
      return Promise.all(
        files.map(async (f) => ({
          uuid: f._id,
          workOrderUuid: w.uuid,
          name: f.name,
          size: f.size,
          uploadedAt: f.uploadedAt,
          url: await fileUrl(ctx, f.storageId),
        })),
      );
    }),
  );
  return lists.flat();
}

async function taskEvidence(
  ctx: QueryCtx,
  cards: NonNullable<Snapshot["taskCards"]>,
) {
  const lists = await Promise.all(
    cards.map(async (t) => {
      const files = await ctx.db
        .query("taskEvidence")
        .withIndex("taskCard", (q) => q.eq("taskCardUuid", t.uuid))
        .collect();
      return Promise.all(
        files.map(async (f) => ({
          uuid: f._id,
          taskCardUuid: t.uuid,
          name: f.name,
          size: f.size,
          uploadedAt: f.uploadedAt,
          category: f.category,
          url: await fileUrl(ctx, f.storageId),
        })),
      );
    }),
  );
  return lists.flat();
}

const fileUrl = async (ctx: QueryCtx, storageId: Id<"_storage">) =>
  (await ctx.storage.getUrl(storageId)) ?? "";

interface SubmissionState {
  aircraft: Doc<"aircraft">;
  /** The program's stock records, for oil drawn on the flight line. */
  management: Doc<"management">[];
  snapshot: Snapshot;
}

// Loads what submitting an outbox entry reads (see submitOperation): the
// entry's earlier submission, or else the records it refers to.
async function submissionState(
  ctx: MutationCtx,
  state: Snapshot,
  operation: Operation,
): Promise<SubmissionState> {
  const aircraftUuid =
    operation.kind === "flight"
      ? operation.input.aircraftUuid
      : operation.aircraftUuid;
  const user = await authorized(
    ctx,
    aircraftUuid,
    operation.kind === "flight" ? "flight" : "discrepancy",
    state,
  );
  if (user._id !== operation.authorId)
    throw new Error(
      "This offline entry belongs to a different user. Sign in with the original account.",
    );
  const aircraft = await aircraftByUuid(ctx, aircraftUuid);
  if (operation.kind === "discrepancy")
    return {
      aircraft,
      management: [],
      snapshot: await reportState(ctx, state, operation),
    };
  const existing = await ctx.db
    .query("flights")
    .withIndex("uuid", (q) => q.eq("uuid", operation.uuid))
    .unique();
  if (existing)
    return {
      aircraft,
      management: [],
      snapshot: { ...state, flights: [existing] },
    };
  const management = await managementDocs(ctx, activeProgram(state));
  const snapshot = await flightState(ctx, state, operation.input, management);
  return { aircraft, management, snapshot };
}

// A report's earlier submission, or else the flight it was raised on.
async function reportState(
  ctx: MutationCtx,
  state: Snapshot,
  operation: Extract<Operation, { kind: "discrepancy" }>,
): Promise<Snapshot> {
  const existing = await ctx.db
    .query("discrepancies")
    .withIndex("uuid", (q) => q.eq("uuid", operation.uuid))
    .unique();
  const flight =
    !existing && operation.flightUuid
      ? await ctx.db
          .query("flights")
          .withIndex("uuid", (q) => q.eq("uuid", operation.flightUuid!))
          .unique()
      : null;
  return { ...state, discrepancies: rowsOf(existing), flights: rowsOf(flight) };
}

// A new flight is checked against this aircraft's airworthiness state for the
// dispatch gate (program-wide ADs, so those that follow an installed
// component count), the program's stock for oil drawn on the flight line,
// its checklist run and plan, and its crew.
async function flightState(
  ctx: MutationCtx,
  state: Snapshot,
  input: FlightInput,
  management: Doc<"management">[],
): Promise<Snapshot> {
  const only = state.aircraft.filter((a) => a.uuid === input.aircraftUuid);
  const crew = await Promise.all(
    [input.pilotId, input.copilotId]
      .filter(Boolean)
      .map((id) => existingUser(ctx, id!)),
  );
  return {
    ...state,
    management: decode("management", management),
    inspections: await inspectionDocs(ctx, only, management),
    airworthiness: decode(
      "airworthiness",
      await airworthinessDocs(ctx, state.aircraft),
    ),
    discrepancies: await discrepancyDocs(ctx, only),
    checklists: decode("checklists", await checklistRunRows(ctx, input)),
    flightPlans: decode("flightPlans", await planRows(ctx, input)),
    flights: await planFlights(ctx, input.flightPlanUuid),
    members: crew.filter((u): u is Doc<"users"> => u !== null).map(member),
  };
}

async function checklistRunRows(ctx: MutationCtx, input: FlightInput) {
  if (!input.checklistRun) return [];
  const { checklistUuid } = input.checklistRun;
  return rowsOf(
    await ctx.db
      .query("checklists")
      .withIndex("uuid", (q) => q.eq("uuid", checklistUuid))
      .unique(),
  );
}

async function planRows(ctx: MutationCtx, input: FlightInput) {
  const planUuid = input.flightPlanUuid;
  if (!planUuid) return [];
  return rowsOf(
    await ctx.db
      .query("flightPlans")
      .withIndex("uuid", (q) => q.eq("uuid", planUuid))
      .unique(),
  );
}

async function planFlights(ctx: MutationCtx, planUuid: string | undefined) {
  if (!planUuid) return [];
  return ctx.db
    .query("flights")
    .withIndex("plan", (q) => q.eq("flightPlanUuid", planUuid))
    .collect();
}

// Writes what an entry changed, in SubmissionChanges order.
async function persistSubmission(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  management: Doc<"management">[],
  changes: SubmissionChanges | undefined,
) {
  if (!changes) return;
  for (const change of changes.stock) {
    const doc = management.find((d) => d.uuid === change.before.uuid)!;
    await ctx.db.patch(doc._id, { payload: JSON.stringify(change.after) });
  }
  if (changes.flight) await ctx.db.insert("flights", changes.flight);
  if (changes.aircraft) {
    const next = changes.aircraft;
    await ctx.db.patch(aircraft._id, {
      currentHobbs: next.currentHobbs,
      currentTach: next.currentTach,
      currentCyclicHobbs: next.currentCyclicHobbs,
      currentFlightTimeLog: next.currentFlightTimeLog,
      cycles: next.cycles,
      landings: next.landings,
      latestFlightAt: next.latestFlightAt,
      version: next.version,
    });
  }
  if (changes.discrepancy)
    await ctx.db.insert("discrepancies", changes.discrepancy);
}

// The stored report, scoped to the caller's active program before any change,
// and the domain's view of it.
async function loadReport(ctx: MutationCtx, state: Snapshot, uuid: string) {
  const d = await reportByUuid(ctx, uuid);
  await authorized(ctx, d.aircraftUuid, "resolve", state);
  return { d, s: { ...state, discrepancies: [reportOf(d)] } };
}

// The report as the domain and the demo hold it, so the change log records
// the report, not Convex's system fields.
function reportOf({ _id, _creationTime, ...report }: Doc<"discrepancies">) {
  return report;
}

async function reportByUuid(ctx: MutationCtx, uuid: string) {
  const d = await ctx.db
    .query("discrepancies")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!d) throw new Error("Report not found.");
  return d;
}

interface ReviewState {
  snapshot: Snapshot;
  aircraft: Doc<"aircraft">;
  /** The stored flights the snapshot holds, for writing the replay. */
  flights: Doc<"flights">[];
}

// Loads what a review reads (see reviewFlight): the reviewed flight, the
// aircraft's flights, the flight's plan and that plan's flights, the crew, and
// the maintenance records and inspections. The administrator is checked
// first, then the aircraft, before any record is read.
async function loadReview(
  ctx: MutationCtx,
  state: Snapshot,
  review: FlightReview,
): Promise<ReviewState> {
  const { input } = review;
  assertReviewer(state);
  await authorized(ctx, input.aircraftUuid, "read", state);
  const aircraft = await aircraftByUuid(ctx, input.aircraftUuid);
  // The reviewed flight and the plan's flights are found by uuid in every
  // Flight Program. Keep only those the reviewer may read: otherwise the
  // refusal for another program's flight names the first link that differs.
  const flights = uniqueRows([
    ...(await aircraftFlights(ctx, aircraft.uuid)),
    ...rowsOf(await flightRow(ctx, review.uuid)),
    ...(await planFlights(ctx, input.flightPlanUuid)),
  ]).filter((f) => can(state, f.aircraftUuid, "read"));
  const management = await managementDocs(ctx, aircraft.programUuid);
  const snapshot: Snapshot = {
    ...state,
    flights,
    flightPlans: decode("flightPlans", await planRows(ctx, input)),
    members: await crewMembers(ctx, input),
    management: decode("management", management),
    inspections: await ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
      .collect(),
  };
  return { snapshot, aircraft, flights };
}

function aircraftFlights(ctx: MutationCtx, aircraftUuid: string) {
  return ctx.db
    .query("flights")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .collect();
}

function flightRow(ctx: MutationCtx, uuid: string) {
  return ctx.db
    .query("flights")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
}

async function crewMembers(ctx: MutationCtx, input: FlightInput) {
  const crew = await Promise.all(
    [input.pilotId, input.copilotId]
      .filter(Boolean)
      .map((id) => existingUser(ctx, id!)),
  );
  return crew.filter((u): u is Doc<"users"> => u !== null).map(member);
}

// Each stored row once, where it first appears.
function uniqueRows<T extends { _id: string }>(rows: T[]) {
  return [...new Map(rows.map((r) => [r._id, r])).values()];
}

// Writes the replayed starting readings, the aircraft's totals, then the
// reviewed flight.
async function persistReview(
  ctx: MutationCtx,
  { aircraft, flights }: ReviewState,
  reviewed: string,
  changes: ReviewChanges,
) {
  // reviewFlight returns only flights it was given.
  const idOf = (uuid: string) => flights.find((f) => f.uuid === uuid)!._id;
  for (const replayed of changes.flights)
    await ctx.db.patch(idOf(replayed.uuid), {
      hobbsOff: replayed.hobbsOff,
      tachOff: replayed.tachOff,
      cyclicHobbsOff: replayed.cyclicHobbsOff,
      flightTimeLogOff: replayed.flightTimeLogOff,
    });
  await patchTotals(ctx, aircraft, changes.aircraft);
  await ctx.db.patch(idOf(reviewed), changes.reviewed);
}

async function patchTotals(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  a: Aircraft,
) {
  await ctx.db.patch(aircraft._id, {
    currentHobbs: a.currentHobbs,
    currentTach: a.currentTach,
    currentCyclicHobbs: a.currentCyclicHobbs,
    currentFlightTimeLog: a.currentFlightTimeLog,
    cycles: a.cycles,
    landings: a.landings,
    latestFlightAt: a.latestFlightAt,
    version: a.version,
    // Records what older counter events changed (see rebuildFlights).
    counterEvents: a.counterEvents,
  });
}

async function existingUser(ctx: Ctx, id: string) {
  const userId = ctx.db.normalizeId("users", id);
  return userId ? ctx.db.get(userId) : null;
}

const rowsOf = <T>(row: T | null) => (row ? [row] : []);

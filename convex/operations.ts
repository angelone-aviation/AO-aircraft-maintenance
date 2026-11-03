/**
 * Responsibility: The workspace snapshot query, the offline outbox's submit,
 *   and the problem-report and flight-review mutations.
 * Layer: Server. Convex query and mutations; the rules live in src/domain.
 * Dependencies: convex/values, ./_generated, ./runCommand, ./collections,
 *   ./programContext, ./access, ./aircraftFiles, ./memberships, ./validators,
 *   src/domain (model, programs, flightSubmission, flights, management,
 *   ownerView, deferrals, requiredParts, flightPlans, flightChecklistLink,
 *   oilInventory, aircraftStatus).
 */
import { v, type Infer } from "convex/values";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { runCommand, hydrate, errorsOf } from "./runCommand";
import { decode } from "./collections";
import {
  context,
  checkContext,
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
} from "./programContext";
import {
  authorized,
  aircraftByUuid,
  audit,
  member,
  activeIdentity,
} from "./access";
import { aircraftFileList } from "./aircraftFiles";
import { programUsers } from "./memberships";
import { flightFields, operationValidator } from "./validators";
import {
  submitOperation,
  FlightRejection,
  type SubmissionChanges,
} from "../src/domain/flightSubmission";
import { preserveOilInventory } from "../src/domain/oilInventory";
import { preserveChecklistLink } from "../src/domain/flightChecklistLink";
import {
  saveDiscrepancyParts as applyDiscrepancyParts,
  requiredPartsSchema,
} from "../src/domain/requiredParts";
import { validatePlanFlight } from "../src/domain/flightPlans";
import {
  scopedSnapshot,
  activeProgram,
  programPermission,
  programIds,
} from "../src/domain/programs";
import { validateMaintenanceTotals } from "../src/domain/management";
import { isOwnerView, ownerSnapshot } from "../src/domain/ownerView";
import { earliestLocalDate } from "../src/domain/aircraftStatus";
import {
  deferCommandSchema,
  deferDiscrepancy as applyDeferral,
} from "../src/domain/deferrals";
import {
  operationSchema,
  type Aircraft,
  type Flight,
  type FlightInput,
  type Operation,
  type Snapshot,
} from "../src/domain/model";
import {
  validateFlight,
  rebuildFlights,
  resequencedFlights,
  resequenceReason,
} from "../src/domain/flights";

type Ctx = QueryCtx | MutationCtx;

const MAX_EXPLANATION_LENGTH = 5000;
const MIN_REVIEW_REASON_LENGTH = 5;

/**
 * The caller's workspace: the active Flight Program's records, narrowed by
 * scopedSnapshot to what the caller may see, with photo and attachment URLs.
 *
 * @returns null without an active account and session. An aircraft owner
 *   gets the owner whitelist.
 * @throws {z.ZodError} When a stored payload no longer parses.
 */
export const snapshot = query({
  args: {},
  handler: async (ctx): Promise<Snapshot | null> => {
    const identity = await activeIdentity(ctx);
    if (!identity) return null;
    const snapshot = scopedSnapshot(await fullSnapshot(ctx, identity));
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
    // Re-apply the owner whitelist after attachment URLs are added above.
    return isOwnerView(snapshot) ? ownerSnapshot(snapshot) : snapshot;
  },
});

/**
 * Applies one offline outbox entry, a flight or a problem report, through
 * submitOperation. Idempotent on the entry's uuid. A flight that conflicts
 * with the aircraft is stored held for review, its totals unchanged.
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
    return runCommand(ctx, {
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
      audit: (log, _, { changes }) => {
        for (const entry of changes?.audit ?? [])
          log.entry(entry.action, entry.entityUuid, entry);
      },
      returns: ({ status }) => ({ status }),
    });
  },
});

/**
 * Resolves an open problem report with a description of the repair, and
 * writes a "discrepancy.resolved" change-log row.
 *
 * @throws {Error} "Report not found.", "Describe the repair in 1–5000
 *   characters." or "This report is already resolved."
 * @throws {ConvexError} The refusals of checkContext, or "You do not have
 *   permission for this aircraft." without the resolve permission.
 */
export const resolveDiscrepancy = mutation({
  args: {
    uuid: v.string(),
    resolution: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, { uuid, resolution, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const d = await reportByUuid(ctx, uuid);
    const user = await authorized(ctx, d.aircraftUuid, "resolve", state);
    if (!resolution.trim() || resolution.length > MAX_EXPLANATION_LENGTH)
      throw new Error("Describe the repair in 1–5000 characters.");
    if (d.status === "resolved")
      throw new Error("This report is already resolved.");
    const update = {
      status: "resolved" as const,
      resolution: resolution.trim(),
      resolvedBy: user._id,
      resolvedAt: Date.now(),
    };
    await ctx.db.patch(d._id, update);
    await audit(ctx, user._id, "discrepancy.resolved", uuid, {
      aircraftUuid: d.aircraftUuid,
      before: d,
      after: update,
      reason: resolution,
    });
  },
});

/**
 * Records a deferral on a problem report, as the deferrals domain allows,
 * and writes a "discrepancy.deferred" change-log row.
 *
 * @param payload - The deferral command, as JSON.
 * @throws {Error} "Report not found.", or the domain's refusal.
 * @throws {ConvexError} The refusals of checkContext, or "You do not have
 *   permission for this aircraft." without the resolve permission.
 */
export const deferDiscrepancy = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => deferCommandSchema.parse(JSON.parse(payload)),
      load: async ({ ctx, state }, command) => {
        const d = await reportByUuid(ctx, command.uuid);
        // Scopes the report to the caller's active program before any change.
        await authorized(ctx, d.aircraftUuid, "resolve", state);
        const { _id, _creationTime, ...report } = d;
        return { d, s: { ...state, discrepancies: [report] } };
      },
      apply: ({ s }, command) => applyDeferral(s, command),
      persist: async ({ ctx }, { d }, next) => {
        await ctx.db.patch(d._id, { deferral: next.deferral });
      },
      audit: (log, { d }, next) =>
        log.entry("discrepancy.deferred", d.uuid, {
          programUuid,
          aircraftUuid: d.aircraftUuid,
          reason: next.deferral!.placard,
          before: d,
          after: next.deferral,
        }),
    }),
});

const reviewArgs = {
  uuid: v.string(),
  programUuid: v.optional(v.string()),
  decision: v.union(v.literal("accept"), v.literal("reject")),
  reason: v.string(),
  input: v.object(flightFields),
};
type ReviewInput = Infer<typeof reviewArgs.input>;

/**
 * A program administrator accepts or rejects a held or rejected flight, with
 * corrections. The aircraft's totals are rebuilt from its flights, and the
 * change log gets "flight.reviewed" plus "flight.resequenced" for each other
 * flight whose readings moved.
 *
 * @throws {Error} With the reason a review is refused, for example "Flight
 *   Program administrator required." or "Flight not found."
 * @throws {ConvexError} The refusals of checkContext, or "You do not have
 *   permission for this aircraft."
 */
export const reviewFlight = mutation({
  args: reviewArgs,
  handler: async (ctx, { uuid, decision, reason, input, programUuid }) => {
    const scope = await checkContext(ctx, programUuid);
    const user = await authorizeReview(ctx, scope, input.aircraftUuid, reason);
    const flight = await flightByUuid(ctx, uuid);
    await assertLinksUnchanged(ctx, scope, flight, decision, input);
    const aircraft = await aircraftByUuid(ctx, flight.aircraftUuid);
    await assertCrew(ctx, scope, aircraft, flight, input);
    validateFlight(aircraft, input);
    const next: Flight = {
      ...flight,
      ...input,
      status: decision === "accept" ? "accepted" : "rejected",
      reviewReason: reason,
    };
    const { all, rebuilt } = await rebuildTotals(ctx, aircraft, uuid, next);
    const review = { uuid, reason, input, flight, next, all, rebuilt };
    const saved = await saveReview(ctx, aircraft, review);
    await auditReview(ctx, user._id, review, saved);
  },
});

/**
 * Saves the parts a problem report needs, and writes a "discrepancy.parts"
 * change-log row. The domain checks maintenance permission and the parts
 * version.
 *
 * @param version - The parts version the client edited.
 * @param payload - The required parts, as JSON.
 * @throws {Error} "Report not found.", or the domain's refusal.
 * @throws {ConvexError} The refusals of checkContext.
 */
export const saveDiscrepancyParts = mutation({
  args: {
    uuid: v.string(),
    version: v.number(),
    payload: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: (ctx, { uuid, version, payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => payload,
      load: async ({ ctx, state }) => {
        const d = await reportByUuid(ctx, uuid);
        const { snapshot } = await hydrate(ctx, state, ["management"]);
        snapshot.discrepancies = [d];
        return { d, snapshot, before: structuredClone(d) };
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
      audit: (log, { d, before }, result) =>
        log.entry("discrepancy.parts", uuid, {
          aircraftUuid: d.aircraftUuid,
          before,
          after: result,
          reason: "Required parts updated",
        }),
    }),
});

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
    aircraft: aircraft.map((a) => ({
      ...a,
      program:
        state.programs.find((p) => p.uuid === a.programUuid)?.name ?? a.program,
    })),
  };
}

async function faaCredentialStatus(ctx: QueryCtx) {
  const credential = await ctx.db.query("faaCredentials").unique();
  return {
    configured: !!(credential?.key || process.env.FAA_DRS_API_KEY),
    expiresOn: credential?.expiresOn || "",
    version: credential?.version ?? 0,
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

async function reportByUuid(ctx: MutationCtx, uuid: string) {
  const d = await ctx.db
    .query("discrepancies")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!d) throw new Error("Report not found.");
  return d;
}

async function authorizeReview(
  ctx: MutationCtx,
  scope: Snapshot,
  aircraftUuid: string,
  reason: string,
) {
  if (!programPermission(scope, "admin"))
    throw new Error("Flight Program administrator required.");
  const user = await authorized(ctx, aircraftUuid, "read", scope);
  if (
    reason.trim().length < MIN_REVIEW_REASON_LENGTH ||
    reason.length > MAX_EXPLANATION_LENGTH
  )
    throw new Error("Provide a meaningful review explanation.");
  return user;
}

async function flightByUuid(ctx: MutationCtx, uuid: string) {
  const flight = await ctx.db
    .query("flights")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!flight) throw new Error("Flight not found.");
  return flight;
}

// A review corrects the flight's own entries; what it links to stays.
async function assertLinksUnchanged(
  ctx: MutationCtx,
  scope: Snapshot,
  flight: Doc<"flights">,
  decision: "accept" | "reject",
  input: ReviewInput,
) {
  preserveChecklistLink(flight, input);
  preserveOilInventory(flight, input);
  if (input.flightPlanUuid !== flight.flightPlanUuid)
    throw new Error("A review cannot change the linked flight plan.");
  const planUuid = input.flightPlanUuid;
  if (decision === "accept" && flight.status === "rejected" && planUuid)
    validatePlanFlight(
      {
        ...scope,
        flightPlans: decode("flightPlans", await planRows(ctx, input)),
        flights: await planFlights(ctx, planUuid),
      },
      input,
    );
  if (input.aircraftUuid !== flight.aircraftUuid)
    throw new Error("A correction cannot change aircraft.");
  // A report is never silently removed by correcting flight text.
  if (input.discrepancy !== flight.discrepancy)
    throw new Error("Use the discrepancy workflow to update problem reports.");
}

// Both crew must exist; anyone newly named must belong to the aircraft's
// program unless they are a system administrator.
async function assertCrew(
  ctx: MutationCtx,
  scope: Snapshot,
  aircraft: Doc<"aircraft">,
  flight: Doc<"flights">,
  input: ReviewInput,
) {
  if (!(await existingUser(ctx, input.pilotId)))
    throw new Error("Pilot not found.");
  if (input.copilotId && !(await existingUser(ctx, input.copilotId)))
    throw new Error("Copilot not found.");
  const program = aircraft.programUuid ?? "";
  for (const id of [input.pilotId, input.copilotId].filter(Boolean)) {
    const unchanged =
      (id === input.pilotId && id === flight.pilotId) ||
      (id === input.copilotId && id === flight.copilotId);
    if (unchanged) continue;
    const pilot = await existingUser(ctx, id!);
    if (
      !pilot ||
      (!pilot.isAdmin &&
        !programIds(member(pilot), scope.groups).includes(program))
    )
      throw new Error("Pilot must belong to this Flight Program.");
  }
}

// Replays the aircraft's flights with the reviewed one replaced; the
// maintenance totals must still hold afterwards.
async function rebuildTotals(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  uuid: string,
  next: Flight,
) {
  const all = await ctx.db
    .query("flights")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
    .collect();
  const replaced = all.map((f) => (f.uuid === uuid ? next : f));
  const rebuilt = rebuildFlights(aircraft, replaced, all);
  validateMaintenanceTotals(
    rebuilt.aircraft,
    decode("management", await managementDocs(ctx, aircraft.programUuid)),
    await ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
      .collect(),
  );
  return { all, rebuilt };
}

interface Review {
  uuid: string;
  reason: string;
  input: ReviewInput;
  flight: Doc<"flights">;
  next: Flight;
  all: Doc<"flights">[];
  rebuilt: ReturnType<typeof rebuildFlights>;
}

// Writes the rebuilt readings, the aircraft's totals and the reviewed flight.
async function saveReview(
  ctx: MutationCtx,
  aircraft: Doc<"aircraft">,
  { uuid, reason, input, flight, next, all, rebuilt }: Review,
) {
  for (const accepted of rebuilt.flights) {
    const original = all.find((f) => f.uuid === accepted.uuid)!;
    await ctx.db.patch(original._id, {
      hobbsOff: accepted.hobbsOff,
      tachOff: accepted.tachOff,
      cyclicHobbsOff: accepted.cyclicHobbsOff,
      flightTimeLogOff: accepted.flightTimeLogOff,
    });
  }
  await patchTotals(ctx, aircraft, rebuilt.aircraft);
  const corrected = rebuilt.flights.find((f) => f.uuid === uuid);
  const saved = {
    ...input,
    status: next.status,
    reviewReason: reason,
    hobbsOff: corrected?.hobbsOff ?? flight.hobbsOff,
    tachOff: corrected?.tachOff ?? flight.tachOff,
    cyclicHobbsOff: corrected?.cyclicHobbsOff ?? flight.cyclicHobbsOff,
    flightTimeLogOff: corrected?.flightTimeLogOff ?? flight.flightTimeLogOff,
  };
  await ctx.db.patch(flight._id, saved);
  return saved;
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

async function auditReview(
  ctx: MutationCtx,
  actorId: Id<"users">,
  { uuid, reason, flight, next, all, rebuilt }: Review,
  saved: object,
) {
  await audit(ctx, actorId, "flight.reviewed", uuid, {
    aircraftUuid: flight.aircraftUuid,
    reason,
    before: flight,
    after: { ...next, ...saved },
  });
  for (const change of resequencedFlights(all, rebuilt.flights, uuid))
    await audit(ctx, actorId, "flight.resequenced", change.flight.uuid, {
      aircraftUuid: flight.aircraftUuid,
      reason: resequenceReason(flight, next),
      before: change.before,
      after: change.after,
    });
}

async function existingUser(ctx: Ctx, id: string) {
  const userId = ctx.db.normalizeId("users", id);
  return userId ? ctx.db.get(userId) : null;
}

const rowsOf = <T>(row: T | null) => (row ? [row] : []);

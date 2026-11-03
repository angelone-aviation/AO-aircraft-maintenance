import { runCommand, hydrate, errorsOf } from "./runCommand";
import {
  submitOperation,
  FlightRejection,
} from "../src/domain/flightSubmission";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { costRecordSchema } from "../src/domain/costs";
import { costDocs } from "./programContext";
import { poSchema } from "../src/domain/purchaseOrders";
import { faaMonitorSchema } from "../src/domain/faa";
import { adSchema } from "../src/domain/airworthiness";
import { preserveOilInventory } from "../src/domain/oilInventory";
import { preserveChecklistLink } from "../src/domain/flightChecklistLink";
import { checklistRecordSchema } from "../src/domain/checklists";
import {
  saveDiscrepancyParts as applyDiscrepancyParts,
  requiredPartsSchema,
} from "../src/domain/requiredParts";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import { taskCardSchema } from "../src/domain/taskCards";
import { workOrderSchema } from "../src/domain/workOrders";
import {
  flightPlanSchema,
  validatePlanFlight,
} from "../src/domain/flightPlans";
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
  auditDocs,
} from "./programContext";
import {
  scopedSnapshot,
  activeProgram,
  programPermission,
  programIds,
} from "../src/domain/programs";
import {
  recordSchema,
  validateMaintenanceTotals,
} from "../src/domain/management";
import { isOwnerView, ownerSnapshot } from "../src/domain/ownerView";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { programUsers } from "./memberships";
import { v } from "convex/values";
import { earliestLocalDate } from "../src/domain/aircraftStatus";
import {
  deferCommandSchema,
  deferDiscrepancy as applyDeferral,
} from "../src/domain/deferrals";
import {
  authorized,
  aircraftByUuid,
  audit,
  admin,
  member,
  group,
  activeIdentity,
} from "./access";
import { flightFields, operationValidator } from "./validators";
import {
  operationSchema,
  type Aircraft,
  type Flight,
  type Operation,
  type Snapshot,
} from "../src/domain/model";
import {
  validateFlight,
  rebuildFlights,
  resequencedFlights,
  resequenceReason,
} from "../src/domain/flights";
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
    [...new Set(flights.flatMap((f) => [f.pilotId, f.copilotId]))].map((id) => {
      const userId = id ? ctx.db.normalizeId("users", id) : null;
      return userId ? ctx.db.get(userId) : null;
    }),
  );
  const users = [
    user,
    ...(program ? await programUsers(ctx, program) : []),
    ...pilots.filter((p): p is Doc<"users"> => p !== null),
  ];
  return [...new Map(users.map((u) => [u._id, u])).values()];
}
export const snapshot = query({
  args: {},
  handler: async (ctx): Promise<Snapshot | null> => {
    const identity = await activeIdentity(ctx);
    if (!identity) return null;
    const { user, session } = identity;
    const state = await context(ctx, user);
    const program = activeProgram(state);
    const aircraft = state.aircraft;
    const management = await managementDocs(ctx, program);
    const credential = await ctx.db.query("faaCredentials").unique();
    const flights = await flightDocs(ctx, aircraft);
    const snapshot = scopedSnapshot({
      ...state,
      faaCredential: {
        configured: !!(credential?.key || process.env.FAA_DRS_API_KEY),
        expiresOn: credential?.expiresOn || "",
        version: credential?.version ?? 0,
      },
      user: member(user),
      authenticatedAt: session._creationTime,
      members: (await snapshotMembers(ctx, user, program, flights)).map(member),
      flights,
      taskCards: (await taskCardDocs(ctx, aircraft)).map((t) =>
        taskCardSchema.parse(JSON.parse(t.payload)),
      ),
      archivedTaskCards: (await archivedTaskCardDocs(ctx, aircraft)).map((t) =>
        taskCardSchema.parse(JSON.parse(t.payload)),
      ),
      faaMonitors: (await faaMonitorDocs(ctx, aircraft)).map((d) =>
        faaMonitorSchema.parse(JSON.parse(d.payload)),
      ),
      airworthiness: (await airworthinessDocs(ctx, aircraft)).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      partsRequests: (await partsRequestDocs(ctx, program)).map((r) =>
        partsRequestSchema.parse(JSON.parse(r.payload)),
      ),
      purchaseOrders: (await purchaseOrderDocs(ctx, program)).map((p) =>
        poSchema.parse(JSON.parse(p.payload)),
      ),
      checklists: (await checklistDocs(ctx, program)).map((c) =>
        checklistRecordSchema.parse(JSON.parse(c.payload)),
      ),
      workOrders: (await workOrderDocs(ctx, aircraft)).map((w) =>
        workOrderSchema.parse(JSON.parse(w.payload)),
      ),
      flightPlans: (await flightPlanDocs(ctx, aircraft)).map((p) =>
        flightPlanSchema.parse(JSON.parse(p.payload)),
      ),
      discrepancies: await discrepancyDocs(ctx, aircraft),
      componentTemplates: (await componentTemplateDocs(ctx, program)).map((d) =>
        JSON.parse(d.payload),
      ),
      componentSetups: (await componentSetupDocs(ctx, program)).map((d) =>
        JSON.parse(d.payload),
      ),
      inspectionTemplates: (await inspectionTemplateDocs(ctx, program)).map(
        (d) => inspectionTemplateSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, aircraft, management),
      management: management.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      audit: await auditDocs(ctx, program, aircraft),
      // scopedSnapshot strips rates and money for non-administrators.
      costs: (await costDocs(ctx, program, aircraft)).map((d) =>
        costRecordSchema.parse(JSON.parse(d.payload)),
      ),
      aircraft: state.aircraft.map((a) => ({
        ...a,
        program:
          state.programs.find((p) => p.uuid === a.programUuid)?.name ??
          a.program,
      })),
    });
    snapshot.aircraft = await Promise.all(
      snapshot.aircraft.map(async (a) => {
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
    snapshot.inventoryAttachments = (
      await Promise.all(
        (snapshot.management ?? [])
          .filter(
            (r) =>
              programPermission(snapshot, "admin") &&
              (r.kind === "stock" || r.kind === "component"),
          )
          .map(async (stock) => {
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
                url: (await ctx.storage.getUrl(f.storageId)) ?? "",
              })),
            );
          }),
      )
    ).flat();
    snapshot.workOrderAttachments = (
      await Promise.all(
        (snapshot.workOrders ?? []).map(async (w) => {
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
              url: (await ctx.storage.getUrl(f.storageId)) ?? "",
            })),
          );
        }),
      )
    ).flat();
    snapshot.taskEvidence = (
      await Promise.all(
        [
          ...(snapshot.taskCards ?? []),
          ...(snapshot.archivedTaskCards ?? []),
        ].map(async (t) => {
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
              url: (await ctx.storage.getUrl(f.storageId)) ?? "",
            })),
          );
        }),
      )
    ).flat();
    // Re-apply the owner whitelist after attachment URLs are added above.
    return isOwnerView(snapshot) ? ownerSnapshot(snapshot) : snapshot;
  },
});
// Loads what submitting an outbox entry reads (see submitOperation): the
// entry's earlier submission, or else the records it refers to, its crew and
// the aircraft's airworthiness state for the dispatch gate.
async function submissionState(
  ctx: MutationCtx,
  state: Snapshot,
  operation: Operation,
) {
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
  if (operation.kind === "discrepancy") {
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
    return {
      aircraft,
      management: [],
      snapshot: {
        ...state,
        discrepancies: existing ? [existing] : [],
        flights: flight ? [flight] : [],
      },
    };
  }
  const { input } = operation;
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
  const checklist = input.checklistRun
    ? await ctx.db
        .query("checklists")
        .withIndex("uuid", (q) =>
          q.eq("uuid", input.checklistRun!.checklistUuid),
        )
        .unique()
    : null;
  const plan = input.flightPlanUuid
    ? await ctx.db
        .query("flightPlans")
        .withIndex("uuid", (q) => q.eq("uuid", input.flightPlanUuid!))
        .unique()
    : null;
  const crew = await Promise.all(
    [input.pilotId, input.copilotId].filter(Boolean).map((id) => {
      const userId = ctx.db.normalizeId("users", id!);
      return userId ? ctx.db.get(userId) : null;
    }),
  );
  // The airworthiness status of this aircraft (program-wide airworthiness so
  // ADs that follow an installed component are included), and the program's
  // stock for oil drawn down on the flight line.
  const only = state.aircraft.filter((a) => a.uuid === aircraftUuid);
  const management = await managementDocs(ctx, activeProgram(state));
  return {
    aircraft,
    management,
    snapshot: {
      ...state,
      management: management.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      inspections: await inspectionDocs(ctx, only, management),
      airworthiness: (await airworthinessDocs(ctx, state.aircraft)).map((d) =>
        adSchema.parse(JSON.parse(d.payload)),
      ),
      discrepancies: await discrepancyDocs(ctx, only),
      checklists: checklist
        ? [checklistRecordSchema.parse(JSON.parse(checklist.payload))]
        : [],
      flightPlans: plan
        ? [flightPlanSchema.parse(JSON.parse(plan.payload))]
        : [],
      flights: input.flightPlanUuid
        ? await ctx.db
            .query("flights")
            .withIndex("plan", (q) =>
              q.eq("flightPlanUuid", input.flightPlanUuid!),
            )
            .collect()
        : [],
      members: crew.filter((u): u is Doc<"users"> => u !== null).map(member),
    },
  };
}
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
      persist: async ({ ctx }, { aircraft, management }, { changes }) => {
        if (!changes) return;
        for (const change of changes.stock) {
          const doc = management.find((d) => d.uuid === change.before.uuid)!;
          await ctx.db.patch(doc._id, {
            payload: JSON.stringify(change.after),
          });
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
      },
      audit: (log, _, { changes }) => {
        for (const entry of changes?.audit ?? [])
          log.entry(entry.action, entry.entityUuid, entry);
      },
      returns: ({ status }) => ({ status }),
    });
  },
});
export const resolveDiscrepancy = mutation({
  args: {
    uuid: v.string(),
    resolution: v.string(),
    programUuid: v.optional(v.string()),
  },
  handler: async (ctx, { uuid, resolution, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const d = await ctx.db
      .query("discrepancies")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    if (!d) throw new Error("Report not found.");
    const user = await authorized(ctx, d.aircraftUuid, "resolve", state);
    if (!resolution.trim() || resolution.length > 5000)
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
export const deferDiscrepancy = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, { payload, programUuid }) =>
    runCommand(ctx, {
      programUuid,
      parse: () => deferCommandSchema.parse(JSON.parse(payload)),
      load: async ({ ctx, state }, command) => {
        const d = await ctx.db
          .query("discrepancies")
          .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
          .unique();
        if (!d) throw new Error("Report not found.");
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
export const reviewFlight = mutation({
  args: {
    uuid: v.string(),
    programUuid: v.optional(v.string()),
    decision: v.union(v.literal("accept"), v.literal("reject")),
    reason: v.string(),
    input: v.object(flightFields),
  },
  handler: async (ctx, { uuid, decision, reason, input, programUuid }) => {
    const scope = await checkContext(ctx, programUuid);
    if (!programPermission(scope, "admin"))
      throw new Error("Flight Program administrator required.");
    const user = await authorized(ctx, input.aircraftUuid, "read", scope);
    if (reason.trim().length < 5 || reason.length > 5000)
      throw new Error("Provide a meaningful review explanation.");
    const flight = await ctx.db
      .query("flights")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique();
    if (!flight) throw new Error("Flight not found.");
    preserveChecklistLink(flight, input);
    preserveOilInventory(flight, input);
    if (input.flightPlanUuid !== flight.flightPlanUuid)
      throw new Error("A review cannot change the linked flight plan.");
    if (
      decision === "accept" &&
      flight.status === "rejected" &&
      input.flightPlanUuid
    ) {
      const plan = await ctx.db
        .query("flightPlans")
        .withIndex("uuid", (q) => q.eq("uuid", input.flightPlanUuid!))
        .unique();
      validatePlanFlight(
        {
          ...scope,
          flightPlans: plan
            ? [flightPlanSchema.parse(JSON.parse(plan.payload))]
            : [],
          flights: await ctx.db
            .query("flights")
            .withIndex("plan", (q) =>
              q.eq("flightPlanUuid", input.flightPlanUuid!),
            )
            .collect(),
        },
        input,
      );
    }
    if (input.aircraftUuid !== flight.aircraftUuid)
      throw new Error("A correction cannot change aircraft.");
    if (input.discrepancy !== flight.discrepancy)
      throw new Error(
        "Use the discrepancy workflow to update problem reports.",
      );
    const aircraft = await aircraftByUuid(ctx, flight.aircraftUuid);
    const pilot = ctx.db.normalizeId("users", input.pilotId);
    if (!pilot || !(await ctx.db.get(pilot)))
      throw new Error("Pilot not found.");
    if (input.copilotId) {
      const copilot = ctx.db.normalizeId("users", input.copilotId);
      if (!copilot || !(await ctx.db.get(copilot)))
        throw new Error("Copilot not found.");
    }
    for (const id of [input.pilotId, input.copilotId].filter(Boolean)) {
      const memberId = ctx.db.normalizeId("users", id!);
      const pilot = memberId ? await ctx.db.get(memberId) : null;
      if (
        (id === input.pilotId && id === flight.pilotId) ||
        (id === input.copilotId && id === flight.copilotId)
      )
        continue;
      if (
        !pilot ||
        (!pilot.isAdmin &&
          !programIds(member(pilot), scope.groups).includes(
            aircraft.programUuid ?? "",
          ))
      )
        throw new Error("Pilot must belong to this Flight Program.");
    }
    validateFlight(aircraft, input);
    const next: Flight = {
      ...flight,
      ...input,
      status: decision === "accept" ? "accepted" : "rejected",
      reviewReason: reason,
    };
    const all = await ctx.db
      .query("flights")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", flight.aircraftUuid))
      .collect();
    const rebuilt = rebuildFlights(
      aircraft,
      all.map((f) => (f.uuid === uuid ? next : f)),
      all,
    );
    validateMaintenanceTotals(
      rebuilt.aircraft,
      (await managementDocs(ctx, aircraft.programUuid)).map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      await ctx.db
        .query("inspections")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraft.uuid))
        .collect(),
    );
    for (const accepted of rebuilt.flights) {
      const original = all.find((f) => f.uuid === accepted.uuid)!;
      await ctx.db.patch(original._id, {
        hobbsOff: accepted.hobbsOff,
        tachOff: accepted.tachOff,
        cyclicHobbsOff: accepted.cyclicHobbsOff,
        flightTimeLogOff: accepted.flightTimeLogOff,
      });
    }
    const a: Aircraft = rebuilt.aircraft;
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
    // A report is never silently removed by correcting flight text.
    await audit(ctx, user._id, "flight.reviewed", uuid, {
      aircraftUuid: flight.aircraftUuid,
      reason,
      before: flight,
      after: { ...next, ...saved },
    });
    for (const change of resequencedFlights(all, rebuilt.flights, uuid))
      await audit(ctx, user._id, "flight.resequenced", change.flight.uuid, {
        aircraftUuid: flight.aircraftUuid,
        reason: resequenceReason(flight, next),
        before: change.before,
        after: change.after,
      });
  },
});

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
        const d = await ctx.db
          .query("discrepancies")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .unique();
        if (!d) throw new Error("Report not found.");
        const { snapshot } = await hydrate(ctx, state, ["management"]);
        snapshot.discrepancies = [d];
        return { d, snapshot, before: structuredClone(d) };
      },
      // The domain checks maintenance permission and the parts version.
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

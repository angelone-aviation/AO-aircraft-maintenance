import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { currentUser, member, group } from "./access";
import { activeProgram, programPermission } from "../src/domain/programs";
import type { Snapshot } from "../src/domain/model";
import { isOwnerView } from "../src/domain/ownerView";
type Ctx = QueryCtx | MutationCtx;
// Loads only the caller's tenant: their own groups plus the active program's
// groups, the active program's aircraft, and manuals for those aircraft.
// Programs stay a full read: one small row per tenant, admins switch between
// all of them, and program names are unique across tenants.
export async function context(ctx: Ctx, known?: Doc<"users">) {
  const user = known ?? (await currentUser(ctx));
  const caller = member(user);
  const programs = await ctx.db.query("programs").collect();
  const own = user.isAdmin
    ? await ctx.db.query("groups").collect()
    : (
        await Promise.all((user.groupIds ?? []).map((id) => ctx.db.get(id)))
      ).filter((g): g is Doc<"groups"> => g !== null);
  const program = activeProgram({
    user: caller,
    groups: own.map(group),
    programs,
  });
  const local =
    user.isAdmin || !program
      ? []
      : await ctx.db
          .query("groups")
          .withIndex("program", (q) => q.eq("programUuid", program))
          .collect();
  const groups = [
    ...new Map([...own, ...local].map((g) => [g._id, g])).values(),
  ].map(group);
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("program", (q) => q.eq("programUuid", program))
    .collect();
  const manuals = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("manuals")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
  return {
    user: caller,
    groups,
    programs,
    aircraft,
    manuals: manuals.map(
      ({ storageId: _storage, _id, _creationTime, ...manual }) => manual,
    ),
    members: [],
    flights: [],
    inspections: [],
    discrepancies: [],
    audit: [],
    syncedAt: Date.now(),
    authenticatedAt: Date.now(),
  } satisfies Snapshot;
}
export async function checkContext(
  ctx: Ctx,
  expected?: string,
  known?: Doc<"users">,
) {
  const state = await context(ctx, known);
  if (!state.user.isAdmin && !programPermission(state, "read"))
    throw new Error("Flight Program permission denied.");
  // Aircraft owners only read their snapshot; every program-scoped command
  // and auxiliary query passes through here.
  if (isOwnerView(state))
    throw new Error("Aircraft owner access is read-only.");
  if (activeProgram(state) !== expected)
    throw new Error(
      "Flight Program changed. Reopen the form in the correct program.",
    );
  return state;
}

// Program-scoped row loaders. Every caller passes the active program (or its
// aircraft), so reads and reactive invalidation stay within one tenant.
type Aircraft = { uuid: string }[];
export async function perAircraft<T>(
  aircraft: Aircraft,
  load: (aircraftUuid: string) => Promise<T[]>,
) {
  return (await Promise.all(aircraft.map((a) => load(a.uuid)))).flat();
}
export async function managementDocs(ctx: Ctx, programUuid?: string) {
  const docs = await ctx.db
    .query("management")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  if (programUuid === undefined) return docs;
  // Legacy rows without a program column derive ownership from their location,
  // component or aircraft (recordProgram), so they stay visible to the domain.
  const legacy = await ctx.db
    .query("management")
    .withIndex("program", (q) => q.eq("programUuid", undefined))
    .collect();
  return [...docs, ...legacy];
}
export async function inspectionDocs(
  ctx: Ctx,
  aircraft: Aircraft,
  management: Doc<"management">[],
) {
  const docs = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
  // Schedules of removed components travel with the component, not an aircraft.
  const loose = await Promise.all(
    management
      .filter((d) => d.kind === "component" && !d.aircraftUuid)
      .map((d) =>
        ctx.db
          .query("inspections")
          .withIndex("component", (q) => q.eq("componentUuid", d.uuid))
          .collect(),
      ),
  );
  return [
    ...new Map([...docs, ...loose.flat()].map((d) => [d._id, d])).values(),
  ];
}
export const flightDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("flights")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const discrepancyDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("discrepancies")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const taskCardDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("taskCards")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const archivedTaskCardDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("archivedTaskCards")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const workOrderDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("workOrders")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const flightPlanDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("flightPlans")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const faaMonitorDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const airworthinessDocs = (ctx: Ctx, aircraft: Aircraft) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("airworthiness")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
export const partsRequestDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("partsRequests")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);
export const purchaseOrderDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("purchaseOrders")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);
export const checklistDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("checklists")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);
export const componentTemplateDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("componentTemplates")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);
export const componentSetupDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("componentSetups")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);
export const inspectionTemplateDocs = (ctx: Ctx, programUuid?: string) =>
  ctx.db
    .query("inspectionTemplates")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
// Change-log rows a transfer listed for a program (see transferredAudit),
// newest first, below an optional _creationTime.
export async function transferredAuditDocs(
  ctx: Ctx,
  programUuid: string | undefined,
  take: number,
  before?: number,
) {
  if (!programUuid) return [];
  const links = await ctx.db
    .query("transferredAudit")
    .withIndex("program", (q) => {
      const eq = q.eq("programUuid", programUuid);
      return before === undefined ? eq : eq.lt("auditCreationTime", before);
    })
    .order("desc")
    .take(take);
  return (await Promise.all(links.map((l) => ctx.db.get(l.auditId)))).filter(
    (d): d is Doc<"audit"> => d !== null,
  );
}
// The History page renders the snapshot list; keep it to recent activity.
export const AUDIT_LIMIT = 250;
const AIRCRAFT_AUDIT_LIMIT = 50;
export async function auditDocs(
  ctx: Ctx,
  programUuid: string | undefined,
  aircraft: Aircraft,
) {
  const docs = [
    ...(await ctx.db
      .query("audit")
      .withIndex("program", (q) => q.eq("programUuid", programUuid))
      .order("desc")
      .take(AUDIT_LIMIT)),
    ...(await perAircraft(aircraft, (id) =>
      ctx.db
        .query("audit")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
        .order("desc")
        .take(AIRCRAFT_AUDIT_LIMIT),
    )),
    ...(await transferredAuditDocs(ctx, programUuid, AUDIT_LIMIT)),
  ];
  return [...new Map(docs.map((d) => [d._id, d])).values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, AUDIT_LIMIT);
}

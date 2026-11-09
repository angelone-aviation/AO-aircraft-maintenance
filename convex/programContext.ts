/**
 * Responsibility: The caller's Flight Program context, its checks, and the
 *   program-scoped loaders every server read goes through.
 * Layer: Server. Convex reads only; the permission rules come from src/domain.
 * Dependencies: convex/values, ./_generated, ./access, src/domain (programs,
 *   model, ownerView).
 *
 * Loaders read one tenant, per program or per aircraft of the program, so
 * reads and reactive invalidation stay within it.
 */
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { currentUser, member, group } from "./access";
import { activeProgram, programPermission } from "../src/domain/programs";
import type { Snapshot } from "../src/domain/model";
import { isOwnerView } from "../src/domain/ownerView";

type Ctx = QueryCtx | MutationCtx;
/** The aircraft a per-aircraft loader reads for. */
type AircraftRefs = { uuid: string }[];

/** How many change-log rows the snapshot's History list holds. */
export const AUDIT_LIMIT = 250;
const AIRCRAFT_AUDIT_LIMIT = 50;

/**
 * The caller's tenant as a Snapshot: their own groups plus the active
 * program's, the program's aircraft and their manuals, and every program (one
 * small row each; administrators switch between them all). Other collections
 * start empty.
 *
 * @param known - The caller, when already loaded.
 * @throws {Error} The session refusal of currentUser, when `known` is absent.
 */
export async function context(ctx: Ctx, known?: Doc<"users">) {
  const user = known ?? (await currentUser(ctx));
  const caller = member(user);
  const programs = await ctx.db.query("programs").collect();
  const own = await ownGroups(ctx, user);
  const program = activeProgram({
    user: caller,
    groups: own.map(group),
    programs,
  });
  const groups = await withProgramGroups(ctx, user, program, own);
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("program", (q) => q.eq("programUuid", program))
    .collect();
  return {
    user: caller,
    groups,
    programs,
    aircraft,
    manuals: await snapshotManuals(ctx, aircraft),
    members: [],
    flights: [],
    inspections: [],
    discrepancies: [],
    audit: [],
    syncedAt: Date.now(),
    authenticatedAt: Date.now(),
  } satisfies Snapshot;
}

/**
 * The caller's context, checked before any program-scoped command or
 * auxiliary query reads further. Administrators pass the read check.
 *
 * @param expected - The Flight Program the client acted in.
 * @throws {Error} The session refusal of currentUser.
 * @throws {ConvexError} In this order: "Flight Program permission denied."
 *   without read permission; "Aircraft owner access is read-only." for an
 *   aircraft owner; "Flight Program changed. Reopen the form in the correct
 *   program." when `expected` is not the active program.
 */
export async function checkContext(
  ctx: Ctx,
  expected?: string,
  known?: Doc<"users">,
) {
  const state = await context(ctx, known);
  if (!state.user.isAdmin && !programPermission(state, "read"))
    throw new ConvexError("Flight Program permission denied.");
  if (isOwnerView(state))
    throw new ConvexError("Aircraft owner access is read-only.");
  if (activeProgram(state) !== expected)
    throw new ConvexError(
      "Flight Program changed. Reopen the form in the correct program.",
    );
  return state;
}

/**
 * Runs one loader per aircraft, in parallel.
 *
 * @returns Every aircraft's rows, in the order of `aircraft`.
 */
export async function perAircraft<T>(
  aircraft: AircraftRefs,
  load: (aircraftUuid: string) => Promise<T[]>,
) {
  return (await Promise.all(aircraft.map((a) => load(a.uuid)))).flat();
}

/**
 * The program's records, plus legacy rows stored without a program: the
 * domain derives their program from their location, component or aircraft
 * (recordProgram).
 *
 * @param programUuid - The program; undefined reads only the rows without one.
 */
export async function managementDocs(ctx: Ctx, programUuid?: string) {
  const docs = await ctx.db
    .query("management")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  if (programUuid === undefined) return docs;
  const legacy = await ctx.db
    .query("management")
    .withIndex("program", (q) => q.eq("programUuid", undefined))
    .collect();
  return [...docs, ...legacy];
}

/**
 * The aircraft's inspections, plus those of removed components, which travel
 * with the component rather than an aircraft.
 *
 * @param management - The program's records, to find removed components.
 * @returns Each inspection once.
 */
export async function inspectionDocs(
  ctx: Ctx,
  aircraft: AircraftRefs,
  management: Doc<"management">[],
) {
  const docs = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("inspections")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
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

/** The aircraft's flights. */
export const flightDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("flights")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's problem reports. */
export const discrepancyDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("discrepancies")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's job cards. */
export const taskCardDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("taskCards")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's archived job cards. */
export const archivedTaskCardDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("archivedTaskCards")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's work orders. */
export const workOrderDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("workOrders")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's flight plans. */
export const flightPlanDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("flightPlans")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's FAA airworthiness-directive monitors. */
export const faaMonitorDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("faaMonitors")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The aircraft's airworthiness-directive records. */
export const airworthinessDocs = (ctx: Ctx, aircraft: AircraftRefs) =>
  perAircraft(aircraft, (id) =>
    ctx.db
      .query("airworthiness")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );

/** The program's parts requests; none without a program. */
export const partsRequestDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("partsRequests")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);

/** The program's purchase orders; none without a program. */
export const purchaseOrderDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("purchaseOrders")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);

/** The program's checklists; none without a program. */
export const checklistDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("checklists")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);

/** The program's component templates; none without a program. */
export const componentTemplateDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("componentTemplates")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);

/** The program's component setups; none without a program. */
export const componentSetupDocs = (ctx: Ctx, programUuid?: string) =>
  programUuid
    ? ctx.db
        .query("componentSetups")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : Promise.resolve([]);

/**
 * The aircraft's cost records, plus the program's settings row (stored with
 * aircraftUuid "").
 */
export async function costDocs(
  ctx: Ctx,
  programUuid: string | undefined,
  aircraft: AircraftRefs,
) {
  const rows = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("costs")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
  const settings = programUuid
    ? await ctx.db
        .query("costs")
        .withIndex("program", (q) =>
          q.eq("programUuid", programUuid).eq("aircraftUuid", ""),
        )
        .collect()
    : [];
  return [...rows, ...settings];
}

/**
 * The program's expiring dates, plus the deployment's own (rows without a
 * program) for a system administrator.
 *
 * @param programUuid - The program; undefined reads only the system rows.
 * @param systemWide - Whether the caller may read the deployment's own rows.
 */
export async function expiringItemDocs(
  ctx: Ctx,
  programUuid: string | undefined,
  systemWide: boolean,
) {
  const own = programUuid
    ? await ctx.db
        .query("expiringItems")
        .withIndex("program", (q) => q.eq("programUuid", programUuid))
        .collect()
    : [];
  const system = systemWide
    ? await ctx.db
        .query("expiringItems")
        .withIndex("program", (q) => q.eq("programUuid", undefined))
        .collect()
    : [];
  return [...own, ...system];
}

/** The program's inspection templates; without one, the unassigned ones. */
export const inspectionTemplateDocs = (ctx: Ctx, programUuid?: string) =>
  ctx.db
    .query("inspectionTemplates")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();

/**
 * Change-log rows a transfer listed for the program (see transferredAudit).
 *
 * @param take - The most rows to return.
 * @param before - Only rows whose audit `_creationTime` is below this.
 * @returns Newest first; none without a program.
 */
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

/**
 * Recent activity for the History list: the program's rows, the latest
 * AIRCRAFT_AUDIT_LIMIT of each aircraft, and the rows transfers listed.
 *
 * @returns At most {@link AUDIT_LIMIT} rows, each once, newest `at` first.
 */
export async function auditDocs(
  ctx: Ctx,
  programUuid: string | undefined,
  aircraft: AircraftRefs,
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

// An administrator holds every group; anyone else, the groups they list.
async function ownGroups(ctx: Ctx, user: Doc<"users">) {
  if (user.isAdmin) return ctx.db.query("groups").collect();
  const groups = await Promise.all(
    (user.groupIds ?? []).map((id) => ctx.db.get(id)),
  );
  return groups.filter((g): g is Doc<"groups"> => g !== null);
}

// A non-administrator's context also lists the active program's other groups;
// an administrator's own list already holds every group. Each group once.
async function withProgramGroups(
  ctx: Ctx,
  user: Doc<"users">,
  program: string | undefined,
  own: Doc<"groups">[],
) {
  const local =
    user.isAdmin || !program
      ? []
      : await ctx.db
          .query("groups")
          .withIndex("program", (q) => q.eq("programUuid", program))
          .collect();
  return [...new Map([...own, ...local].map((g) => [g._id, g])).values()].map(
    group,
  );
}

async function snapshotManuals(ctx: Ctx, aircraft: AircraftRefs) {
  const manuals = await perAircraft(aircraft, (id) =>
    ctx.db
      .query("manuals")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect(),
  );
  return manuals.map(
    ({ storageId: _storage, _id, _creationTime, ...manual }) => manual,
  );
}

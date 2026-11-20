/**
 * Responsibility: The workspace snapshot as operations.snapshot built it
 *   before the retention window: every record of the program, files read
 *   per aircraft, then narrowed by a view the test chooses.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex (_generated, access, collections, programContext,
 *   aircraftFiles, faaCredentials, memberships, backups, costLedger,
 *   workingSet, recordsDate), src/domain (programs, ownerView, boardView,
 *   costs, model).
 *
 * The oracle for the windowed snapshot (ADR-0013, stage S7): the server's
 * result must equal this load narrowed by the window. Kept as it was, so a
 * change to the server's loaders cannot change what it is compared with.
 */
import type { QueryCtx } from "../../convex/_generated/server";
import type { Doc } from "../../convex/_generated/dataModel";
import { activeIdentity, member } from "../../convex/access";
import { decode, decodeFlight } from "../../convex/collections";
import {
  airworthinessDocs,
  archivedTaskCardDocs,
  auditDocs,
  checklistDocs,
  componentSetupDocs,
  componentTemplateDocs,
  context,
  costDocs,
  discrepancyDocs,
  expiringItemDocs,
  faaMonitorDocs,
  flightPlanDocs,
  inspectionDocs,
  inspectionTemplateDocs,
  managementDocs,
  partsRequestDocs,
  perAircraft,
  purchaseOrderDocs,
  taskCardDocs,
  workOrderDocs,
} from "../../convex/programContext";
import { aircraftFileList } from "../../convex/aircraftFiles";
import { faaCredentialStatus } from "../../convex/faaCredentials";
import { programUsers } from "../../convex/memberships";
import { latestCopy } from "../../convex/backups";
import { ledgerRowsOf } from "../../convex/costLedger";
import { budgetAndSettingsDocs } from "../../convex/workingSet";
import { recordsDate } from "../../convex/recordsDate";
import { activeProgram, programPermission } from "../../src/domain/programs";
import {
  isOwnerView,
  ownerPortalAircraft,
  ownerPortalFiles,
} from "../../src/domain/ownerView";
import {
  boardCostPeriods,
  boardCostTotals,
  isBoardView,
} from "../../src/domain/boardView";
import { ledgerTotals } from "../../src/domain/costs/ledger";
import type { Period } from "../../src/domain/costs/period";
import type { Aircraft, Flight, Snapshot } from "../../src/domain/model";

/** Narrows a whole load: scopedSnapshot alone gives the old workspace. */
export type LegacyView = (full: Snapshot, today: string) => Snapshot;

type Identity = { user: Doc<"users">; session: Doc<"authSessions"> };
type ProgramState = Awaited<ReturnType<typeof context>>;

/**
 * The signed-in caller's snapshot from whole history: the workspace, or an
 * owner's or board member's records, passed through `view`, with the photo
 * flags and file lists added from per-aircraft reads.
 *
 * @param view - What the server applies to the whole load.
 * @returns null without an active account and session.
 */
export async function legacySnapshot(
  ctx: QueryCtx,
  view: LegacyView,
): Promise<Snapshot | null> {
  const identity = await activeIdentity(ctx);
  if (!identity) return null;
  const state = await context(ctx, identity.user);
  const today = recordsDate();
  if (!isOwnerView(state) && !isBoardView(state))
    return addWorkspaceExtras(
      ctx,
      view(await fullSnapshot(ctx, identity, state), today),
    );
  const records = await reducedViewRecords(ctx, identity, state, today);
  return addReducedViewExtras(ctx, view(records, today));
}

async function addWorkspaceExtras(ctx: QueryCtx, snapshot: Snapshot) {
  snapshot.aircraft = await withPhotoFlags(ctx, snapshot.aircraft);
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
}

async function addReducedViewExtras(ctx: QueryCtx, snapshot: Snapshot) {
  if (isBoardView(snapshot))
    snapshot.offsiteBackupAt = (await latestCopy(ctx))?.completedAt;
  if (!isOwnerView(snapshot)) return snapshot;
  const owned = ownerPortalAircraft(snapshot);
  const withPhotos = await withPhotoFlags(ctx, owned);
  snapshot.aircraft = snapshot.aircraft.map(
    (a) => withPhotos.find((photo) => photo.uuid === a.uuid) ?? a,
  );
  snapshot.aircraftFiles = ownerPortalFiles(
    await aircraftFileList(ctx, { ...snapshot, aircraft: owned }),
    owned,
  );
  return snapshot;
}

async function reducedViewRecords(
  ctx: QueryCtx,
  { user, session }: Identity,
  state: ProgramState,
  today: string,
): Promise<Snapshot> {
  const program = activeProgram(state);
  const aircraft = state.aircraft;
  const management = await managementDocs(ctx, program);
  return {
    ...state,
    user: member(user),
    authenticatedAt: session._creationTime,
    members: [member(user)],
    discrepancies: await discrepancyDocs(ctx, aircraft),
    airworthiness: decode(
      "airworthiness",
      await airworthinessDocs(ctx, aircraft),
    ),
    workOrders: decode("workOrders", await workOrderDocs(ctx, aircraft)),
    ...(isBoardView(state) && program
      ? await boardCosts(ctx, state, program, today)
      : {}),
    inspections: await inspectionDocs(ctx, aircraft, management),
    management: decode("management", management),
    aircraft: withProgramNames(state),
  };
}

async function boardCosts(
  ctx: QueryCtx,
  state: ProgramState,
  program: string,
  today: string,
): Promise<Pick<Snapshot, "costs" | "boardCosts">> {
  const { wholeYear } = boardCostPeriods(today);
  const rows = new Map(
    await Promise.all(
      state.aircraft.map(
        async (a) =>
          [
            a.uuid,
            await ledgerRowsOf(ctx, program, a.uuid, wholeYear),
          ] as const,
      ),
    ),
  );
  const costs = decode("costs", await budgetAndSettingsDocs(ctx, program));
  const spend = (aircraftUuid: string, period: Period) =>
    ledgerTotals(rows.get(aircraftUuid) ?? [], period).totalCents;
  return {
    costs,
    boardCosts: boardCostTotals({ ...state, costs }, today, spend),
  };
}

async function fullSnapshot(
  ctx: QueryCtx,
  { user, session }: Identity,
  state: ProgramState,
): Promise<Snapshot> {
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
    costs: decode("costs", await costDocs(ctx, program)),
    expiringItems: decode(
      "expiringItems",
      await expiringItemDocs(ctx, program, user.isAdmin === true),
    ),
    aircraft: withProgramNames(state),
  };
}

const flightDocs = (ctx: QueryCtx, aircraft: Aircraft[]) =>
  perAircraft(aircraft, async (id) => {
    const rows = await ctx.db
      .query("flights")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", id))
      .collect();
    return rows.map(decodeFlight);
  });

function withProgramNames(state: ProgramState) {
  return state.aircraft.map((a) => ({
    ...a,
    program:
      state.programs.find((p) => p.uuid === a.programUuid)?.name ?? a.program,
  }));
}

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

async function withPhotoFlags(ctx: QueryCtx, aircraft: Aircraft[]) {
  return Promise.all(
    aircraft.map(async (a) => {
      const photo = await ctx.db
        .query("aircraftPhotos")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", a.uuid))
        .unique();
      return photo ? { ...a, hasPhoto: true } : a;
    }),
  );
}

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
      return files.map((f) => ({
        uuid: f._id,
        stockUuid: f.stockUuid,
        name: f.name,
        type: f.type,
        size: f.size,
        uploadedAt: f.uploadedAt,
      }));
    }),
  );
  return lists.flat();
}

async function workOrderAttachments(
  ctx: QueryCtx,
  workOrders: NonNullable<Snapshot["workOrders"]>,
) {
  const files = await filesByRecord(
    workOrders,
    (aircraftUuid) =>
      ctx.db
        .query("workOrderFiles")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
        .collect(),
    (f) => f.workOrderUuid,
  );
  return workOrders.flatMap((w) =>
    (files.get(w.uuid) ?? []).map((f) => ({
      uuid: f._id,
      workOrderUuid: w.uuid,
      name: f.name,
      size: f.size,
      uploadedAt: f.uploadedAt,
    })),
  );
}

async function taskEvidence(
  ctx: QueryCtx,
  cards: NonNullable<Snapshot["taskCards"]>,
) {
  const files = await filesByRecord(
    cards,
    (aircraftUuid) =>
      ctx.db
        .query("taskEvidence")
        .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
        .collect(),
    (f) => f.taskCardUuid,
  );
  return cards.flatMap((t) =>
    (files.get(t.uuid) ?? []).map((f) => ({
      uuid: f._id,
      taskCardUuid: t.uuid,
      name: f.name,
      size: f.size,
      uploadedAt: f.uploadedAt,
      category: f.category,
    })),
  );
}

async function filesByRecord<F extends { _creationTime: number }>(
  records: { aircraftUuid: string }[],
  readAircraft: (aircraftUuid: string | undefined) => Promise<F[]>,
  recordOf: (file: F) => string,
): Promise<Map<string, F[]>> {
  const aircraft = [...new Set(records.map((r) => r.aircraftUuid))];
  const files = [
    ...(await perAircraft(
      aircraft.map((uuid) => ({ uuid })),
      readAircraft,
    )),
    ...(await readAircraft(undefined)),
  ].sort((a, b) => a._creationTime - b._creationTime);
  const byRecord = new Map<string, F[]>();
  for (const f of files) {
    const list = byRecord.get(recordOf(f));
    if (list) list.push(f);
    else byRecord.set(recordOf(f), [f]);
  }
  return byRecord;
}

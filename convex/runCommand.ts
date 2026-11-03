import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { AuditEntry, Snapshot } from "../src/domain/model";
import { activeProgram } from "../src/domain/programs";
import { recordSchema } from "../src/domain/management";
import { taskCardSchema } from "../src/domain/taskCards";
import { workOrderSchema } from "../src/domain/workOrders";
import { adSchema } from "../src/domain/airworthiness";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import { costRecordSchema } from "../src/domain/costs";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  archivedTaskCardDocs,
  workOrderDocs,
  discrepancyDocs,
  airworthinessDocs,
  partsRequestDocs,
  purchaseOrderDocs,
  checklistDocs,
  componentTemplateDocs,
  componentSetupDocs,
  inspectionTemplateDocs,
  costDocs,
} from "./programContext";
import {
  auditRow,
  writeAudit,
  type AuditFields,
  type AuditRow,
} from "./access";

// The transaction every applier-backed mutation runs (ADR-0003). In order:
//   1. check the caller's Flight Program context, before the payload is read;
//   2. parse the command;
//   3. hand the command to another transaction shape (`delegate`), or
//   4. return without writing when its request id was already applied;
//   5. load the working state (and check record-level access);
//   6. apply the domain command, exposing only expected rejections;
//   7. persist the documents the command changed;
//   8. write the command's change-log rows, once, through the audit writer;
//   9. record the request id.
// A Convex mutation is one transaction: a throw at any step writes nothing.
export interface Command<C, W, R, Out = void> {
  // The Flight Program the client acted in.
  programUuid: string | undefined;
  // The caller, when the mutation has already loaded it.
  actor?: Doc<"users">;
  parse(state: ProgramContext): C;
  // Idempotent commands: replaying `uuid` with the same payload is a no-op.
  request?(command: C): { uuid: string; payload: string };
  // Commands handled by another transaction shape, such as the scheduled
  // work-order template copies. Return undefined to run this one.
  delegate?(state: ProgramContext, command: C): Promise<Out> | undefined;
  load(tx: Transaction, command: C): Promise<W>;
  // The domain applier: pure apart from mutating the working state.
  apply(working: W, command: C): R;
  // The message to show for an applier error that is an expected rejection.
  // It is rethrown as a ConvexError so it survives production error
  // redaction; any other error is rethrown unchanged.
  expose?(error: unknown): string | undefined;
  persist(tx: Transaction, working: W, result: R, command: C): Promise<void>;
  audit(log: CommandLog, working: W, result: R, command: C): void;
  returns?(result: R, working: W): Out;
}
// The caller's checked Flight Program context; its aircraft and programs are
// the stored documents.
export type ProgramContext = Awaited<ReturnType<typeof checkContext>>;
export interface Transaction {
  ctx: MutationCtx;
  state: ProgramContext;
  // Rows a persist step adds (for a helper that audits what it writes) are
  // written with the command's own rows, after persist.
  log: CommandLog;
}
// A replayed request returns undefined; every other run returns `returns`.
export async function runCommand<C, W, R, Out = void>(
  ctx: MutationCtx,
  command: Command<C, W, R, Out> & { request?: undefined },
): Promise<Out>;
export async function runCommand<C, W, R, Out = void>(
  ctx: MutationCtx,
  command: Command<C, W, R, Out>,
): Promise<Out | undefined>;
export async function runCommand<C, W, R, Out = void>(
  ctx: MutationCtx,
  command: Command<C, W, R, Out>,
): Promise<Out | undefined> {
  const state = await checkContext(ctx, command.programUuid, command.actor);
  const parsed = command.parse(state);
  const delegated = command.delegate?.(state, parsed);
  if (delegated) return delegated;
  const request = command.request?.(parsed);
  if (request) {
    const prior = await ctx.db
      .query("managementRequests")
      .withIndex("uuid", (q) => q.eq("uuid", request.uuid))
      .unique();
    if (prior) {
      if (prior.actorId !== state.user.id || prior.payload !== request.payload)
        throw new Error("Request identifier already used.");
      return undefined;
    }
  }
  const log = new CommandLog(state.user.id);
  const tx: Transaction = { ctx, state, log };
  const working = await command.load(tx, parsed);
  let result: R;
  try {
    result = command.apply(working, parsed);
  } catch (error) {
    const message = command.expose?.(error);
    if (message !== undefined) throw new ConvexError(message);
    throw error;
  }
  await command.persist(tx, working, result, parsed);
  command.audit(log, working, result, parsed);
  for (const row of log.rows) await writeAudit(ctx, row);
  if (request)
    await ctx.db.insert("managementRequests", {
      uuid: request.uuid,
      actorId: state.user.id,
      payload: request.payload,
    });
  return command.returns?.(result, working);
}

// A command's change-log rows, collected in order and written once.
export class CommandLog {
  readonly rows: AuditRow[] = [];
  constructor(readonly actorId: string) {}
  // A new entry by the caller, stamped now.
  entry(action: string, entityUuid: string, fields: AuditFields = {}) {
    this.rows.push(auditRow(this.actorId, action, entityUuid, fields));
  }
  // The applier's entries as new rows by the caller, stamped now. Their own
  // program, aircraft, reason and values are kept unless `stamp` overrides
  // them (an explicit undefined clears one).
  replay(
    entries: AuditEntry[],
    stamp:
      Partial<AuditFields> | ((entry: AuditEntry) => Partial<AuditFields>) = {},
  ) {
    for (const e of entries)
      this.entry(e.action, e.entityUuid, {
        programUuid: e.programUuid,
        aircraftUuid: e.aircraftUuid,
        reason: e.reason,
        before: e.before ? JSON.parse(e.before) : undefined,
        after: e.after ? JSON.parse(e.after) : undefined,
        ...(typeof stamp === "function" ? stamp(e) : stamp),
      });
  }
  // The applier's entries exactly as it recorded them: its ids, times and
  // actor. `stamp` sets the program on every row.
  record(entries: AuditEntry[], stamp: { programUuid?: string } = {}) {
    for (const e of entries) this.rows.push({ ...e, ...stamp });
  }
}

// Expected rejections: errors the domain throws as plain `Error` carry a
// message written for the user; parser and runtime errors do not.
export const plainErrors = (error: unknown) =>
  error instanceof Error && error.constructor === Error
    ? error.message
    : undefined;
// Every applier error is a user-facing rejection.
export const allErrors = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
// Only errors of one class are user-facing rejections.
export const errorsOf =
  (type: abstract new (...args: never[]) => Error) => (error: unknown) =>
    error instanceof type ? error.message : undefined;

// Collections a command can ask `hydrate` for, loaded within the active
// Flight Program (per program, or per aircraft of the program).
export interface LoadedDocs {
  management: Doc<"management">[];
  inspections: Doc<"inspections">[];
  taskCards: Doc<"taskCards">[];
  archivedTaskCards: Doc<"archivedTaskCards">[];
  workOrders: Doc<"workOrders">[];
  discrepancies: Doc<"discrepancies">[];
  airworthiness: Doc<"airworthiness">[];
  partsRequests: Doc<"partsRequests">[];
  purchaseOrders: Doc<"purchaseOrders">[];
  checklists: Doc<"checklists">[];
  componentTemplates: Doc<"componentTemplates">[];
  componentSetups: Doc<"componentSetups">[];
  inspectionTemplates: Doc<"inspectionTemplates">[];
  costs: Doc<"costs">[];
}
export type Need = keyof LoadedDocs;
export interface Hydrated<N extends Need> {
  // The program context plus the needed collections, parsed.
  snapshot: Snapshot;
  // The stored documents behind them, for persisting changes.
  docs: Pick<LoadedDocs, N>;
}
const payload =
  <T>(schema: { parse(value: unknown): T }) =>
  (d: { payload: string }) =>
    schema.parse(JSON.parse(d.payload));
export async function hydrate<N extends Need>(
  ctx: MutationCtx,
  state: Snapshot,
  needs: readonly N[],
): Promise<Hydrated<N>> {
  const want = new Set<Need>(needs);
  const program = activeProgram(state);
  const aircraft = state.aircraft;
  const snapshot: Snapshot = { ...state };
  const docs: Partial<LoadedDocs> = {};
  // Inspections of removed components are found through their component.
  const management =
    want.has("management") || want.has("inspections")
      ? await managementDocs(ctx, program)
      : [];
  if (want.has("management")) {
    docs.management = management;
    snapshot.management = management.map(payload(recordSchema));
  }
  if (want.has("inspections"))
    snapshot.inspections = docs.inspections = await inspectionDocs(
      ctx,
      aircraft,
      management,
    );
  if (want.has("taskCards")) {
    docs.taskCards = await taskCardDocs(ctx, aircraft);
    snapshot.taskCards = docs.taskCards.map(payload(taskCardSchema));
  }
  if (want.has("archivedTaskCards")) {
    docs.archivedTaskCards = await archivedTaskCardDocs(ctx, aircraft);
    snapshot.archivedTaskCards = docs.archivedTaskCards.map(
      payload(taskCardSchema),
    );
  }
  if (want.has("workOrders")) {
    docs.workOrders = await workOrderDocs(ctx, aircraft);
    snapshot.workOrders = docs.workOrders.map(payload(workOrderSchema));
  }
  if (want.has("discrepancies"))
    snapshot.discrepancies = docs.discrepancies = await discrepancyDocs(
      ctx,
      aircraft,
    );
  if (want.has("airworthiness")) {
    docs.airworthiness = await airworthinessDocs(ctx, aircraft);
    snapshot.airworthiness = docs.airworthiness.map(payload(adSchema));
  }
  if (want.has("partsRequests")) {
    docs.partsRequests = await partsRequestDocs(ctx, program);
    snapshot.partsRequests = docs.partsRequests.map(
      payload(partsRequestSchema),
    );
  }
  if (want.has("purchaseOrders")) {
    docs.purchaseOrders = await purchaseOrderDocs(ctx, program);
    snapshot.purchaseOrders = docs.purchaseOrders.map(payload(poSchema));
  }
  if (want.has("checklists")) {
    docs.checklists = await checklistDocs(ctx, program);
    snapshot.checklists = docs.checklists.map(payload(checklistRecordSchema));
  }
  if (want.has("componentTemplates")) {
    docs.componentTemplates = await componentTemplateDocs(ctx, program);
    snapshot.componentTemplates = docs.componentTemplates.map((d) =>
      JSON.parse(d.payload),
    );
  }
  if (want.has("componentSetups")) {
    docs.componentSetups = await componentSetupDocs(ctx, program);
    snapshot.componentSetups = docs.componentSetups.map((d) =>
      JSON.parse(d.payload),
    );
  }
  if (want.has("inspectionTemplates")) {
    docs.inspectionTemplates = await inspectionTemplateDocs(ctx, program);
    snapshot.inspectionTemplates = docs.inspectionTemplates.map(
      payload(inspectionTemplateSchema),
    );
  }
  if (want.has("costs")) {
    docs.costs = await costDocs(ctx, program, aircraft);
    snapshot.costs = docs.costs.map(payload(costRecordSchema));
  }
  return { snapshot, docs: docs as Pick<LoadedDocs, N> };
}

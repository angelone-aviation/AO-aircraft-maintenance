/**
 * Responsibility: The one transaction every applier-backed mutation runs
 *   (ADR-0003), and the hydration of the records a command reads.
 * Layer: Server. Runs inside a Convex mutation; the domain owns the rules.
 * Dependencies: convex/values, ./_generated, ./programContext, ./access,
 *   src/domain (model, programs, rejection and the stored-record schemas).
 *
 * Production deployments show any error but a ConvexError as "Server Error".
 * A domain Rejection is rethrown as a ConvexError so its message reaches the
 * user; any other error stays hidden, since its message was not written for
 * them.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { AuditEntry, Snapshot } from "../src/domain/model";
import { activeProgram } from "../src/domain/programs";
import { Rejection } from "../src/domain/rejection";
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

/**
 * One applier-backed command, as {@link runCommand} runs it: `C` is the
 * parsed command, `W` the working state, `R` the applier's result and `Out`
 * what the mutation returns.
 */
export interface Command<C, W, R, Out = void> {
  /** The Flight Program the client acted in. */
  programUuid: string | undefined;
  /** The caller, when the mutation has already loaded it. */
  actor?: Doc<"users">;
  /** Reads the command from the mutation's arguments. */
  parse(state: ProgramContext): C;
  /** Idempotent commands: replaying `uuid` with the same payload is a no-op. */
  request?(command: C): { uuid: string; payload: string };
  /**
   * Hands the command to another transaction shape, such as the scheduled
   * work-order template copies. Return undefined to run this one.
   */
  delegate?(state: ProgramContext, command: C): Promise<Out> | undefined;
  /** Reads the working state and checks record-level access. */
  load(tx: Transaction, command: C): Promise<W>;
  /** The domain applier: pure apart from mutating the working state. */
  apply(working: W, command: C): R;
  /**
   * The message to show for an error `apply` throws that is not a Rejection,
   * or undefined to keep it hidden. A Rejection is always shown as written.
   */
  expose?(error: unknown): string | undefined;
  /** Writes the documents the command changed. */
  persist(tx: Transaction, working: W, result: R, command: C): Promise<void>;
  /** Adds the command's change-log rows, written once after persist. */
  audit(log: CommandLog, working: W, result: R, command: C): void;
  /** What the mutation returns. */
  returns?(result: R, working: W): Out;
}

/**
 * The caller's checked Flight Program context; its aircraft and programs are
 * the stored documents.
 */
export type ProgramContext = Awaited<ReturnType<typeof checkContext>>;

/** What `load` and `persist` work with. */
export interface Transaction {
  ctx: MutationCtx;
  state: ProgramContext;
  /** Rows a persist step adds (for a helper that audits what it writes) are
   * written with the command's own rows, after persist. */
  log: CommandLog;
}

/**
 * Runs a command in the caller's mutation, in order: check the caller's Flight
 * Program context before the payload is read; parse; hand off (`delegate`);
 * return early for a replayed request id; load; apply; persist; write the
 * change-log rows once through the audit writer; record the request id. A
 * Convex mutation is one transaction, so a throw at any step writes nothing.
 *
 * @returns What `returns` gives; undefined for a replayed request.
 * @throws {ConvexError} With the message of a Rejection thrown in `load` or
 *   `apply`, or the message `expose` gives for another `apply` error.
 * @throws {Error} "Request identifier already used." for a request id reused
 *   by another caller or with another payload. Other errors pass unchanged.
 */
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
  if (request && (await isReplayed(ctx, state, request))) return undefined;
  const log = new CommandLog(state.user.id);
  const tx: Transaction = { ctx, state, log };
  const { working, result } = await loadAndApply(tx, command, parsed);
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

/** A command's change-log rows by one caller, collected in order. */
export class CommandLog {
  readonly rows: AuditRow[] = [];
  constructor(readonly actorId: string) {}

  /** Adds a new entry by the caller, stamped now. */
  entry(action: string, entityUuid: string, fields: AuditFields = {}) {
    this.rows.push(auditRow(this.actorId, action, entityUuid, fields));
  }

  /**
   * Adds the applier's entries as new rows by the caller, stamped now. Their
   * own program, aircraft, reason and values are kept unless `stamp`
   * overrides them (an explicit undefined clears one).
   */
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

  /**
   * Adds the applier's entries exactly as it recorded them: its ids, times
   * and actor. `stamp` sets the program on every row.
   */
  record(entries: AuditEntry[], stamp: { programUuid?: string } = {}) {
    for (const e of entries) this.rows.push({ ...e, ...stamp });
  }
}

/**
 * An `expose` policy for domains that still throw refusals as plain `Error`:
 * those carry a message written for the user; parser and runtime errors,
 * which are subclasses, do not.
 *
 * @returns The message of a plain `Error`, else undefined.
 */
export const plainErrors = (error: unknown) =>
  error instanceof Error && error.constructor === Error
    ? error.message
    : undefined;

/**
 * An `expose` policy that shows every applier error, including parser
 * errors, as a user-facing rejection.
 *
 * @returns The error's message, or the thrown value as text.
 */
export const allErrors = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * An `expose` policy that shows errors of one class only.
 *
 * @param type - The class whose errors are user-facing rejections.
 * @returns The policy: the message of an error of `type`, else undefined.
 */
export const errorsOf =
  (type: abstract new (...args: never[]) => Error) => (error: unknown) =>
    error instanceof type ? error.message : undefined;

/**
 * Collections a command can ask {@link hydrate} for, loaded within the active
 * Flight Program (per program, or per aircraft of the program).
 */
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

/** The name of a collection {@link hydrate} can load. */
export type Need = keyof LoadedDocs;

/** A command's working state from {@link hydrate}. */
export interface Hydrated<N extends Need> {
  /** The program context plus the needed collections, parsed. */
  snapshot: Snapshot;
  /** The stored documents behind them, for persisting changes. */
  docs: Pick<LoadedDocs, N>;
}

/**
 * Loads the collections a command needs into a copy of the caller's context.
 * Collections not needed keep the context's values.
 *
 * @param state - The caller's context, as a Snapshot.
 * @returns The snapshot with each needed collection parsed from its stored
 *   payloads, and the stored documents behind them.
 * @throws {z.ZodError} When a stored payload no longer parses.
 */
export async function hydrate<N extends Need>(
  ctx: MutationCtx,
  state: Snapshot,
  needs: readonly N[],
): Promise<Hydrated<N>> {
  const want = new Set<Need>(needs);
  const scope = { program: activeProgram(state), aircraft: state.aircraft };
  const into: Hydrating = { snapshot: { ...state }, docs: {} };
  // Object keys keep their order, so management loads before inspections.
  for (const need of Object.keys(HYDRATORS) as Need[])
    if (want.has(need)) await HYDRATORS[need](ctx, scope, into);
  return { snapshot: into.snapshot, docs: into.docs as Pick<LoadedDocs, N> };
}

interface Hydrating {
  snapshot: Snapshot;
  docs: Partial<LoadedDocs>;
}
type Hydrator = (
  ctx: MutationCtx,
  scope: { program: string | undefined; aircraft: Snapshot["aircraft"] },
  into: Hydrating,
) => Promise<void>;

const payload =
  <T>(schema: { parse(value: unknown): T }) =>
  (d: { payload: string }) =>
    schema.parse(JSON.parse(d.payload));

// Component templates and setups are stored as written, without a schema.
const unparsed = (d: { payload: string }) => JSON.parse(d.payload);

// Reads one collection within the Flight Program and decodes it into the
// snapshot, keeping the stored documents for persist.
const HYDRATORS: Record<Need, Hydrator> = {
  management: async (ctx, { program }, { docs, snapshot }) => {
    docs.management = await managementDocs(ctx, program);
    snapshot.management = docs.management.map(payload(recordSchema));
  },
  // Inspections of removed components are found through their component.
  inspections: async (ctx, { program, aircraft }, { docs, snapshot }) => {
    const management = docs.management ?? (await managementDocs(ctx, program));
    snapshot.inspections = docs.inspections = await inspectionDocs(
      ctx,
      aircraft,
      management,
    );
  },
  taskCards: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.taskCards = await taskCardDocs(ctx, aircraft);
    snapshot.taskCards = docs.taskCards.map(payload(taskCardSchema));
  },
  archivedTaskCards: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.archivedTaskCards = await archivedTaskCardDocs(ctx, aircraft);
    snapshot.archivedTaskCards = docs.archivedTaskCards.map(
      payload(taskCardSchema),
    );
  },
  workOrders: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.workOrders = await workOrderDocs(ctx, aircraft);
    snapshot.workOrders = docs.workOrders.map(payload(workOrderSchema));
  },
  discrepancies: async (ctx, { aircraft }, { docs, snapshot }) => {
    snapshot.discrepancies = docs.discrepancies = await discrepancyDocs(
      ctx,
      aircraft,
    );
  },
  airworthiness: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.airworthiness = await airworthinessDocs(ctx, aircraft);
    snapshot.airworthiness = docs.airworthiness.map(payload(adSchema));
  },
  partsRequests: async (ctx, { program }, { docs, snapshot }) => {
    docs.partsRequests = await partsRequestDocs(ctx, program);
    snapshot.partsRequests = docs.partsRequests.map(
      payload(partsRequestSchema),
    );
  },
  purchaseOrders: async (ctx, { program }, { docs, snapshot }) => {
    docs.purchaseOrders = await purchaseOrderDocs(ctx, program);
    snapshot.purchaseOrders = docs.purchaseOrders.map(payload(poSchema));
  },
  checklists: async (ctx, { program }, { docs, snapshot }) => {
    docs.checklists = await checklistDocs(ctx, program);
    snapshot.checklists = docs.checklists.map(payload(checklistRecordSchema));
  },
  componentTemplates: async (ctx, { program }, { docs, snapshot }) => {
    docs.componentTemplates = await componentTemplateDocs(ctx, program);
    snapshot.componentTemplates = docs.componentTemplates.map(unparsed);
  },
  componentSetups: async (ctx, { program }, { docs, snapshot }) => {
    docs.componentSetups = await componentSetupDocs(ctx, program);
    snapshot.componentSetups = docs.componentSetups.map(unparsed);
  },
  inspectionTemplates: async (ctx, { program }, { docs, snapshot }) => {
    docs.inspectionTemplates = await inspectionTemplateDocs(ctx, program);
    snapshot.inspectionTemplates = docs.inspectionTemplates.map(
      payload(inspectionTemplateSchema),
    );
  },
  costs: async (ctx, { program, aircraft }, { docs, snapshot }) => {
    docs.costs = await costDocs(ctx, program, aircraft);
    snapshot.costs = docs.costs.map(payload(costRecordSchema));
  },
};

// A request id belongs to its first caller and payload: replaying it is a
// no-op, and reusing it for anything else is refused.
async function isReplayed(
  ctx: MutationCtx,
  state: ProgramContext,
  request: { uuid: string; payload: string },
) {
  const prior = await ctx.db
    .query("managementRequests")
    .withIndex("uuid", (q) => q.eq("uuid", request.uuid))
    .unique();
  if (!prior) return false;
  if (prior.actorId !== state.user.id || prior.payload !== request.payload)
    throw new Error("Request identifier already used.");
  return true;
}

async function loadAndApply<C, W, R, Out>(
  tx: Transaction,
  command: Command<C, W, R, Out>,
  parsed: C,
) {
  let working: W;
  try {
    working = await command.load(tx, parsed);
  } catch (error) {
    throw exposed(error);
  }
  try {
    return { working, result: command.apply(working, parsed) };
  } catch (error) {
    throw exposed(error, command.expose);
  }
}

// A Rejection, or an error the command's own policy names, becomes a
// ConvexError with its message; anything else is rethrown unchanged.
function exposed(
  error: unknown,
  expose?: (error: unknown) => string | undefined,
) {
  const message = error instanceof Rejection ? error.message : expose?.(error);
  return message === undefined ? error : new ConvexError(message);
}

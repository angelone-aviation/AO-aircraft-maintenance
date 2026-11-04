/**
 * Responsibility: The one transaction every applier-backed mutation runs
 *   (ADR-0003): hydrating the records a command reads, and writing the ones
 *   it changed.
 * Layer: Server. Runs inside a Convex mutation; the domain owns the rules.
 * Dependencies: convex/values, convex/server (types), zod, ./_generated,
 *   ./programContext, ./access, ./collections, src/domain (model, programs,
 *   rejection, validationText, commandRequest).
 *
 * Production deployments show any error but a ConvexError as "Server Error".
 * A domain Rejection is rethrown as a ConvexError so its message reaches the
 * user; any other error stays hidden, since its message was not written for
 * them.
 */
import { ConvexError } from "convex/values";
import { z, ZodError } from "zod";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { WithOptionalSystemFields } from "convex/server";
import type { AuditEntry, Snapshot } from "../src/domain/model";
import { activeProgram } from "../src/domain/programs";
import { Rejection } from "../src/domain/rejection";
import { validationText } from "../src/domain/validationText";
import { requestUuidField } from "../src/domain/commandRequest";
import {
  decode,
  encode,
  type PayloadCollection,
  type StoredRecord,
  type StoredRow,
} from "./collections";
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
  /**
   * Idempotent commands: replaying `uuid` with the same payload is a no-op.
   * Undefined runs the command unrecorded (see {@link requestOf}).
   */
  request?(command: C): CommandRequest | undefined;
  /** Reads the working state and checks record-level access. */
  load(tx: Transaction, command: C): Promise<W>;
  /** The domain applier: pure apart from mutating the working state. */
  apply(working: W, command: C): R;
  /**
   * The message to show for an error `parse` or `apply` throws that is not a
   * Rejection, or undefined to keep it hidden. A Rejection is always shown as
   * written.
   */
  expose?(error: unknown): string | undefined;
  /**
   * Work that needs the applied state and the transaction, between `apply`
   * and `persist`, such as scheduling the work-order job copies (ADR-0003).
   * What it returns replaces the applier's result.
   */
  afterApply?(tx: Transaction, working: W, result: R, command: C): Promise<R>;
  /** Writes the documents the command changed. */
  persist(tx: Transaction, working: W, result: R, command: C): Promise<void>;
  /** Adds the command's change-log rows, written once after persist. */
  audit(log: CommandLog, working: W, result: R, command: C): void;
  /** What the mutation returns. */
  returns?(result: R, working: W): Out;
}

/** A command's request id and the payload a replay of it must repeat. */
export interface CommandRequest {
  uuid: string;
  payload: string;
}

/**
 * The caller's checked Flight Program context; its aircraft and programs are
 * the stored documents.
 */
export type ProgramContext = Awaited<ReturnType<typeof checkContext>>;

/** What `load`, `afterApply` and `persist` work with. */
export interface Transaction {
  ctx: MutationCtx;
  state: ProgramContext;
  /** Rows a persist step adds (for a helper that audits what it writes) are
   * written with the command's own rows, after persist. */
  log: CommandLog;
}

/**
 * Runs a command in the caller's mutation, in order: check the caller's Flight
 * Program context before the payload is read; parse; return early for a
 * replayed request id; load; apply; afterApply; persist; write the change-log
 * rows once through the audit writer; record the request id. A Convex
 * mutation is one transaction, so a throw at any step writes nothing.
 *
 * @returns What `returns` gives; undefined for a replayed request.
 * @throws {ConvexError} The message of a Rejection thrown in `parse`, `load`,
 *   `apply`, `afterApply` or `persist`, or the one `expose` gives for another
 *   `parse` or `apply` error; "Request identifier already used." for a request id reused by
 *   another caller or with another payload; checkContext's program refusals.
 * @throws {Error} checkContext's session refusal. Other errors pass unchanged.
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
  const parsed = parseCommand(command, state);
  const request = command.request?.(parsed);
  if (request && (await isReplayed(ctx, state, request))) return undefined;
  const log = new CommandLog(state.user.id);
  const tx: Transaction = { ctx, state, log };
  const { working, result: applied } = await loadAndApply(tx, command, parsed);
  const result = await runAfterApply(tx, command, working, applied, parsed);
  await persistCommand(tx, command, working, result, parsed);
  command.audit(log, working, result, parsed);
  for (const row of log.rows) await writeAudit(ctx, row);
  if (request) await recordRequest(ctx, state, request);
  return command.returns?.(result, working);
}

/**
 * The `request` of a command whose request id is optional (T18): a command
 * the client sent without one runs every time.
 *
 * @param requestUuid - The command's request id, if it carries one.
 * @param payload - The command's JSON, as the client sent it.
 * @returns The request, or undefined when there is no id.
 */
export function requestOf(
  requestUuid: string | undefined,
  payload: string,
): CommandRequest | undefined {
  return requestUuid === undefined ? undefined : { uuid: requestUuid, payload };
}

/**
 * The request id in a JSON payload that `apply` parses, read before it does.
 *
 * @returns The id; undefined for a payload that is not JSON or whose id is
 *   missing or not a UUID, which then runs unrecorded (or is refused when
 *   `apply` parses it).
 */
export function requestUuidIn(payload: string): string | undefined {
  let command: unknown;
  try {
    command = JSON.parse(payload);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return REQUEST_ONLY.safeParse(command).data?.requestUuid;
}

const REQUEST_ONLY = z.object(requestUuidField);

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
 * An `expose` policy that shows a zod refusal as the issue text the browser
 * shows for it ({@link validationText}). Opt-in, so a command that wants its
 * parser errors kept hidden, as the offline outbox does, keeps them hidden.
 *
 * @returns That text for a ZodError with issues, else undefined.
 */
export const validationErrors = (error: unknown) =>
  error instanceof ZodError ? validationText(error) || undefined : undefined;

/**
 * An `expose` policy that shows every applier error, including parser
 * errors, as a user-facing rejection.
 *
 * @returns A ZodError's issue text, as {@link validationErrors}; else the
 *   error's message, or the thrown value as text.
 */
export const allErrors = (error: unknown) =>
  validationErrors(error) ??
  (error instanceof Error ? error.message : String(error));

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

/** A payload collection whose records carry their own uuid. */
export type UuidCollection = Exclude<PayloadCollection, "faaMonitors">;

/**
 * The refusal for a new record whose uuid is already stored outside the rows
 * a command loaded: one message for every record type.
 */
export const RECORD_TAKEN = "Record belongs to another Flight Program.";

/**
 * Writes a collection's records after `apply`, as the codec encodes them:
 * replaces each loaded row whose payload changed, skips one left as stored,
 * and inserts a record with no loaded row. Never deletes.
 *
 * A uuid outside the active Flight Program is never overwritten: a record
 * whose uuid is stored but was not loaded is refused.
 *
 * @param loaded - The collection's rows `load` read for the command.
 * @param records - The records to write, in order.
 * @throws {ConvexError} {@link RECORD_TAKEN}, before that record is written.
 */
export async function writeChanged<N extends UuidCollection>(
  ctx: MutationCtx,
  collection: N,
  loaded: readonly Doc<N>[],
  records: readonly StoredRecord<N>[],
): Promise<void> {
  for (const record of records) {
    const row = encode(collection, record);
    const prior = loaded.find((d) => d.uuid === record.uuid);
    if (prior?.payload === row.payload) continue;
    if (prior) await replaceRow(ctx, prior._id, row);
    else await insertUnclaimed(ctx, collection, row);
  }
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

// Reads one collection within the Flight Program and decodes it into the
// snapshot, keeping the stored documents for persist.
const HYDRATORS: Record<Need, Hydrator> = {
  management: async (ctx, { program }, { docs, snapshot }) => {
    docs.management = await managementDocs(ctx, program);
    snapshot.management = decode("management", docs.management);
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
    snapshot.taskCards = decode("taskCards", docs.taskCards);
  },
  archivedTaskCards: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.archivedTaskCards = await archivedTaskCardDocs(ctx, aircraft);
    snapshot.archivedTaskCards = decode(
      "archivedTaskCards",
      docs.archivedTaskCards,
    );
  },
  workOrders: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.workOrders = await workOrderDocs(ctx, aircraft);
    snapshot.workOrders = decode("workOrders", docs.workOrders);
  },
  discrepancies: async (ctx, { aircraft }, { docs, snapshot }) => {
    snapshot.discrepancies = docs.discrepancies = await discrepancyDocs(
      ctx,
      aircraft,
    );
  },
  airworthiness: async (ctx, { aircraft }, { docs, snapshot }) => {
    docs.airworthiness = await airworthinessDocs(ctx, aircraft);
    snapshot.airworthiness = decode("airworthiness", docs.airworthiness);
  },
  partsRequests: async (ctx, { program }, { docs, snapshot }) => {
    docs.partsRequests = await partsRequestDocs(ctx, program);
    snapshot.partsRequests = decode("partsRequests", docs.partsRequests);
  },
  purchaseOrders: async (ctx, { program }, { docs, snapshot }) => {
    docs.purchaseOrders = await purchaseOrderDocs(ctx, program);
    snapshot.purchaseOrders = decode("purchaseOrders", docs.purchaseOrders);
  },
  checklists: async (ctx, { program }, { docs, snapshot }) => {
    docs.checklists = await checklistDocs(ctx, program);
    snapshot.checklists = decode("checklists", docs.checklists);
  },
  componentTemplates: async (ctx, { program }, { docs, snapshot }) => {
    docs.componentTemplates = await componentTemplateDocs(ctx, program);
    snapshot.componentTemplates = decode(
      "componentTemplates",
      docs.componentTemplates,
    );
  },
  componentSetups: async (ctx, { program }, { docs, snapshot }) => {
    docs.componentSetups = await componentSetupDocs(ctx, program);
    snapshot.componentSetups = decode("componentSetups", docs.componentSetups);
  },
  inspectionTemplates: async (ctx, { program }, { docs, snapshot }) => {
    docs.inspectionTemplates = await inspectionTemplateDocs(ctx, program);
    snapshot.inspectionTemplates = decode(
      "inspectionTemplates",
      docs.inspectionTemplates,
    );
  },
  costs: async (ctx, { program, aircraft }, { docs, snapshot }) => {
    docs.costs = await costDocs(ctx, program, aircraft);
    snapshot.costs = decode("costs", docs.costs);
  },
};

// A request id belongs to its first caller and payload: replaying it is a
// no-op, and reusing it for anything else is refused.
async function isReplayed(
  ctx: MutationCtx,
  state: ProgramContext,
  request: CommandRequest,
) {
  const prior = await ctx.db
    .query("managementRequests")
    .withIndex("uuid", (q) => q.eq("uuid", request.uuid))
    .unique();
  if (!prior) return false;
  if (prior.actorId !== state.user.id || prior.payload !== request.payload)
    throw new ConvexError("Request identifier already used.");
  return true;
}

// The same row goes to both tables while commandRequests takes over from
// managementRequests (ADR-0003, expand); replays still read the old one, which
// alone holds the ids recorded before.
async function recordRequest(
  ctx: MutationCtx,
  state: ProgramContext,
  request: CommandRequest,
) {
  const row = {
    uuid: request.uuid,
    actorId: state.user.id,
    payload: request.payload,
  };
  await ctx.db.insert("managementRequests", row);
  await ctx.db.insert("commandRequests", row);
}

function parseCommand<C, W, R, Out>(
  command: Command<C, W, R, Out>,
  state: ProgramContext,
) {
  try {
    return command.parse(state);
  } catch (error) {
    throw exposed(error, command.expose);
  }
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

async function runAfterApply<C, W, R, Out>(
  tx: Transaction,
  command: Command<C, W, R, Out>,
  working: W,
  result: R,
  parsed: C,
) {
  if (!command.afterApply) return result;
  try {
    return await command.afterApply(tx, working, result, parsed);
  } catch (error) {
    throw exposed(error);
  }
}

async function persistCommand<C, W, R, Out>(
  tx: Transaction,
  command: Command<C, W, R, Out>,
  working: W,
  result: R,
  parsed: C,
) {
  try {
    await command.persist(tx, working, result, parsed);
  } catch (error) {
    throw exposed(error);
  }
}

// A row without system fields is a valid replacement; Convex's types cannot
// show that for a table chosen at run time.
function replaceRow<N extends UuidCollection>(
  ctx: MutationCtx,
  id: Id<N>,
  row: StoredRow<N>,
) {
  return ctx.db.replace(id, row as WithOptionalSystemFields<Doc<N>>);
}

async function insertUnclaimed<N extends UuidCollection>(
  ctx: MutationCtx,
  collection: N,
  row: StoredRow<N>,
) {
  const stored = await ctx.db
    .query(collection)
    .withIndex("uuid", (q) => q.eq("uuid", row.uuid))
    .first();
  if (stored) throw new ConvexError(RECORD_TAKEN);
  await ctx.db.insert(collection, row);
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

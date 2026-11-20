/**
 * Responsibility: Job-card saves, through the task-card domain applier, and
 *   job-card evidence: upload, its checks, and removal.
 * Layer: Server. Convex mutations, an action and internal functions; the
 *   rules live in src/domain (taskCards, attachments).
 * Dependencies: convex/values, ./_generated, ./programContext, ./access,
 *   ./runCommand, ./collections, ./recordNumbers, ./costLedger, ./workingSet,
 *   ./attachments, ./userErrors, src/domain (taskCards, workOrders,
 *   attachments, inventoryAttachments, model).
 */
import { v, ConvexError } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { checkContext } from "./programContext";
import {
  discrepancyDocsByUuid,
  inLoadOrder,
  looseCardDocs,
  taskCardDocsByUuid,
  workOrderCardDocs,
  workOrderDocsByUuid,
} from "./workingSet";
import { authorized, audit } from "./access";
import {
  runCommand,
  hydrate,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode, encode } from "./collections";
import { readRecordNumbers } from "./recordNumbers";
import { syncWorkOrderLedger } from "./costLedger";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  storeThenFinish,
  MAX_ATTACHMENTS,
} from "./attachments";
import { exposeRejections } from "./userErrors";
import {
  validateWorkOrderFile,
  WORK_ORDER_FILE_TYPES,
} from "../src/domain/workOrders";
import { withNewEvidence } from "../src/domain/attachments";
import { assertFileContents } from "../src/domain/inventoryAttachments";
import { can } from "../src/domain/model";
import {
  applyTaskCardCommand,
  cardNumberKey,
  cardNumberPrefix,
  taskCardCommandSchema,
  taskWritable,
  evidenceRemovable,
  type TaskCard,
  type TaskCardCommand,
  type TaskLink,
} from "../src/domain/taskCards";

const NO_OPEN_CARD = "An open job card and maintenance access are required.";
const NO_EVIDENCE = "Evidence not found.";

/**
 * Saves a job card in the active Flight Program and writes the
 * "taskCard.<action>" row applyTaskCardCommand records. A card joining a
 * work order brings that order's cost ledger rows up to date, since parts
 * requests on the card now count toward it. A replayed request id changes
 * nothing.
 *
 * @param payload - The job-card command, as JSON, with its request id.
 * @returns The card's uuid; nothing for a replay.
 * @throws {ConvexError} "Archived job cards are read-only."; "Record belongs
 *   to another Flight Program." for a card uuid outside the program; a
 *   domain Rejection; runCommand's program refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => taskCardCommandSchema.parse(JSON.parse(args.payload)),
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: ({ ctx, state }, command) => loadCard(ctx, state, command),
      apply: ({ snapshot, now, numbers }, command) =>
        applyTaskCardCommand(snapshot, command, now, numbers),
      persist: async ({ ctx }, { docs }, next) => {
        const prior = decode(
          "taskCards",
          docs.filter((d) => d.uuid === next.uuid),
        ).at(0);
        await writeChanged(ctx, "taskCards", docs, [next]);
        // Parts requests on a card count toward the work order it joins.
        if (next.workOrderUuid && next.workOrderUuid !== prior?.workOrderUuid)
          await syncWorkOrderLedger(ctx, next.workOrderUuid);
      },
      audit: (log, { snapshot }) => log.replay(snapshot.audit),
      returns: (next) => next.uuid,
    }),
});

const fileArgs = {
  taskCardUuid: v.string(),
  programUuid: v.optional(v.string()),
};
const category = v.union(
  v.literal("photo"),
  v.literal("supporting-document"),
  v.literal("parts-traceability"),
);
/**
 * Checks, before an upload is stored, that the caller may add evidence to
 * the job card.
 *
 * @returns The caller's user id.
 * @throws {ConvexError} "An open job card and maintenance access are
 *   required."; the refusals of checkContext and authorized.
 */
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const s = await withCard(ctx, state, args.taskCardUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t)) throw new ConvexError(NO_OPEN_CARD);
    return (await authorized(ctx, t.aircraftUuid, "maintenance", s))._id;
  },
});
/**
 * Records a stored upload as job-card evidence. New evidence clears the
 * card's signoffs, so the card is saved with a new version and a
 * "taskCard.evidence" change-log row.
 *
 * @throws {ConvexError} "An open job card and maintenance access are
 *   required."; the attachment limit; checkContext's refusals.
 */
export const finishUpload = internalMutation({
  args: {
    ...fileArgs,
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    category,
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const s = await withCard(ctx, state, args.taskCardUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t)) throw new ConvexError(NO_OPEN_CARD);
    assertAttachmentRoom(
      await ctx.db
        .query("taskEvidence")
        .withIndex("taskCard", (q) => q.eq("taskCardUuid", t.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    const now = Date.now();
    await ctx.db.insert("taskEvidence", {
      ...fields,
      aircraftUuid: t.aircraftUuid,
      uploadedAt: now,
    });
    const next = withNewEvidence(t, now);
    const doc = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", t.uuid))
      .unique();
    await ctx.db.patch(doc!._id, encode("taskCards", next));
    await audit(ctx, s.user.id, "taskCard.evidence", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before: t,
      after: { ...next, evidenceName: args.name, category: args.category },
    });
  },
});
/**
 * Uploads one evidence file to a job card. The file is stored first and
 * deleted again if the card refuses it.
 *
 * @throws {ConvexError} "Choose a PDF, JPEG or PNG file up to 7 MiB.", then
 *   "This file's contents do not match its type. Choose a PDF, JPEG or PNG
 *   file." when the first bytes are not the declared type's, both before
 *   any permission check and storing nothing; the refusals of checkUpload and
 *   finishUpload.
 */
export const upload = action({
  args: {
    ...fileArgs,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
    category,
  },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() => {
      validateWorkOrderFile(args.name, args.type, args.bytes.byteLength);
      assertFileContents(args.type, args.bytes, WORK_ORDER_FILE_TYPES);
    });
    const card = {
      taskCardUuid: args.taskCardUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.taskCards.checkUpload, card);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.taskCards.finishUpload, {
        ...card,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
        category: args.category,
      }),
    );
  },
});
/**
 * Deletes one evidence file from an open, unsigned job card, and its stored
 * file once nothing else uses it. Writes a "taskCard.evidence_removed"
 * change-log row.
 *
 * @throws {ConvexError} The refusals of checkContext, first; "Evidence not
 *   found.", also for evidence the caller cannot read; as authorized;
 *   "Evidence can be deleted only from an open, unsigned job card."
 */
export const removeEvidence = mutation({
  args: { id: v.id("taskEvidence"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const file = await ctx.db.get(args.id);
    const s = await withCard(ctx, state, file?.taskCardUuid ?? "");
    const t = file && s.taskCards.find((t) => t.uuid === file.taskCardUuid);
    // One refusal for evidence that is gone or out of the caller's sight, so
    // an id never tells that another program's evidence exists (review T4).
    if (!file || !t || !can(s, t.aircraftUuid, "read"))
      throw new ConvexError(NO_EVIDENCE);
    await authorized(ctx, t.aircraftUuid, "maintenance", s);
    if (!evidenceRemovable(s, t))
      throw new ConvexError(
        "Evidence can be deleted only from an open, unsigned job card.",
      );
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, s.user.id, "taskCard.evidence_removed", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before: { name: file.name, category: file.category },
    });
  },
});

// Archived cards are read-only; a card is saved only within the program.
// The bounded working set (ADR-0013): the card, the work orders and problem
// reports the command or the card names, those orders' cards, the cards on
// no work order of its aircraft (a CSV row's import check reads them), and
// its prerequisites and theirs, beside the complete inspections and records.
async function loadCard(
  ctx: MutationCtx,
  state: ProgramContext,
  command: TaskCardCommand,
) {
  const fleet = state.aircraft;
  const { snapshot } = await hydrate(ctx, state, ["inspections", "management"]);
  const archived = await ctx.db
    .query("archivedTaskCards")
    .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
    .unique();
  if (archived) throw new ConvexError("Archived job cards are read-only.");
  const own = await taskCardDocsByUuid(ctx, [command.uuid], fleet);
  const prior = decode("taskCards", own).at(0);
  const named = namedRecords(command, prior);
  const cards = await withPrerequisites(ctx, fleet, named.prerequisites, [
    ...own,
    ...(await workOrderCardDocs(ctx, named.workOrders, fleet)),
    ...(await looseCardDocs(
      ctx,
      fleet.filter((a) => a.uuid === named.aircraftUuid),
    )),
  ]);
  const now = Date.now();
  return {
    snapshot: {
      ...snapshot,
      taskCards: decode("taskCards", cards),
      workOrders: decode(
        "workOrders",
        await workOrderDocsByUuid(ctx, named.workOrders, fleet),
      ),
      discrepancies: await discrepancyDocsByUuid(
        ctx,
        named.discrepancies,
        fleet,
      ),
    },
    docs: cards,
    now,
    numbers: await cardNumbers(ctx, state, command, prior, now),
  };
}

// The records a job card command reads by uuid: the work orders, problem
// reports and prerequisites its fields, its link or the stored card name,
// and the card's aircraft.
function namedRecords(command: TaskCardCommand, prior: TaskCard | undefined) {
  const fields = command.action === "save" ? command.fields : undefined;
  const link = "link" in command ? command.link : undefined;
  const linked = (kind: TaskLink["kind"]) =>
    link?.kind === kind ? link.uuid : "";
  return {
    aircraftUuid: fields?.aircraftUuid ?? prior?.aircraftUuid,
    prerequisites: fields?.prerequisiteUuids ?? [],
    workOrders: [
      fields?.workOrderUuid ?? "",
      prior?.workOrderUuid ?? "",
      linked("workOrder"),
    ],
    discrepancies: [
      fields?.discrepancyUuid ?? "",
      prior?.discrepancyUuid ?? "",
      linked("discrepancy"),
    ],
  };
}

// Adds the command's prerequisites, then each loaded card's, until none is
// missing, so the prerequisite and cycle checks walk the same cards a full
// load holds.
async function withPrerequisites(
  ctx: MutationCtx,
  fleet: ProgramContext["aircraft"],
  named: readonly string[],
  loaded: Doc<"taskCards">[],
): Promise<Doc<"taskCards">[]> {
  let cards = inLoadOrder(loaded, fleet);
  const sought = new Set<string>();
  let missing = missingOf(cards, named, sought);
  while (missing.length) {
    cards = inLoadOrder(
      [...cards, ...(await taskCardDocsByUuid(ctx, missing, fleet))],
      fleet,
    );
    missing = missingOf(cards, named, sought);
  }
  return cards;
}

// Prerequisites not yet loaded nor sought: one sought but not found is no
// card of the program, so it is not sought again.
function missingOf(
  cards: Doc<"taskCards">[],
  named: readonly string[],
  sought: Set<string>,
) {
  const have = new Set(cards.map((c) => c.uuid));
  const wanted = [
    ...named,
    ...decode("taskCards", cards).flatMap((c) => c.prerequisiteUuids),
  ];
  const missing = [...new Set(wanted)].filter(
    (uuid) => !have.has(uuid) && !sought.has(uuid),
  );
  for (const uuid of missing) sought.add(uuid);
  return missing;
}

// The program's numbers a save's numbering can meet: the command's and the
// card's own, and the year's first free sequence (recordNumbers.ts).
function cardNumbers(
  ctx: MutationCtx,
  state: ProgramContext,
  command: TaskCardCommand,
  prior: TaskCard | undefined,
  now: number,
) {
  const named = command.action === "save" ? command.fields.cardNumber : "";
  const keys = [named, prior?.cardNumber ?? ""]
    .filter(Boolean)
    .map(cardNumberKey);
  const prefix = cardNumberKey(cardNumberPrefix(now));
  return readRecordNumbers(ctx, state.aircraft, "taskCard", { keys, prefix });
}

// The caller's program with one job card, if it is the program's, and its
// work order: all the evidence functions' checks read (ADR-0013).
async function withCard(
  ctx: QueryCtx | MutationCtx,
  state: ProgramContext,
  taskCardUuid: string,
) {
  const fleet = state.aircraft;
  const taskCards = decode(
    "taskCards",
    await taskCardDocsByUuid(ctx, [taskCardUuid], fleet),
  );
  const orders = taskCards.map((t) => t.workOrderUuid);
  return {
    ...state,
    taskCards,
    workOrders: decode(
      "workOrders",
      await workOrderDocsByUuid(ctx, orders, fleet),
    ),
  };
}

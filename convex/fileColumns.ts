/**
 * Responsibility: Copies of a file's owner onto the file row, so the
 *   workspace reads files in a few index ranges instead of one per record:
 *   writing them, keeping them in step, and reading files by them.
 * Layer: Server. Convex reads and writes of taskEvidence and inventoryFiles;
 *   no rule of who may see a file (the callers' listings keep those).
 * Dependencies: ./_generated (types), ./collections (decode).
 *
 * A job card's evidence carries the card's work order, and an inventory
 * file its item's Flight Program. Each copy is derived, like the history
 * window's columns (ADR-0013): migrations:backfillHistoryColumns fills and
 * corrects it, and every read also takes the rows still without it, so a
 * listing is never short before the backfill, only larger.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decode } from "./collections";

type Ctx = QueryCtx | MutationCtx;
type Evidence = Doc<"taskEvidence">;
type InventoryFile = Doc<"inventoryFiles">;

/**
 * The program key an inventory file is stored under: its item's program, or
 * "" for an unassigned item, so that a file without the copy (undefined)
 * is never taken for one on an unassigned item.
 *
 * @param programUuid - The item's row's program, as managementDocs reads it.
 */
export const inventoryProgramKey = (programUuid: string | undefined) =>
  programUuid ?? "";

/**
 * The job cards' evidence, read by work order: one range per work order the
 * cards name, and per aircraft one for cards on no work order and one for
 * rows without the copy, plus the rows stored before evidence carried its
 * aircraft.
 *
 * A card's work-order link is set once, from none to an order
 * (src/domain/taskCards.ts), and {@link moveCardEvidence} moves its evidence
 * with it, so a row's copy is its card's order, none, or missing.
 *
 * @param cards - The cards whose evidence is listed.
 * @returns Each card's evidence, oldest first as the taskCard index orders
 *   it; cards without evidence are absent.
 */
export async function evidenceByCard(
  ctx: Ctx,
  cards: readonly {
    uuid: string;
    aircraftUuid: string;
    workOrderUuid: string;
  }[],
): Promise<Map<string, Evidence[]>> {
  const ranges = new Map<string, [string, string | undefined]>();
  const range = (aircraft: string, order: string | undefined) =>
    ranges.set(`${aircraft}|${order ?? "-"}`, [aircraft, order]);
  for (const card of cards) {
    range(card.aircraftUuid, card.workOrderUuid);
    range(card.aircraftUuid, "");
    range(card.aircraftUuid, undefined);
  }
  const rows = await Promise.all([
    ...[...ranges.values()].map(([aircraft, order]) =>
      ctx.db
        .query("taskEvidence")
        .withIndex("aircraftWorkOrder", (q) =>
          q.eq("aircraftUuid", aircraft).eq("workOrderUuid", order),
        )
        .collect(),
    ),
    cards.length ? unplacedEvidence(ctx) : [],
  ]);
  return byRecord(rows.flat(), cards, (f) => f.taskCardUuid);
}

/**
 * The inventory files of a program's items, in two ranges: those stored
 * under the program and those without the copy.
 *
 * @param programUuid - The program the items were read for; undefined for
 *   the unassigned items.
 * @param items - The stock and component records whose files are listed.
 * @returns Each item's files, oldest first as the stock index orders them;
 *   items without files are absent.
 */
export async function inventoryFilesByItem(
  ctx: Ctx,
  programUuid: string | undefined,
  items: readonly { uuid: string }[],
): Promise<Map<string, InventoryFile[]>> {
  if (!items.length) return new Map();
  const files = (key: string | undefined) =>
    ctx.db
      .query("inventoryFiles")
      .withIndex("program", (q) => q.eq("programUuid", key))
      .collect();
  const [stored, unfilled] = await Promise.all([
    files(inventoryProgramKey(programUuid)),
    files(undefined),
  ]);
  return byRecord([...stored, ...unfilled], items, (f) => f.stockUuid);
}

/**
 * Files an inventory attachment under its item's program. Every insert into
 * inventoryFiles goes through here, so each row carries the copy.
 *
 * @param file - The row without its program.
 * @returns The new row's id.
 */
export async function insertInventoryFile(
  ctx: MutationCtx,
  file: Omit<InventoryFile, "_id" | "_creationTime" | "programUuid">,
) {
  const item = await itemRow(ctx, file.stockUuid);
  return ctx.db.insert("inventoryFiles", {
    ...file,
    programUuid: inventoryProgramKey(item?.programUuid),
  });
}

/**
 * Moves a job card's evidence to the work order the card joined.
 *
 * @param taskCardUuid - The card.
 * @param workOrderUuid - Its work order now.
 */
export async function moveCardEvidence(
  ctx: MutationCtx,
  taskCardUuid: string,
  workOrderUuid: string,
) {
  const rows = await ctx.db
    .query("taskEvidence")
    .withIndex("taskCard", (q) => q.eq("taskCardUuid", taskCardUuid))
    .collect();
  for (const row of rows)
    if (row.workOrderUuid !== workOrderUuid)
      await ctx.db.patch(row._id, { workOrderUuid });
}

/**
 * Moves an inventory item's files to the program its row now holds, when a
 * write changed it (a transfer).
 *
 * @param stockUuid - The stock item or component.
 * @param programUuid - Its row's program now; undefined when unassigned.
 */
export async function moveInventoryFiles(
  ctx: MutationCtx,
  stockUuid: string,
  programUuid: string | undefined,
) {
  const key = inventoryProgramKey(programUuid);
  const rows = await ctx.db
    .query("inventoryFiles")
    .withIndex("stock", (q) => q.eq("stockUuid", stockUuid))
    .collect();
  for (const row of rows)
    if (row.programUuid !== key)
      await ctx.db.patch(row._id, { programUuid: key });
}

/**
 * The owner copies a stored file row should hold, read from its owner: for
 * evidence its card's aircraft and work order (the card live or archived),
 * for an inventory file its item's program.
 *
 * @returns The columns; none for a file whose owner is gone, which no
 *   listing shows.
 */
export async function storedFileColumns(
  ctx: Ctx,
  table: "taskEvidence" | "inventoryFiles",
  row: Evidence | InventoryFile,
): Promise<object> {
  if (table === "inventoryFiles") {
    const item = await itemRow(ctx, (row as InventoryFile).stockUuid);
    return item ? { programUuid: inventoryProgramKey(item.programUuid) } : {};
  }
  // From the payload: a card row stored before its columns has none.
  const card = await cardOf(ctx, (row as Evidence).taskCardUuid);
  if (!card) return {};
  return { aircraftUuid: card.aircraftUuid, workOrderUuid: card.workOrderUuid };
}

// Evidence stored before files carried their aircraft: none once
// attachments:backfillAircraft or the history backfill has run.
function unplacedEvidence(ctx: Ctx) {
  return ctx.db
    .query("taskEvidence")
    .withIndex("aircraftWorkOrder", (q) => q.eq("aircraftUuid", undefined))
    .collect();
}

function itemRow(ctx: Ctx, uuid: string) {
  return ctx.db
    .query("management")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .first();
}

// The card, live or archived: a card may be archived after its evidence.
async function cardOf(ctx: Ctx, uuid: string) {
  const live = await ctx.db
    .query("taskCards")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .first();
  if (live) return decode("taskCards", [live])[0];
  const archived = await ctx.db
    .query("archivedTaskCards")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .first();
  return archived ? decode("archivedTaskCards", [archived])[0] : undefined;
}

// Files grouped by their record, each record's oldest first, as one range
// per record over its own index would return them; only the records' own.
function byRecord<F extends { _creationTime: number }>(
  files: F[],
  records: readonly { uuid: string }[],
  recordOf: (file: F) => string,
): Map<string, F[]> {
  const wanted = new Set(records.map((r) => r.uuid));
  const grouped = new Map<string, F[]>();
  const sorted = files
    .filter((f) => wanted.has(recordOf(f)))
    .sort((a, b) => a._creationTime - b._creationTime);
  for (const f of sorted) {
    const list = grouped.get(recordOf(f));
    if (list) list.push(f);
    else grouped.set(recordOf(f), [f]);
  }
  return grouped;
}

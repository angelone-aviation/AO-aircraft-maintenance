/**
 * Responsibility: Keeps the recordNumbers table, every work order and job
 *   card number by aircraft, in step with the records, and reads the numbers
 *   a save's numbering compares.
 * Layer: Server. Convex reads and writes of one derived table; the number
 *   rules come from src/domain through the rows' derived columns.
 * Dependencies: ./_generated (types), ./collections (types),
 *   src/domain/model (types).
 *
 * Derived rows, not records (ADR-0013): migrations:rebuildRecordNumbers
 * rebuilds them from the records, and they never reach the change log.
 * Archived job cards hold no row, since the uniqueness check has only ever
 * compared live cards.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { PayloadCollection, StoredRow } from "./collections";
import type { NumberedRecord } from "../src/domain/model";

/** The kind of record a number row numbers. */
export type NumberKind = Doc<"recordNumbers">["kind"];
/** A number row as stored, without its system fields. */
export type RecordNumber = Omit<Doc<"recordNumbers">, "_id" | "_creationTime">;

/**
 * The numbers a save's numbering reads: exact keys (numbers the command or
 * its record name), and the prefix its next free number counts up from.
 */
export interface NumberLookup {
  keys: readonly string[];
  prefix: string;
}

const NUMBER_KINDS: Partial<Record<PayloadCollection, NumberKind>> = {
  workOrders: "workOrder",
  taskCards: "taskCard",
};

/**
 * The number row a stored row derives: its aircraft, kind, number key and
 * uuid.
 *
 * @param row - A row as `encode` writes it, so its `numberKey` is set.
 * @returns The row; undefined for a collection that holds no numbers.
 */
export function recordNumberOf<N extends PayloadCollection>(
  collection: N,
  row: StoredRow<N>,
): RecordNumber | undefined {
  const kind = NUMBER_KINDS[collection];
  if (!kind) return undefined;
  const { uuid, aircraftUuid, numberKey } = row as StoredRow<
    "workOrders" | "taskCards"
  >;
  return { aircraftUuid, kind, key: numberKey ?? "", uuid };
}

/**
 * Brings a record's number row up to date after its row is written: inserts
 * it, or patches the one stored when its number or aircraft differs. Rows of
 * other collections write nothing.
 *
 * @param row - The row just inserted or replaced, as `encode` wrote it.
 */
export async function syncRecordNumber<N extends PayloadCollection>(
  ctx: MutationCtx,
  collection: N,
  row: StoredRow<N>,
): Promise<void> {
  const next = recordNumberOf(collection, row);
  if (!next) return;
  const prior = await numberRowOf(ctx, next.uuid);
  if (!prior) await ctx.db.insert("recordNumbers", next);
  else if (!holdsNumber(prior, next)) await ctx.db.patch(prior._id, next);
}

/**
 * Deletes a record's number row, for a job card deleted or archived.
 *
 * @param uuid - The record's uuid; nothing happens when it holds no row.
 */
export async function dropRecordNumber(
  ctx: MutationCtx,
  uuid: string,
): Promise<void> {
  const prior = await numberRowOf(ctx, uuid);
  if (prior) await ctx.db.delete(prior._id);
}

/**
 * The stored numbers of one kind on the given aircraft that a save's
 * numbering can meet: those whose key is one of `lookup.keys` or starts
 * with `lookup.prefix`. One index range per aircraft for the prefix, and
 * one per aircraft for each key outside it.
 *
 * @param aircraft - The Flight Program's aircraft, whose numbers are unique
 *   together.
 * @returns Each row's uuid, with its key as the number: keys are already
 *   in the case the domain compares.
 */
export async function readRecordNumbers(
  ctx: QueryCtx | MutationCtx,
  aircraft: readonly { uuid: string }[],
  kind: NumberKind,
  lookup: NumberLookup,
): Promise<NumberedRecord[]> {
  const { prefix } = lookup;
  const keys = [...new Set(lookup.keys)].filter((k) => !k.startsWith(prefix));
  const rows = await Promise.all(
    aircraft.flatMap(({ uuid }) => [
      numbersFrom(ctx, uuid, kind, prefix),
      ...keys.map((key) => numbersAt(ctx, uuid, kind, key)),
    ]),
  );
  return rows.flat().map((r) => ({ uuid: r.uuid, number: r.key }));
}

function numberRowOf(ctx: QueryCtx | MutationCtx, uuid: string) {
  return ctx.db
    .query("recordNumbers")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
}

function holdsNumber(row: Doc<"recordNumbers">, next: RecordNumber) {
  return (
    row.aircraftUuid === next.aircraftUuid &&
    row.kind === next.kind &&
    row.key === next.key
  );
}

// Every key that starts with the prefix sorts below the prefix followed by
// U+FFFF; a next free number is the prefix and digits, so none is missed.
function numbersFrom(
  ctx: QueryCtx | MutationCtx,
  aircraftUuid: string,
  kind: NumberKind,
  prefix: string,
) {
  return ctx.db
    .query("recordNumbers")
    .withIndex("key", (q) =>
      q
        .eq("aircraftUuid", aircraftUuid)
        .eq("kind", kind)
        .gte("key", prefix)
        .lt("key", prefix + "￿"),
    )
    .collect();
}

function numbersAt(
  ctx: QueryCtx | MutationCtx,
  aircraftUuid: string,
  kind: NumberKind,
  key: string,
) {
  return ctx.db
    .query("recordNumbers")
    .withIndex("key", (q) =>
      q.eq("aircraftUuid", aircraftUuid).eq("kind", kind).eq("key", key),
    )
    .collect();
}

/**
 * Responsibility: Keeps the purchasingKeys table, what each parts request and
 *   purchase order is looked up by, in step with the records, and finds
 *   records by those keys.
 * Layer: Server. Convex reads and writes of one derived table; which keys a
 *   rule needs is the caller's (convex/workingSet.ts).
 * Dependencies: ./_generated (types), ./collections (types), src/domain
 *   (partsRequests and purchaseOrders types).
 *
 * Derived rows, not records (ADR-0013): every write of a request or order
 * syncs them, migrations:backfillHistoryColumns fills them for older rows,
 * and they never reach the change log. A key only names a candidate: the
 * domain still applies its rule to the record, so a stale key costs a read,
 * never a different result. A missing one would, which is why every write
 * path syncs.
 */
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { PayloadCollection, StoredRecord } from "./collections";
import type { PartsRequest } from "../src/domain/partsRequests";
import type { PurchaseOrder } from "../src/domain/purchaseOrders";

/** A table whose records carry lookup keys. */
export type PurchasingTable = Doc<"purchasingKeys">["table"];
/** What a key names; see {@link purchasingKeysOf}. */
export type PurchasingKeyKind = Doc<"purchasingKeys">["kind"];
/** A payload collection whose records carry their own uuid. */
type RecordCollection = Exclude<PayloadCollection, "faaMonitors">;
/** A key row as stored, without its system fields. */
export type PurchasingKey = Omit<
  Doc<"purchasingKeys">,
  "_id" | "_creationTime"
>;

/**
 * The keys a stored record is looked up by, each once.
 *
 * - A parts request: `requestId` for each request id its history holds
 *   (its own commands', a receipt's, an occurrence's creation), `component`
 *   for each component a line names, and `list` its aircraft while it is an
 *   active recurring list.
 * - A purchase order: `requestId` for each request id its history holds,
 *   `allocation` for each parts request a line is allocated to, and
 *   `component` for each component a line returns from repair.
 *
 * @returns The keys, in the record's program; blank ones are skipped.
 *   Undefined for another collection, which holds none.
 */
export function purchasingKeysOf<N extends PayloadCollection>(
  collection: N,
  record: StoredRecord<N>,
): PurchasingKey[] | undefined {
  if (collection === "partsRequests")
    return keysOf("partsRequests", record as PartsRequest, requestKeys);
  if (collection === "purchaseOrders")
    return keysOf("purchaseOrders", record as PurchaseOrder, orderKeys);
  return undefined;
}

/**
 * Brings a record's key rows up to date after its row is written: inserts
 * the keys it gained and deletes those it lost. Records of other collections
 * write nothing.
 *
 * @param record - The record as just inserted, replaced or patched.
 * @returns How many key rows it inserted or deleted.
 */
export async function syncPurchasingKeys<N extends RecordCollection>(
  ctx: MutationCtx,
  collection: N,
  record: StoredRecord<N>,
): Promise<number> {
  const next = purchasingKeysOf(collection, record);
  if (!next) return 0;
  const stored = await ctx.db
    .query("purchasingKeys")
    .withIndex("record", (q) =>
      q.eq("table", collection as PurchasingTable).eq("uuid", record.uuid),
    )
    .collect();
  const wanted = new Set(next.map(keyId));
  const held = new Set(stored.map(keyId));
  const stale = stored.filter((row) => !wanted.has(keyId(row)));
  const added = next.filter((row) => !held.has(keyId(row)));
  for (const row of stale) await ctx.db.delete(row._id);
  for (const row of added) await ctx.db.insert("purchasingKeys", row);
  return stale.length + added.length;
}

/**
 * The uuids of a Flight Program's records in one table that hold any of the
 * given keys of one kind: one index range per key.
 *
 * @param keys - Blanks and repeats are skipped.
 * @returns Each uuid once, in no promised order.
 */
export async function uuidsByKey(
  ctx: QueryCtx | MutationCtx,
  programUuid: string,
  table: PurchasingTable,
  kind: PurchasingKeyKind,
  keys: Iterable<string>,
): Promise<string[]> {
  const wanted = [...new Set(keys)].filter(Boolean);
  const rows = await Promise.all(
    wanted.map((key) =>
      ctx.db
        .query("purchasingKeys")
        .withIndex("key", (q) =>
          q
            .eq("programUuid", programUuid)
            .eq("table", table)
            .eq("kind", kind)
            .eq("key", key),
        )
        .collect(),
    ),
  );
  return [...new Set(rows.flat().map((row) => row.uuid))];
}

type Keyed = [PurchasingKeyKind, string[]][];

function keysOf<R extends { uuid: string; programUuid: string }>(
  table: PurchasingTable,
  record: R,
  keyed: (record: R) => Keyed,
): PurchasingKey[] {
  const { uuid, programUuid } = record;
  const rows = keyed(record).flatMap(([kind, keys]) =>
    keys
      .filter(Boolean)
      .map((key) => ({ programUuid, table, kind, key, uuid })),
  );
  return [...new Map(rows.map((row) => [keyId(row), row])).values()];
}

function requestKeys(r: PartsRequest): Keyed {
  const list = r.recurring && !r.cancelled ? [r.aircraftUuid] : [];
  return [
    ["requestId", r.history.map((h) => h.requestUuid)],
    ["component", r.lines.map((l) => l.componentUuid)],
    ["list", list],
  ];
}

function orderKeys(p: PurchaseOrder): Keyed {
  return [
    ["requestId", p.history.map((h) => h.requestUuid)],
    [
      "allocation",
      p.lines.flatMap((l) =>
        (l.requestAllocations ?? []).map((a) => a.requestUuid),
      ),
    ],
    ["component", p.lines.map((l) => l.repairComponentUuid ?? "")],
  ];
}

// A key row's identity within its record: the table and uuid are the
// record's own.
function keyId(row: Pick<PurchasingKey, "programUuid" | "kind" | "key">) {
  return JSON.stringify([row.programUuid, row.kind, row.key]);
}

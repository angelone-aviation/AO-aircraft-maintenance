/**
 * Responsibility: How each stored payload row decodes into its Snapshot
 *   collection, and how a record encodes back into its row, said once.
 * Layer: Server. Pure: no Convex context, no I/O, and only type imports from
 *   convex, so the backup scripts can bundle it.
 * Dependencies: src/domain (model, componentTemplates and the stored-record
 *   schemas), convex/server and ./_generated (types).
 *
 * Component templates and setups decode as written, without a schema: their
 * readers have always taken the stored JSON as it is, and parsing it would
 * strip unknown fields and fill defaults.
 */
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import type { Snapshot } from "../src/domain/model";
import type {
  ComponentSetup,
  ComponentTemplate,
} from "../src/domain/componentTemplates";
import { recordSchema } from "../src/domain/management";
import { taskCardSchema } from "../src/domain/taskCards";
import { workOrderSchema } from "../src/domain/workOrders";
import { adSchema } from "../src/domain/airworthiness";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import { costRecordSchema } from "../src/domain/costs";
import { faaMonitorSchema } from "../src/domain/faa";
import { flightPlanSchema } from "../src/domain/flightPlans";
import { expiringItemSchema } from "../src/domain/expiringItems";

/** A Snapshot collection stored as one JSON payload per row. */
export type PayloadCollection =
  | "management"
  | "taskCards"
  | "archivedTaskCards"
  | "workOrders"
  | "airworthiness"
  | "partsRequests"
  | "purchaseOrders"
  | "checklists"
  | "componentTemplates"
  | "componentSetups"
  | "inspectionTemplates"
  | "costs"
  | "faaMonitors"
  | "flightPlans"
  | "expiringItems";

/** One record of a payload collection, as the Snapshot holds it. */
export type StoredRecord<N extends PayloadCollection> = NonNullable<
  Snapshot[N]
>[number];

/** The stored row of a payload collection, without its system fields. */
export type StoredRow<N extends PayloadCollection> = WithoutSystemFields<
  Doc<N>
>;

/**
 * Decodes stored rows into their Snapshot collection, checked by the
 * collection's domain schema (which trims text and fills defaults).
 *
 * @returns One record per row, in row order.
 * @throws {SyntaxError} When a payload is not JSON.
 * @throws {z.ZodError} When a payload no longer matches its schema.
 */
export function decode<N extends PayloadCollection>(
  collection: N,
  rows: readonly { payload: string }[],
): StoredRecord<N>[] {
  const schema = SCHEMAS[collection];
  return rows.map((row) => schema.parse(JSON.parse(row.payload)));
}

/** Where a stored payload breaks its collection's schema, and the rule. */
export interface DecodeIssue {
  /** Keys and list positions from the record down to the field. */
  path: PropertyKey[];
  message: string;
}

/**
 * Checks one stored payload value against its collection's schema without
 * throwing, for a reader that shows an old or damaged record as stored.
 *
 * @param value - The payload, already parsed from JSON.
 * @returns The decoded record, or the value as stored when it does not match,
 *   with the schema's issues in its order: each path and message only.
 */
export function decodeLenient<N extends PayloadCollection>(
  collection: N,
  value: unknown,
):
  | { valid: true; record: StoredRecord<N> }
  | { valid: false; stored: unknown; issues: DecodeIssue[] } {
  const result = SCHEMAS[collection].safeParse(value);
  if (result.success) return { valid: true, record: result.data };
  const issues = result.error.issues.map(({ path, message }) => ({
    path,
    message,
  }));
  return { valid: false, stored: value, issues };
}

/**
 * Encodes a record into its stored row: the columns the table is indexed or
 * scoped by, lifted from the record, and the record as the JSON payload.
 *
 * A management row keeps an empty `aircraftUuid` as the record has it. No
 * index covers the column, and its one reader (inspectionDocs) treats empty
 * and absent alike, so older rows without it read back the same.
 *
 * @returns The row's fields, ready to insert or replace.
 * @throws {Error} For a component template without a Flight Program, which
 *   its table cannot store.
 */
export function encode<N extends PayloadCollection>(
  collection: N,
  record: StoredRecord<N>,
): StoredRow<N> {
  return ENCODERS[collection](record, JSON.stringify(record));
}

interface Schema<T> {
  parse(value: unknown): T;
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly DecodeIssue[] } };
}

function asWritten<T>(): Schema<T> {
  return {
    parse: (value) => value as T,
    safeParse: (value) => ({ success: true, data: value as T }),
  };
}

const SCHEMAS: { [N in PayloadCollection]: Schema<StoredRecord<N>> } = {
  management: recordSchema,
  taskCards: taskCardSchema,
  archivedTaskCards: taskCardSchema,
  workOrders: workOrderSchema,
  airworthiness: adSchema,
  partsRequests: partsRequestSchema,
  purchaseOrders: poSchema,
  checklists: checklistRecordSchema,
  componentTemplates: asWritten<ComponentTemplate>(),
  componentSetups: asWritten<ComponentSetup>(),
  inspectionTemplates: inspectionTemplateSchema,
  costs: costRecordSchema,
  faaMonitors: faaMonitorSchema,
  flightPlans: flightPlanSchema,
  expiringItems: expiringItemSchema,
};

type Encoder<N extends PayloadCollection> = (
  record: StoredRecord<N>,
  payload: string,
) => StoredRow<N>;

const ENCODERS: { [N in PayloadCollection]: Encoder<N> } = {
  management: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    kind: r.kind,
    aircraftUuid: "aircraftUuid" in r ? r.aircraftUuid : undefined,
    payload,
  }),
  taskCards: (r, payload) => ({
    uuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  archivedTaskCards: (r, payload) => ({
    uuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  workOrders: (r, payload) => ({
    uuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  airworthiness: (r, payload) => ({
    uuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    programUuid: r.programUuid,
    payload,
  }),
  partsRequests: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    payload,
  }),
  purchaseOrders: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    payload,
  }),
  checklists: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  // The template schema allows a record without a program; the table does not.
  componentTemplates: (r, payload) => {
    if (r.programUuid === undefined)
      throw new Error(`Component template ${r.uuid} has no Flight Program.`);
    return { uuid: r.uuid, programUuid: r.programUuid, payload };
  },
  componentSetups: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  inspectionTemplates: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    payload,
  }),
  // A program's labor-rate settings belong to no aircraft.
  costs: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    aircraftUuid: r.kind === "settings" ? "" : r.aircraftUuid,
    payload,
  }),
  faaMonitors: (r, payload) => ({ aircraftUuid: r.aircraftUuid, payload }),
  flightPlans: (r, payload) => ({
    uuid: r.uuid,
    aircraftUuid: r.aircraftUuid,
    payload,
  }),
  expiringItems: (r, payload) => ({
    uuid: r.uuid,
    programUuid: r.programUuid,
    payload,
  }),
};

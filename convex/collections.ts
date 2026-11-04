/**
 * Responsibility: How each stored payload row decodes into its Snapshot
 *   collection, said once for every reader.
 * Layer: Server. Pure: no Convex context and no I/O.
 * Dependencies: src/domain (model, componentTemplates and the stored-record
 *   schemas).
 *
 * Component templates and setups decode as written, without a schema: their
 * readers have always taken the stored JSON as it is, and parsing it would
 * strip unknown fields and fill defaults.
 */
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
  | "flightPlans";

/** One record of a payload collection, as the Snapshot holds it. */
export type StoredRecord<N extends PayloadCollection> = NonNullable<
  Snapshot[N]
>[number];

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
  const parse = DECODERS[collection];
  return rows.map((row) => parse(JSON.parse(row.payload)));
}

const DECODERS: {
  [N in PayloadCollection]: (value: unknown) => StoredRecord<N>;
} = {
  management: (value) => recordSchema.parse(value),
  taskCards: (value) => taskCardSchema.parse(value),
  archivedTaskCards: (value) => taskCardSchema.parse(value),
  workOrders: (value) => workOrderSchema.parse(value),
  airworthiness: (value) => adSchema.parse(value),
  partsRequests: (value) => partsRequestSchema.parse(value),
  purchaseOrders: (value) => poSchema.parse(value),
  checklists: (value) => checklistRecordSchema.parse(value),
  componentTemplates: (value) => value as ComponentTemplate,
  componentSetups: (value) => value as ComponentSetup,
  inspectionTemplates: (value) => inspectionTemplateSchema.parse(value),
  costs: (value) => costRecordSchema.parse(value),
  faaMonitors: (value) => faaMonitorSchema.parse(value),
  flightPlans: (value) => flightPlanSchema.parse(value),
};

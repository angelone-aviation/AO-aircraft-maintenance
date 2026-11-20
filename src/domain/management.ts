/**
 * Responsibility: The public interface of inventory and inspection records;
 *   the rules live in ./management/.
 * Layer: Domain. Re-exports only; no I/O, no React.
 * Dependencies: ./components, ./management/schemas, ./management/counters,
 *   ./management/apply, ./management/checks, ./management/inspections,
 *   ./management/stock.
 */
// Kept for importers that read components through this module.
export { componentTotals, componentSchema } from "./components";
export type { Component } from "./components";
export {
  INSPECTION_REFERENCE_MAX_LENGTH,
  PURCHASE_REFERENCE_MAX_LENGTH,
  STOCK_VENDOR_MAX_LENGTH,
  locationSchema,
  vendorSchema,
  stockSchema,
  recordSchema,
  inspectionSchema,
  managementCommandSchema,
  type Vendor,
  type ManagedRecord,
  type Stock,
  type Location,
  type ManagementCommand,
} from "./management/schemas";
export {
  inspectionCounters,
  MissingInspectionComponent,
  validateMaintenanceTotals,
} from "./management/counters";
export { applyManagement } from "./management/apply";
export { mayMaintain } from "./management/checks";
export { tracksLandings } from "./management/inspections";
export {
  inventoryCounts,
  needsReorder,
  type InventoryCounts,
} from "./management/stock";

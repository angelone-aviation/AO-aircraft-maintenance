/**
 * Responsibility: The public interface of inventory and inspection records;
 *   the rules live in ./management/.
 * Layer: Domain. Re-exports only; no I/O, no React.
 * Dependencies: ./components, ./management/schemas, ./management/counters,
 *   ./management/apply.
 */
// Kept for importers that read components through this module.
export { componentTotals, componentSchema } from "./components";
export type { Component } from "./components";
export {
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
  validateMaintenanceTotals,
} from "./management/counters";
export { applyManagement } from "./management/apply";

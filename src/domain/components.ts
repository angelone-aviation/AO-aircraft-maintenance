/**
 * Responsibility: The public interface of serialized, life-tracked components
 *   and their service requirements; the rules live in ./components/.
 * Layer: Domain. Re-exports only; no I/O, no React.
 * Dependencies: ./components/records, ./components/usage,
 *   ./components/calendar, ./components/status, ./components/validation,
 *   ./components/requirements, ./components/service.
 */
export {
  ComponentUsageError,
  POSITIONS,
  componentSchema,
  requirementSchema,
  movementSchema,
  baselineFields,
  serviceFields,
  type Component,
  type ComponentRequirement,
  type ComponentMovement,
} from "./components/records";
export {
  tracking,
  componentAircraftSeconds,
  componentTotals,
} from "./components/usage";
export { calendarDue } from "./components/calendar";
export { requirementDueDate, requirementStatus } from "./components/status";
export {
  validateComponent,
  componentDescendants,
} from "./components/validation";
export {
  saveRequirement,
  moveRequirement,
  rebaseServicedRequirements,
} from "./components/requirements";
export { movement, serviceComponent } from "./components/service";

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
  COMPONENT_NOTES_MAX_LENGTH,
  COMPONENT_TYPE_MAX_LENGTH,
  COMPONENT_PART_ID_MAX_LENGTH,
  PARTS_LOCATION_MAX_LENGTH,
  INCOMING_TAG_FIELD_MAX_LENGTH,
  REQUIREMENT_DESCRIPTION_MAX_LENGTH,
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
  aircraftSecondsFor,
  componentAircraftSeconds,
  componentTotals,
} from "./components/usage";
export { calendarDue } from "./components/calendar";
export {
  REQUIREMENT_WARNING_DEFAULTS,
  requirementDueDate,
  requirementStatus,
} from "./components/status";
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

/**
 * Responsibility: Keeps the recurring-parts rules importable at this path.
 * Layer: Domain. Re-exports only; no I/O, no React.
 * Dependencies: src/domain/partsRequests.ts.
 *
 * The parts-request applier creates a saved list's occurrences itself, so the
 * rules live beside it; kept here, the two modules would import each other.
 */
export {
  generateRecurringRequests,
  recurringPartsNeeds,
} from "./partsRequests";

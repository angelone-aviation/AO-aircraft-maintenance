/**
 * Responsibility: The public interface of work-order completion and its
 *   logbook text; the rules live in ./work-order-closeout/.
 * Layer: Domain. Re-exports only; no I/O, no React.
 * Dependencies: ./work-order-closeout/logbookText,
 *   ./work-order-closeout/closeout.
 */
export {
  logbookPerformers,
  workPerformedText,
} from "./work-order-closeout/logbookText";
export {
  completeWorkOrder,
  previewComponentCloseout,
  type ComponentCloseoutPreview,
} from "./work-order-closeout/closeout";

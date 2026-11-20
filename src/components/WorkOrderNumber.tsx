/**
 * Responsibility: Names a work order by its number wherever another record
 *   points at it, loading an order older than the workspace keeps.
 * Layer: UI. Presentational over src/data/historyPages; no rules.
 * Dependencies: src/data/historyPages.ts.
 *
 * A compliance entry or purchase-order line can name a work order the
 * retention window leaves out (ADR-0013); without this it showed the uuid.
 */
import { useRecordsSnapshot, useWorkOrderHistory } from "../data/historyPages";

/**
 * The number of the work order `uuid`: from the screen's records, else
 * loaded through the history query while connected.
 *
 * @param props.uuid - The work order.
 * @returns Its number; the uuid while it loads, offline, or when the user
 *   may not read it.
 */
export function WorkOrderNumber({ uuid }: { uuid: string }) {
  const s = useRecordsSnapshot();
  const held = s?.workOrders?.find((w) => w.uuid === uuid);
  const loaded = useWorkOrderHistory(held ? undefined : uuid);
  return <>{held?.number || loaded.history?.workOrder.number || uuid}</>;
}

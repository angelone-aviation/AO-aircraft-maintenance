/**
 * Responsibility: One vendor's order history and what was ordered on it,
 *   with older orders loaded page by page.
 * Layer: UI. A dialog over src/data/historyPages; the rules are the
 *   domain's.
 * Dependencies: react, src/data (store, historyPages), src/domain (vendors,
 *   purchaseOrders, management and model types, costs/units),
 *   ./HistoryPager, ./ui, ./design.
 *
 * The workspace keeps open orders and those changed in the window (H5,
 * ADR-0013), so a vendor's whole history needs its older pages: the totals
 * say they cover the orders listed.
 */
import { useMemo } from "react";
import { useWorkspace } from "../data/store";
import { useHistoryPages, withHistory } from "../data/historyPages";
import { orderedSpend, vendorOrders } from "../domain/vendors";
import {
  poStatus,
  poTotal,
  type PurchaseOrder,
} from "../domain/purchaseOrders";
import type { Vendor } from "../domain/management";
import { CENTS_PER_DOLLAR } from "../domain/costs/units";
import { HistoryPager, windowSummary } from "./HistoryPager";
import { Modal } from "./ui";
import { EmptyState } from "./design";

/**
 * The dialog listing a vendor's purchase orders, newest first, with the
 * total ordered on those listed, by currency, and Load older.
 *
 * @param props.vendor - The vendor, matched by name as vendorKey matches.
 * @param props.onClose - Closes the dialog.
 */
export function VendorOrders({
  vendor,
  onClose,
}: {
  vendor: Vendor;
  onClose: () => void;
}) {
  const { snapshot } = useWorkspace();
  const pages = useHistoryPages({
    kind: "purchaseOrders",
    vendor: vendor.name,
  });
  const orders = useMemo(() => {
    const s = snapshot && withHistory(snapshot, pages.records);
    return vendorOrders(s?.purchaseOrders ?? [], vendor.name);
  }, [snapshot, pages.records, vendor.name]);
  const loaded = pages.records.purchaseOrders.length;
  return (
    <Modal title={`Orders · ${vendor.name}`} wide onClose={onClose}>
      <OrderedTotal orders={orders} />
      {orders.length ? (
        <OrderTable orders={orders} />
      ) : (
        <EmptyState title="No orders listed">
          Load older orders to see this vendor's earlier purchasing.
        </EmptyState>
      )}
      <HistoryPager
        pages={pages}
        summary={windowSummary("purchaseOrders", loaded, "order")}
      />
    </Modal>
  );
}

function OrderedTotal({ orders }: { orders: PurchaseOrder[] }) {
  const spend = orderedSpend(orders);
  if (!spend.length) return null;
  return (
    <p>
      Ordered on the orders listed:{" "}
      {spend.map((s) => cash(s.cents, s.currency)).join(" · ")}
    </p>
  );
}

function OrderTable({ orders }: { orders: PurchaseOrder[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>PO number</th>
            <th>Status</th>
            <th>Created</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((p) => (
            <tr key={p.uuid}>
              <td>{p.number}</td>
              <td>{poStatus(p)}</td>
              <td>{new Date(p.createdAt).toISOString().slice(0, 10)}</td>
              <td>{cash(poTotal(p), p.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cash(cents: number, currency: string) {
  return `${currency} ${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
}

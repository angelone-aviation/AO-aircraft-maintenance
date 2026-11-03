import { useState } from "react";
import { useWorkspace } from "../data/store";
import { localDate } from "../domain/model";
import {
  coreReturnRows,
  type CoreReturnRow,
  type PurchaseOrder,
} from "../domain/purchaseOrders";
import { AsyncForm, Badge, Field, Modal, value } from "./ui";
const statusLabels = {
  pending: "Pending",
  shipped: "Shipped",
  credited: "Credited",
} as const;
export function CoreReturns({ orders }: { orders: PurchaseOrder[] }) {
  const { online, connected } = useWorkspace();
  const [editing, setEditing] = useState<{
    row: CoreReturnRow;
    status: "shipped" | "credited";
  }>();
  const [showCredited, setShowCredited] = useState(false);
  const today = localDate();
  const rows = coreReturnRows(orders, today).filter(
    (r) => showCredited || r.status !== "credited",
  );
  return (
    <section aria-labelledby="core-returns-heading">
      <h2 id="core-returns-heading">Core returns</h2>
      <p className="muted">
        Exchange units received on a purchase order create a core return. Ship
        the core by its due date, then record the vendor’s credit.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={showCredited}
          onChange={(e) => setShowCredited(e.target.checked)}
        />
        Show credited cores
      </label>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Part / serial</th>
                <th>Vendor / PO</th>
                <th>Due</th>
                <th>Status</th>
                <th>Tracking / notes</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.uuid}>
                  <td>
                    <strong>{r.partNumber}</strong>
                    <small className="block">
                      Serial {r.serial || "not recorded"} · Qty {r.quantity}
                    </small>
                  </td>
                  <td>
                    {r.vendor}
                    <small className="block">{r.poNumber}</small>
                  </td>
                  <td>
                    {r.dueDate}
                    {r.overdue && (
                      <>
                        {" "}
                        <Badge tone="danger">Overdue</Badge>
                      </>
                    )}
                  </td>
                  <td>
                    <Badge
                      tone={
                        r.status === "credited"
                          ? "good"
                          : r.status === "shipped"
                            ? "neutral"
                            : "warning"
                      }
                    >
                      {statusLabels[r.status]}
                    </Badge>
                    {r.shippedDate && (
                      <small className="block">Shipped {r.shippedDate}</small>
                    )}
                    {r.creditedDate && (
                      <small className="block">Credited {r.creditedDate}</small>
                    )}
                  </td>
                  <td>
                    {r.tracking || "—"}
                    {r.notes && <small className="block">{r.notes}</small>}
                  </td>
                  <td>
                    {r.status !== "credited" && (
                      <button
                        type="button"
                        className="button"
                        disabled={!online || !connected}
                        onClick={() =>
                          setEditing({
                            row: r,
                            status:
                              r.status === "pending" ? "shipped" : "credited",
                          })
                        }
                      >
                        {r.status === "pending"
                          ? `Mark ${r.partNumber} core shipped`
                          : `Mark ${r.partNumber} core credited`}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No open core returns.</p>
      )}
      {editing && (
        <Modal
          title={`${editing.status === "shipped" ? "Ship core" : "Record core credit"} · ${editing.row.partNumber}`}
          onClose={() => setEditing(undefined)}
        >
          <CoreReturnForm
            row={editing.row}
            status={editing.status}
            onDone={() => setEditing(undefined)}
          />
        </Modal>
      )}
    </section>
  );
}
function CoreReturnForm({
  row,
  status,
  onDone,
}: {
  row: CoreReturnRow;
  status: "shipped" | "credited";
  onDone: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const [requestUuid] = useState(() => crypto.randomUUID());
  return (
    <AsyncForm
      submitLabel={status === "shipped" ? "Save shipment" : "Save credit"}
      disabled={!online || !connected}
      onSubmit={async (d) => {
        await backend!.purchaseOrder({
          kind: "core",
          requestUuid,
          uuid: row.poUuid,
          version: row.poVersion,
          coreUuid: row.uuid,
          status,
          date: value(d, "date"),
          tracking: status === "shipped" ? value(d, "tracking") : "",
          notes: value(d, "notes"),
        });
        useWorkspace.setState({
          notice:
            status === "shipped"
              ? "Core shipment recorded."
              : "Core credit recorded.",
        });
        onDone();
      }}
    >
      <p>
        {row.vendor} · {row.poNumber} · Due {row.dueDate}
      </p>
      <Field label={status === "shipped" ? "Ship date" : "Credit date"}>
        <input
          type="date"
          name="date"
          required
          min={row.shippedDate}
          max={localDate()}
          defaultValue={localDate()}
        />
      </Field>
      {status === "shipped" ? (
        <Field label="Core tracking number">
          <input name="tracking" required maxLength={100} />
        </Field>
      ) : null}
      <Field label="Notes">
        <textarea name="notes" maxLength={2000} defaultValue={row.notes} />
      </Field>
    </AsyncForm>
  );
}

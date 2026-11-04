/**
 * Responsibility: The Core returns list on Purchase orders, and the form that
 *   records each core's shipment and then its vendor credit.
 * Layer: UI. Writes through `backend.purchaseOrder`.
 * Dependencies: react, src/data/store.ts, src/domain/model.ts (localDate),
 *   src/domain/purchaseOrders.ts (core return rows), ./ui.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { localDate } from "../domain/model";
import {
  coreReturnRows,
  type CoreReturnRow,
  type POCommand,
  type PurchaseOrder,
} from "../domain/purchaseOrders";
import { AsyncForm, Badge, Field, Modal, value } from "./ui";

const STATUS_BADGES = {
  pending: { label: "Pending", tone: "warning" },
  shipped: { label: "Shipped", tone: "neutral" },
  credited: { label: "Credited", tone: "good" },
} as const;

// A core moves pending → shipped → credited; each step has its own form.
const STEPS = {
  shipped: {
    title: "Ship core",
    date: "Ship date",
    submit: "Save shipment",
    notice: "Core shipment recorded.",
  },
  credited: {
    title: "Record core credit",
    date: "Credit date",
    submit: "Save credit",
    notice: "Core credit recorded.",
  },
} as const;

type Step = keyof typeof STEPS;
type Editing = { row: CoreReturnRow; status: Step };
type RowProps = {
  row: CoreReturnRow;
  disabled: boolean;
  onEdit: (editing: Editing) => void;
};

/**
 * The Core returns section: cores owed for exchange units received on the
 * orders, soonest due first, each with a button for its next step. Credited
 * cores stay hidden until the user shows them.
 *
 * @param props.orders - The purchase orders whose core returns to list.
 * @returns The section; its buttons are disabled offline or disconnected.
 */
export function CoreReturns({ orders }: { orders: PurchaseOrder[] }) {
  const { online, connected } = useWorkspace();
  const [editing, setEditing] = useState<Editing>();
  const [showCredited, setShowCredited] = useState(false);
  const rows = coreReturnRows(orders, localDate()).filter(
    (r) => showCredited || r.status !== "credited",
  );
  const close = () => setEditing(undefined);
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
      <CoreReturnTable
        rows={rows}
        disabled={!online || !connected}
        onEdit={setEditing}
      />
      {editing && (
        <Modal
          title={`${STEPS[editing.status].title} · ${editing.row.partNumber}`}
          onClose={close}
        >
          <CoreReturnForm {...editing} onDone={close} />
        </Modal>
      )}
    </section>
  );
}

function CoreReturnTable({
  rows,
  ...rest
}: Omit<RowProps, "row"> & {
  rows: CoreReturnRow[];
}) {
  if (!rows.length) return <p>No open core returns.</p>;
  return (
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
          {rows.map((row) => (
            <CoreReturnLine key={row.uuid} row={row} {...rest} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoreReturnLine({ row, disabled, onEdit }: RowProps) {
  const badge = STATUS_BADGES[row.status];
  return (
    <tr>
      <td>
        <strong>{row.partNumber}</strong>
        <small className="block">
          Serial {row.serial || "not recorded"} · Qty {row.quantity}
        </small>
      </td>
      <td>
        {row.vendor}
        <small className="block">{row.poNumber}</small>
      </td>
      <td>
        {row.dueDate}
        {row.overdue && (
          <>
            {" "}
            <Badge tone="danger">Overdue</Badge>
          </>
        )}
      </td>
      <td>
        <Badge tone={badge.tone}>{badge.label}</Badge>
        {row.shippedDate && (
          <small className="block">Shipped {row.shippedDate}</small>
        )}
        {row.creditedDate && (
          <small className="block">Credited {row.creditedDate}</small>
        )}
      </td>
      <td>
        {row.tracking || "—"}
        {row.notes && <small className="block">{row.notes}</small>}
      </td>
      <NextStepCell row={row} disabled={disabled} onEdit={onEdit} />
    </tr>
  );
}

function NextStepCell({ row, disabled, onEdit }: RowProps) {
  const next: Step = row.status === "pending" ? "shipped" : "credited";
  return (
    <td>
      {row.status !== "credited" && (
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => onEdit({ row, status: next })}
        >
          {`Mark ${row.partNumber} core ${next}`}
        </button>
      )}
    </td>
  );
}

function CoreReturnForm({ row, status, onDone }: Editing & { onDone(): void }) {
  const { backend, online, connected } = useWorkspace();
  const [requestUuid] = useState(() => crypto.randomUUID());
  const step = STEPS[status];
  const save = async (data: FormData) => {
    await backend!.purchaseOrder(coreCommand(row, status, requestUuid, data));
    useWorkspace.setState({ notice: step.notice });
    onDone();
  };
  return (
    <AsyncForm
      submitLabel={step.submit}
      disabled={!online || !connected}
      onSubmit={save}
    >
      <p>
        {row.vendor} · {row.poNumber} · Due {row.dueDate}
      </p>
      <Field label={step.date}>
        <input
          type="date"
          name="date"
          required
          min={row.shippedDate}
          max={localDate()}
          defaultValue={localDate()}
        />
      </Field>
      {status === "shipped" && (
        <Field label="Core tracking number">
          <input name="tracking" required maxLength={100} />
        </Field>
      )}
      <Field label="Notes">
        <textarea name="notes" maxLength={2000} defaultValue={row.notes} />
      </Field>
    </AsyncForm>
  );
}

function coreCommand(
  row: CoreReturnRow,
  status: Step,
  requestUuid: string,
  data: FormData,
): POCommand {
  return {
    kind: "core",
    requestUuid,
    uuid: row.poUuid,
    version: row.poVersion,
    coreUuid: row.uuid,
    status,
    date: value(data, "date"),
    tracking: status === "shipped" ? value(data, "tracking") : "",
    notes: value(data, "notes"),
  };
}

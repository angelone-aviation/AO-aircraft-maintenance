/**
 * Responsibility: The Aircraft Spruce supplier link: a program's account
 *   connection, the product picker on requests and orders, and a purchase
 *   order's supplier progress.
 * Layer: UI. React components; the supplier is reached only through the
 *   workspace backend.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts,
 *   src/domain/programs.ts, src/domain/aircraftSpruce.ts, ./ui.tsx,
 *   ./SettingsBlock.tsx, ./demoNotice.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import { DEMO_KEYS_UNAVAILABLE } from "./demoNotice";
import {
  ORDER_NUMBER_MAX_LENGTH,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  SEARCH_RESULT_LIMIT,
  SECRET_MAX_LENGTH,
  USERID_MAX_LENGTH,
  priceCents,
  type SpruceStatus,
  type SpruceProduct,
  type SpruceOrderSnapshot,
  type SpruceOrderRow,
} from "../domain/aircraftSpruce";
import { AsyncForm, Field, Modal, errorText, safeHref } from "./ui";
import {
  IntegrationRow,
  UpdateButton,
  type IntegrationStatus,
} from "./SettingsBlock";

const CREDENTIAL_FIELDS = [
  {
    key: "userid",
    label: "Aircraft Spruce user ID",
    autoComplete: "username",
    maxLength: USERID_MAX_LENGTH,
  },
  {
    key: "password",
    label: "Aircraft Spruce password",
    type: "password",
    autoComplete: "new-password",
    maxLength: SECRET_MAX_LENGTH,
  },
  {
    key: "apikey",
    label: "Aircraft Spruce API key",
    type: "password",
    autoComplete: "off",
    maxLength: SECRET_MAX_LENGTH,
  },
] as const;
const DISCONNECT_QUESTION =
  "Disconnect Aircraft Spruce for this Flight Program? Saved purchase orders stay unchanged.";
const ORDER_COLUMNS = [
  "Order / PO",
  "Status / invoice",
  "Part",
  "Ordered",
  "Shipped",
  "Backordered",
  "Shipping / tracking",
];

type Credentials = Record<(typeof CREDENTIAL_FIELDS)[number]["key"], string> & {
  currency: string;
};
type OnSelect = (product: SpruceProduct, cents: number | undefined) => void;
type PickerProps = {
  initialSearch: string;
  currency: string;
  onSelect: OnSelect;
};
type Search = ReturnType<typeof useProductSearch>;
type SpruceAccount = ReturnType<typeof useSpruceAccount>;
type LinkProps = {
  programUuid: string;
  status?: SpruceStatus;
  disabled: boolean;
  onClose: () => void;
  onLinked: () => Promise<void>;
};

/**
 * The active program's Aircraft Spruce connection, shown in Settings →
 * Flight Program (an h3 under that section's h2) to its administrators.
 * Credentials go to the server, which keeps them out of offline data; linking,
 * refreshing and disconnecting need a connection and are refused in the demo.
 */
export function AircraftSpruceAccount() {
  const { snapshot: s } = useWorkspace();
  return s?.activeProgramUuid && programPermission(s, "admin") ? (
    <Account key={s.activeProgramUuid} programUuid={s.activeProgramUuid} />
  ) : null;
}

/**
 * Finds a part in the active program's downloaded Aircraft Spruce catalog for
 * a request or order line. Program administrators only; hidden in the demo.
 *
 * @param props.initialSearch - The search the picker opens with.
 * @param props.currency - The document's currency; a product priced in
 *   another one is chosen without its price.
 * @param props.onSelect - Receives the product the user verified and its net
 *   price in cents, or undefined when the currency differs or the price is
 *   unknown.
 */
export function SpruceProductPicker(props: PickerProps) {
  const { snapshot: s, demo } = useWorkspace();
  if (!s?.activeProgramUuid || !programPermission(s, "admin") || demo)
    return null;
  return (
    <ProductPicker
      key={s.activeProgramUuid}
      programUuid={s.activeProgramUuid}
      {...props}
    />
  );
}

/**
 * A purchase order's last synced Aircraft Spruce order lines, and a sync that
 * matches the PO number or a supplier order number. Arrivals still go through
 * Receive parts. Hidden in the demo.
 */
export function SpruceOrderProgress({ poUuid }: { poUuid: string }) {
  const { snapshot: s, demo } = useWorkspace();
  return s?.activeProgramUuid && !demo ? (
    <OrderProgress
      key={`${s.activeProgramUuid}:${poUuid}`}
      programUuid={s.activeProgramUuid}
      poUuid={poUuid}
    />
  ) : null;
}

function Account({ programUuid }: { programUuid: string }) {
  const { online, connected, demo } = useWorkspace();
  const account = useSpruceAccount(programUuid);
  const [editing, setEditing] = useState(false);
  const { status, notice } = account;
  const disabled = !online || !connected || demo || account.busy;
  return (
    <IntegrationRow
      name="Aircraft Spruce account"
      status={accountStatus(status)}
      summary={accountSummary(status)}
      action={
        <UpdateButton
          label="Update Aircraft Spruce account"
          disabled={disabled || !status}
          onClick={() => setEditing(true)}
        />
      }
    >
      <AccountNotes account={account} disabled={disabled} />
      <AccountFooter demo={demo} notice={notice} />
      {editing && (
        <LinkDialog
          programUuid={programUuid}
          account={account}
          disabled={disabled || !status}
          onClose={() => setEditing(false)}
        />
      )}
    </IntegrationRow>
  );
}

function LinkDialog({
  programUuid,
  account,
  disabled,
  onClose,
}: {
  programUuid: string;
  account: SpruceAccount;
  disabled: boolean;
  onClose: () => void;
}) {
  const linked = async () => {
    onClose();
    await account.reload();
    account.setNotice(
      "Account linked. Refresh the catalog to search products.",
    );
  };
  return (
    <Modal title="Update Aircraft Spruce account" onClose={onClose}>
      <LinkForm
        programUuid={programUuid}
        status={account.status}
        disabled={disabled}
        onClose={onClose}
        onLinked={linked}
      />
    </Modal>
  );
}

function AccountFooter({ demo, notice }: { demo: boolean; notice: string }) {
  return (
    <>
      {demo && <p className="set-hint">{DEMO_KEYS_UNAVAILABLE}</p>}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

// Each change reloads the status, then reports in the notice.
function useSpruceAccount(programUuid: string) {
  const { backend } = useWorkspace();
  const { status, setStatus, notice, setNotice } = useSpruceStatus(programUuid);
  const [busy, setBusy] = useState(false);
  const reload = async () =>
    setStatus(await backend!.spruceStatus(programUuid));
  async function run(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice("");
    try {
      await task();
      await reload();
      setNotice(message);
    } catch (e) {
      setNotice(errorText(e, "Aircraft Spruce request failed."));
    } finally {
      setBusy(false);
    }
  }
  const refresh = () =>
    void run(() => backend!.spruceRefresh(programUuid), "Catalog refreshed.");
  const disconnect = (version: number) => {
    if (window.confirm(DISCONNECT_QUESTION))
      void run(
        () => backend!.spruceDisconnect(programUuid, version),
        "Account disconnected.",
      );
  };
  return { status, notice, setNotice, busy, reload, refresh, disconnect };
}

function useSpruceStatus(programUuid: string) {
  const { backend, connected } = useWorkspace();
  const [status, setStatus] = useState<SpruceStatus>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .spruceStatus(programUuid)
        .then((x) => {
          if (active) setStatus(x);
        })
        .catch((e) => {
          if (active)
            setNotice(
              errorText(e, "Could not load Aircraft Spruce connection."),
            );
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid]);
  return { status, setStatus, notice, setNotice };
}

function accountStatus(status?: SpruceStatus): IntegrationStatus {
  if (!status) return { tone: "neutral", label: "Unknown" };
  return status.configured
    ? { tone: "good", label: "Linked" }
    : { tone: "warn", label: "Not linked" };
}

function accountSummary(status?: SpruceStatus) {
  if (!status?.configured) return "No account linked.";
  const linked = `Account linked · catalog currency ${status.currency}`;
  if (!status.catalogAt) return linked;
  const count = status.catalogCount?.toLocaleString();
  const at = new Date(status.catalogAt).toLocaleString();
  return `${linked} · ${count} products · refreshed ${at}`;
}

function AccountNotes({
  account,
  disabled,
}: {
  account: SpruceAccount;
  disabled: boolean;
}) {
  const { status } = account;
  return (
    <>
      <p className="set-hint">
        This connection belongs to the current Flight Program. Account
        credentials are stored on the server and are never included in offline
        data.
      </p>
      {status?.configured && !status.catalogAt && (
        <p>
          Catalog not downloaded yet. Choose Refresh Aircraft Spruce catalog
          before searching for parts.
        </p>
      )}
      {status?.configured && (
        <AccountActions account={account} disabled={disabled} />
      )}
    </>
  );
}

// Typed credentials live only while the form is open.
function LinkForm({
  programUuid,
  status,
  disabled,
  onClose,
  onLinked,
}: LinkProps) {
  const { backend } = useWorkspace();
  const [credentials, setCredentials] = useState<Credentials>({
    userid: "",
    password: "",
    apikey: "",
    currency: status?.currency ?? "",
  });
  const set = (field: keyof Credentials, value: string) =>
    setCredentials((c) => ({ ...c, [field]: value }));
  return (
    <AsyncForm
      submitLabel="Validate and link account"
      disabled={disabled}
      onClose={onClose}
      onSubmit={async () => {
        const version = status!.version;
        await backend!.spruceLink({ programUuid, version, ...credentials });
        await onLinked();
      }}
    >
      <CredentialFields credentials={credentials} onChange={set} />
      <p>
        Confirm the catalog currency with Aircraft Spruce. Their feed does not
        specify it. Replacing the account clears its catalog and hides previous
        account syncs.
      </p>
    </AsyncForm>
  );
}

function CredentialFields({
  credentials,
  onChange,
}: {
  credentials: Credentials;
  onChange: (field: keyof Credentials, value: string) => void;
}) {
  return (
    <>
      {CREDENTIAL_FIELDS.map(({ key, label, ...input }) => (
        <Field key={key} label={label}>
          <input
            required
            type={"type" in input ? input.type : undefined}
            autoComplete={input.autoComplete}
            maxLength={input.maxLength}
            value={credentials[key]}
            onChange={(e) => onChange(key, e.target.value)}
          />
        </Field>
      ))}
      <Field label="Confirmed account catalog currency">
        <select
          required
          value={credentials.currency}
          onChange={(e) => onChange("currency", e.target.value)}
        >
          <option value="">Select currency</option>
          <option value="USD">USD</option>
          <option value="CAD">CAD</option>
        </select>
      </Field>
    </>
  );
}

function AccountActions({
  account: a,
  disabled,
}: {
  account: SpruceAccount;
  disabled: boolean;
}) {
  return (
    <div className="management-actions">
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={a.refresh}
      >
        {a.busy ? "Working…" : "Refresh Aircraft Spruce catalog"}
      </button>
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={() => a.disconnect(a.status!.version)}
      >
        Disconnect account
      </button>
    </div>
  );
}

function ProductPicker({
  programUuid,
  initialSearch,
  currency,
  onSelect,
}: PickerProps & { programUuid: string }) {
  const { online, connected } = useWorkspace();
  const [open, setOpen] = useState(false);
  const search = useProductSearch(programUuid, initialSearch);
  const offline = !online || !connected;
  return (
    <div className="panel">
      <button
        type="button"
        className="button small"
        disabled={offline}
        onClick={() => setOpen(!open)}
      >
        Find at Aircraft Spruce
      </button>
      {open && (
        <PickerBody
          search={search}
          offline={offline}
          currency={currency}
          onUse={(product, cents) => {
            onSelect(product, cents);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function useProductSearch(programUuid: string, initialSearch: string) {
  const { backend } = useWorkspace();
  const [text, setText] = useState(initialSearch),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [results, setResults] = useState<SpruceProduct[]>([]),
    [chosen, setChosen] = useState<SpruceProduct>();
  const [confirmed, setConfirmed] = useState(false);
  const choose = (product?: SpruceProduct) => {
    setChosen(product);
    setConfirmed(false);
  };
  async function find() {
    setBusy(true);
    setError("");
    choose(undefined);
    try {
      const products = await backend!.spruceSearch(programUuid, text);
      setResults(products);
      if (!products.length) setError("No matching products.");
    } catch (e) {
      setError(
        errorText(
          e,
          "Search failed. Try again or check the connection under Vendors.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const state = { text, busy, error, results, chosen, confirmed };
  return { ...state, setText, choose, setConfirmed, find };
}

function PickerBody({
  search: q,
  offline,
  currency,
  onUse,
}: {
  search: Search;
  offline: boolean;
  currency: string;
  onUse: OnSelect;
}) {
  return (
    <>
      <p>
        Search this program's catalog.{" "}
        <Link to="/vendors">Link account / refresh catalog</Link>
      </p>
      <SearchControls search={q} offline={offline} />
      {q.error && <p role="status">{q.error}</p>}
      <ProductResults results={q.results} onChoose={q.choose} />
      {q.chosen && (
        <ChosenProduct
          product={q.chosen}
          confirmed={q.confirmed}
          currency={currency}
          onConfirm={q.setConfirmed}
          onUse={onUse}
        />
      )}
    </>
  );
}

function SearchControls({
  search: q,
  offline,
}: {
  search: Search;
  offline: boolean;
}) {
  return (
    <>
      <Field label="Aircraft Spruce part number or description">
        <input
          value={q.text}
          maxLength={SEARCH_MAX_LENGTH}
          onChange={(e) => q.setText(e.target.value)}
        />
      </Field>
      <button
        type="button"
        className="button"
        disabled={q.busy || offline || q.text.trim().length < SEARCH_MIN_LENGTH}
        onClick={() => void q.find()}
      >
        {q.busy ? "Searching…" : "Search supplier catalog"}
      </button>
    </>
  );
}

function ProductResults({
  results,
  onChoose,
}: {
  results: SpruceProduct[];
  onChoose: (product: SpruceProduct) => void;
}) {
  return (
    <>
      {results.length > 0 && (
        <p>
          {`Showing up to ${SEARCH_RESULT_LIMIT} matches. Supplier availability is separate from your inventory.`}
        </p>
      )}
      {results.map((p) => (
        <div key={p.partNumber}>
          <button
            type="button"
            className="text-button"
            onClick={() => onChoose(p)}
          >
            {p.partNumber} · {p.description}
          </button>
          <span>
            {" "}
            · {p.currency} {p.netPrice || "price unknown"} /{" "}
            {p.uom || "unit unknown"}
          </span>
        </div>
      ))}
    </>
  );
}

// The price is copied only in the document's own currency.
function ChosenProduct({
  product: p,
  confirmed,
  currency,
  onConfirm,
  onUse,
}: {
  product: SpruceProduct;
  confirmed: boolean;
  currency: string;
  onConfirm: (confirmed: boolean) => void;
  onUse: OnSelect;
}) {
  const sameCurrency = currency === p.currency;
  return (
    <section>
      <ProductDetails product={p} />
      <Field label="I verified the part match and that one supplier unit equals one inventory / order unit">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
        />
      </Field>
      {!sameCurrency && (
        <p>Currency differs from this document. Price will not be copied.</p>
      )}
      <button
        type="button"
        className="button"
        disabled={!confirmed}
        onClick={() =>
          onUse(p, sameCurrency ? priceCents(p.netPrice) : undefined)
        }
      >
        Use selected supplier part
      </button>
    </section>
  );
}

function ProductDetails({ product: p }: { product: SpruceProduct }) {
  const href = safeHref(p.url);
  return (
    <>
      <p>
        <strong>{p.partNumber}</strong> · catalog fetched{" "}
        {new Date(p.catalogAt).toLocaleString()}
      </p>
      <p>{availabilityText(p)}</p>
      {href && (
        <a href={href} target="_blank" rel="noreferrer">
          View supplier product
        </a>
      )}
    </>
  );
}

function availabilityText(p: SpruceProduct) {
  return p.availability
    .map(
      (a) =>
        `${a.location}: ${a.quantity || "unknown"}${a.due ? ` (due ${a.due})` : ""}`,
    )
    .join(" · ");
}

function OrderProgress({
  programUuid,
  poUuid,
}: {
  programUuid: string;
  poUuid: string;
}) {
  const { backend, online, connected } = useWorkspace();
  const orders = useSpruceOrders(programUuid, poUuid);
  return (
    <details className="panel">
      <summary>Aircraft Spruce order progress</summary>
      <p>
        Place the order with Aircraft Spruce and supply this PO's number. Sync
        matches that number exactly, or enter a specific supplier order number
        to link it manually.
      </p>
      <AsyncForm
        submitLabel="Sync Aircraft Spruce order"
        disabled={!online || !connected}
        onSubmit={async () => {
          await backend!.spruceSync(programUuid, poUuid, orders.order);
          orders.setSnapshot(await backend!.spruceOrders(programUuid, poUuid));
          orders.setError("");
        }}
      >
        <Field label="Aircraft Spruce order number (optional manual link)">
          <input
            value={orders.order}
            maxLength={ORDER_NUMBER_MAX_LENGTH}
            onChange={(e) => orders.setOrder(e.target.value)}
          />
        </Field>
      </AsyncForm>
      {orders.error && <p role="alert">{orders.error}</p>}
      {orders.snapshot && <OrderLines snapshot={orders.snapshot} />}
    </details>
  );
}

function useSpruceOrders(programUuid: string, poUuid: string) {
  const { backend, connected } = useWorkspace();
  const [snapshot, setSnapshot] = useState<SpruceOrderSnapshot | null>(null),
    [order, setOrder] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .spruceOrders(programUuid, poUuid)
        .then((x) => {
          if (!active) return;
          setSnapshot(x);
          setOrder(x?.order ?? "");
        })
        .catch((e) => {
          if (active)
            setError(errorText(e, "Could not load supplier progress."));
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid, poUuid]);
  return { snapshot, setSnapshot, order, setOrder, error, setError };
}

function OrderLines({ snapshot }: { snapshot: SpruceOrderSnapshot }) {
  return (
    <>
      <p>
        Supplier snapshot · {new Date(snapshot.fetchedAt).toLocaleString()}.
        Confirm arrivals with Receive parts to update inventory.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {ORDER_COLUMNS.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.map((r, i) => (
              <OrderLine key={i} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OrderLine({ row: r }: { row: SpruceOrderRow }) {
  return (
    <tr>
      <td>
        {r.ORN} / {r.PONO || "—"}
      </td>
      <td>
        {orderStatus(r.STATUS)} / {r.INVOICE || "—"}
      </td>
      <td>
        {r.PARTS}
        <br />
        {r.DESCS}
      </td>
      <td>{r.QOS || "—"}</td>
      <td>{r.QSS || "—"}</td>
      <td>{r.QBOS || "—"}</td>
      <td>
        {r.DATESHIP} {r.CARRIER}
        <br />
        {r.TRACKING || "—"}
      </td>
    </tr>
  );
}

// The order export's status codes: I is invoiced, D cancelled; any other code
// shows as sent.
function orderStatus(code: string | undefined) {
  if (code === "I") return "Invoiced";
  if (code === "D") return "Cancelled";
  return code || "Unknown";
}

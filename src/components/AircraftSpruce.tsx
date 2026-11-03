import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import {
  priceCents,
  type SpruceStatus,
  type SpruceProduct,
  type SpruceOrderSnapshot,
} from "../domain/aircraftSpruce";
import { AsyncForm, Field, safeHref } from "./ui";

function supplierError(error: unknown, fallback: string) {
  return error instanceof ConvexError && typeof error.data === "string"
    ? error.data
    : fallback;
}
/** The active program's Aircraft Spruce connection, shown in Settings →
 * Flight Program (h3 under that section's h2). */
export function AircraftSpruceAccount() {
  const { snapshot: s } = useWorkspace();
  return s?.activeProgramUuid && programPermission(s, "admin") ? (
    <Account key={s.activeProgramUuid} programUuid={s.activeProgramUuid} />
  ) : null;
}
function Account({ programUuid }: { programUuid: string }) {
  const { backend, online, connected, demo } = useWorkspace();
  const [status, setStatus] = useState<SpruceStatus>();
  const [editing, setEditing] = useState(false);
  const [userid, setUserid] = useState("");
  const [password, setPassword] = useState("");
  const [apikey, setApikey] = useState("");
  const [currency, setCurrency] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const disabled = !online || !connected || demo || busy;
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .spruceStatus(programUuid)
        .then((x) => {
          if (active) setStatus(x);
        })
        .catch(() => {
          if (active) setNotice("Could not load Aircraft Spruce connection.");
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid]);
  async function run(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNotice("");
    try {
      await task();
      setStatus(await backend!.spruceStatus(programUuid));
      setNotice(message);
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Aircraft Spruce request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h3>Aircraft Spruce account</h3>
      <p>
        This connection belongs to the current Flight Program. Account
        credentials are stored on the server and are never included in offline
        data.
      </p>
      <p>
        {status?.configured
          ? `Account linked · catalog currency ${status.currency}`
          : "No account linked."}
      </p>
      {status?.configured && !status.catalogAt && (
        <p>
          Catalog not downloaded yet. Choose Refresh Aircraft Spruce catalog
          before searching for parts.
        </p>
      )}
      {status?.catalogAt && (
        <p>
          {status.catalogCount?.toLocaleString()} products · refreshed{" "}
          {new Date(status.catalogAt).toLocaleString()}
        </p>
      )}
      {!editing && (
        <button
          type="button"
          className="button"
          disabled={disabled || !status}
          onClick={() => {
            setCurrency(status?.currency ?? "");
            setEditing(true);
          }}
        >
          {status?.configured
            ? "Replace Aircraft Spruce account"
            : "Link Aircraft Spruce account"}
        </button>
      )}
      {editing && (
        <AsyncForm
          submitLabel="Validate and link account"
          disabled={disabled || !status}
          onClose={() => {
            setEditing(false);
            setPassword("");
            setApikey("");
            setUserid("");
          }}
          onSubmit={async () => {
            await backend!.spruceLink({
              programUuid,
              version: status!.version,
              userid,
              password,
              apikey,
              currency,
            });
            setPassword("");
            setApikey("");
            setUserid("");
            setEditing(false);
            setStatus(await backend!.spruceStatus(programUuid));
            setNotice(
              "Account linked. Refresh the catalog to search products.",
            );
          }}
        >
          <Field label="Aircraft Spruce user ID">
            <input
              required
              autoComplete="username"
              maxLength={100}
              value={userid}
              onChange={(e) => setUserid(e.target.value)}
            />
          </Field>
          <Field label="Aircraft Spruce password">
            <input
              required
              type="password"
              autoComplete="new-password"
              maxLength={500}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Aircraft Spruce API key">
            <input
              required
              type="password"
              autoComplete="off"
              maxLength={500}
              value={apikey}
              onChange={(e) => setApikey(e.target.value)}
            />
          </Field>
          <Field label="Confirmed account catalog currency">
            <select
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">Select currency</option>
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
            </select>
          </Field>
          <p>
            Confirm the catalog currency with Aircraft Spruce. Their feed does
            not specify it. Replacing the account clears its catalog and hides
            previous account syncs.
          </p>
        </AsyncForm>
      )}
      {status?.configured && !editing && (
        <div className="management-actions">
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() =>
              void run(
                () => backend!.spruceRefresh(programUuid),
                "Catalog refreshed.",
              )
            }
          >
            {busy ? "Working…" : "Refresh Aircraft Spruce catalog"}
          </button>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  "Disconnect Aircraft Spruce for this Flight Program? Saved purchase orders stay unchanged.",
                )
              )
                void run(
                  () => backend!.spruceDisconnect(programUuid, status.version),
                  "Account disconnected.",
                );
            }}
          >
            Disconnect account
          </button>
        </div>
      )}
      {demo && (
        <p>
          Link accounts in the connected app. Demo mode does not store
          credentials.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function SpruceProductPicker(props: {
  initialSearch: string;
  currency: string;
  onSelect: (product: SpruceProduct, cents: number | undefined) => void;
}) {
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
function ProductPicker({
  programUuid,
  initialSearch,
  currency,
  onSelect,
}: {
  programUuid: string;
  initialSearch: string;
  currency: string;
  onSelect: (product: SpruceProduct, cents: number | undefined) => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(initialSearch),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [results, setResults] = useState<SpruceProduct[]>([]),
    [chosen, setChosen] = useState<SpruceProduct>();
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="panel">
      <button
        type="button"
        className="button small"
        disabled={!online || !connected}
        onClick={() => setOpen(!open)}
      >
        Find at Aircraft Spruce
      </button>
      {open && (
        <>
          <p>
            Search this program's catalog.{" "}
            <Link to="/vendors">Link account / refresh catalog</Link>
          </p>
          <Field label="Aircraft Spruce part number or description">
            <input
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="button"
            disabled={busy || !online || !connected || search.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              setError("");
              setChosen(undefined);
              setConfirmed(false);
              try {
                const products = await backend!.spruceSearch(
                  programUuid,
                  search,
                );
                setResults(products);
                if (!products.length) setError("No matching products.");
              } catch (e) {
                setError(
                  supplierError(
                    e,
                    "Search failed. Try again or check the connection under Vendors.",
                  ),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Searching…" : "Search supplier catalog"}
          </button>
          {error && <p role="status">{error}</p>}
          {results.length > 0 && (
            <p>
              Showing up to 30 matches. Supplier availability is separate from
              your inventory.
            </p>
          )}
          {results.map((p) => (
            <div key={p.partNumber}>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setChosen(p);
                  setConfirmed(false);
                }}
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
          {chosen && (
            <section>
              <p>
                <strong>{chosen.partNumber}</strong> · catalog fetched{" "}
                {new Date(chosen.catalogAt).toLocaleString()}
              </p>
              <p>
                {chosen.availability
                  .map(
                    (a) =>
                      `${a.location}: ${a.quantity || "unknown"}${a.due ? ` (due ${a.due})` : ""}`,
                  )
                  .join(" · ")}
              </p>
              {safeHref(chosen.url) && (
                <a href={safeHref(chosen.url)} target="_blank" rel="noreferrer">
                  View supplier product
                </a>
              )}
              <Field label="I verified the part match and that one supplier unit equals one inventory / order unit">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
              </Field>
              {currency !== chosen.currency && (
                <p>
                  Currency differs from this document. Price will not be copied.
                </p>
              )}
              <button
                type="button"
                className="button"
                disabled={!confirmed}
                onClick={() => {
                  onSelect(
                    chosen,
                    currency === chosen.currency
                      ? priceCents(chosen.netPrice)
                      : undefined,
                  );
                  setOpen(false);
                }}
              >
                Use selected supplier part
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
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
function OrderProgress({
  programUuid,
  poUuid,
}: {
  programUuid: string;
  poUuid: string;
}) {
  const { backend, online, connected } = useWorkspace();
  const [snapshot, setSnapshot] = useState<SpruceOrderSnapshot | null>(null),
    [order, setOrder] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .spruceOrders(programUuid, poUuid)
        .then((x) => {
          if (active) {
            setSnapshot(x);
            setOrder(x?.order ?? "");
          }
        })
        .catch(() => {
          if (active) setError("Could not load supplier progress.");
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid, poUuid]);
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
          await backend!.spruceSync(programUuid, poUuid, order);
          setSnapshot(await backend!.spruceOrders(programUuid, poUuid));
          setError("");
        }}
      >
        <Field label="Aircraft Spruce order number (optional manual link)">
          <input
            value={order}
            maxLength={100}
            onChange={(e) => setOrder(e.target.value)}
          />
        </Field>
      </AsyncForm>
      {error && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <p>
            Supplier snapshot · {new Date(snapshot.fetchedAt).toLocaleString()}.
            Confirm arrivals with Receive parts to update inventory.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "Order / PO",
                    "Status / invoice",
                    "Part",
                    "Ordered",
                    "Shipped",
                    "Backordered",
                    "Shipping / tracking",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.ORN} / {r.PONO || "—"}
                    </td>
                    <td>
                      {r.STATUS === "I"
                        ? "Invoiced"
                        : r.STATUS === "D"
                          ? "Cancelled"
                          : r.STATUS || "Unknown"}{" "}
                      / {r.INVOICE || "—"}
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
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}

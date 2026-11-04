/**
 * Responsibility: A Flight Program's saved addresses: the picker that fills an
 *   address field from them, and the Purchasing directory that edits them.
 * Layer: UI. React components; reads and writes through the workspace backend.
 * Dependencies: react, react-dom, @phosphor-icons/react, src/data/store.ts,
 *   src/domain/addresses.ts, src/domain/savedAddresses.ts (types),
 *   ./AddressFields.tsx, ./ShopList.tsx, ./design.tsx, ./ui.tsx.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import {
  addressIssues,
  blankAddress,
  formatAddress,
  type Address,
} from "../domain/addresses";
import type {
  AddressChoices,
  SavedAddress,
  SavedAddressInput,
} from "../domain/savedAddresses";
import { AddressFields } from "./AddressFields";
import { AsyncForm, Field, Modal, errorText } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { ShopLead, ShopTableCard } from "./ShopList";
import { MapPin, Plus, WarningCircle } from "@phosphor-icons/react";

function useAddressRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("saved-addresses-changed", refresh);
    return () => window.removeEventListener("saved-addresses-changed", refresh);
  }, []);
  return revision;
}
const emptyChoices: AddressChoices = { entries: [], locations: [] };
const LOAD_FAILED = "Could not load saved addresses.";
function fresh(name = "", address = blankAddress()): SavedAddressInput {
  return { uuid: crypto.randomUUID(), version: 0, name, address };
}
function AddressWindow({
  programUuid,
  initial,
  onSaved,
  onClose,
}: {
  programUuid: string;
  initial: SavedAddressInput;
  onSaved: (address: SavedAddress) => void;
  onClose: () => void;
}) {
  const { backend, connected, online } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal
        title={
          initial.version ? "Edit saved address" : "Add new shipping address"
        }
        onClose={onClose}
      >
        <AsyncForm
          submitLabel="Save address"
          disabled={!online || !connected}
          onClose={onClose}
          onSubmit={async () => {
            const issues = addressIssues(draft.address);
            if (issues.length) throw Error(issues.join(" "));
            const saved = await backend!.saveAddress(programUuid, draft);
            window.dispatchEvent(new Event("saved-addresses-changed"));
            onSaved(saved);
          }}
        >
          <Field label="Address name">
            <input
              required
              maxLength={200}
              value={draft.name}
              placeholder="e.g. Main hangar or Miami forwarding"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <AddressFields
            label="Shipping address"
            value={draft.address}
            onChange={(address) => setDraft({ ...draft, address })}
          />
          <p>
            Include the recipient's name in Contact name. Saving confirms these
            details and makes this address available to this Flight Program's
            users.
          </p>
        </AsyncForm>
      </Modal>
    </div>,
    document.body,
  );
}
export function SavedAddressPicker(props: {
  label: string;
  value?: Address;
  legacy?: string;
  inventoryLocationName?: string;
  onChange: (address: Address) => void;
}) {
  const { snapshot: s } = useWorkspace();
  return s?.activeProgramUuid ? (
    <AddressPicker
      key={`${s.activeProgramUuid}:${props.inventoryLocationName ?? ""}`}
      programUuid={s.activeProgramUuid}
      {...props}
    />
  ) : (
    <p>Select a Flight Program to choose an address.</p>
  );
}
function AddressPicker({
  programUuid,
  label,
  value,
  legacy = "",
  inventoryLocationName,
  onChange,
}: {
  programUuid: string;
  label: string;
  value?: Address;
  legacy?: string;
  inventoryLocationName?: string;
  onChange: (address: Address) => void;
}) {
  const { backend, connected, online } = useWorkspace();
  const revision = useAddressRevision();
  const [loaded, setLoaded] = useState(false);
  const [choices, setChoices] = useState<AddressChoices>(emptyChoices);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<SavedAddressInput>();
  const [mode, setMode] = useState(inventoryLocationName ? "" : "saved");
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .addressChoices(programUuid)
        .then((c) => {
          if (active) {
            setChoices(c);
            setLoaded(true);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e, LOAD_FAILED));
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid, revision]);
  const location = choices.locations.find(
    (l) => l.name === inventoryLocationName,
  );
  const matched =
    value &&
    choices.entries.find(
      (e) =>
        e.address.addressName === value.addressName &&
        formatAddress(e.address) === formatAddress(value) &&
        e.address.confirmed === value.confirmed,
    );
  const hasCurrent = !!((value && formatAddress(value)) || legacy);
  function inventoryAddress() {
    if (!location) {
      setError(
        "This inventory location's address is unavailable. Choose a saved address or add one.",
      );
      return;
    }
    const address = {
      ...(location.address ?? blankAddress(location.legacy)),
      addressName: location.name,
    };
    if (addressIssues(address).length) {
      setEdit(fresh(location.name, address));
      return;
    }
    onChange({ ...address, confirmed: true });
    setError("");
  }
  return (
    <section className="panel">
      <strong>{label}</strong>
      {inventoryLocationName && (
        <Field label={`${label} — Use inventory location address?`}>
          <select
            disabled={!online || !connected || !loaded}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              if (e.target.value === "inventory") inventoryAddress();
              else if (e.target.value === "saved") onChange(blankAddress());
            }}
          >
            <option value="">Choose address source</option>
            <option value="inventory">Yes — use {inventoryLocationName}</option>
            <option value="saved">No — choose a saved address</option>
          </select>
        </Field>
      )}
      <Field label={`${label} — Saved address`}>
        <select
          disabled={!online || !connected}
          value={matched?.uuid ?? (hasCurrent ? "__current" : "")}
          onChange={(e) => {
            if (e.target.value === "__new") {
              setEdit(fresh());
              return;
            }
            const chosen = choices.entries.find(
              (x) => x.uuid === e.target.value,
            );
            if (chosen) {
              setMode("saved");
              onChange(structuredClone(chosen.address));
            } else if (!e.target.value) {
              setMode("saved");
              onChange(blankAddress());
            }
          }}
        >
          <option value="">Select saved address</option>
          {hasCurrent && !matched && (
            <option value="__current">
              {value?.addressName ||
                value?.contactName ||
                value?.organization ||
                "Current document address"}{" "}
              (saved on this document)
            </option>
          )}
          {choices.entries.map((e) => (
            <option key={e.uuid} value={e.uuid}>
              {e.name} — {e.address.contactName}
            </option>
          ))}
          <option value="__new">+ Add new address</option>
        </select>
      </Field>
      <button
        type="button"
        className="button small"
        disabled={!online || !connected}
        onClick={() => setEdit(fresh())}
      >
        Add new address
      </button>
      {hasCurrent && (
        <button
          type="button"
          className="button small"
          disabled={!online || !connected}
          onClick={() =>
            setEdit(
              matched ??
                fresh(value?.addressName ?? "", value ?? blankAddress(legacy)),
            )
          }
        >
          Review selected address
        </button>
      )}
      {value && hasCurrent && !value.confirmed && (
        <p>Review and save this address to confirm it before issuing the PO.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {edit && (
        <AddressWindow
          programUuid={programUuid}
          initial={edit}
          onClose={() => setEdit(undefined)}
          onSaved={(saved) => {
            setChoices((c) => ({
              ...c,
              entries: [
                ...c.entries.filter((e) => e.uuid !== saved.uuid),
                saved,
              ].sort((a, b) => a.name.localeCompare(b.name)),
            }));
            setMode("saved");
            onChange(structuredClone(saved.address));
            setEdit(undefined);
            setError("");
          }}
        />
      )}
    </section>
  );
}
export function SavedAddresses() {
  const { snapshot: s } = useWorkspace();
  return s?.activeProgramUuid ? (
    <Directory key={s.activeProgramUuid} programUuid={s.activeProgramUuid} />
  ) : (
    <>
      <PageHeader eyebrow="PURCHASING" title="Saved addresses" />
      <EmptyState title="No Flight Program selected">
        Select a Flight Program to manage saved addresses.
      </EmptyState>
    </>
  );
}
function Directory({ programUuid }: { programUuid: string }) {
  const revision = useAddressRevision();
  const { backend, online, connected } = useWorkspace();
  const [entries, setEntries] = useState<SavedAddress[]>([]),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [edit, setEdit] = useState<SavedAddressInput>();
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .addressChoices(programUuid)
        .then((c) => {
          if (active) setEntries(c.entries);
        })
        .catch((e) => {
          if (active) setError(errorText(e, LOAD_FAILED));
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid, revision]);
  const shown = entries.filter((e) =>
    `${e.name} ${e.address.contactName} ${e.address.city}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="PURCHASING"
        title="Saved addresses"
        description="Ship-to, return and billing addresses for requests and purchase orders, shared only with this Flight Program's users."
        actions={
          <button
            className="button primary"
            disabled={!online || !connected}
            onClick={() => setEdit(fresh())}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            Add new address
          </button>
        }
      />
      <Toolbar className="shop-toolbar">
        <SearchField
          label="Search saved addresses"
          placeholder="Name, recipient or city"
          value={search}
          onChange={setSearch}
        />
      </Toolbar>
      {error && (
        <NoticeBar tone="danger" icon={WarningCircle} role="alert">
          {error}
        </NoticeBar>
      )}
      {shown.length ? (
        <ShopTableCard label="Saved addresses" className="shop-list-look" stack>
          <table className="shop-table">
            <thead>
              <tr>
                <th>Address name</th>
                <th>Recipient</th>
                <th>City / country</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.uuid}>
                  <td className="shop-lead-cell shop-wide">
                    <ShopLead
                      icon={MapPin}
                      tone={e.address.confirmed ? "blue" : "warn"}
                      title={e.name}
                      sub={
                        [
                          e.address.organization,
                          e.address.street,
                          e.address.street2,
                        ]
                          .filter(Boolean)
                          .join(", ") || "No street address"
                      }
                    />
                  </td>
                  <td data-label="Recipient">
                    {e.address.contactName || (
                      <span className="shop-zero">No recipient</span>
                    )}
                  </td>
                  <td data-label="City / country">
                    <span className="ds-list-meta">
                      {e.address.city}, {e.address.country}
                    </span>
                  </td>
                  <td className="shop-actions-cell">
                    <span className="shop-actions">
                      {!e.address.confirmed && (
                        <StatusPill tone="warn">Not confirmed</StatusPill>
                      )}
                      <button
                        className="button small"
                        disabled={!online || !connected}
                        onClick={() => setEdit(e)}
                      >
                        Edit address
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ShopTableCard>
      ) : (
        <EmptyState
          title={
            entries.length ? "No addresses match" : "No saved addresses yet"
          }
        >
          {entries.length
            ? "No saved address matches the search."
            : "Add one here or from a request or PO."}
        </EmptyState>
      )}
      {edit && (
        <AddressWindow
          programUuid={programUuid}
          initial={edit}
          onClose={() => setEdit(undefined)}
          onSaved={(saved) => {
            setEntries((old) =>
              [...old.filter((e) => e.uuid !== saved.uuid), saved].sort(
                (a, b) => a.name.localeCompare(b.name),
              ),
            );
            setEdit(undefined);
          }}
        />
      )}
    </>
  );
}

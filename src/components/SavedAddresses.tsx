/**
 * Responsibility: A Flight Program's saved addresses: the picker that fills an
 *   address field from them, and the Purchasing directory that edits them.
 * Layer: UI. React components; reads and writes through the workspace backend.
 * Dependencies: react, react-dom, @phosphor-icons/react, src/data/store.ts,
 *   src/data/backend.ts (types), src/domain/addresses.ts,
 *   src/domain/savedAddresses.ts (types), ./AddressFields.tsx, ./ShopList.tsx,
 *   ./design.tsx, ./ui.tsx.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
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

// Sent after every save, so each open picker and directory reloads.
const ADDRESSES_CHANGED = "saved-addresses-changed";
const LOAD_FAILED = "Could not load saved addresses.";
// Saved-address choices that are not a saved entry.
const CURRENT_CHOICE = "__current";
const NEW_CHOICE = "__new";
// The limit savedAddressInput sets.
const NAME_MAX_LENGTH = 200;
const EMPTY_CHOICES: AddressChoices = { entries: [], locations: [] };

type PickerProps = {
  label: string;
  value?: Address;
  legacy?: string;
  inventoryLocationName?: string;
  onChange: (address: Address) => void;
};
type Picker = ReturnType<typeof usePicker>;
type PickerView = ReturnType<typeof pickerView>;
type PartProps = { p: Picker; view: PickerView };
type RowProps = { entry: SavedAddress; offline: boolean; onEdit: () => void };

/**
 * An address field filled from the active Flight Program's saved addresses
 * or, with `inventoryLocationName`, from that location's address. A new or
 * reviewed address is saved to the program, which confirms it, before it is
 * used. Choosing or saving needs a connection.
 *
 * @param props.value - The document's address; `legacy` is its text from
 *   before addresses were structured.
 * @param props.onChange - Receives the chosen address, or a blank one when
 *   the choice is cleared.
 */
export function SavedAddressPicker(props: PickerProps) {
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

/**
 * The Purchasing page of the active Flight Program's saved addresses: search
 * by name, recipient or city, and add or edit an address. Unconfirmed
 * addresses are marked; editing needs a connection.
 */
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

function useAddressRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(ADDRESSES_CHANGED, refresh);
    return () => window.removeEventListener(ADDRESSES_CHANGED, refresh);
  }, []);
  return revision;
}

function newSavedAddress(name = "", address = blankAddress()) {
  const input: SavedAddressInput = {
    uuid: crypto.randomUUID(),
    version: 0,
    name,
    address,
  };
  return input;
}

function withSaved<T extends { uuid: string; name: string }>(
  entries: T[],
  saved: T,
) {
  return [...entries.filter((e) => e.uuid !== saved.uuid), saved].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// The address's own issues refuse it before anything is sent.
async function saveChecked(
  backend: Backend,
  programUuid: string,
  draft: SavedAddressInput,
) {
  const issues = addressIssues(draft.address);
  if (issues.length) throw Error(issues.join(" "));
  const saved = await backend.saveAddress(programUuid, draft);
  window.dispatchEvent(new Event(ADDRESSES_CHANGED));
  return saved;
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
  // The portal keeps React's event bubbling: stop this form's submit from
  // also submitting the request or PO form the picker sits in.
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
          onSubmit={async () =>
            onSaved(await saveChecked(backend!, programUuid, draft))
          }
        >
          <DraftFields draft={draft} onDraft={setDraft} />
        </AsyncForm>
      </Modal>
    </div>,
    document.body,
  );
}

function DraftFields({
  draft,
  onDraft,
}: {
  draft: SavedAddressInput;
  onDraft: (draft: SavedAddressInput) => void;
}) {
  return (
    <>
      <Field label="Address name">
        <input
          required
          maxLength={NAME_MAX_LENGTH}
          value={draft.name}
          placeholder="e.g. Main hangar or Miami forwarding"
          onChange={(e) => onDraft({ ...draft, name: e.target.value })}
        />
      </Field>
      <AddressFields
        label="Shipping address"
        value={draft.address}
        onChange={(address) => onDraft({ ...draft, address })}
      />
      <p>
        Include the recipient's name in Contact name. Saving confirms these
        details and makes this address available to this Flight Program's users.
      </p>
    </>
  );
}

function AddressPicker(props: PickerProps & { programUuid: string }) {
  const { connected, online } = useWorkspace();
  const { programUuid, inventoryLocationName, onChange } = props;
  const p = usePicker(programUuid, inventoryLocationName, onChange);
  const view = pickerView(p.choices, props, !online || !connected);
  return (
    <section className="panel">
      <strong>{props.label}</strong>
      {inventoryLocationName && <SourceField p={p} view={view} />}
      <SavedField p={p} view={view} />
      <PickerButtons p={p} view={view} />
      {view.unconfirmed && (
        <p>Review and save this address to confirm it before issuing the PO.</p>
      )}
      {p.error && <p role="alert">{p.error}</p>}
      {p.edit && (
        <AddressWindow
          programUuid={programUuid}
          initial={p.edit}
          onClose={() => p.setEdit(undefined)}
          onSaved={(saved) => applySaved(p, saved)}
        />
      )}
    </section>
  );
}

function usePicker(
  programUuid: string,
  inventoryLocationName: string | undefined,
  onChange: (address: Address) => void,
) {
  const loaded = usePickerChoices(programUuid);
  const [edit, setEdit] = useState<SavedAddressInput>();
  const [mode, setMode] = useState(inventoryLocationName ? "" : "saved");
  const location = loaded.choices.locations.find(
    (l) => l.name === inventoryLocationName,
  );
  return { ...loaded, edit, setEdit, mode, setMode, location, onChange };
}

function usePickerChoices(programUuid: string) {
  const { backend, connected } = useWorkspace();
  const revision = useAddressRevision();
  const [loaded, setLoaded] = useState(false);
  const [choices, setChoices] = useState<AddressChoices>(EMPTY_CHOICES);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (backend && connected)
      void backend
        .addressChoices(programUuid)
        .then((c) => {
          if (!active) return;
          setChoices(c);
          setLoaded(true);
          setError("");
        })
        .catch((e) => {
          if (active) setError(errorText(e, LOAD_FAILED));
        });
    return () => {
      active = false;
    };
  }, [backend, connected, programUuid, revision]);
  return { choices, setChoices, loaded, error, setError };
}

// A document's address matches an entry by name, text and confirmation.
function pickerView(
  choices: AddressChoices,
  props: PickerProps,
  offline: boolean,
) {
  const { value } = props;
  const legacy = props.legacy ?? "";
  const matched =
    value &&
    choices.entries.find(
      (e) =>
        e.address.addressName === value.addressName &&
        formatAddress(e.address) === formatAddress(value) &&
        e.address.confirmed === value.confirmed,
    );
  const hasCurrent = !!((value && formatAddress(value)) || legacy);
  const unconfirmed = !!value && hasCurrent && !value.confirmed;
  return { ...props, legacy, matched, hasCurrent, unconfirmed, offline };
}

function chooseSource(p: Picker, mode: string) {
  p.setMode(mode);
  if (mode === "inventory") applyInventoryAddress(p);
  else if (mode === "saved") p.onChange(blankAddress());
}

// An inventory address with issues opens for review instead of being used.
function applyInventoryAddress(p: Picker) {
  if (!p.location) {
    p.setError(
      "This inventory location's address is unavailable. Choose a saved address or add one.",
    );
    return;
  }
  const address = {
    ...(p.location.address ?? blankAddress(p.location.legacy)),
    addressName: p.location.name,
  };
  if (addressIssues(address).length) {
    p.setEdit(newSavedAddress(p.location.name, address));
    return;
  }
  p.onChange({ ...address, confirmed: true });
  p.setError("");
}

// The document's own address stays chosen until another one is picked.
function chooseSaved(p: Picker, choice: string) {
  if (choice === NEW_CHOICE) {
    p.setEdit(newSavedAddress());
    return;
  }
  const chosen = p.choices.entries.find((x) => x.uuid === choice);
  if (chosen) {
    p.setMode("saved");
    p.onChange(structuredClone(chosen.address));
  } else if (!choice) {
    p.setMode("saved");
    p.onChange(blankAddress());
  }
}

function applySaved(p: Picker, saved: SavedAddress) {
  p.setChoices((c) => ({ ...c, entries: withSaved(c.entries, saved) }));
  p.setMode("saved");
  p.onChange(structuredClone(saved.address));
  p.setEdit(undefined);
  p.setError("");
}

function SourceField({ p, view }: PartProps) {
  return (
    <Field label={`${view.label} — Use inventory location address?`}>
      <select
        disabled={view.offline || !p.loaded}
        value={p.mode}
        onChange={(e) => chooseSource(p, e.target.value)}
      >
        <option value="">Choose address source</option>
        <option value="inventory">
          Yes — use {view.inventoryLocationName}
        </option>
        <option value="saved">No — choose a saved address</option>
      </select>
    </Field>
  );
}

function SavedField({ p, view }: PartProps) {
  const { value, matched, hasCurrent } = view;
  return (
    <Field label={`${view.label} — Saved address`}>
      <select
        disabled={view.offline}
        value={matched?.uuid ?? (hasCurrent ? CURRENT_CHOICE : "")}
        onChange={(e) => chooseSaved(p, e.target.value)}
      >
        <option value="">Select saved address</option>
        {hasCurrent && !matched && (
          <option value={CURRENT_CHOICE}>
            {value?.addressName ||
              value?.contactName ||
              value?.organization ||
              "Current document address"}{" "}
            (saved on this document)
          </option>
        )}
        {p.choices.entries.map((e) => (
          <option key={e.uuid} value={e.uuid}>
            {e.name} — {e.address.contactName}
          </option>
        ))}
        <option value={NEW_CHOICE}>+ Add new address</option>
      </select>
    </Field>
  );
}

function PickerButtons({ p, view }: PartProps) {
  const { value, matched, legacy } = view;
  return (
    <>
      <button
        type="button"
        className="button small"
        disabled={view.offline}
        onClick={() => p.setEdit(newSavedAddress())}
      >
        Add new address
      </button>
      {view.hasCurrent && (
        <button
          type="button"
          className="button small"
          disabled={view.offline}
          onClick={() =>
            p.setEdit(
              matched ??
                newSavedAddress(
                  value?.addressName ?? "",
                  value ?? blankAddress(legacy),
                ),
            )
          }
        >
          Review selected address
        </button>
      )}
    </>
  );
}

function Directory({ programUuid }: { programUuid: string }) {
  const { online, connected } = useWorkspace();
  const { entries, setEntries, error } = useDirectoryEntries(programUuid);
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<SavedAddressInput>();
  const offline = !online || !connected;
  const shown = entries.filter((e) => matchesSearch(e, search));
  return (
    <>
      <DirectoryHeader
        offline={offline}
        onAdd={() => setEdit(newSavedAddress())}
        search={search}
        onSearch={setSearch}
      />
      {error && (
        <NoticeBar tone="danger" icon={WarningCircle} role="alert">
          {error}
        </NoticeBar>
      )}
      <AddressTable
        shown={shown}
        any={entries.length > 0}
        offline={offline}
        onEdit={setEdit}
      />
      {edit && (
        <AddressWindow
          programUuid={programUuid}
          initial={edit}
          onClose={() => setEdit(undefined)}
          onSaved={(saved) => {
            setEntries((old) => withSaved(old, saved));
            setEdit(undefined);
          }}
        />
      )}
    </>
  );
}

// Unlike the picker, a later successful load keeps an earlier load error.
function useDirectoryEntries(programUuid: string) {
  const revision = useAddressRevision();
  const { backend, connected } = useWorkspace();
  const [entries, setEntries] = useState<SavedAddress[]>([]);
  const [error, setError] = useState("");
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
  return { entries, setEntries, error };
}

function matchesSearch(e: SavedAddress, search: string) {
  return `${e.name} ${e.address.contactName} ${e.address.city}`
    .toLowerCase()
    .includes(search.toLowerCase());
}

function DirectoryHeader({
  offline,
  onAdd,
  search,
  onSearch,
}: {
  offline: boolean;
  onAdd: () => void;
  search: string;
  onSearch: (search: string) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="PURCHASING"
        title="Saved addresses"
        description="Ship-to, return and billing addresses for requests and purchase orders, shared only with this Flight Program's users."
        actions={
          <button className="button primary" disabled={offline} onClick={onAdd}>
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
          onChange={onSearch}
        />
      </Toolbar>
    </>
  );
}

function AddressTable({
  shown,
  any,
  offline,
  onEdit,
}: {
  shown: SavedAddress[];
  any: boolean;
  offline: boolean;
  onEdit: (entry: SavedAddress) => void;
}) {
  if (!shown.length) return <NoAddresses any={any} />;
  return (
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
            <AddressRow
              key={e.uuid}
              entry={e}
              offline={offline}
              onEdit={() => onEdit(e)}
            />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

function NoAddresses({ any }: { any: boolean }) {
  return (
    <EmptyState title={any ? "No addresses match" : "No saved addresses yet"}>
      {any
        ? "No saved address matches the search."
        : "Add one here or from a request or PO."}
    </EmptyState>
  );
}

function AddressRow({ entry: e, offline, onEdit }: RowProps) {
  const { organization, street, street2 } = e.address;
  return (
    <tr>
      <td className="shop-lead-cell shop-wide">
        <ShopLead
          icon={MapPin}
          tone={e.address.confirmed ? "blue" : "warn"}
          title={e.name}
          sub={
            [organization, street, street2].filter(Boolean).join(", ") ||
            "No street address"
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
          <button className="button small" disabled={offline} onClick={onEdit}>
            Edit address
          </button>
        </span>
      </td>
    </tr>
  );
}

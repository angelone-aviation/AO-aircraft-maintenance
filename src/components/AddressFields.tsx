/**
 * Responsibility: Structured address fields that a person checks and
 *   confirms, with a lookup that suggests matching addresses.
 * Layer: UI. Lookups go through the workspace backend; the address goes back
 *   through `onChange` or a hidden form input.
 * Dependencies: react, src/data/store.ts (useWorkspace),
 *   src/domain/addressLookup.ts, src/domain/addresses.ts, src/components/ui.tsx.
 */
import { useState, type CSSProperties } from "react";
import { useWorkspace } from "../data/store";
import { lookupInput, type AddressSuggestion } from "../domain/addressLookup";
import {
  blankAddress,
  addressIssues,
  formatAddress,
  type Address,
} from "../domain/addresses";
import { Field, errorText } from "./ui";

// In form order. Each field's label is the fieldset's label, a dash, then this.
const ADDRESS_INPUTS = [
  ["organization", "Company / organization"],
  ["street", "Street address"],
  ["street2", "Apartment / suite / building"],
  ["city", "City"],
  ["region", "State / province"],
  ["postalCode", "ZIP / postal code"],
  ["country", "Country"],
  ["contactName", "Contact name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;
const INPUT_TYPES: Partial<Record<AddressInputKey, string>> = {
  email: "email",
  phone: "tel",
};

// Geoapify result types precise enough to stand for a whole street address;
// a street-, city- or postcode-level match is not.
const USABLE_MATCH_LEVELS = ["building", "amenity"];

const FIELDSET_STYLE: CSSProperties = {
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: 8,
  margin: "12px 0",
  minWidth: 0,
};

type AddressInputKey = (typeof ADDRESS_INPUTS)[number][0];
type AddressLookup = ReturnType<typeof useAddressLookup>;
type AddressFieldsProps = {
  label: string;
  value?: Address;
  legacy?: string;
  contactName?: string;
  email?: string;
  onChange?: (address: Address) => void;
  name?: string;
};

/**
 * Address fields that a person fills in, may look up, then checks and
 * confirms. Any edit or suggestion clears the confirmation.
 *
 * @param props.label - Names the fieldset and starts each field's label.
 * @param props.value - The address; when omitted, a blank one with `legacy`
 *   as its street (plus a note to split it) and the contact given.
 * @param props.onChange - Makes the fields controlled. Without it they keep
 *   their own address, starting from `value`.
 * @param props.name - Submits the address as JSON in a hidden input.
 * @returns The fieldset, disabled while a lookup runs.
 */
export function AddressFields(props: AddressFieldsProps) {
  const { label, value, legacy = "", name } = props;
  const { address, lookup, ...form } = useAddressForm(props);
  return (
    <fieldset
      disabled={lookup.busy}
      className="address-fields"
      style={FIELDSET_STYLE}
    >
      <legend>
        <strong>{label}</strong>
      </legend>
      {!value && legacy && (
        <p className="muted">
          Existing address retained below. Separate its city, state/province and
          postal code before confirming.
        </p>
      )}
      {name && (
        <input type="hidden" name={name} value={JSON.stringify(address)} />
      )}
      <AddressInputs label={label} address={address} onEdit={form.edit} />
      <AddressLookupPanel
        lookup={lookup}
        address={address}
        onUse={form.update}
      />
      <AddressConfirmation
        address={address}
        issues={form.issues}
        onConfirm={form.confirm}
      />
    </fieldset>
  );
}

function useAddressForm({
  value,
  legacy = "",
  contactName = "",
  email = "",
  onChange,
}: AddressFieldsProps) {
  const lookup = useAddressLookup();
  const [issues, setIssues] = useState<string[]>([]);
  const [local, setLocal] = useState(
    () => value ?? blankAddress(legacy, contactName, email),
  );
  const address = onChange
    ? (value ?? blankAddress(legacy, contactName, email))
    : local;
  const update = (next: Address) => {
    lookup.clear();
    setLocal(next);
    onChange?.(next);
  };
  const edit = (key: AddressInputKey, text: string) => {
    setIssues([]);
    update({ ...address, [key]: text, confirmed: false });
  };
  const confirm = () => {
    const errors = addressIssues(address);
    setIssues(errors);
    update({ ...address, confirmed: errors.length === 0 });
  };
  return { address, lookup, issues, update, edit, confirm };
}

function useAddressLookup() {
  const { backend, online, connected } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [notice, setNotice] = useState("");
  const clear = () => {
    setSuggestions([]);
    setNotice("");
  };
  async function run(address: Address) {
    setBusy(true);
    clear();
    try {
      const found = await backend!.lookupAddress(lookupInput(address));
      setSuggestions(found);
      setNotice(
        found.length
          ? "Review suggested matches. Street-only or city-only matches do not verify the full address."
          : "No matching address found. Check the details or confirm manually.",
      );
    } catch (error) {
      setNotice(errorText(error, "Address lookup failed."));
    } finally {
      setBusy(false);
    }
  }
  const available = online && connected;
  return { busy, suggestions, notice, available, clear, run };
}

function AddressInputs({
  label,
  address,
  onEdit,
}: {
  label: string;
  address: Address;
  onEdit: (key: AddressInputKey, text: string) => void;
}) {
  return (
    <>
      <div className="form-grid">
        {ADDRESS_INPUTS.map(([key, title]) => (
          <Field key={key} label={`${label} — ${title}`}>
            <input
              value={address[key]}
              type={INPUT_TYPES[key] ?? "text"}
              onChange={(e) => onEdit(key, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <details>
        <summary>Address preview</summary>
        <p style={{ whiteSpace: "pre-line" }}>
          {formatAddress(address) || "Enter an address."}
        </p>
      </details>
    </>
  );
}

function AddressLookupPanel({
  lookup,
  address,
  onUse,
}: {
  lookup: AddressLookup;
  address: Address;
  onUse: (address: Address) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={!lookup.available}
        onClick={() => lookup.run(address)}
      >
        {lookup.busy ? "Looking up address…" : "Look up address"}
      </button>
      {lookup.notice && <p role="status">{lookup.notice}</p>}
      {lookup.suggestions.map((candidate, index) => (
        <SuggestionCard
          key={index}
          candidate={candidate}
          onUse={() => onUse(applySuggestion(address, candidate))}
        />
      ))}
      <LookupCredit />
    </>
  );
}

function SuggestionCard({
  candidate,
  onUse,
}: {
  candidate: AddressSuggestion;
  onUse: () => void;
}) {
  return (
    <div className="notice">
      <p>
        {candidate.formatted}
        <br />
        {candidate.matchLevel} match · Confidence{" "}
        {Math.round(candidate.confidence * 100)}%
      </p>
      <button
        type="button"
        className="button small"
        disabled={!isUsable(candidate)}
        onClick={onUse}
      >
        Use suggested address
      </button>
      <small className="block">{candidate.attribution}</small>
    </div>
  );
}

function LookupCredit() {
  return (
    <p className="muted">
      <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">
        Powered by Geoapify
      </a>{" "}
      ·{" "}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap contributors
      </a>
      . Only the street, city, state/province, postal code and country are sent
      for lookup. Contact details stay in this app.
    </p>
  );
}

function AddressConfirmation({
  address,
  issues,
  onConfirm,
}: {
  address: Address;
  issues: string[];
  onConfirm: () => void;
}) {
  return (
    <>
      <button type="button" className="button small" onClick={onConfirm}>
        Check & confirm address
      </button>
      {issues.length > 0 && (
        <ul role="alert" className="error">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <p className="muted" role="status">
        {address.confirmed
          ? "Confirmed by you. Required fields and formats checked; deliverability has not been verified."
          : "Review the full address and contact information before confirming."}
      </p>
    </>
  );
}

function applySuggestion(
  address: Address,
  candidate: AddressSuggestion,
): Address {
  return {
    ...address,
    street: candidate.street,
    city: candidate.city,
    region: candidate.region,
    postalCode: candidate.postalCode,
    country: candidate.country,
    confirmed: false,
  };
}

function isUsable(candidate: AddressSuggestion): boolean {
  return (
    !!candidate.street &&
    !!candidate.city &&
    USABLE_MATCH_LEVELS.includes(candidate.matchLevel)
  );
}

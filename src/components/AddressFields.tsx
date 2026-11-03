import { useWorkspace } from "../data/store";
import { lookupInput, type AddressSuggestion } from "../domain/addressLookup";
import { useState } from "react";
import {
  blankAddress,
  addressIssues,
  formatAddress,
  type Address,
} from "../domain/addresses";
import { Field } from "./ui";
export function AddressFields({
  label,
  value,
  legacy = "",
  contactName = "",
  email = "",
  onChange,
  name,
}: {
  label: string;
  value?: Address;
  legacy?: string;
  contactName?: string;
  email?: string;
  onChange?: (address: Address) => void;
  name?: string;
}) {
  const { backend, online, connected } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [lookupNotice, setLookupNotice] = useState("");
  const [local, setLocal] = useState(
    () => value ?? blankAddress(legacy, contactName, email),
  );
  const [issues, setIssues] = useState<string[]>([]);
  const address = onChange
    ? (value ?? blankAddress(legacy, contactName, email))
    : local;
  const update = (next: Address) => {
    setSuggestions([]);
    setLookupNotice("");
    setLocal(next);
    onChange?.(next);
  };
  return (
    <fieldset
      disabled={busy}
      className="address-fields"
      style={{
        padding: 14,
        border: "1px solid var(--border)",
        borderRadius: 8,
        margin: "12px 0",
        minWidth: 0,
      }}
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
      <div className="form-grid">
        {(
          [
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
          ] as const
        ).map(([key, title]) => (
          <Field key={key} label={`${label} — ${title}`}>
            <input
              value={address[key]}
              type={
                key === "email" ? "email" : key === "phone" ? "tel" : "text"
              }
              onChange={(e) => {
                setIssues([]);
                update({ ...address, [key]: e.target.value, confirmed: false });
              }}
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
      <button
        type="button"
        className="button"
        disabled={!online || !connected}
        onClick={async () => {
          setBusy(true);
          setSuggestions([]);
          setLookupNotice("");
          try {
            const found = await backend!.lookupAddress(lookupInput(address));
            setSuggestions(found);
            setLookupNotice(
              found.length
                ? "Review suggested matches. Street-only or city-only matches do not verify the full address."
                : "No matching address found. Check the details or confirm manually.",
            );
          } catch (error) {
            setLookupNotice(
              error instanceof Error ? error.message : "Address lookup failed.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Looking up address…" : "Look up address"}
      </button>
      {lookupNotice && <p role="status">{lookupNotice}</p>}
      {suggestions.map((candidate, index) => (
        <div className="notice" key={index}>
          <p>
            {candidate.formatted}
            <br />
            {candidate.matchLevel} match · Confidence{" "}
            {Math.round(candidate.confidence * 100)}%
          </p>
          <button
            type="button"
            className="button small"
            disabled={
              !candidate.street ||
              !candidate.city ||
              !["building", "amenity"].includes(candidate.matchLevel)
            }
            onClick={() =>
              update({
                ...address,
                street: candidate.street,
                city: candidate.city,
                region: candidate.region,
                postalCode: candidate.postalCode,
                country: candidate.country,
                confirmed: false,
              })
            }
          >
            Use suggested address
          </button>
          <small className="block">{candidate.attribution}</small>
        </div>
      ))}
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
        . Only the street, city, state/province, postal code and country are
        sent for lookup. Contact details stay in this app.
      </p>
      <button
        type="button"
        className="button small"
        onClick={() => {
          const errors = addressIssues(address);
          setIssues(errors);
          update({ ...address, confirmed: errors.length === 0 });
        }}
      >
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
    </fieldset>
  );
}

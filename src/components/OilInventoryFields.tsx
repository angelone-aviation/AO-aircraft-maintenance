/**
 * Responsibility: The flight form's fields for drawing the oil added from
 *   inventory, and the one-line summary of what was drawn.
 * Layer: UI. Reads parts inventory from the workspace snapshot; changes go
 *   back through `onChange`.
 * Dependencies: src/data/store.ts (useWorkspace), src/domain/requiredParts.ts
 *   (partsInventory), src/domain/shelfLife.ts (expiredForUse),
 *   src/domain/flightFluids.ts (OilReading type), src/components/design.tsx
 *   (Switch), src/components/FlightParts.tsx (FlightField).
 */
import { useWorkspace } from "../data/store";
import { partsInventory, type PartsInventory } from "../domain/requiredParts";
import { expiredForUse } from "../domain/shelfLife";
import type { OilReading } from "../domain/flightFluids";
import { Switch } from "./design";
import { FlightField } from "./FlightParts";

type InventoryUse = NonNullable<OilReading["inventory"]>;
type UseFieldProps = {
  label: string;
  use: InventoryUse;
  onChange: (use: InventoryUse) => void;
};

/**
 * Lets the pilot draw the oil added on a flight from stock: a switch, then the
 * location, the oil part number and the stock units used.
 *
 * @param props.label - The oil's name, such as "Engine oil"; it starts each
 *   field's label.
 * @param props.reading - The oil reading being recorded.
 * @param props.onChange - Called with the whole reading after each change.
 * @param props.readOnly - Disables the fields, for usage already posted.
 * @returns The fieldset, or null when no oil was added and no inventory use
 *   is recorded.
 */
export function OilInventoryFields({
  label,
  reading,
  onChange,
  readOnly = false,
}: {
  label: string;
  reading: OilReading;
  onChange: (reading: OilReading) => void;
  readOnly?: boolean;
}) {
  const { snapshot } = useWorkspace();
  const inventory = partsInventory(snapshot!);
  const use = reading.inventory;
  if (!(reading.added && reading.added > 0) && !use) return null;
  const update = (next?: InventoryUse) =>
    onChange({ ...reading, inventory: next });
  return (
    <fieldset
      disabled={readOnly}
      className="oil-inventory-fields flight-oil-inventory"
    >
      <Switch
        className="flight-switch"
        checked={!!use}
        onChange={(checked) => update(checked ? startUse() : undefined)}
        label={`Use inventory for ${label.toLowerCase()}`}
      />
      {use && (
        <UseFields
          label={label}
          use={use}
          inventory={inventory}
          readOnly={readOnly}
          onChange={update}
        />
      )}
    </fieldset>
  );
}

/**
 * One line naming the oil a flight drew from inventory.
 *
 * @param props.reading - The oil reading.
 * @returns "Inventory used: <quantity> × <part number> · <location>", with
 *   the stock id and "Unavailable location" for records no longer in
 *   inventory; null when the reading drew none.
 */
export function OilInventorySummary({ reading }: { reading: OilReading }) {
  const { snapshot } = useWorkspace();
  if (!reading.inventory) return null;
  const inventory = partsInventory(snapshot!);
  const { quantity, stockUuid, locationUuid } = reading.inventory;
  const part = inventory.stock.find((s) => s.uuid === stockUuid);
  const location = inventory.locations.find((l) => l.uuid === locationUuid);
  return (
    <small>
      Inventory used: {quantity} × {part?.partNumber ?? stockUuid} ·{" "}
      {location?.name ?? "Unavailable location"}
    </small>
  );
}

function startUse(): InventoryUse {
  return { locationUuid: "", stockUuid: "", quantity: 1 };
}

function UseFields({
  inventory,
  readOnly,
  ...field
}: UseFieldProps & { inventory: PartsInventory; readOnly: boolean }) {
  // Only stock an administrator marked as oil can be drawn on the flight line.
  const stock = inventory.stock.filter(
    (s) => s.oil && s.locationUuid === field.use.locationUuid,
  );
  return (
    <>
      <div className="flight-grid">
        <LocationField {...field} locations={inventory.locations} />
        <StockField {...field} stock={stock} />
        <QuantityField {...field} />
      </div>
      <UsageNote readOnly={readOnly} />
    </>
  );
}

function LocationField({
  label,
  use,
  onChange,
  locations,
}: UseFieldProps & { locations: PartsInventory["locations"] }) {
  const missing =
    !!use.locationUuid && !locations.some((l) => l.uuid === use.locationUuid);
  return (
    <FlightField label={`${label} inventory location`}>
      <select
        required
        value={use.locationUuid}
        // A new location clears the part, which belonged to the old one.
        onChange={(e) =>
          onChange({ ...use, locationUuid: e.target.value, stockUuid: "" })
        }
      >
        <option value="">Select location</option>
        {missing && (
          <option value={use.locationUuid}>Unavailable location</option>
        )}
        {locations.map((l) => (
          <option key={l.uuid} value={l.uuid}>
            {l.name}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function StockField({
  label,
  use,
  onChange,
  stock,
}: UseFieldProps & { stock: PartsInventory["stock"] }) {
  const missing =
    !!use.stockUuid && !stock.some((s) => s.uuid === use.stockUuid);
  return (
    <FlightField label={`${label} inventory part number`}>
      <select
        required
        disabled={!use.locationUuid}
        value={use.stockUuid}
        onChange={(e) => onChange({ ...use, stockUuid: e.target.value })}
      >
        <option value="">Select oil part number</option>
        {missing && (
          <option value={use.stockUuid}>
            Unavailable part ({use.stockUuid})
          </option>
        )}
        {stock.map((s) => {
          // Expired oil cannot be issued; it is listed but not offered.
          const expired = expiredForUse(s.expirationDate);
          return (
            <option key={s.uuid} value={s.uuid} disabled={expired}>
              {s.partNumber} · {s.description} ·{" "}
              {expired
                ? `Expired ${s.expirationDate}`
                : `${s.quantity} in stock`}
            </option>
          );
        })}
      </select>
    </FlightField>
  );
}

function QuantityField({ label, use, onChange }: UseFieldProps) {
  return (
    <FlightField
      label={`${label} stock units used`}
      hint="Whole stock items, such as bottles. This is separate from the volume of oil added."
    >
      <input
        type="number"
        min="1"
        step="1"
        required
        value={use.quantity || ""}
        onChange={(e) => onChange({ ...use, quantity: Number(e.target.value) })}
      />
    </FlightField>
  );
}

function UsageNote({ readOnly }: { readOnly: boolean }) {
  return (
    <p className="flight-note">
      {readOnly
        ? "This inventory usage is already posted. Use an inventory adjustment to correct stock; rejecting a flight does not return oil already used."
        : "Stock is deducted once when the flight syncs, even if meter readings need review. Offline entries do not reserve stock. Confirm the oil part is appropriate for this aircraft."}
    </p>
  );
}

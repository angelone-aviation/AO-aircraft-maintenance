import { useWorkspace } from "../data/store";
import { partsInventory } from "../domain/requiredParts";
import { expiredForUse } from "../domain/shelfLife";
import type { OilReading } from "../domain/flightFluids";
import { Switch } from "./design";
import { FlightField } from "./FlightParts";
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
  // Only stock an administrator marked as oil can be drawn on the flight line.
  const stock = inventory.stock.filter(
    (s) => s.oil && s.locationUuid === use?.locationUuid,
  );
  return (
    <fieldset
      disabled={readOnly}
      className="oil-inventory-fields flight-oil-inventory"
    >
      <Switch
        className="flight-switch"
        checked={!!use}
        onChange={(checked) =>
          onChange({
            ...reading,
            inventory: checked
              ? { locationUuid: "", stockUuid: "", quantity: 1 }
              : undefined,
          })
        }
        label={`Use inventory for ${label.toLowerCase()}`}
      />
      {use && (
        <>
          <div className="flight-grid">
            <FlightField label={`${label} inventory location`}>
              <select
                required
                value={use.locationUuid}
                onChange={(e) =>
                  onChange({
                    ...reading,
                    inventory: {
                      ...use,
                      locationUuid: e.target.value,
                      stockUuid: "",
                    },
                  })
                }
              >
                <option value="">Select location</option>
                {use.locationUuid &&
                  !inventory.locations.some(
                    (l) => l.uuid === use.locationUuid,
                  ) && (
                    <option value={use.locationUuid}>
                      Unavailable location
                    </option>
                  )}
                {inventory.locations.map((l) => (
                  <option key={l.uuid} value={l.uuid}>
                    {l.name}
                  </option>
                ))}
              </select>
            </FlightField>
            <FlightField label={`${label} inventory part number`}>
              <select
                required
                disabled={!use.locationUuid}
                value={use.stockUuid}
                onChange={(e) =>
                  onChange({
                    ...reading,
                    inventory: { ...use, stockUuid: e.target.value },
                  })
                }
              >
                <option value="">Select oil part number</option>
                {use.stockUuid &&
                  !stock.some((s) => s.uuid === use.stockUuid) && (
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
                onChange={(e) =>
                  onChange({
                    ...reading,
                    inventory: { ...use, quantity: Number(e.target.value) },
                  })
                }
              />
            </FlightField>
          </div>
          <p className="flight-note">
            {readOnly
              ? "This inventory usage is already posted. Use an inventory adjustment to correct stock; rejecting a flight does not return oil already used."
              : "Stock is deducted once when the flight syncs, even if meter readings need review. Offline entries do not reserve stock. Confirm the oil part is appropriate for this aircraft."}
          </p>
        </>
      )}
    </fieldset>
  );
}
export function OilInventorySummary({ reading }: { reading: OilReading }) {
  const { snapshot } = useWorkspace();
  if (!reading.inventory) return null;
  const inventory = partsInventory(snapshot!);
  const part = inventory.stock.find(
    (s) => s.uuid === reading.inventory!.stockUuid,
  );
  const location = inventory.locations.find(
    (l) => l.uuid === reading.inventory!.locationUuid,
  );
  return (
    <small>
      Inventory used: {reading.inventory.quantity} ×{" "}
      {part?.partNumber ?? reading.inventory.stockUuid} ·{" "}
      {location?.name ?? "Unavailable location"}
    </small>
  );
}

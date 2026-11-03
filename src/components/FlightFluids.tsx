import { OilInventoryFields, OilInventorySummary } from "./OilInventoryFields";
import { FlightField } from "./FlightParts";
import { Drop, GasPump } from "@phosphor-icons/react";
import {
  oilUseSincePreviousStart,
  oilRanges,
  oilLevelLabel,
  fluidUsed,
  fluidRate,
  type FuelReading,
  type OilReading,
} from "../domain/flightFluids";
import {
  aircraftMeterLabels,
  type Aircraft,
  type Flight,
} from "../domain/model";
import { meterAtFlight } from "../domain/flights";
export type Fluids = { fuel?: FuelReading; oil?: OilReading[] };
export function FlightFluidFields({
  fluids,
  onChange,
  twin,
  phase = "all",
  required = false,
  inventoryReadOnly = false,
}: {
  fluids: Fluids;
  onChange: (next: Fluids) => void;
  twin?: boolean;
  phase?: "all" | "preflight" | "shutdown";
  required?: boolean;
  inventoryReadOnly?: boolean;
}) {
  const oil = fluids.oil?.length
    ? fluids.oil
    : (twin ? (["left", "right"] as const) : (["single"] as const)).map(
        (engine) => ({ engine, unit: "US qt" as const }),
      );
  const rows: {
    label: string;
    reading: FuelReading | OilReading;
    units: string[];
    update: (r: FuelReading | OilReading) => void;
  }[] = [
    {
      label: "Fuel",
      reading: fluids.fuel ?? { unit: "US gal" as const },
      units: ["US gal", "L", "lb", "kg"],
      update: (r: FuelReading | OilReading) =>
        onChange({ ...fluids, fuel: r as FuelReading }),
    },
    ...(phase === "shutdown" ? [] : oil).map((r, index) => ({
      label: `${r.engine === "single" ? "Engine" : r.engine === "left" ? "Left engine" : "Right engine"} oil`,
      reading: r,
      units: ["US qt", "L", "range"],
      update: (next: FuelReading | OilReading) =>
        onChange({
          ...fluids,
          oil: oil.map((o, i) => (i === index ? (next as OilReading) : o)),
        }),
    })),
  ];
  return (
    <section className="flight-section flight-fluids flight-fluid-fields">
      <div className="flight-section-head">
        <h3 className="flight-section-title">
          {phase === "shutdown" ? "Fuel" : "Fuel and oil"}
        </h3>
      </div>
      <p className="flight-note">
        Starting level is before additions. Enter 0 when none was added. Use the
        same unit for measured readings; changing units does not convert values.
        Switching between measured and range oil clears that engine’s readings.
      </p>
      {rows.map(({ label, reading, units, update }) => (
        <div className="flight-fluid" key={label}>
          <h4 className="flight-fluid-title">
            {"engine" in reading ? (
              <Drop size={18} weight="duotone" aria-hidden="true" />
            ) : (
              <GasPump size={18} weight="duotone" aria-hidden="true" />
            )}
            {label}
          </h4>
          {reading.unit === "range" && (
            <p className="flight-note">
              Levels describe the range between the Add and Full marks. Quantity
              added is recorded separately; consumption cannot be calculated
              from range levels.
            </p>
          )}
          <div className="flight-grid">
            <FlightField label={`${label} unit`}>
              <select
                value={reading.unit}
                disabled={phase === "shutdown"}
                onChange={(e) => {
                  const unit = e.target.value;
                  const rangeChanged =
                    (unit === "range") !== (reading.unit === "range");
                  update({
                    ...reading,
                    unit,
                    ...(rangeChanged
                      ? {
                          start: undefined,
                          end: undefined,
                          added: undefined,
                          addedUnit: unit === "range" ? "US qt" : undefined,
                        }
                      : {}),
                  } as typeof reading);
                }}
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u === "range" ? "Range only (no units)" : u}
                  </option>
                ))}
              </select>
            </FlightField>
            {reading.unit === "range" && phase !== "shutdown" && (
              <FlightField label={`${label} quantity added unit`}>
                <select
                  value={reading.addedUnit ?? "US qt"}
                  onChange={(e) =>
                    update({
                      ...reading,
                      addedUnit: e.target.value as "US qt" | "L",
                    })
                  }
                >
                  <option>US qt</option>
                  <option>L</option>
                </select>
              </FlightField>
            )}
            {(["start", "added", "end"] as const)
              .filter(
                (k) =>
                  (!("engine" in reading) || k !== "end") &&
                  (phase === "all" ||
                    (phase === "preflight" ? k !== "end" : k === "end")),
              )
              .map((k) => (
                <FlightField
                  key={k}
                  label={`${label} ${k === "start" ? "starting level" : k === "added" ? "quantity added" : "shutdown level"} ${reading.unit === "range" ? (k === "added" ? `(${reading.addedUnit ?? "US qt"})` : "(range)") : `(${reading.unit})`}`}
                >
                  {reading.unit === "range" && k !== "added" ? (
                    <select
                      required={required}
                      value={reading[k] ?? ""}
                      onChange={(e) =>
                        update({
                          ...reading,
                          [k]:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">Select level</option>
                      {oilRanges.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="any"
                      inputMode="decimal"
                      required={required}
                      value={reading[k] ?? ""}
                      onChange={(e) =>
                        update({
                          ...reading,
                          [k]:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                    />
                  )}
                </FlightField>
              ))}
          </div>
          {"engine" in reading && (
            <OilInventoryFields
              label={label}
              reading={reading}
              onChange={update}
              readOnly={inventoryReadOnly}
            />
          )}
        </div>
      ))}
    </section>
  );
}
export function FlightFluidSummary({
  flight,
  aircraft,
  previousFlight,
}: {
  flight: Flight;
  aircraft?: Aircraft;
  previousFlight?: Flight;
}) {
  const meter = aircraft
    ? meterAtFlight(aircraft, flight.startTime)
    : undefined;
  const start =
    meter === "tach"
      ? flight.tachOff
      : meter === "flightTimeLog"
        ? flight.flightTimeLogOff
        : meter === "cyclic"
          ? flight.cyclicHobbsOff
          : flight.hobbsOff;
  const end =
    meter === "tach"
      ? flight.tachOn
      : meter === "flightTimeLog"
        ? flight.flightTimeLogOn
        : meter === "cyclic"
          ? flight.cyclicHobbsOn
          : flight.hobbsOn;
  const duration =
    flight.status === "accepted" &&
    meter &&
    start !== undefined &&
    end !== undefined
      ? end - start
      : undefined;
  const rows = [
    ...(flight.fuel ? [{ label: "Fuel", ...flight.fuel }] : []),
    ...(flight.oil ?? []).map((o) => ({ label: `${o.engine} oil`, ...o })),
  ];
  return (
    <>
      {rows.length
        ? rows.map((r) => (
            <div key={r.label}>
              {"engine" in r ? (
                <>
                  <strong>
                    {r.label}: {r.unit === "range" ? "range only" : "preflight"}
                  </strong>
                  <small>
                    Start {oilLevelLabel(r, r.start)} · added {r.added ?? "—"}{" "}
                    {r.unit === "range" ? (r.addedUnit ?? "") : r.unit}
                  </small>
                  <OilInventorySummary reading={r} />
                  <small>
                    {(() => {
                      const used = oilUseSincePreviousStart(
                        flight,
                        previousFlight,
                        r.engine,
                      );
                      return used === undefined
                        ? r.unit === "range"
                          ? "Consumption unavailable for range readings"
                          : "Consumption since previous start unknown"
                        : `${used} ${r.unit} used since previous start`;
                    })()}
                  </small>
                </>
              ) : (
                <>
                  <strong>
                    {r.label}:{" "}
                    {fluidUsed(r) === undefined
                      ? "Consumption unknown"
                      : `${fluidUsed(r)} ${r.unit} used`}
                  </strong>
                  <small>
                    Start {r.start ?? "—"} + added {r.added ?? "—"} − shutdown{" "}
                    {r.end ?? "—"} {r.unit}
                  </small>
                  {fluidRate(r, duration) !== undefined && (
                    <small>
                      {fluidRate(r, duration)!.toFixed(2)} {r.unit}/hr (
                      {meter ? aircraftMeterLabels[meter] : "Unknown"})
                    </small>
                  )}
                </>
              )}
            </div>
          ))
        : "—"}
      {flight.checklistRun && (
        <small>
          Checklist: {flight.checklistRun.checklistName} · revision{" "}
          {flight.checklistRun.checklistVersion} ·{" "}
          {flight.checklistRun.checked.length}/{flight.checklistRun.totalChecks}{" "}
          checked · {flight.checklistRun.skipped.length} skipped
        </small>
      )}
    </>
  );
}

/**
 * Responsibility: The flight form's fuel and oil readings, and the fluids
 *   summary on a flight record.
 * Layer: UI. The fields report each change through `onChange`.
 * Dependencies: @phosphor-icons/react, src/domain/flightFluids.ts,
 *   src/domain/model.ts, src/domain/flights.ts (meterAtFlight),
 *   src/components/OilInventoryFields.tsx, src/components/FlightParts.tsx.
 *
 * Oil is read before each flight only: oil used runs from one start to the
 * next (oilUseSincePreviousStart), so shutdown records fuel alone.
 */
import type { ChangeEvent } from "react";
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
import { OilInventoryFields, OilInventorySummary } from "./OilInventoryFields";
import { FlightField } from "./FlightParts";

const FUEL_UNITS = ["US gal", "L", "lb", "kg"];
const OIL_UNITS = ["US qt", "L", "range"];
const DEFAULT_ADDED_UNIT = "US qt";
// The schema's limit for any one reading (src/domain/flightFluids.ts).
const READING_MAX = "1000000";
const ENGINE_LABELS = {
  single: "Engine",
  left: "Left engine",
  right: "Right engine",
};
const LEVEL_LABELS = {
  start: "starting level",
  added: "quantity added",
  end: "shutdown level",
};
const LEVELS = ["start", "added", "end"] as const;

/** The fuel and per-engine oil readings a flight records. */
export type Fluids = { fuel?: FuelReading; oil?: OilReading[] };
type Reading = FuelReading | OilReading;
type Level = (typeof LEVELS)[number];
type Phase = "all" | "preflight" | "shutdown";
type Meter = Aircraft["meter"];
type FluidRow = {
  label: string;
  reading: Reading;
  units: string[];
  update: (reading: Reading) => void;
};
type Options = { phase: Phase; required: boolean; inventoryReadOnly: boolean };
type FieldsProps = {
  fluids: Fluids;
  onChange: (next: Fluids) => void;
  twin?: boolean;
  phase?: Phase;
  required?: boolean;
  inventoryReadOnly?: boolean;
};

/**
 * Fuel and oil fields for one flight, one group per fluid, with oil drawn
 * from inventory where recorded.
 *
 * @param props.fluids - The readings so far; with no oil yet, one US qt
 *   reading per engine (left and right when `twin`).
 * @param props.onChange - Called with all the fluids after each change.
 * @param props.phase - "preflight" asks for starting levels and additions,
 *   "shutdown" for the fuel's shutdown level only; "all" (the default) both.
 * @param props.required - Marks each level field required.
 * @param props.inventoryReadOnly - Disables the oil inventory fields.
 * @returns The fluids section.
 */
export function FlightFluidFields({
  phase = "all",
  required = false,
  inventoryReadOnly = false,
  ...props
}: FieldsProps) {
  const rows = fluidRows(props, phase);
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
      {rows.map((row) => (
        <FluidFields
          key={row.label}
          row={row}
          options={{ phase, required, inventoryReadOnly }}
        />
      ))}
    </section>
  );
}

/**
 * The fuel and oil a flight recorded, with fuel burn per meter hour once the
 * flight is accepted, then its checklist run.
 *
 * @param props.flight - The flight.
 * @param props.aircraft - Sets the meter the burn rate is measured on; with
 *   none there is no rate.
 * @param props.previousFlight - The flight before, for oil used since its
 *   start.
 * @returns The summary lines, or "—" when no fluids were recorded.
 */
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
  const duration = meteredSeconds(flight, meter);
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
                <OilSummary
                  reading={r}
                  oilUse={oilUseText(flight, previousFlight, r)}
                />
              ) : (
                <FuelSummary reading={r} seconds={duration} meter={meter} />
              )}
            </div>
          ))
        : "—"}
      {flight.checklistRun && <ChecklistSummary run={flight.checklistRun} />}
    </>
  );
}

function FluidFields({ row, options }: { row: FluidRow; options: Options }) {
  const { label, reading, update } = row;
  const { phase, required } = options;
  const Icon = "engine" in reading ? Drop : GasPump;
  return (
    <div className="flight-fluid">
      <h4 className="flight-fluid-title">
        <Icon size={18} weight="duotone" aria-hidden="true" />
        {label}
      </h4>
      {reading.unit === "range" && (
        <p className="flight-note">
          Levels describe the range between the Add and Full marks. Quantity
          added is recorded separately; consumption cannot be calculated from
          range levels.
        </p>
      )}
      <div className="flight-grid">
        <UnitField row={row} disabled={phase === "shutdown"} />
        {reading.unit === "range" && phase !== "shutdown" && (
          <AddedUnitField label={label} reading={reading} update={update} />
        )}
        {shownLevels(reading, phase).map((level) => (
          <LevelField key={level} row={row} level={level} required={required} />
        ))}
      </div>
      {"engine" in reading && (
        <OilInventoryFields
          label={label}
          reading={reading}
          onChange={update}
          readOnly={options.inventoryReadOnly}
        />
      )}
    </div>
  );
}

function UnitField({ row, disabled }: { row: FluidRow; disabled: boolean }) {
  const { label, reading, units, update } = row;
  return (
    <FlightField label={`${label} unit`}>
      <select
        value={reading.unit}
        disabled={disabled}
        onChange={(e) => update(withUnit(reading, e.target.value))}
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {u === "range" ? "Range only (no units)" : u}
          </option>
        ))}
      </select>
    </FlightField>
  );
}

function AddedUnitField({
  label,
  reading,
  update,
}: {
  label: string;
  reading: OilReading;
  update: (reading: OilReading) => void;
}) {
  return (
    <FlightField label={`${label} quantity added unit`}>
      <select
        value={reading.addedUnit ?? DEFAULT_ADDED_UNIT}
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
  );
}

function LevelField({
  row,
  level,
  required,
}: {
  row: FluidRow;
  level: Level;
  required: boolean;
}) {
  const { label, reading, update } = row;
  const control = {
    required,
    value: reading[level] ?? "",
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      update({ ...reading, [level]: parseLevel(e.target.value) }),
  };
  return (
    <FlightField label={levelLabel(label, reading, level)}>
      {reading.unit === "range" && level !== "added" ? (
        <select {...control}>
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
          max={READING_MAX}
          step="any"
          inputMode="decimal"
          {...control}
        />
      )}
    </FlightField>
  );
}

function OilSummary({
  reading: r,
  oilUse,
}: {
  reading: OilReading & { label: string };
  oilUse: string;
}) {
  return (
    <>
      <strong>
        {r.label}: {r.unit === "range" ? "range only" : "preflight"}
      </strong>
      <small>
        Start {oilLevelLabel(r, r.start)} · added {r.added ?? "—"}{" "}
        {r.unit === "range" ? (r.addedUnit ?? "") : r.unit}
      </small>
      <OilInventorySummary reading={r} />
      <small>{oilUse}</small>
    </>
  );
}

function FuelSummary({
  reading: r,
  seconds,
  meter,
}: {
  reading: FuelReading & { label: string };
  seconds: number | undefined;
  meter: Meter | undefined;
}) {
  const used = fluidUsed(r);
  const rate = fluidRate(r, seconds);
  return (
    <>
      <strong>
        {r.label}:{" "}
        {used === undefined ? "Consumption unknown" : `${used} ${r.unit} used`}
      </strong>
      <small>
        Start {r.start ?? "—"} + added {r.added ?? "—"} − shutdown{" "}
        {r.end ?? "—"} {r.unit}
      </small>
      {rate !== undefined && (
        <small>
          {rate.toFixed(2)} {r.unit}/hr (
          {meter ? aircraftMeterLabels[meter] : "Unknown"})
        </small>
      )}
    </>
  );
}

function ChecklistSummary({
  run,
}: {
  run: NonNullable<Flight["checklistRun"]>;
}) {
  return (
    <small>
      Checklist: {run.checklistName} · revision {run.checklistVersion} ·{" "}
      {run.checked.length}/{run.totalChecks} checked · {run.skipped.length}{" "}
      skipped
    </small>
  );
}

function fluidRows(
  { fluids, onChange, twin }: FieldsProps,
  phase: Phase,
): FluidRow[] {
  const oil = fluids.oil?.length ? fluids.oil : defaultOil(twin);
  const fuel = {
    label: "Fuel",
    reading: fluids.fuel ?? { unit: "US gal" as const },
    units: FUEL_UNITS,
    update: (r: Reading) => onChange({ ...fluids, fuel: r as FuelReading }),
  };
  const oilRows = (phase === "shutdown" ? [] : oil).map((reading, index) => ({
    label: `${ENGINE_LABELS[reading.engine]} oil`,
    reading,
    units: OIL_UNITS,
    update: (next: Reading) =>
      onChange({
        ...fluids,
        oil: oil.map((o, i) => (i === index ? (next as OilReading) : o)),
      }),
  }));
  return [fuel, ...oilRows];
}

function defaultOil(twin?: boolean): OilReading[] {
  const engines = twin ? (["left", "right"] as const) : (["single"] as const);
  return engines.map((engine) => ({ engine, unit: "US qt" as const }));
}

function shownLevels(reading: Reading, phase: Phase): Level[] {
  const isOil = "engine" in reading;
  return LEVELS.filter((level) => {
    if (isOil && level === "end") return false;
    if (phase === "all") return true;
    return phase === "preflight" ? level !== "end" : level === "end";
  });
}

function levelLabel(label: string, reading: Reading, level: Level): string {
  return `${label} ${LEVEL_LABELS[level]} ${levelUnit(reading, level)}`;
}

function levelUnit(reading: Reading, level: Level): string {
  if (reading.unit !== "range") return `(${reading.unit})`;
  if (level !== "added") return "(range)";
  return `(${reading.addedUnit ?? DEFAULT_ADDED_UNIT})`;
}

// Range levels and measured quantities are not comparable, so switching
// between them clears the levels already entered.
function withUnit(reading: Reading, unit: string): Reading {
  const rangeChanged = (unit === "range") !== (reading.unit === "range");
  if (!rangeChanged) return { ...reading, unit } as Reading;
  return {
    ...reading,
    unit,
    start: undefined,
    end: undefined,
    added: undefined,
    addedUnit: unit === "range" ? DEFAULT_ADDED_UNIT : undefined,
  } as Reading;
}

function oilUseText(
  flight: Flight,
  previousFlight: Flight | undefined,
  reading: OilReading,
): string {
  const used = oilUseSincePreviousStart(flight, previousFlight, reading.engine);
  if (used !== undefined)
    return `${used} ${reading.unit} used since previous start`;
  return reading.unit === "range"
    ? "Consumption unavailable for range readings"
    : "Consumption since previous start unknown";
}

function parseLevel(text: string): number | undefined {
  return text === "" ? undefined : Number(text);
}

// "Off" readings are where an accepted flight started and "On" where it
// ended (Flight in src/domain/model.ts).
function meteredSeconds(
  flight: Flight,
  meter: Meter | undefined,
): number | undefined {
  if (flight.status !== "accepted" || !meter) return undefined;
  const [start, end] = meterReadings(flight, meter);
  if (start === undefined || end === undefined) return undefined;
  return end - start;
}

function meterReadings(flight: Flight, meter: Meter) {
  if (meter === "tach") return [flight.tachOff, flight.tachOn];
  if (meter === "flightTimeLog")
    return [flight.flightTimeLogOff, flight.flightTimeLogOn];
  if (meter === "cyclic") return [flight.cyclicHobbsOff, flight.cyclicHobbsOn];
  return [flight.hobbsOff, flight.hobbsOn];
}

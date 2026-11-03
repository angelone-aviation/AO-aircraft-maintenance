import { AircraftCostSummary } from "./Costs";
import { AircraftStatusReasons } from "./AircraftStatus";
import { aircraftStatus } from "../domain/aircraftStatus";
import { AircraftPhoto } from "./AircraftPhoto";
import { AddressFields } from "./AddressFields";
import { addressFromForm } from "../domain/addresses";
import { DrsComboBox } from "./DrsComboBox";
import { ComponentForm } from "./Components";
import { AircraftManuals } from "./Manuals";
import { AircraftEngineTrends } from "./EngineTrends";
import { programPermission } from "../domain/programs";
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import {
  can,
  aircraftMeterLabels,
  hours,
  parseHours,
  totalSeconds,
  type Aircraft,
} from "../domain/model";
import {
  parseAdjustment,
  normalizeWebsite,
  type Program,
  type AircraftInput,
  type FleetCommand,
} from "../domain/fleet";
import { AsyncForm, Field, Modal, value, safeHref } from "./ui";
import { History } from "./ManagementShared";
import {
  AirplaneTilt,
  ArrowsLeftRight,
  Buildings,
  Plus,
  WifiSlash,
} from "@phosphor-icons/react";
import {
  EmptyState,
  IconTile,
  ListCard,
  NoticeBar,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { OpsList, OpsMeters, OpsRow } from "./OpsList";
const statusTone = {
  airworthy: "good",
  "due-soon": "warn",
  grounded: "danger",
} as const;
const statusLabel = {
  airworthy: "Airworthy",
  "due-soon": "Due soon",
  grounded: "Grounded",
} as const;
// The manual assessment, worded as in the aircraft form's Status select.
const profileLabel: Record<Aircraft["operationalStatus"], string> = {
  unknown: "Unverified",
  airworthy: "Airworthy",
  maintenance: "Maintenance",
  grounded: "Grounded",
};
function useFleet() {
  const { snapshot, backend, online, connected } = useWorkspace();
  return {
    s: snapshot!,
    writable: online && connected,
    save: async (c: FleetCommand) => {
      if (!online || !connected || !backend)
        throw new Error("Reconnect to save changes.");
      await backend.fleet(c);
      useWorkspace.setState({ notice: "Change saved." });
    },
  };
}
export function AircraftForm({
  initial,
  onDone,
}: {
  initial?: Aircraft;
  onDone: () => void;
}) {
  const { s, writable, save } = useFleet();
  const [meter, setMeter] = useState<Aircraft["meter"]>(
    initial?.meter ?? "hobbs",
  );
  const [flightTimeLog, setFlightTimeLog] = useState(
    initial?.flightTimeLog ?? false,
  );
  const [flightTimeReading, setFlightTimeReading] = useState(
    String((initial?.currentFlightTimeLog ?? 0) / 3600),
  );
  const [turbine, setTurbine] = useState(initial?.turbine ?? false);
  const [helicopter, setHelicopter] = useState(initial?.helicopter ?? false);
  const [cyclic, setCyclic] = useState(
    String((initial?.currentCyclicHobbs ?? 0) / 3600),
  );
  const reading = (source: Aircraft["meter"]) =>
    source === "flightTimeLog"
      ? flightTimeReading
      : source === "cyclic"
        ? cyclic
        : source === "hobbs"
          ? hobbs
          : tach;
  const [hobbs, setHobbs] = useState(
      String((initial?.currentHobbs ?? 0) / 3600),
    ),
    [tach, setTach] = useState(String((initial?.currentTach ?? 0) / 3600)),
    [adjustment, setAdjustment] = useState(
      String((initial?.adjustmentSeconds ?? 0) / 3600),
    );
  let total: number | undefined;
  try {
    total = (parseHours(reading(meter)) ?? 0) + parseAdjustment(adjustment);
  } catch {
    total = undefined;
  }
  const switchMeter = (next: Aircraft["meter"]) => {
    if (total !== undefined) {
      try {
        setAdjustment(
          String((total - (parseHours(reading(next)) ?? 0)) / 3600),
        );
      } catch {
        /* Validation displays on save. */
      }
    }
    setMeter(next);
  };
  return (
    <AsyncForm
      disabled={!writable}
      submitLabel={initial ? "Save aircraft" : "Add aircraft"}
      onSubmit={async (d) => {
        const aircraft: AircraftInput = {
          uuid: initial?.uuid ?? crypto.randomUUID(),
          version: initial?.version ?? 0,
          registration: value(d, "registration"),
          make: value(d, "make"),
          model: value(d, "model"),
          faaSearchModel: value(d, "faaSearchModel"),
          serial: value(d, "serial"),
          twin: d.has("twin"),
          turbine: d.has("turbine"),
          amphibious: d.has("amphibious"),
          helicopter,
          flightTimeLog,
          currentFlightTimeLog: flightTimeLog
            ? parseHours(flightTimeReading)!
            : initial?.currentFlightTimeLog,
          currentCyclicHobbs: helicopter
            ? parseHours(cyclic)!
            : initial?.currentCyclicHobbs,
          programUuid: initial?.programUuid ?? s.activeProgramUuid,
          meter,
          adjustmentSeconds: parseAdjustment(adjustment),
          currentHobbs: parseHours(hobbs)!,
          currentTach: parseHours(tach)!,
          cycles: turbine ? Number(value(d, "cycles")) : (initial?.cycles ?? 0),
          landings: Number(value(d, "landings")),
          operationalStatus: value(
            d,
            "status",
          ) as Aircraft["operationalStatus"],
        };
        await save({
          action: "aircraft.save",
          aircraft,
          requestUuid: crypto.randomUUID(),
          reason: initial ? "Aircraft details updated." : "Aircraft created.",
        });
        onDone();
      }}
    >
      {initial ? (
        <AircraftPhoto aircraftUuid={initial.uuid} />
      ) : (
        <p className="muted">
          Save the aircraft, then open Edit aircraft to add its dashboard photo.
        </p>
      )}
      <div className="form-grid">
        {(["registration", "make", "model", "serial"] as const).map((k, i) => (
          <Field
            key={k}
            label={["Registration", "Make", "Model", "Serial number"][i]}
          >
            {k === "make" || k === "model" ? (
              <DrsComboBox
                kind={k === "make" ? "makes" : "models"}
                name={k}
                defaultValue={initial?.[k]}
                required
              />
            ) : (
              <input
                name={k}
                defaultValue={initial?.[k]}
                maxLength={150}
                required={k !== "serial"}
              />
            )}
          </Field>
        ))}
        <Field
          label="FAA search model (optional)"
          hint="Uses this model for AD searches without changing the aircraft model. Leave blank to use the profile model."
        >
          <DrsComboBox
            kind="models"
            name="faaSearchModel"
            defaultValue={initial?.faaSearchModel}
          />
        </Field>
        <Field label="Flight Program name">
          <select
            name="program"
            value={initial?.programUuid ?? s.activeProgramUuid ?? ""}
            disabled
          >
            <option value="">Unassigned</option>
            {(s.programs ?? [])
              .filter((p) => s.user.isAdmin || p.uuid === s.activeProgramUuid)
              .map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Status (manual assessment)">
          <select
            name="status"
            defaultValue={initial?.operationalStatus ?? "unknown"}
          >
            <option value="unknown">Unverified</option>
            <option value="airworthy">Airworthy</option>
            <option value="maintenance">Maintenance</option>
            <option value="grounded">Grounded</option>
          </select>
        </Field>
      </div>
      <fieldset>
        <legend>Aircraft options</legend>
        <div className="form-grid">
          <label>
            <input
              type="checkbox"
              name="helicopter"
              checked={helicopter}
              onChange={(e) => {
                if (!e.target.checked && meter === "cyclic")
                  switchMeter("hobbs");
                setHelicopter(e.target.checked);
              }}
            />{" "}
            Helicopter
          </label>
          <label>
            <input
              type="checkbox"
              checked={flightTimeLog}
              onChange={(e) => {
                if (!e.target.checked && meter === "flightTimeLog")
                  switchMeter("hobbs");
                setFlightTimeLog(e.target.checked);
              }}
            />{" "}
            Flight time log
          </label>
          {(
            [
              ["twin", "Twin"],
              ["turbine", "Turbine"],
              ["amphibious", "Amphibious"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                name={key}
                defaultChecked={initial?.[key] ?? false}
                onChange={
                  key === "turbine"
                    ? (e) => setTurbine(e.target.checked)
                    : undefined
                }
              />{" "}
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <h3>Aircraft maintenance time</h3>
      <p className="muted">
        Maintenance time = selected meter reading + total time adjustment.
        Inspections and components use this default unless they have an explicit
        time source. For the R66, use the collective hourmeter for time in
        service; retain console run time for reference.
      </p>
      <div className="form-grid">
        <Field
          label={
            helicopter
              ? "Run-time hourmeter (console Hobbs, hours)"
              : "Current Hobbs (hours)"
          }
        >
          <input
            type="number"
            min="0"
            step="0.1"
            value={hobbs}
            onChange={(e) => setHobbs(e.target.value)}
            required
          />
        </Field>
        <Field label="Current tach (hours)">
          <input
            type="number"
            min="0"
            step="0.1"
            value={tach}
            onChange={(e) => setTach(e.target.value)}
            required
          />
        </Field>
        {helicopter && (
          <Field label="Collective hourmeter (hours)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={cyclic}
              onChange={(e) => setCyclic(e.target.value)}
              required
            />
          </Field>
        )}
        {flightTimeLog && (
          <Field label="Current Flight time log (hours)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={flightTimeReading}
              onChange={(e) => setFlightTimeReading(e.target.value)}
              required
            />
          </Field>
        )}
        <Field label="Default maintenance time source">
          <select
            value={meter}
            onChange={(e) => switchMeter(e.target.value as Aircraft["meter"])}
          >
            <option value="hobbs">
              {helicopter ? "Run-time hourmeter (console Hobbs)" : "Hobbs"}
            </option>
            <option value="tach">Tach</option>
            {flightTimeLog && (
              <option value="flightTimeLog">Flight time log</option>
            )}
            {helicopter && <option value="cyclic">Collective hourmeter</option>}
          </select>
        </Field>
        <Field
          label="Total time adjustment (hours)"
          hint="Added to the selected meter. Positive and negative values are allowed."
        >
          <input
            type="number"
            step="0.1"
            value={adjustment}
            onChange={(e) => setAdjustment(e.target.value)}
            required
          />
        </Field>
      </div>
      <p className="callout" role="status">
        Aircraft total time:{" "}
        <strong>
          {total === undefined
            ? "Enter valid readings"
            : hours(total) + " hours"}
        </strong>
        <br />
        {aircraftMeterLabels[meter]} {reading(meter)} + adjustment {adjustment}
      </p>
      <p className="muted">
        Changing the source adjusts the offset to keep total time unchanged.
        Enter a different adjustment if the verified aircraft records require
        it.
      </p>
      <div className="form-grid">
        {turbine && (
          <Field
            label={
              initial?.model.trim().toUpperCase() === "R66"
                ? "Engine start cycles"
                : "Current cycles"
            }
          >
            <input
              name="cycles"
              type="number"
              step="1"
              min="0"
              defaultValue={initial?.cycles ?? 0}
              required
            />
          </Field>
        )}
        <Field label="Current landings">
          <input
            name="landings"
            type="number"
            step="1"
            min="0"
            defaultValue={initial?.landings ?? 0}
            required
          />
        </Field>
      </div>
      {initial && (
        <p className="muted">
          Counter changes are recorded separately from flights.
          Installed-component baselines are adjusted to preserve their
          accumulated usage.
        </p>
      )}
      {initial && <History uuid={initial.uuid} />}
    </AsyncForm>
  );
}
export function AircraftPage() {
  const [componentAircraft, setComponentAircraft] = useState<Aircraft | null>(
    null,
  );
  const { s, writable } = useFleet();
  const [selected, setSelected] = useState<Aircraft | "new" | null>(null),
    [search, setSearch] = useState("");
  const aircraft = s.aircraft.filter((a) =>
    `${a.registration} ${a.make} ${a.model} ${a.program}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="ops-page">
      <PageHeader
        eyebrow="FLEET"
        title="Aircraft"
        description="Registration, airworthiness status and meters for every aircraft you can access."
        actions={
          <>
            <Link className="button" to="/programs">
              <Buildings size={18} aria-hidden="true" /> Flight Programs
            </Link>
            {programPermission(s, "admin") && (
              <button
                className="button primary"
                disabled={!writable}
                onClick={() => setSelected("new")}
              >
                <Plus size={18} weight="bold" aria-hidden="true" /> Add aircraft
              </button>
            )}
          </>
        }
      />
      <Toolbar
        end={
          <SearchField
            label="Search aircraft"
            value={search}
            onChange={setSearch}
            placeholder="Registration or model"
          />
        }
      >
        <p className="ops-count">
          <strong>{aircraft.length}</strong>{" "}
          {aircraft.length === s.aircraft.length
            ? "aircraft"
            : `of ${s.aircraft.length} aircraft`}
        </p>
      </Toolbar>
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Aircraft records are available offline. Reconnect to add or edit.
        </NoticeBar>
      )}
      {aircraft.length ? (
        <ListCard>
          <OpsList label="Aircraft">
            {aircraft.map((a) => (
              <AircraftRow
                key={a.uuid}
                aircraft={a}
                writable={writable}
                onEdit={() => setSelected(a)}
                onAddComponent={() => setComponentAircraft(a)}
              />
            ))}
          </OpsList>
        </ListCard>
      ) : (
        <EmptyState title="No aircraft found">
          Add an aircraft with verified starting readings.
        </EmptyState>
      )}
      {componentAircraft && (
        <Modal
          title={`Add component · ${componentAircraft.registration} · Initial setup`}
          onClose={() => setComponentAircraft(null)}
        >
          <p>
            Record a component already installed on this aircraft. Later
            installations and removals go through a work order.
          </p>
          <ComponentForm
            initialAircraftUuid={componentAircraft.uuid}
            aircraftUuids={[componentAircraft.uuid]}
            onDone={() => setComponentAircraft(null)}
          />
        </Modal>
      )}
      {selected && (
        <Modal
          title={
            selected === "new"
              ? "Add aircraft"
              : `Edit ${selected.registration}`
          }
          onClose={() => setSelected(null)}
        >
          <AircraftForm
            initial={selected === "new" ? undefined : selected}
            onDone={() => setSelected(null)}
          />
          {selected !== "new" && (
            <AircraftCostSummary aircraftUuid={selected.uuid} />
          )}
        </Modal>
      )}
    </div>
  );
}
function AircraftRow({
  aircraft: a,
  writable,
  onEdit,
  onAddComponent,
}: {
  aircraft: Aircraft;
  writable: boolean;
  onEdit: () => void;
  onAddComponent: () => void;
}) {
  const { s } = useFleet();
  const status = aircraftStatus(s, a.uuid);
  const maintenance = can(s, a.uuid, "maintenance");
  const options = [
    a.helicopter && "Helicopter",
    a.twin && "Twin",
    a.turbine && "Turbine",
    a.flightTimeLog && "Flight time log",
    a.amphibious && "Amphibious",
  ]
    .filter(Boolean)
    .join(" · ");
  const meters: [string, ReactNode][] = [
    [
      "Total time source",
      <>
        {aircraftMeterLabels[a.meter]} · Adjustment {hours(a.adjustmentSeconds)}{" "}
        h
      </>,
    ],
    [
      a.helicopter ? "Run-time hourmeter / tach" : "Hobbs / tach",
      <>
        {hours(a.currentHobbs)} / {hours(a.currentTach)} h
      </>,
    ],
  ];
  if (a.flightTimeLog)
    meters.push([
      "Flight time log",
      a.currentFlightTimeLog === undefined
        ? "Not recorded"
        : `${hours(a.currentFlightTimeLog)} h`,
    ]);
  if (a.helicopter && a.currentCyclicHobbs !== undefined)
    meters.push(["Collective hourmeter", `${hours(a.currentCyclicHobbs)} h`]);
  meters.push([
    a.model.trim().toUpperCase() === "R66"
      ? "Engine starts / landings"
      : a.turbine
        ? "Cycles / landings"
        : "Landings",
    a.turbine ? `${a.cycles} / ${a.landings}` : String(a.landings),
  ]);
  meters.push(["Profile", profileLabel[a.operationalStatus]]);
  if (options) meters.push(["Options", options]);
  return (
    <OpsRow
      icon={AirplaneTilt}
      tone={statusTone[status.level]}
      title={a.registration}
      sub={
        <>
          {a.make} {a.model}
          {a.serial && <> · Serial {a.serial}</>} · {a.program || "Unassigned"}
        </>
      }
      meta={<>{hours(totalSeconds(a))} h</>}
      badge={
        <StatusPill tone={statusTone[status.level]}>
          {statusLabel[status.level]}
        </StatusPill>
      }
      actions={
        maintenance && (
          <button
            className="button small"
            disabled={!writable}
            onClick={onEdit}
          >
            Edit aircraft
          </button>
        )
      }
      extra={
        <>
          {maintenance && (
            <button
              className="button small"
              disabled={!writable}
              onClick={onAddComponent}
            >
              Add component
            </button>
          )}
          <AircraftManuals aircraftUuid={a.uuid} />
          <AircraftEngineTrends
            aircraftUuid={a.uuid}
            registration={a.registration}
          />
        </>
      }
    >
      <OpsMeters items={meters} />
      <AircraftStatusReasons
        status={status}
        label={`${a.registration} status reasons`}
      />
    </OpsRow>
  );
}
export function ProgramsPage() {
  const { s, writable } = useFleet();
  const [selected, setSelected] = useState<Program | "new" | null>(null);
  const record = selected && selected !== "new" ? selected : undefined;
  const programs = (s.programs ?? []).filter(
    (p) => s.user.isAdmin || p.uuid === s.activeProgramUuid,
  );
  return (
    <div className="ops-page">
      <PageHeader
        eyebrow="WORKSPACE"
        title="Flight Programs"
        description="Programs group aircraft, people and permissions. Switch the active program from the sidebar."
        actions={
          s.user.isAdmin && (
            <button
              className="button primary"
              disabled={!writable}
              onClick={() => setSelected("new")}
            >
              <Plus size={18} weight="bold" aria-hidden="true" /> Add Flight
              Program
            </button>
          )
        }
      />
      {programs.length ? (
        <ListCard>
          <OpsList label="Flight Programs">
            {programs.map((p) => {
              const active = p.uuid === s.activeProgramUuid;
              const website = p.website ? (
                <a href={safeHref(p.website)} target="_blank" rel="noreferrer">
                  {p.website}
                </a>
              ) : (
                "—"
              );
              return (
                <OpsRow
                  key={p.uuid}
                  icon={Buildings}
                  tone={active ? "good" : "blue"}
                  title={p.name}
                  sub={p.address || "No address recorded"}
                  badge={
                    active ? (
                      <StatusPill tone="good">Active</StatusPill>
                    ) : undefined
                  }
                  actions={
                    (s.user.isAdmin ||
                      (active && programPermission(s, "admin"))) && (
                      <button
                        className="button small"
                        disabled={!writable}
                        onClick={() => setSelected(p)}
                      >
                        Edit Flight Program
                      </button>
                    )
                  }
                >
                  <OpsMeters
                    items={[
                      ["Email", p.email || "—"],
                      ["Contact name", p.contactName || "—"],
                      ["Website", website],
                    ]}
                  />
                </OpsRow>
              );
            })}
          </OpsList>
        </ListCard>
      ) : (
        <EmptyState title="No Flight Programs yet">
          Add Flight Program details, then choose a Flight Program in the
          aircraft form.
        </EmptyState>
      )}
      {s.user.isAdmin && <ProgramTransfers />}
      {selected && (
        <ProgramDialog program={record} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/** The Add / Edit Flight Program form. Flight Programs and Settings →
 * Flight Program both open it; the backend's program.save command decides who
 * may save (system administrators, or the active program's administrators). */
export function ProgramDialog({
  program: record,
  onClose,
}: {
  program?: Program;
  onClose: () => void;
}) {
  const { s, writable, save } = useFleet();
  return (
    <Modal
      title={record ? "Edit Flight Program" : "Add Flight Program"}
      onClose={onClose}
    >
      <AsyncForm
        disabled={!writable}
        submitLabel="Save Flight Program"
        onSubmit={async (d) => {
          await save({
            action: "program.save",
            requestUuid: crypto.randomUUID(),
            reason: record ? "Program details updated." : "Program created.",
            program: {
              uuid: record?.uuid ?? crypto.randomUUID(),
              version: record?.version ?? 0,
              name: value(d, "name"),
              addressDetails: addressFromForm(d),
              address: record?.address ?? "",
              email: record?.email ?? "",
              contactName: record?.contactName ?? "",
              website: value(d, "website"),
            },
          });
          onClose();
        }}
      >
        <Field label="Flight Program name">
          <input
            name="name"
            defaultValue={record?.name}
            maxLength={150}
            required
          />
        </Field>
        <AddressFields
          label="Program address"
          name="addressDetails"
          value={record?.addressDetails}
          legacy={record?.address}
          contactName={record?.contactName}
          email={record?.email}
        />
        <Field label="Website">
          <input
            name="website"
            type="text"
            inputMode="url"
            placeholder="example.com"
            defaultValue={record?.website}
            onBlur={(e) => {
              e.currentTarget.value = normalizeWebsite(e.currentTarget.value);
            }}
          />
        </Field>
      </AsyncForm>
      {/* Another program's history is read from inside that program. */}
      {record && record.uuid === s.activeProgramUuid && (
        <History uuid={record.uuid} />
      )}
    </Modal>
  );
}

function ProgramTransfers() {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [kind, setKind] = useState<"aircraft" | "component" | "location">(
    "aircraft",
  );
  const [revision, setRevision] = useState(0);
  const records =
    kind === "aircraft"
      ? s!.aircraft.map((a) => ({ uuid: a.uuid, label: a.registration }))
      : (s!.management ?? []).flatMap((r) =>
          r.kind === kind
            ? [
                {
                  uuid: r.uuid,
                  label:
                    r.kind === "component"
                      ? `${r.componentType} · ${r.serial}`
                      : r.name,
                },
              ]
            : [],
        );
  return (
    <section className="ops-card" aria-labelledby="ops-transfer-title">
      <header className="ops-card-head">
        <IconTile icon={ArrowsLeftRight} tone="blue" size="md" />
        <div>
          <h2 id="ops-transfer-title">Transfer Flight Program</h2>
          <p>
            System administrators can assign unassigned records or transfer them
            from the active program. Aircraft transfers include their flights,
            inspections, discrepancies, and associated components. Location
            transfers include stock. Standalone component transfers require
            removal from the aircraft first.
          </p>
        </div>
      </header>
      <AsyncForm
        key={revision}
        disabled={!online || !connected}
        submitLabel="Transfer record"
        onSubmit={async (d) => {
          await backend!.transferProgram({
            kind,
            uuid: value(d, "record"),
            destination: value(d, "destination"),
            reason: value(d, "reason"),
          });
          setRevision((r) => r + 1);
          useWorkspace.setState({
            notice: "Record transferred to its destination Flight Program.",
          });
        }}
      >
        <Field label="Record type">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="aircraft">Aircraft</option>
            <option value="component">Stored component</option>
            <option value="location">Storage location</option>
          </select>
        </Field>
        <Field label="Record to transfer">
          <select key={kind} name="record" required>
            <option value="">Select record</option>
            {records.map((r) => (
              <option key={r.uuid} value={r.uuid}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Destination Flight Program">
          <select name="destination" required>
            <option value="">Select destination</option>
            {s!.programs
              ?.filter((p) => p.uuid !== s!.activeProgramUuid)
              .map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Transfer reason">
          <textarea name="reason" required maxLength={2000} />
        </Field>
      </AsyncForm>
    </section>
  );
}

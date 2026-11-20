/**
 * Responsibility: The flight plans screen: importing a flight plan PDF,
 *   reviewing and saving the parsed plan, and the saved plans and sessions.
 * Layer: UI. React components; PDF parsing runs in src/data, loaded on demand.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/flightPlanDiagnostics.ts, src/data/flightPlanPdf.ts (on demand),
 *   src/domain (model, flightPlans, pdf/icao), ./ui, ./design, ./OpsList,
 *   ./FlightSession.
 */
import {
  flightPlanImporterVersion,
  flightPlanUploadReport,
} from "../data/flightPlanDiagnostics";
import { useState, type CSSProperties } from "react";
import { useWorkspace } from "../data/store";
import { can, hours, type Snapshot } from "../domain/model";
import {
  COUNT_MAX,
  DURATION_MAX_MINUTES,
  FLIGHT_RULE_OPTIONS,
  PERSONS_MAX,
  PLACE_MAX_LENGTH,
  TEXT_MAX_LENGTH,
  durationLabel,
  flightPlanSchema,
  linkedPlanFlight,
  projectQueue,
  type FlightPlan,
} from "../domain/flightPlans";
import type { ParsedPlan } from "../domain/pdf/icao";
import { AsyncForm, Field, Modal, errorText, value } from "./ui";
import {
  Airplane,
  AirplaneTakeoff,
  CheckCircle,
  Copy,
  HourglassMedium,
  Info,
  UploadSimple,
  WifiSlash,
} from "@phosphor-icons/react";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { OpsSelect } from "./OpsList";
import { FlightSessions } from "./FlightSession";

type Draft = ParsedPlan & { sourceName: string; sourceHash: string };
type Group = ReturnType<typeof planGroups>[number];
type Dialogs = ReturnType<typeof usePlanDialogs>;
type Upload = ReturnType<typeof usePlanUpload>;
type PlanActions = {
  s: Snapshot;
  allowed: (aircraftUuid: string) => boolean;
  dialogs: Dialogs;
};

/**
 * The Flight plans screen: upload an ICAO flight plan PDF, review it, and see
 * each aircraft's queued plans with the maintenance they would reach.
 *
 * @returns The screen. Uploading and changing plans need a connection and
 *   flight access to the aircraft; maintenance projections always cover an
 *   aircraft's full queue, whatever the search.
 */
export function FlightPlans() {
  const { snapshot, online, connected } = useWorkspace();
  const s = snapshot!;
  const dialogs = usePlanDialogs();
  const upload = usePlanUpload(dialogs.setDraft);
  const [search, setSearch] = useState("");
  const allowed = (id: string) => can(s, id, "flight") && online && connected;
  return (
    <div className="ops-page">
      <PlansHeader
        upload={upload}
        disabled={upload.busy || !online || !connected || !canFly(s)}
      />
      {dialogs.flightMessage && (
        <NoticeBar tone="good" icon={CheckCircle} role="status">
          {dialogs.flightMessage}
        </NoticeBar>
      )}
      <PlanFilters
        s={s}
        dialogs={dialogs}
        search={search}
        onSearch={setSearch}
      />
      <UploadStatus upload={upload} />
      {!online && <OfflineNotice />}
      <PlansHelp />
      <PlanList s={s} allowed={allowed} dialogs={dialogs} search={search} />
      <PlanDialogs allowed={allowed} dialogs={dialogs} />
    </div>
  );
}

function PlanList(props: PlanActions & { search: string }) {
  const { s, dialogs, search } = props;
  const groups = planGroups(s, dialogs.aircraftUuid, search);
  if (!groups.length)
    return (
      <EmptyState
        title={search ? "No matching flight plans" : "No queued flight plans"}
      >
        Change your search or upload a flight plan PDF.
      </EmptyState>
    );
  return groups.map((group, index) => (
    <AircraftPlans
      key={group.aircraft.uuid}
      s={s}
      allowed={props.allowed}
      dialogs={dialogs}
      group={group}
      index={index}
    />
  ));
}

function usePlanDialogs() {
  const [aircraftUuid, setAircraftUuid] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [copying, setCopying] = useState<FlightPlan>();
  const [editing, setEditing] = useState<FlightPlan>();
  const [logging, setLogging] = useState<FlightPlan>();
  const [flightMessage, setFlightMessage] = useState("");
  const [removing, setRemoving] = useState<FlightPlan>();
  return {
    aircraftUuid,
    setAircraftUuid,
    draft,
    setDraft,
    copying,
    setCopying,
    editing,
    setEditing,
    logging,
    setLogging,
    flightMessage,
    setFlightMessage,
    removing,
    setRemoving,
  };
}

function usePlanUpload(setDraft: (draft: Draft) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");
  const [copied, setCopied] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setReport("");
    setCopied(false);
    // The stage names where a failure happened, for the upload report.
    let stage = "Load PDF importer";
    try {
      const { readFlightPlanPdf } = await import("../data/flightPlanPdf");
      const parsed = await readFlightPlanPdf(file, (next) => {
        stage = next;
      });
      stage = "Display imported plan";
      setDraft(parsed);
    } catch (e) {
      setError(
        `PDF import failed at “${stage}” (${flightPlanImporterVersion}): ${errorText(e, "Unable to read PDF.")}`,
      );
      setReport(uploadReport(e, stage, file));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, report, copied, setCopied, upload };
}

function PlansHeader({
  upload,
  disabled,
}: {
  upload: Upload;
  disabled: boolean;
}) {
  return (
    <PageHeader
      eyebrow="FLIGHT OPERATIONS"
      title="Flight"
      accent="plans"
      description="Upload an ICAO PDF, review the plan, and check maintenance across the aircraft’s queue."
      actions={
        <label className="button primary ops-file-button">
          <UploadSimple size={18} weight="bold" aria-hidden="true" />
          Upload flight plan PDF
          <input
            type="file"
            accept=".pdf,application/pdf"
            className="ops-file-input"
            aria-describedby="ops-plan-upload-hint"
            disabled={disabled}
            onChange={(e) => {
              void upload.upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      }
    />
  );
}

function PlanFilters(props: {
  s: Snapshot;
  dialogs: Dialogs;
  search: string;
  onSearch: (search: string) => void;
}) {
  return (
    <Toolbar
      end={
        <SearchField
          label="Search flight plans"
          value={props.search}
          onChange={props.onSearch}
          placeholder="Airport, date or route"
        />
      }
    >
      <OpsSelect
        label="Aircraft"
        icon={Airplane}
        value={props.dialogs.aircraftUuid}
        onChange={props.dialogs.setAircraftUuid}
      >
        <option value="">All aircraft</option>
        {props.s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration} · {a.model}
          </option>
        ))}
      </OpsSelect>
    </Toolbar>
  );
}

function UploadStatus({ upload }: { upload: Upload }) {
  return (
    <>
      {upload.busy && (
        <NoticeBar icon={HourglassMedium} role="status">
          Reading flight-plan PDF…
        </NoticeBar>
      )}
      {upload.error && (
        <p className="error" role="alert">
          {upload.error}
        </p>
      )}
      {upload.report && <UploadReport upload={upload} />}
    </>
  );
}

function UploadReport({ upload }: { upload: Upload }) {
  return (
    <div className="callout ops-upload-report">
      <p>
        The upload report identifies where this failed. Copy it for
        troubleshooting; it excludes the PDF name and contents.
      </p>
      <button
        type="button"
        className="button small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(upload.report);
            upload.setCopied(true);
          } catch {
            // Clipboard blocked: the report stays selectable below.
            upload.setCopied(false);
          }
        }}
      >
        <Copy size={16} aria-hidden="true" />
        {upload.copied ? "Report copied" : "Copy upload report"}
      </button>
      <details>
        <summary>Show upload report (or select to copy)</summary>
        <textarea
          aria-label="Upload report"
          readOnly
          rows={10}
          value={upload.report}
          onFocus={(e) => e.currentTarget.select()}
        />
      </details>
    </div>
  );
}

function OfflineNotice() {
  return (
    <NoticeBar tone="neutral" icon={WifiSlash}>
      Reconnect to upload or change plans. Cached projections use the last
      synchronized aircraft data.
    </NoticeBar>
  );
}

function PlansHelp() {
  return (
    <p className="ops-help">
      <Info size={17} aria-hidden="true" />
      <span>
        Times are UTC. Maintenance projections include the full queue for each
        aircraft, even when searching.{" "}
        <span id="ops-plan-upload-hint">
          PDF upload: the original single-page ICAO form, up to 10 MiB ·
          Importer {flightPlanImporterVersion}.
        </span>
      </span>
    </p>
  );
}

function AircraftPlans(props: PlanActions & { group: Group; index: number }) {
  const { aircraft, projections, history } = props.group;
  return (
    <section
      className="ops-plan-group flight-plan-group rise"
      style={{ "--i": props.index } as CSSProperties}
      aria-label={`${aircraft.registration} flight plans`}
    >
      <AircraftPlansHeading group={props.group} />
      {!!projections.length && <QueueTable {...props} />}
      {!!history.length && <PlanHistory {...props} />}
    </section>
  );
}

function AircraftPlansHeading({ group }: { group: Group }) {
  const { aircraft, projections, last } = group;
  return (
    <header className="ops-plan-head flight-plan-group-heading">
      <div className="ops-plan-title">
        <IconTile icon={AirplaneTakeoff} tone="blue" size="md" />
        <h2>
          {aircraft.registration} <small>{aircraft.model}</small>
        </h2>
      </div>
      <p className="ops-plan-summary">
        <span>
          <strong>{projections.length}</strong> queued
        </span>
        {last && (
          <>
            <span>
              Full queue <strong>{durationLabel(last.minutes)}</strong>
            </span>
            <span>
              Projected total <strong>{totalLabel(last.totalSeconds)}</strong>
            </span>
          </>
        )}
      </p>
    </header>
  );
}

// Only damaged data has a meter without a reading to project from.
function totalLabel(seconds: number | undefined) {
  return seconds === undefined ? "Not recorded" : <>{hours(seconds)} h</>;
}

function QueueTable(props: PlanActions & { group: Group }) {
  return (
    <div className="table-wrap flight-plan-table ops-table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            <th>Departure (UTC)</th>
            <th>Route</th>
            <th>Estimate</th>
            <th>Cumulative</th>
            <th>Maintenance requirements</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.group.projections.map((projection) => (
            <QueueRow
              key={projection.plan.uuid}
              {...props}
              projection={projection}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueueRow(
  props: PlanActions & {
    group: Group;
    projection: Group["projections"][number];
  },
) {
  const { plan: p, minutes, flags } = props.projection;
  const { aircraft } = props.group;
  return (
    <tr>
      <td data-label="Departure (UTC)">
        <span className="ops-cell-sub">{isoDate(p.departureAt)}</span>
        <strong className="ops-cell-main">{isoTime(p.departureAt)}</strong>
      </td>
      <RouteCell plan={p} registration={aircraft.registration} />
      <td className="ops-num" data-label="Estimate">
        {durationLabel(p.durationMinutes)}
        {aircraft.turbine && (
          <span className="ops-cell-sub">{p.cycles} cycles</span>
        )}
      </td>
      <td className="ops-num" data-label="Cumulative">
        {durationLabel(minutes)}
      </td>
      <td className="ops-col-flags" data-label="Maintenance requirements">
        <MaintenanceFlags flags={flags} />
      </td>
      <td className="ops-col-actions" data-label="Actions">
        <QueueActions {...props} plan={p} />
      </td>
    </tr>
  );
}

function RouteCell(props: { plan: FlightPlan; registration: string }) {
  const { plan: p } = props;
  return (
    <td className="ops-col-route" data-label="Route">
      <strong className="ops-cell-main">
        {p.origin} → {p.destination}
      </strong>
      <span className="ops-cell-sub">
        {props.registration} · {p.flightRules} · {p.level || "Level not set"}
      </span>
      <details className="ops-plan-route">
        <summary>Route</summary>
        <small>{p.route || "No route entered"}</small>
      </details>
    </td>
  );
}

function MaintenanceFlags({ flags }: { flags: string[] }) {
  if (!flags.length) return <StatusPill tone="good">No flags</StatusPill>;
  return (
    <details className="ops-plan-flags">
      <summary>
        <StatusPill tone="warn">
          {flags.length} maintenance {flags.length === 1 ? "flag" : "flags"}
        </StatusPill>
      </summary>
      <ul>
        {flags.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </details>
  );
}

function QueueActions(props: PlanActions & { plan: FlightPlan }) {
  const { plan: p, dialogs } = props;
  const disabled = !props.allowed(p.aircraftUuid);
  return (
    <div className="ops-cell-actions">
      <button
        className="button small"
        disabled={disabled}
        onClick={() => dialogs.setCopying(p)}
      >
        Copy plan
      </button>
      <PlanProgress {...props} disabled={disabled} />
    </div>
  );
}

// A plan with a flight logged or queued offers no flight, edit or removal.
function PlanProgress(
  props: PlanActions & { plan: FlightPlan; disabled: boolean },
) {
  const { plan: p, dialogs, disabled } = props;
  const { queue } = useWorkspace();
  if (linkedPlanFlight(props.s, p.uuid))
    return <StatusPill tone="warn">Flight awaiting review</StatusPill>;
  if (pendingFlight(queue, p.uuid))
    return <StatusPill>Flight pending sync</StatusPill>;
  const button = (
    className: string,
    label: string,
    open: (plan: FlightPlan) => void,
  ) => (
    <button className={className} disabled={disabled} onClick={() => open(p)}>
      {label}
    </button>
  );
  return (
    <>
      {button("button small soft", "Start / resume flight", dialogs.setLogging)}
      {button("button small", "Edit plan", dialogs.setEditing)}
      {button("button small", "Remove", dialogs.setRemoving)}
    </>
  );
}

function PlanHistory(props: PlanActions & { group: Group }) {
  const { aircraft, history } = props.group;
  return (
    <details className="ops-plan-history">
      <summary>Logged and removed plans ({history.length})</summary>
      <ul>
        {history.map((p) => (
          <li key={p.uuid}>
            <span>
              {aircraft.registration} · {isoDate(p.departureAt)} · {p.origin} →{" "}
              {p.destination} ·{" "}
              {linkedPlanFlight(props.s, p.uuid)?.status === "accepted"
                ? "Logged"
                : "Removed"}
            </span>{" "}
            <button
              className="button small"
              disabled={!props.allowed(p.aircraftUuid)}
              onClick={() => props.dialogs.setCopying(p)}
            >
              Copy plan
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlanDialogs(props: {
  allowed: (aircraftUuid: string) => boolean;
  dialogs: Dialogs;
}) {
  const d = props.dialogs;
  return (
    <>
      {(d.draft || d.editing) && <ReviewPlanDialog dialogs={d} />}
      {d.copying && <CopyPlanDialog dialogs={d} plan={d.copying} />}
      {d.logging && (
        <FlightSessions
          plan={d.logging}
          onClose={() => d.setLogging(undefined)}
          onSaved={() => {
            d.setLogging(undefined);
            d.setFlightMessage(
              "Preflight saved in this browser. Use Start / resume flight on this plan, or End flight in the Flight log, to enter closing readings.",
            );
          }}
        />
      )}
      {d.removing && (
        <RemovePlanDialog
          plan={d.removing}
          disabled={!props.allowed(d.removing.aircraftUuid)}
          onClose={() => d.setRemoving(undefined)}
        />
      )}
    </>
  );
}

function CopyPlanDialog({
  dialogs: d,
  plan,
}: {
  dialogs: Dialogs;
  plan: FlightPlan;
}) {
  return (
    <Modal title="Copy flight plan" onClose={() => d.setCopying(undefined)}>
      <PlanForm
        draft={{ ...plan, copiedFromUuid: plan.uuid }}
        copying
        onDone={(id) => {
          d.setAircraftUuid(id);
          d.setCopying(undefined);
        }}
      />
    </Modal>
  );
}

function ReviewPlanDialog({ dialogs: d }: { dialogs: Dialogs }) {
  const close = () => {
    d.setDraft(undefined);
    d.setEditing(undefined);
  };
  return (
    <Modal
      title={d.editing ? "Edit flight plan" : "Review imported flight plan"}
      onClose={close}
    >
      <PlanForm
        draft={d.draft ?? d.editing!}
        initial={d.editing}
        onDone={(id) => {
          d.setAircraftUuid(id);
          close();
        }}
      />
    </Modal>
  );
}

// Removing cancels the plan rather than deleting it, so it stays in the
// aircraft's history.
function RemovePlanDialog(props: {
  plan: FlightPlan;
  disabled: boolean;
  onClose: () => void;
}) {
  const { backend } = useWorkspace();
  const { plan } = props;
  return (
    <Modal title="Remove proposed flight" onClose={props.onClose}>
      <AsyncForm
        submitLabel="Remove from queue"
        disabled={props.disabled}
        onSubmit={async () => {
          await backend!.savePlan({
            plan: { ...plan, status: "cancelled" },
            baseVersion: plan.version,
          });
          props.onClose();
        }}
      >
        <p>
          Remove {plan.origin} → {plan.destination} from the queue? Its estimate
          will no longer count toward maintenance projections.
        </p>
      </AsyncForm>
    </Modal>
  );
}

type PlanFormProps = {
  draft: Draft | FlightPlan;
  initial?: FlightPlan;
  copying?: boolean;
  onDone: (id: string) => void;
};

function PlanForm({ draft, initial, copying = false, onDone }: PlanFormProps) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const aircraft = s.aircraft.filter((a) => can(s, a.uuid, "flight"));
  const [selected, setSelected] = useState(
    initial?.aircraftUuid ?? defaultAircraft(draft, aircraft, copying),
  );
  const selectedAircraft = aircraft.find((a) => a.uuid === selected);
  const [uuid] = useState(() => initial?.uuid ?? crypto.randomUUID());
  return (
    <AsyncForm
      submitLabel={copying ? "Save copy" : "Save flight plan"}
      disabled={!online || !connected}
      onSubmit={async (data) => {
        const plan = flightPlanSchema.parse(
          planFrom(data, { draft, initial, uuid, selected, selectedAircraft }),
        );
        await backend!.savePlan({ plan, baseVersion: initial?.version ?? 0 });
        onDone(selected);
      }}
    >
      <PlanSource draft={draft} copying={copying} unmatched={!selected} />
      <div className="form-grid">
        <AircraftField
          aircraft={aircraft}
          selected={selected}
          locked={!!initial || copying}
          onChange={setSelected}
        />
        <PlanTimeFields draft={draft} copying={copying} />
        <PlanPlaceFields draft={draft} />
        <PlanCountFields draft={draft} turbine={!!selectedAircraft?.turbine} />
        <PlanCruiseFields draft={draft} />
      </div>
      <PlanNotes draft={draft} aircraft={selectedAircraft} />
    </AsyncForm>
  );
}

function AircraftField(props: {
  aircraft: Snapshot["aircraft"];
  selected: string;
  locked: boolean;
  onChange: (uuid: string) => void;
}) {
  return (
    <Field label="Aircraft">
      <select
        required
        value={props.selected}
        disabled={props.locked}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">Select aircraft</option>
        {props.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PlanSource(props: {
  draft: Draft | FlightPlan;
  copying: boolean;
  unmatched: boolean;
}) {
  const { draft } = props;
  return (
    <>
      <p className="callout">
        {props.copying
          ? "Review the copied plan and set the flight date and departure time before saving. "
          : ""}
        {draft.sourceName} · Original aircraft:{" "}
        <strong>{draft.registration || "Not found"}</strong>. Review the
        extracted values. Cycles and landings default to one; confirm them for
        this flight. All times below are UTC.
      </p>
      {props.unmatched && (
        <p className="callout">
          No unique aircraft match. Select an aircraft from your active Flight
          Program.
        </p>
      )}
    </>
  );
}

function PlanTimeFields(props: {
  draft: Draft | FlightPlan;
  copying: boolean;
}) {
  const { draft } = props;
  return (
    <>
      <Field label="Flight date (UTC)">
        <input
          name="date"
          type="date"
          required
          // A copy is for another day, so its date starts blank.
          defaultValue={props.copying ? "" : isoDate(draft.departureAt)}
        />
      </Field>
      <Field label="Departure time (UTC)">
        <input
          name="time"
          type="time"
          required
          defaultValue={isoTime(draft.departureAt)}
        />
      </Field>
    </>
  );
}

function PlanPlaceFields({ draft }: { draft: Draft | FlightPlan }) {
  return (
    <>
      {(["origin", "destination"] as const).map((place) => (
        <Field
          key={place}
          label={
            place === "origin" ? "Departure airport" : "Destination airport"
          }
        >
          <input
            name={place}
            required
            maxLength={PLACE_MAX_LENGTH}
            defaultValue={draft[place]}
          />
        </Field>
      ))}
      <Field label="Alternate airport">
        <input name="alternate" defaultValue={draft.alternate} />
      </Field>
    </>
  );
}

function PlanCountFields(props: {
  draft: Draft | FlightPlan;
  turbine: boolean;
}) {
  const { draft } = props;
  return (
    <>
      <DurationField draft={draft} />
      {props.turbine && (
        <Field label="Estimated cycles">
          {countInput("cycles", "cycles" in draft ? draft.cycles : 1)}
        </Field>
      )}
      <Field label="Estimated landings">
        {countInput("landings", "landings" in draft ? draft.landings : 1)}
      </Field>
      <Field label="Flight rules">
        <select name="rules" required defaultValue={draft.flightRules ?? ""}>
          <option value="">Select flight rules</option>
          {FLIGHT_RULE_OPTIONS.map(([rule, label]) => (
            <option key={rule} value={rule}>
              {label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function DurationField({ draft }: { draft: Draft | FlightPlan }) {
  return (
    <Field
      label="Estimated flight duration (minutes)"
      hint={
        draft.durationMinutes
          ? durationLabel(draft.durationMinutes)
          : "Not found in PDF; enter the planned duration."
      }
    >
      <input
        name="duration"
        type="number"
        min="1"
        max={String(DURATION_MAX_MINUTES)}
        step="1"
        required
        defaultValue={draft.durationMinutes}
      />
    </Field>
  );
}

// A plain element, not a component, so Field can give it the label's id.
function countInput(name: string, initial: number) {
  return (
    <input
      name={name}
      type="number"
      min="0"
      max={String(COUNT_MAX)}
      step="1"
      required
      defaultValue={initial}
    />
  );
}

function PlanCruiseFields({ draft }: { draft: Draft | FlightPlan }) {
  return (
    <>
      <Field label="Cruising speed">
        <input name="speed" defaultValue={draft.speed} />
      </Field>
      <Field label="Cruising level">
        <input name="level" defaultValue={draft.level} />
      </Field>
      <Field label="Fuel endurance (minutes)">
        <input
          name="endurance"
          type="number"
          min="0"
          max={String(DURATION_MAX_MINUTES)}
          step="1"
          defaultValue={draft.enduranceMinutes}
        />
      </Field>
      <Field label="Persons onboard">
        <input
          name="persons"
          type="number"
          min="0"
          max={String(PERSONS_MAX)}
          step="1"
          defaultValue={draft.personsOnBoard}
        />
      </Field>
    </>
  );
}

function PlanNotes(props: {
  draft: Draft | FlightPlan;
  aircraft?: Snapshot["aircraft"][number];
}) {
  const { draft, aircraft } = props;
  const mismatch =
    !!aircraft && !sameRegistration(aircraft.registration, draft.registration);
  return (
    <>
      {mismatch && (
        <Field label="Aircraft differs from the PDF: confirm reassignment">
          <input type="checkbox" required />
        </Field>
      )}
      <Field label="Planned route">
        <textarea
          name="route"
          maxLength={TEXT_MAX_LENGTH}
          defaultValue={draft.route}
        />
      </Field>
      <Field
        label="Pilot information from PDF"
        hint="Select the actual pilot account when logging the flight."
      >
        <input
          name="pilot"
          maxLength={TEXT_MAX_LENGTH}
          defaultValue={draft.pilotText}
        />
      </Field>
      <ImportedDetails draft={draft} />
    </>
  );
}

function ImportedDetails({ draft }: { draft: Draft | FlightPlan }) {
  return (
    <details>
      <summary>Additional imported information</summary>
      <p>
        Aircraft type: {draft.aircraftType} · Flight type: {draft.flightType} ·
        Equipment: {draft.equipment}
      </p>
      <p>{draft.otherInformation}</p>
    </details>
  );
}

// Groups by aircraft (by registration) the queued plans that match the
// search, and the logged or removed ones. The projection runs over the full
// queue before filtering so search cannot hide maintenance exposure.
function planGroups(s: Snapshot, aircraftUuid: string, search: string) {
  return s.aircraft
    .filter((a) => !aircraftUuid || a.uuid === aircraftUuid)
    .sort((a, b) => a.registration.localeCompare(b.registration))
    .map((a) => {
      const full = projectQueue(s, a.uuid);
      const queued = new Set(full.map((p) => p.plan.uuid));
      const found = (p: FlightPlan) => matchesSearch(p, a.registration, search);
      return {
        aircraft: a,
        last: full.at(-1),
        projections: full.filter(({ plan }) => found(plan)),
        history: (s.flightPlans ?? []).filter(
          (p) => p.aircraftUuid === a.uuid && !queued.has(p.uuid) && found(p),
        ),
      };
    })
    .filter((g) => g.projections.length || g.history.length);
}

// Every search word must appear in the plan's registration, airports,
// route, departure or pilot text.
function matchesSearch(p: FlightPlan, registration: string, search: string) {
  const text =
    `${registration} ${p.origin} ${p.destination} ${p.alternate} ${p.route} ${p.departureAt} ${p.pilotText}`.toLowerCase();
  return search
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => text.includes(term));
}

function pendingFlight(
  queue: ReturnType<typeof useWorkspace.getState>["queue"],
  planUuid: string,
) {
  return queue.some(
    (q) =>
      q.operation.kind === "flight" &&
      q.operation.input.flightPlanUuid === planUuid,
  );
}

function canFly(s: Snapshot) {
  return s.aircraft.some((a) => can(s, a.uuid, "flight"));
}

function uploadReport(error: unknown, stage: string, file: File) {
  return flightPlanUploadReport(
    error,
    stage,
    file,
    navigator.userAgent,
    import.meta.url,
  );
}

// Registrations compare without case, dashes or spaces: "N-206MA" is N206MA.
function sameRegistration(a: string, b: string) {
  const normalized = (r: string) => r.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized(a) === normalized(b);
}

// A copy keeps its aircraft; an import picks the one aircraft whose
// registration matches the PDF, or none.
function defaultAircraft(
  draft: Draft | FlightPlan,
  aircraft: Snapshot["aircraft"],
  copying: boolean,
) {
  if (copying && "aircraftUuid" in draft) return draft.aircraftUuid;
  const matches = aircraft.filter((a) =>
    sameRegistration(a.registration, draft.registration),
  );
  return matches.length === 1 ? matches[0].uuid : "";
}

function planFrom(
  data: FormData,
  c: {
    draft: Draft | FlightPlan;
    initial?: FlightPlan;
    uuid: string;
    selected: string;
    selectedAircraft?: Snapshot["aircraft"][number];
  },
) {
  const optionalNumber = (key: string) =>
    value(data, key) === "" ? undefined : Number(value(data, key));
  return {
    ...c.draft,
    uuid: c.uuid,
    version: c.initial?.version ?? 0,
    aircraftUuid: c.selected,
    departureAt: `${value(data, "date")}T${value(data, "time")}:00Z`,
    origin: value(data, "origin"),
    destination: value(data, "destination"),
    alternate: value(data, "alternate"),
    durationMinutes: Number(value(data, "duration")),
    cycles: c.selectedAircraft?.turbine
      ? Number(value(data, "cycles"))
      : (c.initial?.cycles ?? 0),
    landings: Number(value(data, "landings")),
    flightRules: value(data, "rules"),
    speed: value(data, "speed"),
    level: value(data, "level"),
    route: value(data, "route"),
    pilotText: value(data, "pilot"),
    enduranceMinutes: optionalNumber("endurance"),
    personsOnBoard: optionalNumber("persons"),
    status: "proposed",
    createdAt: c.initial?.createdAt ?? Date.now(),
  };
}

function isoDate(iso: string) {
  return iso.slice(0, 10);
}

function isoTime(iso: string) {
  return iso.slice(11, 16);
}

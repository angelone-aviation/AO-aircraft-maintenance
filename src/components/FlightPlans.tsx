import {
  flightPlanImporterVersion,
  flightPlanUploadReport,
} from "../data/flightPlanDiagnostics";
import { useState, type CSSProperties } from "react";
import { useWorkspace } from "../data/store";
import { can, hours } from "../domain/model";
import {
  durationLabel,
  flightPlanSchema,
  linkedPlanFlight,
  projectQueue,
  type FlightPlan,
} from "../domain/flightPlans";
import type { ParsedPlan } from "../domain/pdf/icao";
import { AsyncForm, Field, Modal, value } from "./ui";
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
export function FlightPlans() {
  const { snapshot: state, backend, online, connected, queue } = useWorkspace();
  const s = state!;
  const [aircraftUuid, setAircraftUuid] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [copying, setCopying] = useState<FlightPlan>();
  const [editing, setEditing] = useState<FlightPlan>();
  const [logging, setLogging] = useState<FlightPlan>();
  const [flightMessage, setFlightMessage] = useState("");
  const [removing, setRemoving] = useState<FlightPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadReport, setUploadReport] = useState("");
  const [reportCopied, setReportCopied] = useState(false);
  const [search, setSearch] = useState("");
  const allowed = (id: string) => can(s, id, "flight") && online && connected;
  const matches = (p: FlightPlan, registration: string) => {
    const text =
      `${registration} ${p.origin} ${p.destination} ${p.alternate} ${p.route} ${p.departureAt} ${p.pilotText}`.toLowerCase();
    return search
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .every((term) => text.includes(term));
  };
  const groups = s.aircraft
    .filter((a) => !aircraftUuid || a.uuid === aircraftUuid)
    .sort((a, b) => a.registration.localeCompare(b.registration))
    .map((a) => {
      // Calculate the full queue before filtering so search cannot hide maintenance exposure.
      const full = projectQueue(s, a.uuid);
      const queued = new Set(full.map((p) => p.plan.uuid));
      return {
        aircraft: a,
        last: full.at(-1),
        projections: full.filter(({ plan }) => matches(plan, a.registration)),
        history: (s.flightPlans ?? []).filter(
          (p) =>
            p.aircraftUuid === a.uuid &&
            !queued.has(p.uuid) &&
            matches(p, a.registration),
        ),
      };
    })
    .filter((g) => g.projections.length || g.history.length);
  const pending = (id: string) =>
    queue.some(
      (q) =>
        q.operation.kind === "flight" &&
        q.operation.input.flightPlanUuid === id,
    );
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    setUploadReport("");
    setReportCopied(false);
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
        `PDF import failed at “${stage}” (${flightPlanImporterVersion}): ${e instanceof Error ? e.message : "Unable to read PDF."}`,
      );
      setUploadReport(
        flightPlanUploadReport(
          e,
          stage,
          file,
          navigator.userAgent,
          import.meta.url,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const uploadDisabled =
    busy ||
    !online ||
    !connected ||
    !s.aircraft.some((a) => can(s, a.uuid, "flight"));
  return (
    <div className="ops-page">
      <PageHeader
        eyebrow="FLIGHT OPERATIONS"
        title="Flight plans"
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
              disabled={uploadDisabled}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        }
      />
      {flightMessage && (
        <NoticeBar tone="good" icon={CheckCircle} role="status">
          {flightMessage}
        </NoticeBar>
      )}
      <Toolbar
        end={
          <SearchField
            label="Search flight plans"
            value={search}
            onChange={setSearch}
            placeholder="Airport, date or route"
          />
        }
      >
        <OpsSelect
          label="Aircraft"
          icon={Airplane}
          value={aircraftUuid}
          onChange={setAircraftUuid}
        >
          <option value="">All aircraft</option>
          {s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration} · {a.model}
            </option>
          ))}
        </OpsSelect>
      </Toolbar>
      {busy && (
        <NoticeBar icon={HourglassMedium} role="status">
          Reading flight-plan PDF…
        </NoticeBar>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {uploadReport && (
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
                await navigator.clipboard.writeText(uploadReport);
                setReportCopied(true);
              } catch {
                setReportCopied(false);
              }
            }}
          >
            <Copy size={16} aria-hidden="true" />
            {reportCopied ? "Report copied" : "Copy upload report"}
          </button>
          <details>
            <summary>Show upload report (or select to copy)</summary>
            <textarea
              aria-label="Upload report"
              readOnly
              rows={10}
              value={uploadReport}
              onFocus={(e) => e.currentTarget.select()}
            />
          </details>
        </div>
      )}
      {!online && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Reconnect to upload or change plans. Cached projections use the last
          synchronized aircraft data.
        </NoticeBar>
      )}
      <p className="ops-help">
        <Info size={17} aria-hidden="true" />
        <span>
          Times are UTC. Maintenance projections include the full queue for each
          aircraft, even when searching.{" "}
          <span id="ops-plan-upload-hint">
            PDF upload: the original single-page ICAO form, up to 10 MB ·
            Importer {flightPlanImporterVersion}.
          </span>
        </span>
      </p>
      {!groups.length && (
        <EmptyState
          title={search ? "No matching flight plans" : "No queued flight plans"}
        >
          Change your search or upload a flight plan PDF.
        </EmptyState>
      )}
      {groups.map(({ aircraft, projections, history, last }, index) => (
        <section
          className="ops-plan-group flight-plan-group rise"
          style={{ "--i": index } as CSSProperties}
          key={aircraft.uuid}
          aria-label={`${aircraft.registration} flight plans`}
        >
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
                    Projected total{" "}
                    <strong>{hours(last.totalSeconds)} h</strong>
                  </span>
                </>
              )}
            </p>
          </header>
          {!!projections.length && (
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
                  {projections.map(({ plan: p, minutes, flags }) => {
                    const linked = linkedPlanFlight(s, p.uuid);
                    return (
                      <tr key={p.uuid}>
                        <td data-label="Departure (UTC)">
                          <span className="ops-cell-sub">
                            {p.departureAt.slice(0, 10)}
                          </span>
                          <strong className="ops-cell-main">
                            {p.departureAt.slice(11, 16)}
                          </strong>
                        </td>
                        <td className="ops-col-route" data-label="Route">
                          <strong className="ops-cell-main">
                            {p.origin} → {p.destination}
                          </strong>
                          <span className="ops-cell-sub">
                            {aircraft.registration} · {p.flightRules} ·{" "}
                            {p.level || "Level not set"}
                          </span>
                          <details className="ops-plan-route">
                            <summary>Route</summary>
                            <small>{p.route || "No route entered"}</small>
                          </details>
                        </td>
                        <td className="ops-num" data-label="Estimate">
                          {durationLabel(p.durationMinutes)}
                          {aircraft.turbine && (
                            <span className="ops-cell-sub">
                              {p.cycles} cycles
                            </span>
                          )}
                        </td>
                        <td className="ops-num" data-label="Cumulative">
                          {durationLabel(minutes)}
                        </td>
                        <td
                          className="ops-col-flags"
                          data-label="Maintenance requirements"
                        >
                          {flags.length ? (
                            <details className="ops-plan-flags">
                              <summary>
                                <StatusPill tone="warn">
                                  {flags.length} maintenance{" "}
                                  {flags.length === 1 ? "flag" : "flags"}
                                </StatusPill>
                              </summary>
                              <ul>
                                {flags.map((f, i) => (
                                  <li key={i}>{f}</li>
                                ))}
                              </ul>
                            </details>
                          ) : (
                            <StatusPill tone="good">No flags</StatusPill>
                          )}
                        </td>
                        <td className="ops-col-actions" data-label="Actions">
                          <div className="ops-cell-actions">
                            <button
                              className="button small"
                              disabled={!allowed(p.aircraftUuid)}
                              onClick={() => setCopying(p)}
                            >
                              Copy plan
                            </button>
                            {linked ? (
                              <StatusPill tone="warn">
                                Flight awaiting review
                              </StatusPill>
                            ) : pending(p.uuid) ? (
                              <StatusPill>Flight pending sync</StatusPill>
                            ) : (
                              <>
                                <button
                                  className="button small soft"
                                  disabled={!allowed(p.aircraftUuid)}
                                  onClick={() => setLogging(p)}
                                >
                                  Start / resume flight
                                </button>
                                <button
                                  className="button small"
                                  disabled={!allowed(p.aircraftUuid)}
                                  onClick={() => setEditing(p)}
                                >
                                  Edit plan
                                </button>
                                <button
                                  className="button small"
                                  disabled={!allowed(p.aircraftUuid)}
                                  onClick={() => setRemoving(p)}
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!!history.length && (
            <details className="ops-plan-history">
              <summary>Logged and removed plans ({history.length})</summary>
              <ul>
                {history.map((p) => (
                  <li key={p.uuid}>
                    <span>
                      {aircraft.registration} · {p.departureAt.slice(0, 10)} ·{" "}
                      {p.origin} → {p.destination} ·{" "}
                      {linkedPlanFlight(s, p.uuid)?.status === "accepted"
                        ? "Logged"
                        : "Removed"}
                    </span>{" "}
                    <button
                      className="button small"
                      disabled={!allowed(p.aircraftUuid)}
                      onClick={() => setCopying(p)}
                    >
                      Copy plan
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
      {(draft || editing) && (
        <Modal
          title={editing ? "Edit flight plan" : "Review imported flight plan"}
          onClose={() => {
            setDraft(undefined);
            setEditing(undefined);
          }}
        >
          <PlanForm
            draft={draft ?? editing!}
            initial={editing}
            onDone={(id) => {
              setAircraftUuid(id);
              setDraft(undefined);
              setEditing(undefined);
            }}
          />
        </Modal>
      )}
      {copying && (
        <Modal title="Copy flight plan" onClose={() => setCopying(undefined)}>
          <PlanForm
            draft={{ ...copying, copiedFromUuid: copying.uuid }}
            copying
            onDone={(id) => {
              setAircraftUuid(id);
              setCopying(undefined);
            }}
          />
        </Modal>
      )}
      {logging && (
        <FlightSessions
          plan={logging}
          onClose={() => setLogging(undefined)}
          onSaved={() => {
            setLogging(undefined);
            setFlightMessage(
              "Preflight saved in this browser. Use Start / resume flight on this plan, or End flight in the Flight log, to enter closing readings.",
            );
          }}
        />
      )}
      {removing && (
        <Modal
          title="Remove proposed flight"
          onClose={() => setRemoving(undefined)}
        >
          <AsyncForm
            submitLabel="Remove from queue"
            disabled={!allowed(removing.aircraftUuid)}
            onSubmit={async () => {
              await backend!.savePlan({
                plan: { ...removing, status: "cancelled" },
                baseVersion: removing.version,
              });
              setRemoving(undefined);
            }}
          >
            <p>
              Remove {removing.origin} → {removing.destination} from the queue?
              Its estimate will no longer count toward maintenance projections.
            </p>
          </AsyncForm>
        </Modal>
      )}
    </div>
  );
}
function PlanForm({
  draft,
  initial,
  copying = false,
  onDone,
}: {
  draft: Draft | FlightPlan;
  initial?: FlightPlan;
  copying?: boolean;
  onDone: (id: string) => void;
}) {
  const { snapshot: state, backend, online, connected } = useWorkspace();
  const s = state!;
  const aircraft = s.aircraft.filter((a) => can(s, a.uuid, "flight"));
  const normalized = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const matches = aircraft.filter(
    (a) => normalized(a.registration) === normalized(draft.registration),
  );
  const [selected, setSelected] = useState(
    initial?.aircraftUuid ??
      (copying && "aircraftUuid" in draft
        ? draft.aircraftUuid
        : matches.length === 1
          ? matches[0].uuid
          : ""),
  );
  const selectedAircraft = aircraft.find((a) => a.uuid === selected);
  const mismatch =
    !!selectedAircraft &&
    normalized(selectedAircraft.registration) !==
      normalized(draft.registration);
  const [uuid] = useState(() => initial?.uuid ?? crypto.randomUUID());
  return (
    <AsyncForm
      submitLabel={copying ? "Save copy" : "Save flight plan"}
      disabled={!online || !connected}
      onSubmit={async (data) => {
        const optionalNumber = (key: string) =>
          value(data, key) === "" ? undefined : Number(value(data, key));
        const plan = flightPlanSchema.parse({
          ...draft,
          uuid,
          version: initial?.version ?? 0,
          aircraftUuid: selected,
          departureAt: `${value(data, "date")}T${value(data, "time")}:00Z`,
          origin: value(data, "origin"),
          destination: value(data, "destination"),
          alternate: value(data, "alternate"),
          durationMinutes: Number(value(data, "duration")),
          cycles: selectedAircraft?.turbine
            ? Number(value(data, "cycles"))
            : (initial?.cycles ?? 0),
          landings: Number(value(data, "landings")),
          flightRules: value(data, "rules"),
          speed: value(data, "speed"),
          level: value(data, "level"),
          route: value(data, "route"),
          pilotText: value(data, "pilot"),
          enduranceMinutes: optionalNumber("endurance"),
          personsOnBoard: optionalNumber("persons"),
          status: "proposed",
          createdAt: initial?.createdAt ?? Date.now(),
        });
        await backend!.savePlan({ plan, baseVersion: initial?.version ?? 0 });
        onDone(selected);
      }}
    >
      <p className="callout">
        {copying
          ? "Review the copied plan and set the flight date and departure time before saving. "
          : ""}
        {draft.sourceName} · Original aircraft:{" "}
        <strong>{draft.registration || "Not found"}</strong>. Review the
        extracted values. Cycles and landings default to one; confirm them for
        this flight. All times below are UTC.
      </p>
      {!selected && (
        <p className="callout">
          No unique aircraft match. Select an aircraft from your active Flight
          Program.
        </p>
      )}
      <div className="form-grid">
        <Field label="Aircraft">
          <select
            required
            value={selected}
            disabled={!!initial || copying}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select aircraft</option>
            {aircraft.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Flight date (UTC)">
          <input
            name="date"
            type="date"
            required
            defaultValue={copying ? "" : draft.departureAt.slice(0, 10)}
          />
        </Field>
        <Field label="Departure time (UTC)">
          <input
            name="time"
            type="time"
            required
            defaultValue={draft.departureAt.slice(11, 16)}
          />
        </Field>
        <Field label="Departure airport">
          <input
            name="origin"
            required
            maxLength={100}
            defaultValue={draft.origin}
          />
        </Field>
        <Field label="Destination airport">
          <input
            name="destination"
            required
            maxLength={100}
            defaultValue={draft.destination}
          />
        </Field>
        <Field label="Alternate airport">
          <input name="alternate" defaultValue={draft.alternate} />
        </Field>
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
            max="5999"
            step="1"
            required
            defaultValue={draft.durationMinutes}
          />
        </Field>
        {selectedAircraft?.turbine && (
          <Field label="Estimated cycles">
            <input
              name="cycles"
              type="number"
              min="0"
              max="1000"
              step="1"
              required
              defaultValue={"cycles" in draft ? draft.cycles : 1}
            />
          </Field>
        )}
        <Field label="Estimated landings">
          <input
            name="landings"
            type="number"
            min="0"
            max="1000"
            step="1"
            required
            defaultValue={"landings" in draft ? draft.landings : 1}
          />
        </Field>
        <Field label="Flight rules">
          <select name="rules" required defaultValue={draft.flightRules ?? ""}>
            <option value="">Select flight rules</option>
            <option value="I">IFR</option>
            <option value="V">VFR</option>
            <option value="Y">IFR then VFR</option>
            <option value="Z">VFR then IFR</option>
          </select>
        </Field>
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
            max="5999"
            step="1"
            defaultValue={draft.enduranceMinutes}
          />
        </Field>
        <Field label="Persons onboard">
          <input
            name="persons"
            type="number"
            min="0"
            max="999"
            step="1"
            defaultValue={draft.personsOnBoard}
          />
        </Field>
      </div>
      {mismatch && (
        <Field label="Aircraft differs from the PDF: confirm reassignment">
          <input type="checkbox" required />
        </Field>
      )}
      <Field label="Planned route">
        <textarea name="route" maxLength={5000} defaultValue={draft.route} />
      </Field>
      <Field
        label="Pilot information from PDF"
        hint="Select the actual pilot account when logging the flight."
      >
        <input name="pilot" maxLength={5000} defaultValue={draft.pilotText} />
      </Field>
      <details>
        <summary>Additional imported information</summary>
        <p>
          Aircraft type: {draft.aircraftType} · Flight type: {draft.flightType}{" "}
          · Equipment: {draft.equipment}
        </p>
        <p>{draft.otherInformation}</p>
      </details>
    </AsyncForm>
  );
}

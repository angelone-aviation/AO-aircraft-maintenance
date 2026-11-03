import { ADTrackingFields } from "./ADTrackingFields";
import { localDate } from "../domain/model";
import { ADWorkOrderButton } from "./ADWorkOrderButton";
import { isPilotView } from "../domain/pilotView";
import { adRemaining } from "../domain/adRemaining";
import { memberLicense } from "../domain/certifications";
import { PartsAvailability } from "./RequiredParts";
import { RequestPartsButton } from "./PartsRequests";
import { monitoringReviewCandidates } from "../domain/faaCandidateReview";
import { monitoringScope } from "../domain/faaMonitoringSearch";
import { ADRegister } from "./ADRegister";
import { FaaSearchImport } from "./FaaSearchImport";
import { FaaKeySettings } from "./FaaKeySettings";
import { emptyMonitor, faaSearchTerms, type FaaCandidate } from "../domain/faa";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { programPermission } from "../domain/programs";
import {
  adAircraftUuid,
  adNumber,
  adSaveIsCorrection,
  adStatus,
  adTaskStatus,
  blankAD,
  blankADTask,
  clearInitialLimits,
  effectiveCompliance,
  initialLimitClearReason,
  staleInitialLimitNotice,
  staleInitialLimits,
  type AD,
  type ADCompliance,
  type ADSource,
  type StaleInitialLimit,
} from "../domain/airworthiness";
import { importADDocx, type ADImport } from "../data/adImport";
import { Field, Modal, safeHref } from "./ui";
import {
  Airplane,
  ArrowsClockwise,
  CaretDown,
  CheckCircle,
  DotsThree,
  FileDoc,
  FilePdf,
  Info,
  Key,
  Plus,
  Printer,
  Warning,
} from "@phosphor-icons/react";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  StatsStrip,
  StatTile,
  Toolbar,
} from "./design";
import { OpsSelect } from "./OpsList";
const groupKey = (e: ADSource) => [e.section, e.make, e.model].join(" / ");
export function ADAlerts({ aircraftUuid }: { aircraftUuid?: string }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const pilotView = isPilotView(s);
  const rows = (s.airworthiness ?? []).filter(
    (r) =>
      (!aircraftUuid || adAircraftUuid(s, r) === aircraftUuid) &&
      ![
        "Complied",
        "Previously Complied With (PCW)",
        "Not applicable",
        "Superseded",
        "Scheduled",
        "Removed component",
      ].includes(adStatus(s, r)),
  );
  const pending = (s.faaMonitors ?? [])
    .filter((m) => !aircraftUuid || m.aircraftUuid === aircraftUuid)
    .reduce(
      (n, m) =>
        n +
        monitoringReviewCandidates(s, m.aircraftUuid, m.candidates).filter(
          (c) => !c.reviewReason,
        ).length,
      0,
    );
  return (
    <div>
      <h3>Airworthiness directives</h3>
      {pending > 0 && (
        <p>
          {pilotView ? (
            `${pending} FAA document(s) awaiting maintenance review.`
          ) : (
            <Link to="/airworthiness">
              {pending} new or changed FAA documents need review
            </Link>
          )}
        </p>
      )}
      {rows.length ? (
        rows.map((r) => (
          <div className="list-row" key={r.uuid}>
            <span>
              {pilotView ? (
                <span>
                  {
                    s.aircraft.find((a) => a.uuid === r.aircraftUuid)
                      ?.registration
                  }{" "}
                  · AD {r.source.number}
                </span>
              ) : (
                <Link to="/airworthiness">
                  {
                    s.aircraft.find((a) => a.uuid === r.aircraftUuid)
                      ?.registration
                  }{" "}
                  · AD {r.source.number}
                </Link>
              )}
              {staleInitialLimits(r).map((stale) => (
                <small className="ad-stale-limit" key={stale.taskUuid}>
                  {staleInitialLimitNotice(r, stale)}
                </small>
              ))}
            </span>
            <strong>{adStatus(s, r)}</strong>
          </div>
        ))
      ) : (
        <p>No AD alerts in recorded data.</p>
      )}
      {!pilotView && (
        <Link to="/airworthiness">Manage ADs and compliance reports</Link>
      )}
    </div>
  );
}
export function Airworthiness() {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const state = s!;
  const [aircraft, setAircraft] = useState(state.aircraft[0]?.uuid ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewUuid, setViewUuid] = useState<string | null>(null);
  const [draft, setDraft] = useState<AD | null>(null);
  const [preview, setPreview] = useState<ADImport | null>(null);
  const [assign, setAssign] = useState<Record<string, string[]>>({});
  const [draftReason, setDraftReason] = useState("");
  // A new compliance entry, or (with corrects) a correction of one.
  const [compliance, setCompliance] = useState<{
    record: AD;
    entry: ADCompliance;
    corrects?: string;
    reason?: string;
  } | null>(null);
  const [clearing, setClearing] = useState<{
    record: AD;
    stale: StaleInitialLimit;
    reason: string;
  } | null>(null);
  const editable =
    can(state, aircraft, "maintenance") && (demo || (online && connected));
  const aircraftRecord = state.aircraft.find((a) => a.uuid === aircraft);
  // Correcting recorded compliance is for Flight Program administrators.
  const correctable =
    editable && programPermission(state, "admin", aircraftRecord?.programUuid);
  const openDraft = (r: AD) => {
    setDraftReason("");
    setDraft(r);
  };
  const clearLimit = (record: AD, stale: StaleInitialLimit) => {
    setError("");
    setViewUuid(null);
    setClearing({
      record,
      stale,
      reason: initialLimitClearReason(record, stale),
    });
  };
  const components = (state.management ?? [])
    .filter((c) => c.kind === "component")
    .filter((c) => c.aircraftUuid === aircraft);
  const rows = (state.airworthiness ?? []).filter(
    (r) => adAircraftUuid(state, r) === aircraft,
  );
  const workOrders = (state.workOrders ?? []).filter(
    (w) => w.aircraftUuid === aircraft && w.status !== "cancelled",
  );
  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setNotice(message);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function updateSource(k: keyof ADSource, v: string) {
    setDraft((d) => (d ? { ...d, source: { ...d.source, [k]: v } } : d));
  }
  const woSelect = (value: string, change: (v: string) => void) => (
    <select value={value} onChange={(e) => change(e.target.value)}>
      <option value="">No work order linked</option>
      {workOrders.map((w) => (
        <option key={w.uuid} value={w.uuid}>
          {w.number || w.uuid} · {w.status}
        </option>
      ))}
    </select>
  );
  const draftNeedsReason =
    !!draft &&
    adSaveIsCorrection(
      (state.airworthiness ?? []).find((r) => r.uuid === draft.uuid),
    );
  const statuses = rows.map((r) => adStatus(state, r));
  const staleCount = rows.filter((r) => staleInitialLimits(r).length).length;
  const count = (status: string) => statuses.filter((x) => x === status).length;
  return (
    <div className="ops-page ops-ad">
      <PageHeader
        eyebrow="COMPLIANCE"
        title="Airworthiness directives"
        description="FAA directives that apply to your aircraft, with applicability review, compliance records and printable reports."
        actions={
          <>
            <span className="ops-ad-faa">
              <FaaSearchImport key={aircraft} aircraftUuid={aircraft} />
            </span>
            <button
              className="button primary"
              disabled={!editable || busy}
              onClick={() => openDraft(blankAD(aircraft))}
            >
              <Plus size={18} weight="bold" aria-hidden="true" /> Add AD
            </button>
          </>
        }
      />
      <Toolbar
        end={
          <>
            <details className="ops-more">
              <summary className="button">
                <DotsThree size={18} weight="bold" aria-hidden="true" />
                Other import options
              </summary>
              <div className="ops-more-menu">
                <label className="button ops-file-button">
                  <FileDoc size={18} aria-hidden="true" />
                  Import Word report
                  <input
                    aria-label="Import AD Word report"
                    type="file"
                    accept=".docx"
                    className="ops-file-input"
                    disabled={!editable || busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f)
                        void run(async () => {
                          setPreview(await importADDocx(f));
                          setAssign({});
                        }, "Report ready for review.");
                    }}
                  />
                </label>
              </div>
            </details>
            <button
              className="button"
              disabled={!aircraft}
              onClick={async () => {
                try {
                  // Loaded on demand so the PDF library stays out of startup.
                  const { saveADReport } = await import("../data/adReport");
                  saveADReport(state, aircraft);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <FilePdf size={18} aria-hidden="true" /> Save compliance PDF
            </button>
            <button
              className="button"
              disabled={!aircraft}
              onClick={async () => {
                // Open the tab inside the click so pop-up blockers allow it.
                const tab = window.open("", "_blank");
                try {
                  if (!tab) throw Error("Allow pop-ups to print the report.");
                  const { printADReport } = await import("../data/adReport");
                  printADReport(state, aircraft, tab);
                } catch (e) {
                  tab?.close();
                  setError(String(e));
                }
              }}
            >
              <Printer size={18} aria-hidden="true" /> Print compliance report
            </button>
          </>
        }
      >
        <OpsSelect
          label="Aircraft"
          icon={Airplane}
          value={aircraft}
          onChange={(value) => {
            setAircraft(value);
            setPreview(null);
            setDraft(null);
            setError("");
          }}
        >
          {state.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration} · {a.model}
            </option>
          ))}
        </OpsSelect>
      </Toolbar>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <NoticeBar tone="good" icon={CheckCircle} role="status">
          {notice}
        </NoticeBar>
      )}
      <StatsStrip className="ops-stats">
        <StatTile label="Tracked ADs" value={rows.length} />
        <StatTile label="ADs needing review" value={count("Needs review")} />
        <StatTile label="ADs due soon" value={count("Due soon")} />
        <StatTile label="Overdue ADs" value={count("Overdue")} />
      </StatsStrip>
      <NoticeBar icon={Info}>
        New imports require applicability review. Counter thresholds use
        aircraft total hours or component time since new. Due-soon warnings
        start at 30 days, hours, or cycles. Source updates preserve recorded
        compliance.
      </NoticeBar>
      <details className="ad-tools ops-disclosure">
        <summary>
          <IconTile icon={Key} size="sm" />
          <span>FAA connection and renewal settings</span>
          <CaretDown
            className="ops-disclosure-caret"
            size={18}
            aria-hidden="true"
          />
        </summary>
        <div className="ops-disclosure-body">
          <FaaKeySettings />
        </div>
      </details>
      <details className="ad-tools ops-disclosure">
        <summary>
          <IconTile icon={ArrowsClockwise} size="sm" />
          <span>FAA monitoring and updates</span>
          <CaretDown
            className="ops-disclosure-caret"
            size={18}
            aria-hidden="true"
          />
        </summary>
        <div className="ops-disclosure-body">
          <FaaMonitoring
            key={aircraft}
            aircraftUuid={aircraft}
            onImport={(c) => {
              const matches = rows.filter(
                (r) => adNumber(r.source.number) === adNumber(c.source.number),
              );
              const r =
                matches.length === 1
                  ? structuredClone(matches[0])
                  : blankAD(aircraft, c.source.section);
              r.source = c.source;
              r.reviewRequired = true;
              openDraft(r);
            }}
          />
        </div>
      </details>
      {!rows.length && (
        <EmptyState title="No AD records for this aircraft">
          Import a report or add an AD to begin.
        </EmptyState>
      )}
      {staleCount > 0 && (
        <NoticeBar tone="warn" icon={Warning}>
          {staleCount === 1
            ? "1 AD has a one-time limit that was not cleared when compliance was recorded."
            : `${staleCount} ADs have a one-time limit that was not cleared when compliance was recorded.`}{" "}
          Open the AD group to review it. If compliance satisfied the limit, use
          Clear initial limit; the change is recorded in Change history.
        </NoticeBar>
      )}
      <ADRegister
        records={rows}
        state={state}
        aircraftUuid={aircraft}
        editable={editable && !busy}
        onEdit={(r) => {
          setError("");
          openDraft(structuredClone(r));
        }}
        onView={(r) => setViewUuid(r.uuid)}
        onClearInitialLimit={clearLimit}
      />
      {rows
        .filter((r) => r.uuid === viewUuid)
        .map((r) => (
          <Modal
            title={`AD ${r.source.number} details`}
            onClose={() => setViewUuid(null)}
            key={r.uuid}
          >
            <section className="panel">
              <div className="section-heading">
                <h2>AD {r.source.number}</h2>
                <strong>{adStatus(state, r)}</strong>
              </div>
              <p>
                {r.source.section} · {r.source.subject}
              </p>
              <p>
                {r.componentUuid
                  ? components.find((c) => c.uuid === r.componentUuid)
                      ?.serial || "Component serial not recorded"
                  : aircraftRecord?.registration}{" "}
                · Effective {r.source.effective || "not recorded"} · Recurring:{" "}
                {r.source.recurring}
              </p>
              {r.source.supersededBy && (
                <p>
                  Source supersession reference: {r.source.supersededBy} —
                  review against FAA document.
                </p>
              )}
              {r.priorCompliance && (
                <p>
                  Previously Complied With (PCW) · {r.priorCompliance.date} ·
                  Aircraft total time:{" "}
                  {r.priorCompliance.aircraftHours ?? "Not recorded"} hours
                  {r.componentUuid && (
                    <>
                      {" "}
                      · Component total time:{" "}
                      {r.priorCompliance.componentHours ?? "Not recorded"} hours
                    </>
                  )}
                </p>
              )}
              {r.reason && <p>Applicability reason: {r.reason}</p>}
              <button
                className="button"
                disabled={!editable || busy}
                onClick={() => {
                  setError("");
                  setViewUuid(null);
                  openDraft(structuredClone(r));
                }}
              >
                Review / edit AD
              </button>
              {r.tasks.map((t) => (
                <div className="list-row" key={t.uuid}>
                  <div className="grow">
                    <strong>{t.description}</strong>
                    {adRemaining(state, r, t).map(({ label, value }) => (
                      <p key={label}>
                        <strong>
                          {label}: {value}
                        </strong>
                      </p>
                    ))}
                    <p>
                      {adTaskStatus(state, r, t)} · Due:{" "}
                      {[
                        (t.intervalDays || t.dueDate) &&
                          (t.dueDate || "date not set"),
                        (t.intervalHours || t.dueHours !== null) &&
                          `${t.dueHours ?? "not set"} hours`,
                        (t.intervalLandings || t.dueLandings != null) &&
                          `${t.dueLandings ?? "not set"} landings`,
                        (t.intervalCycles || t.dueCycles !== null) &&
                          `${t.dueCycles ?? "not set"} cycles`,
                      ]
                        .filter(Boolean)
                        .join(" / ") || "not set"}
                    </p>
                    <p>
                      {t.recurrence} · Interval:{" "}
                      {[
                        t.intervalDays && `${t.intervalDays} days`,
                        t.intervalHours && `${t.intervalHours} hours`,
                        t.intervalCycles && `${t.intervalCycles} cycles`,
                        t.intervalLandings && `${t.intervalLandings} landings`,
                      ]
                        .filter(Boolean)
                        .join(" / ") || "not set"}
                    </p>
                    {staleInitialLimits(r)
                      .filter((stale) => stale.taskUuid === t.uuid)
                      .map((stale) => (
                        <div className="ad-stale-limit" key={stale.taskUuid}>
                          <p>{staleInitialLimitNotice(r, stale)}</p>
                          <button
                            className="button small"
                            disabled={!editable || busy}
                            onClick={() => clearLimit(r, stale)}
                          >
                            Clear initial limit
                          </button>
                        </div>
                      ))}
                    <PartsAvailability
                      source={{
                        kind: "airworthiness",
                        uuid: t.uuid,
                        workOrderUuid: "",
                      }}
                    />
                    <RequestPartsButton
                      source={{
                        kind: "airworthiness",
                        uuid: t.uuid,
                        workOrderUuid: "",
                      }}
                    />
                    {t.workOrderUuid && (
                      <Link to="/work-orders">
                        Work order:{" "}
                        {workOrders.find((w) => w.uuid === t.workOrderUuid)
                          ?.number || t.workOrderUuid}
                      </Link>
                    )}
                  </div>
                  <ADWorkOrderButton
                    state={state}
                    record={r}
                    taskUuid={t.uuid}
                  />
                  <button
                    className="button small"
                    disabled={
                      !editable ||
                      busy ||
                      r.reviewRequired ||
                      ![
                        "Applicable",
                        "Previously Complied With (PCW)",
                      ].includes(r.applicability)
                    }
                    onClick={() => {
                      setViewUuid(null);
                      setCompliance({
                        record: r,
                        entry: {
                          uuid: crypto.randomUUID(),
                          taskUuid: t.uuid,
                          date: localDate(),
                          hours: null,
                          cycles: null,
                          method: "",
                          serviceBulletin: "",
                          terminatedBy: "",
                          workOrderUuid:
                            t.workOrderUuid ||
                            workOrders.find((w) =>
                              w.tasks.some(
                                (x) =>
                                  x.source.kind === "airworthiness" &&
                                  x.source.uuid === t.uuid,
                              ),
                            )?.uuid ||
                            "",
                          mechanic: state.user.name,
                          certificate: memberLicense(state.user).licenseNumber,
                          evidence: "",
                          recordedAt: 0,
                          recordedBy: "",
                        },
                      });
                    }}
                  >
                    Record compliance
                  </button>
                </div>
              ))}
              <details>
                <summary>
                  Compliance history ({effectiveCompliance(r).length}) and
                  source history ({r.sourceHistory.length})
                </summary>
                {effectiveCompliance(r).map((h) => {
                  const original = r.history.find((x) => x.uuid === h.corrects);
                  return (
                    <div key={h.uuid}>
                      <p>
                        {h.date} · {h.method} · {h.hours ?? "—"} hours ·{" "}
                        {h.cycles ?? "—"} cycles ·{" "}
                        {h.landings != null && (
                          <>{h.landings} aircraft landings · </>
                        )}{" "}
                        {h.mechanic} / {h.certificate} · {h.evidence}
                      </p>
                      {original && (
                        <p>
                          <small>
                            Corrected{" "}
                            {new Date(h.recordedAt).toLocaleDateString()}:{" "}
                            {h.correctionReason}. Originally recorded:{" "}
                            {original.date} · {original.method} ·{" "}
                            {original.hours ?? "—"} hours ·{" "}
                            {original.cycles ?? "—"} cycles ·{" "}
                            {original.mechanic}
                          </small>
                        </p>
                      )}
                      {correctable && (
                        <button
                          className="button small"
                          disabled={busy}
                          aria-label={`Correct entry of ${h.date}`}
                          onClick={() => {
                            const {
                              corrects: _corrects,
                              correctionReason: _reason,
                              ...values
                            } = h;
                            setError("");
                            setViewUuid(null);
                            setCompliance({
                              record: r,
                              corrects: h.corrects ?? h.uuid,
                              reason: "",
                              entry: { ...values, uuid: crypto.randomUUID() },
                            });
                          }}
                        >
                          Correct entry
                        </button>
                      )}
                    </div>
                  );
                })}
                {editable &&
                  !correctable &&
                  effectiveCompliance(r).length > 0 && (
                    <p>
                      <small>
                        A Flight Program administrator can correct recorded
                        compliance.
                      </small>
                    </p>
                  )}
                {r.sourceHistory.map((h, i) => (
                  <p key={i}>
                    {new Date(h.at).toLocaleString()} · {h.source.number} ·{" "}
                    {h.source.subject}
                  </p>
                ))}
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {r.source.sourceNotes}
                </pre>
              </details>
            </section>
          </Modal>
        ))}
      {preview && (
        <Modal
          title="Review AD import"
          onClose={() => !busy && setPreview(null)}
        >
          <p>
            {preview.entries.length} AD entries. Report aircraft:{" "}
            {preview.registration || "not recorded"}. Import into:{" "}
            {aircraftRecord?.registration}.
          </p>
          {preview.registration &&
            preview.registration !== aircraftRecord?.registration && (
              <p role="alert">
                Registration differs. Confirm that this report is appropriate
                for the selected aircraft before importing.
              </p>
            )}
          <p>
            Compliance fields from the report are preserved as source notes.
            They do not automatically establish compliance.
          </p>
          {preview.warnings.map((w, i) => (
            <p key={i} className="callout">
              {w}
            </p>
          ))}
          {[
            ...new Set(
              preview.entries
                .filter((e) => e.section !== "Airframe")
                .map(groupKey),
            ),
          ].map((key) => (
            <fieldset key={key}>
              <legend>{key}: assign to specific components</legend>
              <label>
                <input
                  type="checkbox"
                  checked={(assign[key] ?? []).includes("__skip__")}
                  onChange={(e) =>
                    setAssign({
                      ...assign,
                      [key]: e.target.checked ? ["__skip__"] : [],
                    })
                  }
                />
                Skip this section for now (not imported)
              </label>
              {components.map((c) => (
                <label key={c.uuid}>
                  <input
                    type="checkbox"
                    checked={(assign[key] ?? []).includes(c.uuid)}
                    onChange={(e) =>
                      setAssign({
                        ...assign,
                        [key]: e.target.checked
                          ? [
                              ...(assign[key] ?? []).filter(
                                (id) => id !== "__skip__",
                              ),
                              c.uuid,
                            ]
                          : (assign[key] ?? []).filter((id) => id !== c.uuid),
                      })
                    }
                  />
                  {c.manufacturer} {c.model || c.componentType} ·{" "}
                  {c.installPosition} · P/N {c.partNumber} · S/N{" "}
                  {c.serial || "not recorded"}
                </label>
              ))}
              {!components.length && (
                <p>
                  Add the aircraft’s components first, then import this report.
                </p>
              )}
            </fieldset>
          ))}
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            {preview.entries.map((e, i) => (
              <p key={i}>
                {e.section} · {e.number} · {e.subject} ·{" "}
                {rows.some(
                  (r) => adNumber(r.source.number) === adNumber(e.number),
                )
                  ? "Existing AD — match by component on import"
                  : "New AD"}
              </p>
            ))}
          </div>
          <button
            className="button primary"
            disabled={
              busy ||
              preview.entries.some(
                (e) => e.section !== "Airframe" && !assign[groupKey(e)]?.length,
              )
            }
            onClick={() =>
              void run(async () => {
                await backend!.saveAD({
                  kind: "import",
                  aircraftUuid: aircraft,
                  entries: preview.entries.flatMap((source) =>
                    (source.section === "Airframe"
                      ? [""]
                      : (assign[groupKey(source)] ?? []).filter(
                          (id) => id !== "__skip__",
                        )
                    ).map((componentUuid) => ({ source, componentUuid })),
                  ),
                });
                setPreview(null);
              }, "AD report imported. Review applicability and enter required actions.")
            }
          >
            Confirm import
          </button>
        </Modal>
      )}
      {draft && (
        <Modal
          title={draft.version ? "Review AD" : "Add AD"}
          onClose={() => !busy && setDraft(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await backend!.saveAD({
                  kind: "save",
                  record: draft,
                  ...(draftNeedsReason ? { reason: draftReason } : {}),
                });
                setDraft(null);
              }, "AD saved.");
            }}
          >
            <div className="form-grid">
              {(
                [
                  ["number", "AD number"],
                  ["amendment", "Amendment"],
                  ["issued", "Issue date (as published)"],
                  ["effective", "Effective date (as published)"],
                  ["subject", "Subject"],
                  ["supersededBy", "Superseded by (source reference)"],
                  ["url", "FAA document URL"],
                ] as const
              ).map(([key, label]) => (
                <Field label={label} key={key}>
                  <input
                    required={
                      key === "number" ||
                      key === "subject" ||
                      (key === "supersededBy" &&
                        draft.applicability === "Superseded")
                    }
                    value={draft.source[key]}
                    onChange={(e) => updateSource(key, e.target.value)}
                  />
                </Field>
              ))}
              <Field label="Section">
                <select
                  disabled={draft.version > 0}
                  value={draft.source.section}
                  onChange={(e) => updateSource("section", e.target.value)}
                >
                  {["Airframe", "Engine", "Propeller", "Appliance"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              {draft.source.section !== "Airframe" && (
                <Field label="Component">
                  <select
                    required
                    disabled={draft.version > 0}
                    value={draft.componentUuid}
                    onChange={(e) =>
                      setDraft({
                        ...(rows.find(
                          (r) =>
                            r.componentUuid === e.target.value &&
                            adNumber(r.source.number) ===
                              adNumber(draft.source.number),
                        ) ?? draft),
                        source: draft.source,
                        reviewRequired: true,
                        componentUuid: e.target.value,
                      })
                    }
                  >
                    <option value="">Select component</option>
                    {components.map((c) => (
                      <option key={c.uuid} value={c.uuid}>
                        {c.componentType} · {c.installPosition} · {c.serial}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Recurring">
                <select
                  value={draft.source.recurring}
                  onChange={(e) => updateSource("recurring", e.target.value)}
                >
                  {["Unknown", "Yes", "No"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Applicability">
                <select
                  value={draft.applicability}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      applicability: e.target.value as AD["applicability"],
                      reviewRequired: [
                        "Not applicable",
                        "Superseded",
                        "Previously Complied With (PCW)",
                      ].includes(e.target.value)
                        ? false
                        : e.target.value === "Needs review"
                          ? true
                          : draft.reviewRequired,
                    })
                  }
                >
                  {[
                    "Needs review",
                    "Applicable",
                    "Not applicable",
                    "Superseded",
                    "Previously Complied With (PCW)",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              {draft.applicability === "Previously Complied With (PCW)" && (
                <>
                  <Field label="Previous compliance date">
                    <input
                      type="date"
                      required
                      max={localDate()}
                      value={draft.priorCompliance?.date ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          priorCompliance: {
                            aircraftHours: null,
                            componentHours: null,
                            ...draft.priorCompliance,
                            date: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  {(
                    [
                      "aircraftHours",
                      ...(draft.componentUuid ? ["componentHours"] : []),
                    ] as ("aircraftHours" | "componentHours")[]
                  ).map((key) => (
                    <Field
                      key={key}
                      label={
                        key === "aircraftHours"
                          ? "Aircraft total time at compliance (hours)"
                          : "Component total time at compliance (hours)"
                      }
                    >
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={draft.priorCompliance?.[key] ?? ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            priorCompliance: {
                              date: "",
                              aircraftHours: null,
                              componentHours: null,
                              ...draft.priorCompliance,
                              [key]:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
                  <p>
                    Enter the historical total time, not today's reading. For
                    component ADs, enter aircraft time, component time, or both.
                    PCW records previous compliance; recurring or unknown
                    requirements still need required actions and next due
                    limits.
                  </p>
                </>
              )}
              <Field label="Applicability reason / paragraph">
                <textarea
                  required={draft.applicability === "Not applicable"}
                  value={draft.reason}
                  onChange={(e) =>
                    setDraft({ ...draft, reason: e.target.value })
                  }
                />
              </Field>
            </div>
            <label>
              <input
                type="checkbox"
                checked={!draft.reviewRequired}
                onChange={(e) =>
                  setDraft({ ...draft, reviewRequired: !e.target.checked })
                }
              />
              Applicability and source changes reviewed
            </label>
            {draft.applicability === "Superseded" && (
              <p>
                Enter the replacing AD in Superseded by. Saving marks this AD as
                superseded and preserves its compliance history. Track the
                replacing AD separately.
              </p>
            )}
            {draft.applicability === "Not applicable" && (
              <p>
                Selecting Not applicable marks the review complete. Record your
                reason before saving. Uncheck the review box if further review
                is needed; later FAA source updates will require review again.
              </p>
            )}
            <h3>Required actions</h3>
            {draft.tasks.map((t, index) => (
              <fieldset key={t.uuid}>
                <legend>Action {index + 1}</legend>
                <Field label="Action recurrence">
                  <select
                    value={t.recurrence}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tasks: draft.tasks.map((x) =>
                          x.uuid === t.uuid
                            ? {
                                ...x,
                                recurrence: e.target
                                  .value as typeof t.recurrence,
                              }
                            : x,
                        ),
                      })
                    }
                  >
                    {["Unknown", "One-time", "Recurring"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Required action">
                  <textarea
                    required
                    value={t.description}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tasks: draft.tasks.map((x) =>
                          x.uuid === t.uuid
                            ? { ...x, description: e.target.value }
                            : x,
                        ),
                      })
                    }
                  />
                </Field>
                <ADTrackingFields
                  task={t}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.map((x) =>
                        x.uuid === t.uuid ? next : x,
                      ),
                    })
                  }
                />
                <Field label="Work order">
                  {woSelect(t.workOrderUuid, (v) =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.map((x) =>
                        x.uuid === t.uuid ? { ...x, workOrderUuid: v } : x,
                      ),
                    }),
                  )}
                </Field>
                <button
                  className="button small"
                  type="button"
                  disabled={draft.history.some((h) => h.taskUuid === t.uuid)}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.filter((x) => x.uuid !== t.uuid),
                    })
                  }
                >
                  Remove action
                </button>
              </fieldset>
            ))}
            <button
              className="button"
              type="button"
              onClick={() =>
                setDraft({ ...draft, tasks: [...draft.tasks, blankADTask()] })
              }
            >
              Add required action
            </button>
            {draftNeedsReason && (
              <Field
                label="Reason for change"
                hint="Required to change an AD whose applicability is decided or that has compliance recorded. Recorded in Change history."
              >
                <textarea
                  required
                  maxLength={1500}
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                />
              </Field>
            )}
            <button className="button primary" disabled={busy} type="submit">
              Save AD
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </Modal>
      )}
      {compliance && (
        <Modal
          title={
            compliance.corrects
              ? "Correct AD compliance record"
              : "Record AD compliance"
          }
          onClose={() => !busy && setCompliance(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                async () => {
                  await backend!.saveAD(
                    compliance.corrects
                      ? {
                          kind: "correct",
                          uuid: compliance.record.uuid,
                          version: compliance.record.version,
                          corrects: compliance.corrects,
                          reason: compliance.reason ?? "",
                          entry: compliance.entry,
                        }
                      : {
                          kind: "comply",
                          uuid: compliance.record.uuid,
                          version: compliance.record.version,
                          entry: compliance.entry,
                        },
                  );
                  setCompliance(null);
                },
                compliance.corrects
                  ? "Correction recorded; the original entry is kept."
                  : "Compliance recorded; recurring due limits updated.",
              );
            }}
          >
            <p>
              {compliance.corrects
                ? "The original entry stays in the compliance history. This correction replaces it for due limits and reports, and Change history records it with your reason."
                : "This records compliance evidence; it does not sign or close a work order."}
            </p>
            <div className="form-grid">
              {(
                [
                  ["date", "Completion date"],
                  [
                    "hours",
                    "Hours at completion (airframe total / component TSN)",
                  ],
                  ["cycles", "Cycles at completion"],
                  ["landings", "Aircraft total landings at completion"],
                  ["method", "Method of compliance"],
                  ["serviceBulletin", "Service bulletin"],
                  [
                    "terminatedBy",
                    "Terminating action (only when recurrence ends)",
                  ],
                  ["mechanic", "Mechanic name"],
                  ["certificate", "Certificate number"],
                  ["evidence", "Evidence / attachment / logbook reference"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    required={["date", "method", "mechanic"].includes(key)}
                    type={
                      key === "date"
                        ? "date"
                        : key === "hours" ||
                            key === "cycles" ||
                            key === "landings"
                          ? "number"
                          : "text"
                    }
                    min="0"
                    step={key === "hours" ? "0.1" : "1"}
                    value={compliance.entry[key] ?? ""}
                    onChange={(e) =>
                      setCompliance({
                        ...compliance,
                        entry: {
                          ...compliance.entry,
                          [key]:
                            key === "hours" ||
                            key === "cycles" ||
                            key === "landings"
                              ? e.target.value === ""
                                ? null
                                : Number(e.target.value)
                              : e.target.value,
                        },
                      })
                    }
                  />
                </Field>
              ))}
            </div>
            <Field label="Compliance work order">
              {woSelect(compliance.entry.workOrderUuid, (v) =>
                setCompliance({
                  ...compliance,
                  entry: { ...compliance.entry, workOrderUuid: v },
                }),
              )}
            </Field>
            {compliance.corrects && (
              <Field label="Reason for correction">
                <textarea
                  required
                  maxLength={1500}
                  value={compliance.reason ?? ""}
                  onChange={(e) =>
                    setCompliance({ ...compliance, reason: e.target.value })
                  }
                />
              </Field>
            )}
            <button className="button primary" disabled={busy}>
              {compliance.corrects ? "Save correction" : "Save compliance"}
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </Modal>
      )}
      {clearing && (
        <Modal
          title="Clear initial limit"
          onClose={() => !busy && setClearing(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await backend!.saveAD({
                  kind: "save",
                  record: clearInitialLimits(
                    clearing.record,
                    clearing.stale.taskUuid,
                  ),
                  reason: clearing.reason,
                });
                setClearing(null);
              }, "Initial limit cleared.");
            }}
          >
            <p>
              AD {clearing.record.source.number} ·{" "}
              {
                clearing.record.tasks.find(
                  (t) => t.uuid === clearing.stale.taskUuid,
                )?.description
              }
            </p>
            <p>{staleInitialLimitNotice(clearing.record, clearing.stale)}</p>
            <p>
              Repeating limits stay as they are. The AD is saved with the limit
              removed, and Change history records the values before and after
              with this reason.
            </p>
            <Field label="Reason for change">
              <textarea
                required
                maxLength={1500}
                value={clearing.reason}
                onChange={(e) =>
                  setClearing({ ...clearing, reason: e.target.value })
                }
              />
            </Field>
            <button className="button primary" disabled={busy}>
              Clear initial limit
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </Modal>
      )}
    </div>
  );
}
function FaaMonitoring({
  aircraftUuid,
  onImport,
}: {
  aircraftUuid: string;
  onImport: (c: FaaCandidate) => void;
}) {
  const { snapshot: s, backend, demo, online, connected } = useWorkspace();
  const state = s!;
  const saved =
    state.faaMonitors?.find((m) => m.aircraftUuid === aircraftUuid) ??
    emptyMonitor(aircraftUuid);
  const [terms, setTerms] = useState(saved.terms.join("\n"));
  const [enabled, setEnabled] = useState(saved.enabled);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const editable =
    can(state, aircraftUuid, "maintenance") && (demo || (online && connected));
  const run = async (command: import("../domain/faa").FaaCommand) => {
    setBusy(true);
    setError("");
    try {
      await backend!.faaCommand(command);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const candidates = monitoringReviewCandidates(
    state,
    aircraftUuid,
    saved.candidates,
  );
  const pending = candidates.filter((c) => !c.reviewReason);
  const coverageChanged =
    !!saved.lastSuccess &&
    JSON.stringify(monitoringScope(state, aircraftUuid, saved.terms)) !==
      JSON.stringify(saved.checkedTerms);
  return (
    <section className="ops-monitoring">
      <h2>FAA monitoring</h2>
      <p>
        Checks final rules and emergency ADs in FAA DRS. Matches are candidates
        for review, not confirmed applicability. Proposed rules are excluded.
      </p>
      <p>
        Last successful check:{" "}
        {saved.lastSuccess
          ? new Date(saved.lastSuccess).toLocaleString()
          : "Never"}
        . {saved.runId ? "Check in progress…" : ""}{" "}
        {saved.lastSuccess && Date.now() - saved.lastSuccess > 48 * 3600000
          ? "Results are stale — last check was more than 48 hours ago."
          : ""}
      </p>
      {coverageChanged && (
        <p role="alert">
          Aircraft equipment or search terms changed since the last successful
          check. Run a new check.
        </p>
      )}
      {saved.error && <p role="alert">{saved.error}</p>}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Monitoring settings and FAA key setup</summary>
        <p>
          Request a key from{" "}
          <a href="https://drs.faa.gov/help" target="_blank" rel="noreferrer">
            DRS Help → DRS API
          </a>
          . Use FAA API key and renewal above to update the shared key. Daily
          checks run at 10:00 UTC while the backend is running.
        </p>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!editable}
          />
          Enable daily checks
        </label>
        <Field label="Additional FAA search terms (one per line)">
          <textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            disabled={!editable}
          />
        </Field>
        <p>
          Aircraft and installed components are searched by model and product
          type. FAA search model overrides are used when set; part numbers are a
          fallback for components without models. Tracked AD numbers are checked
          separately. Add older manufacturer/model names and other relevant
          equipment identifiers here. Missing equipment data can lead to missed
          matches.
        </p>
        <p>
          Current search terms:{" "}
          {faaSearchTerms(
            state,
            aircraftUuid,
            terms
              .split("\n")
              .map((t) => t.trim())
              .filter(Boolean),
          ).join(", ") || "None"}
        </p>
        <button
          className="button"
          disabled={!editable || busy}
          onClick={() =>
            void run({
              kind: "configure",
              aircraftUuid,
              enabled,
              terms: terms
                .split("\n")
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        >
          Save monitoring settings
        </button>
      </details>
      <button
        className="button"
        disabled={
          !editable ||
          busy ||
          (!!saved.runId &&
            Date.now() - (saved.lastAttempt ?? 0) < 5 * 60000) ||
          demo
        }
        onClick={() => void run({ kind: "check", aircraftUuid })}
      >
        Check FAA now
      </button>
      {demo && <p>Live FAA checks require a connected backend.</p>}
      <p>
        {pending.length} new or changed candidate documents awaiting review.
      </p>
      {saved.candidates.length > candidates.length && (
        <p>
          {saved.candidates.length - candidates.length} unchanged documents
          already imported for this aircraft/components are hidden.
        </p>
      )}
      {candidates.map((c) => (
        <details key={c.id}>
          <summary>
            {c.emergency ? "EMERGENCY · " : ""}
            {c.source.number} · {c.status} ·{" "}
            {c.reviewReason ? "Reviewed" : "Needs review"}
          </summary>
          <p>{c.source.subject}</p>
          <p>
            {c.source.make} · {c.source.model} · Effective{" "}
            {c.source.effective || "see document"}
          </p>
          <a href={safeHref(c.source.url)} target="_blank" rel="noreferrer">
            Open FAA document
          </a>
          <p>{c.source.sourceNotes}</p>
          <button
            className="button small"
            disabled={!editable || busy}
            onClick={() => onImport(c)}
          >
            Review / import candidate
          </button>
          <Field label={`Review reason for ${c.source.number}`}>
            <input
              value={reasons[c.id] ?? c.reviewReason}
              onChange={(e) =>
                setReasons({ ...reasons, [c.id]: e.target.value })
              }
            />
          </Field>
          <button
            className="button small"
            disabled={
              !editable || busy || !(reasons[c.id] ?? c.reviewReason).trim()
            }
            onClick={() =>
              void run({
                kind: "review",
                aircraftUuid,
                id: c.id,
                reason: reasons[c.id] ?? c.reviewReason,
              })
            }
          >
            Record candidate review
          </button>
          {c.reviewReason && <p>{c.reviewReason}</p>}
        </details>
      ))}
    </section>
  );
}

/**
 * Responsibility: The AD register: an aircraft's airworthiness directives
 *   grouped into the airframe and each component, one table row per AD.
 * Layer: UI. React component; actions are handed to the parent screen.
 * Dependencies: @phosphor-icons/react, src/domain/airworthiness.ts,
 *   src/domain/model.ts (types), ./adRegister.css, ./ADWorkOrderButton,
 *   ./MaintenanceUi, ./design, ./ui.
 *
 * Each group is a table built from ARIA roles on plain elements, so its rows
 * can restack on a phone without losing the table a screen reader hears.
 */
import {
  ArrowSquareOut,
  CalendarCheck,
  CaretDown,
  CheckCircle,
  Clock,
  MinusCircle,
  Question,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { AD, StaleInitialLimit } from "../domain/airworthiness";
import {
  adStatus,
  staleInitialLimitNotice,
  staleInitialLimits,
} from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import "./adRegister.css";
import { ADWorkOrderButton } from "./ADWorkOrderButton";
import { FactLabel } from "./MaintenanceUi";
import { StatusPill, type IconType, type Tone } from "./design";
import { safeHref } from "./ui";

const COLUMNS = ["Directive", "Issued", "Effective", "Status", "Actions"];
// Statuses not listed here (closed applicability, a removed component) are
// settled and read as neutral.
const STATUS_LOOKS: Record<string, { tone: Tone; icon: IconType }> = {
  Overdue: { tone: "danger", icon: Warning },
  "Due soon": { tone: "warn", icon: Clock },
  "Needs review": { tone: "warn", icon: WarningCircle },
  "Counter unavailable": { tone: "neutral", icon: Question },
  "Due not set": { tone: "neutral", icon: Question },
  Scheduled: { tone: "blue", icon: CalendarCheck },
  Complied: { tone: "good", icon: CheckCircle },
  "Previously Complied With (PCW)": { tone: "good", icon: CheckCircle },
};
const SETTLED_LOOK = { tone: "neutral", icon: MinusCircle } as const;
const CARET_SIZE = 18;
const LINK_ICON_SIZE = 14;

type RegisterProps = {
  records: AD[];
  expanded?: boolean;
  state: Snapshot;
  aircraftUuid: string;
  editable: boolean;
  onEdit: (record: AD) => void;
  onView: (record: AD) => void;
  onClearInitialLimit: (record: AD, stale: StaleInitialLimit) => void;
};
type RowProps = Omit<RegisterProps, "records" | "aircraftUuid" | "expanded"> & {
  record: AD;
};

/**
 * The AD register for one aircraft: a collapsible group for the airframe and
 * for each component with ADs, in the order the records first name them, each
 * counting its ADs, those needing review and stale one-time limits.
 *
 * @param props.records - The aircraft's AD records.
 * @param props.expanded - Opens every group; otherwise each starts closed.
 * @param props.editable - Enables Edit and Clear initial limit.
 * @param props.onClearInitialLimit - Receives the AD and one of its one-time
 *   limits that compliance should have cleared.
 * @returns The register. A row offers its AD to a work order only while the
 *   AD is Scheduled, Due soon or Overdue.
 */
export function ADRegister({
  records,
  aircraftUuid,
  expanded,
  ...row
}: RegisterProps) {
  const groups = new Map<string, AD[]>();
  for (const record of records) {
    const key = record.componentUuid || "airframe";
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return (
    <div className="ad-register">
      {[...groups].map(([id, entries]) => (
        <ADGroup
          key={id}
          {...row}
          open={expanded}
          id={id}
          entries={entries}
          aircraftUuid={aircraftUuid}
        />
      ))}
    </div>
  );
}

function ADGroup(
  props: Omit<RowProps, "record"> & {
    id: string;
    entries: AD[];
    aircraftUuid: string;
    open?: boolean;
  },
) {
  const { state, entries } = props;
  const { title, detail } = groupHeading(state, props);
  const needsReview = entries.filter(
    (record) => adStatus(state, record) === "Needs review",
  ).length;
  const staleLimits = entries.filter(
    (record) => staleInitialLimits(record).length,
  ).length;
  return (
    <details className="ad-register-group" open={props.open || undefined}>
      <summary>
        <CaretDown
          className="ad-register-caret"
          size={CARET_SIZE}
          aria-hidden="true"
        />
        <strong>{title}</strong>
        <span>{detail}</span>
        <b>
          {entries.length} AD{entries.length === 1 ? "" : "s"}
          <span
            className={
              needsReview ? "ad-review-count pending" : "ad-review-count"
            }
          >
            Needs review: {needsReview}
          </span>
          {staleLimits > 0 && (
            <span className="ad-review-count pending">
              One-time limits to check: {staleLimits}
            </span>
          )}
        </b>
      </summary>
      <ADTable {...props} title={title} />
    </details>
  );
}

function ADTable(
  props: Omit<RowProps, "record"> & {
    entries: AD[];
    title: string;
  },
) {
  return (
    <div
      className="ad-register-table"
      role="table"
      aria-label={`${props.title} airworthiness directives`}
    >
      <div role="rowgroup" className="ad-register-head">
        <div role="row" className="ad-register-row">
          {COLUMNS.map((column) => (
            <span role="columnheader" key={column}>
              {column}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {props.entries.map((r) => (
          <ADRow key={r.uuid} {...props} record={r} />
        ))}
      </div>
    </div>
  );
}

function ADRow(props: RowProps) {
  const { record: r } = props;
  const status = adStatus(props.state, r);
  const stale = staleInitialLimits(r);
  return (
    <div role="row" className="ad-register-row">
      <ADMainCell {...props} />
      <div role="cell" className="ad-register-date">
        <FactLabel>Issued</FactLabel>
        {r.source.issued || "—"}
      </div>
      <div role="cell" className="ad-register-date">
        <FactLabel>Effective</FactLabel>
        {r.source.effective || "—"}
      </div>
      <ADStatusCell record={r} status={status} stale={stale} />
      <ADActions {...props} stale={stale} />
    </div>
  );
}

function ADMainCell({ record: r, onView }: RowProps) {
  const url = safeHref(r.source.url);
  return (
    <div role="cell" className="ad-register-main">
      <span className="ad-register-subject">
        {r.source.subject}
        {r.source.supersededBy && (
          <small>Superseded by: {r.source.supersededBy}</small>
        )}
      </span>
      <span className="ad-register-meta">
        <button
          className="ad-register-link"
          onClick={() => onView(r)}
          aria-label={`View AD ${r.source.number}`}
        >
          {r.source.number}
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            FAA
            <ArrowSquareOut size={LINK_ICON_SIZE} aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <span>Recurring: {r.source.recurring}</span>
      </span>
    </div>
  );
}

function ADStatusCell(props: {
  record: AD;
  status: string;
  stale: StaleInitialLimit[];
}) {
  const { record: r, status } = props;
  const look = STATUS_LOOKS[status] ?? SETTLED_LOOK;
  return (
    <div role="cell" className="ad-register-status">
      <StatusPill tone={look.tone} icon={look.icon}>
        {status}
      </StatusPill>
      {r.applicability !== status && <small>{r.applicability}</small>}
      {props.stale.map((limit) => (
        <small className="ad-stale-limit" key={limit.taskUuid}>
          {staleInitialLimitNotice(r, limit)}
        </small>
      ))}
    </div>
  );
}

function ADActions(props: RowProps & { stale: StaleInitialLimit[] }) {
  const { record: r, editable } = props;
  return (
    <div role="cell" className="ad-register-actions">
      <button
        className="button small"
        disabled={!editable}
        onClick={() => props.onEdit(r)}
        aria-label="Review / edit AD"
      >
        Edit
      </button>
      <button
        className="button small"
        onClick={() => props.onView(r)}
        aria-label={`Details for AD ${r.source.number}`}
      >
        Details
      </button>
      {props.stale.map((limit) => (
        <button
          className="button small"
          key={limit.taskUuid}
          disabled={!editable}
          onClick={() => props.onClearInitialLimit(r, limit)}
          aria-label={`Clear initial limit on AD ${r.source.number}: ${r.tasks.find((t) => t.uuid === limit.taskUuid)?.description ?? ""}`}
        >
          Clear initial limit
        </button>
      ))}
      <ADWorkOrderButton state={props.state} record={r} />
    </div>
  );
}

function groupHeading(
  state: Snapshot,
  {
    id,
    entries,
    aircraftUuid,
  }: { id: string; entries: AD[]; aircraftUuid: string },
) {
  const aircraft = state.aircraft.find((a) => a.uuid === aircraftUuid);
  const found = state.management?.find(
    (c) => c.kind === "component" && c.uuid === id,
  );
  const c = found?.kind === "component" ? found : null;
  if (!c)
    return {
      title: `Airframe: ${aircraft?.make ?? ""} / ${aircraft?.model ?? ""}`,
      detail: aircraft?.registration,
    };
  return {
    title: `${entries[0].source.section}: ${c.manufacturer} / ${c.model || c.componentType}`,
    detail: `${c.installPosition || ""} · S/N ${c.serial || "—"}`,
  };
}

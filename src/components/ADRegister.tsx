/**
 * Responsibility: The AD register: an aircraft's airworthiness directives
 *   grouped into the airframe and each component, one table row per AD.
 * Layer: UI. React component; actions are handed to the parent screen.
 * Dependencies: src/domain/airworthiness.ts, src/domain/adWorkOrders.ts,
 *   src/domain/model.ts (types), ./adRegister.css, ./ADWorkOrderButton, ./ui.
 */
import type { AD, StaleInitialLimit } from "../domain/airworthiness";
import {
  adStatus,
  staleInitialLimitNotice,
  staleInitialLimits,
} from "../domain/airworthiness";
import { OPEN_AD_STATUSES } from "../domain/adWorkOrders";
import type { Snapshot } from "../domain/model";
import "./adRegister.css";
import { ADWorkOrderButton } from "./ADWorkOrderButton";
import { safeHref } from "./ui";

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
    <div className="ad-register-scroll">
      <table>
        <caption className="sr-only">
          {props.title} airworthiness directives
        </caption>
        <thead>
          <tr>
            <th>AD number</th>
            <th>View</th>
            <th>Rec.</th>
            <th>Subject</th>
            <th>Issued</th>
            <th>Effective</th>
            <th>Applicability / status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((r) => (
            <ADRow key={r.uuid} {...props} record={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ADRow(props: RowProps) {
  const { record: r } = props;
  const status = adStatus(props.state, r);
  const stale = staleInitialLimits(r);
  return (
    <tr>
      <td>
        <button
          className="ad-register-link"
          onClick={() => props.onView(r)}
          aria-label={`View AD ${r.source.number}`}
        >
          {r.source.number}
        </button>
      </td>
      <td>
        {safeHref(r.source.url) ? (
          <a href={safeHref(r.source.url)} target="_blank" rel="noreferrer">
            FAA ↗
          </a>
        ) : (
          "—"
        )}
      </td>
      <td>{r.source.recurring}</td>
      <td className="ad-register-subject">
        {r.source.subject}
        {r.source.supersededBy && (
          <small>Superseded by: {r.source.supersededBy}</small>
        )}
      </td>
      <td>{r.source.issued || "—"}</td>
      <td>{r.source.effective || "—"}</td>
      <ADStatusCell record={r} status={status} stale={stale} />
      <ADActions {...props} status={status} stale={stale} />
    </tr>
  );
}

function ADStatusCell(props: {
  record: AD;
  status: string;
  stale: StaleInitialLimit[];
}) {
  const { record: r, status } = props;
  return (
    <td>
      <strong>{status}</strong>
      {r.applicability !== status && <small>{r.applicability}</small>}
      {props.stale.map((limit) => (
        <small className="ad-stale-limit" key={limit.taskUuid}>
          {staleInitialLimitNotice(r, limit)}
        </small>
      ))}
    </td>
  );
}

function ADActions(
  props: RowProps & { status: string; stale: StaleInitialLimit[] },
) {
  const { record: r, editable } = props;
  return (
    <td>
      <button
        disabled={!editable}
        onClick={() => props.onEdit(r)}
        aria-label="Review / edit AD"
      >
        Edit
      </button>
      <button
        onClick={() => props.onView(r)}
        aria-label={`Details for AD ${r.source.number}`}
      >
        Details
      </button>
      {props.stale.map((limit) => (
        <button
          key={limit.taskUuid}
          disabled={!editable}
          onClick={() => props.onClearInitialLimit(r, limit)}
          aria-label={`Clear initial limit on AD ${r.source.number}: ${r.tasks.find((t) => t.uuid === limit.taskUuid)?.description ?? ""}`}
        >
          Clear initial limit
        </button>
      ))}
      {OPEN_AD_STATUSES.includes(props.status) && (
        <ADWorkOrderButton state={props.state} record={r} />
      )}
    </td>
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

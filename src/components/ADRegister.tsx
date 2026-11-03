import type { AD, StaleInitialLimit } from "../domain/airworthiness";
import {
  adStatus,
  staleInitialLimitNotice,
  staleInitialLimits,
} from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import "./adRegister.css";
import { ADWorkOrderButton } from "./ADWorkOrderButton";
import { safeHref } from "./ui";

export function ADRegister({
  records,
  state,
  aircraftUuid,
  editable,
  onEdit,
  onView,
  onClearInitialLimit,
}: {
  records: AD[];
  state: Snapshot;
  aircraftUuid: string;
  editable: boolean;
  onEdit: (record: AD) => void;
  onView: (record: AD) => void;
  onClearInitialLimit: (record: AD, stale: StaleInitialLimit) => void;
}) {
  const aircraft = state.aircraft.find((a) => a.uuid === aircraftUuid);
  const groups = new Map<string, AD[]>();
  for (const record of records) {
    const key = record.componentUuid || "airframe";
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return (
    <div className="ad-register">
      {[...groups].map(([id, entries]) => {
        const needsReview = entries.filter(
          (record) => adStatus(state, record) === "Needs review",
        ).length;
        const staleLimits = entries.filter(
          (record) => staleInitialLimits(record).length,
        ).length;
        const component = state.management?.find(
          (c) => c.kind === "component" && c.uuid === id,
        );
        const c = component?.kind === "component" ? component : null;
        const title = c
          ? `${entries[0].source.section}: ${c.manufacturer} / ${c.model || c.componentType}`
          : `Airframe: ${aircraft?.make ?? ""} / ${aircraft?.model ?? ""}`;
        return (
          <details className="ad-register-group" key={id}>
            <summary>
              <strong>{title}</strong>
              <span>
                {c
                  ? `${c.installPosition || ""} · S/N ${c.serial || "—"}`
                  : aircraft?.registration}
              </span>
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
            <div className="ad-register-scroll">
              <table>
                <caption className="sr-only">
                  {title} airworthiness directives
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
                  {entries.map((r) => (
                    <tr key={r.uuid}>
                      <td>
                        <button
                          className="ad-register-link"
                          onClick={() => onView(r)}
                          aria-label={`View AD ${r.source.number}`}
                        >
                          {r.source.number}
                        </button>
                      </td>
                      <td>
                        {safeHref(r.source.url) ? (
                          <a
                            href={safeHref(r.source.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
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
                      <td>
                        <strong>{adStatus(state, r)}</strong>
                        {r.applicability !== adStatus(state, r) && (
                          <small>{r.applicability}</small>
                        )}
                        {staleInitialLimits(r).map((stale) => (
                          <small
                            className="ad-stale-limit"
                            key={stale.taskUuid}
                          >
                            {staleInitialLimitNotice(r, stale)}
                          </small>
                        ))}
                      </td>
                      <td>
                        <button
                          disabled={!editable}
                          onClick={() => onEdit(r)}
                          aria-label="Review / edit AD"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => onView(r)}
                          aria-label={`Details for AD ${r.source.number}`}
                        >
                          Details
                        </button>
                        {staleInitialLimits(r).map((stale) => (
                          <button
                            key={stale.taskUuid}
                            disabled={!editable}
                            onClick={() => onClearInitialLimit(r, stale)}
                            aria-label={`Clear initial limit on AD ${r.source.number}: ${r.tasks.find((t) => t.uuid === stale.taskUuid)?.description ?? ""}`}
                          >
                            Clear initial limit
                          </button>
                        ))}
                        {["Scheduled", "Due soon", "Overdue"].includes(
                          adStatus(state, r),
                        ) && <ADWorkOrderButton state={state} record={r} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

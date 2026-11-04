/**
 * Responsibility: The Administration notice listing permission groups that
 *   cover every aircraft without a recorded administrator choice, and the
 *   hook that asks the server for them.
 * Layer: UI. Reads the workspace, asks through the Backend; changes nothing.
 * Dependencies: src/data/store.ts (useWorkspace),
 *   src/domain/groupAccessReview.ts (report type, summary),
 *   src/components/design.tsx (NoticeBar, StatusPill),
 *   src/components/ui.tsx (errorText), @phosphor-icons/react.
 */
import { useEffect, useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  groupAccessSummary,
  type GroupAccessReport,
} from "../domain/groupAccessReview";
import { NoticeBar, StatusPill } from "./design";
import { errorText } from "./ui";

const MEMBERS_SHOWN = 5;

type ReviewResult = { reports: GroupAccessReport[]; error?: string };

/**
 * Says why a group needs review, with dates as the browser's locale writes a
 * short month, day and year.
 *
 * @param r - The group's review report.
 * @returns The sentence from `groupAccessSummary`.
 */
export function accessSummary(r: GroupAccessReport): string {
  return groupAccessSummary(r, formatDay);
}

/**
 * Asks the server which groups cover every aircraft of their Flight Program
 * while their change log does not show an administrator choosing that
 * (follow-up to #34). Asks again when the groups or `refresh` change, and
 * drops a reply that arrives after that.
 *
 * @param active - Whether to ask at all.
 * @param refresh - Change it to ask again.
 * @returns The reports; on failure none, with the error's message ("The
 *   check did not run." for a non-Error). None while inactive.
 */
export function useGroupAccessReview(active: boolean, refresh: number) {
  const backend = useWorkspace((x) => x.backend);
  const groups = useWorkspace((x) => x.snapshot?.groups);
  const key = JSON.stringify(groups ?? []);
  const [result, setResult] = useState<ReviewResult>({ reports: [] });
  useEffect(() => {
    if (!active || !backend) return;
    let current = true;
    backend.groupAccessReview().then(
      (reports) => current && setResult({ reports }),
      (error: unknown) =>
        current &&
        setResult({
          reports: [],
          error: errorText(error, "The check did not run."),
        }),
    );
    return () => {
      current = false;
    };
  }, [active, backend, key, refresh]);
  return active ? result : { reports: [] };
}

/**
 * Lists the groups to review in Administration → Permission groups. Nothing
 * changes here: "Edit group" opens the group form, which asks for an explicit
 * aircraft choice.
 *
 * @param props.error - Shown instead of the list when the check failed.
 * @param props.activeProgramUuid - Reports outside it add a warning that
 *   editing switches programs.
 * @returns The notice, or null when there is nothing to review.
 */
export function GroupAccessNotice({
  reports,
  error,
  activeProgramUuid,
  disabled,
  onEdit,
}: {
  reports: GroupAccessReport[];
  error?: string;
  activeProgramUuid?: string;
  disabled: boolean;
  onEdit: (report: GroupAccessReport) => void;
}) {
  if (error)
    return (
      <NoticeBar tone="neutral" icon={Warning} className="rise">
        Aircraft access could not be checked: {error}
      </NoticeBar>
    );
  if (!reports.length) return null;
  const elsewhere = reports.some((r) => r.programUuid !== activeProgramUuid);
  return (
    <section className="adm-review rise" aria-labelledby="adm-review-title">
      <NoticeBar tone="warn" icon={Warning}>
        <ReviewExplanation count={reports.length} elsewhere={elsewhere} />
        <ul className="adm-review-list">
          {reports.map((r) => (
            <ReviewItem
              key={r.groupId}
              report={r}
              disabled={disabled}
              onEdit={onEdit}
            />
          ))}
        </ul>
      </NoticeBar>
    </section>
  );
}

function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ReviewExplanation({
  count,
  elsewhere,
}: {
  count: number;
  elsewhere: boolean;
}) {
  return (
    <>
      <p id="adm-review-title" className="adm-review-title">
        <strong>
          Check aircraft access for {count} permission{" "}
          {count === 1 ? "group" : "groups"}
        </strong>
      </p>
      <p>
        {count === 1 ? "This group covers" : "These groups cover"} every
        aircraft in {count === 1 ? "its" : "their"} Flight Program, but the
        change log does not show that an administrator chose that. Until
        November 2026, editing a group whose aircraft had moved to another
        program could open it to the whole program. Open each group and choose
        its aircraft or all aircraft. Nothing changes until you save.
        {elsewhere &&
          " Editing a group in another Flight Program switches to that program."}
      </p>
    </>
  );
}

function ReviewItem({
  report,
  disabled,
  onEdit,
}: {
  report: GroupAccessReport;
  disabled: boolean;
  onEdit: (report: GroupAccessReport) => void;
}) {
  const widened = report.flag === "widened";
  return (
    <li className="adm-review-item">
      <div className="adm-review-text">
        <span className="adm-review-head">
          <strong>{report.groupName}</strong>
          <span className="adm-review-program">{report.programName}</span>
          <StatusPill dot={false} tone={widened ? "danger" : "warn"}>
            {widened ? "Opened to all aircraft" : "Review"}
          </StatusPill>
        </span>
        <span>{accessSummary(report)}</span>
        <span className="adm-review-members">{describeMembers(report)}</span>
      </div>
      <button
        type="button"
        className="button small adm-button"
        disabled={disabled}
        onClick={() => onEdit(report)}
      >
        Edit group
      </button>
    </li>
  );
}

function describeMembers(report: GroupAccessReport): string {
  if (!report.members.length) return "No members";
  const names = report.members.map(
    (m) => m.name + (m.active ? "" : " (disabled)"),
  );
  const more = names.length - MEMBERS_SHOWN;
  const shown = names.slice(0, MEMBERS_SHOWN).join(", ");
  return `Members: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
}

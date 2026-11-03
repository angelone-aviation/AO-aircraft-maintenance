import { useEffect, useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  groupAccessSummary,
  type GroupAccessReport,
} from "../domain/groupAccessReview";
import { NoticeBar, StatusPill } from "./design";

const day = (at: number) =>
  new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
export const accessSummary = (r: GroupAccessReport) =>
  groupAccessSummary(r, day);

/** Groups covering every aircraft of their Flight Program whose change log
 * does not show that choice (follow-up to #34), for system administrators.
 * Asked again whenever the groups change or `refresh` does. */
export function useGroupAccessReview(active: boolean, refresh: number) {
  const backend = useWorkspace((x) => x.backend);
  const groups = useWorkspace((x) => x.snapshot?.groups);
  const key = JSON.stringify(groups ?? []);
  const [result, setResult] = useState<{
    reports: GroupAccessReport[];
    error?: string;
  }>({ reports: [] });
  useEffect(() => {
    if (!active || !backend) return;
    let current = true;
    backend.groupAccessReview().then(
      (reports) => current && setResult({ reports }),
      (error: unknown) =>
        current &&
        setResult({
          reports: [],
          error:
            error instanceof Error ? error.message : "The check did not run.",
        }),
    );
    return () => {
      current = false;
    };
  }, [active, backend, key, refresh]);
  return active ? result : { reports: [] };
}

const MEMBERS_SHOWN = 5;
function members(r: GroupAccessReport) {
  if (!r.members.length) return "No members";
  const names = r.members.map((m) => m.name + (m.active ? "" : " (disabled)"));
  const more = names.length - MEMBERS_SHOWN;
  return `Members: ${names.slice(0, MEMBERS_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Lists the groups to review in Administration → Permission groups. Nothing
 * is changed here: "Edit group" opens the group form, which asks for an
 * explicit aircraft choice. */
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
        <p id="adm-review-title" className="adm-review-title">
          <strong>
            Check aircraft access for {reports.length} permission{" "}
            {reports.length === 1 ? "group" : "groups"}
          </strong>
        </p>
        <p>
          {reports.length === 1 ? "This group covers" : "These groups cover"}{" "}
          every aircraft in {reports.length === 1 ? "its" : "their"} Flight
          Program, but the change log does not show that an administrator chose
          that. Until November 2026, editing a group whose aircraft had moved to
          another program could open it to the whole program. Open each group
          and choose its aircraft or all aircraft. Nothing changes until you
          save.
          {elsewhere &&
            " Editing a group in another Flight Program switches to that program."}
        </p>
        <ul className="adm-review-list">
          {reports.map((r) => (
            <li className="adm-review-item" key={r.groupId}>
              <div className="adm-review-text">
                <span className="adm-review-head">
                  <strong>{r.groupName}</strong>
                  <span className="adm-review-program">{r.programName}</span>
                  <StatusPill
                    dot={false}
                    tone={r.flag === "widened" ? "danger" : "warn"}
                  >
                    {r.flag === "widened" ? "Opened to all aircraft" : "Review"}
                  </StatusPill>
                </span>
                <span>{accessSummary(r)}</span>
                <span className="adm-review-members">{members(r)}</span>
              </div>
              <button
                type="button"
                className="button small adm-button"
                disabled={disabled}
                onClick={() => onEdit(r)}
              >
                Edit group
              </button>
            </li>
          ))}
        </ul>
      </NoticeBar>
    </section>
  );
}

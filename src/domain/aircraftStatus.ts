import { adAircraftUuid, adTaskStatus } from "./airworthiness";
import { requirementStatus } from "./components";
import {
  deferralDaysRemaining,
  deferralLabel,
  type Deferral,
} from "./deferrals";
import { inspectionStatus } from "./maintenance";
import { inspectionCounters } from "./management";
import { localDate, type Snapshot } from "./model";
import { programPermission } from "./programs";

export type AircraftStatusLevel = "airworthy" | "due-soon" | "grounded";
export interface AircraftStatusReason {
  kind:
    "profile" | "inspection" | "ad" | "component" | "discrepancy" | "deferral";
  label: string;
  entityUuid: string;
}
export interface AircraftStatus {
  level: AircraftStatusLevel;
  /** Reasons for the reported level only (grounding reasons when grounded). */
  reasons: AircraftStatusReason[];
}
/** MEL deferrals expiring within this many days are flagged as due soon. */
export const DEFERRAL_WARNING_DAYS = 3;
const short = (text: string) =>
  text.length > 80 ? text.slice(0, 77).trimEnd() + "…" : text;

/**
 * Airworthiness summary derived from recorded data. Missing schedules never
 * imply readiness elsewhere in the app; here they simply add no reason.
 */
export function aircraftStatus(
  s: Snapshot,
  aircraftUuid: string,
  today = localDate(),
): AircraftStatus {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) throw new Error("Aircraft not found.");
  const grounded: AircraftStatusReason[] = [];
  const soon: AircraftStatusReason[] = [];
  if (a.operationalStatus === "grounded")
    grounded.push({
      kind: "profile",
      label: "Marked grounded in the aircraft profile",
      entityUuid: a.uuid,
    });
  for (const i of s.inspections) {
    if (i.archived || i.aircraftUuid !== a.uuid) continue;
    let status;
    try {
      status = inspectionStatus(
        i,
        a,
        today,
        inspectionCounters(i, a, s.management),
      ).status;
    } catch {
      // Uncomputable schedules stay unverified, as on the Dashboard.
      continue;
    }
    const reason = { kind: "inspection" as const, entityUuid: i.uuid };
    if (status === "overdue")
      grounded.push({ ...reason, label: `${i.reference} overdue` });
    else if (status === "due-soon")
      soon.push({ ...reason, label: `${i.reference} due soon` });
  }
  const records = s.management ?? [];
  for (const c of records) {
    if (c.kind !== "component" || !c.installed || c.aircraftUuid !== a.uuid)
      continue;
    for (const r of records) {
      if (r.kind !== "componentRequirement" || r.componentUuid !== c.uuid)
        continue;
      let status;
      try {
        status = requirementStatus(r, c, a, today).status;
      } catch {
        continue;
      }
      const name = `${c.componentType}${c.serial ? ` S/N ${c.serial}` : ""}: ${r.description}`;
      const reason = { kind: "component" as const, entityUuid: r.uuid };
      // "Due now" is a usage limit with nothing left: it grounds, as an
      // inspection at 0 h does. A calendar limit due today is "Due soon".
      if (status === "Past due" || status === "Due now")
        grounded.push({ ...reason, label: `${name} ${status.toLowerCase()}` });
      else if (status === "Due soon")
        soon.push({ ...reason, label: `${name} due soon` });
    }
  }
  for (const r of s.airworthiness ?? []) {
    if (
      adAircraftUuid(s, r) !== a.uuid ||
      r.applicability === "Not applicable" ||
      r.applicability === "Superseded"
    )
      continue;
    const component = records.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (component?.kind === "component" && !component.installed) continue;
    const statuses = r.tasks.map((t) => adTaskStatus(s, r, t, today));
    const reason = { kind: "ad" as const, entityUuid: r.uuid };
    if (statuses.includes("Overdue"))
      grounded.push({ ...reason, label: `AD ${r.source.number} overdue` });
    else if (statuses.includes("Due soon"))
      soon.push({ ...reason, label: `AD ${r.source.number} due soon` });
  }
  for (const d of s.discrepancies) {
    if (d.aircraftUuid !== a.uuid || d.status !== "open") continue;
    if (d.deferral) {
      const days = deferralDaysRemaining(d.deferral, today);
      const reason = { kind: "deferral" as const, entityUuid: d.uuid };
      const label = deferralLabel(d.deferral as Deferral);
      if (days !== undefined && days < 0)
        grounded.push({
          ...reason,
          label: `${label} deferral expired ${d.deferral.expiresOn}`,
        });
      else if (days !== undefined && days <= DEFERRAL_WARNING_DAYS)
        soon.push({
          ...reason,
          label: `${label} deferral expires ${d.deferral.expiresOn}`,
        });
    } else if (d.grounding)
      grounded.push({
        kind: "discrepancy",
        label: `Open discrepancy: ${short(d.description)}`,
        entityUuid: d.uuid,
      });
  }
  return grounded.length
    ? { level: "grounded", reasons: grounded }
    : soon.length
      ? { level: "due-soon", reasons: soon }
      : { level: "airworthy", reasons: [] };
}

/** Earliest local date in any zone (UTC-12); server-safe "overdue" limit. */
export function earliestLocalDate(now = Date.now()) {
  return new Date(now - 12 * 3600000).toISOString().slice(0, 10);
}
export const MIN_OVERRIDE_REASON = 10;
export interface DispatchOverride {
  by: string;
  name: string;
  reason: string;
  at: number;
}
export const canOverrideDispatch = (s: Snapshot) =>
  programPermission(s, "admin");
/**
 * Blocks logging a flight for a grounded aircraft unless a Flight Program
 * administrator records a reason. Returns the override to store, if used.
 */
export function dispatchGate(
  s: Snapshot,
  aircraftUuid: string,
  overrideReason: string | undefined,
  today = localDate(),
  now = Date.now(),
): DispatchOverride | undefined {
  if (overrideReason !== undefined && !canOverrideDispatch(s))
    throw new Error(
      "Only a Flight Program administrator can override a grounded aircraft.",
    );
  const status = aircraftStatus(s, aircraftUuid, today);
  if (status.level !== "grounded") return undefined;
  const registration =
    s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration ??
    "This aircraft";
  if (overrideReason === undefined)
    throw new Error(
      `${registration} is grounded: ${status.reasons.map((r) => r.label).join("; ")}. Resolve these items or ask a Flight Program administrator to override.`,
    );
  const reason = overrideReason.trim();
  if (reason.length < MIN_OVERRIDE_REASON || reason.length > 1000)
    throw new Error(
      `Explain the dispatch override in ${MIN_OVERRIDE_REASON}–1000 characters.`,
    );
  return { by: s.user.id, name: s.user.name, reason, at: now };
}

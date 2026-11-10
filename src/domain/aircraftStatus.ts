/**
 * Responsibility: Aircraft status (airworthy, due soon or grounded, with
 *   reasons) and the dispatch gate that blocks flights on a grounded aircraft.
 * Layer: Domain. Pure rules shared by the browser and Convex; no I/O, no React.
 * Dependencies: ./airworthiness, ./deferrals, ./dueItems, ./model,
 *   ./programs, ./rejection.
 *
 * Status is derived from recorded data only. A missing or uncomputable
 * schedule adds no reason here; it never implies readiness elsewhere.
 */
import { CLOSED_APPLICABILITY } from "./airworthiness";
import {
  deferralDaysRemaining,
  deferralLabel,
  isGroundingReport,
  type Deferral,
} from "./deferrals";
import { dueItems, type MaintenanceDue, type RequirementDue } from "./dueItems";
import { localDate, type Aircraft, type Snapshot } from "./model";
import { programPermission } from "./programs";
import { Rejection } from "./rejection";

const OVERRIDE_REASON_MAX = 1000;
const DISCREPANCY_LABEL_MAX = 80;
const EARLIEST_ZONE_OFFSET_MS = 12 * 3600000;

/** How fit an aircraft is to fly (GLOSSARY "Aircraft status"). */
export type AircraftStatusLevel = "airworthy" | "due-soon" | "grounded";

/** One reason for a status level: the record's kind, a label and its uuid. */
export interface AircraftStatusReason {
  kind:
    "profile" | "inspection" | "ad" | "component" | "discrepancy" | "deferral";
  label: string;
  entityUuid: string;
}

/** An aircraft's status level and the reasons for that level. */
export interface AircraftStatus {
  level: AircraftStatusLevel;
  /** Reasons for the reported level only (grounding reasons when grounded). */
  reasons: AircraftStatusReason[];
}

/** One record's effect on the status: the level it causes and why. */
export interface AircraftStatusFinding {
  level: Exclude<AircraftStatusLevel, "airworthy">;
  reason: AircraftStatusReason;
}

/** Display name of each status level. */
export const aircraftStatusLabels: Record<AircraftStatusLevel, string> = {
  airworthy: "Airworthy",
  "due-soon": "Due soon",
  grounded: "Grounded",
};

/** Deferrals expiring within this many days are flagged as due soon. */
export const DEFERRAL_WARNING_DAYS = 3;

/**
 * Computes an aircraft's status. It is grounded by its profile, an overdue
 * inspection, component limit or AD, an expired deferral or an open grounding
 * discrepancy, and due soon when any of these is near.
 *
 * @param s - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft.
 * @param today - Local date (YYYY-MM-DD) that calendar limits are judged on.
 * @returns The level, with its reasons in the order profile, inspections,
 *   components, ADs, then discrepancies; none when airworthy.
 * @throws {Error} "Aircraft not found." for an unknown aircraft.
 */
export function aircraftStatus(
  s: Snapshot,
  aircraftUuid: string,
  today = localDate(),
): AircraftStatus {
  const findings = aircraftStatusFindings(s, aircraftUuid, today);
  const grounded = reasonsAt(findings, "grounded");
  if (grounded.length) return { level: "grounded", reasons: grounded };
  const soon = reasonsAt(findings, "due-soon");
  if (soon.length) return { level: "due-soon", reasons: soon };
  return { level: "airworthy", reasons: [] };
}

/**
 * Lists every record that grounds an aircraft or is due soon, each at its
 * own level, for a document that must mark each record the way
 * {@link aircraftStatus} judged it.
 *
 * @param s - Snapshot holding the aircraft and its records.
 * @param aircraftUuid - The aircraft.
 * @param today - Local date (YYYY-MM-DD) that calendar limits are judged on.
 * @returns Grounding and due-soon findings together, in the order profile,
 *   inspections, components, ADs, then discrepancies.
 * @throws {Error} "Aircraft not found." for an unknown aircraft.
 */
export function aircraftStatusFindings(
  s: Snapshot,
  aircraftUuid: string,
  today = localDate(),
): AircraftStatusFinding[] {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) throw new Error("Aircraft not found.");
  const due = dueItems(s, a.uuid, today);
  return [
    ...listProfileFindings(a),
    ...listInspectionFindings(due),
    ...listComponentFindings(s, due),
    ...listAdFindings(due),
    ...listDiscrepancyFindings(s, a, today),
  ];
}

/**
 * Gets the earliest calendar date anywhere (UTC-12), so the server, which
 * does not know a device's time zone, never finds a limit overdue that the
 * device still accepted.
 *
 * @param now - Time in epoch milliseconds.
 * @returns The date as YYYY-MM-DD.
 */
export function earliestLocalDate(now = Date.now()) {
  return new Date(now - EARLIEST_ZONE_OFFSET_MS).toISOString().slice(0, 10);
}

/** Shortest dispatch-override reason accepted, in characters after trimming. */
export const MIN_OVERRIDE_REASON = 10;

/** An administrator's override of the dispatch gate, stored with the flight. */
export interface DispatchOverride {
  by: string;
  name: string;
  reason: string;
  at: number;
}

/**
 * Tells whether the user may override the dispatch gate.
 *
 * @param s - Snapshot, for the user and the active program.
 * @returns True for an active Flight Program or system administrator.
 */
export const canOverrideDispatch = (s: Snapshot) =>
  programPermission(s, "admin");

/**
 * Blocks logging a flight on a grounded aircraft unless a Flight Program
 * administrator records a reason.
 *
 * @param s - Snapshot holding the user and the aircraft's records.
 * @param aircraftUuid - The aircraft.
 * @param overrideReason - The administrator's reason, or undefined for none.
 * @param today - Local date for {@link aircraftStatus}.
 * @param now - Time stamped on the override.
 * @returns The override to store with the flight, or undefined when the
 *   aircraft is not grounded (a reason given is then unused).
 * @throws {Rejection} When a non-administrator gives a reason (even if not
 *   grounded); "<registration> is grounded: <reasons>. …" without a reason;
 *   "Explain the dispatch override in 10–1000 characters." for a bad reason.
 */
export function dispatchGate(
  s: Snapshot,
  aircraftUuid: string,
  overrideReason: string | undefined,
  today = localDate(),
  now = Date.now(),
): DispatchOverride | undefined {
  if (overrideReason !== undefined && !canOverrideDispatch(s))
    throw new Rejection(
      "Only a Flight Program administrator can override a grounded aircraft.",
    );
  const status = aircraftStatus(s, aircraftUuid, today);
  if (status.level !== "grounded") return undefined;
  const registration =
    s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration ??
    "This aircraft";
  if (overrideReason === undefined)
    throw new Rejection(
      `${registration} is grounded: ${status.reasons.map((r) => r.label).join("; ")}. Resolve these items or ask a Flight Program administrator to override.`,
    );
  const reason = overrideReason.trim();
  if (
    reason.length < MIN_OVERRIDE_REASON ||
    reason.length > OVERRIDE_REASON_MAX
  )
    throw new Rejection(
      `Explain the dispatch override in ${MIN_OVERRIDE_REASON}–${OVERRIDE_REASON_MAX} characters.`,
    );
  return { by: s.user.id, name: s.user.name, reason, at: now };
}

type Finding = AircraftStatusFinding;
type ReasonKind = AircraftStatusReason["kind"];

function reasonsAt(findings: Finding[], level: Finding["level"]) {
  return findings.filter((f) => f.level === level).map((f) => f.reason);
}

function flagGrounded(kind: ReasonKind, entityUuid: string, label: string) {
  return [{ level: "grounded", reason: { kind, label, entityUuid } } as const];
}

function flagDueSoon(kind: ReasonKind, entityUuid: string, label: string) {
  return [{ level: "due-soon", reason: { kind, label, entityUuid } } as const];
}

function listProfileFindings(a: Aircraft): Finding[] {
  if (a.operationalStatus !== "grounded") return [];
  const label = "Marked grounded in the aircraft profile";
  return flagGrounded("profile", a.uuid, label);
}

// The Reference is optional, so the label falls back to the description, as
// alerts and the status sheet name it. An inspection of a component removed
// to storage does not ground the aircraft it came off, as for its ADs.
function listInspectionFindings(due: MaintenanceDue[]) {
  return due.flatMap((item): Finding[] => {
    if (item.kind !== "inspection" || item.component?.installed === false)
      return [];
    const { uuid, reference, description } = item.inspection;
    const name = reference || description;
    if (item.level === "overdue")
      return flagGrounded("inspection", uuid, `${name} overdue`);
    if (item.level !== "due-soon") return [];
    return flagDueSoon("inspection", uuid, `${name} due soon`);
  });
}

// Reasons follow component order, then each component's requirements.
function listComponentFindings(s: Snapshot, due: MaintenanceDue[]) {
  const records = s.management ?? [];
  return due
    .filter((item) => item.kind === "componentRequirement")
    .sort((x, y) => records.indexOf(x.component) - records.indexOf(y.component))
    .flatMap(listRequirementFindings);
}

// The label keeps the component's own word: "past due" or "due now".
function listRequirementFindings(item: RequirementDue): Finding[] {
  const { requirement: r, component: c, due, level } = item;
  if (!due) return [];
  const name = `${c.componentType}${c.serial ? ` S/N ${c.serial}` : ""}: ${r.description}`;
  if (level === "overdue")
    return flagGrounded(
      "component",
      r.uuid,
      `${name} ${due.status.toLowerCase()}`,
    );
  if (level !== "due-soon") return [];
  return flagDueSoon("component", r.uuid, `${name} due soon`);
}

// An AD on a removed component does not ground the aircraft it came off.
function listAdFindings(due: MaintenanceDue[]) {
  return due.flatMap((item): Finding[] => {
    if (item.kind !== "ad" || (item.component && !item.component.installed))
      return [];
    const { uuid, applicability, source } = item.ad;
    if (CLOSED_APPLICABILITY.includes(applicability)) return [];
    const levels = item.tasks.map((t) => t.level);
    if (levels.includes("overdue"))
      return flagGrounded("ad", uuid, `AD ${source.number} overdue`);
    if (!levels.includes("due-soon")) return [];
    return flagDueSoon("ad", uuid, `AD ${source.number} due soon`);
  });
}

function listDiscrepancyFindings(s: Snapshot, a: Aircraft, today: string) {
  return s.discrepancies.flatMap((d): Finding[] => {
    if (d.aircraftUuid !== a.uuid) return [];
    if (isGroundingReport(d)) {
      const label = `Open discrepancy: ${shortenDescription(d.description)}`;
      return flagGrounded("discrepancy", d.uuid, label);
    }
    if (d.status !== "open" || !d.deferral) return [];
    return listDeferralFindings(d.uuid, d.deferral, today);
  });
}

function listDeferralFindings(
  uuid: string,
  deferral: Deferral,
  today: string,
): Finding[] {
  const days = deferralDaysRemaining(deferral, today);
  const name = deferralLabel(deferral);
  if (days === undefined || days > DEFERRAL_WARNING_DAYS) return [];
  const expired = days < 0;
  const label = `${name} deferral ${expired ? "expired" : "expires"} ${deferral.expiresOn}`;
  return expired
    ? flagGrounded("deferral", uuid, label)
    : flagDueSoon("deferral", uuid, label);
}

function shortenDescription(text: string) {
  return text.length > DISCREPANCY_LABEL_MAX
    ? text.slice(0, DISCREPANCY_LABEL_MAX - 3).trimEnd() + "…"
    : text;
}

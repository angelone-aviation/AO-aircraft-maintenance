/**
 * Responsibility: Decides which records a list's search box keeps: the
 *   shared text match and the fields each searchable record list offers.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, workOrders.ts, taskCards.ts,
 *   airworthiness.ts, alerts.ts (types).
 */
import type { Discrepancy, Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import type { TaskCard } from "./taskCards";
import type { AD } from "./airworthiness";
import type { Alert } from "./alerts";

type Names = Pick<Snapshot, "aircraft" | "members">;
type SearchedWorkOrder = Pick<WorkOrder, "number" | "supervisor" | "scope"> & {
  aircraft: Pick<WorkOrder["aircraft"], "registration">;
  tasks: Pick<WorkOrder["tasks"][number], "description">[];
};
type SearchedTaskCard = Pick<
  TaskCard,
  "cardNumber" | "title" | "description" | "aircraftUuid" | "workOrderUuid"
>;

/**
 * Whether a record with these searchable fields matches what the user typed.
 *
 * @param search - The search box text; surrounding spaces are ignored.
 * @param fields - The record's searchable text; missing values are skipped.
 * @returns True for a blank search, or when one field contains the search,
 *   ignoring case. A search never matches across two fields.
 */
export function matchesSearch(
  search: string,
  fields: readonly (string | undefined)[],
): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return fields.some((field) => field?.toLowerCase().includes(query));
}

/**
 * Whether a work order matches the search: its number, aircraft
 * registration, supervisor, scope or a work item's description.
 */
export function workOrderMatches(
  order: SearchedWorkOrder,
  search: string,
): boolean {
  return matchesSearch(search, [
    order.number,
    order.aircraft.registration,
    order.supervisor,
    order.scope,
    ...order.tasks.map((task) => task.description),
  ]);
}

/**
 * Whether a job card or template matches the search: its card number, title,
 * description, aircraft registration or work order number.
 *
 * @param s - Supplies the registration and work order number.
 */
export function taskCardMatches(
  s: Pick<Snapshot, "aircraft"> & {
    workOrders?: Pick<WorkOrder, "uuid" | "number">[];
  },
  card: SearchedTaskCard,
  search: string,
): boolean {
  return matchesSearch(search, [
    card.cardNumber,
    card.title,
    card.description,
    registrationOf(s, card.aircraftUuid),
    s.workOrders?.find((w) => w.uuid === card.workOrderUuid)?.number,
  ]);
}

/**
 * Whether an AD matches the search: its number, subject, section, make,
 * model, amendment, superseding AD or a required action's description.
 */
export function adMatches(
  record: Pick<AD, "source" | "tasks">,
  search: string,
): boolean {
  const { source } = record;
  return matchesSearch(search, [
    source.number,
    source.subject,
    source.section,
    source.make,
    source.model,
    source.amendment,
    source.supersededBy,
    ...record.tasks.map((task) => task.description),
  ]);
}

/**
 * Whether a discrepancy report matches the search: its aircraft
 * registration, description, resolution or reporter's name.
 *
 * @param s - Supplies the registration and the reporter's name.
 */
export function discrepancyMatches(
  s: Names,
  report: Discrepancy,
  search: string,
): boolean {
  return matchesSearch(search, [
    registrationOf(s, report.aircraftUuid),
    report.description,
    report.resolution,
    s.members.find((m) => m.id === report.authorId)?.name,
  ]);
}

/**
 * Whether an alert matches the search: its title, detail or aircraft
 * registration.
 *
 * @param s - Supplies the registration.
 */
export function alertMatches(
  s: Pick<Snapshot, "aircraft">,
  alert: Alert,
  search: string,
): boolean {
  return matchesSearch(search, [
    alert.title,
    alert.detail,
    alert.aircraftUuid && registrationOf(s, alert.aircraftUuid),
  ]);
}

function registrationOf(s: Pick<Snapshot, "aircraft">, aircraftUuid: string) {
  return s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration;
}

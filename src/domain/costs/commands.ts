/**
 * Responsibility: Applying cost commands: labor and other costs, part unit
 *   costs, budgets and the labor rate, each with its change-log row.
 * Layer: Domain. An applier on a working snapshot; no I/O, no React.
 * Dependencies: ../model, ../programs, ../workOrders, ../rejection,
 *   ./records, ./units, ./workOrderCosts, ./save.
 */
import { can, latestLocalDate, type Snapshot } from "../model";
import { activeProgram, programPermission } from "../programs";
import { isOpenWorkOrder, type WorkOrder } from "../workOrders";
import { Rejection } from "../rejection";
import {
  costCommandSchema,
  workOrderCostSchema,
  type CostCommand,
  type CostRecord,
  type WorkOrderCost,
} from "./records";
import { SECONDS_PER_MINUTE } from "./units";
import {
  findBudget,
  findWorkOrderCost,
  laborRate,
  partIssues,
} from "./workOrderCosts";
import { emptyWorkOrderCost, saveCostRecord } from "./save";

/**
 * Applies one cost command to the snapshot and returns the changed record.
 * Granular add/remove commands never overwrite fields a non-administrator
 * cannot see (rates, amounts).
 *
 * @returns The saved record. Adding an entry whose uuid is already stored
 *   returns the stored record and changes nothing.
 * @throws {Rejection} For a refused command: no active program, missing
 *   access, an unknown or closed work order, a future date, or an entry or
 *   part that is not there.
 * @throws {z.ZodError} For an invalid command or result.
 *
 * Side effects: replaces the record in `s.costs` and prepends a
 * `cost.<action>` entry to `s.audit`.
 */
export function applyCostCommand(
  s: Snapshot,
  raw: CostCommand,
  now = Date.now(),
): CostRecord {
  const c = costCommandSchema.parse(raw);
  const program = activeProgram(s);
  if (!program || !s.user.active)
    throw new Rejection("Select a Flight Program first.");
  const change = { action: c.action, program, now };
  if (c.action === "settings.laborRate")
    return saveCostRecord(s, change, laborRateRecord(s, c, program));
  if (c.action === "budget.set") {
    const budget = budgetRecord(s, c, program);
    return saveCostRecord(
      s,
      { ...change, aircraftUuid: c.aircraftUuid },
      budget,
    );
  }
  const w = openOrder(s, c.workOrderUuid, isAdmin(s));
  // Records stay with the program that paid when the aircraft moves
  // (decision D14), so a command only ever edits its own program's.
  const record =
    findWorkOrderCost(s, w.uuid, program) ?? emptyWorkOrderCost(w, program);
  const changed = changeWorkOrderCost(s, c, w, record, now);
  if (!changed) return record;
  const next = workOrderCostSchema.parse({
    ...record,
    ...changed,
    version: record.version + 1,
  });
  return saveCostRecord(s, { ...change, aircraftUuid: w.aircraftUuid }, next);
}

type WorkOrderCommand = Exclude<
  CostCommand,
  { action: "settings.laborRate" | "budget.set" }
>;

const isAdmin = (s: Snapshot) => programPermission(s, "admin");

function requireAdmin(s: Snapshot) {
  if (!isAdmin(s))
    throw new Rejection("Flight Program administrator access is required.");
}

// An administrator may cost any work order they can read; others need
// maintenance access to its aircraft.
function openOrder(s: Snapshot, workOrderUuid: string, admin: boolean) {
  const w = s.workOrders?.find((w) => w.uuid === workOrderUuid);
  if (!w || !can(s, w.aircraftUuid, admin ? "read" : "maintenance"))
    throw new Rejection("Work order not found.");
  if (!isOpenWorkOrder(w))
    throw new Rejection("This work order is closed. Its costs are read-only.");
  return w;
}

function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Rejection("Cost dates cannot be in the future.");
}

function laborRateRecord(
  s: Snapshot,
  c: Extract<CostCommand, { action: "settings.laborRate" }>,
  program: string,
): CostRecord {
  requireAdmin(s);
  const prior = s.costs?.find(
    (r) => r.kind === "settings" && r.programUuid === program,
  );
  return {
    uuid: prior?.uuid ?? crypto.randomUUID(),
    version: (prior?.version ?? 0) + 1,
    programUuid: program,
    kind: "settings",
    laborRateCents: c.laborRateCents,
  };
}

function budgetRecord(
  s: Snapshot,
  c: Extract<CostCommand, { action: "budget.set" }>,
  program: string,
): CostRecord {
  requireAdmin(s);
  if (!can(s, c.aircraftUuid, "read"))
    throw new Rejection("Aircraft not found.");
  const prior = findBudget(s, c.aircraftUuid, c.year, program);
  return {
    uuid: prior?.uuid ?? crypto.randomUUID(),
    version: (prior?.version ?? 0) + 1,
    programUuid: program,
    kind: "budget",
    aircraftUuid: c.aircraftUuid,
    year: c.year,
    amountCents: c.amountCents,
  };
}

// Undefined when the entry was already added: the command is idempotent.
function changeWorkOrderCost(
  s: Snapshot,
  c: WorkOrderCommand,
  w: WorkOrder,
  record: WorkOrderCost,
  now: number,
): Partial<WorkOrderCost> | undefined {
  if (c.action === "labor.add") return addLabor(s, c, record, now);
  if (c.action === "labor.remove") return removeLabor(s, c.uuid, record);
  requireAdmin(s);
  if (c.action === "other.add") return addOther(s, c, record, now);
  if (c.action === "other.remove") return removeOther(c.uuid, record);
  if (c.action !== "part.unitCost") throw new Error("Unknown command.");
  if (!partIssues(s, w).some((i) => i.stockUuid === c.stockUuid))
    throw new Rejection("That part was not issued to this work order.");
  const rest = record.partUnitCosts.filter((p) => p.stockUuid !== c.stockUuid);
  if (c.unitCents === null) return { partUnitCosts: rest };
  const manual = { stockUuid: c.stockUuid, unitCents: c.unitCents };
  return { partUnitCosts: [...rest, manual] };
}

// Labor added without a rate is priced at the program rate in force now.
function addLabor(
  s: Snapshot,
  c: Extract<CostCommand, { action: "labor.add" }>,
  record: WorkOrderCost,
  now: number,
) {
  if (c.entry.rateCents !== undefined && !isAdmin(s))
    throw new Rejection("Only Flight Program administrators can set rates.");
  checkDate(c.entry.date, now);
  if (record.labor.some((e) => e.uuid === c.entry.uuid)) return undefined;
  const { seconds } = c.entry;
  const entry = {
    ...c.entry,
    minutes:
      seconds === undefined
        ? c.entry.minutes!
        : Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE)),
    rateCents: c.entry.rateCents ?? laborRate(s) ?? 0,
    createdBy: s.user.id,
    createdAt: now,
  };
  return { labor: [...record.labor, entry] };
}

function removeLabor(s: Snapshot, uuid: string, record: WorkOrderCost) {
  const entry = record.labor.find((e) => e.uuid === uuid);
  if (!entry) throw new Rejection("Labor entry not found.");
  if (!isAdmin(s) && entry.createdBy !== s.user.id)
    throw new Rejection("You can only remove labor you recorded.");
  return { labor: record.labor.filter((e) => e.uuid !== uuid) };
}

function addOther(
  s: Snapshot,
  c: Extract<CostCommand, { action: "other.add" }>,
  record: WorkOrderCost,
  now: number,
) {
  checkDate(c.entry.date, now);
  if (record.other.some((e) => e.uuid === c.entry.uuid)) return undefined;
  const entry = { ...c.entry, createdBy: s.user.id, createdAt: now };
  return { other: [...record.other, entry] };
}

function removeOther(uuid: string, record: WorkOrderCost) {
  if (!record.other.some((e) => e.uuid === uuid))
    throw new Rejection("Cost entry not found.");
  return { other: record.other.filter((e) => e.uuid !== uuid) };
}

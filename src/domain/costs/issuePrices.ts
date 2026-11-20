/**
 * Responsibility: Recording the unit cost a part is issued at on the cost
 *   record of each work order that counts the issue (decision D13).
 * Layer: Domain. Mutates a working snapshot; no I/O, no React.
 * Dependencies: ../model, ../programs, ../partsRequests (types),
 *   ../rejection, ./records, ./workOrderCosts, ./save.
 *
 * Pilots and mechanics read parts requests and their change log, while stock
 * costs are for administrators only, so the price goes on the work order's
 * cost record, never on the issue.
 */
import type { Snapshot } from "../model";
import { activeProgram } from "../programs";
import type { PartsRequest } from "../partsRequests";
import { Rejection } from "../rejection";
import { workOrderCostSchema } from "./records";
import {
  findWorkOrderCost,
  issueWorkOrders,
  pricedIssue,
} from "./workOrderCosts";
import { emptyWorkOrderCost, saveCostRecord } from "./save";

/**
 * Records a new issue at its stock item's unit cost now, on the active
 * program's cost record of each work order that counts it, creating the
 * record if needed. Closed work orders record it too: the issue counts on
 * them whatever their status.
 *
 * @param r - The request the issue was made on.
 * @param issue - The issue as the request stores it.
 * @throws {Rejection} "Select a Flight Program first." with no active program.
 * @throws {z.ZodError} When a record would pass its issued-part limit.
 *
 * Side effects: replaces each record in `s.costs` and prepends a
 * `cost.part.issue` entry to `s.audit` for it.
 */
export function recordIssuedPart(
  s: Snapshot,
  r: PartsRequest,
  issue: PartsRequest["issues"][number],
  now: number,
) {
  const program = activeProgram(s);
  if (!program) throw new Rejection("Select a Flight Program first.");
  const part = pricedIssue(s, r, issue);
  for (const w of issueWorkOrders(s, r)) {
    const record =
      findWorkOrderCost(s, w.uuid, program) ?? emptyWorkOrderCost(w, program);
    const next = workOrderCostSchema.parse({
      ...record,
      issuedParts: [...(record.issuedParts ?? []), part],
      version: record.version + 1,
    });
    const change = { program, now, aircraftUuid: w.aircraftUuid };
    saveCostRecord(s, { ...change, action: "part.issue" }, next);
  }
}

/**
 * Responsibility: The cost report history query: an aircraft's work-order
 *   costs over a period, summed from the cost ledger.
 * Layer: Server. A public Convex query; the cost rules come from src/domain.
 * Dependencies: convex/values, ./_generated, ./programContext, ./collections,
 *   ./costLedger, ./workingSet, ./userErrors, src/domain (costs, programs,
 *   model, auditHistory).
 *
 * It checks the program first (checkContext refuses a stale program, owners
 * and board members), then that the caller administers it and may read the
 * aircraft (ADR-0013), as the other history queries do.
 */
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { checkContext } from "./programContext";
import { decode } from "./collections";
import { ledgerRowsOf } from "./costLedger";
import { budgetAndSettingsDocs, workOrderDocsByUuid } from "./workingSet";
import { exposeRejections } from "./userErrors";
import { ledgerCostReport } from "../src/domain/costs/ledger";
import { periodFor, type Period } from "../src/domain/costs/period";
import type { CostRecord } from "../src/domain/costs/records";
import { activeProgram, programPermission } from "../src/domain/programs";
import { can } from "../src/domain/model";
import { HISTORY_NOT_FOUND } from "../src/domain/auditHistory";

/**
 * An aircraft's work-order costs over a period, from the cost ledger: each
 * work order with costs in it and its labor time and money, the totals, and
 * the aircraft's budgets for the years the period touches. Parts count at
 * the prices the records fix (src/domain/costs/ledger.ts); the paying
 * program's rows only, so an aircraft that moved shows only its own costs.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param aircraftUuid - The aircraft.
 * @param from - The first date, as an ISO date.
 * @param to - The last date, inclusive.
 * @returns As `ledgerCostReport`, with `budgets` by year.
 * @throws {ConvexError} As `checkContext`, first; "Flight Program
 *   administrator required."; "History not found." for an aircraft the
 *   caller cannot read; "Choose a start and end date."; "Choose a start date
 *   on or before the end date."
 */
export const costReport = query({
  args: {
    programUuid: v.optional(v.string()),
    aircraftUuid: v.string(),
    from: v.string(),
    to: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const program = activeProgram(state);
    if (!program || !programPermission(state, "admin"))
      throw new ConvexError("Flight Program administrator required.");
    if (!can(state, args.aircraftUuid, "read"))
      throw new ConvexError(HISTORY_NOT_FOUND);
    const period = exposeRejections(() =>
      periodFor("custom", args.to, { from: args.from, to: args.to }),
    );
    const rows = await ledgerRowsOf(ctx, program, args.aircraftUuid, period);
    const orders = await workOrderDocsByUuid(
      ctx,
      rows.map((r) => r.workOrderUuid),
      state.aircraft,
    );
    const costs = decode("costs", await budgetAndSettingsDocs(ctx, program));
    return {
      ...ledgerCostReport(rows, decode("workOrders", orders), period),
      budgets: budgetsIn(costs, args.aircraftUuid, period),
    };
  },
});

function budgetsIn(costs: CostRecord[], aircraftUuid: string, period: Period) {
  const first = Number(period.from.slice(0, 4));
  const last = Number(period.to.slice(0, 4));
  return costs
    .flatMap((r) =>
      r.kind === "budget" &&
      r.aircraftUuid === aircraftUuid &&
      r.year >= first &&
      r.year <= last
        ? [{ year: r.year, amountCents: r.amountCents }]
        : [],
    )
    .sort((x, y) => x.year - y.year);
}

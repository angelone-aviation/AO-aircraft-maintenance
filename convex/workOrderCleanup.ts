/**
 * Responsibility: The one-off migration that strips retired authorization
 *   fields from saved work orders.
 * Layer: Server. An internal mutation run by hand; the field list is the
 *   domain's.
 * Dependencies: convex/access, src/domain/workOrderCleanup.
 *
 * Change-log rows are never edited (ADR-0005); each changed order gets one
 * appended entry instead. Before 2026-11-02 this migration also rewrote
 * before/after on existing rows; see the note in ADR-0005.
 */
import { internalMutation } from "./_generated/server";
import { audit } from "./access";
import {
  removeWorkOrderAuthorization,
  retiredWorkOrderFields,
} from "../src/domain/workOrderCleanup";

/**
 * Removes the retired fields from every saved work order, and audits each
 * changed order as `workOrder.retiredFieldsRemoved` by `system:migration`,
 * with the removed values as `before`. Running it again changes nothing.
 *
 * @returns How many orders were checked and how many changed.
 */
export const removeAuthorization = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.query("workOrders").collect();
    let ordersChanged = 0;
    for (const order of orders) {
      const saved = JSON.parse(order.payload);
      const payload = JSON.stringify(removeWorkOrderAuthorization(saved));
      if (payload === order.payload) continue;
      await ctx.db.patch(order._id, { payload });
      await audit(
        ctx,
        "system:migration",
        "workOrder.retiredFieldsRemoved",
        order.uuid,
        {
          aircraftUuid: order.aircraftUuid,
          reason: "Retired work-order authorization fields removed.",
          before: retiredWorkOrderFields(saved),
        },
      );
      ordersChanged++;
    }
    return { ordersChecked: orders.length, ordersChanged };
  },
});

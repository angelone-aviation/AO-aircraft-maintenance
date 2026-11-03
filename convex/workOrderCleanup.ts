import { internalMutation } from "./_generated/server";
import { audit } from "./access";
import {
  removeWorkOrderAuthorization,
  retiredWorkOrderFields,
} from "../src/domain/workOrderCleanup";

// Removes retired authorization fields from saved work orders. Change-log rows
// are never edited (ADR-0005): each changed order gets one appended entry
// recording the values removed. Before 2026-11-02 this migration also rewrote
// before/after on existing rows; see the note in ADR-0005.
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

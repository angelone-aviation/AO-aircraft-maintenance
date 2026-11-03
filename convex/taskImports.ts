import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  inspectionTemplateDocs,
} from "./programContext";
import { audit } from "./access";
import { importTaskCsv } from "../src/domain/taskCsv";
import { inspectionTemplateSchema } from "../src/domain/inspectionTemplates";
import { taskCardSchema } from "../src/domain/taskCards";
import { recordSchema } from "../src/domain/management";
import type { Snapshot } from "../src/domain/model";
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, { payload, programUuid }) => {
    const state = await checkContext(ctx, programUuid);
    const templates = await inspectionTemplateDocs(ctx, programUuid);
    const management = await managementDocs(ctx, programUuid);
    const s: Snapshot = {
      ...state,
      inspectionTemplates: templates.map((t) =>
        inspectionTemplateSchema.parse(JSON.parse(t.payload)),
      ),
      inspections: await inspectionDocs(ctx, state.aircraft, management),
      taskCards: (await taskCardDocs(ctx, state.aircraft)).map((t) =>
        taskCardSchema.parse(JSON.parse(t.payload)),
      ),
      management: management.map((r) =>
        recordSchema.parse(JSON.parse(r.payload)),
      ),
    };
    const result = importTaskCsv(s, JSON.parse(payload));
    if (result.template) {
      const doc = templates.find((t) => t.uuid === result.template!.uuid)!;
      await ctx.db.patch(doc._id, { payload: JSON.stringify(result.template) });
    }
    for (const task of result.tasks)
      await ctx.db.insert("taskCards", {
        uuid: task.uuid,
        aircraftUuid: task.aircraftUuid,
        payload: JSON.stringify(task),
      });
    for (const entry of s.audit)
      await audit(ctx, state.user.id, entry.action, entry.entityUuid, {
        programUuid,
        aircraftUuid: entry.aircraftUuid,
        reason: entry.reason,
        after: entry.after ? JSON.parse(entry.after) : undefined,
        before: entry.before ? JSON.parse(entry.before) : undefined,
      });
    return result.count;
  },
});

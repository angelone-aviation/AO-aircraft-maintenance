import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import {
  checkContext,
  managementDocs,
  componentTemplateDocs,
  componentSetupDocs,
} from "./programContext";
import { audit } from "./access";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../src/domain/componentTemplates";
import { recordSchema } from "../src/domain/management";
const args = { payload: v.string(), programUuid: v.optional(v.string()) };
export const save = mutation({
  args,
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const docs = await componentTemplateDocs(ctx, args.programUuid);
    const s = {
      ...state,
      componentTemplates: docs.map((d) => JSON.parse(d.payload)),
    };
    const next = (() => {
      try {
        return saveComponentTemplate(s, JSON.parse(args.payload));
      } catch (e) {
        throw new ConvexError(e instanceof Error ? e.message : String(e));
      }
    })();
    const old = docs.find((d) => d.uuid === next.uuid);
    const fields = {
      uuid: next.uuid,
      programUuid: next.programUuid,
      payload: JSON.stringify(next),
    };
    if (old) await ctx.db.replace(old._id, fields);
    else if (
      await ctx.db
        .query("componentTemplates")
        .withIndex("uuid", (q) => q.eq("uuid", next.uuid))
        .first()
    )
      throw new ConvexError("Template belongs to another Flight Program.");
    else await ctx.db.insert("componentTemplates", fields);
    await audit(ctx, state.user.id, "componentTemplate.save", next.uuid, {
      programUuid: next.programUuid,
      before: old ? JSON.parse(old.payload) : undefined,
      after: next,
    });
    return next.uuid;
  },
});
export const apply = mutation({
  args,
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const s = {
      ...state,
      componentTemplates: (
        await componentTemplateDocs(ctx, args.programUuid)
      ).map((d) => JSON.parse(d.payload)),
      componentSetups: (await componentSetupDocs(ctx, args.programUuid)).map(
        (d) => JSON.parse(d.payload),
      ),
      management: (await managementDocs(ctx, args.programUuid)).map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
    };
    const added = (() => {
      try {
        return applyComponentTemplate(s, JSON.parse(args.payload));
      } catch (e) {
        throw new ConvexError(e instanceof Error ? e.message : String(e));
      }
    })();
    for (const d of added) {
      await ctx.db.insert("componentSetups", {
        uuid: d.uuid,
        programUuid: d.programUuid,
        aircraftUuid: d.aircraftUuid,
        payload: JSON.stringify(d),
      });
      await audit(ctx, state.user.id, "component.setupImported", d.uuid, {
        programUuid: d.programUuid,
        aircraftUuid: d.aircraftUuid,
        after: d,
      });
    }
    return added.length;
  },
});

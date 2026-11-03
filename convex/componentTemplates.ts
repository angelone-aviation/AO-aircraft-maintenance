import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { runCommand, hydrate, allErrors } from "./runCommand";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../src/domain/componentTemplates";
const args = { payload: v.string(), programUuid: v.optional(v.string()) };
export const save = mutation({
  args,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      // Parsed inside apply: malformed input is a user-facing rejection too.
      parse: () => args.payload,
      load: ({ ctx, state }) => hydrate(ctx, state, ["componentTemplates"]),
      apply: ({ snapshot }, payload) =>
        saveComponentTemplate(snapshot, JSON.parse(payload)),
      expose: allErrors,
      persist: async ({ ctx }, { docs }, next) => {
        const old = docs.componentTemplates.find((d) => d.uuid === next.uuid);
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
      },
      audit: (log, { docs }, next) => {
        const old = docs.componentTemplates.find((d) => d.uuid === next.uuid);
        log.entry("componentTemplate.save", next.uuid, {
          programUuid: next.programUuid,
          before: old ? JSON.parse(old.payload) : undefined,
          after: next,
        });
      },
      returns: (next) => next.uuid,
    }),
});
export const apply = mutation({
  args,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => args.payload,
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "componentTemplates",
          "componentSetups",
          "management",
        ]),
      apply: ({ snapshot }, payload) =>
        applyComponentTemplate(snapshot, JSON.parse(payload)),
      expose: allErrors,
      persist: async ({ ctx }, _, added) => {
        for (const d of added)
          await ctx.db.insert("componentSetups", {
            uuid: d.uuid,
            programUuid: d.programUuid,
            aircraftUuid: d.aircraftUuid,
            payload: JSON.stringify(d),
          });
      },
      audit: (log, _, added) => {
        for (const d of added)
          log.entry("component.setupImported", d.uuid, {
            programUuid: d.programUuid,
            aircraftUuid: d.aircraftUuid,
            after: d,
          });
      },
      returns: (added) => added.length,
    }),
});

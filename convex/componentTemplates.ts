/**
 * Responsibility: Component templates: saving one in the Flight Program, and
 *   adding its rows to an aircraft's component setup list.
 * Layer: Server. Two public mutations through runCommand; the rules are the
 *   domain's saveComponentTemplate and applyComponentTemplate.
 * Dependencies: convex/runCommand, src/domain/componentTemplates.
 *
 * Both parse the payload inside the domain step and show every error it
 * throws, so malformed input is refused with its message too.
 */
import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { runCommand, hydrate, allErrors } from "./runCommand";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../src/domain/componentTemplates";

const args = { payload: v.string(), programUuid: v.optional(v.string()) };

/**
 * Saves a component template as its next version in the caller's Flight
 * Program, and audits `componentTemplate.save` with the stored and saved
 * versions.
 *
 * @param payload - JSON, as `saveComponentTemplate` reads it.
 * @param programUuid - The caller's active Flight Program.
 * @returns The template's uuid.
 * @throws {ConvexError} As `runCommand`; any error saveComponentTemplate or
 *   the JSON parser throws, with its message ("Template changed. Reopen
 *   it.", …); "Template belongs to another Flight Program." for a new uuid
 *   another program uses.
 */
export const save = mutation({
  args,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
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
        // The scoped load cannot see other programs' templates.
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

/**
 * Adds the chosen rows of a component template to an aircraft's component
 * setup list, and audits `component.setupImported` for each. A row already
 * added is skipped; no component is installed.
 *
 * @param payload - JSON: `templateUuid`, the template `version` previewed,
 *   `aircraftUuid` and the `rowIds` to add.
 * @param programUuid - The caller's active Flight Program.
 * @returns How many rows were added.
 * @throws {ConvexError} As `runCommand`; any error applyComponentTemplate or
 *   the JSON parser throws, with its message ("Template changed. Reopen the
 *   preview.", "Aircraft make and model must match the template.", …).
 */
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

/**
 * Responsibility: Component templates: saving one in the Flight Program, and
 *   adding its rows to an aircraft's component setup list.
 * Layer: Server. Two public mutations through runCommand; the rules are the
 *   domain's saveComponentTemplate and applyComponentTemplate.
 * Dependencies: convex/runCommand, src/domain/componentTemplates.
 *
 * Both parse the payload inside the domain step and show every error it
 * throws, so malformed input is refused with its message too. Their request
 * id is read from the payload first; the domain schemas drop it, so it is
 * never stored in a template or setup.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import {
  runCommand,
  hydrate,
  writeChanged,
  allErrors,
  requestOf,
  requestUuidIn,
} from "./runCommand";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../src/domain/componentTemplates";

const args = { payload: v.string(), programUuid: v.optional(v.string()) };

/**
 * Saves a component template as its next version in the caller's Flight
 * Program, and writes the `componentTemplate.save` row saveComponentTemplate
 * records. A replayed request id changes nothing.
 *
 * @param payload - JSON, as `saveComponentTemplate` reads it, with its
 *   request id.
 * @param programUuid - The caller's active Flight Program.
 * @returns The template's uuid.
 * @throws {ConvexError} As `runCommand`; any error saveComponentTemplate or
 *   the JSON parser throws, with its message ("Template changed. Reopen
 *   it.", …) or a zod refusal's issue text; "Record belongs to another
 *   Flight Program." for a new uuid another program uses.
 */
export const save = mutation({
  args,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => args.payload,
      request: (payload) => requestOf(requestUuidIn(payload), payload),
      load: ({ ctx, state }) => hydrate(ctx, state, ["componentTemplates"]),
      apply: ({ snapshot }, payload) =>
        saveComponentTemplate(snapshot, JSON.parse(payload)),
      expose: allErrors,
      persist: ({ ctx }, { docs }, next) =>
        writeChanged(ctx, "componentTemplates", docs.componentTemplates, [
          next,
        ]),
      audit: (log, { snapshot }) => log.replay(snapshot.audit),
      returns: (next) => next.uuid,
    }),
});

/**
 * Adds the chosen rows of a component template to an aircraft's component
 * setup list, and writes the `component.setupImported` row
 * applyComponentTemplate records for each, in row order. A row already added
 * is skipped; no component is installed. A replayed request id changes
 * nothing.
 *
 * @param payload - JSON: `templateUuid`, the template `version` previewed,
 *   `aircraftUuid`, the `rowIds` to add and the request id.
 * @param programUuid - The caller's active Flight Program.
 * @returns How many rows were added.
 * @throws {ConvexError} As `runCommand`; any error applyComponentTemplate or
 *   the JSON parser throws, with its message ("Template changed. Reopen the
 *   preview.", "Aircraft make and model must match the template.", …) or a
 *   zod refusal's issue text.
 */
export const apply = mutation({
  args,
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => args.payload,
      request: (payload) => requestOf(requestUuidIn(payload), payload),
      load: ({ ctx, state }) =>
        hydrate(ctx, state, [
          "componentTemplates",
          "componentSetups",
          "management",
        ]),
      apply: ({ snapshot }, payload) =>
        applyComponentTemplate(snapshot, JSON.parse(payload)),
      expose: allErrors,
      persist: ({ ctx }, { docs }, added) =>
        writeChanged(ctx, "componentSetups", docs.componentSetups, added),
      audit: (log, { snapshot }) => log.replay([...snapshot.audit].reverse()),
      returns: (added) => added.length,
    }),
});

import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { currentUser, audit } from "./access";
import {
  context,
  checkContext,
  managementDocs,
  checklistDocs,
  componentSetupDocs,
  partsRequestDocs,
  purchaseOrderDocs,
} from "./programContext";
import { programIds } from "../src/domain/programs";
import { transferProgram } from "../src/domain/programTransfers";
import { recordSchema } from "../src/domain/management";
import { partsRequestSchema } from "../src/domain/partsRequests";
import { poSchema } from "../src/domain/purchaseOrders";
import { checklistRecordSchema } from "../src/domain/checklists";
import type { Snapshot } from "../src/domain/model";
export const select = mutation({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const user = await currentUser(ctx),
      state = await context(ctx, user);
    if (
      programUuid
        ? !state.programs.some((p) => p.uuid === programUuid) ||
          (!user.isAdmin &&
            !programIds(state.user, state.groups).includes(programUuid))
        : !user.isAdmin
    )
      throw new Error("Flight Program access denied.");
    await ctx.db.patch(user._id, { activeProgramUuid: programUuid });
    await audit(
      ctx,
      user._id,
      "program.selected",
      programUuid || "unassigned",
      { programUuid: programUuid || undefined },
    );
  },
});
export const transfer = mutation({
  args: {
    programUuid: v.optional(v.string()),
    kind: v.union(
      v.literal("aircraft"),
      v.literal("component"),
      v.literal("location"),
    ),
    uuid: v.string(),
    destination: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const program = args.programUuid;
    const aircraftKind = args.kind === "aircraft";
    const documents = await managementDocs(ctx, program);
    const inspections = aircraftKind
      ? await ctx.db
          .query("inspections")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.uuid))
          .collect()
      : args.kind === "component"
        ? await ctx.db
            .query("inspections")
            .withIndex("component", (q) => q.eq("componentUuid", args.uuid))
            .collect()
        : [];
    const checklists = aircraftKind ? await checklistDocs(ctx, program) : [];
    const setups = aircraftKind ? await componentSetupDocs(ctx, program) : [];
    // Aircraft wait for their open requests; locations for reserved stock and
    // open order lines delivering there (transferProgram).
    const commitments = aircraftKind || args.kind === "location";
    const s: Snapshot = {
      ...state,
      management: documents.map((d) =>
        recordSchema.parse(JSON.parse(d.payload)),
      ),
      inspections,
      partsRequests: commitments
        ? (await partsRequestDocs(ctx, program)).map((d) =>
            partsRequestSchema.parse(JSON.parse(d.payload)),
          )
        : [],
      purchaseOrders: commitments
        ? (await purchaseOrderDocs(ctx, program)).map((d) =>
            poSchema.parse(JSON.parse(d.payload)),
          )
        : [],
      checklists: checklists.map((d) =>
        checklistRecordSchema.parse(JSON.parse(d.payload)),
      ),
      componentSetups: setups.map((d) => JSON.parse(d.payload)),
      audit: [],
    };
    const originals = new Map(
      state.aircraft.map((a) => [a.uuid, JSON.stringify(a)]),
    );
    const versions = new Map(inspections.map((i) => [i._id, i.version]));
    const entities = transferProgram(s, args);
    for (const a of state.aircraft)
      if (JSON.stringify(a) !== originals.get(a.uuid))
        await ctx.db.patch(a._id, {
          programUuid: a.programUuid,
          program: a.program,
          version: a.version,
        });
    for (const r of s.management ?? []) {
      const d = documents.find((d) => d.uuid === r.uuid)!;
      if (JSON.stringify(r) !== d.payload)
        await ctx.db.patch(d._id, {
          programUuid: r.programUuid,
          aircraftUuid:
            "aircraftUuid" in r ? r.aircraftUuid || undefined : undefined,
          payload: JSON.stringify(r),
        });
    }
    for (const i of inspections)
      if (i.version !== versions.get(i._id))
        await ctx.db.patch(i._id, {
          programUuid: i.programUuid,
          version: i.version,
        });
    for (const c of s.checklists ?? []) {
      const d = checklists.find((d) => d.uuid === c.uuid)!;
      if (c.programUuid !== d.programUuid)
        await ctx.db.patch(d._id, {
          programUuid: c.programUuid,
          payload: JSON.stringify(c),
        });
    }
    for (const c of s.componentSetups ?? []) {
      const d = setups.find((d) => d.uuid === c.uuid)!;
      if (c.programUuid !== d.programUuid)
        await ctx.db.patch(d._id, {
          programUuid: c.programUuid,
          payload: JSON.stringify(c),
        });
    }
    // ADR-0005: existing change-log rows are never edited. History follows each
    // record's current owner (visibleScope): the destination sees the moved
    // records' rows, and the source keeps only rows that also concern an
    // aircraft or record it still holds. Rows
    // the destination's own program and aircraft indexes would not reach are
    // listed in transferredAudit so its History feed includes them.
    // ponytail: one transaction; a very long record history may need batching.
    const mapped = new Set<string>();
    for (const uuid of entities)
      for (const row of await ctx.db
        .query("audit")
        .withIndex("entity", (q) => q.eq("entityUuid", uuid))
        .collect())
        if (
          !mapped.has(row._id) &&
          row.programUuid !== args.destination &&
          !(aircraftKind && row.aircraftUuid === args.uuid)
        ) {
          mapped.add(row._id);
          await ctx.db.insert("transferredAudit", {
            programUuid: args.destination,
            auditId: row._id,
            auditCreationTime: row._creationTime,
          });
        }
    const e = s.audit[0];
    await audit(ctx, s.user.id, e.action, e.entityUuid, {
      programUuid: e.programUuid,
      aircraftUuid: e.aircraftUuid,
      reason: e.reason,
      before: JSON.parse(e.before!),
      after: JSON.parse(e.after!),
    });
  },
});

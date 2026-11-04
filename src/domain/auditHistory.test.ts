/**
 * Responsibility: Pins History paging, filters, page-size bounds, the access
 *   probe and action labels.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/auditHistory.ts, ./model (types).
 */
import { expect, it } from "vitest";
import {
  auditActionLabel,
  canPageAuditFilter,
  clampAuditPageSize,
  pageAuditEntries,
} from "./auditHistory";
import type { AuditEntry } from "./model";
const entry = (at: number, entityUuid = "e", aircraftUuid?: string) =>
  ({
    uuid: `u${at}`,
    at,
    actorId: "a",
    action: "x",
    entityUuid,
    aircraftUuid,
  }) satisfies AuditEntry;
it("pages newest first through matching entries until done", () => {
  const log = [1, 5, 3, 4, 2].map((at) => entry(at, at % 2 ? "odd" : "even"));
  const first = pageAuditEntries(log, { cursor: null, numItems: 2 });
  expect(first.page.map((a) => a.at)).toEqual([5, 4]);
  expect(first.isDone).toBe(false);
  const second = pageAuditEntries(log, {
    cursor: first.continueCursor,
    numItems: 2,
  });
  expect(second.page.map((a) => a.at)).toEqual([3, 2]);
  const last = pageAuditEntries(log, {
    cursor: second.continueCursor,
    numItems: 2,
  });
  expect(last).toMatchObject({ isDone: true, page: [{ at: 1 }] });
  expect(
    pageAuditEntries(log, {
      cursor: null,
      numItems: 10,
      entityUuid: "odd",
    }).page.map((a) => a.at),
  ).toEqual([5, 3, 1]);
});
it("filters by aircraft and bounds the page size", () => {
  const log = [entry(1, "e", "A"), entry(2, "e", "B")];
  expect(
    pageAuditEntries(log, { cursor: null, numItems: 5, aircraftUuid: "A" })
      .page,
  ).toEqual([log[0]]);
  expect(clampAuditPageSize(0)).toBe(1);
  expect(clampAuditPageSize(1000)).toBe(100);
  expect(clampAuditPageSize(Number.NaN)).toBe(1);
});
it("rounds page sizes down and restarts at an unreadable cursor", () => {
  expect(clampAuditPageSize(2.9)).toBe(2);
  const log = [entry(1), entry(2), entry(3)];
  expect(
    pageAuditEntries(log, { cursor: "abc", numItems: 1 }).page.map((a) => a.at),
  ).toEqual([3]);
});
it("probes the filter with the row rule before paging", () => {
  const visible = new Set(["mine", "plane"]);
  const canSee = (a: AuditEntry) =>
    visible.has(a.entityUuid) || visible.has(a.aircraftUuid ?? "");
  expect(canPageAuditFilter(canSee, {})).toBe(true);
  expect(canPageAuditFilter(canSee, { aircraftUuid: "plane" })).toBe(true);
  expect(canPageAuditFilter(canSee, { aircraftUuid: "other" })).toBe(false);
  expect(canPageAuditFilter(canSee, { entityUuid: "mine" })).toBe(true);
  const byAircraft = (a: AuditEntry) => a.aircraftUuid === "plane";
  expect(canPageAuditFilter(byAircraft, { entityUuid: "plane" })).toBe(true);
  const order = entry(9, "order", "plane");
  expect(canPageAuditFilter(canSee, { entityUuid: "order" }, order)).toBe(true);
  expect(canPageAuditFilter(canSee, { entityUuid: "order" })).toBe(false);
  expect(canPageAuditFilter(canSee, { entityUuid: "other" }, order)).toBe(
    false,
  );
});
it("labels actions with dots as separators and underscores as spaces", () => {
  expect(auditActionLabel("flight.reviewed")).toBe("Flight · reviewed");
  expect(auditActionLabel("work_order.closed_out")).toBe(
    "Work order · closed out",
  );
});

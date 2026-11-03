import { expect, it } from "vitest";
import { clampAuditPageSize, pageAuditEntries } from "./auditHistory";
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

import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement, inspectionSchema } from "./management";
import { inspectionStatus, inspectionDueDate } from "./maintenance";
import { totalSeconds } from "./model";

function setup() {
  const state = demoSnapshot();
  const record = inspectionSchema.parse({
    uuid: "calendar-test",
    version: 0,
    aircraftUuid: state.aircraft[0].uuid,
    description: "Calendar test",
    materials: "",
    archived: false,
    intervalMonths: 12,
    lastDate: "2024-01-15",
  });
  return { state, record };
}
const save = (
  state: ReturnType<typeof demoSnapshot>,
  record: ReturnType<typeof inspectionSchema.parse>,
  now = Date.parse("2026-10-23T12:00:00Z"),
) =>
  applyManagement(
    state,
    {
      action: "inspection.save",
      requestUuid: crypto.randomUUID(),
      reason: "Verified inspection schedule",
      record,
    },
    now,
  );

describe("aircraft inspection calendar exemptions", () => {
  it("suppresses calendar alerts without losing the requirement, and restores the original deadline", () => {
    const { state, record } = setup();
    const normal = inspectionStatus(record, state.aircraft[0], "2026-10-23");
    expect(normal.status).toBe("overdue");
    record.calendarExempt = true;
    record.calendarExemptReason = "Phases 52–56; approved manual reference";
    save(state, record);
    let stored = state.inspections.find((i) => i.uuid === record.uuid)!;
    expect(stored.intervalMonths).toBe(12);
    expect(stored.lastDate).toBe("2024-01-15");
    expect(stored.dueDate).toBe("2025-01-31");
    expect(inspectionDueDate(stored)).toBeUndefined();
    expect(
      inspectionStatus(stored, state.aircraft[0], "2026-10-23"),
    ).toMatchObject({ daysRemaining: undefined, status: "scheduled" });
    expect(stored.calendarExemptChangedBy).toBe(state.user.id);
    save(state, inspectionSchema.parse({ ...stored, calendarExempt: false }));
    stored = state.inspections.find((i) => i.uuid === record.uuid)!;
    expect(inspectionDueDate(stored)).toBe("2025-01-31");
    expect(
      inspectionStatus(stored, state.aircraft[0], "2026-10-23").status,
    ).toBe("overdue");
  });
  it("keeps hours and cycles active", () => {
    const { state, record } = setup();
    record.calendarExempt = true;
    record.dueSeconds = totalSeconds(state.aircraft[0]) - 3600;
    record.dueCycles = state.aircraft[0].cycles + 5;
    expect(
      inspectionStatus(record, state.aircraft[0], "2026-10-23"),
    ).toMatchObject({
      hoursRemaining: -1,
      cyclesRemaining: 5,
      daysRemaining: undefined,
      status: "overdue",
    });
  });
  it("requires a reason, preserves exemptions from older clients and stamps the actual actor", () => {
    const { state, record } = setup();
    expect(() => save(state, { ...record, calendarExempt: true })).toThrow(
      "reason/reference",
    );
    save(state, {
      ...record,
      calendarExempt: true,
      calendarExemptReason: "Manual reference",
      calendarExemptChangedBy: "forged",
      calendarExemptChangedAt: 1,
    });
    const stored = state.inspections.find((i) => i.uuid === record.uuid)!;
    expect(stored.calendarExemptChangedBy).toBe(state.user.id);
    const legacy = inspectionSchema.parse(stored);
    delete legacy.calendarExempt;
    delete legacy.calendarExemptReason;
    delete legacy.calendarExemptChangedAt;
    delete legacy.calendarExemptChangedBy;
    save(state, legacy, Date.parse("2026-10-24T12:00:00Z"));
    const preserved = state.inspections.find((i) => i.uuid === record.uuid)!;
    expect(preserved.calendarExempt).toBe(true);
    expect(preserved.calendarExemptChangedAt).toBe(
      stored.calendarExemptChangedAt,
    );
    expect(state.audit[0].after).toContain('"calendarExempt":true');
  });
});

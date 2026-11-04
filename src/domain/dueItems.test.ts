/**
 * Responsibility: Pins what the due list holds, its order, the level each
 *   status maps to, and what it keeps when a status throws.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/dueItems.ts, model.ts, rejection.ts;
 *   tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import { DUE_FLEET_TODAY, dueFleet } from "../../tests/fixtures/dueFleet";
import { dueItems, type MaintenanceDue } from "./dueItems";
import { localDate } from "./model";
import { Rejection } from "./rejection";

const uuidOf = (item: MaintenanceDue) => {
  if (item.kind === "inspection") return item.inspection.uuid;
  if (item.kind === "componentRequirement") return item.requirement.uuid;
  return item.ad.uuid;
};
const byUuid = (items: MaintenanceDue[]) =>
  new Map(items.map((item) => [uuidOf(item), item]));

describe("dueItems", () => {
  it("lists inspections, then requirements, then ADs, in record order", () => {
    const { s, a } = dueFleet();
    expect(dueItems(s, a.uuid, DUE_FLEET_TODAY).map(uuidOf)).toStrictEqual([
      ...["i-late", "i-today", "i-zero", "i-cycles", "i-ok", "i-none"],
      ...["i-exempt", "i-missing", "i-gear"],
      ...["r-early", "r-now", "r-today", "r-tracked", "r-landing"],
      "r-gear-tso",
      ...["ad-na", "ad-superseded", "ad-review", "ad-na-review"],
      ...["ad-removed", "ad-overdue", "ad-soon", "ad-complied", "ad-pcw"],
      ...["ad-unset", "ad-counter"],
    ]);
  });

  it("lists the whole program, with inventory and ADs on absent aircraft, without an aircraft", () => {
    const { s, b } = dueFleet();
    const items = byUuid(dueItems(s, undefined, DUE_FLEET_TODAY));
    expect([...items.keys()]).toEqual(
      expect.arrayContaining(["i-other", "i-collective", "r-b", "ad-b"]),
    );
    expect(items.get("r-removed")).toMatchObject({ aircraft: undefined });
    expect(items.get("ad-gone")).toMatchObject({
      aircraftUuid: "gone",
      aircraft: undefined,
    });
    expect(items.get("ad-b")).toMatchObject({ aircraftUuid: b.uuid });
    expect(items.has("i-archived")).toBe(false);
  });

  it("maps every status to one level", () => {
    const { s, a } = dueFleet();
    const levels = [...byUuid(dueItems(s, a.uuid, DUE_FLEET_TODAY))].map(
      ([uuid, item]) => `${uuid} ${statusOf(item)} ${item.level}`,
    );
    expect(levels).toStrictEqual(LEVELS);
  });

  it("keeps what a status function threw, at level unknown", () => {
    const { s, c } = dueFleet();
    const items = byUuid(dueItems(s, undefined, DUE_FLEET_TODAY));
    const thrown = (uuid: string) => {
      const item = items.get(uuid);
      return item?.kind === "ad" ? undefined : item;
    };
    expect(thrown("r-early")?.level).toBe("unknown");
    expect(thrown("r-early")?.due).toBeUndefined();
    expect(thrown("r-early")?.error).toStrictEqual(
      new Rejection(
        "Aircraft readings or date precede the installation baseline.",
      ),
    );
    expect(thrown("i-missing")?.error).toBeInstanceOf(Rejection);
    expect(thrown("i-collective")?.aircraft).toBe(c);
    expect(thrown("i-collective")?.due).toBeUndefined();
  });

  it("measures a component inspection's counters on the date given", () => {
    const { s, a } = dueFleet();
    const gear = s.management!.find((r) => r.uuid === "gear")!;
    Object.assign(gear, { installedDate: "2099-01-01" });
    const gearCheck = (today?: string) =>
      byUuid(dueItems(s, a.uuid, today)).get("i-gear");
    expect(gearCheck("2099-06-01")).toMatchObject({ level: "ok" });
    expect(gearCheck()).toMatchObject({ level: "unknown" });
  });

  it("judges an AD's own status on the clock's date", () => {
    // Characterizes current behaviour: adStatus takes no date, so an action
    // overdue by the clock leaves the AD overdue on an earlier `today`.
    const { s, a } = dueFleet();
    const ad = s.airworthiness!.find((r) => r.uuid === "ad-overdue")!;
    ad.tasks[0].dueDate = daysAgo(1);
    const today = daysAgo(10);
    expect(byUuid(dueItems(s, a.uuid, today)).get("ad-overdue")).toMatchObject({
      status: "Overdue",
      tasks: [{ status: "Due soon", level: "due-soon" }],
    });
  });
});

function daysAgo(days: number) {
  const DAY_MS = 86_400_000;
  return localDate(Date.now() - days * DAY_MS);
}

function statusOf(item: MaintenanceDue) {
  if (item.kind === "ad")
    return `${item.status}/${item.tasks.map((t) => t.status).join(",")}`;
  return item.due?.status ?? "threw";
}

const LEVELS = [
  "i-late overdue overdue",
  "i-today due-soon due-soon",
  "i-zero overdue overdue",
  "i-cycles due-soon due-soon",
  "i-ok scheduled ok",
  "i-none unknown unknown",
  "i-exempt scheduled ok",
  "i-missing threw unknown",
  "i-gear scheduled ok",
  "r-early threw unknown",
  "r-now Due now overdue",
  "r-today Due soon due-soon",
  "r-tracked Tracked ok",
  "r-landing Set landing baseline unknown",
  "r-gear-tso Set time baseline unknown",
  "ad-na Not applicable/ ok",
  "ad-superseded Superseded/ ok",
  "ad-review Needs review/Scheduled unknown",
  "ad-na-review Needs review/Overdue unknown",
  "ad-removed Removed component/Scheduled unknown",
  "ad-overdue Overdue/Overdue overdue",
  "ad-soon Due soon/Due soon due-soon",
  "ad-complied Complied/Complied ok",
  "ad-pcw Previously Complied With (PCW)/ ok",
  "ad-unset Due not set/Due not set unknown",
  "ad-counter Counter unavailable/Counter unavailable unknown",
];

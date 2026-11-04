/**
 * Responsibility: Pins which of an AD's actions a work order can take on.
 * Layer: Test. Vitest suite on the demo fleet; never shipped in the build.
 * Dependencies: ./adWorkOrders, ./airworthiness (blankAD, blankADTask),
 *   ./model (types), src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { adWorkOrderTasks } from "./adWorkOrders";
import { blankAD, blankADTask, type AD } from "./airworthiness";
import type { Snapshot } from "./model";

const DAY_MS = 86_400_000;
// "Due soon" is within 30 days of today.
const soon = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
const base = demoSnapshot();
const aircraftUuid = base.aircraft[0].uuid;
const engine = {
  kind: "component",
  uuid: "engine",
  aircraftUuid,
  componentType: "Engine",
  manufacturer: "Lycoming",
  model: "IO-540",
  serial: "L-1",
  installed: true,
};
const state = { ...base, management: [engine] } as Snapshot;
const task = (uuid: string, dueDate: string) => ({
  ...blankADTask(),
  uuid,
  dueDate,
});
const ad = (extra: Partial<AD> = {}): AD => ({
  ...blankAD(aircraftUuid),
  applicability: "Applicable",
  reviewRequired: false,
  tasks: [
    task("overdue", "2020-01-01"),
    task("unset", ""),
    task("soon", soon),
    task("scheduled", "2099-01-01"),
  ],
  ...extra,
});
const uuids = (r: AD, taskUuid?: string, s = state) =>
  adWorkOrderTasks(s, r, taskUuid).map((t) => t.uuid);

describe("adWorkOrderTasks", () => {
  it("offers the Overdue, Due soon and Scheduled actions in the AD's order", () => {
    expect(uuids(ad())).toEqual(["overdue", "soon", "scheduled"]);
    expect(
      uuids(ad({ applicability: "Previously Complied With (PCW)" })),
    ).toEqual(["overdue", "soon", "scheduled"]);
  });

  it("offers one action only while it is open", () => {
    expect(uuids(ad(), "soon")).toEqual(["soon"]);
    expect(uuids(ad(), "unset")).toEqual([]);
  });

  it("offers nothing for an AD under review, not tracked or on a removed component", () => {
    expect(uuids(ad({ reviewRequired: true }))).toEqual([]);
    for (const applicability of [
      "Needs review",
      "Not applicable",
      "Superseded",
    ] as const)
      expect(uuids(ad({ applicability }))).toEqual([]);
    const removed = { ...state, management: [{ ...engine, installed: false }] };
    expect(
      uuids(ad({ componentUuid: "engine" }), undefined, removed as Snapshot),
    ).toEqual([]);
    expect(uuids(ad({ componentUuid: "engine" }))).toEqual([
      "overdue",
      "soon",
      "scheduled",
    ]);
  });
});

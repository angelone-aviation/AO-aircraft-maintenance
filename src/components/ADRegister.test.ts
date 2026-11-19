/**
 * Responsibility: Pins how the AD register groups and counts an aircraft's
 *   ADs, and which row actions it offers.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ADRegister.tsx, src/domain/airworthiness.ts,
 *   src/domain/adWorkOrders.ts, src/data/demo.ts (demoSnapshot),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { adWorkOrderTasks } from "../domain/adWorkOrders";
import {
  adStatus,
  blankAD,
  blankADTask,
  type AD,
} from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import { ADRegister } from "./ADRegister";

// The real button needs the workspace; this stub marks where it would show,
// by the domain rule the real one renders by.
vi.mock("./ADWorkOrderButton", () => ({
  ADWorkOrderButton: ({ state, record }: { state: Snapshot; record: AD }) =>
    adWorkOrderTasks(state, record).length
      ? createElement("i", { "data-work-order": record.uuid })
      : null,
}));

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
const ad = (uuid: string, extra: Partial<AD> = {}): AD => ({
  ...blankAD(aircraftUuid),
  uuid,
  ...extra,
});
const decided = (uuid: string, dueDate: string, extra: Partial<AD> = {}) =>
  ad(uuid, {
    applicability: "Applicable",
    reviewRequired: false,
    tasks: [{ ...blankADTask(), uuid: `${uuid}-task`, dueDate }],
    ...extra,
  });
const DAY_MS = 86_400_000;
// "Due soon" is within 30 days of today.
const soon = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
// Complied with on 2026-02-01, yet its first due date was never cleared.
const staleTask = {
  ...blankADTask(),
  uuid: "stale-task",
  dueDate: "2026-01-01",
  intervalHours: 100,
};
const stale = ad("stale", {
  applicability: "Applicable",
  reviewRequired: false,
  componentUuid: "engine",
  source: { ...blankAD(aircraftUuid).source, section: "Engine" },
  tasks: [staleTask],
  history: [
    { uuid: "h1", taskUuid: "stale-task", date: "2026-02-01" },
  ] as AD["history"],
});
const render = (records: AD[], editable = true) =>
  renderToStaticMarkup(
    createElement(ADRegister, {
      records,
      state,
      aircraftUuid,
      editable,
      onEdit: () => {},
      onView: () => {},
      onClearInitialLimit: () => {},
    }),
  );

describe("ADRegister", () => {
  it("groups ADs under the airframe and each component, in first-named order", () => {
    const html = render([stale, ad("a"), ad("b")]);
    const titles = [...html.matchAll(/<strong>([^<]+)<\/strong><span>/g)];
    expect(titles.map((m) => m[1])).toEqual([
      "Engine: Lycoming / IO-540",
      "Airframe: Cessna / 206 Stationair",
    ]);
    expect(html).toContain("2 ADs");
    expect(html).toContain("1 AD<");
  });

  it("counts the ADs needing review and the stale one-time limits", () => {
    const html = render([ad("a"), ad("b"), stale]);
    expect(html).toContain("Needs review: 2");
    expect(html).toContain("Needs review: 0");
    expect(html).toContain("One-time limits to check: 1");
  });

  it("offers a work order whenever one of a tracked AD's actions is open, whatever the AD's status", () => {
    // A second action whose own status outranks the open one's in adStatus.
    const twoActions = (
      uuid: string,
      dueDate: string,
      other: Partial<AD["tasks"][number]>,
    ) => {
      const r = decided(uuid, dueDate, { componentUuid: "engine" });
      r.tasks = [
        { ...blankADTask(), uuid: `${uuid}-other`, ...other },
        ...r.tasks,
      ];
      return r;
    };
    const unset = twoActions("unset", "2099-01-01", {});
    const counter = twoActions("counter", soon, { dueHours: 100 });
    expect([unset, counter].map((r) => adStatus(state, r))).toEqual([
      "Due not set",
      "Counter unavailable",
    ]);
    const html = render([
      decided("overdue", "2020-01-01"),
      decided("soon", soon),
      decided("scheduled", "2099-01-01"),
      unset,
      counter,
      decided("excluded", "2020-01-01", { applicability: "Not applicable" }),
      ad("review"),
    ]);
    const offered = [...html.matchAll(/data-work-order="([^"]+)"/g)];
    expect(offered.map((m) => m[1]).sort()).toEqual(
      ["counter", "overdue", "scheduled", "soon", "unset"].sort(),
    );
  });

  it("disables Edit and Clear initial limit unless editable", () => {
    const disabled =
      /<button class="button small" disabled="" aria-label="(Review|Clear)/g;
    expect(render([stale]).match(disabled)).toBeNull();
    expect(render([stale], false).match(disabled)).toHaveLength(2);
  });
});

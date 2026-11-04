/**
 * Responsibility: Pins how the aircraft form keeps total time across meters
 *   and which readings it saves, what an aircraft row lists, who may add
 *   aircraft and edit programs, and what a program transfer offers.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Fleet.tsx, src/data/demo.ts,
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Aircraft, Snapshot } from "../domain/model";
import { AircraftForm, AircraftPage, ProgramsPage } from "./Fleet";

// The root's states are seeded in the order it declares them, and their
// updates recorded; later states are React's own.
const hooks = vi.hoisted(() => ({
  seeds: [] as unknown[],
  updates: [] as unknown[][],
  changes: new Map<string, (e: unknown) => void>(),
  submit: undefined as ((d: FormData) => Promise<void>) | undefined,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    const slot = hooks.updates.length;
    if (!hooks.seeds.length) return react.useState(init);
    hooks.updates.push([]);
    const update = (next: unknown) => hooks.updates[slot].push(next);
    return [hooks.seeds.shift(), update];
  };
  return { ...react, useState };
});
// Tests compile JSX for development, so controls are seen in jsxDEV.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  type Props = { name?: string; onChange?: (e: unknown) => void };
  const jsxDEV = (type: unknown, props: Props, ...rest: unknown[]) => {
    if (type === "select" || type === "input")
      if (props.onChange)
        hooks.changes.set(`${type}:${props.name ?? ""}`, props.onChange);
    return (runtime.jsxDEV as (...args: unknown[]) => unknown)(
      type,
      props,
      ...rest,
    );
  };
  return { ...runtime, jsxDEV };
});
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  Modal: (props: { children: ReactNode }) =>
    createElement("section", null, props.children),
  AsyncForm: (props: {
    onSubmit: (d: FormData) => Promise<void>;
    children: ReactNode;
  }) => {
    hooks.submit = props.onSubmit;
    return createElement("form", null, props.children);
  },
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("./Costs", () => ({ AircraftCostSummary: () => null }));
vi.mock("./AircraftStatus", () => ({ AircraftStatusReasons: () => null }));
vi.mock("./AircraftPhoto", () => ({ AircraftPhoto: () => null }));
vi.mock("./AddressFields", () => ({ AddressFields: () => null }));
vi.mock("./DrsComboBox", () => ({ DrsComboBox: () => null }));
vi.mock("./Components", () => ({ ComponentForm: () => null }));
vi.mock("./Manuals", () => ({ AircraftManuals: () => null }));
vi.mock("./EngineTrends", () => ({ AircraftEngineTrends: () => null }));
vi.mock("./ManagementShared", () => ({ History: () => null }));
const fleet = vi.fn(async (_command: unknown) => {});
const workspace = {
  snapshot: demoSnapshot() as Snapshot,
  online: true,
  connected: true,
  backend: { fleet },
};
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace, { setState: () => {} }),
}));

const HOUR = 3600;
const base = demoSnapshot();
const R66 = {
  ...base.aircraft[0],
  uuid: "r66",
  registration: "N66R",
  model: " r66 ",
  helicopter: true,
  turbine: true,
  meter: "hobbs",
  currentCyclicHobbs: 12 * HOUR,
  flightTimeLog: true,
  currentFlightTimeLog: undefined,
} as Aircraft;
const SECOND = { uuid: "p2", version: 1, name: "Second", address: "" };
const READINGS = ["100.0", "90.0", "0.0"];

beforeEach(() => {
  workspace.snapshot = {
    ...base,
    aircraft: [...base.aircraft, R66],
    programs: [...base.programs!, SECOND],
  } as Snapshot;
  workspace.online = true;
  Object.assign(hooks, { seeds: [], updates: [], submit: undefined });
  hooks.changes.clear();
  fleet.mockClear();
});

// Seeds the form's states: meter, the flight time log option and reading,
// turbine, helicopter, collective, Hobbs, tach and adjustment.
function form(meter: string, initial?: Aircraft, options = [false, false]) {
  const [flightTimeLog, helicopter] = options;
  hooks.seeds = [
    meter,
    flightTimeLog,
    "7.5",
    true,
    helicopter,
    "12.0",
    ...READINGS,
  ];
  return renderToStaticMarkup(
    createElement(AircraftForm, { initial, onDone: () => {} }),
  );
}

describe("AircraftForm", () => {
  it("keeps total time when the meter changes, through the adjustment", () => {
    form("hobbs");
    hooks.changes.get("select:")!({ target: { value: "tach" } });
    expect(hooks.updates[8]).toEqual(["10"]);
    expect(hooks.updates[0]).toEqual(["tach"]);
  });

  it("moves a collective meter to the Hobbs when the helicopter option goes", () => {
    form("cyclic", R66, [false, true]);
    hooks.changes.get("input:helicopter")!({ target: { checked: false } });
    expect(hooks.updates[0]).toEqual(["hobbs"]);
    expect(hooks.updates[4]).toEqual([false]);
  });

  it("keeps the stored option readings while those options are off", async () => {
    form("hobbs", R66);
    const d = new FormData();
    d.set("landings", "5");
    await hooks.submit!(d);
    expect(fleet.mock.calls[0][0]).toMatchObject({
      aircraft: { currentCyclicHobbs: 12 * HOUR, currentHobbs: 100 * HOUR },
    });
  });

  it("labels an R66's cycles as engine starts", () => {
    expect(form("cyclic", R66, [false, true])).toContain("Engine start cycles");
  });
});

describe("AircraftPage", () => {
  const page = () => {
    hooks.seeds = [null, null, ""];
    return renderToStaticMarkup(createElement(AircraftPage));
  };

  it("lets a program administrator add aircraft while connected", () => {
    expect(page()).toMatch(/<button class="button primary">.*Add aircraft/);
    workspace.online = false;
    expect(page()).toMatch(/<button class="button primary" disabled="">/);
    workspace.snapshot.user = base.members.find((m) => m.id === "demo-pilot")!;
    expect(page()).not.toContain("Add aircraft");
  });

  it("lists only the meters an aircraft has", () => {
    const html = page();
    expect(html).toContain("Engine starts / landings");
    expect(html).toContain("Not recorded");
    expect(html.match(/Collective hourmeter/g)).toHaveLength(1);
  });
});

describe("ProgramsPage", () => {
  const page = () => {
    hooks.seeds = [null];
    return renderToStaticMarkup(createElement(ProgramsPage));
  };
  const edits = (html: string) => html.match(/Edit Flight Program/g)?.length;

  it("shows a program administrator only the active program to edit", () => {
    expect(edits(page())).toBe(2);
    const programAdmin = {
      ...base.groups[0],
      id: "admins",
      programAdmin: true,
    };
    workspace.snapshot.groups = [programAdmin];
    const user = { ...workspace.snapshot.user, isAdmin: false };
    workspace.snapshot.user = { ...user, groupIds: ["admins"] };
    const html = page();
    expect(html).not.toContain("Second");
    expect(edits(html)).toBe(1);
  });

  it("offers stored components for transfer", () => {
    workspace.snapshot.management = [
      { kind: "component", uuid: "c1", componentType: "Engine", serial: "E1" },
    ] as never;
    hooks.seeds = [null, "component", 0];
    const html = renderToStaticMarkup(createElement(ProgramsPage));
    expect(html).toContain('<option value="c1">Engine · E1</option>');
  });
});

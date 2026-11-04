/**
 * Responsibility: Pins what the AD screen's docs promise: which ADs alert,
 *   who may change or correct them, the applicability review rule, import
 *   targets, compliance prefill and corrections, due lines, FAA monitoring
 *   timing and where errors show.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Airworthiness.tsx, src/domain/airworthiness.ts,
 *   src/data/demo.ts, react-dom/server.
 */
// @vitest-environment node
import { createElement as h, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask, type AD } from "../domain/airworthiness";
import type { Snapshot } from "../domain/model";
import { ADAlerts, Airworthiness } from "./Airworthiness";

type Props = Record<string, unknown> & { children?: ReactNode };
type Handler = (...args: unknown[]) => unknown;

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR_MS = 3_600_000;

const ui = vi.hoisted(() => ({
  workspace: {} as Record<string, unknown>,
  states: [] as unknown[],
  slot: 0,
  handlers: new Map<string, Handler>(),
}));

vi.mock("../data/store", () => ({
  useWorkspace: (select?: (state: unknown) => unknown) =>
    select ? select(ui.workspace) : ui.workspace,
}));
vi.mock("./FaaSearchImport", () => ({ FaaSearchImport: () => null }));
vi.mock("./FaaKeySettings", () => ({ FaaKeySettings: () => null }));
vi.mock("./ADRegister", () => ({ ADRegister: () => null }));
vi.mock("./ADWorkOrderButton", () => ({ ADWorkOrderButton: () => null }));
vi.mock("./ADTrackingFields", () => ({ ADTrackingFields: () => null }));
vi.mock("./RequiredParts", () => ({ PartsAvailability: () => null }));
vi.mock("./PartsRequests", () => ({ RequestPartsButton: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: Props) => h("a", null, children),
}));
// Server rendering keeps no state, so each useState slot is kept here and a
// setter takes effect on the next render.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.slot++;
      if (!(slot in ui.states)) ui.states[slot] = initial;
      const set = (next: unknown) =>
        (ui.states[slot] =
          typeof next === "function" ? next(ui.states[slot]) : next);
      return [ui.states[slot], set];
    },
  };
});
// Vitest compiles JSX for development, through jsxDEV. Handlers are kept by
// element and label, e.g. "button Correct entry" or "field Applicability".
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, ...rest) => {
    keepHandler(type, props as Props);
    return runtime.jsxDEV(type, props, ...rest);
  };
  return { ...runtime, jsxDEV };

  // Buttons by their text, a Field's control by the field's label.
  function keepHandler(type: unknown, props: Props) {
    const control = isValidElement(props.children)
      ? (props.children.props as Props)
      : {};
    if (typeof props.label === "string" && control.onChange)
      ui.handlers.set(`field ${props.label}`, control.onChange as Handler);
    const handler = props.onClick ?? props.onSubmit;
    if (typeof type !== "string" || typeof handler !== "function") return;
    const label = props["aria-label"] ?? textOf(props.children).trim();
    ui.handlers.set(`${type} ${label}`.trim(), handler as Handler);
  }
  function textOf(node: ReactNode): string {
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement(node)) return textOf((node.props as Props).children);
    return typeof node === "string" ? node : "";
  }
});

const BASE = demoSnapshot();
const [N206, N208] = BASE.aircraft;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  ui.states = [];
  ui.handlers.clear();
  setWorkspace(withADs([applicable()]));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ADAlerts", () => {
  it("alerts on unsettled ADs, for one aircraft or all", () => {
    const scheduled = {
      ...applicable("2020-02-02"),
      history: [],
      tasks: [{ ...blankADTask(), dueDate: "2027-06-01" }],
    };
    const other = { ...applicable("2021-03-03"), aircraftUuid: N208.uuid };
    const notApplicable = {
      ...applicable("2022-04-04"),
      applicability: "Not applicable" as const,
    };
    setWorkspace(withADs([applicable(), scheduled, other, notApplicable]));
    const all = render(ADAlerts, {});
    expect(all).toContain("AD 2019-01-01");
    expect(all).toContain("AD 2021-03-03");
    expect(all).not.toContain("AD 2020-02-02");
    expect(all).not.toContain("AD 2022-04-04");
    expect(render(ADAlerts, { aircraftUuid: N206.uuid })).not.toContain(
      "AD 2021-03-03",
    );
  });

  it("lists ADs needing review or a due limit, not complied or closed ones (Characterizes current behaviour)", () => {
    const [task] = applicable().tasks;
    const ad = (number: string, patch: Partial<AD>) => ({
      ...applicable(number),
      ...patch,
    });
    setWorkspace(
      withADs([
        ad("2023-01-01", { reviewRequired: true }),
        ad("2023-02-02", { tasks: [], history: [] }),
        ad("2023-03-03", { applicability: "Superseded" }),
        ad("2023-04-04", { tasks: [{ ...task, recurrence: "One-time" }] }),
      ]),
    );
    const html = render(ADAlerts, {});
    expect(html).toContain("<strong>Needs review</strong>");
    expect(html).toContain("<strong>Due not set</strong>");
    expect(html).not.toContain("AD 2023-03-03");
    expect(html).not.toContain("AD 2023-04-04");
  });

  it("gives pilot view no links", () => {
    setWorkspace(asPilot(withADs([applicable()])));
    const html = render(ADAlerts, {});
    expect(html).toContain("AD 2019-01-01");
    expect(html).not.toContain("<a>");
  });
});

describe("who may change ADs", () => {
  it("needs maintenance and a connection, except in the demo", () => {
    expect(render(Airworthiness)).toMatch(/<button[^>]*primary">.*Add AD/);
    setWorkspace(withADs([applicable()]), { online: false });
    expect(render(Airworthiness)).toMatch(/disabled="">.*Add AD/);
    setWorkspace(withADs([applicable()]), { online: false, demo: true });
    expect(render(Airworthiness)).not.toMatch(/disabled="">.*Add AD/);
    setWorkspace(asPilot(withADs([applicable()])));
    expect(render(Airworthiness)).toMatch(/disabled="">.*Add AD/);
  });

  it("lets only administrators correct compliance, and a correction keeps the original", () => {
    setWorkspace(asMechanic(withADs([applicable()])));
    openDetails();
    const html = render(Airworthiness);
    expect(html).not.toContain("Correct entry");
    expect(html).toContain("A Flight Program administrator can correct");
    setWorkspace(withADs([applicable()]));
    ui.states = [];
    openDetails();
    handler("button Correct entry of 2026-01-03")();
    const compliance = render(Airworthiness);
    expect(compliance).toContain("Correct AD compliance record");
    expect(compliance).toContain("The original entry stays");
    expect(draftState()).toMatchObject({ corrects: "h1" });
  });
});

describe("the AD form", () => {
  it("settles review on a settling applicability and reopens it on Needs review", () => {
    handler("button Add AD")();
    const choose = (applicability: string) => {
      render(Airworthiness);
      handler("field Applicability")({ target: { value: applicability } });
      return (draft() as AD).reviewRequired;
    };
    expect(choose("Not applicable")).toBe(false);
    expect(choose("Applicable")).toBe(false);
    expect(choose("Needs review")).toBe(true);
    expect(choose("Applicable")).toBe(true);
  });

  it("shows a failed save on the screen and in the open form", async () => {
    setWorkspace(withADs([applicable()]), {
      backend: { saveAD: vi.fn(async () => Promise.reject(new Error("No"))) },
    });
    handler("button Add AD")();
    render(Airworthiness);
    handler("form")({ preventDefault() {} });
    await vi.waitFor(() =>
      expect(
        render(Airworthiness).match(/role="alert"[^>]*>No</g),
      ).toHaveLength(2),
    );
  });
});

describe("compliance", () => {
  it("prefills today, the signed-in mechanic and the task's work order", () => {
    openDetails();
    handler("button Record compliance")();
    expect(draftState()).toMatchObject({
      entry: {
        date: "2026-11-04",
        mechanic: BASE.user.name,
        workOrderUuid: "wo1",
      },
    });
  });

  it("lists only the due limits a task has, landings included", () => {
    const ad = applicable();
    ad.tasks = [
      { ...blankADTask(), dueHours: 100, dueLandings: 5 },
      { ...blankADTask(), intervalCycles: 50 },
    ];
    setWorkspace(withADs([ad]));
    openDetails();
    const html = render(Airworthiness);
    expect(html).toContain("Due: 100 hours / 5 landings");
    expect(html).toContain("Due: not set cycles");
  });
});

describe("imports", () => {
  it("imports Airframe ADs onto the aircraft and the others onto each chosen component", async () => {
    const saveAD = vi.fn(async () => {});
    setWorkspace(withADs([]), { backend: { saveAD } });
    const engine = { ...blankAD(N206.uuid, "Engine").source, make: "L" };
    const prop = { ...blankAD(N206.uuid, "Propeller").source, make: "H" };
    const airframe = blankAD(N206.uuid).source;
    ui.states[6] = { entries: [airframe, engine, prop], warnings: [] };
    ui.states[7] = {
      [`Engine / L / `]: ["c1", "c2"],
      [`Propeller / H / `]: ["__skip__"],
    };
    render(Airworthiness);
    handler("button Confirm import")();
    await vi.waitFor(() => expect(saveAD).toHaveBeenCalled());
    expect(saveAD.mock.calls[0]).toEqual([
      expect.objectContaining({
        entries: [
          { source: airframe, componentUuid: "" },
          { source: engine, componentUuid: "c1" },
          { source: engine, componentUuid: "c2" },
        ],
      }),
    ]);
  });
});

describe("FAA monitoring", () => {
  it("calls results stale after two days and blocks a new check for five minutes", () => {
    const monitor = (lastSuccess: number, lastAttempt: number) => ({
      aircraftUuid: N206.uuid,
      terms: [],
      enabled: true,
      candidates: [],
      lastSuccess,
      lastAttempt,
      runId: "run",
      error: "",
      checkedTerms: [],
    });
    const html = (lastSuccess: number, lastAttempt: number) => {
      setWorkspace({
        ...withADs([]),
        faaMonitors: [monitor(lastSuccess, lastAttempt)],
      } as Snapshot);
      return render(Airworthiness);
    };
    expect(html(NOW - 47 * HOUR_MS, NOW)).not.toContain("Results are stale");
    expect(html(NOW - 49 * HOUR_MS, NOW)).toContain("Results are stale");
    expect(html(NOW, NOW - 4 * 60_000)).toMatch(/disabled="">Check FAA now/);
    expect(html(NOW, NOW - 6 * 60_000)).not.toMatch(
      /disabled="">Check FAA now/,
    );
  });
});

function render(screen: (props: never) => ReactNode, props = {}) {
  ui.slot = 0;
  ui.handlers.clear();
  return renderToStaticMarkup(h(screen as () => ReactNode, props));
}

// The first kept handler whose element and label start with these words.
function handler(start: string) {
  if (!ui.handlers.size) render(Airworthiness);
  const found = [...ui.handlers].find(([key]) => key.startsWith(start));
  if (!found) throw new Error(`No handler for ${start}`);
  return found[1];
}

function openDetails() {
  ui.states[4] = "ad1";
  render(Airworthiness);
}

// Slots 5 and 9 hold the AD and the compliance drafts (see useADState).
const draft = () => ui.states[5];
const draftState = () => ui.states[9];

function setWorkspace(snapshot: Snapshot, over: Record<string, unknown> = {}) {
  ui.workspace = {
    snapshot,
    online: true,
    connected: true,
    demo: false,
    backend: { saveAD: vi.fn(async () => {}), faaCommand: vi.fn() },
    ...over,
  };
}

function withADs(airworthiness: AD[]): Snapshot {
  const workOrders = [
    { uuid: "wo1", aircraftUuid: N206.uuid, status: "open", tasks: [] },
  ];
  return { ...BASE, airworthiness, workOrders } as unknown as Snapshot;
}

function asPilot(s: Snapshot): Snapshot {
  return {
    ...s,
    user: { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] },
  };
}

// Maintenance in the program, without administration.
function asMechanic(s: Snapshot): Snapshot {
  const group = {
    ...s.groups[0],
    id: "mx",
    permissions: ["read", "maintenance"],
  };
  return {
    ...s,
    groups: [...s.groups, group],
    user: { ...s.user, isAdmin: false, groupIds: ["mx"] },
  } as Snapshot;
}

// An applicable, reviewed AD whose one action is overdue, with a corrected
// compliance entry.
function applicable(number = "2019-01-01"): AD {
  const ad = blankAD(N206.uuid);
  const task = {
    ...blankADTask(),
    uuid: "t1",
    dueDate: "2026-01-01",
    workOrderUuid: "wo1",
  };
  const entry = {
    uuid: "h1",
    taskUuid: "t1",
    date: "2026-01-02",
    hours: 1,
    cycles: null,
    method: "Inspect",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Pat",
    certificate: "1",
    evidence: "",
    recordedAt: 1,
    recordedBy: "x",
  };
  return {
    ...ad,
    uuid: number === "2019-01-01" ? "ad1" : number,
    version: 1,
    source: { ...ad.source, number },
    applicability: "Applicable",
    reviewRequired: false,
    tasks: [task],
    history: [
      entry,
      { ...entry, uuid: "h2", corrects: "h1", date: "2026-01-03" },
    ],
  };
}

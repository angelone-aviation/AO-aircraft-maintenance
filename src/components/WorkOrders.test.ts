/**
 * Responsibility: Pins the work orders screen and the Add to work order
 *   button: listing and counts, saving and closing an order, staged task
 *   removal, requested work, and which orders can take an item.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrders.tsx, react-dom/server,
 *   src/domain/workOrders.ts, src/data/demo.ts (seed), tests/fixtures.
 *
 * Server rendering keeps no state, so the mocks keep the state of the screen,
 * the work order form and the button by component name between renders, and
 * capture click and change handlers by text or label and forms by label.
 * Child panels with their own suites render nothing here.
 */
// @vitest-environment node
import {
  createElement as h,
  type FunctionComponent,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { localDate, type Snapshot } from "../domain/model";
import {
  newWorkTask,
  saveWorkOrder,
  type WorkOrder,
} from "../domain/workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { AddToWorkOrder, WorkOrders } from "./WorkOrders";

type Props = Record<string, unknown>;
type Handler = (event?: unknown) => unknown;
const ui = vi.hoisted(() => {
  const tracked = new Set(["WorkOrders", "WorkOrderForm", "AddToWorkOrder"]);
  const frames: { id: string; next: number }[] = [];
  const wrappers = new Map<unknown, unknown>();
  // Runs a tracked component inside a frame, so its useState calls are kept.
  const track = <P extends object>(type: FunctionComponent<P>) => {
    if (!wrappers.has(type))
      wrappers.set(type, (props: P) => {
        frames.push({ id: type.name, next: 0 });
        try {
          return type(props);
        } finally {
          frames.pop();
        }
      });
    return wrappers.get(type) as FunctionComponent<P>;
  };
  return {
    tracked,
    frames,
    track,
    states: new Map<string, unknown[]>(),
    clicks: new Map<string, Handler[]>(),
    forms: new Map<string, (data: FormData) => Promise<void>>(),
    workspace: {} as Props,
    confirm: vi.fn(),
    none: (names: string[]) =>
      Object.fromEntries(names.map((name) => [name, () => null])),
  };
});
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const frame = ui.frames.at(-1);
      if (!frame) return react.useState(initial);
      const slots = ui.states.get(frame.id) ?? [];
      ui.states.set(frame.id, slots);
      const slot = frame.next++;
      if (!(slot in slots)) slots[slot] = initial;
      const set = (update: unknown) => {
        slots[slot] =
          typeof update === "function" ? update(slots[slot]) : update;
      };
      return [slots[slot], set];
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    return "";
  };
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = [args[0], args[1] as Props];
      const handler = props.onClick as Handler | undefined;
      const name = String(props["aria-label"] ?? textOf(props.children).trim());
      if (type === "button" && handler)
        ui.clicks.set(name, [...(ui.clicks.get(name) ?? []), handler]);
      if (typeof type === "function" && ui.tracked.has(type.name))
        args[0] = ui.track(type as FunctionComponent);
      return runtime.jsxDEV(...args);
    },
  };
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props.onSubmit);
      return actual.AsyncForm(props);
    },
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      const control = (props.children as { props: Props }).props;
      if (control.onChange)
        ui.clicks.set(props.label, [control.onChange as Handler]);
      return actual.Field(props);
    },
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
const pages = vi.hoisted(() => ({
  older: [] as WorkOrder[],
  list: undefined as unknown,
}));
vi.mock("../data/historyPages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/historyPages")>();
  return {
    ...actual,
    useHistoryPages: (list: unknown) => {
      pages.list = list;
      return {
        ...actual.NO_HISTORY,
        records: { ...actual.NO_HISTORY.records, workOrders: pages.older },
        loading: false,
        error: "",
        offline: false,
        loadOlder: () => {},
      };
    },
  };
});
vi.mock("./PartsRequests", () => ui.none(["RequestPartsButton"]));
vi.mock("./RequestedComponentMovement", () =>
  ui.none(["RequestedComponentMovement"]),
);
vi.mock("./ComponentCloseoutCorrection", () =>
  ui.none(["ComponentCloseoutCorrection"]),
);
vi.mock("./WorkOrderRevisions", () => ui.none(["WorkOrderRevisions"]));
vi.mock("./WorkOrderCosts", () => ui.none(["WorkOrderCosts"]));
vi.mock("./WorkOrderComponentWork", () => ui.none(["WorkOrderComponentWork"]));
vi.mock("./ReleaseStatements", () => ui.none(["ReleaseStatements"]));
vi.mock("./LogbookWording", () => ui.none(["LogbookWording"]));
vi.mock("./LogbookSample", () => ui.none(["LogbookSample"]));
vi.mock("./LogbookEntry", () => ui.none(["LogbookEntryButton"]));
vi.mock("./TaskCards", () =>
  ui.none(["ArchivedJobCardButton", "LinkedTaskCards", "WorkItemJobCards"]),
);

const now = Date.parse("2026-10-02T12:00:00Z");
const backend = { workOrder: vi.fn(), resumeWorkOrderTemplates: vi.fn() };
let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
  for (const fn of Object.values(backend)) fn.mockReset();
  ui.workspace = { snapshot: s, backend, online: true, connected: true };
  ui.states.clear();
  pages.older = [];
  ui.confirm.mockReset();
  vi.stubGlobal("window", { confirm: ui.confirm });
  vi.stubGlobal("document", { body: {} });
});

function order(tasks: string[] = [], at = now): WorkOrder {
  const cmd = workOrderCommand();
  cmd.tasks = tasks.map((d) =>
    newWorkTask({ kind: "manual", uuid: crypto.randomUUID() }, d),
  );
  return saveWorkOrder(s, cmd, at);
}

function render(element: ReactElement = h(ui.track(WorkOrders))) {
  ui.clicks.clear();
  ui.forms.clear();
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

function act(name: string, event?: unknown, index = 0) {
  render();
  ui.clicks.get(name)![index](event);
  return render();
}

function formData(fields: [string, string][]) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

describe("listing", () => {
  it("lists open orders newest first, then closed ones by completion date, with counts that include closed ones", () => {
    const older = order(["A"], now - 1000);
    const newer = order(["B"], now);
    Object.assign(newer, { status: "in-progress" });
    const closed = order([], now + 1000);
    const month = localDate().slice(0, 7);
    Object.assign(closed, {
      status: "completed",
      completionDate: `${month}-01`,
    });
    const lastYear = order([], now - 2000);
    Object.assign(lastYear, {
      status: "completed",
      completionDate: "2000-01-01",
    });
    const html = render();
    const numbers = html.match(/WO-\d{4}-\d{4}/g);
    expect(numbers).toEqual([newer.number, older.number]);
    const counts = [...html.matchAll(/class="ds-stat-value">(\d+)/g)];
    expect(counts.map((m) => m[1])).toEqual(["2", "1", "1"]);
    ui.states.set("WorkOrders", [null, "", true]);
    expect(render().match(/WO-\d{4}-\d{4}/g)).toEqual([
      newer.number,
      older.number,
      closed.number,
      lastYear.number,
    ]);
  });

  it("lists older closed orders after the workspace's once closed ones are included", () => {
    const recent = order([], now);
    Object.assign(recent, {
      status: "completed",
      completionDate: "2026-09-30",
    });
    const archived = {
      ...recent,
      uuid: crypto.randomUUID(),
      number: "WO-2019-0001",
      completionDate: "2019-05-01",
    };
    pages.older = [archived, { ...recent, scope: "Stale page copy" }];
    expect(render()).not.toContain("Load older");
    ui.states.set("WorkOrders", [null, "N206MA", true]);
    const html = render();
    expect(pages.list).toEqual({ kind: "workOrders", aircraftUuid: "N206MA" });
    ui.states.set("WorkOrders", [null, "", true]);
    const all = render();
    expect(all.match(/WO-\d{4}-\d{4}/g)).toEqual([
      recent.number,
      archived.number,
    ]);
    expect(all).not.toContain("Stale page copy");
    expect(all).toContain("Showing the last 3 months and 1 older work order");
    expect(html).toContain("Load older");
    const counts = [...all.matchAll(/class="ds-stat-value">(\d+)/g)];
    expect(counts.map((m) => m[1])).toEqual(["0", "0", "0"]);
  });

  it("explains an empty list, and needs a connection to open an order", () => {
    ui.workspace = { ...ui.workspace, connected: false };
    const html = render();
    expect(html).toContain("Open a work order for an aircraft");
    expect(html).toContain("Cached work orders are available.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Open work order/);
    Object.assign(order(), { status: "cancelled" });
    expect(render()).toContain("No open work orders match.");
  });
});

describe("work order form", () => {
  it("opens a new order with the entered fields", async () => {
    act("Open work order");
    await ui.forms.get("Open work order")!(
      formData([
        ["number", ""],
        ["dateOpened", "2026-01-02"],
        ["supervisor", "Sam"],
        ["scope", ""],
        ["priority", "high"],
        ["completionDate", ""],
        ["releaseOutcome", ""],
      ]),
    );
    expect(backend.workOrder).toHaveBeenCalledWith({
      action: "save",
      uuid: expect.any(String),
      version: 0,
      fields: expect.objectContaining({
        aircraftUuid: s.aircraft[0].uuid,
        dateOpened: "2026-01-02",
        supervisor: "Sam",
        priority: "high",
        status: "open",
        finalReview: "",
      }),
      completionReadings: undefined,
      componentUuids: [],
      componentWork: [],
      tasks: [],
    });
    expect(render()).not.toContain("Save work order");
  });

  it("closes an order only once confirmed, with readings in seconds", async () => {
    const open = order(["Wash"]);
    act("Details");
    act("Status", { target: { value: "completed" } });
    const html = render();
    expect(html).toContain("Closing this work order is permanent.");
    const close = () =>
      ui.forms.get("Save work order")!(
        formData([
          ["dateOpened", open.dateOpened],
          ["priority", "routine"],
          ["completionDate", "2026-10-02"],
          ["releaseOutcome", "Released"],
          ["completionTotalHours", "2341.25"],
          ["completionHobbs", "10"],
          ["completionTach", "9.5"],
          ["completionLandings", "120"],
        ]),
      );
    ui.confirm.mockReturnValue(false);
    await close();
    expect(ui.confirm.mock.calls[0][0]).toMatch(
      /^Closing this work order is permanent\..*\n\n\n\nClose this work order\?$/s,
    );
    expect(backend.workOrder).not.toHaveBeenCalled();
    ui.confirm.mockReturnValue(true);
    await close();
    expect(backend.workOrder.mock.calls[0][0].completionReadings).toEqual({
      totalSeconds: 8428500,
      hobbs: 36000,
      tach: 34200,
      cyclicHobbs: undefined,
      flightTimeLog: undefined,
      landings: 120,
      cycles: s.aircraft[0].cycles,
    });
  });

  it("stages task removal until the order is saved", () => {
    order(["Wash", "Lube"]);
    act("Details");
    act("Remove tasks");
    act("Select all removable");
    expect(act("Remove selected (2)")).toContain("Remove selected tasks?");
    const html = act("Yes, proceed");
    expect(html).toContain("No requested work added yet.");
    expect(html).toContain("Task removal is pending.");
    expect(html).not.toContain("Select tasks to remove");
  });

  it("adds requested work as an unsaved task", () => {
    order();
    act("Details");
    act("Additional requested work", { target: { value: "  Wash  " } });
    const html = act("Add requested work");
    expect(html).toContain('title="Wash"');
    expect(html).toContain("Remove unsaved task");
  });

  it("shows a closed order read-only", () => {
    Object.assign(order(["Wash"]), { status: "cancelled" });
    ui.states.set("WorkOrders", [null, "", true]);
    const html = act("Details");
    expect(html).toContain(
      "This work order is closed. Tasks and job cards are available to view only.",
    );
    expect(html).not.toContain("Remove tasks");
  });
});

describe("Add to work order", () => {
  const source = { kind: "inspection" as const, uuid: "demo-insp-1" };
  const button = () =>
    h(ui.track(AddToWorkOrder), { aircraftUuid: s.aircraft[0].uuid, source });
  const open = () => {
    render(button());
    ui.clicks.get("Add to work order")![0]();
    return render(button());
  };

  it("needs maintenance permission on the aircraft", () => {
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    expect(render(button())).toBe("");
  });

  it("offers only open, prepared orders without the item", () => {
    const free = order();
    const taken = order();
    taken.tasks = [newWorkTask(source, "Annual")];
    Object.assign(order(), { status: "cancelled" });
    const preparing = order();
    preparing.templateCopy = {
      jobId: "j",
      status: "running",
      completed: 0,
      total: 1,
    };
    const options = open().match(/<option value="[^"]*"/g);
    expect(options).toEqual([`<option value="${free.uuid}"`]);
  });

  it("adds the item, then reports the order's job card preparation", async () => {
    const target = order();
    open();
    await ui.forms.get("Add item")!(formData([["order", target.uuid]]));
    expect(backend.workOrder).toHaveBeenCalledWith({
      action: "add",
      uuid: target.uuid,
      version: target.version,
      source,
    });
    expect(render(button())).toContain("Item added. Job card preparation");
    target.templateCopy = {
      jobId: "j",
      status: "failed",
      completed: 1,
      total: 4,
    };
    const html = render(button());
    expect(html).toContain("Preparing job cards: 1 of 4.");
    expect(html).toContain("Retry the remaining cards.");
    await ui.forms.get("Resume preparation")!(formData([]));
    expect(backend.resumeWorkOrderTemplates).toHaveBeenCalledWith(target.uuid);
  });
});

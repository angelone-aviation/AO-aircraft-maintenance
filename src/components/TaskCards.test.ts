/**
 * Responsibility: Pins how job card lists filter and order cards, which cards
 *   a linked record lists and offers, how removing links stops at a refusal,
 *   which links, stock and choices the card editor offers, and how a card
 *   older than the workspace opens. Saving,
 *   signing and uploads need a browser: tests/e2e/job-cards*.spec.ts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/TaskCards.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardDefaults, type TaskCard } from "../domain/taskCards";
import {
  ArchivedJobCardButton,
  LinkedTaskCards,
  TaskCards,
  WorkItemJobCards,
} from "./TaskCards";

// The root's states are seeded in the order it declares them, and their
// updates recorded; later states are React's own.
const hooks = vi.hoisted(() => ({
  seeds: [] as unknown[],
  updates: [] as unknown[][],
  clicks: new Map<string, () => unknown>(),
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
// Tests compile JSX for development, so buttons are seen in jsxDEV.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  type Props = { onClick?: () => unknown; children?: ReactNode };
  const jsxDEV = (type: unknown, props: Props, ...rest: unknown[]) => {
    if (type === "button" && props.onClick)
      hooks.clicks.set(textOf(props.children), props.onClick);
    return (runtime.jsxDEV as (...args: unknown[]) => unknown)(
      type,
      props,
      ...rest,
    );
  };
  return { ...runtime, jsxDEV };
});
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  Modal: (props: { children: ReactNode }) =>
    createElement("section", null, props.children),
  AsyncForm: (props: { submitLabel: string; children: ReactNode }) =>
    createElement("form", { "data-label": props.submitLabel }, props.children),
}));
vi.mock("./PartsRequests", () => ({ RequestPartsButton: () => null }));
vi.mock("./WorkOrderRevisions", () => ({ WorkOrderRevisions: () => null }));
vi.mock("./LogbookWording", () => ({ LogbookWording: () => null }));
vi.mock("./TaskCsvImport", () => ({ TaskCsvImportButton: () => null }));
vi.mock("./Manuals", () => ({ ManualReferenceFields: () => null }));
vi.stubGlobal("document", { body: null });
const taskCard = vi.fn(async (_command: { uuid: string }) => {});
const workspace = {
  snapshot: demoSnapshot(),
  online: true,
  connected: true,
  backend: { taskCard },
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
const older = vi.hoisted(() => ({
  loaded: { loading: false, error: "", offline: false } as Record<
    string,
    unknown
  >,
  asked: [] as (string | undefined)[],
}));
vi.mock("../data/historyPages", async (original) => ({
  ...(await original<typeof import("../data/historyPages")>()),
  useWorkOrderHistory: (uuid?: string) => {
    older.asked.push(uuid);
    return older.loaded;
  },
}));

const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${10 + n}`;
const card = (n: number, extra: Partial<TaskCard> = {}): TaskCard => ({
  ...taskCardDefaults("demo-206"),
  uuid: uuid(n),
  version: 1,
  cardNumber: `TC-${n}`,
  title: `Card ${n}`,
  ...{ createdAt: 0, createdBy: "", updatedAt: 0, stepSignoffs: {} },
  ...{ technicianSignoff: null, inspectionSignoff: null },
  ...extra,
});
const OPEN = { uuid: uuid(90), number: "WO-1", status: "open" };
const CLOSED = { uuid: uuid(91), number: "WO-2", status: "completed" };
const STOCK = {
  kind: "stock",
  locationUuid: "store",
  programUuid: "demo-program",
};
const snapshot = (cards: TaskCard[]) =>
  ({
    ...demoSnapshot(),
    taskCards: cards,
    workOrders: [OPEN, CLOSED].map((w) => ({ ...w, aircraftUuid: "demo-206" })),
    management: [
      {
        kind: "location",
        uuid: "store",
        name: "Store",
        programUuid: "demo-program",
      },
      {
        ...STOCK,
        uuid: "oil",
        partNumber: "OIL",
        description: "Oil",
        quantity: 2,
      },
      {
        ...STOCK,
        uuid: "old",
        partNumber: "OLD",
        description: "Old lot",
        quantity: 1,
        expirationDate: "2020-01-01",
      },
      {
        ...STOCK,
        uuid: "aged",
        partNumber: "AGED",
        description: "Aged lot",
        quantity: 1,
        expirationDate: "2020-01-01",
      },
      {
        kind: "component",
        uuid: "fitted",
        aircraftUuid: "demo-206",
        componentType: "Engine",
        serial: "E1",
        installed: true,
      },
      {
        kind: "component",
        uuid: "removed",
        aircraftUuid: "demo-206",
        componentType: "Prop",
        serial: "P1",
        installed: false,
      },
      {
        kind: "component",
        uuid: "spare",
        aircraftUuid: "demo-206",
        componentType: "Prop",
        serial: "P2",
        installed: false,
      },
    ],
  }) as unknown as typeof workspace.snapshot;
const render = (root: unknown, props: object, seeds: unknown[]) => {
  hooks.seeds = [...seeds];
  hooks.updates = [];
  hooks.clicks.clear();
  return renderToStaticMarkup(createElement(root as never, props));
};
// Card numbers in order of first appearance.
const order = (html: string) => [...new Set(html.match(/TC-\d+/g))];
const TEMPLATE = card(1, { inspectionUuid: "demo-insp-1" });
const COPY = card(2, {
  ...{ workOrderUuid: OPEN.uuid, sourceTaskCardUuid: TEMPLATE.uuid },
  ...{ inspectionUuid: "demo-insp-1", status: "in-progress" },
});

beforeEach(() => {
  workspace.online = true;
  taskCard.mockReset();
});

it("filters templates and job cards by status apart", () => {
  workspace.snapshot = snapshot([
    TEMPLATE,
    COPY,
    card(3, { workOrderUuid: OPEN.uuid }),
  ]);
  const listed = (status: string) =>
    order(render(TaskCards, {}, [undefined, "", status, "", "number"]));
  expect(listed("template")).toEqual(["TC-1"]);
  expect(listed("draft")).toEqual(["TC-3"]);
});

it("orders by zone with zoneless cards last, or by card number", () => {
  const onItem = { workOrderUuid: OPEN.uuid, workTaskUuid: uuid(50) };
  const cards = [
    card(10, { ...onItem, description: "Zone: 200" }),
    card(9, onItem),
    card(8, { ...onItem, description: "Zone: 100" }),
  ];
  workspace.snapshot = snapshot(cards);
  const item = { uuid: uuid(50), description: "", source: { kind: "x" } };
  const list = (by: string) =>
    order(
      render(WorkItemJobCards, { workOrderUuid: OPEN.uuid, item }, [
        undefined,
        by,
      ]),
    );
  expect(list("zone")).toEqual(["TC-8", "TC-10", "TC-9"]);
  expect(list("number")).toEqual(["TC-8", "TC-9", "TC-10"]);
});

it("shows a long description's first 157 characters and an ellipsis", () => {
  workspace.snapshot = snapshot([card(4, { description: "x".repeat(161) })]);
  const html = render(TaskCards, {}, [undefined, "", "", "", "zone"]);
  expect(html).toContain(`${"x".repeat(157)}…<`);
});

it("lists cached cards offline but offers no new card", () => {
  workspace.snapshot = snapshot([TEMPLATE]);
  workspace.online = false;
  const html = render(TaskCards, {}, [undefined, "", "", "", "zone"]);
  expect(html).toContain("Cached job cards are available.");
  // The button's plus icon sits between the tag and its words.
  expect(html).toMatch(
    /disabled=""><svg[^>]*><path[^>]*><\/path><\/svg>New job card/,
  );
});

it("lists and offers cards by the kind of linked record", () => {
  const other = card(4, { requirementUuid: uuid(40) });
  workspace.snapshot = snapshot([TEMPLATE, COPY, other, card(5)]);
  const linked = (link: object) =>
    render(LinkedTaskCards, { aircraftUuid: "demo-206", link }, [
      true,
      undefined,
      "number",
      false,
      [],
      false,
      "",
    ]);
  const inspection = linked({ kind: "inspection", uuid: "demo-insp-1" });
  expect(order(inspection.split("<form")[0])).toEqual(["TC-1"]);
  expect(order(inspection.split("<form")[1])).toEqual(["TC-4", "TC-5"]);
  const workOrder = linked({ kind: "workOrder", uuid: OPEN.uuid });
  expect(order(workOrder.split("<form")[0])).toEqual(["TC-2"]);
  expect(order(workOrder.split("<form")[1])).toEqual(["TC-5"]);
  const closed = linked({ kind: "workOrder", uuid: CLOSED.uuid });
  expect(closed).toMatch(/disabled="">Create linked job card/);
});

it("stops removing links at the first refusal and keeps the rest selected", async () => {
  const cards = [
    card(6, { inspectionUuid: "demo-insp-1" }),
    card(7, { inspectionUuid: "demo-insp-1" }),
  ];
  workspace.snapshot = snapshot(cards);
  taskCard.mockImplementation(async ({ uuid: id }) => {
    if (id === cards[1].uuid) throw new Error("Refused.");
  });
  const ids = cards.map((c) => c.uuid);
  render(
    LinkedTaskCards,
    {
      aircraftUuid: "demo-206",
      link: { kind: "inspection", uuid: "demo-insp-1" },
    },
    [true, undefined, "zone", true, ids, false, ""],
  );
  hooks.clicks.get("Remove selected (2)")!();
  await new Promise((settled) => setTimeout(settled));
  const [removing, removeIds, , removeError] = hooks.updates.slice(3);
  expect(removing).toEqual([]);
  expect((removeIds[0] as (ids: string[]) => string[])(ids)).toEqual([ids[1]]);
  expect(removeError).toEqual(["", "Refused."]);
});

it("locks a template's work order and saved links, and a copy's every link", () => {
  const editor = (c: TaskCard) => {
    workspace.snapshot = snapshot([c]);
    return render(ArchivedJobCardButton, { card: c }, [true]);
  };
  const locked = (html: string, label: string) =>
    new RegExp(`${label}</label><select[^>]*disabled=""`).test(html);
  const template = editor(TEMPLATE);
  expect(locked(template, "Work order")).toBe(true);
  expect(locked(template, "Inspection")).toBe(true);
  expect(locked(template, "Component")).toBe(false);
  expect(locked(editor(COPY), "Component")).toBe(true);
});

it("lists a removed component only while the card links it", () => {
  workspace.snapshot = snapshot([card(8, { componentUuid: "removed" })]);
  const html = render(
    ArchivedJobCardButton,
    { card: card(8, { componentUuid: "removed" }) },
    [true],
  );
  expect(html).toContain("Engine · E1");
  expect(html).toContain("Prop · P1");
  expect(html).not.toContain("Prop · P2");
});

it("offers an expired lot only when the part already uses it", () => {
  const part = {
    uuid: uuid(30),
    partNumber: "AGED",
    description: "",
    quantity: 1,
  };
  const stocked = card(9, {
    partsUsed: [
      {
        ...part,
        source: "stock",
        locationUuid: "store",
        stockUuid: "aged",
        serialLot: "",
        removedComponent: "",
        installedComponent: "",
      },
    ],
  });
  workspace.snapshot = snapshot([stocked]);
  const html = render(ArchivedJobCardButton, { card: stocked }, [true]);
  expect(html).toContain(
    '<option value="oil">OIL · Oil · Available: 2</option>',
  );
  expect(html).toContain(
    '<option value="old" disabled="">OLD · Old lot · Expired 2020-01-01</option>',
  );
  expect(html).toMatch(
    /<option value="aged" selected="">AGED · Aged lot · Expired/,
  );
});

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node.trim();
  if (Array.isArray(node)) return node.map(textOf).join("").trim();
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}

it("opens a card the workspace does not hold by loading its work order", () => {
  workspace.snapshot = snapshot([]);
  const archived = card(12, { workOrderUuid: CLOSED.uuid, title: "Older" });
  older.asked = [];
  older.loaded = { loading: true, error: "", offline: false };
  const loading = render(ArchivedJobCardButton, { card: archived }, [true]);
  expect(older.asked).toContain(CLOSED.uuid);
  expect(loading).toContain("Loading the job card…");
  expect(loading).not.toContain('data-label="Save job card"');
  older.loaded = {
    ...{ loading: false, error: "", offline: false },
    history: {
      workOrder: { ...CLOSED, aircraftUuid: "demo-206" },
      taskCards: [],
      archivedTaskCards: [archived],
      costs: [],
      taskEvidence: [],
      workOrderAttachments: [],
      partsRequests: [],
    },
  };
  const opened = render(ArchivedJobCardButton, { card: archived }, [true]);
  expect(opened).toContain('value="Older"');
});

it("says an older card needs a connection, or was not found, never a blank new card", () => {
  workspace.snapshot = snapshot([]);
  older.loaded = { loading: false, error: "", offline: true };
  const offline = render(
    ArchivedJobCardButton,
    { card: card(13, { workOrderUuid: CLOSED.uuid }) },
    [true],
  );
  expect(offline).toContain("Reconnect to open it.");
  older.loaded = { loading: false, error: "", offline: false };
  const unknown = render(ArchivedJobCardButton, { card: card(14) }, [true]);
  expect(unknown).toContain("Job card not found.");
  expect(unknown).not.toContain('data-label="Save job card"');
});

/**
 * Responsibility: Pins parts and repair requests: the record button, the
 *   screen's filters and selection, new drafts per source, editor rules,
 *   stock availability, reservations and purchase-order drafts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/PartsRequests.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain (components, partsRequests,
 *   purchaseOrders).
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key and capture buttons, fields,
 * forms and stubs: a test renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema } from "../domain/components";
import {
  applyRequestCommand,
  requestDraftSchema,
  type PartsRequest,
  type RequestCommand,
  type RequestDraft,
  type RequestSource,
} from "../domain/partsRequests";
import { applyPOCommand, poDraftSchema } from "../domain/purchaseOrders";
import type { Snapshot } from "../domain/model";
import {
  PartsRequests,
  RequestPartsButton,
  requestPODraft,
} from "./PartsRequests";

type Props = Record<string, unknown>;
type Control = { onChange: (event: { target: Props }) => void } & Props;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as { key: string; next: number }[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  effects: [] as (() => unknown)[],
  buttons: [] as { text: string; props: Props }[],
  fields: new Map<string, Control>(),
  forms: new Map<string, Props>(),
  stubs: new Map<string, Props>(),
  stubList: [] as { name: string; props: Props }[],
  workspace: {} as Props,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const frame = ui.frames[ui.frames.length - 1];
      const slots = ui.states.get(frame.key) ?? [];
      ui.states.set(frame.key, slots);
      const slot = frame.next++;
      if (!(slot in slots))
        slots[slot] = typeof initial === "function" ? initial() : initial;
      const set = (update: unknown) => {
        slots[slot] =
          typeof update === "function" ? update(slots[slot]) : update;
      };
      return [slots[slot], set];
    },
    useEffect: (effect: () => unknown) => {
      ui.effects.push(effect);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const tracked = (type: FunctionComponent, key: unknown) => {
    const byKey = ui.wrappers.get(type) ?? new Map<unknown, unknown>();
    ui.wrappers.set(type, byKey);
    if (!byKey.has(key))
      byKey.set(key, (props: object) => {
        const id = `${type.name}:${String(key)}`;
        ui.rendered.add(id);
        ui.frames.push({ key: id, next: 0 });
        try {
          return type(props);
        } finally {
          ui.frames.pop();
        }
      });
    return byKey.get(key);
  };
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = args;
      const control = props as Control;
      if (type === "button")
        ui.buttons.push({ text: textOf(props).trim(), props: control });
      if (
        typeof type === "string" &&
        control["aria-label"] &&
        typeof control.onChange === "function"
      )
        ui.fields.set(control["aria-label"] as string, control);
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "children" in node)
      return textOf(node.children);
    if (node && typeof node === "object" && "props" in node)
      return textOf(node.props);
    return "";
  }
});
// Modal is a plain element: the real dialog's effects need a DOM.
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Modal: (props: Parameters<typeof actual.Modal>[0]) => {
      ui.stubs.set(`Modal ${props.title}`, props as never);
      return createElement(
        "dialog",
        { "aria-label": props.title },
        props.children,
      );
    },
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      const [control] = [props.children].flat() as { props: Control }[];
      ui.fields.set(props.label, control.props);
      return actual.Field(props);
    },
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props as never);
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./AircraftSpruce", () => ({
  SpruceProductPicker: stub("SpruceProductPicker"),
}));
vi.mock("./Vendors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Vendors")>()),
  VendorPicker: stub("VendorPicker"),
}));
vi.mock("./SavedAddresses", () => ({
  SavedAddressPicker: stub("SavedAddressPicker"),
}));
vi.mock("./PurchaseOrders", () => ({
  POEditor: stub("POEditor"),
  PODetail: stub("PODetail"),
}));
vi.mock("../data/partsRequestPdf", () => ({
  requestPdf: (_r: unknown, _s: unknown, kind: string) => ({
    save: (name: string) => calls.push(["pdf", kind, name]),
  }),
}));

// A stub records its props, so a test can read them and call callbacks.
function stub(name: string) {
  return (props: Props) => {
    ui.stubs.set(name, props);
    ui.stubList.push({ name, props });
    return `[${name}]`;
  };
}

const NOW = Date.parse("2026-11-04T12:00:00Z");
let s: Snapshot;
let calls: unknown[][];
let element: Parameters<typeof renderToStaticMarkup>[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ui.states.clear();
  ui.stubs.clear();
  calls = [];
  s = fixture();
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      partsRequest: async (command: RequestCommand) =>
        void calls.push(["partsRequest", command]),
      manage: async (command: unknown) => void calls.push(["manage", command]),
    },
  };
  vi.stubGlobal("document", { body: {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(next = element) {
  element = next;
  ui.buttons = [];
  ui.stubList = [];
  ui.effects = [];
  ui.fields.clear();
  ui.forms.clear();
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(element);
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function click(text: string) {
  const found = ui.buttons.find((b) => b.text === text);
  if (!found) throw Error(`No button "${text}"`);
  (found.props.onClick as () => unknown)();
  return render();
}

function change(label: string, value: unknown) {
  const field = ui.fields.get(label);
  if (!field) throw Error(`No field "${label}"`);
  field.onChange({ target: { value, checked: value } });
  return render();
}

async function submit(label: string) {
  const form = ui.forms.get(label);
  if (!form) throw Error(`No form "${label}"`);
  try {
    await (form.onSubmit as (data: FormData) => Promise<void>)(new FormData());
    return "saved";
  } catch (e) {
    return (e as Error).message;
  } finally {
    render();
  }
}

// A store and a shop, tires and an alternate (one lot expired), a vendor, an
// uninstalled pump in the store and a stock request for 5 tires.
function fixture() {
  const snapshot = demoSnapshot();
  snapshot.user.isAdmin = true;
  snapshot.management = [
    location("store", "Main store", "Hangar"),
    location("shop", "Shop", ""),
    stock("tire", "TIRE", "store", 3, { alternates: "TIRE-B", vendor: "Acme" }),
    stock("tire-b", "TIRE-B", "shop", 2, { condition: "overhauled" }),
    stock("expired", "TIRE", "shop", 4, { expirationDate: "2025-01-01" }),
    stock("core", "TIRE", "shop", 6, { condition: "as removed" }),
    componentSchema.parse({
      uuid: "pump",
      version: 1,
      programUuid: "demo-program",
      kind: "component",
      aircraftUuid: "",
      componentType: "Appliance",
      partNumber: "PUMP",
      serial: "SN1",
      manufacturer: "Maker",
      notes: "",
      trackTime: true,
      trackCycles: true,
      trackCalendar: false,
      installed: false,
      locationUuid: "shop",
      installedSeconds: 0,
      installedCycles: 0,
      timeSinceNew: 3600,
      timeSinceOverhaul: 0,
      timeSinceRepair: 0,
      cyclesSinceNew: 1,
      serviceDaysBase: 0,
    }),
  ] as Snapshot["management"];
  saveRequest(snapshot, { uuid: "r1" });
  return snapshot;
}

function location(uuid: string, name: string, address: string) {
  return {
    uuid,
    version: 1,
    programUuid: "demo-program",
    kind: "location",
    name,
    address,
    contact: "",
  };
}

function stock(
  uuid: string,
  partNumber: string,
  locationUuid: string,
  quantity: number,
  extra: object = {},
) {
  return {
    uuid,
    version: 1,
    programUuid: "demo-program",
    kind: "stock",
    partNumber,
    description: partNumber.toLowerCase(),
    category: "part",
    condition: "new",
    locationUuid,
    quantity,
    minimum: 0,
    alternates: "",
    ...extra,
  };
}

function saveRequest(snapshot: Snapshot, overrides: Partial<RequestDraft>) {
  const draft = requestDraftSchema.parse({
    version: 0,
    source: { kind: "stock" },
    mode: "parts",
    date: "2026-11-01",
    engineer: "Alex",
    priority: "P2 Routine",
    requiredBy: "",
    vendor: "Acme",
    currency: "USD",
    shipTo: "Hangar",
    notes: "For the spare wheel",
    lines: [
      {
        uuid: `${overrides.uuid}-line`,
        partNumber: "TIRE",
        alternateNumber: "TIRE-B",
        description: "Tire",
        quantity: 5,
      },
    ],
    ...overrides,
  });
  return applyRequestCommand(
    snapshot,
    { kind: "save", requestUuid: crypto.randomUUID(), draft },
    NOW,
  );
}

function request(uuid: string) {
  return s.partsRequests!.find((r) => r.uuid === uuid)!;
}

const REPAIR: Partial<RequestDraft> = {
  uuid: "r2",
  source: { kind: "component", uuid: "pump", workOrderUuid: "" },
  mode: "repair",
  vendor: "acme",
  lines: [
    {
      uuid: "r2-line",
      partNumber: "PUMP",
      alternateNumber: "",
      description: "Maker Appliance",
      quantity: 1,
      ipcReference: "",
      componentUuid: "pump",
      service: "overhaul",
      defect: "Leak",
      workRequested: "Reseal",
      quotedCents: 12345,
    },
  ],
};
describe("purchase order drafts from requests", () => {
  it("refuses, in order, what cannot become one order", () => {
    const refusal = (ids: string[]) => {
      try {
        requestPODraft(s, ids);
        return "drafted";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(refusal([])).toBe("Select an open request.");
    saveRequest(s, { uuid: "r3", vendor: "Other" });
    mark("r3", { recurring: true });
    expect(refusal(["r1", "r3"])).toBe(
      "Select occurrence requests for purchasing, not recurring lists.",
    );
    saveRequest(s, { uuid: "r4", vendor: "Other" });
    saveRequest(s, { uuid: "r5", currency: "CAD" });
    for (const other of ["r4", "r5"])
      expect(refusal(["r1", other])).toBe(
        "Select requests with the same vendor, currency and ship-to address.",
      );
    const r1 = request("r1");
    applyRequestCommand(
      s,
      {
        kind: "reserve",
        requestUuid: crypto.randomUUID(),
        uuid: "r1",
        version: r1.version,
        lineUuid: "r1-line",
        stockUuid: "tire",
        quantity: 3,
        alternateConfirmed: false,
      },
      NOW,
    );
    expect(refusal(["r1"])).toBe("drafted");
    purchase("r1", 2);
    expect(refusal(["r1"])).toBe(
      "Selected requests are already reserved, ordered or fulfilled.",
    );
  });

  it("orders each line's shortage, returning repaired components", () => {
    saveRequest(s, REPAIR);
    const draft = requestPODraft(s, ["r1", "r2"]);
    expect(draft).toMatchObject({
      version: 0,
      vendor: "Acme",
      shipTo: "Hangar",
      currency: "USD",
      shippingCents: 0,
      notes: "PR-00001: For the spare wheel\nPR-00002: For the spare wheel",
    });
    expect(draft.lines).toMatchObject([
      {
        stockUuid: "tire",
        locationUuid: "store",
        partNumber: "TIRE",
        quantity: 5,
        kind: "part",
        requestAllocations: [
          { requestUuid: "r1", lineUuid: "r1-line", quantity: 5 },
        ],
      },
      {
        stockUuid: "",
        locationUuid: "shop",
        description: "Maker Appliance — overhaul: Reseal",
        unitCents: 12345,
        kind: "component",
        repairComponentUuid: "pump",
        repairWork: "overhaul",
      },
    ]);
  });

  it("falls back to the first location, then makes the buyer choose", () => {
    saveRequest(s, {
      uuid: "r3",
      lines: [{ ...request("r1").lines[0], partNumber: "BOLT" }],
    });
    expect(requestPODraft(s, ["r3"]).lines[0].locationUuid).toBe("store");
    s.management = s.management!.filter((r) => r.kind !== "location");
    expect(requestPODraft(s, ["r3"]).lines[0].locationUuid).toBe(
      "choose-location",
    );
  });
});

describe("request parts button", () => {
  const source = { kind: "stock" as const, uuid: "tire", workOrderUuid: "" };

  it("counts the record's open requests", () => {
    saveRequest(s, { uuid: "r3", source });
    saveRequest(s, { uuid: "r4", source });
    mark("r4", { cancelled: true });
    expect(render(h(RequestPartsButton, { source }))).toContain(
      "Parts / repair requests (1)",
    );
  });

  it("is hidden for an unknown record or stock without administrator", () => {
    const missing = { ...source, kind: "inspection" as const, uuid: "x" };
    expect(render(h(RequestPartsButton, { source: missing }))).toBe("");
    s.user.isAdmin = false;
    expect(render(h(RequestPartsButton, { source }))).toBe("");
  });

  it("opens the record's requests and reports the close", () => {
    const onClose = () => calls.push(["closed"]);
    render(h(RequestPartsButton, { source, label: "Parts", onClose }));
    expect(click("Parts")).toContain('aria-label="Parts"');
    (ui.stubs.get("Modal Parts")!.onClose as () => void)();
    expect(render()).not.toContain("<dialog");
    expect(calls).toEqual([["closed"]]);
  });
});

describe("requests screen", () => {
  const numbers = (html: string) =>
    [...html.matchAll(/class="shop-title-button">([^<]*)/g)].map((m) => m[1]);

  it("lists newest first and filters by search, priority and status", () => {
    saveRequest(s, { ...REPAIR, priority: "P1 AOG" });
    s.partsRequests = s.partsRequests!.map((r, i) => ({ ...r, createdAt: i }));
    expect(numbers(render(h(PartsRequests)))).toEqual(["PR-00002", "PR-00001"]);
    expect(render()).toContain('<span class="shop-count">02</span>');
    expect(numbers(change("Search requests", "reseal"))).toEqual([]);
    expect(numbers(change("Search requests", "maker"))).toEqual(["PR-00002"]);
    change("Search requests", "");
    expect(numbers(change("Priority", "P2 Routine"))).toEqual(["PR-00001"]);
    change("Priority", "");
    expect(change("Status", "Fulfilled")).toContain(
      "No requests match these filters",
    );
  });

  it("selects only open occurrences with something to order", () => {
    saveRequest(s, { uuid: "r3" });
    mark("r3", { recurring: true });
    render(h(PartsRequests));
    expect(ui.fields.get("Select PR-00002")!.disabled).toBe(true);
    change("Select PR-00001", true);
    expect(click("Add selected to purchase order (1)")).toContain(
      'aria-label="Purchase requested parts / repair services"',
    );
    expect(ui.stubs.get("POEditor")!.initial).toMatchObject({
      vendor: "Acme",
    });
  });

  it("drafts a new request for the first record the user may choose", () => {
    render(h(PartsRequests));
    click("New request");
    expect(ui.fields.get("Request for")!.value).toBe(
      JSON.stringify({ kind: "stock", uuid: "", workOrderUuid: "" }),
    );
    expect(ui.fields.get("Priority")!.value).toBe("P3 Stock");
  });
});

describe("request editor", () => {
  const open = (source: RequestSource) => {
    render(h(RequestPartsButton, { source, initialOpen: true }));
    click("New request");
  };

  it("drafts a repair of an uninstalled component from its location", () => {
    open({ kind: "component", uuid: "pump", workOrderUuid: "" });
    expect(ui.fields.get("Request type")!.value).toBe("repair");
    expect(ui.fields.get("Inventory location")!.value).toBe("Shop");
    expect(ui.fields.get("Part name")!.value).toBe("Maker Appliance");
    expect(ui.fields.get("Existing serialized component")!.value).toBe("pump");
  });

  it("asks for parts, not a repair, for an installed component", () => {
    s.management = s.management!.map((r) =>
      r.uuid === "pump" ? { ...r, installed: true } : r,
    );
    open({ kind: "component", uuid: "pump", workOrderUuid: "" });
    expect(ui.fields.get("Request type")!.value).toBe("parts");
  });

  it("drafts a stock request with its vendor, location and alternate", () => {
    open({ kind: "stock", uuid: "tire", workOrderUuid: "" });
    expect(ui.fields.get("Priority")!.value).toBe("P3 Stock");
    expect(ui.fields.get("Inventory location")!.value).toBe("Main store");
    expect(ui.fields.get("Alternate part number")!.value).toBe("TIRE-B");
    expect(ui.stubs.get("VendorPicker")!.value).toBe("Acme");
  });

  it("lists an inspection's stocked required parts with its manual page", () => {
    Object.assign(s.inspections[0], {
      requiredParts: [
        { stockUuid: "tire", quantity: 2 },
        { stockUuid: "gone", quantity: 1 },
      ],
      manualReference: { section: "5-1", printedPage: "3", pdfPage: 7 },
    });
    open({
      kind: "inspection",
      uuid: s.inspections[0].uuid,
      workOrderUuid: "",
    });
    expect(ui.fields.get("Quantity")!.value).toBe(2);
    expect(ui.fields.get("IPC / manual reference")!.value).toBe(
      "5-1 · printed page 3 · PDF page 7",
    );
  });

  it("drops the supplier mapping when the part number changes", () => {
    open({ kind: "stock", uuid: "", workOrderUuid: "" });
    const select = ui.stubs.get("SpruceProductPicker")!.onSelect as (
      ...args: unknown[]
    ) => void;
    select({ partNumber: "SPR", uom: "EA", currency: "USD", catalogAt: 1 }, 99);
    expect(render()).toContain("Aircraft Spruce: SPR · EA");
    expect(ui.stubs.get("VendorPicker")!.value).toBe("Aircraft Spruce");
    change("Part number", "OTHER");
    expect(render()).not.toContain("Aircraft Spruce:");
  });

  it("clears component links when the request type changes", async () => {
    open({ kind: "component", uuid: "pump", workOrderUuid: "" });
    change("Request type", "parts");
    change("Request type", "repair");
    expect(ui.fields.get("Existing serialized component")!.value).toBe("");
    expect(await submit("Save request")).toBe("saved");
  });

  it("saves a new vendor to the directory only for an administrator", async () => {
    open({ kind: "stock", uuid: "", workOrderUuid: "" });
    const picker = () =>
      ui.stubs.get("VendorPicker") as {
        onAdd: (name: string) => Promise<void>;
        customLabel: string;
        value: string;
      };
    expect(picker().customLabel).toBe("Create custom vendor");
    await picker().onAdd("New Co");
    render();
    expect(picker().value).toBe("New Co");
    expect(calls[0]).toMatchObject([
      "manage",
      { reason: "Vendor created from parts request" },
    ]);
  });
});

describe("request detail", () => {
  const open = (number: string) => {
    render(h(PartsRequests));
    return click(number);
  };

  it("links the source, offers its documents and reports their errors", async () => {
    saveRequest(s, REPAIR);
    const html = open("PR-00002");
    expect(html).toContain('<a href="/components">');
    click("Download packing slip");
    click("Download repair order / tag");
    await settle();
    expect(calls).toEqual([
      ["pdf", "packing", "PR-00002-packing-slip.pdf"],
      ["pdf", "request", "PR-00002.pdf"],
    ]);
  });

  it("shows serviceable stock, leaving expired lots out of what is available", () => {
    expect(open("PR-00001")).toContain(
      "Available: 3 · Shortage: 2 · Expired: 4",
    );
    expect(render()).toContain("TIRE-B (alternate) · overhauled");
  });

  it("reserves a lot, confirming an alternate part", async () => {
    open("PR-00001");
    change("Stock lot / location", "tire-b");
    expect(render()).toContain("I confirm use of the listed alternate");
    change("Quantity", "2");
    expect(await submit("Reserve stock")).toBe("saved");
    expect(calls.at(-1)).toMatchObject([
      "partsRequest",
      {
        kind: "reserve",
        uuid: "r1",
        lineUuid: "r1-line",
        stockUuid: "tire-b",
        quantity: 2,
        alternateConfirmed: false,
      },
    ]);
    change("Inventory action", "release");
    expect(ui.forms.has("Release reservation")).toBe(true);
    expect(ui.fields.get("Stock lot / location")!.value).toBe("");
  });

  it("cancels with the reason given", async () => {
    open("PR-00001");
    const form = ui.forms.get("Cancel request and release reservations")!;
    const data = new FormData();
    data.set("reason", "Not needed");
    await (form.onSubmit as (d: FormData) => Promise<void>)(data);
    expect(calls.at(-1)).toMatchObject([
      "partsRequest",
      { kind: "cancel", uuid: "r1", reason: "Not needed" },
    ]);
  });
});

function mark(uuid: string, changes: Partial<PartsRequest>) {
  s.partsRequests = s.partsRequests!.map((r) =>
    r.uuid === uuid ? { ...r, ...changes } : r,
  );
}

function purchase(uuid: string, quantity: number) {
  const r: PartsRequest = request(uuid);
  const draft = poDraftSchema.parse({
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: "Acme",
    vendorContact: "",
    currency: "USD",
    shipTo: "Hangar",
    expectedDate: "",
    shippingCents: 0,
    notes: "",
    lines: [
      {
        uuid: crypto.randomUUID(),
        stockUuid: "tire",
        locationUuid: "store",
        partNumber: "TIRE",
        description: "Tire",
        quantity,
        unitCents: 100,
        kind: "part",
        requestAllocations: [
          { requestUuid: r.uuid, lineUuid: r.lines[0].uuid, quantity },
        ],
      },
    ],
  });
  applyPOCommand(
    s,
    { kind: "save", requestUuid: crypto.randomUUID(), drafts: [draft] },
    NOW,
  );
}

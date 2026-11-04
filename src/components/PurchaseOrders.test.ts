/**
 * Responsibility: Pins the purchase-order views: the list's search, filter,
 *   counts and overdue flag, the inspection PO quantities, the editor's
 *   refusals and per-vendor drafts, the order actions and attachments.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/PurchaseOrders.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain (management, purchaseOrders).
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key, record effects, and capture
 * buttons, fields, forms and stubs: a test renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement } from "../domain/management";
import {
  applyPOCommand,
  poDraftSchema,
  type POCommand,
  type PODraft,
  type PurchaseOrder,
} from "../domain/purchaseOrders";
import type { Snapshot } from "../domain/model";
import {
  InspectionPOButton,
  PODetail,
  POEditor,
  PurchaseOrders,
} from "./PurchaseOrders";

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
      ui.fields.set(props.label, (props.children as { props: Control }).props);
      return actual.Field(props);
    },
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props as never);
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: Props) =>
      createElement("a", { "data-to": props.to }, props.children as never),
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./AircraftSpruce", () => ({
  SpruceProductPicker: stub("SpruceProductPicker"),
  SpruceOrderProgress: stub("SpruceOrderProgress"),
}));
vi.mock("./Vendors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Vendors")>()),
  VendorEditor: stub("VendorEditor"),
  VendorPicker: stub("VendorPicker"),
}));
vi.mock("./SavedAddresses", () => ({
  SavedAddressPicker: stub("SavedAddressPicker"),
}));
vi.mock("./CoreReturns", () => ({ CoreReturns: stub("CoreReturns") }));
vi.mock("../data/poPdf", () => ({
  poPdf: () => ({
    save: (name: string) => calls.push(["save", name]),
    output: () => new Blob(["%PDF"]),
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
      purchaseOrder: async (command: POCommand) =>
        void calls.push(["purchaseOrder", command]),
      manage: async (command: unknown) => void calls.push(["manage", command]),
      poFiles: async (uuid: string) => {
        calls.push(["poFiles", uuid]);
        return [{ uuid: "f1", name: "invoice.pdf", url: "https://f/1" }];
      },
      attachPOFile: async (...args: unknown[]) =>
        void calls.push(["attach", ...args]),
      removePOFile: async (uuid: string) => void calls.push(["remove", uuid]),
    },
  };
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

const ADDRESS = {
  street: "1 Hangar Rd",
  city: "Town",
  region: "CA",
  postalCode: "94000",
  country: "US",
  contactName: "Sam",
  email: "sam@example.test",
  phone: "+1 415 555 0100",
  confirmed: true,
};

// A program with two stores, a tire and a filter in stock, two vendors and
// an inspection that needs 5 tires and 2 filters.
function fixture() {
  const snapshot = demoSnapshot();
  snapshot.user.isAdmin = true;
  for (const record of [
    location("store", "Store", "1 Hangar Rd, Town"),
    location("shop", "Shop", ""),
    stock("tire", "TIRE", "store", 1, 12.5),
    stock("filter", "FLT", "shop", 4),
    { uuid: "va", kind: "vendor", name: "Vendor A", addressDetails: ADDRESS },
    { uuid: "vb", kind: "vendor", name: "Bolt Co" },
  ])
    applyManagement(
      snapshot,
      {
        action: "record.save",
        requestUuid: crypto.randomUUID(),
        reason: "Seed",
        record: { version: 0, ...record },
      } as never,
      NOW,
    );
  snapshot.inspections[0].requiredParts = [
    { stockUuid: "tire", quantity: 5 },
    { stockUuid: "filter", quantity: 2 },
  ] as never;
  return snapshot;
}

function location(uuid: string, name: string, address: string) {
  const details = address ? { addressDetails: ADDRESS } : {};
  return { uuid, kind: "location", name, address, contact: "", ...details };
}

function stock(
  uuid: string,
  partNumber: string,
  locationUuid: string,
  quantity: number,
  cost?: number,
) {
  return {
    uuid,
    kind: "stock",
    partNumber,
    description: partNumber.toLowerCase(),
    category: "part",
    condition: "new",
    locationUuid,
    quantity,
    minimum: 0,
    alternates: "",
    cost,
  };
}

function draft(overrides: Partial<PODraft> = {}): PODraft {
  return poDraftSchema.parse({
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: "Vendor A",
    vendorContact: "",
    shipTo: "Main hangar",
    shippingAddress: ADDRESS,
    expectedDate: "",
    currency: "USD",
    shippingCents: 1000,
    notes: "",
    lines: [
      {
        uuid: crypto.randomUUID(),
        stockUuid: "tire",
        locationUuid: "store",
        partNumber: "TIRE",
        description: "tire",
        quantity: 3,
        unitCents: 2500,
        kind: "part",
      },
    ],
    ...overrides,
  });
}

function order(command: POCommand) {
  return applyPOCommand(s, command, NOW)[0];
}

function saved(overrides: Partial<PODraft> = {}) {
  return order({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    drafts: [draft(overrides)],
  });
}

function issued(overrides: Partial<PODraft> = {}) {
  const p = saved(overrides);
  return order({
    kind: "issue",
    requestUuid: crypto.randomUUID(),
    uuid: p.uuid,
    version: p.version,
    reason: "",
  });
}

const saves = () =>
  calls
    .filter(([kind]) => kind === "purchaseOrder")
    .map(([, command]) => command as Extract<POCommand, { kind: "save" }>);

describe("purchase orders screen", () => {
  it("is for inventory administrators only", () => {
    s.user.isAdmin = false;
    expect(render(h(PurchaseOrders))).toContain(
      "Inventory administrator access required",
    );
  });

  it("counts drafts, open and overdue orders and flags late deliveries", () => {
    saved({ vendor: "Bolt Co" });
    issued({ expectedDate: "2026-11-03" });
    issued({ expectedDate: "2026-11-04" });
    const html = render(h(PurchaseOrders));
    expect(html).toMatch(/Drafts.*>1<.*Open.*>2<.*Delivery overdue.*>1</s);
    expect(html.match(/shop-overdue/g)).toHaveLength(1);
  });

  it("lists newest first, searching PO, vendor and part number", () => {
    s.purchaseOrders = [
      { ...saved({ vendor: "Bolt Co" }), createdAt: 1 },
      { ...saved(), createdAt: 2 },
    ];
    const rows = () =>
      [...render().matchAll(/<td data-label="Vendor">([^<]*)/g)].map(
        (m) => m[1],
      );
    render(h(PurchaseOrders));
    expect(rows()).toEqual(["Vendor A", "Bolt Co"]);
    change("Search purchase orders", "bolt");
    expect(rows()).toEqual(["Bolt Co"]);
    change("Search purchase orders", "TIRE");
    expect(rows()).toEqual(["Vendor A", "Bolt Co"]);
    change("Search purchase orders", "PO-00002");
    expect(rows()).toEqual(["Vendor A"]);
  });

  it("filters by status and says why the list is empty", () => {
    saved();
    render(h(PurchaseOrders));
    expect(change("PO status", "Received")).toContain(
      "No purchase orders match the search or status.",
    );
    s.purchaseOrders = [];
    expect(render()).toContain(
      "Create a PO here or from an inspection’s required parts.",
    );
  });

  it("opens an order, then its draft in the editor", () => {
    const p = saved();
    render(h(PurchaseOrders));
    expect(click(p.number)).toContain(`aria-label="${p.number} · Draft"`);
    expect(click("Edit draft")).toContain('aria-label="Edit draft PO"');
  });
});

describe("inspection PO button", () => {
  it("orders what the inspection still needs beyond stock and orders", () => {
    issued({ lines: [{ ...draft().lines[0], quantity: 1 }] });
    saved({
      lines: [
        {
          ...draft().lines[0],
          quantity: 2,
          inspectionUuid: s.inspections[0].uuid,
          aircraftUuid: s.inspections[0].aircraftUuid,
        },
      ],
    });
    render(h(InspectionPOButton, { inspection: s.inspections[0] }));
    click("Create PO for parts");
    expect([lineValues(1), lineValues(2)]).toEqual([
      ["TIRE", 1, 12.5, "part"],
      ["FLT", 0, 0, "part"],
    ]);
  });

  it("is hidden without required parts or administrator access", () => {
    const inspection = { ...s.inspections[0], requiredParts: [] };
    expect(render(h(InspectionPOButton, { inspection }))).toBe("");
    s.user.isAdmin = false;
    expect(
      render(h(InspectionPOButton, { inspection: s.inspections[0] })),
    ).toBe("");
  });
});

describe("purchase order editor", () => {
  const open = (initial: PODraft = draft(), extra: Props = {}) =>
    render(
      h(POEditor, { initial, onDone: () => calls.push(["done"]), ...extra }),
    );

  it("ships to the first line's location when no ship-to is given", () => {
    open({ ...draft(), shipTo: " ", shippingAddress: undefined });
    const store = s.management!.find((r) => r.uuid === "store")!;
    expect(ui.stubs.get("SavedAddressPicker")).toMatchObject({
      inventoryLocationName: "Store",
      legacy: (store as { address: string }).address,
      value: ADDRESS,
    });
  });

  it("refuses in order: no quantity, no vendor, unknown vendor", async () => {
    open({ ...draft(), vendor: "" });
    change("Part 1 quantity", "0");
    expect(await submit("Save draft PO")).toBe(
      "Select at least one part quantity to purchase.",
    );
    change("Part 1 quantity", "2");
    expect(await submit("Save draft PO")).toBe(
      "Select a vendor for each part.",
    );
    vendorPicker().onChange("Nobody");
    render();
    expect(await submit("Save draft PO")).toBe(
      "Add vendor “Nobody” using Quick add or Add vendor before saving.",
    );
    expect(saves()).toEqual([]);
  });

  it("splits lines by vendor into drafts with zero shipping", async () => {
    open(draft({ shippingCents: 0 }));
    click("Split part 1 across vendors");
    vendorPicker(2).onChange("Bolt Co");
    render();
    expect(await submit("Save draft PO")).toBe("saved");
    const [command] = saves();
    expect(
      command.drafts.map((d) => [d.uuid.slice(-2), d.vendor, d.lines.length]),
    ).toEqual([
      [command.drafts[0].uuid.slice(-2), "Vendor A", 1],
      ["-1", "Bolt Co", 1],
    ]);
    expect(calls.at(-1)).toEqual(["done"]);
  });

  it("refuses shipping across several vendors and a vendor change", async () => {
    open(draft());
    click("Split part 1 across vendors");
    vendorPicker(1).onChange("Bolt Co");
    render();
    expect(await submit("Save draft PO")).toBe(
      "Set shipping cost to zero here, then enter each vendor’s shipping charge on its separate draft PO.",
    );
    const p = saved();
    open({ ...p });
    expect(vendorPicker(1)).toBeUndefined();
  });

  it("adds lines to an existing draft only when they match it", async () => {
    const existing = saved();
    open(draft({ shipTo: "Elsewhere" }));
    change("Add to existing draft PO", existing.uuid);
    expect(await submit("Add to draft PO")).toBe(
      "Ship-to must match the existing draft.",
    );
    ui.states.clear();
    open(draft({ shipTo: existing.shipTo }));
    change("Add to existing draft PO", existing.uuid);
    expect(await submit("Add to draft PO")).toBe("saved");
    expect(saves()[0].drafts[0].lines).toHaveLength(2);
  });

  it("drops the supplier mapping when the part number changes", () => {
    open();
    (
      ui.stubs.get("SpruceProductPicker")!.onSelect as (...a: unknown[]) => void
    )({ partNumber: "SPR", uom: "EA", currency: "USD", catalogAt: 1 }, 1999);
    expect(render()).toContain("Aircraft Spruce: SPR · EA");
    expect(lineValues(1)).toEqual(["TIRE", 3, 19.99, "part"]);
    change("Part 1 number", "OTHER");
    expect(render()).not.toContain("Aircraft Spruce:");
  });

  it("quick-adds a vendor with a change-log reason", async () => {
    open({ ...draft(), vendor: "" });
    await vendorPicker().onAdd("New Co", true);
    render();
    expect(calls[0]).toMatchObject([
      "manage",
      {
        action: "record.save",
        record: { kind: "vendor", name: "New Co" },
        reason: "Vendor quick added from purchase order",
      },
    ]);
    expect(vendorPicker().value).toBe("New Co");
  });
});

describe("purchase order detail", () => {
  const open = (p: PurchaseOrder) =>
    render(h(PODetail, { po: p, onEdit: () => calls.push(["edit"]) }));

  it("offers each phase's actions", () => {
    const buttons = (html: string) =>
      [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) =>
        m[1].replace(/<[^>]*>/g, "").trim(),
      );
    expect(buttons(open(saved()))).toEqual([
      "Print PO",
      "Save PO PDF",
      "Edit draft",
      "Issue PO",
      "Cancel PO",
    ]);
    expect(buttons(open(issued()))).toEqual([
      "Print PO",
      "Save PO PDF",
      "Record shipment",
      "Receive parts",
      "Close PO",
      "Revise PO",
      "Cancel PO",
    ]);
  });

  it("explains a blocked preview window", async () => {
    vi.stubGlobal("window", { open: () => null });
    open(saved());
    click("Print PO");
    await settle();
    await settle();
    expect(render()).toContain(
      "Allow the PDF preview window, or use Save PO PDF.",
    );
    click("Save PO PDF");
    await settle();
    expect(calls).toContainEqual(["save", "PO-00001.pdf"]);
  });

  it("receives only lines with a quantity", async () => {
    const p = issued();
    open(p);
    click("Receive parts");
    expect(await submit("Confirm receipt into inventory")).toBe(
      "Enter a quantity for at least one line.",
    );
    change("TIRE quantity received", "2");
    change("TIRE received condition", "overhauled");
    expect(await submit("Confirm receipt into inventory")).toBe("saved");
    expect(calls.at(-1)).toMatchObject([
      "purchaseOrder",
      {
        kind: "receive",
        uuid: p.uuid,
        version: p.version,
        date: "2026-11-04",
        lines: [
          {
            lineUuid: p.lines[0].uuid,
            quantity: 2,
            condition: "overhauled",
            serials: [],
          },
        ],
      },
    ]);
  });

  it("records a shipment with its carrier and tracking", async () => {
    const p = issued();
    open(p);
    click("Record shipment");
    change("Carrier", "UPS");
    change("TIRE quantity shipped", "3");
    expect(await submit("Save shipment")).toBe("saved");
    expect(calls.at(-1)).toMatchObject([
      "purchaseOrder",
      {
        kind: "ship",
        carrier: "UPS",
        lines: [{ lineUuid: p.lines[0].uuid, quantity: 3 }],
      },
    ]);
  });

  it("loads, uploads and removes attachments", async () => {
    vi.stubGlobal("window", { confirm: () => true });
    const p = saved();
    open(p);
    for (const effect of ui.effects) effect();
    await settle();
    expect(render()).toContain('href="https://f/1"');
    const file = new File(["x"], "slip.pdf");
    const input = ui.fields.get("PO attachment")!;
    await (input.onChange as (e: unknown) => Promise<void>)({
      target: { files: [file], value: "slip.pdf" },
    });
    expect(calls).toContainEqual(["attach", p.uuid, undefined, file]);
    click("Delete");
    await settle();
    expect(calls).toContainEqual(["remove", "f1"]);
  });
});

function vendorPicker(index = 0) {
  return ui.stubList.filter((x) => x.name === "VendorPicker")[index]?.props as {
    onChange: (name: string, vendor?: unknown) => void;
    onAdd: (name: string, quick: boolean) => Promise<void>;
    value: string;
  };
}

// Part number, quantity, unit cost and category of an editor line.
function lineValues(line: number) {
  return ["number", "quantity", "unit cost", "category"].map(
    (field) => ui.fields.get(`Part ${line} ${field}`)?.value,
  );
}

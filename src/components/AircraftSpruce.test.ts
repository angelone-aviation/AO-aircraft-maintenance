/**
 * Responsibility: Pins the Aircraft Spruce views: linking, refreshing and
 *   disconnecting the account, searching and choosing a supplier part, and a
 *   purchase order's supplier progress.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AircraftSpruce.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 *
 * Server rendering keeps no state, runs no effects and calls no handlers, so
 * mocks keep each component's useState values by name and key (dropped once
 * it stops rendering, as on unmount), record each render's effects, and
 * capture buttons, fields and forms: a test mounts, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { demoSnapshot } from "../data/demo";
import type { SpruceProduct, SpruceStatus } from "../domain/aircraftSpruce";
import {
  AircraftSpruceAccount,
  SpruceOrderProgress,
  SpruceProductPicker,
} from "./AircraftSpruce";

type Frame = { key: string; next: number };
type Props = Record<string, unknown>;
type Control = { onChange: (event: { target: Props }) => void } & Props;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  effects: [] as (() => unknown)[],
  buttons: [] as { text: string; props: Props }[],
  fields: new Map<string, Control>(),
  forms: new Map<string, Props>(),
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
      if (type === "button")
        ui.buttons.push({ text: textOf(props).trim(), props: props as Props });
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && "children" in node)
      return textOf(node.children);
    return typeof node === "object" ? "" : String(node);
  }
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
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
vi.mock("@tanstack/react-router", () => ({ Link: () => "[Link]" }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

const PROGRAM = "demo-program";
const CATALOG_AT = Date.UTC(2026, 9, 1, 12);
const PRODUCT: SpruceProduct = {
  partNumber: "05-01234",
  description: "Oil filter",
  uom: "EA",
  netPrice: "12.50",
  currency: "USD",
  url: "https://www.aircraftspruce.com/catalog/05-01234",
  availability: [
    { location: "GA", quantity: "3", due: "" },
    { location: "CA", quantity: "", due: "2026-12-01" },
  ],
  catalogAt: CATALOG_AT,
} as unknown as SpruceProduct;
let calls: unknown[][];
let status: SpruceStatus;
let products: SpruceProduct[];
let element: Parameters<typeof renderToStaticMarkup>[0];

beforeEach(() => {
  ui.states.clear();
  calls = [];
  status = { configured: false, version: 0 };
  products = [PRODUCT];
  vi.stubGlobal("window", { confirm: () => true });
  const backend = {
    spruceStatus: async () => status,
    spruceLink: async (input: unknown) => void calls.push(["link", input]),
    spruceRefresh: async (p: string) => void calls.push(["refresh", p]),
    spruceDisconnect: async (...args: unknown[]) =>
      void calls.push(["disconnect", ...args]),
    spruceSearch: async (...args: unknown[]) => {
      calls.push(["search", ...args]);
      return products;
    },
    spruceOrders: async () => ({
      fetchedAt: CATALOG_AT,
      order: "A-77",
      rows: [
        { ORN: "A-77", PONO: "PO-1", STATUS: "I", INVOICE: "INV-9" },
        { ORN: "A-78", STATUS: "D", PARTS: "05-1", DESCS: "Filter" },
        { ORN: "A-79", STATUS: "S", QOS: "2", QSS: "1", QBOS: "1" },
        { ORN: "A-80", DATESHIP: "2026-10-02", CARRIER: "UPS" },
      ],
    }),
    spruceSync: async (...args: unknown[]) =>
      void calls.push(["sync", ...args]),
  };
  ui.workspace = {
    snapshot: demoSnapshot(),
    backend,
    online: true,
    connected: true,
    demo: false,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render() {
  ui.buttons = [];
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

// Renders, runs the first render's effects (the load) and renders again.
async function mount(next: typeof element) {
  element = next;
  render();
  for (const effect of ui.effects) effect();
  await settle();
  return render();
}

function button(text: string) {
  const found = ui.buttons.find((b) => b.text === text);
  if (!found) throw Error(`No button "${text}"`);
  return found.props;
}

async function click(text: string) {
  await (button(text).onClick as () => unknown)();
  await settle();
  return render();
}

function type(label: string, value: string) {
  ui.fields
    .get(label)!
    .onChange({ target: { value, checked: value === "on" } });
  return render();
}

async function submit(label: string) {
  await (ui.forms.get(label)!.onSubmit as (d: FormData) => unknown)(
    new FormData(),
  );
  return render();
}

const backend = () => ui.workspace.backend as Record<string, unknown>;

describe("AircraftSpruceAccount", () => {
  it("is for program administrators", async () => {
    const s = demoSnapshot();
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    ui.workspace.snapshot = s;
    expect(await mount(h(AircraftSpruceAccount))).toBe("");
  });

  it("describes the link and its catalog", async () => {
    const html = await mount(h(AircraftSpruceAccount));
    expect(html).toContain("<p>No account linked.</p>");
    expect(button("Link Aircraft Spruce account").disabled).toBe(false);
    status = { configured: true, version: 3, currency: "CAD" };
    expect(await mount(h(AircraftSpruceAccount))).toContain(
      "Catalog not downloaded yet.",
    );
    status = { ...status, catalogAt: CATALOG_AT, catalogCount: 12345 };
    const linked = await mount(h(AircraftSpruceAccount));
    expect(linked).toContain("Account linked · catalog currency CAD");
    expect(linked).toContain(
      `12,345 products · refreshed ${new Date(CATALOG_AT).toLocaleString()}`,
    );
    expect(linked).not.toContain("Catalog not downloaded");
    expect(button("Replace Aircraft Spruce account").disabled).toBe(false);
  });

  it("waits for the status, and a connection outside the demo", async () => {
    element = h(AircraftSpruceAccount);
    render();
    expect(button("Link Aircraft Spruce account").disabled).toBe(true);
    ui.workspace.demo = true;
    expect(await mount(h(AircraftSpruceAccount))).toContain(
      "Not available in the demo: keys and accounts are saved only on a live deployment.",
    );
    expect(button("Link Aircraft Spruce account").disabled).toBe(true);
  });

  it("says when the status does not load", async () => {
    backend().spruceStatus = async () => {
      throw Error("[CONVEX Q(aircraftSpruce:status)] Server Error");
    };
    expect(await mount(h(AircraftSpruceAccount))).toContain(
      '<p role="status">Could not load Aircraft Spruce connection.</p>',
    );
    backend().spruceStatus = async () => {
      throw new ConvexError("Flight Program access denied.");
    };
    expect(await mount(h(AircraftSpruceAccount))).toContain(
      '<p role="status">Flight Program access denied.</p>',
    );
  });

  it("links an account with the confirmed currency", async () => {
    status = { configured: true, version: 3, currency: "CAD" };
    await mount(h(AircraftSpruceAccount));
    await click("Replace Aircraft Spruce account");
    expect(ui.fields.get("Confirmed account catalog currency")!.value).toBe(
      "CAD",
    );
    type("Aircraft Spruce user ID", "pilot");
    type("Aircraft Spruce password", " secret ");
    type("Aircraft Spruce API key", "key");
    type("Confirmed account catalog currency", "USD");
    status = { configured: true, version: 4, currency: "USD" };
    const html = await submit("Validate and link account");
    expect(calls).toEqual([
      [
        "link",
        {
          programUuid: PROGRAM,
          version: 3,
          userid: "pilot",
          password: " secret ",
          apikey: "key",
          currency: "USD",
        },
      ],
    ]);
    expect(html).toContain(
      "Account linked. Refresh the catalog to search products.",
    );
    expect(html).toContain("catalog currency USD");
    await click("Replace Aircraft Spruce account");
    expect(ui.fields.get("Aircraft Spruce user ID")!.value).toBe("");
  });

  it("clears typed credentials when the form closes", async () => {
    await mount(h(AircraftSpruceAccount));
    await click("Link Aircraft Spruce account");
    type("Aircraft Spruce password", "secret");
    (ui.forms.get("Validate and link account")!.onClose as () => void)();
    render();
    await click("Link Aircraft Spruce account");
    expect(ui.fields.get("Aircraft Spruce password")!.value).toBe("");
  });

  it("refreshes the catalog and disconnects after a confirm", async () => {
    status = { configured: true, version: 3, currency: "USD" };
    await mount(h(AircraftSpruceAccount));
    expect(await click("Refresh Aircraft Spruce catalog")).toContain(
      '<p role="status">Catalog refreshed.</p>',
    );
    vi.stubGlobal("window", { confirm: () => false });
    await click("Disconnect account");
    expect(calls).toEqual([["refresh", PROGRAM]]);
    vi.stubGlobal("window", { confirm: () => true });
    expect(await click("Disconnect account")).toContain(
      "Account disconnected.",
    );
    expect(calls[1]).toEqual(["disconnect", PROGRAM, 3]);
    backend().spruceRefresh = async () => {
      throw Error("Catalog download failed.");
    };
    expect(await click("Refresh Aircraft Spruce catalog")).toContain(
      '<p role="status">Catalog download failed.</p>',
    );
  });
});

describe("SpruceProductPicker", () => {
  let chosen: unknown[][];
  const picker = (currency = "USD") =>
    h(SpruceProductPicker, {
      initialSearch: "f",
      currency,
      onSelect: (...args: unknown[]) => chosen.push(args),
    });

  beforeEach(() => {
    chosen = [];
  });

  it("is for program administrators outside the demo", async () => {
    ui.workspace.demo = true;
    expect(await mount(picker())).toBe("");
  });

  it("searches with at least two characters", async () => {
    await mount(picker());
    await click("Find at Aircraft Spruce");
    expect(button("Search supplier catalog").disabled).toBe(true);
    type("Aircraft Spruce part number or description", " filter ");
    expect(button("Search supplier catalog").disabled).toBe(false);
    const html = await click("Search supplier catalog");
    expect(calls).toEqual([["search", PROGRAM, " filter "]]);
    expect(html).toContain("Showing up to 30 matches.");
    expect(html).toContain("05-01234 · Oil filter");
    expect(html).toContain(" · USD 12.50 / EA");
    products = [];
    expect(await click("Search supplier catalog")).toContain(
      '<p role="status">No matching products.</p>',
    );
    backend().spruceSearch = async () => {
      throw Error("[CONVEX A(aircraftSpruce:search)] Server Error");
    };
    expect(await click("Search supplier catalog")).toContain(
      "Search failed. Try again or check the connection under Vendors.",
    );
  });

  it("uses a verified part, with its price only in the same currency", async () => {
    await mount(picker("CAD"));
    await click("Find at Aircraft Spruce");
    type("Aircraft Spruce part number or description", "filter");
    await click("Search supplier catalog");
    const html = await click("05-01234 · Oil filter");
    expect(html).toContain("GA: 3 · CA: unknown (due 2026-12-01)");
    expect(html).toContain('href="https://www.aircraftspruce.com/catalog');
    expect(html).toContain("Currency differs from this document.");
    expect(button("Use selected supplier part").disabled).toBe(true);
    expect(await click("Search supplier catalog")).not.toContain(
      "Use selected supplier part",
    );
    await click("05-01234 · Oil filter");
    type(
      "I verified the part match and that one supplier unit equals one inventory / order unit",
      "on",
    );
    const closed = await click("Use selected supplier part");
    expect(chosen).toEqual([[PRODUCT, undefined]]);
    expect(closed).not.toContain("Search supplier catalog");
    await mount(picker("USD"));
    await click("Find at Aircraft Spruce");
    type("Aircraft Spruce part number or description", "filter");
    await click("Search supplier catalog");
    await click("05-01234 · Oil filter");
    type(
      "I verified the part match and that one supplier unit equals one inventory / order unit",
      "on",
    );
    await click("Use selected supplier part");
    expect(chosen[1]).toEqual([PRODUCT, 1250]);
  });
});

describe("SpruceOrderProgress", () => {
  it("shows the synced lines and syncs again", async () => {
    const html = await mount(h(SpruceOrderProgress, { poUuid: "po-1" }));
    expect(
      ui.fields.get("Aircraft Spruce order number (optional manual link)")!
        .value,
    ).toBe("A-77");
    expect(html).toContain("<td>A-77 / PO-1</td><td>Invoiced / INV-9</td>");
    expect(html).toContain("<td>Cancelled / —</td><td>05-1<br/>Filter</td>");
    expect(html).toContain(
      "<td>S / —</td><td><br/></td><td>2</td><td>1</td><td>1</td>",
    );
    expect(html).toContain("<td>Unknown / —</td>");
    expect(html).toContain("<td>2026-10-02 UPS<br/>—</td>");
    type("Aircraft Spruce order number (optional manual link)", "B-1");
    await submit("Sync Aircraft Spruce order");
    expect(calls).toEqual([["sync", PROGRAM, "po-1", "B-1"]]);
  });

  it("says when progress does not load, and is hidden in the demo", async () => {
    backend().spruceOrders = async () => {
      throw Error("[CONVEX Q(aircraftSpruce:orders)] Server Error");
    };
    expect(await mount(h(SpruceOrderProgress, { poUuid: "po-1" }))).toContain(
      '<p role="alert">Could not load supplier progress.</p>',
    );
    backend().spruceOrders = async () => {
      throw new ConvexError("PO not found.");
    };
    expect(await mount(h(SpruceOrderProgress, { poUuid: "po-2" }))).toContain(
      '<p role="alert">PO not found.</p>',
    );
    ui.workspace.demo = true;
    expect(render()).toBe("");
  });
});

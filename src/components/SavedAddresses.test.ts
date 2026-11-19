/**
 * Responsibility: Pins what the saved-address picker offers and fills in,
 *   when it saves an address first, how the directory searches, and that both
 *   clear a load error once a reload succeeds.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/SavedAddresses.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/addresses.ts.
 *
 * Server rendering keeps no state, runs no effects and calls no handlers, so
 * mocks keep useState values in call order, record the effects of the first
 * render (the load), and capture fields, forms and buttons: a test mounts,
 * acts, and renders again.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { addressSchema, type Address } from "../domain/addresses";
import type {
  AddressChoices,
  SavedAddressInput,
} from "../domain/savedAddresses";
import { SavedAddresses, SavedAddressPicker } from "./SavedAddresses";

type Handlers = { children?: unknown; onClick?: () => unknown };
type Control = { onChange: (event: { target: { value: string } }) => void };

const ui = vi.hoisted(() => ({
  states: [] as unknown[],
  next: 0,
  effects: [] as (() => unknown)[],
  fields: new Map<string, Control>(),
  forms: new Map<string, () => Promise<void>>(),
  buttons: new Map<string, () => unknown>(),
  search: undefined as undefined | ((value: string) => void),
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.next++;
      if (!(slot in ui.states)) ui.states[slot] = initial;
      const set = (update: unknown) => {
        ui.states[slot] =
          typeof update === "function" ? update(ui.states[slot]) : update;
      };
      return [ui.states[slot], set];
    },
    useEffect: (effect: () => unknown) => {
      ui.effects.push(effect);
    },
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, element] = args;
      const props = element as Handlers;
      if (type === "button" && props.onClick)
        ui.buttons.set([props.children].flat().join("").trim(), props.onClick);
      return runtime.jsxDEV(...args);
    },
  };
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
      const submit = props.onSubmit;
      ui.forms.set(props.submitLabel ?? "Save", () => submit(new FormData()));
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("./design", async (importOriginal) => {
  const design = await importOriginal<typeof import("./design")>();
  return {
    ...design,
    SearchField: (props: Parameters<typeof design.SearchField>[0]) => {
      ui.search = props.onChange;
      return design.SearchField(props);
    },
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

const s = demoSnapshot();
const address = (fields: Partial<Address> = {}): Address => ({
  ...addressSchema.parse({
    street: "1600 Pennsylvania Avenue NW",
    city: "Washington",
    region: "DC",
    postalCode: "20500",
    country: "United States",
    contactName: "Receiving",
    email: "receiving@example.com",
    phone: "+1 202 555 0100",
    confirmed: true,
  }),
  ...fields,
});
const HANGAR = {
  uuid: "e1",
  version: 1,
  name: "Main hangar",
  programUuid: "p",
};
const MIAMI = { uuid: "e2", version: 1, name: "Forwarder", programUuid: "p" };
let changed: Address[];
let loaded: AddressChoices;
let sent: [string, SavedAddressInput][];

function choices(): AddressChoices {
  return {
    entries: [
      { ...HANGAR, address: address({ addressName: "Main hangar" }) },
      {
        ...MIAMI,
        address: address({ city: "Miami", contactName: "", confirmed: false }),
      },
    ],
    locations: [
      {
        uuid: "l1",
        name: "Stores",
        address: address({ confirmed: false }),
        legacy: "",
      },
      { uuid: "l2", name: "Shop", legacy: "12 Old Road" },
    ],
  };
}

beforeEach(() => {
  ui.states = [];
  changed = [];
  sent = [];
  loaded = choices();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { body: {} });
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      addressChoices: async () => loaded,
      saveAddress: async (programUuid: string, draft: SavedAddressInput) => {
        sent.push([programUuid, draft]);
        return { ...draft, programUuid, address: { ...draft.address } };
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(element: Parameters<typeof renderToStaticMarkup>[0]) {
  ui.next = 0;
  ui.effects = [];
  ui.fields.clear();
  ui.forms.clear();
  ui.buttons.clear();
  return renderToStaticMarkup(element);
}

// Renders, runs the first render's effects (the load) and renders again.
async function mount(element: Parameters<typeof renderToStaticMarkup>[0]) {
  render(element);
  for (const effect of ui.effects) effect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return render(element);
}

// Sends the event every save sends, then runs the reload it starts.
function reload(element: Parameters<typeof renderToStaticMarkup>[0]) {
  window.dispatchEvent(new Event("saved-addresses-changed"));
  return mount(element);
}

const picker = (props: Partial<Parameters<typeof SavedAddressPicker>[0]>) =>
  h(SavedAddressPicker, {
    label: "Ship to",
    onChange: (next: Address) => changed.push(next),
    ...props,
  });

function choose(label: string, value: string) {
  ui.fields.get(`Ship to — ${label}`)!.onChange({ target: { value } });
}

describe("SavedAddressPicker", () => {
  it("asks for a Flight Program first", () => {
    ui.workspace.snapshot = { ...s, activeProgramUuid: "" };
    expect(render(picker({}))).toBe(
      "<p>Select a Flight Program to choose an address.</p>",
    );
  });

  it("fills the field with a copy of the saved address chosen", async () => {
    const html = await mount(picker({}));
    expect(html).toContain(
      `<option value="e1">Main hangar — Receiving</option>`,
    );
    choose("Saved address", "e1");
    expect(changed).toEqual([loaded.entries[0].address]);
    expect(changed[0]).not.toBe(loaded.entries[0].address);
    choose("Saved address", "");
    expect(changed[1]).toMatchObject({ street: "", confirmed: false });
  });

  it("uses a location's address as confirmed, or opens an incomplete one", async () => {
    const element = picker({ inventoryLocationName: "Stores" });
    await mount(element);
    choose("Use inventory location address?", "inventory");
    expect(changed).toEqual([{ ...address(), addressName: "Stores" }]);
    ui.states = [];
    const shop = picker({ inventoryLocationName: "Shop" });
    await mount(shop);
    choose("Use inventory location address?", "inventory");
    expect(render(shop)).toContain("Add new shipping address");
  });

  it("keeps the document's own address and asks to confirm it", async () => {
    const value = address({ addressName: "Dock 4", confirmed: false });
    const html = await mount(picker({ value }));
    expect(html).toContain(
      '<option value="__current" selected="">Dock 4 (saved on this document)</option>',
    );
    expect(html).toContain("Review and save this address to confirm it");
  });

  it("saves a reviewed address to the program before using it", async () => {
    const value = address({ addressName: "Dock 4", confirmed: false });
    const element = picker({ value });
    await mount(element);
    await ui.buttons.get("Review selected address")!();
    render(element);
    await ui.forms.get("Save address")!();
    expect(sent).toEqual([
      [
        s.activeProgramUuid,
        expect.objectContaining({ name: "Dock 4", version: 0 }),
      ],
    ]);
    expect(changed).toEqual([value]);
  });

  it("refuses an incomplete address before sending it", async () => {
    const element = picker({});
    await mount(element);
    choose("Saved address", "__new");
    render(element);
    await expect(ui.forms.get("Save address")!()).rejects.toThrow(
      "Street address is required. City is required.",
    );
    expect(sent).toEqual([]);
  });
});

describe("SavedAddresses", () => {
  it("searches by name, recipient or city and marks unconfirmed addresses", async () => {
    const html = await mount(h(SavedAddresses));
    expect(html).toContain("Not confirmed");
    expect(html).toContain('<span class="shop-zero">No recipient</span>');
    for (const [search, shown] of [
      ["MIAMI", "Forwarder"],
      ["receiving", "Main hangar"],
    ]) {
      ui.search!(search);
      const filtered = render(h(SavedAddresses));
      expect(filtered).toContain(shown);
      expect(filtered.match(/Edit address/g)).toHaveLength(1);
    }
    ui.search!("nowhere");
    expect(render(h(SavedAddresses))).toContain("No addresses match");
  });

  it("needs a Flight Program, and a connection to edit", async () => {
    ui.workspace.connected = false;
    expect(await mount(h(SavedAddresses))).toContain("No saved addresses yet");
    expect(render(h(SavedAddresses))).toMatch(/disabled="">.*Add new address/);
    ui.workspace.snapshot = { ...s, activeProgramUuid: "" };
    expect(render(h(SavedAddresses))).toContain("No Flight Program selected");
  });
});

describe("for a member who is not an administrator (AC-7)", () => {
  // The server refuses their saves ("Flight Program administrator
  // required."), so neither view offers a new address.
  beforeEach(() => {
    const technicians = {
      id: "technicians",
      name: "Technicians",
      programUuid: s.activeProgramUuid,
      aircraftIds: [],
      permissions: ["read", "discrepancy", "resolve", "maintenance"],
    };
    ui.workspace.snapshot = {
      ...s,
      groups: [...s.groups, technicians],
      user: { ...s.user, isAdmin: false, groupIds: [technicians.id] },
    };
  });

  it("the picker lists the saved addresses without Add new address", async () => {
    const html = await mount(picker({}));
    expect(html).toContain("Main hangar — Receiving");
    expect(html).not.toContain("Add new address");
    expect(html).not.toContain(`value="__new"`);
  });

  it("the directory lists the addresses without Add new address", async () => {
    expect(await mount(h(SavedAddresses))).toContain("Main hangar");
    expect(render(h(SavedAddresses))).not.toContain("Add new address");
    ui.states = [];
    loaded = { entries: [], locations: [] };
    expect(await mount(h(SavedAddresses))).toContain(
      "A Flight Program administrator adds them here or from a request or PO.",
    );
  });
});

describe("for an administrator", () => {
  it("both views offer Add new address", async () => {
    const pickerHtml = await mount(picker({}));
    expect(pickerHtml).toContain(
      `<option value="__new">+ Add new address</option>`,
    );
    expect(pickerHtml).toMatch(/<button[^>]*>Add new address<\/button>/);
    ui.states = [];
    loaded = { entries: [], locations: [] };
    const directory = await mount(h(SavedAddresses));
    expect(directory).toContain("Add new address");
    expect(directory).toContain("Add one here or from a request or PO.");
  });
});

describe("both views", () => {
  it.each([
    ["picker", () => picker({})],
    ["directory", () => h(SavedAddresses)],
  ])(
    "the %s clears a load error after a successful reload",
    async (_, view) => {
      const backend = ui.workspace.backend as { addressChoices: () => unknown };
      const load = backend.addressChoices;
      backend.addressChoices = async () => {
        throw Error("Network down.");
      };
      expect(await mount(view())).toContain("Network down.");
      backend.addressChoices = load;
      const html = await reload(view());
      expect(html).toContain("Main hangar");
      expect(html).not.toContain("Network down.");
    },
  );
});

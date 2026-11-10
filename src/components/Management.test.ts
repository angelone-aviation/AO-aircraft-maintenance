/**
 * Responsibility: Pins the inspections and inventory screens: sorting,
 *   filters and due lines, an aircraft without a meter reading, saving and
 *   completing a schedule, inventory rows and counts, a new item's
 *   attachments, and items opened from a link.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Management.tsx, react-dom/server, convex/values
 *   (ConvexError), src/data/demo.ts (seed), tests/fixtures/dueFleet.ts.
 *
 * Server rendering keeps no state, so the mocks keep each screen's state by
 * component name between renders, and capture click and change handlers by
 * text or label and forms by label. Panels with their own suites render a
 * marker or nothing.
 */
// @vitest-environment node
import {
  createElement as h,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withoutMeterReading } from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import type { Inspection, Snapshot } from "../domain/model";
import type { Location, Stock } from "../domain/management";
import { Inspections, Inventory } from "./Management";

type Props = Record<string, unknown>;
type Handler = (event?: unknown) => unknown;
const ui = vi.hoisted(() => {
  const tracked = new Set(["Inspections", "Inventory"]);
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
    search: {} as { item?: string; program?: string },
    navigate: vi.fn(),
    setState: vi.fn(),
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
      const name = String(
        props["aria-label"] ?? props.label ?? textOf(props.children).trim(),
      );
      const handler = (props.onClick ?? props.onChange) as Handler | undefined;
      if (handler && name)
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
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useSearch: () => ui.search,
  useNavigate: () => ui.navigate,
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(
    (select?: (state: Props) => unknown) =>
      select ? select(ui.workspace) : ui.workspace,
    { getState: () => ui.workspace, setState: ui.setState },
  ),
}));
vi.mock("./PartsRequests", () => ({
  RequestPartsButton: (p: {
    source: { uuid: string };
    initialOpen?: boolean;
  }) => (p.initialOpen ? `[request ${p.source.uuid}]` : null),
}));
vi.mock("./ManagementShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ManagementShared")>()),
  History: () => null,
}));
vi.mock("./InventoryAttachments", () => ({
  InventoryAttachments: (p: { initialFiles: File[] }) =>
    `[retry ${p.initialFiles.map((f) => f.name).join(",")}]`,
  InventoryFilePicker: () => null,
}));
vi.mock("./Manuals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Manuals")>()),
  ManualLink: () => null,
  ManualReferenceFields: () => null,
}));
vi.mock("./AddressFields", () => ({ AddressFields: () => null }));
vi.mock("./PurchaseOrders", () => ({ InspectionPOButton: () => null }));
vi.mock("./InventoryPrinting", () => ({ InventoryPrintButtons: () => null }));
vi.mock("./InventoryScanner", () => ({ ScanButton: () => null }));
vi.mock("./TaskCsvImport", () => ({ TaskCsvImportButton: () => null }));
vi.mock("./TaskCards", () => ({ LinkedTaskCards: () => null }));
vi.mock("./WorkOrders", () => ({ AddToWorkOrder: () => null }));
vi.mock("./Components", () => ({
  ComponentForm: () => null,
  ServiceForm: () => null,
  Components: () => null,
}));

const backend = {
  manage: vi.fn(),
  selectProgram: vi.fn(),
  attachInventoryFile: vi.fn(),
};
let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
  for (const fn of Object.values(backend)) fn.mockReset();
  ui.workspace = { snapshot: s, backend, online: true, connected: true };
  ui.states.clear();
  ui.search = {};
  ui.navigate.mockReset();
  ui.setState.mockReset();
});

function render(element: ReactElement) {
  ui.clicks.clear();
  ui.forms.clear();
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

const inspections = () => render(h(ui.track(Inspections)));
const inventory = () => render(h(ui.track(Inventory)));

function act(screen: () => string, name: string, event?: unknown) {
  screen();
  ui.clicks.get(name)![0](event);
  return screen();
}

function formData(fields: [string, string | Blob][]) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

function inspection(overrides: Partial<Inspection>): Inspection {
  return { ...s.inspections[0], uuid: crypto.randomUUID(), ...overrides };
}

const titles = (html: string) =>
  [...html.matchAll(/class="mx-insp-title">([^<]*)</g)].map((m) => m[1]);

describe("inspections", () => {
  beforeEach(() => {
    const hours = (h: number) => h * 3600;
    s.inspections = [
      inspection({ reference: "Annual", dueSeconds: undefined }),
      inspection({ reference: "Phase 10", dueSeconds: hours(2400) }),
      inspection({ reference: "Phase 2", dueSeconds: hours(2300) }),
      inspection({ reference: "Old", archived: true }),
    ];
  });

  it("sorts by phase number, or by a due limit with missing ones last", () => {
    expect(titles(inspections())).toEqual(["Phase 2", "Phase 10", "Annual"]);
    act(inspections, "Sort inspections by", "hours");
    expect(titles(inspections())).toEqual(["Phase 2", "Phase 10", "Annual"]);
    act(inspections, "Sort order", "descending");
    expect(titles(inspections())).toEqual(["Phase 10", "Phase 2", "Annual"]);
    expect(act(inspections, "Show archived", true)).toContain(">Old<");
  });

  it("labels what remains and leads with the limit past due", () => {
    s.inspections = [
      inspection({
        reference: "Due",
        dueSeconds: 2000 * 3600,
        dueLandings: 99999,
        intervalLandings: 100,
        lastLandings: 99899,
      }),
      inspection({
        reference: "Exempt",
        dueSeconds: undefined,
        calendarExempt: true,
      }),
    ];
    const html = inspections();
    expect(html).toMatch(
      /class="mx-due-left lead mx-tone-danger">[\d.,]+ h overdue/,
    );
    expect(html).toMatch(/class="mx-due-left">\d+ landings remaining/);
    expect(html).toContain("Calendar exempt");
  });

  // Due hours are total time, which differs from the meter by the
  // adjustment (a replaced Hobbs meter).
  it("labels an aircraft schedule's due hours as total time", () => {
    s.inspections = [inspection({ reference: "100-hour", dueSeconds: 1 })];
    const html = inspections();
    expect(html).toContain('<span class="mx-due-basis">Total time</span>');
    expect(html).not.toMatch(/mx-due-basis">(Hobbs|Tach)/);
  });

  it("needs a connection to create a schedule", () => {
    ui.workspace = { ...ui.workspace, connected: false };
    const html = inspections();
    expect(html).toContain("Cached schedules are available.");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*><svg.*?<\/svg>New inspection/,
    );
  });

  it("creates a schedule, then opens its parts request when asked", async () => {
    act(inspections, "New inspection");
    await ui.forms.get("Save inspection")!(
      formData([
        ["aircraft", s.aircraft[0].uuid],
        ["usageMeter", "aircraft"],
        ["description", "Brake check"],
        ["intervalSeconds", "50"],
        ["requiredParts", "[]"],
        ["inspectionIntent", "request"],
      ]),
    );
    const [command] = backend.manage.mock.calls[0];
    expect(command).toMatchObject({
      action: "inspection.save",
      reason: "Inspection created.",
      record: {
        aircraftUuid: s.aircraft[0].uuid,
        description: "Brake check",
        intervalSeconds: 50 * 3600,
        archived: false,
        calendarExempt: false,
      },
    });
    const html = inspections();
    expect(html).not.toContain("New inspection</h2>");
    expect(html).toContain(`[request ${command.record.uuid}]`);
  });

  it("records a completion with its readings", async () => {
    act(inspections, "Complete");
    await ui.forms.get("Record completion")!(
      formData([
        ["date", "2026-10-01"],
        ["seconds", "2400.5"],
        ["cycles", "1900"],
        ["reason", "Done"],
      ]),
    );
    expect(backend.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inspection.complete",
        uuid: s.inspections.find((i) => i.reference === "Phase 2")!.uuid,
        reason: "Done",
        date: "2026-10-01",
        seconds: 2400.5 * 3600,
        cycles: 1900,
      }),
    );
  });
});

describe("inspections on an aircraft without a meter reading", () => {
  beforeEach(() => {
    const a = s.aircraft.find((x) => x.uuid === s.inspections[0].aircraftUuid)!;
    withoutMeterReading(s, a);
    s.inspections = [s.inspections[0]];
  });

  it("lists them as unknown, with their limits and nothing remaining", () => {
    const html = inspections();
    expect(titles(html)).toEqual(["100-hour inspection"]);
    expect(html).toMatch(/class="mx-due-what">Due [\d,.]+ h </);
    expect(html).toContain('<span class="ds-pill ds-tone-neutral">Unknown<');
    expect(html).not.toContain("mx-due-left");
  });

  it("starts completion from blank readings", () => {
    const html = act(inspections, "Complete");
    expect(html).toMatch(/<input [^>]*name="seconds"\/>/);
    expect(html).toMatch(/<input [^>]*name="cycles"\/>/);
  });
});

describe("inventory", () => {
  const location: Location = {
    kind: "location",
    uuid: "loc-1",
    version: 0,
    programUuid: "demo-program",
    name: "Main hangar",
    address: "",
    contact: "",
  };
  const stock = (overrides: Partial<Stock>): Stock => ({
    kind: "stock",
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: "demo-program",
    partNumber: "PN",
    description: "Filter",
    alternates: "",
    category: "part",
    condition: "new",
    locationUuid: "loc-1",
    quantity: 5,
    minimum: 1,
    ...overrides,
  });
  const rows = (html: string) =>
    [...html.matchAll(/class="mx-main-title">([^<]*)</g)].map((m) => m[1]);

  beforeEach(() => {
    s.management = [
      location,
      stock({
        partNumber: "OIL-1",
        cost: 10,
        quantity: 2,
        minimum: 2,
        expirationDate: "2000-01-01",
      }),
      stock({ partNumber: "BOLT-2", cost: 0.5, quantity: 4, vendor: "Acme" }),
    ];
  });

  it("is for Flight Program administrators only", () => {
    s.user = { ...s.user, isAdmin: false };
    expect(inventory()).toContain("Administrator access required");
  });

  it("counts reorder, shelf life and recorded value, and filters rows", () => {
    const html = inventory();
    const counts = [...html.matchAll(/class="ds-stat-value">([^<]*)</g)];
    expect(counts.map((m) => m[1])).toEqual(["2", "1", "1", "$22.00"]);
    expect(rows(html)).toEqual(["OIL-1", "BOLT-2"]);
    act(inventory, "Search inventory", "acme");
    expect(rows(inventory())).toEqual(["BOLT-2"]);
    act(inventory, "Search inventory", "");
    act(inventory, "Shelf life", "soon");
    expect(rows(inventory())).toEqual(["OIL-1"]);
    act(inventory, "Search inventory", "nothing");
    expect(inventory()).toContain("No matching items");
  });

  it("keeps a new item open on the files left when an upload fails", async () => {
    act(inventory, "New stock item");
    const files = [
      new File(["a"], "a.pdf", { type: "application/pdf" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
    ];
    ui.states.get("Inventory")![0] = files;
    inventory();
    backend.attachInventoryFile.mockResolvedValueOnce(undefined);
    backend.attachInventoryFile.mockRejectedValueOnce(
      new Error("Upload failed"),
    );
    await ui.forms.get("Save")!(
      formData([
        ["partNumber", "NEW-1"],
        ["description", "New part"],
        ["category", "part"],
        ["condition", "new"],
        ["location", "loc-1"],
        ["quantity", "3"],
      ]),
    );
    expect(backend.manage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "record.save",
        reason: "Stock item created.",
      }),
    );
    const html = inventory();
    expect(html).toContain("Some attachments could not be uploaded.");
    expect(html).toContain("[retry b.pdf]");
  });

  it("refuses unsupported files before saving a new item", async () => {
    act(inventory, "New stock item");
    ui.states.get("Inventory")![0] = [
      new File(["x"], "x.exe", { type: "application/x-msdownload" }),
    ];
    inventory();
    await expect(ui.forms.get("Save")!(formData([]))).rejects.toThrow();
    expect(backend.manage).not.toHaveBeenCalled();
  });

  it("offers a linked item's program and shows why switching failed", async () => {
    s.programs = [
      ...s.programs!,
      { ...s.programs![0], uuid: "other", name: "Other" },
    ];
    ui.search = { item: "elsewhere", program: "other" };
    const html = inventory();
    expect(html).toContain("This inventory item is not available");
    // errorText reads a ConvexError's data, which error.message did not.
    backend.selectProgram.mockRejectedValue(
      new ConvexError({ message: "No access to Other." }),
    );
    await ui.clicks.get("Open item’s Flight Program")![0]();
    expect(backend.selectProgram).toHaveBeenCalledWith("other");
    expect(ui.setState).toHaveBeenCalledWith({ error: "No access to Other." });
  });

  it("clears the link when a linked item's dialog closes", () => {
    const [, oil] = s.management!;
    ui.search = { item: oil.uuid };
    act(inventory, "Details");
    ui.clicks.get("Close dialog")![0]();
    expect(ui.navigate).toHaveBeenCalledWith({
      to: "/inventory",
      search: { item: undefined, program: undefined },
      replace: true,
    });
  });
});

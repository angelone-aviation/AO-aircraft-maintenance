/**
 * Responsibility: Pins what the record screens' docs promise: flight order,
 *   filters and optional columns, who may correct or resolve, the report
 *   counts, the Sync center's entries and discard, and the history filter.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Records.tsx, src/data/demo.ts, react-dom/server.
 *
 * Child screens and dialogs are stubbed; their own suites and tests/e2e
 * cover them.
 */
// @vitest-environment node
import { createElement as h, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Discrepancy, Flight, Snapshot } from "../domain/model";
import { Discrepancies, Flights, History, SyncCenter } from "./Records";

type Props = Record<string, unknown> & { children?: ReactNode };
type Handler = (...args: unknown[]) => unknown;

const ui = vi.hoisted(() => ({
  workspace: {} as Record<string, unknown>,
  breakpoint: "desktop",
  history: { entries: [] as unknown[], offline: false, isDone: true },
  historyFilter: undefined as unknown,
  states: [] as unknown[],
  slot: 0,
  handlers: new Map<string, Handler>(),
  setState: vi.fn(),
}));

vi.mock("../data/store", () => {
  const useWorkspace = () => ui.workspace;
  useWorkspace.setState = ui.setState;
  return { useWorkspace };
});
vi.mock("../data/auditHistory", () => ({
  useAuditHistory: (filter: unknown) => {
    ui.historyFilter = filter;
    return ui.history;
  },
}));
vi.mock("./design", async (original) => ({
  ...(await original<typeof import("./design")>()),
  useBreakpoint: () => ui.breakpoint,
}));
vi.mock("./FlightForm", () => ({ FlightForm: () => null }));
vi.mock("./FlightSession", () => ({ FlightSessions: () => null }));
vi.mock("./FlightLogImport", () => ({ FlightLogImportButton: () => null }));
vi.mock("./LogbookPhotos", () => ({
  LogbookPhotoStrip: () => null,
  LogbookPhotoPrompt: () => null,
  PendingThumbnail: () => null,
}));
vi.mock("./FlightFluids", () => ({ FlightFluidSummary: () => null }));
vi.mock("./Deferrals", () => ({
  DeferralStatus: () => null,
  DeferDiscrepancyForm: () => null,
}));
vi.mock("./RequiredParts", () => ({ DiscrepancyParts: () => "PARTS" }));
vi.mock("./PartsRequests", () => ({ RequestPartsButton: () => null }));
vi.mock("./TaskCards", () => ({ LinkedTaskCards: () => null }));
vi.mock("./WorkOrders", () => ({ AddToWorkOrder: () => null }));
vi.mock("./ManagementShared", () => ({ HistoryPager: () => null }));
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
      return [ui.states[slot], (next: unknown) => (ui.states[slot] = next)];
    },
  };
});
// Vitest compiles JSX for development, through jsxDEV. Handlers are kept by
// element and label, e.g. "button Correct" or "Switch Include resolved…".
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, ...rest) => {
    keepHandler(type, props as Props);
    return runtime.jsxDEV(type, props, ...rest);
  };
  return { ...runtime, jsxDEV };

  function keepHandler(type: unknown, props: Props) {
    const name = typeof type === "string" ? type : (type as Handler).name;
    const label = props.label ?? props.submitLabel ?? textOf(props.children);
    const handler = props.onClick ?? props.onChange ?? props.onSubmit;
    if (typeof handler === "function")
      ui.handlers.set(`${name} ${String(label).trim()}`, handler as Handler);
  }
  function textOf(node: ReactNode): string {
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement(node)) return textOf((node.props as Props).children);
    return typeof node === "string" || typeof node === "number"
      ? String(node)
      : "";
  }
});

const ADMIN = demoSnapshot();
const [N206, N208] = ADMIN.aircraft;
const REPORTS = [
  report("old", 1),
  report("grounds", 2, { grounding: true }),
  report("deferred", 3, { grounding: true, deferral: {} }),
  report("fixed", 4, { status: "resolved", resolution: "Fixed" }),
];

beforeEach(() => {
  ui.states = [];
  ui.breakpoint = "desktop";
  ui.history = { entries: [], offline: false, isDone: true };
  setWorkspace(ADMIN);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Flights", () => {
  it("lists flights newest first and filters them by status", () => {
    setWorkspace(
      withFlights(flight("a", "2026-10-01"), flight("b", "2026-10-03")),
    );
    const html = render(Flights);
    expect(html.indexOf("2026-10-03")).toBeLessThan(html.indexOf("2026-10-01"));
    handler("Segmented Flight status")("review");
    expect(render(Flights)).toContain("No flights in this view");
  });

  it("links to the Sync center only for the user's flights in this program", () => {
    setWorkspace(ADMIN, {
      queue: [
        queued("q1", "flight"),
        queued("q2", "flight", { authorId: "someone-else" }),
        queued("q3", "flight", { programUuid: "other-program" }),
        queued("q4", "discrepancy"),
      ],
    });
    expect(render(Flights)).toContain("1 flight entry awaiting sync");
  });
});

describe("Flights columns and actions", () => {
  it("shows the optional reading columns only when an aircraft or flight uses them", () => {
    const columns = [
      "Collective hourmeter",
      "Flight time log",
      "cycles",
      "Engine starts",
    ];
    setWorkspace(withFlights(flight("a", "2026-10-01")));
    const plain = render(Flights);
    for (const column of columns) expect(plain).not.toContain(column);
    const engineStarts = [{ engine: "single" as const, durationSeconds: 9 }];
    setWorkspace({
      ...withFlights(
        flight("a", "2026-10-01", { flightTimeLogOn: 2, engineStarts }),
      ),
      aircraft: [{ ...N206, helicopter: true, turbine: true }, N208],
    });
    const used = render(Flights);
    for (const column of columns) expect(used).toContain(column);
  });

  it("lets administrators correct, or review a held flight, only while connected", () => {
    const s = withFlights(
      flight("a", "2026-10-01"),
      flight("b", "2026-10-02", { status: "review" }),
    );
    setWorkspace(s);
    expect(render(Flights)).toMatch(/>Review<.*>Correct</s);
    setWorkspace(s, { connected: false });
    expect(render(Flights)).toMatch(/disabled="">Correct</);
    setWorkspace(asPilot(s));
    expect(render(Flights)).not.toMatch(/>(Review|Correct)</);
  });
});

describe("Discrepancies", () => {
  it("shows open reports newest first, and resolved ones on request", () => {
    setWorkspace({ ...ADMIN, discrepancies: REPORTS });
    const html = render(Discrepancies);
    expect(html.indexOf("Report deferred")).toBeLessThan(
      html.indexOf("Report old"),
    );
    expect(html).not.toContain("Report fixed");
    handler("Switch Include resolved reports")(true);
    expect(render(Discrepancies)).toContain("Report fixed");
  });

  it("counts a deferred report as deferred, not grounding", () => {
    setWorkspace({ ...ADMIN, discrepancies: REPORTS });
    const html = render(Discrepancies);
    expect(html).toContain("3 open");
    expect(html).toContain("1 deferred");
    expect(html).toContain("1 grounding");
  });
});

describe("Discrepancy actions", () => {
  it("offers Defer and Record resolution only with resolve, while connected", () => {
    setWorkspace({ ...ADMIN, discrepancies: [report("open", 1)] });
    expect(render(Discrepancies)).toMatch(/<button[^>]*>.*Defer \(MEL/s);
    setWorkspace(
      { ...ADMIN, discrepancies: [report("open", 1)] },
      {
        online: false,
      },
    );
    expect(render(Discrepancies)).toMatch(/disabled="">.*Record resolution/s);
    setWorkspace(asPilot({ ...ADMIN, discrepancies: [report("open", 1)] }));
    const pilot = render(Discrepancies);
    expect(pilot).not.toContain("Record resolution");
    expect(pilot).not.toContain("PARTS");
  });

  it("queues a report on the device, also offline", async () => {
    setWorkspace(ADMIN, { online: false });
    render(Discrepancies);
    handler("button Report a problem")();
    expect(render(Discrepancies)).toContain("synced when connected");
    const data = new FormData();
    data.set("aircraft", N208.uuid);
    data.set("description", " Oil leak ");
    data.set("grounding", "on");
    await handler("AsyncForm Save report")(data);
    expect(ui.workspace.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "discrepancy",
        authorId: ADMIN.user.id,
        aircraftUuid: N208.uuid,
        description: "Oil leak",
        grounding: true,
      }),
    );
  });
});

describe("SyncCenter", () => {
  it("lists only the user's entries, oldest first, and names another program's", () => {
    setWorkspace(ADMIN, {
      queue: [
        queued("first", "discrepancy", { description: "First" }),
        queued("theirs", "discrepancy", { authorId: "someone-else" }),
        queued("second", "discrepancy", {
          description: "Second",
          programUuid: undefined,
        }),
      ],
    });
    const html = render(SyncCenter);
    expect(html).toContain("2 pending entries");
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html).toContain("Switch to Unassigned records to sync this entry.");
  });

  it("discards a failed entry only when confirmed, and says so if it fails", async () => {
    setWorkspace(ADMIN, {
      queue: [queued("bad", "discrepancy", {}, "Refused")],
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(SyncCenter);
    handler("button Discard entry")();
    expect(ui.workspace.discard).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    handler("button Discard entry")();
    await vi.waitFor(() =>
      expect(ui.setState).toHaveBeenCalledWith({
        error: "Could not discard the entry. Try again.",
      }),
    );
  });
});

describe("History", () => {
  it("loads all history or one aircraft's, and says when it is offline", () => {
    render(History);
    expect(ui.historyFilter).toEqual({ aircraftUuid: undefined });
    handler("select")({ target: { value: N206.uuid } });
    ui.history = { entries: [], offline: true, isDone: true };
    expect(render(History)).toContain("Reconnect to load the full history.");
    expect(ui.historyFilter).toEqual({ aircraftUuid: N206.uuid });
  });
});

// The first kept handler whose element and label start with these words.
function handler(start: string) {
  const found = [...ui.handlers].find(([key]) => key.startsWith(start));
  if (!found) throw new Error(`No handler for ${start}`);
  return found[1];
}

function render(screen: () => ReactNode) {
  ui.slot = 0;
  ui.handlers.clear();
  return renderToStaticMarkup(h(screen));
}

function setWorkspace(snapshot: Snapshot, over: Record<string, unknown> = {}) {
  ui.workspace = {
    snapshot,
    queue: [],
    pendingPhotos: [],
    online: true,
    connected: true,
    syncing: false,
    enqueue: vi.fn(async () => {}),
    discard: vi.fn(async () => Promise.reject(new Error("IndexedDB"))),
    flush: vi.fn(),
    backend: { resolve: vi.fn() },
    ...over,
  };
}

function withFlights(...flights: Flight[]): Snapshot {
  return { ...ADMIN, flights };
}

// A pilot: the demo's Pilots group, without administration or resolve.
function asPilot(s: Snapshot): Snapshot {
  return {
    ...s,
    user: { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] },
  };
}

function flight(uuid: string, day: string, over: Partial<Flight> = {}) {
  return {
    uuid,
    aircraftUuid: N206.uuid,
    authorId: ADMIN.user.id,
    pilotId: ADMIN.user.id,
    submittedAt: 0,
    startTime: `${day}T10:00:00.000Z`,
    status: "accepted",
    origin: day,
    destination: "",
    landings: 1,
    ...over,
  } as Flight;
}

function report(uuid: string, createdAt: number, over: object = {}) {
  return {
    uuid,
    aircraftUuid: N206.uuid,
    description: `Report ${uuid}`,
    status: "open",
    authorId: ADMIN.user.id,
    createdAt,
    ...over,
  } as Discrepancy;
}

function queued(
  uuid: string,
  kind: "flight" | "discrepancy",
  over: object = {},
  error?: string,
) {
  const input = {
    aircraftUuid: N206.uuid,
    origin: "",
    destination: "",
    startTime: "2026-10-01T10:00:00.000Z",
  };
  return {
    queuedAt: 0,
    error,
    operation: {
      uuid,
      kind,
      input,
      aircraftUuid: N206.uuid,
      description: uuid,
      authorId: ADMIN.user.id,
      programUuid: ADMIN.activeProgramUuid,
      ...over,
    },
  };
}

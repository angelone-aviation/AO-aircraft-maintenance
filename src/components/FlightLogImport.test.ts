/**
 * Responsibility: Pins who sees the Import logbook button, which files it
 *   refuses, which rows a preview selects, and what importing queues.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightLogImport.tsx, react-dom/server,
 *   src/data/demo.ts (seed), tests/fixtures/foreflight-logbook.csv.
 *
 * Server rendering keeps no state between renders, so a react mock keeps
 * useState values in call order: a test can open the dialog, submit a form
 * and render again.
 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Operation, Permission, Snapshot } from "../domain/model";
import { FlightLogImportButton } from "./FlightLogImport";

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  next: 0,
  forms: new Map<string, (data: FormData) => Promise<void>>(),
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = hooks.next++;
      if (!(slot in hooks.states))
        hooks.states[slot] =
          typeof initial === "function" ? initial() : initial;
      const set = (update: unknown) => {
        hooks.states[slot] =
          typeof update === "function" ? update(hooks.states[slot]) : update;
      };
      return [hooks.states[slot], set];
    },
  };
});
vi.mock("./ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("./ui")>();
  return {
    ...ui,
    AsyncForm: (props: Parameters<typeof ui.AsyncForm>[0]) => {
      hooks.forms.set(props.submitLabel ?? "Save", props.onSubmit);
      return ui.AsyncForm(props);
    },
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => hooks.workspace, {
    getState: () => hooks.workspace,
  }),
}));

const LOGBOOK = readFileSync("tests/fixtures/foreflight-logbook.csv", "utf8");
let s: Snapshot;
let queued: Operation[];

beforeEach(() => {
  s = demoSnapshot();
  queued = [];
  hooks.states = [];
  hooks.workspace = {
    snapshot: s,
    queue: [],
    enqueue: async (operation: Operation) => {
      queued.push(operation);
    },
  };
});

function render() {
  hooks.next = 0;
  hooks.forms.clear();
  return renderToStaticMarkup(h(FlightLogImportButton));
}

// Opens the dialog and previews `contents` as the chosen logbook file.
async function preview(contents: string) {
  // The button's first state is whether its dialog is open.
  hooks.states[0] = true;
  render();
  const data = new FormData();
  data.set("logbook", new File([contents], "logbook.csv"));
  data.set("operation", "Mission");
  data.set("rules", "IFR");
  await hooks.forms.get("Preview flights")!(data);
  return render();
}

describe("FlightLogImportButton", () => {
  it("shows only to users who may log a flight on some aircraft", () => {
    expect(render()).toContain("Import logbook</button>");
    const permissions: Permission[] = ["read", "maintenance"];
    const group = { ...s.groups[0], programAdmin: false, permissions };
    const user = { ...s.user, isAdmin: false, groupIds: [group.id] };
    hooks.workspace.snapshot = { ...s, user, groups: [group] };
    expect(render()).toBe("");
  });

  it("refuses an empty file or one over 5 MiB", async () => {
    const tooLarge = "x".repeat(5 * 1024 * 1024 + 1);
    for (const contents of ["", tooLarge])
      await expect(preview(contents)).rejects.toThrow(
        "Choose a logbook CSV up to 5 MiB.",
      );
  });

  it("selects the rows without an error or a possible duplicate", async () => {
    const lines = LOGBOOK.trimEnd().split("\n");
    const html = await preview([...lines, lines[12]].join("\n"));
    expect(html).toContain('aria-label="Import row 13" checked=""/>');
    expect(html).toContain(
      '<span class="ds-pill ds-tone-good"><span class="ds-pill-dot" aria-hidden="true"></span>Ready</span>',
    );
    expect(html).toContain('aria-label="Import row 15" disabled=""/>');
    expect(html).toContain('aria-label="Import row 19"/>');
    expect(html).toContain("Possible duplicate");
  });

  it("checks a row older than the workspace's flights against the server's", async () => {
    const lines = LOGBOOK.trimEnd().split("\n").slice(0, 11);
    const older = [
      ...lines,
      "2020-03-02,N206MA,KPAO,KSQL,,14:30,14:38,15:35,15:42,1.2,1.2,0,1,1,0,0,1,100.0,101.2,,,Old leg",
    ].join("\n");
    const flightsInRange = vi.fn(async () => ({
      flights: [loggedFlight("2020-03-02", 1.2)],
      members: [],
    }));
    hooks.workspace = {
      ...hooks.workspace,
      backend: { flightsInRange },
      online: true,
      connected: true,
    };
    const html = await preview(older);
    expect(flightsInRange).toHaveBeenCalledExactlyOnceWith({
      aircraftUuid: "demo-206",
      from: new Date(2020, 2, 2).getTime(),
      to: new Date(2020, 2, 3).getTime(),
    });
    expect(html).toContain("1 possible duplicates");
    hooks.workspace = { ...hooks.workspace, online: false };
    const offline = await preview(older);
    expect(offline).toContain("0 possible duplicates");
    expect(offline).toContain(
      "Offline, older rows were checked for duplicates against the flights on this device only.",
    );
  });

  it("queues each selected row as the user's flight and lists failures", async () => {
    hooks.workspace.enqueue = async (operation: Operation) => {
      if (queued.length) throw new Error("Queue full.");
      queued.push(operation);
    };
    const html = await preview(LOGBOOK);
    const label = html.match(/Import \d+ selected flights?/)![0];
    await hooks.forms.get(label)!(new FormData());
    expect(queued).toMatchObject([
      { kind: "flight", authorId: s.user.id, input: { operation: "Mission" } },
    ]);
    const after = render();
    expect(after).toContain("1 flight saved on this device");
    expect(after).toMatch(/Row \d+: Queue full\./);
  });
});

// A flight already logged on N206MA from KPAO to KSQL at local noon.
function loggedFlight(date: string, hobbsHours: number) {
  const [year, month, day] = date.split("-").map(Number);
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: "demo-206",
    authorId: s.user.id,
    pilotId: s.user.id,
    submittedAt: 0,
    status: "accepted" as const,
    startTime: new Date(year, month - 1, day, 12).toISOString(),
    hobbsOff: 0,
    hobbsOn: hobbsHours * 3600,
    landings: 1,
    cycles: 0,
    origin: "KPAO",
    destination: "KSQL",
    operation: "Mission" as const,
    flightRules: "VFR" as const,
    remarks: "",
    discrepancy: "",
  };
}

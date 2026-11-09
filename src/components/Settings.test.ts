/**
 * Responsibility: Pins the Settings page: which sections each role sees, the
 *   section links, account facts and alert email, pending entries, program
 *   details, labor rate, CSV exports and off-site backup status.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Settings.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/model.ts (types).
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
import type { Snapshot } from "../domain/model";
import { Settings } from "./Settings";

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
      // Switches register under their name; section links have no label of
      // their own.
      if (control.role === "switch")
        ui.fields.set(String(control.name ?? "switch"), control);
      if (type === "a" && typeof control.onClick === "function")
        ui.fields.set(String(control.href), control);
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
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: Props) =>
      createElement(
        "a",
        { "data-to": props.to, className: props.className },
        props.children as never,
      ),
    useNavigate: () => (options: unknown) => calls.push(["navigate", options]),
    useRouterState: ({ select }: { select: (r: object) => unknown }) =>
      select({ location: { hash: ui.workspace.hash } }),
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(
    (select?: (state: Props) => unknown) =>
      select ? select(ui.workspace) : ui.workspace,
    { getState: () => ui.workspace },
  ),
}));
vi.mock("./UserProfile", () => ({
  MyCertifications: stub("MyCertifications"),
}));
vi.mock("./SignInMethods", () => ({
  SignInMethodList: stub("SignInMethodList"),
}));
vi.mock("./Fleet", () => ({ ProgramDialog: stub("ProgramDialog") }));
vi.mock("./AircraftSpruce", () => ({
  AircraftSpruceAccount: stub("AircraftSpruceAccount"),
}));
vi.mock("./ProgramUsers", () => ({ CsvExportCard: stub("CsvExportCard") }));
vi.mock("./FaaKeySettings", () => ({ FaaKeySettings: stub("FaaKeySettings") }));
vi.mock("./AddressVerificationSettings", () => ({
  AddressVerificationSettings: stub("AddressVerificationSettings"),
}));
vi.mock("./DemoBackup", () => ({ DemoBackup: stub("DemoBackup") }));

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
let alertEmails: () => Promise<unknown>;
let latestCopy: () => Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ui.states.clear();
  ui.stubs.clear();
  calls = [];
  s = demoSnapshot();
  alertEmails = async () => undefined;
  latestCopy = async () => ({ completedAt: NOW - 3_600_000, bytes: 3 << 20 });
  ui.workspace = {
    snapshot: s,
    hash: "",
    queue: [],
    online: true,
    connected: true,
    demo: false,
    backend: {
      setAlertEmails: (next: boolean) => {
        calls.push(["setAlertEmails", next]);
        return alertEmails();
      },
      setUrgentAlertEmails: (next: boolean) => {
        calls.push(["setUrgentAlertEmails", next]);
        return alertEmails();
      },
      costs: async (command: unknown) => void calls.push(["costs", command]),
      latestOffsiteCopy: () => latestCopy(),
    },
  };
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({
      scrollIntoView: () => calls.push(["scroll", id]),
    }),
    createElement: () => ({
      click(this: { download: string; href: string }) {
        calls.push(["download", this.download, blobs.get(this.href)?.type]);
      },
    }),
  });
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      blobs.set("blob:1", blob);
      return "blob:1";
    },
    revokeObjectURL: () => undefined,
  });
});

const blobs = new Map<string, Blob>();

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

async function runEffects() {
  for (const effect of ui.effects) effect();
  await settle();
  return render();
}

function sections(html: string) {
  return [...html.matchAll(/<h2 id="[a-z]+-title">([^<]*)/g)].map((m) => m[1]);
}

function asMember(changes: Partial<Snapshot["user"]>) {
  s.user = { ...s.user, isAdmin: false, ...changes };
}

describe("settings", () => {
  it("shows each section only to those who may use it", () => {
    expect(sections(render(h(Settings)))).toEqual([
      "My account",
      "This device",
      "Flight Program",
      "System",
    ]);
    asMember({ groupIds: ["demo-pilots"] });
    expect(sections(render())).toEqual(["My account", "This device"]);
    s.groups = s.groups.map((g) => ({ ...g, programAdmin: true }));
    expect(sections(render())).toEqual([
      "My account",
      "This device",
      "Flight Program",
    ]);
  });

  it("jumps to a section unless a modifier asks for a new tab", async () => {
    ui.workspace.hash = "program";
    const html = render(h(Settings));
    expect(html).toContain('href="#program" aria-current="location"');
    await runEffects();
    expect(calls).toEqual([["scroll", "program"]]);
    const follow = (event: object) =>
      (ui.fields.get("#device")!.onClick as (e: object) => void)({
        button: 0,
        preventDefault: () => calls.push(["prevented"]),
        ...event,
      });
    follow({ metaKey: true });
    follow({ button: 1 });
    follow({});
    expect(calls.slice(1)).toEqual([
      ["prevented"],
      [
        "navigate",
        { to: "/settings", hash: "device", hashScrollIntoView: false },
      ],
      ["scroll", "device"],
    ]);
  });

  it("describes the user's role, groups and certifications", () => {
    asMember({
      groupIds: ["demo-pilots"],
      certifications: [
        {
          kind: "mechanic",
          number: "123",
          airframe: true,
          powerplant: true,
          ia: true,
          renewalDate: "2027-03-31",
        },
        { kind: "medical", number: "", expiresOn: "2027-01-01" },
      ],
    } as Partial<Snapshot["user"]>);
    const html = render(h(Settings));
    expect(html).toContain("<dd>Pilot<small>");
    expect(html).toContain(
      "No. 123 · Airframe, Powerplant, IA · IA renewal 2027-03-31",
    );
    expect(html).toContain("Number not recorded · Expires 2027-01-01");
    s.user = {
      ...s.user,
      certifications: [
        {
          kind: "mechanic",
          number: "9",
          airframe: true,
          ia: false,
          renewalDate: "2027-03-31",
        },
      ],
    } as Snapshot["user"];
    expect(render()).toContain("<small>No. 9 · Airframe</small>");
    s.user = {
      ...s.user,
      certifications: [],
      licenseNumber: "456",
      certificateType: "Commercial",
    };
    expect(render()).toContain("Existing profile license: Commercial 456");
  });

  it("keeps the alert email choice until it is saved, and undoes a failure", async () => {
    render(h(Settings));
    const toggle = () => ui.fields.get("emailAlerts")!;
    expect(toggle().checked).toBe(false);
    alertEmails = async () => {
      throw Error("Refused");
    };
    await (toggle().onChange as (e: object) => Promise<void>)({
      target: { checked: true },
    });
    expect(render()).toContain('<p role="alert" class="error">Refused</p>');
    expect(toggle().checked).toBe(false);
    let finish = () => {};
    alertEmails = () => new Promise<void>((resolve) => (finish = resolve));
    void (toggle().onChange as (e: object) => void)({
      target: { checked: true },
    });
    render();
    expect(toggle()).toMatchObject({ checked: true, disabled: true });
    finish();
    await settle();
    expect(render()).not.toContain('role="alert"');
    expect(toggle()).toMatchObject({ checked: true, disabled: false });
    alertEmails = async () => {
      throw Error("Offline");
    };
    await (toggle().onChange as (e: object) => Promise<void>)({
      target: { checked: false },
    });
    expect(render()).toContain('<p role="alert" class="error">Offline</p>');
    expect(toggle().checked).toBe(false);
    ui.workspace.online = false;
    expect(render()).toContain("Reconnect to change alert");
  });

  it("saves the urgent alert email choice on its own switch", async () => {
    render(h(Settings));
    const urgent = () => ui.fields.get("urgentAlertEmails")!;
    // A system administrator in no group gets neither email by default.
    expect(urgent().checked).toBe(false);
    await (urgent().onChange as (e: object) => Promise<void>)({
      target: { checked: true },
    });
    expect(calls).toEqual([["setUrgentAlertEmails", true]]);
    expect(render()).not.toContain('role="alert"');
    expect(urgent().checked).toBe(true);
    expect(ui.fields.get("emailAlerts")!.checked).toBe(false);
  });

  it("counts only this user's entries waiting to sync", () => {
    const entry = (authorId: string) => ({ operation: { authorId } });
    ui.workspace.queue = [entry(s.user.id), entry("someone-else")];
    expect(render(h(Settings))).toContain("1 pending entry");
    ui.workspace.queue = [entry(s.user.id), entry(s.user.id)];
    expect(render()).toContain("2 pending entries");
  });

  it("lists program details from the structured address first", () => {
    s.programs = [
      {
        ...s.programs![0],
        website: "javascript:alert(1)",
        addressDetails: {
          organization: "Mission Air",
          street: "1 Ramp Rd",
          street2: "",
          city: "Town",
          region: "CA",
          postalCode: "94000",
          country: "US",
          contactName: "",
          email: "",
          phone: "+1 415 555 0100",
          confirmed: true,
        },
      },
    ];
    const html = render(h(Settings));
    expect(html).toContain(
      '<span class="set-line">Mission Air</span><span class="set-line">1 Ramp Rd</span><span class="set-line">Town, CA, 94000</span><span class="set-line">US</span>',
    );
    expect(html).toContain(
      '<span class="set-line">Demo coordinator</span><span class="set-line">operations@example.test</span><span class="set-line">+1 415 555 0100</span>',
    );
    expect(html).toContain("No website recorded");
    s.programs = [{ ...s.programs[0], addressDetails: undefined }];
    expect(render()).toContain('<span class="set-line">Demo airfield</span>');
  });

  it("exports program records and backups as dated CSV files", () => {
    render(h(Settings));
    const exports = ui.stubList.filter((x) => x.name === "CsvExportCard");
    for (const card of exports)
      (card.props.onDownload as (table: string) => void)("aircraft");
    expect(calls).toEqual([
      ["download", "demo-program-aircraft.csv", "text/csv;charset=utf-8"],
      [
        "download",
        "angel-one-aircraft-2026-11-04.csv",
        "text/csv;charset=utf-8",
      ],
    ]);
  });

  it("saves the labor rate in cents and shows the current one", async () => {
    expect(render(h(Settings))).toContain("No default rate set.");
    const data = new FormData();
    data.set("rate", "85.5");
    await (
      ui.forms.get("Save rate")!.onSubmit as (d: FormData) => Promise<void>
    )(data);
    expect(calls).toEqual([
      ["costs", { action: "settings.laborRate", laborRateCents: 8550 }],
    ]);
    s.costs = [
      { kind: "settings", programUuid: "demo-program", laborRateCents: 8550 },
    ] as Snapshot["costs"];
    expect(render()).toContain("Current rate $85.50 per hour.");
    expect(ui.fields.get("Rate per hour (USD)")!.defaultValue).toBe("85.50");
  });

  it("reports the newest off-site backup or why it cannot", async () => {
    expect(render(h(Settings))).toContain("Checking off-site backups…");
    const html = await runEffects();
    expect(html).toContain("Last off-site backup 1 hour ago.");
    expect(html).toContain("<dd>3.0 MB</dd>");
    expect(html).toContain("<dd>None yet</dd>");
    expect(html).toContain("Your alert email is off");
    latestCopy = async () => {
      throw Error("Down");
    };
    ui.states.clear();
    render();
    expect(await runEffects()).toContain(
      "Could not load the off-site backup status.",
    );
    ui.workspace.connected = false;
    ui.states.clear();
    expect(render()).toContain("Reconnect to see the off-site backup status.");
    ui.workspace.demo = true;
    expect(render()).toContain(
      "Off-site backups run only on the production deployment.",
    );
  });
});

/**
 * Responsibility: Pins the Administration screen: who sees it, the users,
 *   groups and aircraft tabs, the windows each action opens, and editing a
 *   reviewed group from another Flight Program.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Admin.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key (dropped once it stops
 * rendering, as on unmount), stub the forms each window holds, and capture
 * buttons: a test renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { PASSWORD_MIN_LENGTH } from "../domain/accountRules";
import type { Group, Snapshot } from "../domain/model";
import { Administration } from "./Admin";

type Frame = { key: string; next: number };
type Props = Record<string, unknown>;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  buttons: [] as { text: string; props: Props }[],
  forms: new Map<string, (data: FormData) => Promise<void>>(),
  stubs: new Map<string, Props>(),
  reviews: [] as [boolean, number][],
  reports: [] as unknown[],
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
      if (type === "button") {
        const p = props as Props;
        const text = (p["aria-label"] as string) ?? textOf(p.children);
        ui.buttons.push({ text: text.trim(), props: p });
      }
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    return "";
  }
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
vi.mock("./GroupAccessReview", () => ({
  useGroupAccessReview: (active: boolean, refresh: number) => {
    ui.reviews.push([active, refresh]);
    return { reports: ui.reports };
  },
  GroupAccessNotice: stub("GroupAccessNotice"),
}));
vi.mock("./PermissionGroupForm", () => ({ GroupForm: stub("GroupForm") }));
vi.mock("./UserProfile", () => ({
  UserProfileForm: stub("UserProfileForm"),
}));
vi.mock("./Fleet", () => ({ AircraftForm: stub("AircraftForm") }));
vi.mock("./ProgramUsers", () => ({
  ProgramUsers: stub("ProgramUsers"),
  MemberAvatar: stub("MemberAvatar"),
}));
vi.mock("./SignInMethods", () => ({
  SignInMethodList: stub("SignInMethodList"),
}));
vi.mock("./DeleteGroupButton", () => ({
  DeleteGroupButton: stub("DeleteGroupButton"),
}));
vi.mock("./design", async (importOriginal) => {
  const design = await importOriginal<typeof import("./design")>();
  return {
    ...design,
    Segmented: (props: Parameters<typeof design.Segmented>[0]) => {
      ui.stubs.set("Segmented", props as never);
      return design.Segmented(props);
    },
  };
});
vi.mock("@tanstack/react-router", () => ({ Link: stub("Link") }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
    setState: (patch: Props) => Object.assign(ui.workspace, patch),
  }),
}));

// A stub renders its name and records its props, so a test can read what the
// screen passed and call its callbacks.
function stub(name: string) {
  return (props: Props) => {
    ui.stubs.set(name, props);
    return `[${name}]`;
  };
}

let s: Snapshot;
let calls: unknown[][];
const PILOTS = "demo-pilots";

beforeEach(() => {
  ui.states.clear();
  ui.stubs.clear();
  ui.reviews = [];
  ui.reports = [];
  calls = [];
  s = demoSnapshot();
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    demo: false,
    backend: {
      resetPassword: async (...args: unknown[]) => {
        calls.push(["reset", ...args]);
      },
      selectProgram: async (programUuid: string) => {
        calls.push(["select", programUuid]);
      },
    },
  };
});

function render() {
  ui.buttons = [];
  ui.forms.clear();
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(h(Administration));
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

function buttons(text: string) {
  return ui.buttons.filter((b) => b.text === text).map((b) => b.props);
}

function click(text: string, index = 0) {
  const found = buttons(text)[index];
  if (!found) throw Error(`No button "${text}"`);
  (found.onClick as () => void)();
  return render();
}

function tab(name: string) {
  render();
  (ui.stubs.get("Segmented")?.onChange as (t: string) => void)?.(name);
  return render();
}

function group(fields: Partial<Group>): Group {
  return {
    id: "g",
    name: "Group",
    programUuid: s.activeProgramUuid,
    aircraftIds: [],
    permissions: [],
    ...fields,
  };
}

describe("access", () => {
  it("shows program users to a program administrator, or refuses", () => {
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    expect(render()).toContain("Administrator access required");
    s.groups.push(
      group({ id: "admins", programAdmin: true, permissions: ["read"] }),
    );
    s.user = { ...s.user, groupIds: ["admins"] };
    expect(render()).toBe("[ProgramUsers]");
    expect(ui.reviews.at(-1)).toEqual([false, 0]);
  });
});

describe("users", () => {
  it("lists each user's groups and status, with demo and offline notices", () => {
    s.members.push({ ...s.members[1], id: "off", name: "Off", active: false });
    const html = render();
    expect(html).toContain("alex@example.test · No Flight Program groups");
    expect(html).toContain('title="jordan@example.test · Pilots"');
    expect(html.match(/>(Administrator|Active|Disabled)</g)).toEqual([
      ">Administrator<",
      ">Active<",
      ">Disabled<",
    ]);
    expect(html).not.toContain("Administration requires a connection.");
    expect(buttons("Reset password")[0].disabled).toBe(false);
    ui.workspace.demo = true;
    expect(render()).toContain("Local demo.");
    expect(buttons("Reset password")[0].disabled).toBe(true);
    expect(buttons("Sign-in methods")[0].disabled).toBe(false);
    ui.workspace.connected = false;
    expect(render()).toContain("Administration requires a connection.");
    for (const name of ["Add user", "Edit access", "Sign-in methods"])
      expect(buttons(name)[0].disabled).toBe(true);
  });

  it("creates a user, or edits one's access", () => {
    render();
    expect(click("Add user")).toContain("Create user");
    expect(ui.stubs.get("UserProfileForm")!.initial).toBeUndefined();
    (ui.stubs.get("UserProfileForm")!.onDone as () => void)();
    expect(render()).not.toContain("Create user");
    expect(click("Edit access", 1)).toContain("Edit user access");
    expect(ui.stubs.get("UserProfileForm")!.initial).toBe(s.members[1]);
  });

  it("resets a password, then closes", async () => {
    render();
    const html = click("Reset password", 1);
    expect(html).toContain("Reset password · Jordan Lee");
    expect(html).toContain(`At least ${PASSWORD_MIN_LENGTH} characters.`);
    const data = new FormData();
    data.set("password", "correct horse battery staple");
    await ui.forms.get("Reset password")!(data);
    expect(calls).toEqual([
      ["reset", "demo-pilot", "correct horse battery staple"],
    ]);
    expect(render()).not.toContain("Reset password · Jordan Lee");
  });

  it("shows a user's sign-in methods", () => {
    render();
    const html = click("Sign-in methods", 1);
    expect(html).toContain("Sign-in methods · Jordan Lee");
    expect(html).toContain("verified email is jordan@example.test.");
    expect(ui.stubs.get("SignInMethodList")!.member).toBe(s.members[1]);
  });
});

describe("permission groups", () => {
  it("describes each group's permissions, program and aircraft", () => {
    s.groups = [
      group({ id: "a", programAdmin: true, permissions: ["read"] }),
      group({ id: "o", owner: true }),
      group({ id: "o1", owner: true, aircraftIds: ["demo-206"] }),
      group({ id: "x", programUuid: "other" }),
      s.groups[0],
    ];
    s.programs = [
      ...s.programs!,
      { ...s.programs![0], uuid: "other", name: "Other" },
    ];
    const html = tab("groups");
    expect(html).toContain(
      "read · Mission operations · Flight Program administrator",
    );
    expect(html).toContain(
      "No permissions · Mission operations · Aircraft owner · No aircraft assigned",
    );
    expect(html).toContain("No permissions · Mission operations · 1 aircraft");
    expect(html).not.toContain("Other");
    expect(html).toMatch(/read, flight, discrepancy · Mission operations · /);
    expect(ui.reviews.at(-1)).toEqual([true, 0]);
    s.groups[4] = { ...s.groups[4], programUuid: "nowhere" };
    expect(tab("groups")).not.toContain("Pilots");
  });

  it("offers an empty state, and a new group", () => {
    s.groups = [];
    expect(tab("groups")).toContain("No permission groups");
    expect(click("Add group")).toContain("Create permission group");
    expect(ui.stubs.get("GroupForm")).toMatchObject({
      initial: undefined,
      review: undefined,
    });
  });

  it("edits a group with its review, then checks access again", () => {
    const review = { groupId: PILOTS, programUuid: s.activeProgramUuid };
    ui.reports = [{ groupId: "other" }, review];
    tab("groups");
    expect(click("Edit group")).toContain("Edit permission group");
    expect(ui.stubs.get("GroupForm")).toMatchObject({
      initial: s.groups[0],
      review,
    });
    (ui.stubs.get("GroupForm")!.onDone as () => void)();
    expect(render()).not.toContain("Edit permission group");
    expect(ui.reviews.at(-1)).toEqual([true, 1]);
    ui.workspace.online = false;
    render();
    expect(ui.reviews.at(-1)).toEqual([false, 1]);
  });

  it("switches program before editing a reviewed group elsewhere", async () => {
    tab("groups");
    const onEdit = ui.stubs.get("GroupAccessNotice")!.onEdit as (
      r: object,
    ) => void;
    onEdit({ groupId: PILOTS, programUuid: "elsewhere" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["select", "elsewhere"]]);
    expect(render()).toContain("Edit permission group");
  });

  it("shows a failed switch as the workspace error", async () => {
    const backend = ui.workspace.backend as Props;
    backend.selectProgram = async () => {
      throw "offline";
    };
    tab("groups");
    const onEdit = ui.stubs.get("GroupAccessNotice")!.onEdit as (
      r: object,
    ) => void;
    onEdit({ groupId: PILOTS, programUuid: "elsewhere" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.workspace.error).toBe("Unable to switch Flight Program.");
    onEdit({ groupId: "gone", programUuid: s.activeProgramUuid });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render()).not.toContain("Edit permission group");
  });
});

describe("aircraft", () => {
  it("lists aircraft and their meter, or asks for the first", () => {
    const html = tab("aircraft");
    expect(html).toContain("Cessna 206 Stationair · DEMO-demo-206");
    expect(html.match(/Hobbs tracking/g)).toHaveLength(3);
    expect(click("Add aircraft")).toMatch(/<h2 id="[^"]+">Add aircraft</);
    expect(ui.stubs.get("AircraftForm")).toBeDefined();
    s.aircraft = [];
    expect(tab("aircraft")).toContain("Add your first aircraft");
  });
});

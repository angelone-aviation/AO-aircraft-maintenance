/**
 * Responsibility: Pins the Flight Program administration screen: who it lists,
 *   its offline and demo notices, and the account, access, group and aircraft
 *   dialogs; plus the shared member avatar and CSV export card.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ProgramUsers.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 *
 * Server rendering keeps no state, so the mocks keep the screen's own state
 * (its first six useState calls) between renders and capture each button's
 * click handler by its text and each form's submit handler by its label.
 */
// @vitest-environment node
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot, withDemoUser } from "../data/demo";
import type { Group, Member, Snapshot } from "../domain/model";
import { CsvExportCard, MemberAvatar, ProgramUsers } from "./ProgramUsers";

type Props = Record<string, unknown>;
const ui = vi.hoisted(() => ({
  screenStates: 6,
  slots: [] as unknown[],
  next: 0,
  clicks: new Map<string, (() => void)[]>(),
  forms: new Map<string, (data: FormData) => Promise<void>>(),
  workspace: {} as Props,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.next++;
      if (slot >= ui.screenStates) return react.useState(initial);
      if (!(slot in ui.slots)) ui.slots[slot] = initial;
      const set = (update: unknown) => {
        ui.slots[slot] =
          typeof update === "function" ? update(ui.slots[slot]) : update;
      };
      return [ui.slots[slot], set];
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const textOf = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    return "";
  };
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = [args[0], args[1] as Props];
      if (type === "button" && typeof props.onClick === "function") {
        const text = textOf(props.children).trim();
        ui.clicks.set(text, [
          ...(ui.clicks.get(text) ?? []),
          props.onClick as () => void,
        ]);
      }
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
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./PermissionGroupForm", () => ({
  GroupForm: (props: { initial?: Group; onDone: () => void }) => {
    ui.clicks.set("group form done", [props.onDone]);
    return `[group form ${props.initial?.id ?? "new"}]`;
  },
}));
vi.mock("./Fleet", () => ({
  AircraftForm: (props: { initial?: { uuid: string }; onDone: () => void }) => {
    ui.clicks.set("aircraft form done", [props.onDone]);
    return `[aircraft form ${props.initial?.uuid ?? "new"}]`;
  },
}));
vi.mock("./DeleteGroupButton", () => ({ DeleteGroupButton: () => null }));

const backend = {
  createProgramUser: vi.fn(),
  updateProgramAccess: vi.fn(),
  addExistingProgramUser: vi.fn(),
};
let s: Snapshot;

beforeEach(() => {
  s = withDemoUser(demoSnapshot(), false);
  s.groups.push(group("admins", { programAdmin: true }));
  s.groups.push(group("elsewhere", { programUuid: "other-program" }));
  s.members.push(member("dee", "Dee Disabled", ["admins"], false));
  s.members.push(member("out", "Other Program", ["elsewhere"]));
  for (const fn of Object.values(backend)) fn.mockReset();
  ui.workspace = { snapshot: s, backend, online: true, connected: true };
  ui.slots = [];
});

function group(id: string, overrides: Partial<Group> = {}): Group {
  const programUuid = s.activeProgramUuid;
  return {
    id,
    name: id,
    programUuid,
    aircraftIds: [],
    permissions: ["read"],
    ...overrides,
  };
}

function member(
  id: string,
  name: string,
  groupIds: string[],
  active = true,
): Member {
  return {
    id,
    name,
    email: `${id}@example.test`,
    isAdmin: false,
    active,
    groupIds,
  };
}

function render() {
  ui.next = 0;
  ui.clicks.clear();
  ui.forms.clear();
  return renderToStaticMarkup(h(ProgramUsers));
}

function click(text: string, index = 0) {
  render();
  ui.clicks.get(text)![index]();
  return render();
}

function formData(fields: [string, string][]) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

describe("lists", () => {
  it("lists members through the program's groups, with their access", () => {
    const html = render();
    for (const name of ["Jordan Lee", "Sam Rivera", "Dee Disabled"])
      expect(html).toContain(name);
    // Alex has no groups; Other Program's only group is in another program.
    expect(html).not.toContain("Alex Morgan");
    expect(html).not.toContain("Other Program");
    expect(html.match(/>Disabled</g)).toHaveLength(1);
    expect(html.match(/class="adm-count">\d+</g)).toEqual([
      'class="adm-count">03<',
      'class="adm-count">03<',
      'class="adm-count">03<',
    ]);
  });

  it("summarizes administrator, owner and other groups", () => {
    const html = render();
    expect(html).toContain(
      "Flight Program administrator · All program aircraft",
    );
    expect(html).toContain("Aircraft owner (read-only portal) · 1 aircraft");
    expect(html).toContain("read, flight, discrepancy · 3 aircraft");
  });

  it("disables every change offline and labels the local demo", () => {
    ui.workspace = { ...ui.workspace, connected: false, demo: true };
    const html = render();
    expect(html).toContain("Administration requires a connection.");
    expect(html).toContain("Local demo.");
    expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>/);
  });
});

describe("dialogs", () => {
  it("creates an account in the program with the chosen groups, then closes", async () => {
    expect(click("Add user")).toContain("Create account");
    await ui.forms.get("Create account")!(
      formData([
        ["name", "New Pilot"],
        ["email", "new@example.test"],
        ["password", "a long enough password"],
        ["group", "demo-pilots"],
      ]),
    );
    expect(backend.createProgramUser).toHaveBeenCalledWith(
      "new@example.test",
      "New Pilot",
      "a long enough password",
      s.activeProgramUuid,
      ["demo-pilots"],
    );
    expect(render()).not.toContain("Create account");
  });

  it("keeps a dialog open when the server refuses", async () => {
    backend.createProgramUser.mockRejectedValue(new Error("Refused."));
    click("Add user");
    await expect(ui.forms.get("Create account")!(formData([]))).rejects.toThrow(
      "Refused.",
    );
    expect(render()).toContain("Create account");
  });

  it("edits a member's groups, or removes their access, then closes", async () => {
    const html = click("Edit program access");
    expect(html).toContain("Jordan Lee · jordan@example.test");
    expect(html).toContain('checked="" value="demo-pilots"');
    expect(html).not.toContain('checked="" value="admins"');
    expect(html).toContain("Remove access to this Flight Program");
    await ui.forms.get("Save program access")!(
      formData([
        ["group", "admins"],
        ["remove", "on"],
      ]),
    );
    expect(backend.updateProgramAccess).toHaveBeenCalledWith(
      "demo-pilot",
      s.activeProgramUuid,
      ["admins"],
      true,
    );
    expect(render()).not.toContain("Save program access");
  });

  it("adds an existing account by email and shows the server's reply", async () => {
    backend.addExistingProgramUser.mockResolvedValue("Reply for any email.");
    expect(click("Add existing user")).toContain("Existing account email");
    await ui.forms.get("Save program access")!(
      formData([
        ["email", "known@example.test"],
        ["group", "demo-pilots"],
      ]),
    );
    expect(backend.addExistingProgramUser).toHaveBeenCalledWith(
      "known@example.test",
      s.activeProgramUuid,
      ["demo-pilots"],
    );
    const html = render();
    expect(html).not.toContain("Existing account email");
    expect(html).toMatch(/role="status"[^>]*>.*Reply for any email\./);
    expect(click("Add existing user")).not.toContain("Reply for any email.");
  });

  it("opens the group and aircraft forms, new or for the chosen record", () => {
    expect(click("Add group")).toContain("Create permission group");
    expect(click("group form done")).not.toContain("Create permission group");
    const edit = click("Edit group", 1);
    expect(edit).toContain("Edit permission group");
    expect(edit).toContain("[group form demo-owners]");
    expect(click("Add aircraft")).toContain("[aircraft form new]");
    expect(click("aircraft form done")).not.toContain("[aircraft form");
    expect(click("Edit aircraft", 2)).toContain("[aircraft form demo-182]");
  });
});

describe("shared pieces", () => {
  it("shows at most two initials, in blue for an administrator", () => {
    const avatar = (name: string, admin?: boolean) =>
      renderToStaticMarkup(h(MemberAvatar, { name, admin }));
    expect(avatar("Ann Bee Cee")).toBe(
      '<span class="adm-avatar" aria-hidden="true">AB</span>',
    );
    expect(avatar("Ann", true)).toContain(
      'class="adm-avatar adm-avatar-admin"',
    );
  });

  it("offers one download per table", () => {
    const onDownload = vi.fn();
    const html = renderToStaticMarkup(
      h(CsvExportCard, {
        title: "Exports",
        tables: ["aircraft", "flights"],
        onDownload,
      }),
    );
    expect(html.match(/aria-label="Download [a-z]+\.csv"/g)).toEqual([
      'aria-label="Download aircraft.csv"',
      'aria-label="Download flights.csv"',
    ]);
    ui.clicks.get("flights.csv")![0]();
    expect(onDownload).toHaveBeenCalledWith("flights");
  });

  it("names a table's file readably where asked, and downloads by table", () => {
    const onDownload = vi.fn();
    const html = renderToStaticMarkup(
      h(CsvExportCard, {
        title: "Exports",
        tables: ["audit", "flights"],
        fileNames: { audit: "change-log-recent" },
        onDownload,
      }),
    );
    expect(html).toContain('aria-label="Download change-log-recent.csv"');
    expect(html).toContain('aria-label="Download flights.csv"');
    ui.clicks.get("change-log-recent.csv")![0]();
    expect(onDownload).toHaveBeenCalledWith("audit");
  });
});

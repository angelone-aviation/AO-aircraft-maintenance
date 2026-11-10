/**
 * Responsibility: Pins who sees which navigation links in the app shell, the
 *   sidebar's counts and remembered groups, the top-bar title and the
 *   phone's Log flight button.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AppShell.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import { AppShell } from "./AppShell";

const view = { path: "/", routeId: "/", breakpoint: "desktop", unread: 0 };
vi.mock("@tanstack/react-router", () => ({
  rootRouteId: "__root__",
  useRouterState: (o: { select: (r: object) => string }) =>
    o.select({
      location: { pathname: view.path },
      matches: [{ routeId: "__root__" }, { routeId: view.routeId }],
    }),
  Link: (props: {
    to: string;
    className?: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
  }) =>
    createElement(
      "a",
      { href: props.to, className: props.className },
      typeof props.children === "function"
        ? props.children({ isActive: false })
        : props.children,
    ),
}));
vi.mock("./design", async (original) => ({
  ...(await original<typeof import("./design")>()),
  useBreakpoint: () => view.breakpoint,
}));
vi.mock("./Alerts", () => ({
  AlertBell: () => null,
  useUnreadAlertCount: () => view.unread,
}));
vi.mock("./UserProfile", () => ({ MyCertifications: () => null }));
vi.mock("./FlightForm", () => ({ FlightForm: () => null }));
const base = demoSnapshot();
const workspace = {
  snapshot: base as Snapshot,
  online: true,
  connected: true,
  demo: false,
  queue: [] as unknown[],
};
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(
    (select?: (w: typeof workspace) => unknown) =>
      select ? select(workspace) : workspace,
    { getState: () => workspace },
  ),
  previewDemoOwner: async () => {},
}));

const owners = {
  id: "owners",
  name: "Owners",
  programUuid: base.programs![0].uuid,
  permissions: ["read"],
  owner: true,
  aircraftIds: [base.aircraft[0].uuid],
};
const mechanics = {
  ...owners,
  id: "mechanics",
  owner: false,
  permissions: ["read", "maintenance"],
};
const asUser = (id: "admin" | "pilot" | "owner" | "mechanic"): Snapshot => {
  if (id === "admin") return base;
  const pilot = base.members[1];
  if (id === "pilot") return { ...base, user: { ...pilot } } as Snapshot;
  const user = {
    ...pilot,
    groupIds: [id === "owner" ? "owners" : "mechanics"],
  };
  const groups = [...base.groups, owners, mechanics];
  return { ...base, groups, user } as Snapshot;
};
// The screen is passed as a child; the props type still names it.
const SHELL_PROPS = { exit: () => {} } as ComponentProps<typeof AppShell>;
const render = (s: Snapshot = base) => {
  workspace.snapshot = s;
  return renderToStaticMarkup(createElement(AppShell, SHELL_PROPS, "Screen"));
};
const links = (html: string) =>
  [...html.matchAll(/<span class="nav-text">([^<]+)<\/span>/g)].map(
    (m) => m[1],
  );

describe("AppShell", () => {
  afterEach(() => {
    Object.assign(view, {
      path: "/",
      routeId: "/",
      breakpoint: "desktop",
      unread: 0,
    });
    vi.unstubAllGlobals();
  });

  it("gives administrators every link, ending with Administration, Costs, Board view and Settings", () => {
    const shown = links(render(asUser("admin")));
    expect(shown).toContain("Inventory");
    expect(shown.slice(-4)).toEqual([
      "Administration",
      "Costs",
      "Board view",
      "Settings",
    ]);
  });

  it("keeps inventory and purchasing links for program administrators", () => {
    const shown = links(render(asUser("mechanic")));
    expect(shown).toContain("Work orders");
    for (const link of ["Inventory", "Purchase orders", "Vendors", "Costs"])
      expect(shown).not.toContain(link);
  });

  it("shows pilots only pilot navigation, and owners only the overview", () => {
    const pilot = links(render(asUser("pilot")));
    expect(pilot).toContain("Flight log");
    expect(pilot).not.toContain("Work orders");
    expect(pilot).not.toContain("Administration");
    expect(pilot.at(-1)).toBe("Settings");
    expect(links(render(asUser("owner")))).toEqual(["Overview"]);
  });

  it("shows sidebar counts above 99 as 99+", () => {
    view.unread = 120;
    expect(render()).toContain('<span class="nav-count">99+</span>');
  });

  it("remembers closed sidebar groups, and opens them all after bad storage", () => {
    const closed = (stored: string) => {
      vi.stubGlobal("localStorage", { getItem: () => stored });
      return render().match(/class="nav-group closed"/g)?.length ?? 0;
    };
    expect(closed('["fly","unknown"]')).toBe(1);
    expect(closed("not json")).toBe(0);
  });

  it("titles nested screens by their section, unknown ones Page not found, and reduced views by their name", () => {
    view.breakpoint = "tablet";
    view.path = "/manuals/abc";
    expect(render()).toContain("<span>Reference library</span>");
    view.path = "/aircraft/setup/abc";
    expect(render()).toContain("<span>Set up an aircraft</span>");
    view.path = "/nowhere";
    view.routeId = "__root__";
    expect(render()).toContain("<span>Page not found</span>");
    view.path = "/settings";
    view.routeId = "/settings";
    expect(render(asUser("owner"))).toContain("<span>Owner portal</span>");
  });

  it("labels the sidebar profile with the role Settings shows", () => {
    expect(render(asUser("admin"))).toContain(
      "<small>System administrator</small>",
    );
    expect(render(asUser("mechanic"))).toContain("<small>Mechanic</small>");
  });

  it("offers Log flight on phones only to those who may log a flight", () => {
    view.breakpoint = "phone";
    expect(render(asUser("pilot"))).toContain("Log flight");
    expect(render(asUser("owner"))).not.toContain("Log flight");
  });
});

/**
 * Responsibility: Pins the design system's documented markup rules, the
 *   dialog's dismissal rules and the theme: saved, or following the device.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/design.tsx, react-dom/server.
 *
 * Opening a dialog and the breakpoints need a browser: tests/e2e covers them.
 */
// @vitest-environment node
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AircraftArt,
  Dialog,
  Facts,
  ListRow,
  ProgressTrack,
  SearchField,
  Segmented,
  Skeleton,
  StatusPill,
  Wordmark,
  initTheme,
  setTheme,
} from "./design";

const html = (element: ReactElement) => renderToStaticMarkup(element);

// The dialog element's own handlers, captured as it is created. Vitest
// compiles JSX for development, through jsxDEV.
type Fn = (event: object) => void;
type DialogHandlers = Record<"onCancel" | "onPointerDown" | "onClick", Fn>;
let dialog: DialogHandlers;
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, ...rest) => {
    if (type === "dialog") dialog = props as DialogHandlers;
    return runtime.jsxDEV(type, props, ...rest);
  };
  return { ...runtime, jsxDEV };
});

describe("design markup", () => {
  it("reads the warning tone as warn", () => {
    expect(html(h(StatusPill, { tone: "warning", children: "Due" }))).toContain(
      "ds-tone-warn",
    );
  });

  it("announces a loading placeholder once, politely, and hides its shapes", () => {
    const page = html(h(Skeleton));
    expect(page).toMatch(/^<div class="ds-skeleton page" role="status">/);
    expect(page.match(/<span class="sr-only">Loading<\/span>/g)).toHaveLength(
      1,
    );
    expect(page.match(/"ds-skeleton-card"/g)).toHaveLength(4);
    expect(page.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(
      html(h(Skeleton, { shape: "section" })).match(/"ds-skeleton-card"/g),
    ).toHaveLength(1);
  });

  it("shows the one aircraft picture, sized, lazy and hidden from readers", () => {
    expect(html(h(AircraftArt, {}))).toBe(
      '<img src="/branding/aircraft.webp" alt="" aria-hidden="true"' +
        ' loading="lazy" decoding="async" width="128" height="50"' +
        ' class="ds-aircraft-art"/>',
    );
    expect(html(h(AircraftArt, { width: 300, className: "hero" }))).toContain(
      'width="300" height="117" class="ds-aircraft-art hero"',
    );
  });

  it("gives a status pill an icon in place of its dot", () => {
    const Icon = () => h("svg", { "data-icon": true });
    const pill = html(
      h(StatusPill, { tone: "good", icon: Icon, children: "Airworthy" }),
    );
    expect(pill).toContain("<svg data-icon");
    expect(pill).not.toContain("ds-pill-dot");
  });

  it("lists facts as labelled values, one column each by default", () => {
    const facts = [
      { label: "Hobbs", value: "2,341.2" },
      { label: "Landings", value: "2,194" },
    ];
    expect(html(h(Facts, { facts }))).toBe(
      '<dl class="ds-facts" style="--facts:2">' +
        "<div><dt>Hobbs</dt><dd>2,341.2</dd></div>" +
        "<div><dt>Landings</dt><dd>2,194</dd></div></dl>",
    );
    expect(html(h(Facts, { facts, columns: 4, bare: true }))).toContain(
      'class="ds-facts bare" style="--facts:4"',
    );
  });

  it("uses a search field's label as its placeholder unless one is given", () => {
    const field = (placeholder?: string) =>
      html(
        h(SearchField, {
          label: "Find",
          value: "",
          onChange() {},
          placeholder,
        }),
      );
    expect(field()).toContain('aria-label="Find" placeholder="Find"');
    expect(field("Name")).toContain('placeholder="Name"');
  });

  it("clamps progress, rounds it to a tenth and names it only with a label", () => {
    const bar = (value: number, label?: string) =>
      html(h(ProgressTrack, { value, label }));
    expect(bar(0.12345)).toContain("width:12.3%");
    expect(bar(1.5)).toContain("width:100%");
    expect(bar(Number.NaN)).toContain("width:0%");
    expect(bar(0.5)).toContain('aria-hidden="true"');
    expect(bar(0.5, "Life used")).toContain(
      'role="progressbar" aria-label="Life used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"',
    );
  });

  it("leaves out a list row's empty meta but shows 0, and is a button with onClick", () => {
    const row = (meta: ReactNode, onClick?: () => void) =>
      html(h(ListRow, { title: "T", meta, onClick }));
    for (const meta of [undefined, null, ""])
      expect(row(meta)).not.toContain("ds-list-meta");
    expect(row(0)).toContain('<span class="ds-list-meta">0</span>');
    expect(row("1 h")).toMatch(/^<div class="ds-list-row">/);
    expect(row("1 h", () => {})).toMatch(/^<button type="button"/);
  });

  it("marks the chosen segment pressed or current, and hides counts", () => {
    const options = [
      { value: "a", label: "All", count: 4 },
      { value: "b", label: "Busy", count: "" },
    ];
    const group = (mode?: "pressed" | "current") =>
      html(
        h(Segmented, {
          label: "View",
          options,
          value: "a",
          mode,
          onChange() {},
        }),
      );
    expect(group()).toContain('aria-pressed="true">All');
    expect(group()).toContain('aria-pressed="false">Busy</button>');
    expect(group("current")).toContain('aria-current="page">All');
    expect(group("current")).not.toContain("aria-pressed");
    expect(group()).toContain(
      '<span class="ds-seg-count" aria-hidden="true">4',
    );
  });

  it("names a dialog by its title, through aria-label with a custom header", () => {
    const frame = (header?: ReactElement, open?: boolean) =>
      html(h(Dialog, { title: "Edit AD", onClose() {}, header, open }));
    expect(frame(undefined, false)).toBe("");
    expect(frame()).toMatch(/aria-labelledby="([^"]+)".*<h2 id="\1">Edit AD/);
    expect(frame(h("div"))).toContain('aria-label="Edit AD"');
    expect(frame(h("div"))).not.toContain("aria-labelledby");
  });

  it("shows a fixed wordmark, or both for CSS to pick, 156px wide by default", () => {
    expect(
      html(h(Wordmark, {})).match(/class="ds-wordmark auto/g),
    ).toHaveLength(2);
    expect(html(h(Wordmark, { variant: "navy" }))).toContain(
      'class="ds-wordmark ds-wordmark-navy" style="width:156px;height:auto"',
    );
    expect(html(h(Wordmark, { variant: "white", height: 40 }))).toContain(
      'style="width:auto;height:40px"',
    );
  });
});

describe("Dialog dismissal", () => {
  const scrim = {};
  const panel = {};
  const open = (dismissOnScrim?: boolean) => {
    const onClose = vi.fn();
    html(h(Dialog, { title: "T", onClose, dismissOnScrim }));
    const at = (target: object) => ({
      target,
      currentTarget: scrim,
      preventDefault() {},
    });
    return { onClose, at };
  };

  it("closes on a scrim click only when the press began on the scrim", () => {
    const { onClose, at } = open();
    dialog.onPointerDown(at(panel));
    dialog.onClick(at(scrim));
    expect(onClose).not.toHaveBeenCalled();
    dialog.onPointerDown(at(scrim));
    dialog.onClick(at(scrim));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores the scrim when dismissOnScrim is false", () => {
    const { onClose, at } = open(false);
    dialog.onPointerDown(at(scrim));
    dialog.onClick(at(scrim));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape only for the dialog the browser cancelled", () => {
    const { onClose, at } = open();
    dialog.onCancel(at(panel));
    expect(onClose).not.toHaveBeenCalled();
    dialog.onCancel(at(scrim));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("theme", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (saved: string | null, systemDark = false) => {
    const stored = new Map<string, string>();
    const dark = vi.fn();
    const system = { dark: systemDark, listeners: new Set<() => void>() };
    vi.stubGlobal("localStorage", {
      getItem: () => saved,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({
        get matches() {
          return system.dark;
        },
        addEventListener: (_: string, l: () => void) => system.listeners.add(l),
        removeEventListener: (_: string, l: () => void) =>
          system.listeners.delete(l),
      }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: dark, add: vi.fn(), remove: vi.fn() },
      },
    });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    // Changes the device's light or dark setting, telling the page as the
    // browser does.
    const turnDevice = (toDark: boolean) => {
      system.dark = toDark;
      system.listeners.forEach((l) => l());
    };
    return { stored, dark, turnDevice };
  };

  it("applies the saved theme, or else the system preference", () => {
    const saved = stub("dark");
    initTheme();
    expect(saved.dark).toHaveBeenLastCalledWith("dark", true);
    const system = stub(null, true);
    initTheme();
    expect(system.dark).toHaveBeenLastCalledWith("dark", true);
  });

  it("saves a chosen theme on the device and applies it even when storage is blocked", () => {
    const { stored, dark } = stub(null);
    setTheme("dark");
    expect(stored.get("angelone-theme")).toBe("dark");
    vi.stubGlobal("localStorage", {
      setItem() {
        throw new Error("Storage blocked");
      },
    });
    setTheme("light");
    expect(dark).toHaveBeenLastCalledWith("dark", false);
  });

  it("saves Match this device as its own choice and follows the device live (B9)", () => {
    const device = stub("light", false);
    initTheme();
    setTheme("system");
    expect(device.stored.get("angelone-theme")).toBe("system");
    device.turnDevice(true);
    expect(device.dark).toHaveBeenLastCalledWith("dark", true);
    device.turnDevice(false);
    expect(device.dark).toHaveBeenLastCalledWith("dark", false);
  });

  it("follows the device live when nothing is saved, or Match this device was", () => {
    for (const saved of [null, "system"]) {
      const device = stub(saved, true);
      initTheme();
      expect(device.dark).toHaveBeenLastCalledWith("dark", true);
      device.turnDevice(false);
      expect(device.dark).toHaveBeenLastCalledWith("dark", false);
    }
  });

  it("keeps a chosen light or dark theme when the device's setting changes", () => {
    const device = stub("system", false);
    initTheme();
    setTheme("dark");
    device.turnDevice(true);
    device.turnDevice(false);
    expect(device.dark).toHaveBeenLastCalledWith("dark", true);
  });
});

/**
 * Responsibility: Pins when a key press is a shortcut: the three keys, and
 *   every case where a shortcut stands down; and the shortcut list's rows.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/KeyboardShortcuts.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ShortcutsHelp,
  hasKeyboardPointer,
  shortcutFor,
  type ShortcutPress,
} from "./KeyboardShortcuts";

const press = (key: string, more: Partial<ShortcutPress> = {}) =>
  shortcutFor({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    typing: false,
    dialogOpen: false,
    ...more,
  });

describe("shortcutFor", () => {
  it("maps /, n and ? to search, a new flight and the list", () => {
    expect(press("/")).toBe("search");
    expect(press("n")).toBe("new-flight");
    expect(press("?")).toBe("help");
    expect(press("x")).toBeUndefined();
    expect(press("N")).toBeUndefined();
  });

  it("stands down while typing in a field", () => {
    for (const key of ["/", "n", "?"])
      expect(press(key, { typing: true })).toBeUndefined();
  });

  it("stands down while a dialog is open", () => {
    expect(press("n", { dialogOpen: true })).toBeUndefined();
    expect(press("?", { dialogOpen: true })).toBeUndefined();
  });

  it("stands down with Ctrl, Cmd or Alt held, and on a held-down repeat", () => {
    expect(press("n", { ctrlKey: true })).toBeUndefined();
    expect(press("/", { metaKey: true })).toBeUndefined();
    expect(press("n", { altKey: true })).toBeUndefined();
    expect(press("n", { repeat: true })).toBeUndefined();
  });
});

describe("ShortcutsHelp", () => {
  const rows = (canLog: boolean) =>
    [
      ...renderToStaticMarkup(
        createElement(ShortcutsHelp, { canLog, onClose: () => {} }),
      ).matchAll(/<kbd>([^<]+)<\/kbd>/g),
    ].map((m) => m[1]);

  it("lists N only for those who may log flights", () => {
    expect(rows(true)).toEqual(["/", "N", "?", "Esc"]);
    expect(rows(false)).toEqual(["/", "?", "Esc"]);
  });
});

describe("hasKeyboardPointer", () => {
  it("is false without a window, as on the server", () => {
    expect(hasKeyboardPointer()).toBe(false);
  });
});

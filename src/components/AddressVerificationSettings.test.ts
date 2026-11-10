/**
 * Responsibility: Pins who sees the Geoapify key panel, its status row, and
 *   when its Update… dialog is disabled. Loading and saving the key need a
 *   backend: tests/e2e/addresses.spec.ts covers the panel in demo mode.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AddressVerificationSettings.tsx,
 *   src/data/demo.ts (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { AddressVerificationSettings } from "./AddressVerificationSettings";

// Server rendering cannot click, so `dialog.open` makes the panel's first
// useState(false), its Update… dialog, start open.
const dialog = vi.hoisted(() => ({ open: false, flipped: false }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const real = react.useState(initial);
      if (!dialog.open || dialog.flipped || initial !== false) return real;
      dialog.flipped = true;
      return [true, real[1]];
    },
  };
});

const workspace = {
  snapshot: demoSnapshot(),
  backend: null,
  online: true,
  connected: true,
  demo: false,
};
vi.mock("../data/store", () => {
  const useWorkspace = () => workspace;
  useWorkspace.getState = () => workspace;
  return { useWorkspace };
});
beforeEach(() => {
  dialog.open = false;
  workspace.snapshot = demoSnapshot();
  workspace.snapshot.user.isAdmin = true;
  workspace.demo = false;
});

const render = (open = false) => {
  dialog.open = open;
  dialog.flipped = false;
  return renderToStaticMarkup(createElement(AddressVerificationSettings));
};

describe("AddressVerificationSettings", () => {
  it("shows nothing to anyone but a system administrator", () => {
    workspace.snapshot.user.isAdmin = false;
    expect(render()).toBe("");
  });

  it("opens with the name, the status pill and an Update… button", () => {
    const html = render();
    expect(html).toContain("<h3>Address verification</h3>");
    expect(html).toContain("Unknown</span>");
    expect(html).toContain('aria-label="Update Geoapify API key"');
  });

  it("asks a system administrator for a key of 16 or more characters", () => {
    const html = render(true);
    expect(html).toContain('minLength="16"');
    expect(html).toContain('type="password"');
  });

  it("disables updating until the key's status has loaded", () => {
    expect(render()).toContain('disabled="">Update…</button>');
    expect(render(true)).toMatch(/<fieldset disabled=""/);
  });

  it("says the key is saved only on a live deployment in demo mode", () => {
    workspace.demo = true;
    expect(render()).toContain(
      "Not available in the demo: keys and accounts are saved only on a live deployment.",
    );
  });
});

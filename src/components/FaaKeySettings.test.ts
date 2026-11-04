/**
 * Responsibility: Pins when the FAA key renewal warning shows and where it
 *   links, and who may replace the key from the FAA key panel.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FaaKeySettings.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FaaCredentialStatus } from "../domain/faaCredential";
import { localDate } from "../domain/model";
import { FaaKeySettings, FaaRenewalAlert } from "./FaaKeySettings";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({
  useWorkspace: (select?: (state: unknown) => unknown) =>
    select ? select(workspace.state) : workspace.state,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; hash?: string; children: ReactNode }) =>
    h("a", { href: props.to + (props.hash ? "#" + props.hash : "") }, [
      props.children,
    ]),
}));

const DAY_MS = 86_400_000;
const ONLINE = { online: true, connected: true, demo: false };

function expiringIn(days: number): FaaCredentialStatus {
  const expiresOn = new Date(Date.parse(localDate()) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { configured: true, expiresOn, version: 1 };
}

function renderAlert(faaCredential?: FaaCredentialStatus, isAdmin = true) {
  workspace.state = {
    snapshot: faaCredential && { faaCredential, user: { isAdmin } },
  };
  return renderToStaticMarkup(h(FaaRenewalAlert));
}

function renderPanel(
  level?: 2 | 3,
  isAdmin = true,
  flags: Partial<typeof ONLINE> = {},
) {
  workspace.state = {
    snapshot: { faaCredential: expiringIn(90), user: { isAdmin } },
    ...ONLINE,
    ...flags,
  };
  return renderToStaticMarkup(h(FaaKeySettings, { level }));
}

describe("FaaRenewalAlert", () => {
  it("stays hidden until the status loads and while expiry is over 60 days away", () => {
    expect(renderAlert()).toBe("");
    expect(renderAlert(expiringIn(61))).toBe("");
    expect(renderAlert(expiringIn(60))).toContain("60 days remaining");
  });

  it("links system administrators to Settings and others to Airworthiness", () => {
    expect(renderAlert(expiringIn(1))).toContain('href="/settings#system"');
    expect(renderAlert(expiringIn(1), false)).toContain(
      'href="/airworthiness"',
    );
  });
});

describe("FaaKeySettings", () => {
  it("uses an h2 by default and an h3 when nested", () => {
    expect(renderPanel()).toContain("<h2>FAA API key and renewal</h2>");
    expect(renderPanel(3)).toContain("<h3>FAA API key and renewal</h3>");
  });

  it("offers the replacement only to system administrators", () => {
    expect(renderPanel()).toContain(
      '<button type="button" class="button">Update FAA API key</button>',
    );
    const other = renderPanel(2, false);
    expect(other).not.toContain("Update FAA API key");
    expect(other).toContain("An administrator can update the shared FAA key.");
  });

  it("disables the replacement offline and in demo mode", () => {
    for (const flags of [{ online: false }, { connected: false }])
      expect(renderPanel(2, true, flags)).toContain('disabled="">Update');
    const demo = renderPanel(2, true, { demo: true });
    expect(demo).toContain('disabled="">Update');
    expect(demo).toContain("not in demo mode");
  });
});

/**
 * Responsibility: Pins when the FAA key renewal warning shows, where it links
 *   and for whom, who may replace the key, and what a failed replacement
 *   shows.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FaaKeySettings.tsx, react-dom/server,
 *   convex/values (ConvexError).
 *
 * Server rendering keeps no state between renders, so a react mock keeps
 * useState values in call order: a test can open the dialog, submit it and
 * render again.
 */
// @vitest-environment node
import {
  createElement as h,
  isValidElement,
  type FormEvent,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FaaCredentialStatus } from "../domain/faaCredential";
import { localDate } from "../domain/model";
import { FaaKeySettings, FaaRenewalAlert } from "./FaaKeySettings";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const hooks = vi.hoisted(() => ({ states: [] as unknown[], next: 0 }));
const dialog = vi.hoisted(() => ({
  submit: undefined as undefined | ((event: FormSubmit) => void),
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = hooks.next++;
      if (!(slot in hooks.states)) hooks.states[slot] = initial;
      const set = (value: unknown) => {
        hooks.states[slot] = value;
      };
      return [hooks.states[slot], set];
    },
  };
});
vi.mock("./ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("./ui")>();
  return {
    ...ui,
    Modal: (props: Parameters<typeof ui.Modal>[0]) => {
      const form = props.children;
      if (isValidElement<{ onSubmit: (event: FormSubmit) => void }>(form))
        dialog.submit = form.props.onSubmit;
      return ui.Modal(props);
    },
  };
});
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

type FormSubmit = Pick<FormEvent, "preventDefault">;

const DAY_MS = 86_400_000;
const ONLINE = { online: true, connected: true, demo: false };
const UNCONFIRMED =
  "Unable to confirm the update. Check the key, future expiration date, connection, and administrator access. Refresh to check the saved expiration date before retrying.";

beforeEach(() => {
  hooks.states = [];
  dialog.submit = undefined;
});

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
  return renderAgain(level);
}

// Renders the panel from the workspace and state the last render left.
function renderAgain(level?: 2 | 3) {
  hooks.next = 0;
  return renderToStaticMarkup(h(FaaKeySettings, { level }));
}

// Opens the replacement dialog, submits it to a backend that throws `error`,
// and returns the panel as it renders afterwards.
async function failReplacement(error: Error) {
  renderPanel();
  workspace.state.backend = { updateFaaKey: () => Promise.reject(error) };
  // The panel's first state is whether the dialog is open.
  hooks.states[0] = true;
  renderAgain();
  if (!dialog.submit) throw new Error("The replacement dialog did not open.");
  dialog.submit({ preventDefault: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return renderAgain();
}

describe("FaaRenewalAlert", () => {
  it("stays hidden until the status loads and while expiry is over 60 days away", () => {
    expect(renderAlert()).toBe("");
    expect(renderAlert(expiringIn(61))).toBe("");
    expect(renderAlert(expiringIn(60))).toContain("60 days remaining");
  });

  it("links system administrators to Settings, and tells others who renews it", () => {
    expect(renderAlert(expiringIn(1))).toContain('href="/settings#system"');
    const member = renderAlert(expiringIn(1), false);
    expect(member).not.toContain("href=");
    expect(member).toContain("A system administrator renews it.");
    expect(member).not.toContain("Renew it");
    expect(renderAlert(expiringIn(61), false)).toBe("");
  });
});

describe("FaaKeySettings", () => {
  it("uses an h2 by default and an h3 when nested", () => {
    expect(renderPanel()).toContain("<h2>FAA API key and renewal</h2>");
    expect(renderPanel(3)).toContain("<h3>FAA API key and renewal</h3>");
  });

  it("offers the replacement only to system administrators", () => {
    expect(renderPanel()).toContain(
      '<button type="button" class="button small">Update FAA API key</button>',
    );
    expect(renderPanel(2, false)).not.toContain("Update FAA API key");
  });

  it("disables the replacement offline and in demo mode", () => {
    for (const flags of [{ online: false }, { connected: false }])
      expect(renderPanel(2, true, flags)).toContain('disabled="">Update');
    const demo = renderPanel(2, true, { demo: true });
    expect(demo).toContain('disabled="">Update');
    expect(demo).toContain(
      "Not available in the demo: keys and accounts are saved only on a live deployment.",
    );
  });

  it("shows the server's refusal, and the general advice for anything else", async () => {
    const refusal =
      "FAA could not verify the new key (401). The previous key is unchanged.";
    expect(await failReplacement(new ConvexError(refusal))).toContain(
      `<p role="alert">${refusal}</p>`,
    );
    const hidden = new Error(
      "[CONVEX A(faaCredentials:replace)] [Request ID: 1a2b] Server Error",
    );
    expect(await failReplacement(hidden)).toContain(
      `<p role="alert">${UNCONFIRMED}</p>`,
    );
  });
});

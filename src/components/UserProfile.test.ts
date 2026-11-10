/**
 * Responsibility: Pins which account, access and certification fields the
 *   user form shows, and what saving it sends to the backend.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/UserProfile.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Member, Snapshot } from "../domain/model";
import { MyCertifications, UserProfileForm } from "./UserProfile";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const form = vi.hoisted(() => ({
  submit: undefined as undefined | ((data: FormData) => Promise<void>),
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace.state, {
    getState: () => workspace.state,
  }),
}));
vi.mock("./ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("./ui")>();
  return {
    ...ui,
    AsyncForm: (props: Parameters<typeof ui.AsyncForm>[0]) => {
      form.submit = props.onSubmit;
      return ui.AsyncForm(props);
    },
  };
});

let snapshot: Snapshot;
const calls: unknown[][] = [];
const backend = new Proxy(
  {},
  {
    get:
      (_, method: string) =>
      async (...args: unknown[]) => {
        calls.push([method, ...args]);
        return method === "createUser" ? "new-user" : [];
      },
  },
);

beforeEach(() => {
  snapshot = demoSnapshot();
  calls.length = 0;
  workspace.state = { snapshot, backend, online: true, connected: true };
});

function render(initial?: Member, self = false) {
  return renderToStaticMarkup(
    h(UserProfileForm, { initial, self, onDone: () => calls.push(["done"]) }),
  );
}

function submit(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return form.submit!(data);
}

const other = () => snapshot.members.find((m) => m.id !== snapshot.user.id)!;

describe("account fields", () => {
  it("asks a new account for an initial password", () => {
    const html = render();
    expect(html).toMatch(
      /type="password" minLength="15" maxLength="128" required=""[^>]*name="password"/,
    );
    expect(html).toMatch(/> Create account<\/button>/);
    expect(html).toContain('maxLength="150"');
  });

  it("locks an existing user's email and offers access fields", () => {
    const html = render(other());
    expect(html).not.toContain('name="password"');
    expect(html).toMatch(/type="email" required="" readOnly=""/);
    expect(html).toContain('name="admin"');
    expect(html).toContain("<h3>Flight Program access</h3>");
    expect(html).toMatch(/> Save user<\/button>/);
  });

  it("gives the signed-in user read-only name and email, and leaves alert email to Settings", () => {
    const html = render(snapshot.user, true);
    expect(html).toMatch(/readOnly=""[^>]*name="name"/);
    expect(html).toMatch(/type="email" required="" readOnly=""/);
    expect(html).not.toContain('name="admin"');
    expect(html).not.toContain("Flight Program access");
    expect(html).not.toContain('name="emailAlerts"');
    expect(html).toContain("Alert email is chosen under Settings → Alerts.");
    expect(html).toMatch(/> Save certifications<\/button>/);
  });
});

describe("access and certification fields", () => {
  it("says when a program has no permission groups", () => {
    snapshot.groups = [];
    expect(render(other())).toContain("No permission groups are available.");
  });

  it("keeps a legacy license visible until certifications are saved", () => {
    const legacy = {
      ...other(),
      certifications: undefined,
      licenseNumber: "A123",
      certificateType: "A&P",
    };
    expect(render(legacy)).toContain("Existing profile license: A&amp;P A123");
  });

  it("opens the certifications form from a text button by default", () => {
    const html = renderToStaticMarkup(h(MyCertifications, {}));
    expect(html).toBe(
      '<button type="button" class="text-button">My certifications</button>',
    );
  });
});

describe("saving", () => {
  it("creates the account before saving its profile", async () => {
    render();
    await submit({ email: "new@example.test", name: "New", password: "pw" });
    expect(calls[0]).toEqual(["createUser", "new@example.test", "New", "pw"]);
    expect(calls[1]).toMatchObject([
      "updateUser",
      { id: "new-user", email: "new@example.test", active: false },
    ]);
    expect(calls.at(-1)).toEqual(["done"]);
  });

  it("keeps an existing user's certifications unless they were edited", async () => {
    render(other());
    await submit({ name: "Renamed", active: "on" });
    expect(calls[0][0]).toBe("updateUser");
    expect(calls[0][1]).toMatchObject({ name: "Renamed", active: true });
    expect(calls[0][1]).toHaveProperty("certifications", undefined);
  });

  it("never changes the signed-in user's alert emails from this form", async () => {
    snapshot.user = { ...snapshot.user, emailAlerts: true };
    render(snapshot.user, true);
    await submit({});
    await submit({ emailAlerts: "on" });
    expect(calls).toEqual([["done"], ["done"]]);
  });
});

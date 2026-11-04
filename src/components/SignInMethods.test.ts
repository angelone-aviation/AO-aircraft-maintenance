/**
 * Responsibility: Pins which Google and Microsoft sign-in buttons show and how
 *   they read, and the first render of a user's sign-in methods.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/SignInMethods.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Member } from "../domain/model";
import { SignInMethodList, SsoButtonList } from "./SignInMethods";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

const render = (
  providers: string[],
  options: { busy?: string; disabled?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(SsoButtonList, {
      providers,
      onSelect: () => undefined,
      ...options,
    }),
  );

function renderMethods(member?: Member, online = false) {
  workspace.state = { online, connected: true, backend: null };
  return renderToStaticMarkup(createElement(SignInMethodList, { member }));
}

it("shows no Google or Microsoft button when neither is configured", () => {
  expect(render([])).toBe("");
  // Only the providers the app knows are offered.
  expect(render(["github"])).toBe("");
});

it("shows a button for each configured provider only", () => {
  const google = render(["google"]);
  expect(google).toContain("Sign in with Google");
  expect(google).not.toContain("Microsoft");
  const both = render(["google", "microsoft-entra-id"]);
  expect(both).toContain("Sign in with Google");
  expect(both).toContain("Sign in with Microsoft");
  expect(both.match(/<button/g)).toHaveLength(2);
  expect(both).toMatch(/type="button"/);
});

it("keeps the configured order", () => {
  const html = render(["microsoft-entra-id", "google"]);
  expect(html.indexOf("Microsoft")).toBeLessThan(html.indexOf("Google"));
});

it("names the provider being opened and disables every button meanwhile", () => {
  const html = render(["google", "microsoft-entra-id"], { busy: "google" });
  expect(html).toContain("Opening Google…");
  expect(html).toContain("Sign in with Microsoft");
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(render(["google"])).not.toContain("disabled");
  expect(render(["google"], { disabled: true })).toContain('disabled=""');
});

it("tells users who resets their password", () => {
  expect(renderMethods()).toContain(
    "Set by your administrator. Ask them to reset it.",
  );
  const member = { id: "u1", name: "Pat Doe" } as Member;
  expect(renderMethods(member)).toContain("Reset by a system administrator.");
});

it("asks to reconnect before linked accounts can load", () => {
  expect(renderMethods()).toContain("Reconnect to see linked");
  expect(renderMethods(undefined, true)).not.toContain("Reconnect");
});

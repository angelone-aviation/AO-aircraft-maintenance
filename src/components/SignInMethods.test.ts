// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SsoButtonList } from "./SignInMethods";
vi.mock("../data/store", () => ({ useWorkspace: () => ({}) }));

const render = (providers: string[]) =>
  renderToStaticMarkup(
    createElement(SsoButtonList, { providers, onSelect: () => undefined }),
  );

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

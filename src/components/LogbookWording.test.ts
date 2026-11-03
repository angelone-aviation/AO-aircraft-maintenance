// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LogbookWording } from "./LogbookWording";

vi.mock("../data/store", () => ({
  useWorkspace: () => ({
    snapshot: null,
    backend: null,
    online: false,
    connected: false,
  }),
}));

describe("log book wording visibility", () => {
  it("hides wording and phrase controls when inclusion is unchecked", () => {
    const html = renderToStaticMarkup(
      createElement(LogbookWording, {
        included: false,
        phrase: "Inspected",
        onChange: () => {},
      }),
    );
    expect(html).toContain("Include in log book entry");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Manage log book phrases");
  });
  it("shows the saved wording when inclusion is checked", () => {
    const html = renderToStaticMarkup(
      createElement(LogbookWording, {
        included: true,
        phrase: "Inspected",
        onChange: () => {},
      }),
    );
    expect(html).toContain("<select");
    expect(html).toContain("Manage log book phrases");
    expect(html).toContain('selected="">Inspected');
  });
});

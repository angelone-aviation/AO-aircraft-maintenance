/**
 * Responsibility: Pins when the logbook wording controls show, the phrase
 *   selected by default, and the note on entries that predate the choice.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/LogbookWording.tsx, react-dom/server.
 */
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

const render = (included?: boolean, phrase?: string) =>
  renderToStaticMarkup(
    createElement(LogbookWording, { included, phrase, onChange: () => {} }),
  );
const LEGACY_NOTE = "Existing entry uses the original work summary.";

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
  it("shows a task with no recorded choice as included, worded Performed", () => {
    const html = render();
    expect(html).toContain('checked=""');
    expect(html).toContain('selected="">Performed');
  });
  it("notes only entries that predate the choice", () => {
    expect(render()).toContain(LEGACY_NOTE);
    expect(render(true)).not.toContain(LEGACY_NOTE);
    expect(render(false)).not.toContain(LEGACY_NOTE);
  });
  it("keeps a phrase missing from the saved list in the menu", () => {
    expect(render(true, "Overhauled")).toContain(
      '<option selected="">Overhauled</option>',
    );
  });
});

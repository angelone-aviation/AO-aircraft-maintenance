/**
 * Responsibility: Pins the make and model field's input markup and the source
 *   note under it. The suggestion list and keys need a browser:
 *   tests/e2e/drs-fields.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/DrsComboBox.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { DrsComboBox } from "./DrsComboBox";

let snapshot = demoSnapshot();
vi.mock("../data/store", () => ({
  useWorkspace: (select: (state: { snapshot: unknown }) => unknown) =>
    select({ snapshot }),
}));
beforeEach(() => {
  snapshot = demoSnapshot();
});

const render = (props: Partial<ComponentProps<typeof DrsComboBox>>) =>
  renderToStaticMarkup(createElement(DrsComboBox, { kind: "makes", ...props }));
const note = (html: string) => html.match(/<small>.*<\/small>/)?.[0];

describe("DrsComboBox", () => {
  it("renders a closed combobox input that controls its list", () => {
    expect(render({ id: "make", name: "make", required: true })).toBe(
      '<div class="drs-combobox"><div class="drs-combobox-input">' +
        '<input id="make" role="combobox" aria-autocomplete="list"' +
        ' aria-expanded="false" aria-controls="make-list" autoComplete="off"' +
        ' required="" maxLength="150" name="make" value=""/>' +
        '<span aria-hidden="true"></span></div></div>',
    );
  });

  it("gives the input a generated id when none is passed", () => {
    const html = render({});
    const id = html.match(/<input id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-controls="${id}-list"`);
  });

  it("passes maxLength and aria-describedby through", () => {
    const html = render({ maxLength: 60, "aria-describedby": "make-hint" });
    expect(html).toContain('aria-describedby="make-hint"');
    expect(html).toContain('maxLength="60"');
  });

  it("names a DRS name as DRS, ignoring case", () => {
    expect(note(render({ defaultValue: "cessna aircraft company" }))).toBe(
      "<small>DRS</small>",
    );
  });

  it("names a name recorded in the program as Custom", () => {
    snapshot.aircraft[0].make = "Spyder Aero Works";
    expect(note(render({ defaultValue: "Spyder Aero Works" }))).toBe(
      "<small>Custom</small>",
    );
  });

  it("says that other text is outside the DRS list but still accepted", () => {
    expect(note(render({ defaultValue: "Nowhere Aero" }))).toBe(
      "<small>Custom · Not in the DRS list; can still be saved and searched.</small>",
    );
  });

  it("shows no note while the field is empty", () => {
    expect(note(render({}))).toBeUndefined();
  });

  it("shows the controlled value over defaultValue", () => {
    const html = render({ kind: "models", value: "441", defaultValue: "x" });
    expect(html).toContain('value="441"');
    expect(note(html)).toBe("<small>DRS</small>");
  });
});

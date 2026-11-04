/**
 * Responsibility: Pins the maintenance filter select's accessible name and
 *   change, and the fact caption's hiding from assistive technology.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/MaintenanceUi.tsx, react-dom/server.
 */
// @vitest-environment node
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FactLabel, IconSelect } from "./MaintenanceUi";

const Icon = () => createElement("svg");
const props = { icon: Icon, label: "Status", value: "a", children: null };

describe("IconSelect", () => {
  it("names the select with the label and adds the caller's class", () => {
    const html = renderToStaticMarkup(
      createElement(IconSelect, { ...props, className: "wide", onChange() {} }),
    );
    expect(html).toContain('<label class="mx-select wide">');
    expect(html).toContain('<select aria-label="Status">');
  });

  it("passes the chosen value to onChange", () => {
    const onChange = vi.fn();
    const select = findSelect(IconSelect({ ...props, onChange }));
    select.props.onChange({ target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("FactLabel", () => {
  it("is hidden from assistive technology", () => {
    expect(renderToStaticMarkup(FactLabel({ children: "Qty" }))).toBe(
      '<span class="mx-fact-label" aria-hidden="true">Qty</span>',
    );
  });
});

type SelectElement = ReactElement<{
  onChange: (event: { target: { value: string } }) => void;
}>;

function findSelect(label: ReactElement<{ children: ReactNode }>) {
  const select = Children.toArray(label.props.children).find(
    (child): child is SelectElement =>
      isValidElement(child) && child.type === "select",
  );
  if (!select) throw Error("IconSelect rendered no <select>.");
  return select;
}

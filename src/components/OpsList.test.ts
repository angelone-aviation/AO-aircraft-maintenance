/**
 * Responsibility: Pins the markup contract of the operations-screen building
 *   blocks: accessible names, optional row parts, meters and the select.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/OpsList.tsx, react-dom/server.
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
import { OpsList, OpsMeters, OpsRow, OpsSelect } from "./OpsList";

const Icon = () => createElement("svg");
const html = (element: ReactElement) => renderToStaticMarkup(element);
const row = (props: Partial<Parameters<typeof OpsRow>[0]>) =>
  html(createElement(OpsRow, { title: "N123AB", ...props }));

describe("OpsList", () => {
  it("is a list named by its label", () => {
    expect(html(OpsList({ label: "Aircraft", children: "rows" }))).toBe(
      '<ul class="ops-list" aria-label="Aircraft">rows</ul>',
    );
  });
});

describe("OpsRow", () => {
  it("renders only the lead when nothing else is given", () => {
    expect(row({})).toBe(
      '<li class="ops-row"><div class="ops-row-lead"><div class="ops-row-text">' +
        '<strong class="ops-row-title">N123AB</strong></div></div></li>',
    );
  });

  it("draws the icon tile blue unless a tone is given", () => {
    expect(row({ icon: Icon })).toContain("ds-tone-blue");
    expect(row({ icon: Icon, tone: "danger" })).toContain("ds-tone-danger");
  });

  it.each([undefined, null, ""])("leaves out a %j meta", (meta) => {
    expect(row({ meta })).not.toContain("ops-row-status");
  });

  it("shows a 0 meta and a badge without meta", () => {
    expect(row({ meta: 0 })).toContain('<span class="ops-row-meta">0</span>');
    expect(row({ badge: "Grounded" })).toContain(
      '<div class="ops-row-status">Grounded</div>',
    );
  });

  it("orders actions, details and secondary actions after the status", () => {
    const markup = row({
      meta: "1,204 h",
      actions: "Edit",
      extra: "Archive",
      children: "Meters",
    });
    const order = [
      "ops-row-status",
      "ops-row-actions",
      "ops-row-details",
      "ops-row-extra",
    ].map((name) => markup.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
  });
});

describe("OpsMeters", () => {
  it("ends each term with a visually hidden colon", () => {
    const meters = html(
      createElement(OpsMeters, { items: [["Hobbs", "1,204.3"]] }),
    );
    expect(meters).toBe(
      '<dl class="ops-meters"><div><dt>Hobbs<span class="sr-only">: </span>' +
        "</dt><dd>1,204.3</dd></div></dl>",
    );
  });
});

describe("OpsSelect", () => {
  const props = { label: "Aircraft", value: 2, children: null };

  it("names the select with the label and passes disabled through", () => {
    const markup = html(
      createElement(OpsSelect, {
        ...props,
        disabled: true,
        onChange: () => {},
      }),
    );
    expect(markup).toContain('<select aria-label="Aircraft" disabled="">');
  });

  it("passes the chosen value to onChange as a string", () => {
    const onChange = vi.fn();
    const select = findSelect(OpsSelect({ ...props, onChange }));
    select.props.onChange({ target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith("3");
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
  if (!select) throw Error("OpsSelect rendered no <select>.");
  return select;
}

/**
 * Responsibility: Pins the maintenance filter select's accessible name and
 *   change, the fact caption's hiding from assistive technology, and the
 *   rows table's roles, header and cell captions.
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
import {
  FactLabel,
  IconSelect,
  RowsCell,
  RowsRow,
  RowsTable,
} from "./MaintenanceUi";

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

describe("RowsTable", () => {
  const table = () =>
    renderToStaticMarkup(
      createElement(
        RowsTable,
        {
          label: "Templates",
          columns: ["Name", "Interval", "Actions"],
          cols: "1fr 1fr auto",
          hiddenColumns: ["Actions"],
        },
        createElement(
          RowsRow,
          null,
          createElement(RowsCell, { kind: "main" }, "Phase 2"),
          createElement(RowsCell, { caption: "Interval" }, "100 hours"),
          createElement(RowsCell, { kind: "actions" }, "Edit"),
        ),
      ),
    );

  it("is a named table whose rows share the desktop columns", () => {
    expect(table()).toContain(
      '<div class="mx-rt ds-rows" role="table" aria-label="Templates" style="--cols:1fr 1fr auto">',
    );
  });

  it("heads every column, showing only those not hidden", () => {
    const headers = [
      ...table().matchAll(
        /<span role="columnheader"><span class="([^"]*)">([^<]*)</g,
      ),
    ].map((m) => [m[2], m[1]]);
    expect(headers).toEqual([
      ["Name", ""],
      ["Interval", ""],
      ["Actions", "sr-only"],
    ]);
  });

  it("captions a cell for sighted readers only and marks its kind", () => {
    const html = table();
    expect(html).toContain('<div role="cell" class="mx-rt-main">Phase 2</div>');
    expect(html).toContain(
      '<div role="cell"><span class="mx-fact-label" aria-hidden="true">Interval</span>100 hours</div>',
    );
    expect(html).toContain('<div role="cell" class="mx-rt-actions">Edit</div>');
  });
});

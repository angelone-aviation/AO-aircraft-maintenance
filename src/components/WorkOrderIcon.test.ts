/**
 * Responsibility: Pins the Work orders icon's Phosphor-style size and weight
 *   props and its always-hidden accessibility.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderIcon.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkOrderIcon } from "./WorkOrderIcon";

const render = (props: ComponentProps<typeof WorkOrderIcon> = {}) =>
  renderToStaticMarkup(createElement(WorkOrderIcon, props));
const svgTag = (svg: string) => svg.match(/<svg[^>]*>/)?.[0] ?? "";
const sheetTint = 'opacity="0.2"';

describe("WorkOrderIcon", () => {
  it("draws at 18px with the regular stroke by default", () => {
    const svg = render();
    expect(svgTag(svg)).toContain('width="18" height="18"');
    expect(svgTag(svg)).toContain('stroke-width="1.6"');
    expect(svg).not.toContain(sheetTint);
  });

  it("passes a string size through", () => {
    expect(render({ size: "1.5em" })).toContain('width="1.5em" height="1.5em"');
  });

  it.each([
    ["bold", "2.2"],
    ["light", "1.2"],
    ["thin", "1.2"],
    ["regular", "1.6"],
    ["fill", "1.6"],
    ["duotone", "1.6"],
  ] as const)("draws the %s weight with a %s stroke", (weight, width) => {
    expect(svgTag(render({ weight }))).toContain(`stroke-width="${width}"`);
  });

  it("tints the sheet only for duotone", () => {
    expect(render({ weight: "duotone" })).toContain(sheetTint);
    expect(render({ weight: "fill" })).not.toContain(sheetTint);
  });

  it("stays hidden from assistive technology", () => {
    // Characterizes current behaviour: aria-hidden={false} is ignored.
    const svg = render({ "aria-hidden": false });
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });
});

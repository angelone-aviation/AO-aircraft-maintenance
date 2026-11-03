/**
 * Responsibility: Pins the Inspections icon's Phosphor-style size and weight
 *   props and its always-hidden accessibility.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InspectionIcon.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InspectionIcon } from "./InspectionIcon";

const render = (props: ComponentProps<typeof InspectionIcon> = {}) =>
  renderToStaticMarkup(createElement(InspectionIcon, props));
const lens = (svg: string) => svg.match(/<circle[^>]*>/)?.[0] ?? "";

describe("InspectionIcon", () => {
  it("draws at 18px with the regular stroke by default", () => {
    const svg = render();
    expect(svg).toContain('width="18" height="18"');
    expect(svg).toContain('stroke-width="1.6"');
    expect(lens(svg)).toContain('fill="none"');
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
    expect(render({ weight })).toContain(`stroke-width="${width}"`);
  });

  it("tints the lens only for duotone", () => {
    expect(lens(render({ weight: "duotone" }))).toContain(
      'fill="currentColor" fill-opacity="0.2"',
    );
    expect(lens(render({ weight: "fill" }))).not.toContain("fill-opacity");
  });

  it("stays hidden from assistive technology", () => {
    // Characterizes current behaviour: aria-hidden={false} is ignored.
    const svg = render({ "aria-hidden": false });
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });
});

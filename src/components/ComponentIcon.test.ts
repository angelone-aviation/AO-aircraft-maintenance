/**
 * Responsibility: Pins how the Components icon maps Phosphor's size and weight
 *   props onto its SVG.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ComponentIcon.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComponentIcon } from "./ComponentIcon";

type Props = Parameters<typeof ComponentIcon>[0];

const render = (props: Props) =>
  renderToStaticMarkup(createElement(ComponentIcon, props));

describe("ComponentIcon", () => {
  it("defaults to 18 pixels at the regular stroke", () => {
    const svg = render({});
    expect(svg).toContain('width="18" height="18"');
    expect(svg).toContain('stroke-width="1.6"');
  });

  it("takes a CSS length as its size", () => {
    expect(render({ size: "2em" })).toContain('width="2em" height="2em"');
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

  it("adds the tinted disc for duotone only", () => {
    expect(render({ weight: "duotone" })).toContain('opacity="0.2"');
    expect(render({ weight: "fill" })).not.toContain('opacity="0.2"');
  });

  it("stays hidden from assistive technology whatever aria-hidden says", () => {
    expect(render({ "aria-hidden": "false" })).toContain('aria-hidden="true"');
  });
});

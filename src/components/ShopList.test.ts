/**
 * Responsibility: Pins the markup contract of the shop-screen building
 *   blocks: accessible names, optional parts, tones, pill icons and the
 *   select's change.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ShopList.tsx, react-dom/server.
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
  ShopLead,
  ShopPill,
  ShopSelect,
  ShopStat,
  ShopTableCard,
} from "./ShopList";

const Icon = () => createElement("svg");
const html = (element: ReactElement) => renderToStaticMarkup(element);
const card = (props: Partial<Parameters<typeof ShopTableCard>[0]>) =>
  html(ShopTableCard({ children: "rows", ...props }));

describe("ShopTableCard", () => {
  it("names its section and leaves out the head row by default", () => {
    const markup = card({ label: "Vendors" });
    expect(markup).toContain(
      '<section class="shop-table-card" aria-label="Vendors">',
    );
    expect(markup).not.toContain("shop-table-head");
    expect(markup).toContain('<div class="shop-table-scroll">rows</div>');
  });

  it("shows the head row for a title or for actions alone", () => {
    expect(card({ title: "Open" })).toContain(
      '<div class="shop-table-head"><h2>Open</h2></div>',
    );
    expect(card({ actions: "New" })).toContain(
      '<div class="shop-table-head"><div class="shop-table-head-actions">New</div></div>',
    );
  });

  it("adds the stacking class and the caller's classes", () => {
    expect(card({ stack: true, className: "shop-list-look" })).toContain(
      'class="shop-table-card shop-stack shop-list-look"',
    );
  });
});

describe("ShopLead", () => {
  it.each([undefined, "neutral", "blue"] as const)(
    "draws a %s tone as the blue tile",
    (tone) => {
      const lead = html(
        createElement(ShopLead, { icon: Icon, tone, title: "A" }),
      );
      expect(lead).toContain("ds-tone-blue");
    },
  );

  it("keeps other tones and shows the sub-line only when given", () => {
    const lead = html(
      createElement(ShopLead, { icon: Icon, tone: "danger", title: "A" }),
    );
    expect(lead).toContain("ds-tone-danger");
    expect(lead).not.toContain("ds-list-sub");
    const withSub = html(
      createElement(ShopLead, { icon: Icon, title: "A", sub: "B" }),
    );
    expect(withSub).toContain('<span class="ds-list-sub">B</span>');
  });
});

describe("ShopSelect", () => {
  const props = { label: "Status", value: "open", children: null };

  it("names the select with the label", () => {
    const markup = html(
      createElement(ShopSelect, { ...props, onChange: () => {} }),
    );
    expect(markup).toContain('<select aria-label="Status">');
  });

  it("passes the chosen value to onChange", () => {
    const onChange = vi.fn();
    const select = findSelect(ShopSelect({ ...props, onChange }));
    select.props.onChange({ target: { value: "closed" } });
    expect(onChange).toHaveBeenCalledWith("closed");
  });
});

describe("ShopStat", () => {
  it("colours the value by tone and shows a footnote only when given", () => {
    const plain = html(createElement(ShopStat, { label: "Open", value: 3 }));
    expect(plain).toContain('<strong class="ds-stat-value">3</strong>');
    expect(plain).not.toContain("shop-stat-foot");
    const toned = html(
      createElement(ShopStat, {
        label: "Late",
        value: 2,
        tone: "warn",
        foot: "since May",
      }),
    );
    expect(toned).toContain('class="ds-stat-value shop-tone-warn"');
    expect(toned).toContain('<span class="shop-stat-foot">since May</span>');
  });
});

describe("ShopPill", () => {
  it("puts an icon before the words, in the pill's tone", () => {
    const pill = (tone?: "good" | "warning") =>
      html(ShopPill({ tone, children: "Draft" }));
    expect(pill("good")).toMatch(
      /^<span class="ds-pill ds-tone-good"><svg[^>]*aria-hidden="true">.*<\/svg>Draft<\/span>$/,
    );
    expect(pill("warning")).toContain('class="ds-pill ds-tone-warn"');
    expect(pill()).toContain('class="ds-pill ds-tone-neutral"><svg');
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
  if (!select) throw Error("ShopSelect rendered no <select>.");
  return select;
}

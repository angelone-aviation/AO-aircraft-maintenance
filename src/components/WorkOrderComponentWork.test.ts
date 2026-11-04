/**
 * Responsibility: Pins the component work section: the work offered, the
 *   tracking preview at completion, the fields each action needs, and the
 *   choices it reports.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderComponentWork.tsx, react-dom/server,
 *   src/data/demo.ts (seed), tests/fixtures/workOrders.ts.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { WorkOrderComponentWork } from "./WorkOrderComponentWork";

type Control = { onChange: (event: { target: { value: string } }) => void };

const fields = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("./ui")>();
  return {
    ...ui,
    // Records each field's control by its label, for a test to change.
    Field: (props: Parameters<typeof ui.Field>[0]) => {
      fields.set(props.label, (props.children as ReactElement).props);
      return ui.Field(props);
    },
  };
});

const LABEL = "Engine · SN";
let s: Snapshot;
let reported: ComponentWork[][];

beforeEach(() => {
  s = demoSnapshot();
  s.management = [workOrderComponent()];
  reported = [];
  fields.clear();
});

function render(
  choices: ComponentWork[] = [],
  { closing = false, ids = ["engine"], form = new FormData() } = {},
) {
  return renderToStaticMarkup(
    h(WorkOrderComponentWork, {
      s,
      ids,
      aircraftUuid: s.aircraft[0].uuid,
      fields: form,
      choices,
      onChange: (next: ComponentWork[]) => reported.push(next),
      closing,
    }),
  );
}

function choice(fields: Partial<ComponentWork>): ComponentWork {
  return {
    componentUuid: "engine",
    version: 0,
    action: "service",
    description: "",
    reference: "",
    ...fields,
  } as ComponentWork;
}

function change(label: string, value: string) {
  (fields.get(`${LABEL} ${label}`) as Control).onChange({ target: { value } });
}

describe("WorkOrderComponentWork", () => {
  it("renders nothing without components, and flags a missing one", () => {
    expect(render([], { ids: [] })).toBe("");
    expect(render([], { ids: ["gone"] })).toContain(
      "An included component is unavailable.",
    );
  });

  it("offers work other than a movement, or only the movement its task plans", () => {
    const free = render();
    expect(free).toContain(">Repaired and overhauled</option>");
    expect(free).not.toContain("Removed from aircraft");
    const planned = render([choice({ action: "remove", taskUuid: "t" })]);
    expect(planned).toContain(">Removed from aircraft</option>");
    expect(planned).not.toContain(">Repaired</option>");
    expect(planned).toContain(`${LABEL} inventory location`);
  });

  it("previews the overhaul and repair resets on current readings", () => {
    const html = render([choice({ action: "both" })]);
    expect(html).toContain(
      "Current readings (preview): TSN 110.0 h; cycles 40. TSO 30.0 h → 0.0 h; TSR Not recorded → 0.0 h.",
    );
    expect(html).toContain("Planned for closeout: repaired and overhauled");
    expect(html).toContain(" and renews applicable overhaul requirements.");
  });

  it("measures at the completion readings and date while closing", () => {
    const form = new FormData();
    form.set("completionHobbs", "1");
    form.set("completionTotalHours", "1");
    form.set("completionDate", "2026-10-30");
    const early = render([choice({ action: "repair" })], {
      closing: true,
      form,
    });
    expect(early).toContain("precede this component’s baseline");
    const html = render([choice({ action: "repair" })], { closing: true });
    expect(html).toContain("At completion: TSN");
    expect(html).toMatch(
      /Closing this order records repaired on \d{4}-\d\d-\d\d\./,
    );
    expect(html).toMatch(/<select required=""/);
  });

  it("reports the changed choice last, starting from the component's version", () => {
    const other = choice({ componentUuid: "spare" });
    render([choice({ action: "repair", version: 1 }), other]);
    change("work performed", "overhaul");
    change("work description", "Overhauled");
    expect(reported).toEqual([
      [other, choice({ action: "overhaul", version: 1 })],
      [
        other,
        choice({ action: "repair", version: 1, description: "Overhauled" }),
      ],
    ]);
  });

  it("asks for a description of a repair, overhaul or movement only", () => {
    expect(render([choice({ action: "overhaul" })])).toContain(
      `${LABEL} work description`,
    );
    expect(render([choice({})])).not.toContain("work description");
  });

  it("asks to confirm readings when the component changed since the choice", () => {
    expect(render([choice({ version: 1 })])).toContain(
      "Confirm current component readings",
    );
    expect(render([choice({})])).not.toContain("Confirm current");
  });
});

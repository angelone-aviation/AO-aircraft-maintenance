/**
 * Responsibility: Pins when the template activation form refuses to save,
 *   which last compliance it asks for, and what its next-due preview shows.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ActivateTemplate.tsx, src/domain
 *   (inspectionTemplates emptyTemplate), src/data/demo.ts (demoSnapshot),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  emptyTemplate,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import type { Component } from "../domain/components";
import type { Snapshot } from "../domain/model";
import { ActivateTemplate } from "./ActivateTemplate";

type FormProps = {
  disabled: boolean;
  onChange: (data: FormData) => void;
  onSubmit: (data: FormData) => Promise<void>;
};
// The form's first three states (mode, target, preview) are seeded, and
// each preview it sets is recorded.
let seeds: unknown[] = [];
let previews: unknown[] = [];
let form: FormProps;
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    if (!seeds.length) return react.useState(init);
    const preview = seeds.length === 1;
    return [
      seeds.shift(),
      preview ? (v: unknown) => previews.push(v) : () => {},
    ];
  };
  return { ...react, useState };
});
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  AsyncForm: (props: FormProps & { children: ReactNode }) => {
    form = props;
    return createElement("form", null, props.children);
  },
}));
const workspace = {
  snapshot: demoSnapshot() as Snapshot,
  online: true,
  connected: true,
  backend: { activateTemplate: vi.fn(async () => {}) },
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children: string }) =>
    createElement("a", null, props.children),
}));

const aircraft = workspace.snapshot.aircraft[0];
const template = (extra: Partial<InspectionTemplate>): InspectionTemplate => ({
  ...emptyTemplate(),
  uuid: "00000000-0000-4000-8000-000000000001",
  name: "Phase 1",
  applicability: {
    kind: "aircraft",
    manufacturer: aircraft.make,
    model: aircraft.model,
    partNumber: "",
  },
  ...extra,
});
const render = (t: InspectionTemplate, mode: string, target = "") => {
  seeds = [mode, target, ""];
  previews = [];
  return renderToStaticMarkup(
    createElement(ActivateTemplate, { template: t, onDone: () => {} }),
  );
};
const data = (fields: Record<string, string>) => {
  const d = new FormData();
  for (const [key, value] of Object.entries(fields)) d.set(key, value);
  return d;
};

describe("ActivateTemplate", () => {
  it("refuses to save before a schedule is chosen and reviewed", async () => {
    render(template({ hours: 100, initialHours: 50 }), "");
    await expect(form.onSubmit(data({ reviewed: "on" }))).rejects.toThrow(
      "Choose an initial or recurring schedule.",
    );
    render(template({ hours: 100 }), "recurring");
    await expect(form.onSubmit(data({}))).rejects.toThrow(
      "Review applicability before saving.",
    );
    expect(workspace.backend.activateTemplate).not.toHaveBeenCalled();
  });

  it("blocks a second schedule of the same template, mode and target", () => {
    const t = template({ hours: 100 });
    const existing = {
      ...workspace.snapshot.inspections[0],
      aircraftUuid: aircraft.uuid,
      sourceKey: `template:${t.uuid}:recurring`,
    };
    workspace.snapshot = {
      ...workspace.snapshot,
      inspections: [...workspace.snapshot.inspections, existing],
    };
    expect(render(t, "recurring", aircraft.uuid)).toContain(
      "This schedule already exists.",
    );
    expect(form.disabled).toBe(true);
    expect(render(t, "initial", aircraft.uuid)).not.toContain("already");
    expect(form.disabled).toBe(false);
  });

  it("flags the schedule the server refuses once a template moves to a component model", () => {
    const t = template({ hours: 100 });
    const engine = {
      kind: "component",
      uuid: "engine-1",
      aircraftUuid: aircraft.uuid,
      installed: true,
      componentType: "Engine",
      manufacturer: "Lycoming",
      model: "IO-540",
      partNumber: "",
      serial: "L-1",
    } as Component;
    const earlier = {
      ...workspace.snapshot.inspections[0],
      aircraftUuid: aircraft.uuid,
      sourceKey: `template:${t.uuid}:recurring`,
    };
    workspace.snapshot = {
      ...workspace.snapshot,
      inspections: [...workspace.snapshot.inspections, earlier],
      management: [...(workspace.snapshot.management ?? []), engine],
    };
    const moved = template({
      hours: 100,
      applicability: {
        kind: "component",
        manufacturer: "Lycoming",
        model: "IO-540",
        partNumber: "",
      },
    });
    expect(render(moved, "recurring", engine.uuid)).toContain(
      "This schedule already exists.",
    );
    expect(form.disabled).toBe(true);
  });

  it("previews only absolute limits before a schedule is chosen", () => {
    render(template({ initialHours: 50, hours: 100, landings: 50 }), "");
    form.onChange(data({}));
    expect(previews).toEqual([""]);
    const absolute = template({
      initialHours: 50,
      hours: 100,
      hourMode: "ABSOLUTE",
      landings: 50,
      landingMode: "ABSOLUTE",
    });
    render(absolute, "");
    form.onChange(data({}));
    expect(previews).toEqual(["100 hours or 50 aircraft landings"]);
  });

  it("previews hours from the last compliance in tenths", () => {
    render(template({ hours: 0.2 }), "recurring");
    form.onChange(data({ lastHours: "0.1" }));
    expect(previews).toEqual(["0.3 hours"]);
  });

  it("counts landings from the last compliance unless they are absolute", () => {
    const landings = "Last complied at (aircraft total landings)";
    expect(render(template({ landings: 50 }), "recurring")).toContain(landings);
    form.onChange(data({ lastLandings: "10" }));
    expect(previews).toEqual(["60 aircraft landings"]);
    const absolute = template({ landings: 50, landingMode: "ABSOLUTE" });
    expect(render(absolute, "recurring")).not.toContain(landings);
    form.onChange(data({ lastLandings: "10" }));
    expect(previews).toEqual(["50 aircraft landings"]);
  });
});

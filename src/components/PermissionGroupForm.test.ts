/**
 * Responsibility: Pins the permission group form's aircraft choice (#34), the
 *   programs it offers, and the group it saves.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/PermissionGroupForm.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { CHOOSE_GROUP_AIRCRAFT } from "../domain/groupAircraft";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import type { Group, Snapshot } from "../domain/model";
import { GroupForm } from "./PermissionGroupForm";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const form = vi.hoisted(() => ({
  submit: undefined as undefined | ((data: FormData) => Promise<void>),
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace.state, {
    getState: () => workspace.state,
  }),
}));
vi.mock("./ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("./ui")>();
  return {
    ...ui,
    AsyncForm: (props: Parameters<typeof ui.AsyncForm>[0]) => {
      form.submit = props.onSubmit;
      return ui.AsyncForm(props);
    },
  };
});

let s: Snapshot;
const saveGroup = vi.fn();
const REVIEW = { reason: "no_history", aircraftBefore: [] } as unknown;

beforeEach(() => {
  s = demoSnapshot();
  saveGroup.mockReset();
  const backend = { saveGroup };
  workspace.state = { snapshot: s, backend, online: true, connected: true };
});

function group(overrides: Partial<Group> = {}): Group {
  const programUuid = s.activeProgramUuid;
  return {
    id: "g1",
    name: "Crew",
    programUuid,
    aircraftIds: [],
    permissions: ["read"],
    ...overrides,
  };
}

function render(initial?: Group, review?: unknown) {
  return renderToStaticMarkup(
    h(GroupForm, {
      initial,
      review: review as GroupAccessReport | undefined,
      onDone: () => undefined,
    }),
  );
}

function submit(fields: [string, string][] = [["name", "Crew"]]) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return form.submit!(data);
}

// The "All aircraft" radio, then "Only selected aircraft".
const radios = (html: string) => html.match(/<input type="radio"[^>]*>/g)!;

describe("aircraft choice", () => {
  it("starts a new group with no aircraft choice and refuses to save it", async () => {
    expect(radios(render()).join("")).not.toContain("checked");
    await expect(submit()).rejects.toThrow(CHOOSE_GROUP_AIRCRAFT);
    expect(saveGroup).not.toHaveBeenCalled();
  });

  it("keeps an existing all-aircraft group's choice and saves it explicitly", async () => {
    const [all, selected] = radios(render(group()));
    expect(all).toContain('checked=""');
    expect(selected).not.toContain("checked");
    await submit([
      ["name", "Crew"],
      ["permissions", "flight"],
    ]);
    expect(saveGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        aircraftIds: [],
        allAircraft: true,
        permissions: ["read", "flight"],
      }),
    );
  });

  it("asks again when the change log cannot confirm all-aircraft access", async () => {
    const html = render(group(), REVIEW);
    expect(radios(html).join("")).not.toContain("checked");
    expect(html).toContain("Confirm aircraft access.");
    await expect(submit()).rejects.toThrow(CHOOSE_GROUP_AIRCRAFT);
  });
});

describe("administrator and owner groups", () => {
  it("lets a Flight Program administrator group skip the choice", async () => {
    const html = render(group({ programAdmin: true }));
    expect(html).toContain("Flight Program administrators can access every");
    await submit();
    expect(saveGroup).toHaveBeenCalledWith(
      expect.objectContaining({ programAdmin: true, allAircraft: true }),
    );
  });

  it("saves an owner group as read-only with its named aircraft", async () => {
    const aircraftIds = [s.aircraft[0].uuid];
    render(group({ owner: true, aircraftIds }));
    await submit([
      ["name", "Owners"],
      ["permissions", "flight"],
    ]);
    expect(saveGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: true,
        permissions: ["read"],
        aircraftIds,
        allAircraft: undefined,
      }),
    );
  });
});

describe("Flight Program", () => {
  it("offers other administrators only the active program", () => {
    const other = { ...s.programs![0], uuid: "other", name: "Other" };
    s.programs = [...s.programs!, other];
    s.user = { ...s.user, isAdmin: false };
    expect(render()).not.toContain(">Other</option>");
    s.user = { ...s.user, isAdmin: true };
    expect(render()).toContain(">Other</option>");
  });

  it("locks an existing group's program", () => {
    expect(render(group())).toMatch(/<select[^>]*disabled=""/);
    expect(render()).not.toMatch(/<select[^>]*disabled=""/);
  });

  it("keeps another program's group aircraft without the retired unscoped-group note", async () => {
    const other = { ...s.programs![0], uuid: "other", name: "Other" };
    s.programs = [...s.programs!, other];
    const aircraftIds = ["other-a", "other-b"];
    const html = render(group({ programUuid: "other", aircraftIds }));
    expect(html).toContain("Switch the active program to configure");
    expect(html).not.toContain("chosen earlier");
    await submit();
    expect(saveGroup).toHaveBeenCalledWith(
      expect.objectContaining({ programUuid: "other", aircraftIds }),
    );
  });
});

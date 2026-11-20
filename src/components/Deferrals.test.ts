/**
 * Responsibility: Pins how a deferral's status reads while open, expired and
 *   resolved, and what the defer form asks for and sends.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Deferrals.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Deferral } from "../domain/deferrals";
import { localDate } from "../domain/model";
import { DeferDiscrepancyForm, DeferralStatus } from "./Deferrals";

const form = vi.hoisted(() => ({
  choices: new Map<unknown, unknown>(),
  submit: undefined as undefined | ((data: FormData) => Promise<void>),
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  // The form's states are its basis ("mel") and category ("B"); a test
  // chooses them by their initial value.
  return {
    ...react,
    useState: (initial: unknown) => [
      form.choices.get(initial) ?? initial,
      () => {},
    ],
  };
});
vi.mock("../data/store", () => ({ useWorkspace: () => form.workspace }));
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

const DAY_MS = 86_400_000;
const report = demoSnapshot().discrepancies[0];
const calls: unknown[] = [];

beforeEach(() => {
  form.choices.clear();
  calls.length = 0;
  form.workspace = {
    online: true,
    connected: true,
    snapshot: demoSnapshot(),
    backend: {
      deferDiscrepancy: async (command: unknown) => calls.push(command),
    },
  };
});

function status(deferral: Partial<Deferral>, open = true) {
  const recorded = {
    type: "mel",
    melItem: "21-1",
    category: "B",
    placard: "INOP",
    deferredOn: "2026-10-01",
    deferredAt: 0,
    deferredBy: "demo-admin",
    deferredByName: "Alex Morgan",
    ...deferral,
  } as Deferral;
  const discrepancy = { ...report, deferral: recorded };
  discrepancy.status = open ? "open" : "resolved";
  return renderToStaticMarkup(h(DeferralStatus, { report: discrepancy }));
}

const inDays = (days: number) => localDate(Date.now() + days * DAY_MS);

describe("DeferralStatus", () => {
  it("counts the days left of an open deferral", () => {
    const html = status({ expiresOn: inDays(3) });
    expect(html).toContain(
      '<span class="ds-pill ds-tone-warn"><span class="ds-pill-dot" aria-hidden="true"></span>Deferred</span>',
    );
    expect(html).toContain(`Expires ${inDays(3)} · 3 days remaining`);
    expect(status({ expiresOn: inDays(1) })).toContain("· 1 day remaining");
  });

  it("grounds the aircraft once an open deferral expires", () => {
    const html = status({ expiresOn: inDays(-1) });
    expect(html).toContain(
      '<span class="ds-pill ds-tone-danger"><span class="ds-pill-dot" aria-hidden="true"></span>Deferral expired</span>',
    );
    expect(html).toContain("The aircraft is grounded until this is resolved.");
  });

  it("names the day the defect was found, else the report's date", () => {
    expect(status({ foundOn: "2026-09-28" })).toContain(
      "Found 2026-09-28 · deferred by Alex Morgan on 2026-10-01",
    );
    expect(status({})).toContain(
      `Found ${localDate(report.createdAt)} · deferred by Alex Morgan`,
    );
  });

  it("has no expiry under 91.213(d), and ends with the discrepancy", () => {
    expect(status({ type: "91.213d" })).toContain(
      "No expiry under 91.213(d); repair at the next required inspection.",
    );
    const resolved = status({ expiresOn: inDays(-1) }, false);
    expect(resolved).toContain(
      '<span class="ds-pill ds-tone-neutral"><span class="ds-pill-dot" aria-hidden="true"></span>Deferred</span>',
    );
    expect(resolved).toContain(
      "Deferral ended when the discrepancy was resolved.",
    );
  });
});

describe("DeferDiscrepancyForm", () => {
  function render(basis = "mel", category = "B") {
    form.choices.set("mel", basis).set("B", category);
    return renderToStaticMarkup(
      h(DeferDiscrepancyForm, {
        uuid: report.uuid,
        onDone: () => calls.push("done"),
      }),
    );
  }

  function submit(fields: Record<string, string>) {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return form.submit!(data);
  }

  it("asks when the defect was found, starting from the report's date", () => {
    const reported = localDate(report.createdAt);
    expect(render()).toMatch(
      new RegExp(
        `<input type="date" required="" max="${reported}" [^>]*name="foundOn" value="${reported}"/>`,
      ),
    );
    expect(render("91.213d")).toContain('name="foundOn"');
  });

  it("asks for MEL days only in category A", () => {
    expect(render()).toContain(
      "3 calendar days after the day the defect was found.",
    );
    expect(render()).not.toContain('name="days"');
    expect(render("mel", "D")).not.toContain('name="days"');
    const a = render("mel", "A");
    expect(a).toContain("Enter the interval stated in the MEL item.");
    expect(a).toMatch(/type="number" min="1" max="365"[^>]*name="days"/);
  });

  it("asks a 91.213(d) deferral to confirm the equipment is no hazard", () => {
    const html = render("91.213d");
    expect(html).toContain(
      '<input type="checkbox" required="" name="notHazard"/>',
    );
    expect(html).not.toContain('name="melItem"');
  });

  it("sends the parsed deferral with the found date and today's, then closes", async () => {
    render("mel", "A");
    await submit({
      foundOn: "2026-09-28",
      melItem: " 21-1 ",
      days: "5",
      placard: "INOP",
    });
    expect(calls).toEqual([
      {
        uuid: report.uuid,
        foundOn: "2026-09-28",
        deferredOn: localDate(),
        deferral: {
          type: "mel",
          melItem: "21-1",
          category: "A",
          days: 5,
          placard: "INOP",
        },
      },
      "done",
    ]);
  });

  it("refuses with the first schema issue and sends nothing", async () => {
    render();
    await expect(submit({ melItem: "21-1", placard: " " })).rejects.toThrow(
      "Enter the placard text.",
    );
    expect(calls).toEqual([]);
  });

  it("disables recording without a connection", () => {
    form.workspace.connected = false;
    expect(render()).toContain("<fieldset disabled");
  });
});

// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { FlightForm } from "./FlightForm";
let snapshot = demoSnapshot();
const enqueue = vi.fn();
let submit: ((data: FormData) => Promise<void>) | undefined;
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    AsyncForm: (props: ComponentProps<typeof actual.AsyncForm>) => {
      submit = props.onSubmit;
      return createElement(actual.AsyncForm, props);
    },
  };
});
vi.mock("../data/store", () => {
  const state = () => ({ snapshot, enqueue, online: true, connected: true });
  return { useWorkspace: Object.assign(state, { getState: state }) };
});
beforeEach(() => {
  snapshot = demoSnapshot();
  enqueue.mockReset();
});
function render(phase: "preflight" | "end", turbine: boolean, twin = false) {
  snapshot.aircraft[0].turbine = turbine;
  snapshot.aircraft[0].twin = twin;
  return renderToStaticMarkup(
    createElement(FlightForm, {
      aircraftUuid: snapshot.aircraft[0].uuid,
      phase,
      onDone: () => {},
    }),
  );
}
it("collects preflight fluids without closing meters or engine start readings", () => {
  const html = render("preflight", true);
  expect(html).toContain("Save preflight &amp; start flight");
  expect(html).toContain("Fuel starting level");
  expect(html).toContain("oil starting level");
  expect(html).not.toContain('name="hobbs"');
  expect(html).not.toContain('name="tach"');
  expect(html).not.toContain("Start max EGT");
  expect(html).not.toContain("Fuel shutdown level");
  expect(html).not.toContain('name="discrepancy"');
});
it("collects closing meters and turbine start readings at end flight", () => {
  const html = render("end", true, true);
  expect(html).toContain('name="hobbs"');
  expect(html).toContain('name="left-start-duration"');
  expect(html).toContain('name="right-start-egt"');
  expect(html).toContain("Fuel shutdown level");
  expect(html).not.toContain("oil starting level");
  expect(html).toContain("End flight &amp; save");
});
it("omits engine start fields for non-turbine aircraft", () => {
  const html = render("end", false, true);
  expect(html).not.toContain("-start-duration");
  expect(html).not.toContain("-start-egt");
});

it("retains the plan link when ending a restored session without the plan object", async () => {
  const planUuid = crypto.randomUUID();
  renderToStaticMarkup(
    createElement(FlightForm, {
      aircraftUuid: snapshot.aircraft[0].uuid,
      phase: "end",
      prefill: { flightPlanUuid: planUuid },
      onDone: () => {},
    }),
  );
  const data = new FormData();
  for (const [key, value] of Object.entries({
    pilot: snapshot.user.id,
    time: "2026-01-01T10:00",
    hobbs: "123.4",
    tach: "123.4",
    origin: "AAA",
    destination: "BBB",
    cycles: "1",
    landings: "1",
    operation: "Mission",
    rules: "VFR",
  }))
    data.set(key, value);
  await submit!(data);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "flight",
      input: expect.objectContaining({ flightPlanUuid: planUuid }),
    }),
  );
});
it("shows grounding reasons, requires an administrator override and disables saving for others", () => {
  snapshot.discrepancies.push({
    uuid: "grounding",
    aircraftUuid: snapshot.aircraft[0].uuid,
    description: "Alternator inoperative",
    status: "open",
    grounding: true,
    authorId: snapshot.user.id,
    createdAt: 0,
  });
  const html = render("preflight", false);
  expect(html).toContain("N206MA is grounded.");
  expect(html).toContain("Open discrepancy: Alternator inoperative");
  expect(html).toContain("Administrator dispatch override reason");
  // Administrators stay enabled with a required override field.
  expect(html).toContain("<form><fieldset>");
  expect(html).toMatch(/<textarea[^>]*minLength="10"[^>]*required/);
  const pilot = renderToStaticMarkup(
    createElement(FlightForm, {
      aircraftUuid: snapshot.aircraft[0].uuid,
      onDone: () => {},
      dispatchOverrideReason: "Ferry flight to repair shop",
    }),
  );
  expect(pilot).toContain("Ferry flight to repair shop");
  snapshot.user = { ...snapshot.members[1] };
  const blocked = renderToStaticMarkup(
    createElement(FlightForm, {
      aircraftUuid: snapshot.aircraft[0].uuid,
      onDone: () => {},
    }),
  );
  expect(blocked).toContain("Ask a Flight Program administrator");
  expect(blocked).toContain('<form><fieldset disabled="">');
});

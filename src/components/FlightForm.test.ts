/**
 * Responsibility: Pins what the flight form collects in each phase, how it
 *   saves new flights (behind the user's own unsynced legs too), preflights
 *   and reviews, and the dispatch gate.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightForm.tsx, src/data/demo.ts
 *   (demoSnapshot), src/domain/model.ts (types), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { QueuedOperation } from "../domain/model";
import { FlightForm } from "./FlightForm";
let snapshot = demoSnapshot();
let online = true;
let queue: QueuedOperation[] = [];
const enqueue = vi.fn();
const replace = vi.fn();
const backend = { review: vi.fn() };
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
// Term tips link through the router, which these tests do not mount.
vi.mock("./TermTip", () => ({ TermTip: () => null }));
vi.mock("../data/store", () => {
  const state = () => ({
    snapshot,
    queue,
    enqueue,
    replace,
    backend,
    online,
    connected: true,
  });
  return { useWorkspace: Object.assign(state, { getState: state }) };
});
beforeEach(() => {
  snapshot = demoSnapshot();
  online = true;
  queue = [];
  enqueue.mockReset();
  replace.mockReset();
  backend.review.mockReset();
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
const flightData = () => {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    pilot: snapshot.user.id,
    time: "2026-01-01T10:00",
    hobbs: "123.4",
    tach: "123.4",
    origin: "AAA",
    destination: "BBB",
    landings: "1",
    operation: "Mission",
    rules: "VFR",
    reason: "Counter corrected",
  }))
    data.set(key, value);
  return data;
};
const form = (props: Partial<ComponentProps<typeof FlightForm>>) =>
  renderToStaticMarkup(
    createElement(FlightForm, {
      aircraftUuid: snapshot.aircraft[0].uuid,
      onDone: () => {},
      ...props,
    }),
  );
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

it("prefills the discrepancy a failed entry carried on Edit and retry", () => {
  const html = form({
    prefill: { discrepancy: "Left brake pedal soft on rollout" },
    replaces: crypto.randomUUID(),
  });
  expect(html).toMatch(
    /<textarea name="discrepancy"[^>]*>Left brake pedal soft on rollout<\/textarea>/,
  );
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
it("lets a pilot end a flight the aircraft was grounded after it began, to be held", async () => {
  const startTime = "2026-01-01T10:00:00.000Z";
  const report = (createdAt: number) => ({
    uuid: `grounding-${createdAt}`,
    aircraftUuid: snapshot.aircraft[0].uuid,
    description: "Hard landing",
    status: "open" as const,
    grounding: true,
    authorId: snapshot.user.id,
    createdAt,
  });
  snapshot.user = { ...snapshot.members[1] };
  snapshot.discrepancies.push(report(Date.parse(startTime) + 60_000));
  const end = () => form({ phase: "end", prefill: { startTime } });
  const html = end();
  expect(html).toContain("N206MA was grounded during this flight.");
  expect(html).not.toContain("N206MA is grounded.");
  expect(html).toContain("<form><fieldset>");
  await submit!(flightData());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ dispatchOverrideReason: undefined }),
  );
  // Logging a new flight is still gated, as is an end when the aircraft
  // was grounded before take-off.
  expect(form({})).toContain('<form><fieldset disabled="">');
  snapshot.discrepancies.push(report(Date.parse(startTime) - 60_000));
  expect(end()).toContain('<form><fieldset disabled="">');
});
it("refuses a preflight it has no way to save", async () => {
  form({ phase: "preflight" });
  await expect(submit!(flightData())).rejects.toThrow(
    "Preflight saving is unavailable.",
  );
  expect(enqueue).not.toHaveBeenCalled();
});
it("departs IFR from a plan filed I or Y, and VFR otherwise", () => {
  const plan = (flightRules: string) =>
    ({
      uuid: crypto.randomUUID(),
      aircraftUuid: snapshot.aircraft[0].uuid,
      departureAt: "2026-11-05T08:00:00.000Z",
      flightRules,
      route: "DCT",
    }) as ComponentProps<typeof FlightForm>["plan"];
  const checked = (rules: string) =>
    form({ plan: plan(rules) }).match(/checked="" value="(\w+)"/)?.[1];
  expect(form({}).match(/checked="" value="(\w+)"/)?.[1]).toBe("VFR");
  expect(["I", "Y", "V", "Z"].map(checked)).toEqual([
    "IFR",
    "IFR",
    "VFR",
    "VFR",
  ]);
});
it("names an R66's turbine cycles as engine starts", () => {
  snapshot.aircraft[0].turbine = true;
  snapshot.aircraft[0].model = " r66 ";
  expect(form({})).toContain("Engine start cycles");
  snapshot.aircraft[0].model = "206";
  expect(form({})).not.toContain("Engine start cycles");
});
it("queues a new flight against its opening version without legacy oil ends", async () => {
  const oil = [
    { engine: "single" as const, unit: "US qt" as const, start: 5, end: 6 },
  ];
  snapshot.aircraft[0].version = 4;
  form({ prefill: { oil } });
  await submit!(flightData());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      baseVersion: 4,
      input: expect.objectContaining({
        oil: [{ engine: "single", unit: "US qt", start: 5 }],
      }),
    }),
  );
});
it("opens behind the user's own unsynced leg on its ending readings and version", async () => {
  const a = snapshot.aircraft[0];
  a.version = 4;
  queue = [
    {
      queuedAt: 1,
      operation: {
        kind: "flight",
        uuid: "leg-1",
        authorId: snapshot.user.id,
        baseVersion: 4,
        input: {
          aircraftUuid: a.uuid,
          pilotId: snapshot.user.id,
          startTime: "2026-01-01T08:00:00.000Z",
          hobbsOn: a.currentHobbs + 3600,
          tachOn: a.currentTach + 3600,
          landings: 1,
          cycles: 0,
          origin: "AAA",
          destination: "BBB",
          operation: "Mission",
          flightRules: "VFR",
          remarks: "",
          discrepancy: "",
        },
      },
    },
  ];
  const html = form({});
  expect(html).toContain(((a.currentHobbs + 3600) / 3600).toFixed(1));
  expect(html).not.toContain("readings changed");
  await submit!(flightData());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ baseVersion: 5 }),
  );
  // Edit and retry of that same entry does not count it as an earlier leg.
  form({ replaces: "leg-1" });
  await submit!(flightData());
  expect(replace).toHaveBeenCalledWith(
    "leg-1",
    expect.objectContaining({ baseVersion: 4 }),
  );
});
it("reviews a held flight online only, keeping its stored oil", async () => {
  const held = {
    uuid: "held",
    aircraftUuid: snapshot.aircraft[0].uuid,
    startTime: "2026-01-01T10:00:00.000Z",
    status: "review",
    oil: [
      { engine: "single" as const, unit: "US qt" as const, start: 5, end: 6 },
    ],
  } as ComponentProps<typeof FlightForm>["initial"];
  online = false;
  expect(form({ initial: held })).toContain('<form><fieldset disabled="">');
  online = true;
  form({ initial: held });
  await submit!(flightData());
  expect(backend.review).toHaveBeenCalledWith(
    "held",
    "accept",
    "Counter corrected",
    expect.objectContaining({ oil: held!.oil }),
  );
});

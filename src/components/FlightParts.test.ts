/**
 * Responsibility: Pins the labelling, hint wiring and flight time states of
 *   the flight form building blocks.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightParts.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FlightField,
  FlightSection,
  FlightTimeStrip,
  MeterBox,
} from "./FlightParts";

const render = (element: ReactElement) => renderToStaticMarkup(element);
const endInput = () => h("input", { name: "end" });
const idOf = (html: string, pattern: RegExp) => pattern.exec(html)?.[1];

describe("FlightSection", () => {
  it("names the section and ids the hint for inputs to reference", () => {
    const html = render(
      h(FlightSection, {
        title: "Meters",
        hint: "Verify",
        hintId: "h1",
        label: "Readings",
        children: "body",
      }),
    );
    expect(html).toContain(
      '<section class="flight-section" aria-label="Readings">',
    );
    expect(html).toMatch(
      /<span class="flight-section-hint" id="h1">.*Verify<\/span>/,
    );
  });

  it("leaves out the hint when none is given", () => {
    expect(
      render(h(FlightSection, { title: "Meters", children: "body" })),
    ).not.toContain("flight-section-hint");
  });
});

describe("FlightField", () => {
  it("ties a single element child to its label and hint", () => {
    const html = render(
      h(FlightField, {
        label: "Pilot",
        hint: "As on the certificate",
        children: endInput(),
      }),
    );
    const id = idOf(html, /<label for="([^"]+)">/);
    expect(html).toContain(
      `<input id="${id}" aria-describedby="${id}-hint" name="end"/>`,
    );
    expect(html).toContain(
      `<small id="${id}-hint">As on the certificate</small>`,
    );
  });

  it("points no aria-describedby anywhere without a hint", () => {
    expect(
      render(h(FlightField, { label: "Pilot", children: endInput() })),
    ).not.toContain("aria-describedby");
  });

  it("renders a non-element child as is", () => {
    expect(
      render(h(FlightField, { label: "Pilot", children: "plain" })),
    ).toMatch(/<\/label>plain<\/div>/);
  });

  it("spans the row when wide", () => {
    expect(
      render(
        h(FlightField, { label: "Notes", wide: true, children: endInput() }),
      ),
    ).toContain('class="field flight-field flight-wide"');
  });
});

describe("MeterBox", () => {
  it("shows the start as a labelled read-only input, described by describedBy", () => {
    const html = render(
      h(MeterBox, {
        startLabel: "Starting Hobbs",
        startSrSuffix: " (hours)",
        startValue: "12.3",
        describedBy: "d1",
      }),
    );
    const id = idOf(
      html,
      /<label for="([^"]+)" class="flight-meter-label">Starting Hobbs/,
    );
    expect(html).toContain('<span class="flight-sr-only"> (hours)</span>');
    expect(html).toContain(
      `<input id="${id}" readOnly="" size="4" aria-describedby="d1" value="12.3"/>`,
    );
    expect(html).toContain(
      '<span class="flight-meter-unit" aria-hidden="true">h</span>',
    );
  });

  it("is start-only without an end input", () => {
    expect(
      render(h(MeterBox, { startLabel: "S", startValue: "1.0" })),
    ).toContain('<div class="flight-meter start-only">');
  });

  it("drops the h unit when the start is Unknown", () => {
    expect(
      render(h(MeterBox, { startLabel: "S", startValue: "Unknown" })),
    ).not.toContain("flight-meter-unit");
    expect(
      render(
        h(MeterBox, {
          startInput: false,
          startLabel: "S",
          startValue: "Unknown",
        }),
      ),
    ).not.toContain("flight-meter-unit");
  });

  it("shows the start as plain text when startInput is false", () => {
    const html = render(
      h(MeterBox, {
        startInput: false,
        startLabel: "Preflight Hobbs",
        startValue: "3.4",
      }),
    );
    expect(html).not.toContain("<input");
    expect(html).toContain(
      '<span class="flight-meter-label">Preflight Hobbs</span><span class="flight-meter-readout"><strong>3.4</strong><span class="flight-meter-unit">h</span>',
    );
  });

  it("ties the end input to its label and the hint", () => {
    const html = render(
      h(MeterBox, {
        startLabel: "S",
        startValue: "1.0",
        endLabel: "Ending Hobbs",
        endInput: endInput(),
        hint: "Cumulative hours",
      }),
    );
    const endId = idOf(
      html,
      /<label for="([^"]+)" class="flight-meter-label">Ending Hobbs/,
    );
    const hintId = idOf(
      html,
      /<small class="flight-meter-hint" id="([^"]+)">Cumulative hours/,
    );
    expect(html).toContain('<div class="flight-meter">');
    expect(html).toContain(
      `<input id="${endId}" aria-describedby="${hintId}" name="end"/>`,
    );
  });

  it("keeps the hint when there is no end input", () => {
    expect(
      render(
        h(MeterBox, { startLabel: "S", startValue: "1.0", hint: "Read-only" }),
      ),
    ).toMatch(
      /<small class="flight-meter-hint" id="[^"]+-hint">Read-only<\/small>/,
    );
  });
});

describe("FlightTimeStrip", () => {
  const strip = (startSeconds: number | undefined, endHours: string) =>
    render(
      h(FlightTimeStrip, {
        meterLabel: "Hobbs",
        entryName: "Hobbs",
        startSeconds,
        endHours,
      }),
    );

  it.each([
    ["", "Enter ending Hobbs"],
    ["  ", "Enter ending Hobbs"],
    ["abc", "Enter ending Hobbs"],
  ])("prompts for the end while %j is typed", (endHours, text) => {
    const html = strip(7200, endHours);
    expect(html).toContain(
      '<div class="flight-delta neutral" aria-live="polite">',
    );
    expect(html).toContain(`<strong>${text}</strong>`);
  });

  it("says when the starting reading is unknown", () => {
    const html = strip(undefined, "1.5");
    expect(html).toContain('class="flight-delta neutral"');
    expect(html).toContain("<strong>Starting reading unknown</strong>");
  });

  it("warns when the end is before the start", () => {
    const html = strip(7200, "1.9");
    expect(html).toContain('class="flight-delta danger"');
    expect(html).toContain("<strong>Ending is before start</strong>");
  });

  it("shows the difference in hours to one decimal, zero included", () => {
    expect(strip(7200, "2.26")).toContain("<strong>0.3 h</strong>");
    expect(strip(7200, "2")).toContain('class="flight-delta good"');
    expect(strip(7200, "2")).toContain("<strong>0.0 h</strong>");
  });

  it("names the meter beside the label", () => {
    expect(strip(7200, "")).toContain(
      '<span class="flight-delta-meter">· Hobbs</span>',
    );
  });
});

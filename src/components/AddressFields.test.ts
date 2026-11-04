/**
 * Responsibility: Pins the address fields' labels and order, the legacy
 *   note, the hidden form input and when lookup is offered. Editing, lookup
 *   and confirming need a browser: tests/e2e/addresses.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AddressFields.tsx, src/domain/addresses.ts,
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blankAddress } from "../domain/addresses";
import { AddressFields } from "./AddressFields";

const workspace = { online: true, connected: true, backend: null };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
beforeEach(() => {
  workspace.online = true;
  workspace.connected = true;
});

const render = (props: Partial<ComponentProps<typeof AddressFields>>) =>
  renderToStaticMarkup(
    createElement(AddressFields, { label: "Ship", ...props }),
  );
const lookupButton = (html: string) =>
  html.match(/<button[^>]*>Look up address<\/button>/)?.[0];
const LEGACY_NOTE = "Existing address retained below.";

describe("AddressFields", () => {
  it("labels each field with the fieldset's label, in form order", () => {
    const labels = [...render({}).matchAll(/<label[^>]*>([^<]*)</g)];
    expect(labels.map((m) => m[1])).toEqual(
      [
        "Company / organization",
        "Street address",
        "Apartment / suite / building",
        "City",
        "State / province",
        "ZIP / postal code",
        "Country",
        "Contact name",
        "Email",
        "Phone",
      ].map((title) => `Ship — ${title}`),
    );
  });

  it("starts from the legacy address and contact, with a note to split it", () => {
    const html = render({ legacy: "1 Old Rd", contactName: "Bo", name: "a" });
    expect(html).toContain(LEGACY_NOTE);
    expect(html).toContain(
      `value="${JSON.stringify(blankAddress("1 Old Rd", "Bo")).replaceAll('"', "&quot;")}"`,
    );
  });

  it("drops the legacy note once a value is given", () => {
    const value = blankAddress("1 New St");
    expect(render({ legacy: "1 Old Rd", value })).not.toContain(LEGACY_NOTE);
  });

  it("submits nothing without a name", () => {
    expect(render({})).not.toContain('type="hidden"');
  });

  it("says whether the address is confirmed", () => {
    const value = { ...blankAddress(), confirmed: true };
    expect(render({ value })).toContain("Confirmed by you.");
    expect(render({})).toContain("Review the full address");
  });

  it("offers lookup only when online and connected", () => {
    expect(lookupButton(render({}))).not.toContain("disabled");
    workspace.connected = false;
    expect(lookupButton(render({}))).toContain("disabled");
    workspace.connected = true;
    workspace.online = false;
    expect(lookupButton(render({}))).toContain("disabled");
  });
});

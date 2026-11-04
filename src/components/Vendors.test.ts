/**
 * Responsibility: Pins new vendor records, who sees the Vendors screen, and
 *   when the vendor picker offers to add a name. Adding and editing need a
 *   browser: tests/e2e/vendors.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Vendors.tsx, src/data/demo.ts (demoSnapshot),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Vendor } from "../domain/management";
import type { Snapshot } from "../domain/model";
import { VendorPicker, Vendors, newVendor } from "./Vendors";

const workspace = { snapshot: null as Snapshot | null, online: true };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
// Keeps the props of each field's input so a test can call its handlers.
const inputs: { onBlur?: () => void }[] = [];
vi.mock("./ui", async (original) => {
  const ui = await original<typeof import("./ui")>();
  const Field = (props: Parameters<typeof ui.Field>[0]) => {
    inputs.push((props.children as { props: object }).props);
    return ui.Field(props);
  };
  return { ...ui, Field };
});

const acme = { ...newVendor("Acme Aero"), version: 1 };
const picker = (value: string, extra = {}) => {
  const changes: unknown[][] = [];
  const html = renderToStaticMarkup(
    createElement(VendorPicker, {
      value,
      options: [acme],
      onChange: (...args: unknown[]) => changes.push(args),
      onAdd: async () => {},
      ...extra,
    }),
  );
  return { html, changes };
};

describe("newVendor", () => {
  it("is an unsaved record named New vendor unless named", () => {
    expect(newVendor()).toMatchObject({ version: 0, name: "New vendor" });
    expect(newVendor("Acme").name).toBe("Acme");
    expect(newVendor().uuid).not.toBe(newVendor().uuid);
  });
});

describe("Vendors", () => {
  const render = () => renderToStaticMarkup(createElement(Vendors));

  it("is for program administrators only", () => {
    const base = demoSnapshot();
    workspace.snapshot = { ...base, user: { ...base.user, isAdmin: false } };
    expect(render()).toContain("Inventory administrator access required");
  });

  it("lists vendors with their order counts", () => {
    workspace.snapshot = {
      ...demoSnapshot(),
      management: [acme],
      purchaseOrders: [{ vendor: " acme aero " }] as Snapshot["purchaseOrders"],
    };
    expect(render()).toContain("Acme Aero");
    expect(render()).toContain("1 order<");
  });
});

describe("VendorPicker", () => {
  it("offers to add a name that matches no vendor", () => {
    const { html } = picker(" New Co ");
    expect(html).toContain("Vendor not found. Add “New Co”?");
    expect(html).toContain("Quick add");
    expect(html).toContain("Add vendor");
  });

  it("matches vendors ignoring case and surrounding spaces", () => {
    expect(picker(" ACME AERO ").html).not.toContain("Vendor not found");
  });

  it("offers only the custom label for a name-only picker", () => {
    const { html } = picker("New Co", {
      nameOnly: true,
      customLabel: "Use it",
    });
    expect(html).toContain(">Use it<");
    expect(html).not.toContain("Quick add");
    expect(html).not.toContain(">Add vendor<");
  });

  it("corrects a matching name to the vendor's spelling on blur", () => {
    inputs.length = 0;
    const { changes } = picker("acme aero");
    inputs[0].onBlur!();
    expect(changes).toEqual([["Acme Aero", acme as Vendor]]);
  });
});

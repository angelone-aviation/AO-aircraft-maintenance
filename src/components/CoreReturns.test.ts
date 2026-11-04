/**
 * Responsibility: Pins which core returns are listed, in what order, and the
 *   next-step button each offers. Toggling and saving need a browser.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/CoreReturns.tsx, src/domain/purchaseOrders.ts
 *   (types), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CoreReturn, PurchaseOrder } from "../domain/purchaseOrders";
import { CoreReturns } from "./CoreReturns";

const workspace = { online: true, connected: true };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const core = (partNumber: string, dueDate: string, status: string) =>
  ({ uuid: partNumber, partNumber, dueDate, status }) as CoreReturn;
const order = {
  uuid: "po",
  number: "PO-1",
  vendor: "Acme",
  coreReturns: [
    core("LATE", "2026-03-01", "shipped"),
    core("SOON", "2026-02-01", "pending"),
    core("DONE", "2026-01-01", "credited"),
  ],
} as PurchaseOrder;
const render = () =>
  renderToStaticMarkup(createElement(CoreReturns, { orders: [order] }));
const buttons = () =>
  [...render().matchAll(/<button[^>]*>([^<]*)</g)].map((m) => m[1]);

describe("CoreReturns", () => {
  it("lists open cores soonest due first, each with its next step", () => {
    expect(buttons()).toEqual([
      "Mark SOON core shipped",
      "Mark LATE core credited",
    ]);
  });

  it("hides credited cores until they are shown", () => {
    expect(render()).not.toContain("DONE");
  });

  it("disables the next steps offline or while disconnected", () => {
    workspace.connected = false;
    expect(render().match(/disabled=""/g)).toHaveLength(2);
    workspace.connected = true;
    workspace.online = false;
    expect(render().match(/disabled=""/g)).toHaveLength(2);
    workspace.online = true;
  });

  it("says so when no core is open", () => {
    expect(
      renderToStaticMarkup(createElement(CoreReturns, { orders: [] })),
    ).toContain("No open core returns.");
  });
});

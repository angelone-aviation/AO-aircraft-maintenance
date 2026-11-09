/**
 * Responsibility: Pins when the Generate logbook entry button is offered. The
 *   dialog needs a browser: tests/e2e/work-order-template-cards.spec.ts and
 *   logbook-wording.spec.ts cover it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/LogbookEntry.tsx, src/domain/workOrders.ts
 *   (WorkOrder type), react-dom/server.
 *
 * The signed page photos beside the button are stubbed; their own suite
 * covers them.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkOrder } from "../domain/workOrders";
import { LogbookEntryButton } from "./LogbookEntry";

vi.mock("./LogbookPhotos", () => ({ LogbookPhotoStrip: () => null }));

const render = (status: WorkOrder["status"]) =>
  renderToStaticMarkup(
    createElement(LogbookEntryButton, {
      order: { status, number: "WO-1" } as WorkOrder,
    }),
  );

describe("LogbookEntryButton", () => {
  it("is offered on a completed work order", () => {
    expect(render("completed")).toBe(
      '<button type="button" class="button">Generate logbook entry</button>',
    );
  });

  it("is withheld until the order is completed", () => {
    expect(render("open")).toBe("");
  });
});

/**
 * Responsibility: Pins how a work order another record names is shown: by
 *   the number the screen holds, else the loaded order's, else its uuid.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderNumber.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WorkOrderNumber } from "./WorkOrderNumber";

const data = vi.hoisted(() => ({
  held: [] as { uuid: string; number: string }[],
  loaded: undefined as { workOrder: { number: string } } | undefined,
  asked: [] as (string | undefined)[],
}));
vi.mock("../data/historyPages", () => ({
  useRecordsSnapshot: () => ({ workOrders: data.held }),
  useWorkOrderHistory: (uuid?: string) => {
    data.asked.push(uuid);
    return { history: data.loaded };
  },
}));

it("shows the held number, else loads the older order, else the uuid", () => {
  const render = () => renderToStaticMarkup(h(WorkOrderNumber, { uuid: "w" }));
  data.held = [{ uuid: "w", number: "WO-2026-0001" }];
  expect(render()).toBe("WO-2026-0001");
  expect(data.asked).toEqual([undefined]);
  data.held = [];
  expect(render()).toBe("w");
  data.loaded = { workOrder: { number: "WO-2019-0007" } };
  expect(render()).toBe("WO-2019-0007");
  expect(data.asked.at(-1)).toBe("w");
});

/**
 * Responsibility: Pins which aircraft and fields the movement form offers,
 *   the work order command it sends, and when it refuses.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/PlanComponentMovement.tsx, react-dom/server,
 *   src/data/demo.ts (seed), tests/fixtures/workOrders.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Component } from "../domain/components";
import type { Permission, Snapshot } from "../domain/model";
import { saveWorkOrder, type WorkOrderCommand } from "../domain/workOrders";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { PlanComponentMovement } from "./PlanComponentMovement";

const form = vi.hoisted(() => ({
  orderUuid: "",
  submit: undefined as undefined | ((data: FormData) => Promise<void>),
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  // The chosen work order starts as "" (a new order); a test picks another.
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(initial === "" ? form.orderUuid : initial),
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => form.workspace, {
    getState: () => form.workspace,
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
let sent: WorkOrderCommand[];

beforeEach(() => {
  s = demoSnapshot();
  s.workOrders = [];
  sent = [];
  form.orderUuid = "";
  form.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      workOrder: async (command: WorkOrderCommand) => sent.push(command),
    },
  };
});

function render(c: Component = workOrderComponent()) {
  s.management = [c];
  return renderToStaticMarkup(
    h(PlanComponentMovement, { c, onDone: () => {} }),
  );
}

function submit() {
  const data = new FormData();
  data.set("description", "Swap");
  data.set("shelf", "B-2");
  return form.submit!(data);
}

function openOrder() {
  const order = saveWorkOrder(s, workOrderCommand(), Date.now());
  form.orderUuid = order.uuid;
  return order;
}

describe("PlanComponentMovement", () => {
  it("removes an installed component from its own aircraft only", () => {
    const html = render();
    const own = s.aircraft[0].registration;
    expect(html).toContain(
      `<option value="${s.aircraft[0].uuid}" selected="">${own}</option>`,
    );
    expect(html).not.toContain(`>${s.aircraft[1].registration}</option>`);
    expect(html).toContain('<input maxLength="150" required="" id=');
  });

  it("asks where to install a loose component, on any aircraft", () => {
    const html = render({ ...workOrderComponent(), installed: false });
    expect(html).toContain("Installation position");
    expect(html).toContain(`>${s.aircraft[1].registration}</option>`);
  });

  it("offers no aircraft, and no saving, without maintenance permission", () => {
    const permissions: Permission[] = ["read", "flight"];
    const group = { ...s.groups[0], programAdmin: false, permissions };
    s.user = { ...s.user, isAdmin: false, groupIds: [group.id] };
    s.groups = [group];
    const html = render({ ...workOrderComponent(), installed: false });
    expect(html).not.toContain(`>${s.aircraft[0].registration}</option>`);
    expect(html).toContain("<fieldset disabled");
  });

  it("requires an inventory location instead of a shelf when there are some", () => {
    s.partsInventory = {
      locations: [
        { uuid: "loc", name: "Hangar", programUuid: s.aircraft[0].programUuid },
      ],
      stock: [],
    };
    const html = render();
    expect(html).toContain('<select name="location" required=""');
    expect(html).toContain('<input maxLength="150" id=');
  });

  it("opens a new work order with the movement as work and a task", async () => {
    render();
    await submit();
    const [command] = sent;
    expect(command).toMatchObject({
      action: "save",
      version: 0,
      fields: { scope: "Remove Engine P/N PN; S/N SN", status: "open" },
      componentWork: [
        {
          componentUuid: "engine",
          action: "remove",
          description: "Swap",
          partsLocation: "B-2",
        },
      ],
      tasks: [
        {
          description: "Remove Engine P/N PN; S/N SN. Swap",
          status: "requested",
        },
      ],
    });
  });

  it("adds the movement to a chosen open work order", async () => {
    const order = openOrder();
    render();
    await submit();
    expect(sent[0]).toMatchObject({
      uuid: order.uuid,
      fields: { scope: "Annual maintenance" },
    });
  });

  it("refuses a closed work order or one that already includes it", async () => {
    const order = openOrder();
    s.workOrders = [];
    render();
    await expect(submit()).rejects.toThrow(
      "This work order is no longer open.",
    );
    const work = {
      componentUuid: "engine",
      version: 0,
      action: "remove" as const,
      taskUuid: "t",
      description: "",
      reference: "",
    };
    s.workOrders = [{ ...order, componentWork: [work] }];
    render();
    await expect(submit()).rejects.toThrow(
      "This component is already included.",
    );
    expect(sent).toEqual([]);
  });
});

/**
 * Responsibility: Pins when a work order can be revised, the revise command
 *   sent, and how the current wording and earlier records are listed.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkOrderRevisions.tsx, react-dom/server,
 *   src/data/demo.ts (seed), tests/fixtures/workOrders.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Permission, Snapshot } from "../domain/model";
import {
  newWorkTask,
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
  type WorkOrderCommand,
} from "../domain/workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { WorkOrderRevisions } from "./WorkOrderRevisions";

const ui = vi.hoisted(() => ({
  submit: undefined as undefined | ((data: FormData) => Promise<void>),
  workspace: {} as Record<string, unknown>,
}));
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.submit = props.onSubmit;
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./LogbookPhotos", () => ({ LogbookPhotoStrip: () => null }));

const NOW = Date.parse("2026-10-02T12:00:00Z");
let s: Snapshot;
let sent: unknown[];

beforeEach(() => {
  s = demoSnapshot();
  sent = [];
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: { workOrder: async (command: unknown) => sent.push(command) },
  };
});

// A completed order for the first demo inspection, revised `count` times.
function closedOrder(count = 0) {
  const command = workOrderCommand();
  const inspection = s.inspections[0];
  command.tasks = [
    newWorkTask({ kind: "inspection", uuid: inspection.uuid }, "Inspect"),
  ];
  const open = saveWorkOrder(s, command, NOW);
  let order = saveWorkOrder(
    s,
    {
      ...command,
      version: open.version,
      tasks: open.tasks.map((t) => ({ ...t, status: "completed" as const })),
      fields: {
        ...workOrderFieldsSchema.parse(open),
        status: "completed",
        completionDate: "2026-10-02",
        releaseOutcome: "Original release",
        finalReview: "Original review",
      },
    },
    NOW,
  );
  for (let n = 1; n <= count; n++)
    order = saveWorkOrder(s, revise(order, `Fix ${n}`), NOW + n);
  return order;
}

function revise(order: WorkOrder, reason: string): WorkOrderCommand {
  return {
    action: "revise",
    uuid: order.uuid,
    version: order.version,
    reason,
    fields: {
      supervisor: `Supervisor after ${reason}`,
      scope: order.scope,
      releaseOutcome: "Corrected release",
      finalReview: order.finalReview,
      workPerformed: `Work after ${reason}`,
    },
  };
}

function render(order: WorkOrder, initiallyEditing = false) {
  return renderToStaticMarkup(
    h(WorkOrderRevisions, {
      order,
      onDone: () => sent.push("done"),
      initiallyEditing,
    }),
  );
}

describe("WorkOrderRevisions", () => {
  it("revises only a closed order, with a connection and maintenance permission", () => {
    const command = workOrderCommand();
    expect(render(saveWorkOrder(s, command, NOW))).toBe("");
    const order = closedOrder();
    expect(render(order)).toContain(
      'class="button">Revise work order</button>',
    );
    ui.workspace.connected = false;
    expect(render(order)).toContain('disabled="">Revise work order');
    ui.workspace.connected = true;
    const permissions: Permission[] = ["read", "flight"];
    const group = { ...s.groups[0], programAdmin: false, permissions };
    s.user = { ...s.user, isAdmin: false, groupIds: [group.id] };
    s.groups = [group];
    expect(render(order)).toContain('disabled="">Revise work order');
  });

  it("sends the revised record with its reason and the final review unchanged", async () => {
    const order = closedOrder();
    expect(render(order, true)).toMatch(/name="releaseOutcome" required=""/);
    const data = new FormData();
    for (const name of ["reason", "supervisor", "scope", "releaseOutcome"])
      data.set(name, `New ${name}`);
    data.set("workPerformed", "New wording");
    await ui.submit!(data);
    expect(sent).toEqual([
      {
        action: "revise",
        uuid: order.uuid,
        version: order.version,
        reason: "New reason",
        fields: {
          supervisor: "New supervisor",
          scope: "New scope",
          releaseOutcome: "New releaseOutcome",
          finalReview: "Original review",
          workPerformed: "New wording",
        },
      },
      "done",
    ]);
  });

  it("starts the wording from the latest revision, else the closeout", () => {
    const order = closedOrder();
    const closeout = { ...order.closeout!, workPerformed: "Closeout wording" };
    expect(render({ ...order, closeout }, true)).toContain(
      ">Closeout wording</textarea>",
    );
    expect(render(closedOrder(1), true)).toContain(
      ">Work after Fix 1</textarea>",
    );
  });

  it("lists earlier records newest first, the first as the original", () => {
    const html = render(closedOrder(2));
    expect(html).toContain("Revisions · Revision 2</h3>");
    const summaries = [...html.matchAll(/<summary>Revision (\d)/g)];
    expect(summaries.map((m) => m[1])).toEqual(["2", "1"]);
    expect(html).toContain("<h4>Record before revision 2</h4>");
    expect(html).toContain("<p>Supervisor: Supervisor after Fix 1</p>");
    expect(html).toContain("<h4>Original record</h4>");
    expect(html).toContain("<p>Reason: Fix 1</p>");
  });
});

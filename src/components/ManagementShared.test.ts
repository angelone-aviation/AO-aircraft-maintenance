/**
 * Responsibility: Pins the management form readers, the shared fields, the
 *   change-history views and the offline refusal of management commands.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ManagementShared.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagementCommand } from "../domain/management";
import {
  History,
  HistoryPager,
  NumberField,
  num,
  Reason,
  secs,
  today,
  useManagement,
} from "./ManagementShared";

const workspace = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setState: vi.fn(),
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace.state, {
    setState: workspace.setState,
  }),
}));
const audit = vi.hoisted(() => ({ history: {} as Record<string, unknown> }));
vi.mock("../data/auditHistory", () => ({
  useAuditHistory: () => audit.history,
}));

const render = (element: ReactElement) => renderToStaticMarkup(element);
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, text] of Object.entries(fields)) data.set(key, text);
  return data;
};
const page = (overrides: Record<string, unknown>) => ({
  entries: [],
  isDone: false,
  loading: false,
  error: "",
  loadMore: () => {},
  ...overrides,
});

beforeEach(() => {
  workspace.setState.mockReset();
});

describe("form readers", () => {
  it("reads a number field, blank or missing as undefined", () => {
    const data = form({ hours: " 1.5 ", blank: " ", text: "x" });
    expect(num(data, "hours")).toBe(1.5);
    expect(num(data, "blank")).toBeUndefined();
    expect(num(data, "missing")).toBeUndefined();
    expect(num(data, "text")).toBeNaN();
  });

  it("reads hours as seconds and refuses other text", () => {
    expect(secs(form({ h: "12.5" }), "h")).toBe(45_000);
    expect(secs(form({ h: "" }), "h")).toBeUndefined();
    expect(() => secs(form({ h: "1.25" }), "h")).toThrow(
      "Use hours of 0 or more, with at most one decimal place.",
    );
  });

  it("gives today's date as YYYY-MM-DD", () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("fields", () => {
  it("offers a number of zero or more, in tenths when decimal", () => {
    expect(render(h(NumberField, { name: "n", label: "Cycles" }))).toContain(
      '<input type="number" min="0" step="1" id="_R_0_" name="n"/>',
    );
    const decimal = render(
      h(NumberField, { name: "n", label: "Hours", initial: 3, decimal: true }),
    );
    expect(decimal).toContain('step="0.1"');
    expect(decimal).toContain('value="3"');
  });

  it("requires a reason of at most 2,000 characters", () => {
    expect(render(h(Reason))).toContain(
      '<textarea name="reason" required="" maxLength="2000"',
    );
  });
});

describe("change history", () => {
  it("says when a record has no changes", () => {
    audit.history = page({ isDone: true });
    expect(render(h(History, { uuid: "r1" }))).toContain(
      "No recorded changes.",
    );
  });

  it("lists each entry with its recorded values", () => {
    audit.history = page({
      entries: [
        {
          uuid: "e1",
          action: "update",
          at: 0,
          reason: "Fix",
          after: '{"a":1}',
        },
      ],
    });
    const html = render(h(History, { uuid: "r1" }));
    expect(html).toContain("<strong>update</strong>");
    expect(html).toContain("<p>Fix</p>");
    expect(html).toContain("&quot;a&quot;: 1");
  });

  it("pages with status, error and Load more until the last page", () => {
    expect(render(h(HistoryPager, { history: page({}) as never }))).toContain(
      "Load more",
    );
    expect(
      render(h(HistoryPager, { history: page({ loading: true }) as never })),
    ).toBe('<p role="status">Loading history…</p>');
    expect(
      render(
        h(HistoryPager, {
          history: page({ isDone: true, error: "Offline" }) as never,
        }),
      ),
    ).toBe('<p role="alert" class="error">Offline</p>');
  });
});

describe("useManagement", () => {
  const command = { kind: "noop" } as unknown as ManagementCommand;

  it("refuses a command while offline", async () => {
    workspace.state = { online: false, connected: true, backend: {} };
    const { writable, execute } = useManagement();
    expect(writable).toBe(false);
    await expect(execute(command)).rejects.toThrow(
      "Reconnect to make this change.",
    );
  });

  it("sends a command and shows Change saved.", async () => {
    const manage = vi.fn(async () => {});
    workspace.state = { online: true, connected: true, backend: { manage } };
    await useManagement().execute(command);
    expect(manage).toHaveBeenCalledWith(command);
    expect(workspace.setState).toHaveBeenCalledWith({
      notice: "Change saved.",
    });
  });
});

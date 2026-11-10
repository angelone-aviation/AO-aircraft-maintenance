/**
 * Responsibility: Pins the setup session: one commit at a time per aircraft,
 *   saved rows recorded in the stored draft without losing an edit, a row
 *   already on the aircraft not sent, and a retry that keeps request ids.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/aircraftSetupSession.ts, src/domain/aircraftSetup.ts
 *   (types).
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { SetupAction } from "../domain/aircraftSetup";
import {
  editSetupDraft,
  forgetSetupDraft,
  openSetupSession,
  retrySetupCommit,
  setupSession,
  startSetupCommit,
  subscribeSetupSessions,
  type SetupCommitPorts,
} from "./aircraftSetupSession";

const KEY = "angel-one-setup:test:aircraft-1";
let stored: Map<string, string>;
let keyNumber = 0;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
});

// Module state is per key, so every test takes its own aircraft.
const freshKey = () => `${KEY}-${++keyNumber}`;

function action(name: string): SetupAction {
  return {
    step: "inspections",
    key: `inspection-name:${name}`,
    label: name,
    detail: "",
    command: {
      requestUuid: `request-${name}`,
      action: "inspection.save",
    } as SetupAction["command"] as never,
  };
}

// A backend whose saves resolve only when the test says so.
function manualPorts(onRecord: string[] = []) {
  const sent: string[] = [];
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const ports: SetupCommitPorts = {
    send: (a) => {
      sent.push(String(a.command.requestUuid));
      return new Promise<void>((resolve, reject) =>
        waiting.push({ resolve, reject }),
      );
    },
    onRecord: (a) => onRecord.includes(a.key),
  };
  const settle = async (error?: Error) => {
    const next = waiting.shift()!;
    if (error) next.reject(error);
    else next.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { ports, sent, settle };
}

const storedDraft = (key: string) => JSON.parse(stored.get(key) ?? "null");

it("refuses a second commit while one is running, so no row is sent twice", async () => {
  const key = freshKey();
  const first = manualPorts();
  const second = manualPorts();
  const actions = [action("a"), action("b")];
  expect(startSetupCommit(key, actions, first.ports)).toBe(true);
  expect(setupSession(key).run).toMatchObject({ busy: true, saved: [] });
  // The same plan again, as a remounted Save step would send it.
  expect(startSetupCommit(key, [action("a"), action("b")], second.ports)).toBe(
    false,
  );
  expect(retrySetupCommit(key, second.ports)).toBe(false);
  await first.settle();
  await first.settle();
  expect(first.sent).toEqual(["request-a", "request-b"]);
  expect(second.sent).toEqual([]);
  expect(setupSession(key).run).toMatchObject({
    busy: false,
    saved: ["inspection-name:a", "inspection-name:b"],
  });
});

it("keeps a running commit when the wizard is opened again", async () => {
  const key = freshKey();
  const { ports, settle } = manualPorts();
  startSetupCommit(key, [action("a")], ports);
  openSetupSession(key);
  expect(setupSession(key).run?.busy).toBe(true);
  await settle();
  expect(setupSession(key).run).toMatchObject({ busy: false });
  // The finished result stays while the stored draft is the same one.
  openSetupSession(key);
  expect(setupSession(key).run?.saved).toEqual(["inspection-name:a"]);
  // Sign-out clears the stored draft; the next visit starts empty.
  stored.clear();
  openSetupSession(key);
  expect(setupSession(key)).toEqual({
    draft: { inspectionCsv: "", adCsv: "", done: [] },
    storageError: "",
    run: undefined,
  });
});

it("records each saved row in the stored draft and leaves the texts alone", async () => {
  const key = freshKey();
  editSetupDraft(key, { inspectionCsv: "name\nA" });
  editSetupDraft(key, { adCsv: "ad_number\n2011-10-09" });
  const { ports, settle } = manualPorts();
  startSetupCommit(key, [action("a"), action("b")], ports);
  await settle();
  expect(storedDraft(key)).toEqual({
    inspectionCsv: "name\nA",
    adCsv: "ad_number\n2011-10-09",
    done: ["inspection-name:a"],
  });
  await settle();
  expect(storedDraft(key).done).toEqual([
    "inspection-name:a",
    "inspection-name:b",
  ]);
});

it("refuses edits and forgetting while a commit runs, and drops the result on a later edit", async () => {
  const key = freshKey();
  editSetupDraft(key, { inspectionCsv: "old" });
  const { ports, settle } = manualPorts();
  startSetupCommit(key, [action("a")], ports);
  expect(editSetupDraft(key, { inspectionCsv: "new" })).toBe(false);
  expect(forgetSetupDraft(key)).toBe(false);
  expect(setupSession(key).draft.inspectionCsv).toBe("old");
  await settle();
  expect(setupSession(key).run?.busy).toBe(false);
  expect(editSetupDraft(key, { inspectionCsv: "new" })).toBe(true);
  expect(setupSession(key).run).toBeUndefined();
  expect(setupSession(key).draft).toEqual({
    inspectionCsv: "new",
    adCsv: "",
    done: ["inspection-name:a"],
  });
  expect(forgetSetupDraft(key)).toBe(true);
  expect(stored.has(key)).toBe(false);
});

it("does not send a row whose record is on the aircraft by the time it is reached", async () => {
  const key = freshKey();
  const { ports, sent, settle } = manualPorts(["inspection-name:b"]);
  startSetupCommit(key, [action("a"), action("b"), action("c")], ports);
  await settle();
  await settle();
  expect(sent).toEqual(["request-a", "request-c"]);
  expect(setupSession(key).run).toMatchObject({
    busy: false,
    saved: ["inspection-name:a", "inspection-name:c"],
    onRecord: ["inspection-name:b"],
  });
  expect(storedDraft(key).done).toEqual([
    "inspection-name:a",
    "inspection-name:c",
  ]);
});

it("stops at a failed row and retries from it with the same request id", async () => {
  const key = freshKey();
  const { ports, sent, settle } = manualPorts();
  const notified = vi.fn();
  const stop = subscribeSetupSessions(notified);
  startSetupCommit(key, [action("a"), action("b"), action("c")], ports);
  await settle();
  await settle(new Error("Inspection refused."));
  expect(setupSession(key).run).toMatchObject({
    busy: false,
    saved: ["inspection-name:a"],
    failure: { key: "inspection-name:b", message: "Inspection refused." },
  });
  expect(sent).toEqual(["request-a", "request-b"]);
  expect(retrySetupCommit(key, ports)).toBe(true);
  expect(setupSession(key).run).toMatchObject({ busy: true });
  expect(setupSession(key).run?.failure).toBeUndefined();
  await settle();
  await settle();
  expect(sent).toEqual(["request-a", "request-b", "request-b", "request-c"]);
  expect(setupSession(key).run).toMatchObject({
    busy: false,
    saved: ["inspection-name:a", "inspection-name:b", "inspection-name:c"],
  });
  expect(retrySetupCommit(key, ports)).toBe(false);
  expect(notified).toHaveBeenCalled();
  stop();
});

it("says when the draft cannot be stored or read", () => {
  const key = freshKey();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  });
  expect(setupSession(key).storageError).toMatch(/could not be loaded/);
  editSetupDraft(key, { inspectionCsv: "x" });
  expect(setupSession(key)).toMatchObject({
    draft: { inspectionCsv: "x" },
    storageError: expect.stringMatching(/cannot be resumed/),
  });
});

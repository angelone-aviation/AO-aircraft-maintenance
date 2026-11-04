/**
 * Responsibility: Pins the change-log row constructor: its stamps, the
 *   program it derives, and the keys it keeps.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/changeLog.ts, src/data/demo.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { auditEntry } from "./changeLog";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MOVE = { action: "stock.move", entityUuid: "stock" };

describe("auditEntry", () => {
  it("stamps a fresh id, the time and the signed-in user", () => {
    const s = demoSnapshot();
    const entry = auditEntry(s, MOVE, NOW);
    expect(entry).toStrictEqual({
      programUuid: "demo-program",
      uuid: expect.stringMatching(UUID),
      actorId: s.user.id,
      at: NOW,
      ...MOVE,
    });
    expect(auditEntry(s, MOVE, NOW).uuid).not.toBe(entry.uuid);
  });

  it("keeps a fixed id, such as the command's request id", () => {
    const random = vi.spyOn(crypto, "randomUUID");
    const entry = auditEntry(demoSnapshot(), { ...MOVE, uuid: "request" });
    expect(entry.uuid).toBe("request");
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("defaults the time to now", () => {
    vi.useFakeTimers({ now: NOW });
    expect(auditEntry(demoSnapshot(), MOVE).at).toBe(NOW);
    vi.useRealTimers();
  });

  it("belongs to the program owning the aircraft, else the active one", () => {
    const s = demoSnapshot();
    const [owned, unassigned] = s.aircraft;
    owned.programUuid = "other-program";
    unassigned.programUuid = undefined;
    const program = (aircraftUuid: string) =>
      auditEntry(s, { ...MOVE, aircraftUuid }, NOW).programUuid;
    expect(program(owned.uuid)).toBe("other-program");
    expect(program(unassigned.uuid)).toBe("demo-program");
    expect(program("missing")).toBe("demo-program");
  });

  it("keeps a program the change names, even an explicit undefined", () => {
    const s = demoSnapshot();
    const aircraftUuid = s.aircraft[0].uuid;
    const named = auditEntry(s, { ...MOVE, programUuid: "named" }, NOW);
    expect(named.programUuid).toBe("named");
    const unset = { ...MOVE, aircraftUuid, programUuid: undefined };
    const entry = auditEntry(s, unset, NOW);
    expect("programUuid" in entry && entry.programUuid).toBe(undefined);
  });

  it("stores before and after as JSON and leaves omitted keys absent", () => {
    const s = demoSnapshot();
    const change = { ...MOVE, before: { quantity: 1 }, after: { quantity: 2 } };
    const entry = auditEntry(s, { ...change, reason: undefined }, NOW);
    expect(entry).toMatchObject({
      before: '{"quantity":1}',
      after: '{"quantity":2}',
    });
    expect(Object.keys(entry)).toContain("reason");
    const removed = auditEntry(s, { ...MOVE, after: undefined }, NOW);
    expect(Object.keys(removed)).toContain("after");
    expect(removed.after).toBeUndefined();
    expect(Object.keys(auditEntry(s, MOVE, NOW)).sort()).toEqual([
      "action",
      "actorId",
      "at",
      "entityUuid",
      "programUuid",
      "uuid",
    ]);
  });

  it("orders its keys: stamps, then the change's, then before and after", () => {
    const s = demoSnapshot();
    const change = {
      programUuid: "named",
      ...MOVE,
      reason: "r",
      before: 1,
      after: 2,
    };
    expect(Object.keys(auditEntry(s, change, NOW))).toEqual([
      "uuid",
      "programUuid",
      "actorId",
      "at",
      "action",
      "entityUuid",
      "reason",
      "before",
      "after",
    ]);
  });

  it("leaves the snapshot and its change log as they were", () => {
    const s = demoSnapshot();
    const before = structuredClone(s);
    auditEntry(s, { ...MOVE, before: s.aircraft[0] }, NOW);
    expect(s).toEqual(before);
  });
});

/**
 * Responsibility: Pins the expiring-date rules: who may save and archive,
 *   stale versions, aircraft scope, status by date, the FAA key row and the
 *   listing order.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/expiringItems.ts, src/domain/model.ts,
 *   src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "./model";
import {
  applyExpiringCommand,
  daysUntil,
  expiringItemSchema,
  expiringStatus,
  FAA_KEY_ITEM_UUID,
  faaKeyExpiringItem,
  listExpiringItems,
  type ExpiringItem,
} from "./expiringItems";

const TODAY = "2026-11-09";
const ITEM_UUID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-09T12:00:00Z");

function item(patch: Partial<ExpiringItem> = {}): ExpiringItem {
  return {
    uuid: ITEM_UUID,
    programUuid: "demo-program",
    kind: "insurance",
    label: "Hull policy",
    expiresOn: "2027-01-31",
    warnDays: 60,
    version: 0,
    ...patch,
  };
}

// The demo administrator is a system administrator in the demo program.
const admin = (): Snapshot => demoSnapshot();

// A member of a program-administrator group, not a system administrator.
function programAdmin(): Snapshot {
  const s = demoSnapshot();
  const group = {
    id: "admins",
    name: "Program managers",
    programUuid: "demo-program",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read" as const],
  };
  return {
    ...s,
    groups: [...s.groups, group],
    user: { ...s.user, isAdmin: false, groupIds: ["admins"] },
  };
}

function pilot(): Snapshot {
  const s = demoSnapshot();
  return {
    ...s,
    user: { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] },
  };
}

describe("saving", () => {
  it("creates a program item at version 1 with a change-log row", () => {
    const s = programAdmin();
    const saved = applyExpiringCommand(
      s,
      { action: "save", item: item() },
      NOW,
    );
    expect(saved).toMatchObject({ uuid: ITEM_UUID, version: 1 });
    expect(s.expiringItems).toEqual([saved]);
    expect(s.audit[0]).toMatchObject({
      action: "expiring-date.saved",
      entityUuid: ITEM_UUID,
      programUuid: "demo-program",
      actorId: s.user.id,
      at: NOW,
    });
    expect(s.audit[0].before).toBeUndefined();
    expect(JSON.parse(s.audit[0].after!)).toEqual(saved);
  });

  it("edits with the stored version and refuses a stale one", () => {
    const s = programAdmin();
    applyExpiringCommand(s, { action: "save", item: item() });
    const edited = applyExpiringCommand(s, {
      action: "save",
      item: item({ label: "Hull and liability", version: 1 }),
    });
    expect(edited.version).toBe(2);
    expect(s.expiringItems).toHaveLength(1);
    expect(() =>
      applyExpiringCommand(s, {
        action: "save",
        item: item({ label: "Again", version: 1 }),
      }),
    ).toThrow("This expiring date changed. Refresh and try again.");
  });

  it("refuses a program item from anyone but a program administrator", () => {
    expect(() =>
      applyExpiringCommand(pilot(), { action: "save", item: item() }),
    ).toThrow("Flight Program administrator required.");
    expect(() =>
      applyExpiringCommand(programAdmin(), {
        action: "save",
        item: item({ programUuid: "other-program" }),
      }),
    ).toThrow("Expiring dates belong to the active Flight Program.");
  });

  it("keeps system-wide items to system administrators", () => {
    const system = item({ programUuid: undefined, kind: "secret" });
    expect(() =>
      applyExpiringCommand(programAdmin(), { action: "save", item: system }),
    ).toThrow("Administrator permission required.");
    const s = admin();
    const saved = applyExpiringCommand(s, { action: "save", item: system });
    expect(saved.programUuid).toBeUndefined();
    expect(s.audit[0].programUuid).toBeUndefined();
  });

  it("never moves an item between programs", () => {
    const s = admin();
    applyExpiringCommand(s, { action: "save", item: item() });
    expect(() =>
      applyExpiringCommand(s, {
        action: "save",
        item: item({ programUuid: undefined, version: 1 }),
      }),
    ).toThrow("Expiring dates cannot move between Flight Programs.");
  });

  it("ties an item only to an aircraft of its program", () => {
    const s = programAdmin();
    const saved = applyExpiringCommand(s, {
      action: "save",
      item: item({ aircraftUuid: "demo-206" }),
    });
    expect(saved.aircraftUuid).toBe("demo-206");
    expect(() =>
      applyExpiringCommand(s, {
        action: "save",
        item: item({ uuid: crypto.randomUUID(), aircraftUuid: "elsewhere" }),
      }),
    ).toThrow("Aircraft must belong to this Flight Program.");
    expect(() =>
      applyExpiringCommand(admin(), {
        action: "save",
        item: item({ programUuid: undefined, aircraftUuid: "demo-206" }),
      }),
    ).toThrow("Aircraft must belong to this Flight Program.");
  });

  it("parses the stored shape with its defaults", () => {
    const parsed = expiringItemSchema.parse({
      uuid: ITEM_UUID,
      kind: "other",
      label: "  Padded  ",
      expiresOn: "2027-01-01",
      version: 3,
    });
    expect(parsed).toMatchObject({ label: "Padded", warnDays: 60 });
    expect(() =>
      expiringItemSchema.parse({ ...item(), expiresOn: "01/31/2027" }),
    ).toThrow();
    expect(() =>
      expiringItemSchema.parse({ ...item(), warnDays: 731 }),
    ).toThrow();
  });
});

describe("archiving", () => {
  it("hides the item, keeps it, and refuses a second archive or a later save", () => {
    const s = programAdmin();
    applyExpiringCommand(s, { action: "save", item: item() });
    const archived = applyExpiringCommand(s, {
      action: "archive",
      uuid: ITEM_UUID,
      version: 1,
    });
    expect(archived).toMatchObject({ archived: true, version: 2 });
    expect(s.expiringItems).toEqual([archived]);
    expect(s.audit[0].action).toBe("expiring-date.archived");
    expect(listExpiringItems(s, "program")).toEqual([]);
    expect(() =>
      applyExpiringCommand(s, {
        action: "archive",
        uuid: ITEM_UUID,
        version: 2,
      }),
    ).toThrow("This expiring date is already archived.");
    expect(() =>
      applyExpiringCommand(s, {
        action: "save",
        item: item({ version: 2 }),
      }),
    ).toThrow("This expiring date is already archived.");
  });

  it("reports an unknown or stale item", () => {
    const s = programAdmin();
    expect(() =>
      applyExpiringCommand(s, {
        action: "archive",
        uuid: ITEM_UUID,
        version: 0,
      }),
    ).toThrow("Expiring date not found.");
    applyExpiringCommand(s, { action: "save", item: item() });
    expect(() =>
      applyExpiringCommand(s, {
        action: "archive",
        uuid: ITEM_UUID,
        version: 0,
      }),
    ).toThrow("This expiring date changed. Refresh and try again.");
  });
});

describe("status", () => {
  const at = (expiresOn: string, warnDays = 60) =>
    expiringStatus({ expiresOn, warnDays }, TODAY);
  it("is ok before the warning window, expiring through the date, expired after", () => {
    expect(at("2027-01-09")).toBe("ok");
    expect(at("2027-01-08")).toBe("expiring");
    expect(at(TODAY)).toBe("expiring");
    expect(at("2026-11-08")).toBe("expired");
    expect(at(TODAY, 0)).toBe("expiring");
    expect(at("2026-11-10", 0)).toBe("ok");
  });
  it("counts whole days", () => {
    expect(daysUntil(TODAY, "2026-11-10")).toBe(1);
    expect(daysUntil(TODAY, TODAY)).toBe(0);
    expect(daysUntil(TODAY, "2026-11-01")).toBe(-8);
  });
});

describe("the FAA key row", () => {
  it("exists only for a saved key with a renewal date", () => {
    expect(faaKeyExpiringItem(undefined)).toBeUndefined();
    expect(
      faaKeyExpiringItem({ configured: false, expiresOn: "", version: 0 }),
    ).toBeUndefined();
    expect(
      faaKeyExpiringItem({ configured: true, expiresOn: "", version: 1 }),
    ).toBeUndefined();
    expect(
      faaKeyExpiringItem({
        configured: true,
        expiresOn: "2027-10-14",
        version: 2,
      }),
    ).toMatchObject({
      uuid: FAA_KEY_ITEM_UUID,
      kind: "service-key",
      expiresOn: "2027-10-14",
      warnDays: 60,
      version: 2,
    });
  });
});

describe("listing", () => {
  it("sorts soonest first, splits system from program items, and hides what the user may not see", () => {
    const s = admin();
    s.faaCredential = { configured: true, expiresOn: "2027-10-14", version: 1 };
    const program = (label: string, expiresOn: string) =>
      item({ uuid: crypto.randomUUID(), label, expiresOn });
    s.expiringItems = [
      program("Zulu", "2027-03-01"),
      program("Alpha", "2027-03-01"),
      program("Early", "2026-12-01"),
      item({
        uuid: crypto.randomUUID(),
        programUuid: undefined,
        label: "Cloudflare token",
        expiresOn: "2026-12-15",
      }),
      item({ uuid: crypto.randomUUID(), label: "Gone", archived: true }),
    ];
    expect(listExpiringItems(s, "program").map((i) => i.label)).toEqual([
      "Early",
      "Alpha",
      "Zulu",
    ]);
    expect(listExpiringItems(s, "system").map((i) => i.label)).toEqual([
      "Cloudflare token",
      "FAA DRS API key",
    ]);
    const member = { ...programAdmin(), expiringItems: s.expiringItems };
    member.faaCredential = s.faaCredential;
    expect(listExpiringItems(member, "system")).toEqual([]);
    expect(listExpiringItems(member, "program")).toHaveLength(3);
    expect(
      listExpiringItems(
        { ...pilot(), expiringItems: s.expiringItems },
        "program",
      ),
    ).toEqual([]);
  });
});

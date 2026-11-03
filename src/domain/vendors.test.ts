import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyManagement, vendorSchema } from "./management";
import { vendorDirectory } from "./vendors";
import { scopedSnapshot } from "./programs";
const command = (name = "Aircraft supplier") => ({
  action: "record.save" as const,
  requestUuid: crypto.randomUUID(),
  reason: "Vendor added",
  record: vendorSchema.parse({
    kind: "vendor",
    uuid: crypto.randomUUID(),
    version: 0,
    name,
  }),
});
describe("vendor directory", () => {
  it("saves name-only vendors, rejects duplicate names, and checks stale edits", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    const c = command();
    applyManagement(s, c);
    const saved = vendorDirectory(s).find((v) => v.name === c.record.name)!;
    expect(saved.version).toBe(1);
    expect(saved.addressDetails).toBeUndefined();
    expect(() => applyManagement(s, command("  AIRCRAFT SUPPLIER  "))).toThrow(
      /already exists/,
    );
    applyManagement(s, {
      ...command(),
      record: { ...saved, notes: "Account contact updated" },
    });
    expect(() =>
      applyManagement(s, {
        ...command(),
        record: { ...saved, notes: "Stale update" },
      }),
    ).toThrow();
  });
  it("requires inventory administrator access and hides vendors from other programs", () => {
    const s = demoSnapshot();
    s.user.isAdmin = true;
    applyManagement(s, command());
    const saved = vendorDirectory(s).find(
      (v) => v.name === "Aircraft supplier",
    )!;
    s.management!.push({
      ...saved,
      uuid: "foreign",
      name: "Foreign supplier",
      programUuid: "other-program",
    });
    expect(
      vendorDirectory(scopedSnapshot(s)).some(
        (v) => v.name === "Foreign supplier",
      ),
    ).toBe(false);
    s.user.isAdmin = false;
    s.user.groupIds = [];
    expect(() => applyManagement(s, command("Forbidden"))).toThrow(
      /Permission/,
    );
  });
});

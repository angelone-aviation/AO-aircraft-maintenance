/**
 * Responsibility: Pins the inventory attachment file rule and who may manage
 *   an item's attachments.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/inventoryAttachments.ts, rejection.ts,
 *   src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  MAX_ACTION_FILE_BYTES,
  inventoryAttachmentAccess,
  validateInventoryFile,
} from "./inventoryAttachments";
import { Rejection } from "./rejection";
import type { Stock } from "./management";

describe("attachment files", () => {
  it("accepts each type with its extension in any case, up to 7 MiB", () => {
    expect(MAX_ACTION_FILE_BYTES).toBe(7 * 1024 * 1024);
    for (const [name, type] of [
      ["invoice.PDF", "application/pdf"],
      ["tag.jpg", "image/jpeg"],
      ["tag.JPEG", "image/jpeg"],
      ["label.png", "image/png"],
      ["photo.webp", "image/webp"],
    ])
      expect(() =>
        validateInventoryFile(name, type, MAX_ACTION_FILE_BYTES),
      ).not.toThrow();
    expect(() =>
      validateInventoryFile(`${"n".repeat(251)}.pdf`, "application/pdf", 1),
    ).not.toThrow();
  });
  it("refuses another type, a mismatched or long name, and a bad size", () => {
    const wrongFile = Error("Choose a PDF, JPEG, PNG or WebP file.");
    for (const [name, type] of [
      ["scan.gif", "image/gif"],
      ["scan.png", "image/jpeg"],
      [" ", "application/pdf"],
      [`${"n".repeat(252)}.pdf`, "application/pdf"],
    ]) {
      expect(() => validateInventoryFile(name, type, 1)).toThrow(Rejection);
      expect(() => validateInventoryFile(name, type, 1)).toThrow(wrongFile);
    }
    const wrongSize = Error("Attachments must be between 1 byte and 7 MB.");
    for (const size of [0, 1.5, MAX_ACTION_FILE_BYTES + 1]) {
      expect(() =>
        validateInventoryFile("a.pdf", "application/pdf", size),
      ).toThrow(wrongSize);
    }
    expect(() => validateInventoryFile("a.pdf", "application/pdf", 0)).toThrow(
      Rejection,
    );
  });
  it("refuses a type named after an Object property", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(() => validateInventoryFile("a.pdf", type, 1)).toThrow(Rejection);
      expect(() => validateInventoryFile("a.pdf", type, 1)).toThrow(
        "Choose a PDF, JPEG, PNG or WebP file.",
      );
    }
  });
});

describe("attachment access", () => {
  const oil = (programUuid: string): Stock => ({
    uuid: "oil",
    version: 1,
    kind: "stock",
    programUuid,
    partNumber: "MIL-PRF-6082",
    alternates: "",
    description: "Engine oil",
    category: "supply",
    condition: "new",
    locationUuid: "hangar",
    quantity: 4,
    minimum: 1,
  });
  function workspace() {
    const s = demoSnapshot();
    s.management = [oil("demo-program")];
    return s;
  }
  const denied = Error(
    "Inventory administrator access to this item is required.",
  );
  it("returns an item in the active program to its administrator", () => {
    const s = workspace();
    expect(inventoryAttachmentAccess(s, "oil").uuid).toBe("oil");
    s.user = { ...s.user, isAdmin: false, groupIds: ["admins"] };
    s.groups = [
      {
        id: "admins",
        name: "Administrators",
        programUuid: "demo-program",
        aircraftIds: [],
        permissions: ["read"],
        programAdmin: true,
      },
    ];
    expect(inventoryAttachmentAccess(s, "oil").uuid).toBe("oil");
  });
  it("refuses a missing item, another program's item, and a non-administrator", () => {
    const s = workspace();
    expect(() => inventoryAttachmentAccess(s, "missing")).toThrow(Rejection);
    expect(() => inventoryAttachmentAccess(s, "missing")).toThrow(denied);
    s.management = [oil("other")];
    expect(() => inventoryAttachmentAccess(s, "oil")).toThrow(denied);
    const member = workspace();
    member.user = member.members[1];
    expect(() => inventoryAttachmentAccess(member, "oil")).toThrow(denied);
  });
});

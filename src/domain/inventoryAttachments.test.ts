/**
 * Responsibility: Pins the inventory attachment file rule, the check of a
 *   file's first bytes, who may manage an item's attachments, and the rows a
 *   purchase-order upload logs.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/inventoryAttachments.ts, rejection.ts,
 *   src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  MAX_ACTION_FILE_BYTES,
  assertFileContents,
  inventoryAttachmentAccess,
  validateInventoryFile,
  poAttachmentChanges,
  receiptItemUuids,
} from "./inventoryAttachments";
import { Rejection } from "./rejection";
import type { Stock } from "./management";

describe("attachment contents", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(
      values.flatMap((v) =>
        typeof v === "string" ? [...new TextEncoder().encode(v)] : [v],
      ),
    ).buffer;
  const matches = (type: string, file: ArrayBuffer) => {
    try {
      assertFileContents(type, file);
      return true;
    } catch (e) {
      expect(e).toBeInstanceOf(Rejection);
      return false;
    }
  };

  it("accepts each type's own first bytes and refuses the others", () => {
    const files = {
      "application/pdf": bytes("%PDF-1.7"),
      "image/jpeg": bytes(0xff, 0xd8, 0xff, 0xe1),
      "image/png": bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0),
      "image/webp": bytes("RIFF", 1, 2, 3, 4, "WEBPVP8 "),
    };
    for (const type of Object.keys(files))
      expect(
        Object.entries(files).map(([, file]) => matches(type, file)),
      ).toEqual(Object.keys(files).map((t) => t === type));
  });

  it("refuses a file too short to tell, a RIFF that is not WebP and an unknown type", () => {
    expect(matches("image/jpeg", bytes(0xff, 0xd8))).toBe(false);
    expect(matches("image/webp", bytes("RIFF", 1, 2, 3, 4, "WAVE"))).toBe(
      false,
    );
    expect(matches("image/svg+xml", bytes("<svg"))).toBe(false);
  });
});

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

describe("purchase-order upload rows (T3)", () => {
  const po = { uuid: "po", number: "PO-7", programUuid: "program" };
  const file = { name: "invoice.pdf", size: 9, type: "application/pdf" };
  const receipt = {
    uuid: "receipt",
    lines: [{ itemUuids: ["lot-a", "lot-b"] }, { itemUuids: ["lot-a"] }],
  } as never;

  it("lists each item a receipt brought in once, in receipt order", () => {
    expect(receiptItemUuids(receipt)).toEqual(["lot-a", "lot-b"]);
    expect(receiptItemUuids(undefined)).toEqual([]);
  });
  it("logs the order's file, then a receipt's copy on each item", () => {
    const stored = { name: "invoice.pdf", size: 9 };
    expect(poAttachmentChanges(po, undefined, file)).toEqual([
      {
        action: "purchaseOrder.attachment",
        entityUuid: "po",
        programUuid: "program",
        reason: "Purchase order attachment uploaded",
        after: stored,
      },
    ]);
    expect(poAttachmentChanges(po, receipt, file)).toEqual([
      {
        action: "purchaseOrder.attachment",
        entityUuid: "po",
        programUuid: "program",
        reason: "Receipt attachment uploaded",
        after: { ...stored, receiptUuid: "receipt" },
      },
      ...["lot-a", "lot-b"].map((entityUuid) => ({
        action: "inventory.attachment",
        entityUuid,
        programUuid: "program",
        reason: "Receipt attachment from PO-7",
        after: stored,
      })),
    ]);
  });
});

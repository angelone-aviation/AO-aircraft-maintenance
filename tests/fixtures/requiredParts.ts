/**
 * Responsibility: A parts-planning snapshot and the required part that runs
 *   it short.
 * Layer: Test. Fixture over the demo seed.
 * Dependencies: src/data/demo (demoSnapshot), src/domain/requiredParts
 *   (RequiredPart type).
 */
import { demoSnapshot } from "../../src/data/demo";
import type { RequiredPart } from "../../src/domain/requiredParts";

const PROGRAM_UUID = "demo-program";
const MAIN_HANGAR_UUID = "parts-location";
const FILTER_STOCK_UUID = "parts-stock";

/** Three FILTER-1 from the main hangar, one more than it holds. */
export const neededPart: RequiredPart = {
  locationUuid: MAIN_HANGAR_UUID,
  stockUuid: FILTER_STOCK_UUID,
  quantity: 3,
};

/**
 * The demo snapshot with its inventory replaced by two hangars, and its
 * discrepancies by one open report on the first aircraft.
 * @returns A fresh snapshot. The main hangar holds 2 FILTER-1, with a cost and
 *   a vendor an owner must not see; the remote hangar holds 10 REMOTE-1.
 */
export function partsFixture() {
  const s = demoSnapshot();
  s.management = [
    {
      kind: "location",
      uuid: MAIN_HANGAR_UUID,
      programUuid: PROGRAM_UUID,
      version: 1,
      name: "Main hangar",
      address: "",
      contact: "",
    },
    {
      kind: "location",
      uuid: "other-location",
      programUuid: PROGRAM_UUID,
      version: 1,
      name: "Remote hangar",
      address: "",
      contact: "",
    },
    {
      kind: "stock",
      uuid: FILTER_STOCK_UUID,
      programUuid: PROGRAM_UUID,
      version: 1,
      locationUuid: MAIN_HANGAR_UUID,
      partNumber: "FILTER-1",
      description: "Oil filter",
      quantity: 2,
      minimum: 0,
      alternates: "",
      category: "part",
      condition: "new",
      cost: 99,
      vendor: "Private vendor",
    },
    {
      kind: "stock",
      uuid: "remote-stock",
      programUuid: PROGRAM_UUID,
      version: 1,
      locationUuid: "other-location",
      partNumber: "REMOTE-1",
      description: "Remote filter",
      quantity: 10,
      minimum: 0,
      alternates: "",
      category: "part",
      condition: "new",
    },
  ];
  s.discrepancies = [
    {
      uuid: "parts-report",
      aircraftUuid: s.aircraft[0].uuid,
      description: "Replace cabin filter",
      status: "open",
      authorId: s.user.id,
      createdAt: Date.now(),
    },
  ];
  return s;
}

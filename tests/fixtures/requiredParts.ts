import { demoSnapshot } from "../../src/data/demo";
import type { RequiredPart } from "../../src/domain/requiredParts";
export const neededPart: RequiredPart = {
  locationUuid: "parts-location",
  stockUuid: "parts-stock",
  quantity: 3,
};
export function partsFixture() {
  const s = demoSnapshot();
  s.management = [
    {
      kind: "location",
      uuid: "parts-location",
      programUuid: "demo-program",
      version: 1,
      name: "Main hangar",
      address: "",
      contact: "",
    },
    {
      kind: "location",
      uuid: "other-location",
      programUuid: "demo-program",
      version: 1,
      name: "Remote hangar",
      address: "",
      contact: "",
    },
    {
      kind: "stock",
      uuid: "parts-stock",
      programUuid: "demo-program",
      version: 1,
      locationUuid: "parts-location",
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
      programUuid: "demo-program",
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

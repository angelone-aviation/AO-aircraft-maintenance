import { describe, expect, it } from "vitest";
import {
  csvRows,
  catalogSearch,
  orderFields,
  parseOrders,
  priceCents,
} from "./aircraftSpruce";

describe("Aircraft Spruce imports", () => {
  it("parses quoted commas, escaped quotes, embedded newlines, BOM and empty fields", () => {
    expect([
      ...csvRows('\ufeffPN,DESC,PRICE\r\nA,"Bolt, 1/4""\nsteel",\r\n'),
    ]).toEqual([
      ["PN", "DESC", "PRICE"],
      ["A", 'Bolt, 1/4"\nsteel', ""],
    ]);
    expect([...csvRows('PN,DESC\nA,Tube 1/4" diameter\n')]).toEqual([
      ["PN", "DESC"],
      ["A", 'Tube 1/4" diameter'],
    ]);
    expect(() => [...csvRows('A,B\n"unfinished')]).toThrow(/Incomplete/);
  });
  it("keeps unknown availability separate from zero and rejects unsafe links", () => {
    const text =
      "PN,DESCRIPTION,NETPRICE,UOM,GA-AVAIL,CA-AVAIL,URL\nABC,Bolt,1.25,EA,,0,javascript:alert(1)\n";
    const [product] = catalogSearch(text, "ab", "CAD", 100);
    expect(product).toMatchObject({
      partNumber: "ABC",
      currency: "CAD",
      netPrice: "1.25",
      catalogAt: 100,
      url: "",
    });
    expect(product.availability[0].quantity).toBe("");
    expect(product.availability[1].quantity).toBe("0");
    expect(priceCents("1.25")).toBe(125);
    expect(priceCents("")).toBeUndefined();
    expect(priceCents("-1")).toBeUndefined();
    expect(priceCents("1,200")).toBeUndefined();
  });
  it("filters exact PO matches and retains repeated part rows without summing quantities", () => {
    const encode = (record: Record<string, string>) =>
      orderFields.map((k) => record[k] ?? "").join(",");
    const text = [
      orderFields.join(","),
      encode({ ORN: "1", PONO: "PO-1", PARTS: "A", QSS: "2" }),
      encode({ ORN: "1", PONO: "PO-1", PARTS: "A", QSS: "1" }),
      encode({ ORN: "2", PONO: "PO-10", PARTS: "B" }),
    ].join("\n");
    expect(parseOrders(text, "PO-1", "")).toHaveLength(2);
    expect(parseOrders(text, "PO-1", "2")).toHaveLength(1);
    expect(() => parseOrders("ORN,PONO\n1,X", "X", "")).toThrow(/columns/);
  });
});

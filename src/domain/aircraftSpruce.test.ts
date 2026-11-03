/**
 * Responsibility: Pins the Aircraft Spruce CSV parsing, catalog search, price
 *   conversion, order-line matching and account schemas.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftSpruce.ts.
 */
import { describe, expect, it } from "vitest";
import {
  csvRecords,
  csvRows,
  catalogSearch,
  orderFields,
  parseOrders,
  priceCents,
  spruceCredentials,
  sprucePartSchema,
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

// Mirror the private limits in aircraftSpruce.ts; a change to either fails here.
const SEARCH_RESULT_LIMIT = 30;
const MAX_ORDER_LINES = 1000;
const CATALOG_HEADER = "PN,DESCRIPTION,NETPRICE,UOM";

describe("csvRows", () => {
  it("ends lines at \\n, \\r\\n or a lone \\r", () => {
    expect([...csvRows("A\nB\r\nC\rD")]).toEqual([["A"], ["B"], ["C"], ["D"]]);
  });
  it("skips lines whose fields are all empty", () => {
    expect([...csvRows('A\n\n,,\n""\nB\n')]).toEqual([["A"], ["B"]]);
  });
  it("keeps an all-empty last line that has a comma and no line break", () => {
    // Characterizes current behaviour: only the last line escapes the skip.
    expect([...csvRows("A\n,")]).toEqual([["A"], ["", ""]]);
    expect([...csvRows('A\n""')]).toEqual([["A"]]);
  });
  it("reads the rows before an unclosed quote, then throws", () => {
    const rows = csvRows('A,B\nC,"unfinished');
    expect(rows.next().value).toEqual(["A", "B"]);
    expect(() => rows.next()).toThrow(Error("Incomplete CSV download."));
  });
});

describe("csvRecords", () => {
  it("keys each row by the header, keeping columns that are not required", () => {
    expect([...csvRecords("PN,MFG\nA,Acme\n", ["PN"])]).toEqual([
      { PN: "A", MFG: "Acme" },
    ]);
  });
  it("refuses an empty export or a missing required column", () => {
    const columnsError = Error("Unexpected Aircraft Spruce CSV columns.");
    expect(() => [...csvRecords("", [])]).toThrow(columnsError);
    expect(() => [...csvRecords("PN\nA\n", ["PN", "UOM"])]).toThrow(
      columnsError,
    );
  });
  it("refuses a row whose field count differs, once iteration reaches it", () => {
    const records = csvRecords("PN,UOM\nA,EA\nB\n", ["PN"]);
    expect(records.next().value).toEqual({ PN: "A", UOM: "EA" });
    expect(() => records.next()).toThrow(
      Error("Unexpected Aircraft Spruce CSV row."),
    );
  });
});

describe("catalogSearch", () => {
  const catalog = (...lines: string[]) => [CATALOG_HEADER, ...lines].join("\n");
  it("needs two characters after trimming", () => {
    expect(() => catalogSearch(catalog(), " a ", "USD", 1)).toThrow(
      Error("Enter at least two characters."),
    );
  });
  it("matches the part number and description joined by a space, ignoring case", () => {
    const text = catalog("ABC,Bolt,1,EA", "XYZ,Nut,1,EA");
    const found = (search: string) =>
      catalogSearch(text, search, "USD", 1).map((p) => p.partNumber);
    expect(found(" abc bo ")).toEqual(["ABC"]);
    expect(found("NUT")).toEqual(["XYZ"]);
    expect(found("bolt xyz")).toEqual([]);
  });
  it("returns the first 30 matches in catalog order and reads no further", () => {
    const parts = Array.from(
      { length: SEARCH_RESULT_LIMIT },
      (_, i) => `P${i},Bolt,1,EA`,
    );
    const text = catalog(...parts, "MALFORMED");
    const found = catalogSearch(text, "bolt", "USD", 1);
    expect(found.map((p) => p.partNumber)).toEqual(
      parts.map((line) => line.split(",")[0]),
    );
    expect(() => catalogSearch(text, "malformed", "USD", 1)).toThrow(
      Error("Unexpected Aircraft Spruce CSV row."),
    );
  });
  it("keeps only https links to the supplier's own sites", () => {
    const withUrl = (url: string) =>
      catalogSearch(
        `${CATALOG_HEADER},URL\nABC,Bolt,1,EA,${url}`,
        "ab",
        "",
        1,
      )[0].url;
    expect(withUrl("https://www.aircraftspruce.ca/p?id=1")).toBe(
      "https://www.aircraftspruce.ca/p?id=1",
    );
    expect(withUrl("https://www.aircraftspruce.com/p")).toBe(
      "https://www.aircraftspruce.com/p",
    );
    expect(withUrl("http://www.aircraftspruce.com/p")).toBe("");
    expect(withUrl("https://aircraftspruce.com.example/p")).toBe("");
    expect(withUrl("not a link")).toBe("");
    expect(catalogSearch(catalog("ABC,Bolt,1,EA"), "ab", "", 1)[0].url).toBe(
      "",
    );
  });
  it("lists the supplier's quantity and due text per location, in order", () => {
    const text = `${CATALOG_HEADER},CANADA-AVAIL,AZ-DUE\nABC,Bolt,1,EA,4,CALL`;
    expect(catalogSearch(text, "ab", "USD", 1)[0].availability).toEqual([
      { location: "GA", quantity: "", due: "" },
      { location: "CA", quantity: "", due: "" },
      { location: "CANADA", quantity: "4", due: "" },
      { location: "IL", quantity: "", due: "" },
      { location: "TX", quantity: "", due: "" },
      { location: "PA", quantity: "", due: "" },
      { location: "AZ", quantity: "", due: "CALL" },
    ]);
  });
});

describe("priceCents", () => {
  it("converts a plain price with up to two decimals to whole cents", () => {
    expect(priceCents("0")).toBe(0);
    expect(priceCents("12")).toBe(1200);
    expect(priceCents("1.5")).toBe(150);
    expect(priceCents("0.29")).toBe(29);
  });
  it("leaves any other text unconverted", () => {
    for (const value of ["1.255", "1.", ".5", " 1", "1e3", "$1"]) {
      expect(priceCents(value)).toBeUndefined();
    }
  });
  it("converts at most $1 billion", () => {
    expect(priceCents("1000000000")).toBe(100_000_000_000);
    expect(priceCents("1000000000.01")).toBeUndefined();
    expect(priceCents("9".repeat(400))).toBeUndefined();
  });
});

describe("parseOrders", () => {
  const exportOf = (lines: Record<string, string>[]) =>
    [
      orderFields.join(","),
      ...lines.map((line) => orderFields.map((k) => line[k] ?? "").join(",")),
    ].join("\n");
  it("compares each line's trimmed order or PO number exactly", () => {
    const text = exportOf([
      { ORN: " 7 ", PONO: " PO-1 " },
      { ORN: "77", PONO: "PO-1%" },
    ]);
    expect(parseOrders(text, "PO-1", "")).toEqual([
      expect.objectContaining({ ORN: " 7 " }),
    ]);
    expect(parseOrders(text, "", "7")).toEqual([
      expect.objectContaining({ ORN: " 7 " }),
    ]);
  });
  it("refuses an export of over 1,000 lines, even when none match", () => {
    const lines = (count: number) =>
      exportOf(Array.from({ length: count }, () => ({ ORN: "1" })));
    expect(parseOrders(lines(MAX_ORDER_LINES), "", "1")).toHaveLength(
      MAX_ORDER_LINES,
    );
    expect(() => parseOrders(lines(MAX_ORDER_LINES + 1), "", "2")).toThrow(
      Error("Too many order lines. Select an individual order."),
    );
  });
});

describe("account and part schemas", () => {
  const login = {
    userid: " pilot ",
    password: " secret ",
    apikey: " key ",
    currency: "USD",
  };
  it("trims the user id and API key but keeps the password as typed", () => {
    expect(spruceCredentials.parse(login)).toEqual({
      userid: "pilot",
      password: " secret ",
      apikey: "key",
      currency: "USD",
    });
  });
  it("refuses a blank field or a currency that is not three capitals", () => {
    const accepts = (patch: Partial<typeof login>) =>
      spruceCredentials.safeParse({ ...login, ...patch }).success;
    expect(accepts({ userid: "  " })).toBe(false);
    expect(accepts({ password: "" })).toBe(false);
    expect(accepts({ currency: "usd" })).toBe(false);
    expect(accepts({ currency: "US" })).toBe(false);
  });
  it("needs a part number and a currency code on a linked part", () => {
    const part = { partNumber: "AN3", uom: "", currency: "CAD", catalogAt: 1 };
    expect(sprucePartSchema.parse(part)).toEqual(part);
    expect(
      sprucePartSchema.safeParse({ ...part, partNumber: "" }).success,
    ).toBe(false);
    expect(
      sprucePartSchema.safeParse({ ...part, currency: "cad" }).success,
    ).toBe(false);
  });
});

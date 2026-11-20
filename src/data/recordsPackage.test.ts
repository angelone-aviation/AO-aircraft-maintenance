/**
 * Responsibility: Pins the assembled records package: its name, the files in
 *   the ZIP, the README's skipped list, change-log paging, data: URL files,
 *   a download that fails, and the progress messages.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: vitest, fflate, node:fs, src/data/recordsPackage.ts,
 *   src/data/backend.ts (types), src/data/demo.ts, src/domain/model.ts.
 */
// @vitest-environment node
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "./backend";
import { demoSnapshot } from "./demo";
import { exportRecordsPackage } from "./recordsPackage";
import type { AuditPageRequest } from "../domain/auditHistory";
import {
  emptyHistoryRecords,
  type HistoryPageRequest,
  type HistoryRecords,
} from "../domain/retention";
import type { FileRef } from "../domain/fileLinks";
import type { AuditEntry } from "../domain/model";

const NOW = new Date("2026-06-15T09:30:00Z");
const PAGE = 100;

// The font comes from the site in the browser; here from the repository.
function stubFetch(files: Record<string, Uint8Array | number>) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/fonts/DejaVuSans.ttf"))
      return new Response(await readFile("public/fonts/DejaVuSans.ttf"));
    const file = files[url];
    if (file === undefined) throw new TypeError("Failed to fetch");
    return typeof file === "number"
      ? new Response(null, { status: file })
      : new Response(file as BodyInit);
  });
}

function fakeBackend(
  entries: AuditEntry[],
  calls: number[] = [],
  older: HistoryRecords = emptyHistoryRecords(),
): Backend {
  return {
    historyPage: async ({ kind }: HistoryPageRequest) => ({
      records: { ...emptyHistoryRecords(), [kind]: older[kind] },
      members: [],
      isDone: true,
      continueCursor: null,
    }),
    workOrderHistory: async () => {
      throw new Error("History not found.");
    },
    auditPage: async ({ cursor, numItems }: AuditPageRequest) => {
      calls.push(numItems);
      const start = Number(cursor ?? 0);
      const end = start + numItems;
      return {
        page: entries.slice(start, end),
        isDone: end >= entries.length,
        continueCursor: String(end),
      };
    },
  } as unknown as Backend;
}

// Links as the server issues them, one entry per file asked for: the URL
// in `urls`, or null for a file not listed there.
function linksTo(urls: Record<string, string>, asked: string[][] = []) {
  return async (refs: FileRef[]) => {
    asked.push(refs.map((r) => r.id));
    return refs.map((r) =>
      urls[r.id] ? { url: urls[r.id], expiresAt: NOW.getTime() } : null,
    );
  };
}

function entry(i: number, aircraftUuid: string): AuditEntry {
  return {
    uuid: `e${i}`,
    actorId: "demo-admin",
    at: NOW.getTime() - i,
    action: "flight.logged",
    entityUuid: `f${i}`,
    aircraftUuid,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("exportRecordsPackage", () => {
  it("zips the README, PDF, one CSV per table and the aircraft's files", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    s.aircraftFiles = [
      {
        uuid: "f1",
        aircraftUuid: a.uuid,
        category: "form-337",
        name: "Repair.pdf",
        type: "application/pdf",
        size: 5,
        uploadedAt: Date.parse("2026-03-01T12:00:00Z"),
        url: "data:application/pdf;base64,aGVsbG8=",
      },
    ];
    const messages: string[] = [];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: fakeBackend([entry(1, a.uuid)]),
      fileLinks: linksTo({ f1: "data:application/pdf;base64,aGVsbG8=" }),
      now: NOW,
      onProgress: (m) => messages.push(m),
    });
    expect(result.name).toBe("N206MA-records-2026-06-15.zip");
    expect(result.blob.type).toBe("application/zip");
    expect(result.skipped).toEqual([]);
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "ad-compliance.csv",
      "change-log.csv",
      "component-requirements.csv",
      "components.csv",
      "discrepancies.csv",
      "flights.csv",
      "form-337.csv",
      "form-337/2026-03-01-Repair.pdf",
      "records.pdf",
      "status-airworthiness.csv",
      "status-component-limits.csv",
      "status-components.csv",
      "status-discrepancies.csv",
      "status-form-337.csv",
      "status-inspections.csv",
      "status-overview.csv",
      "work-orders.csv",
    ]);
    expect(strFromU8(files["form-337/2026-03-01-Repair.pdf"])).toBe("hello");
    const readme = strFromU8(files["README.txt"]);
    expect(readme).toContain("Generated: 2026-06-15 09:30 UTC by Alex Morgan");
    expect(readme).toContain("change-log.csv - Change log (1 row).");
    expect(readme).toMatch(/SKIPPED FILES\nNone\.\n$/);
    expect(strFromU8(files["records.pdf"]).startsWith("%PDF-")).toBe(true);
    // UTF-8 byte-order mark, so Excel opens the CSV as UTF-8.
    expect([...files["status-inspections.csv"].slice(0, 3)]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    const inspections = strFromU8(files["status-inspections.csv"]);
    expect(inspections.split("\r\n")).toHaveLength(3);
    expect(strFromU8(files["change-log.csv"])).toContain(
      '"2026-06-15 09:29","Flight · logged","Alex Morgan","f1","","",""',
    );
    expect(messages[0]).toBe("Loading the change log…");
    expect(messages).toContain("Printing records.pdf…");
    expect(messages).toContain("Copying files 1 of 1…");
    expect(messages.at(-1)).toBe("Compressing the package…");
  });

  it("pages the change log until the backend is done", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    const entries = Array.from({ length: PAGE * 2 + 1 }, (_, i) =>
      entry(i, a.uuid),
    );
    const calls: number[] = [];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: fakeBackend(entries, calls),
      fileLinks: null,
      now: NOW,
    });
    expect(calls).toEqual([PAGE, PAGE, PAGE]);
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(strFromU8(files["change-log.csv"]).split("\r\n")).toHaveLength(
      PAGE * 2 + 2,
    );
    expect(strFromU8(files["README.txt"])).toContain(
      "change-log.csv - Change log (201 rows).",
    );
  });

  it("falls back to the snapshot's recent entries without a backend", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    s.audit = [entry(1, a.uuid), entry(2, s.aircraft[1].uuid)];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: null,
      fileLinks: null,
      now: NOW,
    });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const lines = strFromU8(files["change-log.csv"]).split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^"Partial change log: 1 entry, only the recent changes kept on the exporting device, which was offline\./,
    );
    const readme = strFromU8(files["README.txt"]);
    expect(readme).toContain("Change log (1 row), partial: see WARNINGS.");
    expect(readme).toContain("\nWARNINGS\nPartial flights: only the last 6");
    expect(readme).toContain("\nPartial change log: 1 entry");
    expect(strFromU8(files["flights.csv"]).split("\r\n")[1]).toMatch(
      /^"Partial flights: only the last 6 months kept on the exporting device/,
    );
  });

  it("pages the aircraft's older history into the package while connected (H4)", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    const older = emptyHistoryRecords();
    older.flights = [
      {
        ...{ uuid: "old", aircraftUuid: a.uuid, authorId: "demo-admin" },
        ...{ pilotId: "demo-admin", submittedAt: 0, status: "accepted" },
        ...{ startTime: "2019-04-02T15:00:00Z", landings: 1, cycles: 0 },
        ...{ origin: "KOLD", destination: "KBFI", operation: "Mission" },
        ...{ flightRules: "VFR", remarks: "", discrepancy: "" },
      },
    ];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: fakeBackend([], [], older),
      fileLinks: null,
      now: NOW,
    });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const flights = strFromU8(files["flights.csv"]);
    expect(flights).toContain("KOLD");
    expect(flights).not.toContain("Partial flights");
  });

  it("says a change log cut at the page limit is partial, without asking to reconnect", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    const entries = Array.from({ length: PAGE * 2 }, (_, i) =>
      entry(i, a.uuid),
    );
    const backend = fakeBackend(entries);
    const auditPage = backend.auditPage;
    // Never done: every page claims more follow.
    backend.auditPage = async (request) => ({
      ...(await auditPage(request)),
      isDone: false,
    });
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend,
      fileLinks: null,
      now: NOW,
    });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const readme = strFromU8(files["README.txt"]);
    expect(readme).toContain(
      "Partial change log: the newest 200 entries. The change log is longer than one package reads",
    );
    expect(readme).not.toContain("Reconnect");
  });

  it("refuses a user without maintenance permission before reading anything", async () => {
    const s = demoSnapshot();
    s.user = s.members.find((m) => m.id === "demo-pilot")!;
    const calls: number[] = [];
    await expect(
      exportRecordsPackage({
        snapshot: s,
        aircraftUuid: s.aircraft[0].uuid,
        backend: fakeBackend([], calls),
        fileLinks: null,
        now: NOW,
      }),
    ).rejects.toThrow(
      "Records packages are for users with maintenance permission on the aircraft.",
    );
    expect(calls).toEqual([]);
  });

  it("lists a file it could not download in the README and keeps the rest", async () => {
    stubFetch({ "https://files.test/ok": new Uint8Array([1, 2, 3]) });
    const s = demoSnapshot();
    const a = s.aircraft[0];
    const copy = (uuid: string, url: string) => ({
      uuid,
      aircraftUuid: a.uuid,
      category: "form-337" as const,
      name: `${uuid}.pdf`,
      type: "application/pdf",
      size: 3,
      uploadedAt: Date.parse("2026-03-01T12:00:00Z"),
      url,
    });
    s.aircraftFiles = [copy("ok", ""), copy("gone", ""), copy("hidden", "")];
    const asked: string[][] = [];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: null,
      fileLinks: linksTo(
        { ok: "https://files.test/ok", gone: "https://files.test/gone" },
        asked,
      ),
      now: NOW,
    });
    // Each link is asked for just before its download: a package of many
    // files outlasts a link's five minutes.
    expect(asked).toEqual([["ok"], ["gone"], ["hidden"]]);
    const skipped = (id: string) => ({
      file: {
        path: `form-337/2026-03-01-${id}.pdf`,
        file: { kind: "aircraftFile", id },
        size: 3,
        description: "Form 337 copy",
      },
      reason: "Could not be downloaded",
    });
    expect(result.skipped).toEqual([skipped("gone"), skipped("hidden")]);
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect([...files["form-337/2026-03-01-ok.pdf"]]).toEqual([1, 2, 3]);
    expect(files["form-337/2026-03-01-gone.pdf"]).toBeUndefined();
    expect(strFromU8(files["README.txt"])).toMatch(
      /SKIPPED FILES\nform-337\/2026-03-01-gone\.pdf - Form 337 copy: Could not be downloaded\.\n/,
    );
  });

  it("lists every file as not downloaded when it cannot ask for links", async () => {
    stubFetch({});
    const s = demoSnapshot();
    const a = s.aircraft[0];
    s.aircraftFiles = [
      {
        uuid: "f1",
        aircraftUuid: a.uuid,
        category: "form-337",
        name: "Repair.pdf",
        type: "application/pdf",
        size: 5,
        uploadedAt: Date.parse("2026-03-01T12:00:00Z"),
      },
    ];
    const result = await exportRecordsPackage({
      snapshot: s,
      aircraftUuid: a.uuid,
      backend: null,
      fileLinks: null,
      now: NOW,
    });
    expect(result.skipped.map((f) => [f.file.path, f.reason])).toEqual([
      ["form-337/2026-03-01-Repair.pdf", "Could not be downloaded"],
    ]);
  });

  it("fails when the font cannot be loaded", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    const s = demoSnapshot();
    await expect(
      exportRecordsPackage({
        snapshot: s,
        aircraftUuid: s.aircraft[0].uuid,
        backend: null,
        fileLinks: null,
        now: NOW,
      }),
    ).rejects.toThrow("Unable to load the PDF font. Reconnect and try again.");
  });
});

/**
 * Responsibility: Pins who sees which Form 337 controls, the copy order and
 *   the offline state of the aircraft's Form 337 section.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AircraftFiles.tsx, src/data/demo.ts,
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { AircraftFile } from "../domain/aircraftFiles";
import { AircraftForm337 } from "./AircraftFiles";

let workspace = {
  backend: null as object | null,
  online: true,
  connected: true,
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const copy = (n: number, extra: Partial<AircraftFile> = {}): AircraftFile => ({
  uuid: `f${n}`,
  aircraftUuid: "demo-182",
  category: "form-337",
  name: `copy-${n}.pdf`,
  type: "application/pdf",
  size: 2048,
  uploadedAt: Date.UTC(2026, 0, n),
  url: `https://files.example/${n}`,
  ...extra,
});

function render(files: AircraftFile[], backend: object | null, online = true) {
  workspace = { backend, online, connected: true };
  const snapshot = demoSnapshot();
  snapshot.aircraftFiles = files;
  const aircraft = snapshot.aircraft.find((a) => a.uuid === "demo-182")!;
  return renderToStaticMarkup(
    h(AircraftForm337, { state: snapshot, aircraft }),
  );
}

describe("AircraftForm337", () => {
  it("says when the aircraft has no copies", () => {
    expect(render([], null)).toContain("No Form 337 copies on file.");
  });

  it("lists this aircraft's current copies, newest upload first", () => {
    const html = render(
      [copy(1), copy(3), copy(2), copy(4, { aircraftUuid: "demo-other" })],
      null,
    );
    const names = [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(["copy-3.pdf", "copy-2.pdf", "copy-1.pdf"]);
    expect(html).toContain('aria-label="N182MA Form 337 copies"');
  });

  it("shows a switch counting archived copies, without listing them", () => {
    const archived = { archivedAt: 1, archiveReason: "Superseded" };
    const html = render([copy(1), copy(2, archived), copy(3, archived)], null);
    expect(html).toContain("Show archived (2)");
    expect(html).not.toContain("copy-2.pdf");
  });

  it("gives readers no upload or archive controls", () => {
    const html = render([copy(1)], null);
    expect(html).toContain('aria-label="Open copy-1.pdf"');
    expect(html).not.toContain("Upload Form 337 copy");
    expect(html).not.toContain("Archive copy-1.pdf");
  });

  it("lets maintenance upload and archive while online", () => {
    const html = render([copy(1)], {});
    expect(html).toContain('aria-label="Archive copy-1.pdf"');
    expect(html).toMatch(
      /Upload Form 337 copy<input type="file"[^>]*class="dash-file-input" aria-describedby="[^"]+"\/>/,
    );
    expect(html).toContain("PDF, JPEG, PNG or WebP, up to 7 MiB.");
  });

  it("holds uploads and archiving while offline", () => {
    const html = render([copy(1)], {}, false);
    expect(html).not.toContain("Archive copy-1.pdf");
    expect(html).toMatch(/<input type="file"[^>]*disabled=""/);
    expect(html).toContain("Reconnect to upload or archive Form 337 copies.");
  });
});

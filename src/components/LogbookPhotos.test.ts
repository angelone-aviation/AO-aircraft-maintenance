/**
 * Responsibility: Pins who sees the logbook photo control, the thumbnail
 *   order, the waiting and failed marks on queued photos, and the prompt
 *   after a flight saves. The camera input and the full-size dialog need a
 *   browser: tests/e2e/logbook-photos.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/LogbookPhotos.tsx, src/data/demo.ts,
 *   src/data/logbookPhotos.ts (types), src/domain/aircraftFiles.ts (types),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { PendingLogbookPhoto } from "../data/logbookPhotos";
import type { AircraftFile } from "../domain/aircraftFiles";
import type { Snapshot } from "../domain/model";
import {
  LogbookPhotoPrompt,
  LogbookPhotoStrip,
  type LogbookPhotoTarget,
} from "./LogbookPhotos";

let workspace = {
  snapshot: null as Snapshot | null,
  pendingPhotos: [] as PendingLogbookPhoto[],
  attachLogbookPhoto: vi.fn(),
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const TARGET: LogbookPhotoTarget = {
  aircraftUuid: "demo-206",
  linkedKind: "flight",
  linkedUuid: "flight-1",
};

const photo = (n: number, extra: Partial<AircraftFile> = {}): AircraftFile => ({
  uuid: `p${n}`,
  aircraftUuid: "demo-206",
  category: "logbook-page",
  linkedKind: "flight",
  linkedUuid: "flight-1",
  name: `page-${n}.jpg`,
  type: "image/jpeg",
  size: 2048,
  uploadedAt: n,
  url: `https://files.example/${n}`,
  ...extra,
});

const queued = (name: string, error?: string): PendingLogbookPhoto => ({
  key: `flight-1:${name}`,
  aircraftUuid: "demo-206",
  linkedKind: "flight",
  linkedUuid: "flight-1",
  authorId: "demo-admin",
  programUuid: "demo-program",
  name,
  type: "image/jpeg",
  size: 3,
  queuedAt: 1,
  error,
  blob: new Blob([new Uint8Array([1])]),
});

function render(
  files: AircraftFile[],
  options: { user?: string; pending?: PendingLogbookPhoto[] } = {},
) {
  const snapshot = demoSnapshot();
  snapshot.aircraftFiles = files;
  if (options.user)
    snapshot.user = snapshot.members.find((m) => m.id === options.user)!;
  workspace = {
    snapshot,
    pendingPhotos: options.pending ?? [],
    attachLogbookPhoto: vi.fn(),
  };
  return renderToStaticMarkup(
    h(LogbookPhotoStrip, { target: TARGET, label: "Add a photo" }),
  );
}

describe("LogbookPhotoStrip", () => {
  it("offers the rear camera to a pilot with flight permission and nothing to a reader", () => {
    const html = render([], { user: "demo-pilot" });
    expect(html).toContain('capture="environment"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain("Add a photo");
    // An observer reads the aircraft but may not write to it.
    const snapshot = demoSnapshot();
    snapshot.user = { ...snapshot.user, isAdmin: false, groupIds: [] };
    workspace = { snapshot, pendingPhotos: [], attachLogbookPhoto: vi.fn() };
    expect(
      renderToStaticMarkup(
        h(LogbookPhotoStrip, { target: TARGET, label: "Add a photo" }),
      ),
    ).toBe("");
  });

  it("shows a record's current photos oldest first and none of another record's", () => {
    const html = render([
      photo(3),
      photo(1),
      photo(2, { archivedAt: 9 }),
      photo(4, { linkedUuid: "flight-2" }),
    ]);
    const labels = [
      ...html.matchAll(/aria-label="Open logbook photo ([^"]+)"/g),
    ].map((m) => m[1]);
    expect(labels).toEqual(["page-1.jpg", "page-3.jpg"]);
  });

  it("marks queued photos as waiting, or failed after a refusal", () => {
    const html = render([], {
      pending: [queued("a.jpg"), queued("b.jpg", "Flight not found.")],
    });
    expect(html).toContain('title="Waiting to upload"');
    expect(html).toContain(">Waiting<");
    expect(html).toContain('title="Flight not found."');
    expect(html).toContain(">Failed<");
  });
});

describe("LogbookPhotoPrompt", () => {
  it("says the flight is saved and offers the photo control and Done", () => {
    workspace = {
      snapshot: demoSnapshot(),
      pendingPhotos: [],
      attachLogbookPhoto: vi.fn(),
    };
    const html = renderToStaticMarkup(
      h(LogbookPhotoPrompt, { target: TARGET, onDismiss: () => undefined }),
    );
    expect(html).toContain("Flight saved.");
    expect(html).toContain("Add a photo of the logbook line");
    expect(html).toContain(">Done<");
  });
});

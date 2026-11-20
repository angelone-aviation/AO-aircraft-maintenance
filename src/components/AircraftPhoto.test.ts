/**
 * Responsibility: Pins which aircraft photo controls show, and when they are
 *   disabled.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AircraftPhoto.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AircraftPhoto } from "./AircraftPhoto";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({
  useWorkspace: (select?: (state: Record<string, unknown>) => unknown) =>
    select ? select(workspace.state) : workspace.state,
}));

function render(aircraftUuid: string, online = true) {
  workspace.state = {
    snapshot: {
      aircraft: [
        { uuid: "a1", registration: "N1", hasPhoto: true },
        { uuid: "a2", registration: "N2" },
      ],
    },
    backend: {},
    online,
    connected: true,
  };
  return renderToStaticMarkup(h(AircraftPhoto, { aircraftUuid }));
}

describe("AircraftPhoto", () => {
  it("offers to remove an existing photo, previewed once its link arrives", () => {
    const html = render("a1");
    // The preview needs a link from the server: tests/e2e covers it.
    expect(html).not.toContain("<img");
    expect(html).toContain("Remove photo</button>");
  });

  it("offers only the file input without a photo", () => {
    const html = render("a2");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Remove photo");
    expect(html).toContain(
      '<input type="file" accept="image/jpeg,image/png,image/webp"/>',
    );
  });

  it("disables both actions offline", () => {
    expect(render("a1", false).match(/disabled=""/g)).toHaveLength(2);
  });
});

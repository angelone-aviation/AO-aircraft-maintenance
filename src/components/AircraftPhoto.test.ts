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
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

function render(aircraftUuid: string, online = true) {
  workspace.state = {
    snapshot: {
      aircraft: [
        { uuid: "a1", registration: "N1", photoUrl: "https://p.example/1" },
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
  it("previews the photo and offers to remove it", () => {
    const html = render("a1");
    expect(html).toContain('alt="N1 photo preview"');
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

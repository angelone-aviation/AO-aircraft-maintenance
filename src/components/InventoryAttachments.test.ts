/**
 * Responsibility: Pins who may upload and delete inventory attachments, the
 *   offline notice and the picked-file list. Viewing, downloading and
 *   uploading need a browser: tests/e2e/inventory-attachments.spec.ts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InventoryAttachments.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  InventoryAttachments,
  InventoryFilePicker,
} from "./InventoryAttachments";

const workspace = { snapshot: demoSnapshot(), online: true, connected: true };
vi.mock("../data/store", () => {
  const useWorkspace = () => workspace;
  useWorkspace.getState = () => workspace;
  return { useWorkspace };
});
beforeEach(() => {
  workspace.snapshot = demoSnapshot();
  workspace.snapshot.inventoryAttachments = [
    {
      uuid: "A1",
      stockUuid: "S1",
      name: "cert.pdf",
      type: "application/pdf",
      size: 1025,
      uploadedAt: 0,
      url: "https://files.example/cert",
    },
  ] as typeof workspace.snapshot.inventoryAttachments;
  workspace.online = true;
  workspace.connected = true;
});

const render = (stockUuid = "S1") =>
  renderToStaticMarkup(createElement(InventoryAttachments, { stockUuid }));
const NOTICE = "Reconnect to upload attachments";

describe("InventoryAttachments", () => {
  it("lets a program administrator upload and delete while connected", () => {
    const html = render();
    expect(html).toContain("cert.pdf</strong> · 2 KB");
    expect(html).toContain("Upload attachment");
    expect(html).toContain("Delete");
    expect(html).not.toContain(NOTICE);
  });

  it("offers neither to other users", () => {
    workspace.snapshot.user.isAdmin = false;
    workspace.snapshot.groups = [];
    const html = render();
    expect(html).not.toContain("Upload attachment");
    expect(html).not.toContain("Delete");
  });

  it("notes the need to reconnect and withholds delete offline", () => {
    workspace.connected = false;
    const html = render();
    expect(html).toContain(NOTICE);
    expect(html).not.toContain("Delete");
  });

  it("says when the item has no attachments", () => {
    expect(render("S2")).toContain("No attachments yet.");
  });
});

describe("InventoryFilePicker", () => {
  it("lists each picked file with its size in KB, rounded up", () => {
    const files = [new File(["x".repeat(1025)], "photo.png")];
    const html = renderToStaticMarkup(
      createElement(InventoryFilePicker, { files, onChange: () => {} }),
    );
    expect(html).toContain("photo.png · 2 KB");
    expect(html).toContain("Remove photo.png");
  });
});

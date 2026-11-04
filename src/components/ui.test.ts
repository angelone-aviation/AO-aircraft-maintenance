/**
 * Responsibility: Pins the markup, labelling, link and form-value rules of the
 *   shared UI building blocks, the blob and blank-CSV downloads, and that
 *   they show errors as src/data does.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ui.tsx, react-dom/server, src/data/errors.ts.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText as dataErrorText } from "../data/errors";
import {
  AsyncForm,
  Badge,
  DeleteFileButton,
  Empty,
  Field,
  Modal,
  PageTitle,
  download,
  downloadBlankCsv,
  errorText,
  safeHref,
  value,
} from "./ui";

const render = (element: ReactElement) => renderToStaticMarkup(element);
const save = async () => {};

describe("Modal", () => {
  it("adds its class after modal and opens wide on request", () => {
    const html = render(
      h(Modal, {
        title: "Edit",
        onClose: () => {},
        wide: true,
        className: "x",
        children: "body",
      }),
    );
    expect(html).toContain('<dialog class="ds-dialog wide modal x"');
    expect(
      render(h(Modal, { title: "Edit", onClose: () => {}, children: "body" })),
    ).toContain('<dialog class="ds-dialog modal"');
  });
});

describe("DeleteFileButton", () => {
  it("names the file in its accessible name", () => {
    expect(
      render(h(DeleteFileButton, { name: "photo.jpg", onDelete: save })),
    ).toBe(
      '<button type="button" class="text-button" aria-label="Delete photo.jpg">Delete</button>',
    );
  });

  it("can be disabled", () => {
    expect(
      render(
        h(DeleteFileButton, { name: "a", onDelete: save, disabled: true }),
      ),
    ).toContain('disabled=""');
  });
});

describe("AsyncForm", () => {
  it("defaults the submit label to Save and has no Close button without onClose", () => {
    expect(render(h(AsyncForm, { onSubmit: save, children: "fields" }))).toBe(
      '<form><fieldset>fields</fieldset><div class="form-footer"><button class="button primary"> Save</button></div></form>',
    );
  });

  it("disables the fields and submit button but not Close when disabled", () => {
    const html = render(
      h(AsyncForm, {
        onSubmit: save,
        onClose: () => {},
        submitLabel: "Send",
        disabled: true,
        children: "fields",
      }),
    );
    expect(html).toContain('<fieldset disabled="">fields</fieldset>');
    expect(html).toContain(
      '<button class="button primary" disabled=""> Send</button>',
    );
    expect(html).toContain(
      '<button type="button" class="button">Close</button>',
    );
  });
});

describe("Field", () => {
  it("ties a single element child to its label and hint", () => {
    const html = render(
      h(Field, { label: "Serial", hint: "As stamped", children: h("input") }),
    );
    const id = /<label for="([^"]+)">Serial<\/label>/.exec(html)?.[1];
    expect(html).toContain(`<input id="${id}" aria-describedby="${id}-hint"/>`);
    expect(html).toContain(`<small id="${id}-hint">As stamped</small>`);
  });

  it("links a component child only through the props it forwards", () => {
    type Linked = { id?: string; "aria-describedby"?: string };
    const Forwarding = (props: Linked) => h("select", props);
    const Dropping = () => h("select");
    const field = (child: ReactElement) =>
      render(h(Field, { label: "Unit", hint: "Pick one", children: child }));
    const linked = field(h(Forwarding));
    const id = /<label for="([^"]+)">Unit<\/label>/.exec(linked)?.[1];
    expect(linked).toContain(
      `<select id="${id}" aria-describedby="${id}-hint"></select>`,
    );
    expect(field(h(Dropping))).toContain("</label><select></select>");
  });

  it("renders any other child as is", () => {
    expect(render(h(Field, { label: "Serial", children: "text" }))).toMatch(
      /<\/label>text<\/div>$/,
    );
  });
});

describe("Badge", () => {
  it("shows a string's hyphens as spaces, in the neutral tone by default", () => {
    expect(render(h(Badge, { children: "not-yet-due" }))).toBe(
      '<span class="badge neutral">not yet due</span>',
    );
  });

  it("leaves element children untouched", () => {
    expect(
      render(h(Badge, { tone: "danger", children: h("b", null, "a-b") })),
    ).toBe('<span class="badge danger"><b>a-b</b></span>');
  });
});

describe("Empty and PageTitle", () => {
  it("puts the empty state's title over its paragraph", () => {
    expect(render(h(Empty, { title: "No files", children: "Add one." }))).toBe(
      '<div class="empty"><h3>No files</h3><p>Add one.</p></div>',
    );
  });

  it("draws the page title as a PageHeader with the action in its actions area", () => {
    const html = render(
      h(PageTitle, {
        eyebrow: "Shop",
        title: "Vendors",
        description: "All vendors",
        action: h("button", null, "New"),
      }),
    );
    expect(html).toContain('<header class="ds-page-header page-title">');
    expect(html).toContain(
      '<div class="ds-page-actions"><button>New</button></div>',
    );
  });
});

describe("safeHref", () => {
  it.each([
    "http://example.com/a",
    "https://example.com/b?c=d",
    "HTTPS://EXAMPLE.COM",
  ])("passes %s through unchanged", (url) => {
    expect(safeHref(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://example.com",
    "/relative",
    "",
    null,
    undefined,
  ])("refuses %j", (url) => {
    expect(safeHref(url)).toBeUndefined();
  });
});

describe("value", () => {
  it("trims the field and reads a missing one as empty", () => {
    const data = new FormData();
    data.set("serial", "  SN-1 ");
    expect(value(data, "serial")).toBe("SN-1");
    expect(value(data, "missing")).toBe("");
  });
});

describe("download and downloadBlankCsv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("saves the byte-order mark and quoted header row, ending in CRLF", async () => {
    const link = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link });
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:csv";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    downloadBlankCsv("template.csv", ["kind", "interval_hours", 'say "hi"']);
    expect(link).toMatchObject({ href: "blob:csv", download: "template.csv" });
    expect(link.click).toHaveBeenCalledOnce();
    expect(blobs[0].type).toBe("text/csv");
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(
      new TextEncoder().encode(
        '\uFEFF"kind","interval_hours","say ""hi"""\r\n',
      ),
    );
    downloadBlankCsv("utf8.csv", ["kind"], "text/csv;charset=utf-8");
    expect(blobs[1].type).toBe("text/csv;charset=utf-8");
  });

  it("saves a blob's bytes unchanged, under the type it is given", async () => {
    const link = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link });
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:file";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const bytes = new Uint8Array([0, 0xff, 0xfe, 0x80]);
    download("a.fmd", new Blob([bytes]), "application/octet-stream");
    expect(link).toMatchObject({ href: "blob:file", download: "a.fmd" });
    expect(blobs[0].type).toBe("application/octet-stream");
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes);
  });
});

describe("errorText", () => {
  it("is the data layer's helper, so screens and the Sync center agree", () => {
    expect(errorText).toBe(dataErrorText);
  });
});

/**
 * Responsibility: Pins the markup, labelling and link and form-value rules of
 *   the shared UI building blocks.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ui.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AsyncForm,
  Badge,
  DeleteFileButton,
  Empty,
  Field,
  Modal,
  PageTitle,
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

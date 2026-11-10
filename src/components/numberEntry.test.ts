/**
 * Responsibility: Pins the number field guard: a typed, pasted or dropped
 *   comma or exponent is refused and the field marked invalid; the mark
 *   outlasts later digits and clears only on a decimal point or an emptied
 *   field; other inputs are left alone; stopping removes the listeners.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/numberEntry.ts, src/domain/readings.ts.
 *
 * The suite has no DOM, so it stubs the two classes the guard tests events
 * against with minimal fakes; tests/e2e/number-entry.spec.ts runs it in a
 * browser.
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DECIMAL_COMMA_MESSAGE, EXPONENT_MESSAGE } from "../domain/readings";
import { guardNumberEntry } from "./numberEntry";

class FakeInput extends EventTarget {
  type = "number";
  value = "";
  validity = { badInput: false };
  dataset: Record<string, string> = {};
  validationMessage = "";
  attributes = new Map<string, string>();
  reportValidity = vi.fn(() => !this.validationMessage);
  setCustomValidity(message: string) {
    this.validationMessage = message;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

interface InsertInit {
  data?: string | null;
  dataTransfer?: { getData: (format: string) => string } | null;
}

class FakeInputEvent extends Event {
  data: string | null;
  dataTransfer: InsertInit["dataTransfer"];
  constructor(type: string, init: InsertInit = {}) {
    super(type, { cancelable: true });
    this.data = init.data ?? null;
    this.dataTransfer = init.dataTransfer ?? null;
  }
}

beforeAll(() => {
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("InputEvent", FakeInputEvent);
});
afterAll(() => vi.unstubAllGlobals());

describe("refused text", () => {
  it.each([
    ["a typed comma", { data: "," }, DECIMAL_COMMA_MESSAGE],
    ["a typed exponent", { data: "E" }, EXPONENT_MESSAGE],
    [
      "pasted text with a comma",
      { dataTransfer: paste("2342,5") },
      DECIMAL_COMMA_MESSAGE,
    ],
  ])("refuses %s and marks the field invalid", (_, init, message) => {
    const input = guarded();
    const event = type(input, init);
    expect(event.defaultPrevented).toBe(true);
    expect(input.validationMessage).toBe(message);
    expect(input.attributes.get("aria-invalid")).toBe("true");
    expect(input.reportValidity).toHaveBeenCalledOnce();
  });

  it("lets plain digits through", () => {
    const input = guarded();
    expect(type(input, { data: "7" }).defaultPrevented).toBe(false);
    expect(input.validationMessage).toBe("");
  });
});

describe("the invalid mark", () => {
  it("stays through digits typed after the refused comma", () => {
    const input = guarded();
    type(input, { data: "," });
    type(input, { data: "5" });
    expect(input.validationMessage).toBe(DECIMAL_COMMA_MESSAGE);
  });

  it("clears when a decimal point is typed", () => {
    const input = guarded();
    type(input, { data: "," });
    type(input, { data: "." });
    expect(input.validationMessage).toBe("");
    expect(input.attributes.has("aria-invalid")).toBe(false);
    expect(input.dataset).toEqual({});
  });

  it("clears when the field is emptied, but not while the browser holds bad input", () => {
    const input = guarded();
    type(input, { data: "," });
    input.validity.badInput = true;
    input.dispatchEvent(new Event("input"));
    expect(input.validationMessage).toBe(DECIMAL_COMMA_MESSAGE);
    input.validity.badInput = false;
    input.dispatchEvent(new Event("input"));
    expect(input.validationMessage).toBe("");
  });

  it("leaves a message the field set itself when no mark was made", () => {
    const input = guarded();
    input.setCustomValidity("Required.");
    type(input, { data: "." });
    expect(input.validationMessage).toBe("Required.");
  });
});

it("leaves inputs that are not number fields alone", () => {
  const input = guarded();
  input.type = "text";
  expect(type(input, { data: "," }).defaultPrevented).toBe(false);
});

it("stops watching by removing exactly the listeners it added", () => {
  // Node's EventTarget keeps a listener added with capture `true` when it is
  // removed the same way, unlike browsers, so the calls are compared instead.
  const input = new FakeInput();
  const added = vi.spyOn(input, "addEventListener");
  const removed = vi.spyOn(input, "removeEventListener");
  const stop = guardNumberEntry(input as unknown as HTMLElement);
  expect(removed).not.toHaveBeenCalled();
  stop();
  expect(added.mock.calls.map(([t]) => t)).toEqual(["beforeinput", "input"]);
  expect(removed.mock.calls).toEqual(added.mock.calls);
});

// The guard watches the input itself here: the fakes have no tree for an
// event to travel up to a document.
function guarded(): FakeInput {
  const input = new FakeInput();
  guardNumberEntry(input as unknown as HTMLElement);
  return input;
}

function type(input: FakeInput, init: InsertInit): FakeInputEvent {
  const event = new FakeInputEvent("beforeinput", init);
  input.dispatchEvent(event);
  return event;
}

function paste(text: string) {
  return { getData: (format: string) => (format === "text/plain" ? text : "") };
}

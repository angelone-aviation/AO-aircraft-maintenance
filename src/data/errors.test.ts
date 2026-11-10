/**
 * Responsibility: Pins which text a user sees for a failed command, load or
 *   sync, and that the Convex client's wrapper never reaches the screen.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/errors.ts, convex/values, zod,
 *   src/domain/addressLookup.ts, src/domain/addresses.ts,
 *   src/domain/logbookWording.ts, src/domain/rejection.ts.
 */
import { ConvexError, type Value } from "convex/values";
import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import { lookupInput } from "../domain/addressLookup";
import { blankAddress } from "../domain/addresses";
import { logbookPhrasesSchema } from "../domain/logbookWording";
import { MODULE_LOAD_ERROR_TEXT, errorText, isStaleSave } from "./errors";
import { StaleRecordRejection } from "../domain/rejection";

// The logbook phrase limit in src/domain/logbookWording.ts.
const PHRASE_MAX_LENGTH = 200;

describe("errorText", () => {
  const refusal = "Work order changed. Reload it and try again.";
  const requestId = "[Request ID: 8f3a1c2b9d4e5f60]";
  // Built the way convex/browser's client builds them (sync/client.js and
  // logging.js, convex 1.49): the wrapper becomes the message, and a
  // ConvexError's data is copied across from the server.
  const clientError = (serverMessage: string, data?: Value) => {
    const message = `[CONVEX M(workOrders:save)] ${requestId} ${serverMessage}\n  Called by client`;
    if (data === undefined) return new Error(message);
    const error = new ConvexError<Value>(message);
    error.data = data;
    return error;
  };
  const plainServerError = clientError("Server Error");

  it("shows a ConvexError's string data, not the wrapper", () => {
    const error = clientError(
      `Server Error\nUncaught ConvexError: ${refusal}`,
      refusal,
    );
    expect(errorText(error)).toBe(refusal);
    expect(errorText(new ConvexError(refusal), "Fallback.")).toBe(refusal);
  });

  it("shows a string message inside object data", () => {
    expect(
      errorText(clientError("Server Error", { code: "x", message: refusal })),
    ).toBe(refusal);
  });

  it("falls back for ConvexError data without a string message", () => {
    expect(
      errorText(clientError("Server Error", { code: "sso-refused" }), "F."),
    ).toBe("F.");
    expect(errorText(clientError("Server Error", { message: 4 }), "F.")).toBe(
      "F.",
    );
  });

  it("never shows a plain server error's wrapper", () => {
    expect(errorText(plainServerError, "Could not load.")).toBe(
      "Could not load.",
    );
    expect(
      errorText(
        new Error(`[CONVEX Q(engineTrends:list)] ${requestId} Server Error`),
      ),
    ).toBe(
      "Something went wrong. Try again, and tell an administrator if it keeps happening.",
    );
  });

  it("shows any other Error's message, as the demo and local checks throw", () => {
    expect(errorText(new Error("Connect to the live app."), "Fallback.")).toBe(
      "Connect to the live app.",
    );
  });

  it.each([
    "Failed to fetch dynamically imported module: https://app.test/assets/recordsPackage-Cd9q.js",
    "error loading dynamically imported module: https://app.test/assets/paperCheckReport-a1.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/Board-x.css",
  ])("explains a module the browser could not load: %s", (message) => {
    const failure = new TypeError(message);
    expect(errorText(failure, "Unable to export.")).toBe(
      MODULE_LOAD_ERROR_TEXT,
    );
  });

  it.each([undefined, null, "text", { message: refusal }])(
    "falls back for the non-Error %j",
    (thrown) => {
      expect(errorText(thrown, "Fallback.")).toBe("Fallback.");
    },
  );
});

describe("errorText for validation errors", () => {
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("Expected the schema to refuse the input.");
  };

  it("shows each issue message, never zod's JSON", () => {
    const error = thrown(() =>
      lookupInput({ ...blankAddress(), street: " ", country: "" }),
    );
    expect((error as ZodError).issues).toHaveLength(2);
    expect(errorText(error, "Fallback.")).toBe(
      "Enter a street address to look up.\nEnter a country to look up.",
    );
  });

  it("shows a schema's own message", () => {
    const error = thrown(() =>
      logbookPhrasesSchema.parse(["Repaired", " repaired"]),
    );
    expect(errorText(error)).toBe("Remove duplicate phrases.");
  });

  it("puts different messages on their own lines, in issue order", () => {
    const error = thrown(() =>
      logbookPhrasesSchema.parse([" ", "x".repeat(PHRASE_MAX_LENGTH + 1)]),
    );
    expect(errorText(error)).toBe(
      "Too small: expected string to have >=1 characters\nToo big: expected string to have <=200 characters",
    );
  });

  it("falls back for a validation error without issues", () => {
    expect(errorText(new ZodError([]), "Fallback.")).toBe("Fallback.");
  });
});

describe("isStaleSave", () => {
  const stale = new StaleRecordRejection("inspection", 2);
  it("recognises the domain's refusal and the server's copy of it", () => {
    expect(isStaleSave(stale)).toBe(true);
    expect(isStaleSave(new ConvexError(stale.message))).toBe(true);
    expect(isStaleSave(new ConvexError({ message: stale.message }))).toBe(true);
  });
  it("is false for any other failure", () => {
    expect(isStaleSave(new Error(stale.message.slice(1)))).toBe(false);
    expect(isStaleSave(new ConvexError("Work order changed."))).toBe(false);
    expect(isStaleSave(undefined)).toBe(false);
  });
});

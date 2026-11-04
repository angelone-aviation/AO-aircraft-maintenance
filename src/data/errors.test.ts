/**
 * Responsibility: Pins which text a user sees for a failed command, load or
 *   sync, and that the Convex client's wrapper never reaches the screen.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/errors.ts, convex/values.
 */
import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorText } from "./errors";

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

  it.each([undefined, null, "text", { message: refusal }])(
    "falls back for the non-Error %j",
    (thrown) => {
      expect(errorText(thrown, "Fallback.")).toBe("Fallback.");
    },
  );
});

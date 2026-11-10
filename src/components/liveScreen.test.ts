/**
 * Responsibility: Pins which screen the live app shows, including the page
 *   for a failed snapshot query and when the kept copy may open after one.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/liveScreen.ts, src/domain/model.ts (types).
 */
import { describe, expect, it } from "vitest";
import {
  chooseLiveScreen,
  keptCopyIsTheirs,
  type LiveSession,
} from "./liveScreen";
import type { Snapshot } from "../domain/model";

const ofUser = (id: string) => ({ user: { id } }) as Snapshot;
const session = (patch: Partial<LiveSession> = {}): LiveSession => ({
  ready: true,
  snapshot: ofUser("u1"),
  online: true,
  socket: true,
  isLoading: false,
  isAuthenticated: true,
  result: undefined,
  ...patch,
});
const failure = new Error(
  "[CONVEX Q(operations:snapshot)] Too many bytes read",
);

describe("chooseLiveScreen", () => {
  it("shows the unavailable page, not an endless load, when the query fails", () => {
    expect(chooseLiveScreen(session({ failure }))).toBe("unavailable");
    expect(chooseLiveScreen(session({ failure, snapshot: null }))).toBe(
      "unavailable",
    );
  });

  it("opens the kept copy after a failure only when chosen and it is the signed-in account's", () => {
    const theirs = session({ failure, signedInUserId: "u1" });
    expect(chooseLiveScreen(theirs)).toBe("unavailable");
    expect(chooseLiveScreen(theirs, true)).toBe("workspace");
    expect(
      chooseLiveScreen(session({ failure, signedInUserId: "u2" }), true),
    ).toBe("unavailable");
    expect(chooseLiveScreen(session({ failure }), true)).toBe("unavailable");
  });

  it("keeps the offline and connected paths as they were", () => {
    expect(chooseLiveScreen(session({ ready: false, failure }))).toBe(
      "loading",
    );
    expect(chooseLiveScreen(session())).toBe("loading");
    expect(chooseLiveScreen(session({ socket: false, failure }))).toBe(
      "workspace",
    );
    expect(chooseLiveScreen(session({ result: ofUser("u1") }))).toBe(
      "workspace",
    );
    expect(chooseLiveScreen(session({ result: ofUser("u2") }))).toBe("sign-in");
    expect(
      chooseLiveScreen(session({ isAuthenticated: false, result: undefined })),
    ).toBe("sign-in");
  });
});

describe("keptCopyIsTheirs", () => {
  it("is false until the signed-in account is known, and for another account's copy", () => {
    expect(keptCopyIsTheirs({ snapshot: ofUser("u1") })).toBe(false);
    expect(
      keptCopyIsTheirs({ snapshot: ofUser("u1"), signedInUserId: null }),
    ).toBe(false);
    expect(
      keptCopyIsTheirs({ snapshot: ofUser("u1"), signedInUserId: "u2" }),
    ).toBe(false);
    expect(keptCopyIsTheirs({ snapshot: null, signedInUserId: "u1" })).toBe(
      false,
    );
    expect(
      keptCopyIsTheirs({ snapshot: ofUser("u1"), signedInUserId: "u1" }),
    ).toBe(true);
  });
});

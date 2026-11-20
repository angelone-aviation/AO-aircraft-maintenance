/**
 * Responsibility: Pins the sign-out warning: how it counts the user's
 *   unsynced entries and photos, and the choices it offers.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/SignOutConfirm.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SignOutDialog, unsyncedTitle } from "./SignOutConfirm";

vi.mock("../data/store", () => ({ useWorkspace: { getState: () => ({}) } }));

it("names how many entries and photos have not synced", () => {
  expect(unsyncedTitle({ entries: 1, photos: 0 })).toBe(
    "1 entry hasn't synced",
  );
  expect(unsyncedTitle({ entries: 0, photos: 3 })).toBe(
    "3 photos haven't synced",
  );
  expect(unsyncedTitle({ entries: 2, photos: 1 })).toBe(
    "2 entries and 1 photo haven't synced",
  );
});

it("says signing out deletes them and offers to stay signed in first", () => {
  const html = renderToStaticMarkup(
    h(SignOutDialog, {
      items: { entries: 1, photos: 1 },
      onStay: () => {},
      onSignOut: () => {},
    }),
  );
  expect(html).toContain("1 entry and 1 photo haven&#x27;t synced");
  expect(html).toContain(
    "Signing out deletes them from this device. They have not reached the server and cannot be recovered.",
  );
  expect(html).toContain("Stay signed in to sync them when you are connected.");
  expect(html.indexOf("Stay signed in</button>")).toBeLessThan(
    html.indexOf("Delete and sign out</button>"),
  );
});

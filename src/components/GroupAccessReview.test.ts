/**
 * Responsibility: Pins what the group access notice shows: the failed-check
 *   notice, singular and plural wording, the other-program warning, the
 *   status pill and the shortened member list.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/GroupAccessReview.tsx,
 *   src/domain/groupAccessReview.ts (report type), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import { GroupAccessNotice } from "./GroupAccessReview";

const report = (over: Partial<GroupAccessReport> = {}): GroupAccessReport => ({
  groupId: "g1",
  groupName: "Pilots",
  programUuid: "p1",
  programName: "Program One",
  flag: "review",
  reason: "no_before",
  aircraftBefore: [],
  members: [],
  ...over,
});
const member = (n: number, active = true) => ({
  id: `u${n}`,
  name: `User ${n}`,
  email: "",
  active,
});
const notice = (props: Partial<Parameters<typeof GroupAccessNotice>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GroupAccessNotice, {
      reports: [report()],
      activeProgramUuid: "p1",
      disabled: false,
      onEdit: () => {},
      ...props,
    }),
  );

describe("GroupAccessNotice", () => {
  it("shows the failed check instead of the list", () => {
    const html = notice({ error: "Offline" });
    expect(html).toContain("Aircraft access could not be checked: Offline");
    expect(html).not.toContain("adm-review-list");
  });

  it("renders nothing when no group needs review", () => {
    expect(notice({ reports: [] })).toBe("");
  });

  it("words one group in the singular", () => {
    const html = notice();
    expect(html).toContain(
      "<strong>Check aircraft access for 1 permission group</strong>",
    );
    expect(html).toContain(
      "<p>This group covers every aircraft in its Flight Program,",
    );
    expect(html).not.toContain("switches to that program");
  });

  it("words several groups in the plural and warns about other programs", () => {
    const html = notice({
      reports: [report(), report({ groupId: "g2", programUuid: "p2" })],
    });
    expect(html).toContain("for 2 permission groups</strong>");
    expect(html).toContain("These groups cover every aircraft in their");
    expect(html).toContain(
      "until you save. Editing a group in another Flight Program switches to that program.</p>",
    );
  });

  it("marks a widened group and disables editing when asked", () => {
    const html = notice({
      disabled: true,
      reports: [report({ flag: "widened", reason: "owner_removed" })],
    });
    expect(html).toContain(
      '<span class="ds-pill ds-tone-danger">Opened to all aircraft</span>',
    );
    expect(html).toContain('disabled="">Edit group</button>');
  });

  it("lists five members, marks disabled ones and counts the rest", () => {
    const members = [1, 2, 3, 4, 5, 6, 7].map((n) => member(n, n !== 2));
    expect(notice({ reports: [report({ members })] })).toContain(
      "Members: User 1, User 2 (disabled), User 3, User 4, User 5 and 2 more",
    );
    expect(notice()).toContain(
      '<span class="adm-review-members">No members</span>',
    );
  });
});

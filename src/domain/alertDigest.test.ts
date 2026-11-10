/**
 * Responsibility: Pins how the alert digest groups, flattens and limits its
 *   alerts, and the urgent email and push message. Escaping and links are
 *   pinned in alerts.test.ts, the backup warning in offsiteBackups.test.ts.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/alertDigest.ts, alerts.ts (types).
 */
import { expect, it } from "vitest";
import {
  DIGEST_LIMIT,
  digestEmail,
  URGENT_LIMIT,
  urgentEmail,
  urgentPushPayload,
} from "./alertDigest";
import type { Alert } from "./alerts";

const alert = (key: string, severity: Alert["severity"]): Alert => ({
  key,
  kind: "inspection-overdue",
  severity,
  title: `Title ${key}`,
  detail: `Detail ${key}`,
  entityUuid: key,
  link: "/inspections",
});

it("groups alerts action required, coming due, then for review, leaving out empty groups", () => {
  const email = digestEmail(
    [alert("a", "info"), alert("b", "danger"), alert("c", "info")],
    { programName: "Ops" },
  );
  expect(email.text).toBe(
    [
      "Ops maintenance alerts",
      "",
      "ACTION REQUIRED",
      "- Title b\n  Detail b",
      "",
      "FOR REVIEW",
      "- Title a\n  Detail a",
      "- Title c\n  Detail c",
      "",
      "Turn these emails off under My certifications in the app.",
    ].join("\n"),
  );
  expect(email.html.indexOf("<h3>Action required</h3>")).toBeLessThan(
    email.html.indexOf("<h3>For review</h3>"),
  );
  expect(email.html).not.toContain("Coming due");
});

it("keeps each alert to one line of title and one of detail in the text", () => {
  const multiline = {
    ...alert("a", "warning"),
    title: "First\r\nsecond",
    detail: " Detail\nmore ",
  };
  const email = digestEmail([multiline], { programName: "Ops" });
  expect(email.text).toContain("- First second\n  Detail more\n");
});

it("shows the first DIGEST_LIMIT alerts", () => {
  const alerts = Array.from({ length: DIGEST_LIMIT + 1 }, (_, i) =>
    alert(String(i), "danger"),
  );
  const { shown } = digestEmail(alerts, { programName: "Ops" });
  expect(shown.map((a) => a.key)).toEqual(
    alerts.slice(0, DIGEST_LIMIT).map((a) => a.key),
  );
});

it("lists urgent alerts with their links, counts the rest, and escapes record text", () => {
  const hostile = {
    ...alert("x", "danger"),
    title: "Grounded <b>&</b>",
    detail: "Line one\r\nline two",
  };
  const email = urgentEmail([hostile], {
    programName: "Ops\nTeam",
    siteUrl: "https://app.example.test/",
  });
  expect(email.subject).toBe("Ops Team: 1 urgent alert");
  expect(email.text).toBe(
    [
      "Ops Team: 1 urgent alert",
      "",
      "- Grounded <b>&</b>\n  Line one line two\n  https://app.example.test/inspections",
      "",
      "Turn these emails off under Settings → My account in the app.",
    ].join("\n"),
  );
  expect(email.html).toContain(
    '<li><a href="https://app.example.test/inspections">Grounded &lt;b&gt;&amp;&lt;/b&gt;</a><br>Line one',
  );
  expect(email.html).not.toContain("<b>");
  const many = Array.from({ length: URGENT_LIMIT + 2 }, (_, i) =>
    alert(String(i), "danger"),
  );
  const capped = urgentEmail(many, { programName: "Ops" });
  expect(capped.subject).toBe(`Ops: ${URGENT_LIMIT + 2} urgent alerts`);
  expect(capped.shown).toHaveLength(URGENT_LIMIT);
  expect(capped.text).toContain("and 2 more in the app.");
  expect(capped.text).not.toContain("https://");
});

it("builds a push message of alert titles that opens the alerts screen", () => {
  const payload = urgentPushPayload(
    [alert("a", "danger"), { ...alert("b", "danger"), title: "Two\nlines" }],
    "Ops",
  );
  expect(payload).toEqual({
    title: "Ops: 2 urgent alerts",
    body: "Title a\nTwo lines",
    url: "/alerts",
    tag: "urgent:Ops",
  });
  const many = Array.from({ length: URGENT_LIMIT + 3 }, (_, i) =>
    alert(String(i), "danger"),
  );
  const capped = urgentPushPayload(many, "Ops");
  expect(capped.body.split("\n")).toHaveLength(URGENT_LIMIT + 1);
  expect(capped.body.endsWith("and 3 more")).toBe(true);
  const long = urgentPushPayload(
    [{ ...alert("l", "danger"), title: "x".repeat(500) }],
    "Ops",
  );
  expect(long.body).toHaveLength(400);
});

it("tags every push message of a program alike, whatever its count, so a newer card replaces the older", () => {
  const one = urgentPushPayload([alert("a", "danger")], "Ops", "program-1");
  const two = urgentPushPayload(
    [alert("a", "danger"), alert("b", "danger")],
    "Ops",
    "program-1",
  );
  expect(one.tag).toBe("urgent:program-1");
  expect(two.tag).toBe(one.tag);
  expect(
    urgentPushPayload([alert("a", "danger")], "Ops", "program-2").tag,
  ).not.toBe(one.tag);
});

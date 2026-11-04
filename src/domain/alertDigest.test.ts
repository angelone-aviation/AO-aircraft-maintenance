/**
 * Responsibility: Pins how the alert digest groups, flattens and limits its
 *   alerts. Escaping and links are pinned in alerts.test.ts, the backup
 *   warning in offsiteBackups.test.ts.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/alertDigest.ts, alerts.ts (types).
 */
import { expect, it } from "vitest";
import { DIGEST_LIMIT, digestEmail } from "./alertDigest";
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

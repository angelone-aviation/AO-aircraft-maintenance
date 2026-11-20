/**
 * Responsibility: Pins the off-site backup freshness rule and its wording, and
 *   the backup warning in the daily alert email.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/offsiteBackups.ts, src/domain/alertDigest.ts.
 */
import { describe, expect, it } from "vitest";
import { offsiteFreshness, OFFSITE_STALE_AFTER_MS } from "./offsiteBackups";
import { backupWarningEmail, digestEmail } from "./alertDigest";

const now = Date.UTC(2026, 10, 4, 13, 0);
const minute = 60_000;
const hour = 60 * minute;
const at = (ago: number) => offsiteFreshness({ completedAt: now - ago }, now);

describe("off-site backup freshness", () => {
  it("is none before the first copy is recorded", () => {
    for (const latest of [null, undefined])
      expect(offsiteFreshness(latest, now)).toEqual({
        status: "none",
        message: "No off-site backup has been recorded yet.",
      });
  });

  it("is ok up to and including exactly 26 hours", () => {
    expect(OFFSITE_STALE_AFTER_MS).toBe(26 * hour);
    expect(at(2 * hour)).toEqual({
      status: "ok",
      message: "Last off-site backup 2 hours ago.",
    });
    expect(at(26 * hour)).toEqual({
      status: "ok",
      message: "Last off-site backup 26 hours ago.",
    });
  });

  it("is stale one millisecond after 26 hours", () => {
    expect(at(26 * hour + 1)).toEqual({
      status: "stale",
      message:
        "No off-site backup for 26 hours. Check the Nightly backup job in GitHub Actions.",
    });
    expect(at(47 * hour + 59 * minute).message).toMatch(
      /^No .* for 47 hours\./,
    );
    expect(at(2 * 24 * hour + 5 * hour).message).toBe(
      "No off-site backup for 2 days. Check the Nightly backup job in GitHub Actions.",
    );
  });

  // Decision D10: the nightly job finishes about 08:45 UTC and the digest
  // checks at 13:00 UTC, so one missed night must show at the next digest.
  it("warns at the first digest after one missed night", () => {
    const digest = Date.UTC(2026, 10, 10, 13, 0);
    const finished = (day: number) => ({
      completedAt: Date.UTC(2026, 10, day, 8, 45),
    });
    expect(offsiteFreshness(finished(10), digest).status).toBe("ok");
    expect(offsiteFreshness(finished(9), digest)).toEqual({
      status: "stale",
      message:
        "No off-site backup for 28 hours. Check the Nightly backup job in GitHub Actions.",
    });
  });

  it("words ages in hours under two days, then in whole days", () => {
    expect(at(37 * hour).message).toMatch(/^No .* for 37 hours\./);
    expect(at(2 * 24 * hour).message).toMatch(/^No .* for 2 days\./);
    expect(at(3 * 24 * hour - 1).message).toMatch(/^No .* for 2 days\./);
  });

  it("words short ages plainly, including a clock slightly ahead", () => {
    expect(at(30 * 1000).message).toBe(
      "Last off-site backup less than a minute ago.",
    );
    expect(at(-5 * minute)).toEqual({
      status: "ok",
      message: "Last off-site backup less than a minute ago.",
    });
    expect(at(minute).message).toBe("Last off-site backup 1 minute ago.");
    expect(at(59 * minute).message).toBe(
      "Last off-site backup 59 minutes ago.",
    );
    expect(at(hour).message).toBe("Last off-site backup 1 hour ago.");
  });
});

describe("off-site backup warning in the alert email", () => {
  const alert = {
    key: "k",
    title: "Annual N206MA",
    detail: "Overdue",
    severity: "danger" as const,
    link: "/inspections" as const,
  };

  it("puts the warning above the maintenance alerts, escaped", () => {
    const email = digestEmail([alert], {
      programName: "Ops",
      siteUrl: "https://app.example.test/",
      backupWarning: 'No <b>backup</b> & "more"\r\nBcc: x',
    });
    expect(email.subject).toBe("Ops: 1 maintenance alert");
    expect(
      email.html.startsWith("<p><strong>Off-site backups:</strong> "),
    ).toBe(true);
    expect(email.html).toContain(
      "No &lt;b&gt;backup&lt;/b&gt; &amp; &quot;more&quot; Bcc: x",
    );
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain(
      '<a href="https://app.example.test/settings#system">',
    );
    expect(email.html.indexOf("Off-site backups")).toBeLessThan(
      email.html.indexOf("Annual N206MA"),
    );
    expect(email.text.split("\n").slice(0, 3)).toEqual([
      'Off-site backups: No <b>backup</b> & "more" Bcc: x',
      "https://app.example.test/settings#system",
      "",
    ]);
  });

  it("leaves the digest unchanged without a warning", () => {
    const options = { programName: "Ops", siteUrl: "https://app.example.test" };
    const plain = digestEmail([alert], options);
    expect(digestEmail([alert], { ...options, backupWarning: "" })).toEqual(
      plain,
    );
    expect(plain.html).not.toContain("Off-site");
    expect(plain.text.startsWith("Ops maintenance alerts")).toBe(true);
  });

  it("sends the warning alone, without links to a non-http site", () => {
    const email = backupWarningEmail("No off-site backup <yet>.", {
      siteUrl: "javascript:alert(1)",
    });
    expect(email.subject).toBe("Off-site backup warning");
    expect(email.html).not.toContain("href");
    expect(email.html).toContain("No off-site backup &lt;yet&gt;.");
    expect(email.text).toBe(
      "Off-site backups: No off-site backup <yet>.\n\nTurn these emails off under My certifications in the app.",
    );
  });
});

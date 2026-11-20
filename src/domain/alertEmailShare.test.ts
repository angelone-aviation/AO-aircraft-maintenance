/**
 * Responsibility: Pins each Flight Program's share of the day's immediate
 *   urgent-alert emails and the warning system administrators get when a
 *   program's share holds an email back (decision D9).
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/alerts.ts, src/domain/alertDigest.ts.
 */
import { expect, it } from "vitest";
import {
  IMMEDIATE_EMAIL_SHARE_FLOOR,
  IMMEDIATE_EMAILS_PER_DAY,
  immediateEmailShare,
} from "./alerts";
import { shareReachedEmail } from "./alertDigest";

it("splits the day's immediate emails equally between active programs, never below the floor", () => {
  expect(IMMEDIATE_EMAILS_PER_DAY).toBe(60);
  expect(IMMEDIATE_EMAIL_SHARE_FLOOR).toBe(10);
  expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(immediateEmailShare)).toEqual([
    60, 60, 30, 20, 15, 12, 10, 10, 10,
  ]);
});

it("warns that a program's share is spent, naming the share, the total and the digest", () => {
  const email = shareReachedEmail("Mission <ops>\nB", 30, {
    siteUrl: "https://app.example.test/",
  });
  expect(email.subject).toBe(
    "System: Mission <ops> B reached its share of urgent alert emails",
  );
  expect(email.text).toContain(
    "Mission <ops> B has sent its 30 immediate urgent-alert emails for today, its share of the deployment's 60.",
  );
  expect(email.text).toContain("daily digest at 13:00 UTC");
  expect(email.text).toContain("https://app.example.test/settings#system");
  expect(email.html).toContain("Mission &lt;ops&gt; B");
  expect(email.html).not.toContain("<ops>");
});

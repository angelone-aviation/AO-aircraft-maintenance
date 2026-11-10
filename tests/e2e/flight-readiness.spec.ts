/**
 * Responsibility: Pins the OK-to-fly line on aircraft cards and the aircraft
 *   detail: the verdict in words, the one reason, and the switch to "Not OK
 *   to fly" once a grounding problem is reported, at phone and desktop size.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Page } from "@playwright/test";

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const DEFECT = "Alternator inoperative after start";

for (const size of SIZES) {
  test(`shows OK to fly, due-soon notes and grounding on ${size.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openDemo(page);
    const n208 = page.getByRole("article", { name: "N208MA" });
    await expect(n208.locator(".readiness")).toHaveText("OK to fly");
    const n206 = page.getByRole("article", { name: "N206MA" });
    await expect(n206.locator(".readiness")).toHaveText(
      "OK to fly 100-hour inspection due soon",
      { useInnerText: true },
    );

    await reportGroundingProblem(page);
    const line = n206.locator(".readiness");
    await expect(line).toHaveText(`Not OK to fly Open discrepancy: ${DEFECT}`, {
      useInnerText: true,
    });
    await n206.getByRole("button", { name: /View aircraft/ }).click();
    const detail = page.getByRole("dialog", { name: "N206MA" });
    await expect(detail.locator(".readiness")).toContainText("Not OK to fly");
    await expect(detail.locator(".readiness")).toContainText(DEFECT);
  });
}

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

async function reportGroundingProblem(page: Page) {
  await page.goto("/discrepancies");
  await page.getByRole("button", { name: "Report a problem" }).click();
  await page.getByLabel("What did you observe?").fill(DEFECT);
  await page.getByRole("checkbox", { name: /Aircraft not airworthy/ }).check();
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("/");
}

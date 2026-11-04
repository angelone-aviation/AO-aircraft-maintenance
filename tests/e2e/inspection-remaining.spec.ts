/**
 * Responsibility: Pins the aircraft's inspection schedules: remaining or
 *   overdue units shown, and numeric sorting in both directions.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 */
import { test, expect, type Locator } from "@playwright/test";

test("aircraft inspection schedules display remaining units and offer numeric sorting", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: /View aircraft/i })
    .first()
    .click();
  const region = page.getByRole("region", {
    name: "Inspection schedules",
    exact: true,
  });
  await expect(region).toBeVisible();
  await expect(
    region.getByText(/hours (remaining|overdue)/).first(),
  ).toBeVisible();
  const sort = region.getByLabel("Sort inspection schedules by");
  await sort.selectOption("hours");
  const ascending = await readRemainingHours(region);
  expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
  await region.getByLabel("Inspection sort order").selectOption("descending");
  const descending = await readRemainingHours(region);
  expect(descending).toEqual([...descending].sort((a, b) => b - a));
  await sort.selectOption("months");
  await sort.selectOption("cycles");
  await sort.selectOption("name");
});

// Overdue hours count below zero, so ascending order starts with the most
// overdue schedule.
async function readRemainingHours(region: Locator): Promise<number[]> {
  const texts = await region.locator(".list-row").allInnerTexts();
  return texts.flatMap((text) => {
    const match = text.match(/([\d.]+) hours (remaining|overdue)/);
    if (!match) return [];
    return [Number(match[1]) * (match[2] === "overdue" ? -1 : 1)];
  });
}

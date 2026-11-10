/**
 * Responsibility: Pins the "hours left" meters on the demo fleet: a meter
 *   per limit with a known interval on the Inspections screen, the
 *   maintenance outlook and the aircraft's schedules, the word "Overdue" with
 *   an empty meter, and no meter where the interval is unknown.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test.
 *
 * N206MA reads 2,341.2 hours. A 100-hour repeat last done at 2,250 leaves
 * 8.8 hours (9% of the interval, due soon); a 50-hour repeat last done at
 * 2,280 is 11.2 hours overdue. The demo's own 100-hour inspections set only
 * a due value, so their interval is unknown.
 */
import { test, expect, type Page } from "@playwright/test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

for (const [size, viewport] of [
  ["phone", PHONE],
  ["desktop", DESKTOP],
] as const) {
  test(`shows the share of each interval left beside the remaining amount (${size})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openDemo(page);
    await addHourInspection(page, "METER-SOON", "100", "2250");
    await addHourInspection(page, "METER-OVER", "50", "2280");

    const soon = inspectionRow(page, "METER-SOON");
    await expect(soon).toContainText("8.8 h remaining");
    await expectMeter(soon.getByRole("meter"), "METER-SOON", 9);
    await expect(dueCell(soon).getByText("Overdue")).toHaveCount(0);

    const over = inspectionRow(page, "METER-OVER");
    await expect(over).toContainText("11.2 h overdue");
    await expectMeter(over.getByRole("meter"), "METER-OVER", 0);
    await expect(
      dueCell(over).getByText("Overdue", { exact: true }),
    ).toBeVisible();

    const unknown = inspectionRow(page, "100-hour inspection").first();
    await expect(unknown).toContainText("remaining");
    await expect(unknown.getByRole("meter")).toHaveCount(0);

    await page.goto("/");
    const outlook = page.locator(".dash-outlook");
    await expectMeter(outlook.getByRole("meter").first(), "METER-OVER", 0);
    await expect(outlook.getByRole("meter")).toHaveCount(2);

    await page
      .getByRole("article", { name: "N206MA" })
      .getByRole("button", { name: /View aircraft/ })
      .click();
    const schedules = page.getByRole("region", {
      name: "Inspection schedules",
      exact: true,
    });
    await expectMeter(
      schedules.getByRole("meter", { name: /^METER-SOON/ }),
      "METER-SOON",
      9,
    );
    await expect(schedules.getByText("Overdue", { exact: true })).toHaveCount(
      1,
    );
  });
}

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inspections");
  await expect(
    page.getByRole("button", { name: "New inspection", exact: true }),
  ).toBeVisible();
}

async function addHourInspection(
  page: Page,
  reference: string,
  everyHours: string,
  lastHours: string,
) {
  await page
    .getByRole("button", { name: "New inspection", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "New inspection" });
  await form.getByLabel("Reference", { exact: true }).fill(reference);
  await form.getByLabel("Description", { exact: true }).fill("Meter check");
  await form.getByRole("checkbox", { name: "Hours", exact: true }).check();
  await form
    .getByLabel("Repeat every (hours)", { exact: true })
    .fill(everyHours);
  await form.getByLabel("Last complied at (tracked hours)").fill(lastHours);
  await form
    .getByRole("button", { name: "Save inspection", exact: true })
    .click();
  await expect(form).not.toBeVisible();
}

// The status pill also reads "Overdue"; the meter's word sits in the due cell.
function dueCell(row: ReturnType<Page["getByRole"]>) {
  return row.locator(".mx-insp-due");
}

function inspectionRow(page: Page, reference: string) {
  return page.getByRole("row").filter({ hasText: reference });
}

async function expectMeter(
  meter: ReturnType<Page["getByRole"]>,
  item: string,
  percent: number,
) {
  await expect(meter).toHaveAttribute("aria-label", `${item}: hours left`);
  await expect(meter).toHaveAttribute("aria-valuenow", String(percent));
  await expect(meter).toHaveAttribute(
    "aria-valuetext",
    `${percent}% of the interval left`,
  );
}

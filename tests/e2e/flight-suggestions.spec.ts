/**
 * Responsibility: Pins the flight form's history helpers: "Same as last
 *   flight" fills pilot, copilot and route only, appears only when the
 *   aircraft has a previous flight, and the route fields suggest the
 *   program's places, at phone and desktop size.
 * Layer: Test. Playwright spec against the demo in a production build.
 * Dependencies: @playwright/test, tests/fixtures/localDateTime.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { localDateTime } from "../fixtures/localDateTime";

const HOUR_MS = 60 * 60 * 1000;
const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];
const REPEAT = { name: "Same as last flight", exact: true };

for (const size of SIZES) {
  test(`repeats the last flight's crew and route on ${size.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await openDemo(page);
    let form = await openFlightForm(page);
    await expect(form.getByRole("button", REPEAT)).toHaveCount(0);
    await logFirstFlight(form);

    form = await openFlightForm(page);
    const time = await form.getByLabel("Flight date & time").inputValue();
    const start = await form.getByLabel("Starting Hobbs (hours)").inputValue();
    expect(start).toBe("2342.2");
    await form.getByRole("button", REPEAT).click();
    await expect(form.getByLabel("Pilot", { exact: true })).toHaveValue(
      await optionValue(form, "Pilot", "Jordan Lee"),
    );
    await expect(form.getByLabel(/^Copilot/)).toHaveValue(
      await optionValue(form, /^Copilot/, "Alex Morgan"),
    );
    await expect(form.getByLabel("Origin", { exact: true })).toHaveValue(
      "KBOI",
    );
    await expect(form.getByLabel("Destination", { exact: true })).toHaveValue(
      "KMYL",
    );
    await expect(
      form.getByText(/filled from N206MA's last flight/),
    ).toBeVisible();
    // Readings and the date are the new flight's own.
    await expect(
      form.getByLabel("Ending Hobbs *", { exact: true }),
    ).toHaveValue("");
    await expect(form.getByLabel("Flight date & time")).toHaveValue(time);

    await selectAircraft(form, "N208MA");
    await expect(form.getByRole("button", REPEAT)).toHaveCount(0);
  });
}

test("suggests the program's places on the route fields", async ({ page }) => {
  await openDemo(page);
  await logFirstFlight(await openFlightForm(page));
  const form = await openFlightForm(page);
  const origin = form.getByLabel("Origin", { exact: true });
  const listId = await origin.getAttribute("list");
  expect(
    await form.getByLabel("Destination", { exact: true }).getAttribute("list"),
  ).toBe(listId);
  const options = page.locator(`datalist[id="${listId}"] option`);
  await expect(options).toHaveCount(2);
  expect(
    await options.evaluateAll((o) =>
      o.map((e) => (e as HTMLOptionElement).value).sort(),
    ),
  ).toEqual(["KBOI", "KMYL"]);
  await origin.fill("Somewhere new");
  await expect(origin).toHaveValue("Somewhere new");
});

async function openDemo(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your fleet, at a glance." }),
  ).toBeVisible();
}

async function openFlightForm(page: Page) {
  await page
    .getByRole("article", { name: "N206MA" })
    .getByRole("button", { name: "Log flight", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await selectAircraft(form, "N206MA");
  return form;
}

async function logFirstFlight(form: Locator) {
  await form
    .getByLabel("Pilot", { exact: true })
    .selectOption({ label: "Jordan Lee" });
  await form.getByLabel(/^Copilot/).selectOption({ label: "Alex Morgan" });
  await form
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - HOUR_MS));
  await form.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await form.getByLabel("Origin", { exact: true }).fill("KBOI");
  await form.getByLabel("Destination", { exact: true }).fill("KMYL");
  await form.getByRole("button", { name: "Save flight", exact: true }).click();
  await expect(form).not.toBeVisible();
}

async function selectAircraft(form: Locator, registration: string) {
  const select = form.getByLabel("Aircraft", { exact: true });
  const option = select.locator("option").filter({ hasText: registration });
  await select.selectOption(await option.getAttribute("value"));
}

async function optionValue(
  form: Locator,
  label: string | RegExp,
  name: string,
) {
  const select =
    typeof label === "string"
      ? form.getByLabel(label, { exact: true })
      : form.getByLabel(label);
  return (
    (await select.locator("option", { hasText: name }).getAttribute("value")) ??
    ""
  );
}

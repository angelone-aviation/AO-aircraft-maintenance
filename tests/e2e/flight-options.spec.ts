import { test, expect, type Page } from "@playwright/test";
import { localDateTime } from "../fixtures/localDateTime";
async function configure(page: Page, options: string[]) {
  await page.goto("/aircraft");
  await page
    .getByRole("button", { name: "Edit aircraft", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const registration = await dialog
    .getByLabel("Registration", { exact: true })
    .inputValue();
  for (const option of ["Twin", "Turbine", "Amphibious"])
    await dialog
      .getByLabel(option, { exact: true })
      .setChecked(options.includes(option));
  await dialog
    .getByRole("button", { name: "Save aircraft", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  return registration;
}
async function openFlight(page: Page, registration: string) {
  await page.getByRole("link", { name: "Flight log", exact: true }).click();
  await page
    .getByRole("button", { name: "Log a completed flight", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const select = dialog.getByLabel("Aircraft", { exact: true });
  const option = select.locator("option").filter({ hasText: registration });
  await select.selectOption((await option.getAttribute("value"))!);
  return dialog;
}
test("shows only the fields selected by each aircraft option combination", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  for (const options of [
    [],
    ["Twin"],
    ["Turbine"],
    ["Twin", "Turbine"],
    ["Amphibious"],
    ["Twin", "Turbine", "Amphibious"],
  ]) {
    const registration = await configure(page, options);
    const dialog = await openFlight(page, registration);
    await expect(dialog.getByLabel(/Start time \(seconds\)/)).toHaveCount(
      options.includes("Turbine") ? (options.includes("Twin") ? 2 : 1) : 0,
    );
    await expect(dialog.getByLabel(/Start max EGT/)).toHaveCount(
      options.includes("Turbine") ? (options.includes("Twin") ? 2 : 1) : 0,
    );
    await expect(
      dialog.getByLabel("Landing surface", { exact: true }),
    ).toHaveCount(options.includes("Amphibious") ? 1 : 0);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
});
test("preserves both turbine starts and sea/land landings through offline sync, reload and correction", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  const registration = await configure(page, ["Twin", "Turbine", "Amphibious"]);
  let dialog = await openFlight(page, registration);
  await dialog
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - 3600000));
  const starting = Number(
    await dialog.getByLabel("Starting Hobbs (hours)").inputValue(),
  );
  await dialog
    .getByLabel("Ending Hobbs", { exact: false })
    .fill((starting + 1).toFixed(1));
  await dialog.getByLabel("Origin", { exact: true }).fill("TEST-STARTS");
  await dialog
    .getByLabel("Left Start time (seconds)", { exact: true })
    .fill("12.5");
  await dialog
    .getByLabel("Left Start max EGT (°C)", { exact: true })
    .fill("670");
  await dialog
    .getByLabel("Right Start time (seconds)", { exact: true })
    .fill("14");
  await dialog
    .getByLabel("Right Start max EGT (°C)", { exact: true })
    .fill("690");
  await dialog
    .getByLabel("Landing surface", { exact: true })
    .selectOption("sea");
  await context.setOffline(true);
  await expect(dialog.getByText(/Offline · This entry/)).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await context.setOffline(false);
  let row = page.getByRole("row").filter({ hasText: "TEST-STARTS" });
  await expect(row).toContainText("Left: 12.5 s · max EGT 670 °C");
  await expect(row).toContainText("Right: 14 s · max EGT 690 °C");
  await expect(row).toContainText("1 Sea / 1");
  await page.reload();
  row = page.getByRole("row").filter({ hasText: "TEST-STARTS" });
  await row.getByRole("button", { name: "Correct", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Left Start time (seconds)", { exact: true }),
  ).toHaveValue("12.5");
  await expect(
    dialog.getByLabel("Landing surface", { exact: true }),
  ).toHaveValue("sea");
  await dialog
    .getByLabel("Left Start time (seconds)", { exact: true })
    .fill("13");
  await dialog.getByLabel("Right Start max EGT (°C)", { exact: true }).fill("");
  await dialog
    .getByLabel("Landing surface", { exact: true })
    .selectOption("land");
  await dialog
    .getByLabel("Explanation", { exact: true })
    .fill("Corrected start duration and landing surface");
  await dialog
    .getByRole("button", { name: "Record review", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toContainText("Left: 13 s · max EGT 670 °C");
  await expect(row).toContainText("Right: 14 s · max EGT —");
  await expect(row).toContainText("1 Land / 1");
});
test("resets the ending readings typed for one aircraft when the pilot switches aircraft", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/flights");
  const dialog = await openFlight(page, "N206MA");
  await dialog
    .getByLabel("Flight date & time")
    .fill(localDateTime(Date.now() - 3600000));
  await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("2342.2");
  await dialog.getByLabel("Ending tach", { exact: true }).fill("2262.0");
  await dialog.getByLabel("Origin", { exact: true }).fill("SWITCHED");
  const strip = dialog.locator(".flight-delta strong");
  await expect(strip).toHaveText("1.0 h");
  const select = dialog.getByLabel("Aircraft", { exact: true });
  await select.selectOption(
    (await select
      .locator("option")
      .filter({ hasText: "N182MA" })
      .getAttribute("value"))!,
  );
  await expect(dialog.getByLabel("Starting Hobbs (hours)")).toHaveValue(
    "1650.4",
  );
  await expect(
    dialog.getByLabel("Ending Hobbs *", { exact: true }),
  ).toHaveValue("");
  await expect(dialog.getByLabel("Ending tach", { exact: true })).toHaveValue(
    "",
  );
  await expect(strip).toHaveText("Enter ending Hobbs");
  await expect(dialog.getByLabel("Origin", { exact: true })).toHaveValue(
    "SWITCHED",
  );
  // Nothing typed for N206MA can be saved against N182MA.
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "SWITCHED" }),
  ).toHaveCount(0);
  await dialog.getByLabel("Ending Hobbs *", { exact: true }).fill("1651.4");
  await expect(strip).toHaveText("1.0 h");
  await dialog
    .getByRole("button", { name: "Save flight", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "SWITCHED" }),
  ).toContainText("1,651.4");
});

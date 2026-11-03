import { test, expect } from "@playwright/test";
import path from "node:path";
test("aircraft photo persists on dashboard and can be removed", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/");
  await page.getByRole("link", { name: "Aircraft", exact: true }).click();
  const row = page
    .getByRole("list", { name: "Aircraft", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "N206MA" });
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  await page
    .getByRole("region", { name: "Aircraft photo", exact: true })
    .locator("input[type=file]")
    .setInputFiles(path.resolve("public/icon-192.png"));
  await expect(
    page.getByRole("img", { name: "N206MA photo preview", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.goto("/");
  await expect(
    page.getByRole("img", { name: "N206MA aircraft", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("img", { name: "N206MA aircraft", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Aircraft", exact: true }).click();
  await row.getByRole("button", { name: "Edit aircraft", exact: true }).click();
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "N206MA photo preview", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.goto("/");
  await expect(
    page.getByRole("img", { name: "N206MA aircraft", exact: true }),
  ).toHaveCount(0);
});

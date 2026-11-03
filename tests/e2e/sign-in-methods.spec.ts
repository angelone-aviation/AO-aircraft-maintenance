import { test, expect, type Page } from "@playwright/test";

// Google and Microsoft sign-in (ADR-0009) appear only where the deployment
// configures them. This build has no backend, so neither is configured: no
// screen may offer them, and the sign-in method lists show the password only.

const ssoButton = (page: Page) =>
  page.getByRole("button", { name: /Sign in with (Google|Microsoft)/ });

async function openDemo(page: Page, path: string) {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto(path);
}

test("no Google or Microsoft sign-in buttons when they are not configured", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Explore the local demo/ }),
  ).toBeVisible();
  await expect(ssoButton(page)).toHaveCount(0);
  // A sign-in error in the address is not shown without a sign-in screen.
  await page.goto("/?signInError=account&signInProvider=google");
  await expect(
    page.getByRole("button", { name: /Explore the local demo/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(ssoButton(page)).toHaveCount(0);
});

test("My account lists the password as the only sign-in method", async ({
  page,
}) => {
  await openDemo(page, "/settings#account");
  const account = page.getByRole("region", { name: "My account" });
  await expect(
    account.getByRole("heading", {
      level: 3,
      name: "Sign-in methods",
      exact: true,
    }),
  ).toBeVisible();
  const methods = account.getByRole("list", { name: "Sign-in methods" });
  await expect(methods.getByRole("listitem")).toHaveCount(1);
  await expect(methods).toContainText("Password");
  await expect(
    account.getByText("No Google or Microsoft account is linked."),
  ).toBeVisible();
  await expect(ssoButton(page)).toHaveCount(0);
});

test("Administration shows a user's sign-in methods, also on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, "/admin");
  const row = page
    .locator(".list-row")
    .filter({ hasText: "alex@example.test" });
  const open = row.getByRole("button", {
    name: "Sign-in methods",
    exact: true,
  });
  await expect(open).toBeEnabled();
  const box = await open.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40);
  expect(box!.height).toBeGreaterThanOrEqual(40);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await open.click();
  const dialog = page.getByRole("dialog", {
    name: "Sign-in methods · Alex Morgan",
  });
  await expect(dialog).toBeVisible();
  const methods = dialog.getByRole("list", { name: "Sign-in methods" });
  await expect(methods.getByRole("listitem")).toHaveCount(1);
  await expect(methods).toContainText("Password");
  await expect(
    dialog.getByText("No Google or Microsoft account is linked."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

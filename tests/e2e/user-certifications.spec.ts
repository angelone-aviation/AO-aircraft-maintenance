import { test, expect } from "@playwright/test";

test("program group selections grant and retain access without separate program checkboxes", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.programs.push({
            uuid: "peru-projects",
            version: 1,
            name: "Peru Projects",
            address: "",
            email: "",
            contactName: "",
            website: "",
          });
          s.groups.push({
            id: "peru-observers",
            programUuid: "peru-projects",
            name: "Observers",
            programAdmin: false,
            aircraftIds: [],
            permissions: ["read"],
          });
          entry.update(s);
          entry.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Edit access", exact: true })
    .last()
    .click();
  await expect(page.getByRole("dialog")).toContainText("Peru Projects", {
    timeout: 1500,
  });
  await expect(
    page.getByRole("checkbox", {
      name: "Access to Peru Projects",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("group", { name: "Peru Projects", exact: true })
    .getByRole("checkbox", { name: "Observers · read", exact: true })
    .check();
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Edit access", exact: true })
    .last()
    .click();
  await expect(
    page
      .getByRole("group", { name: "Peru Projects", exact: true })
      .getByRole("checkbox", { name: "Observers · read", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("dialog")).not.toContainText("Read access");
  await page
    .getByRole("group", { name: "Peru Projects", exact: true })
    .getByRole("checkbox", { name: "Observers · read", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Save user", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Edit access", exact: true })
    .last()
    .click();
  await expect(
    page
      .getByRole("group", { name: "Peru Projects", exact: true })
      .getByRole("checkbox", { name: "Observers · read", exact: true }),
  ).not.toBeChecked();
});

test("creates a user with certifications and license copies, then preserves them on edit", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/admin");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name", { exact: true }).fill("Licensed User");
  await dialog
    .getByLabel("Email", { exact: true })
    .fill("licensed@example.test");
  await dialog.getByLabel("Initial password").fill("private-test-password");
  await dialog.getByRole("checkbox", { name: "Pilot", exact: true }).check();
  await dialog
    .getByLabel("Pilot certificate number", { exact: true })
    .fill("P-98765");
  await dialog
    .getByLabel("Pilot date of issue", { exact: true })
    .fill("2020-01-01");
  await expect(dialog.getByLabel(/expiration date/i)).toHaveCount(0);
  await dialog
    .getByLabel("Pilot license copies", { exact: true })
    .setInputFiles({
      name: "pilot-license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nLicense copy"),
    });
  await dialog
    .getByRole("checkbox", { name: "Certified mechanic", exact: true })
    .check();
  await dialog
    .getByLabel("Certified mechanic certificate number", { exact: true })
    .fill("M-12345");
  await dialog
    .getByRole("checkbox", {
      name: "Inspection Authorization (IA)",
      exact: true,
    })
    .check();
  await dialog
    .getByLabel("IA renewal date", { exact: true })
    .fill("2026-03-01");
  await dialog
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page
    .locator(".list-row")
    .filter({ hasText: "licensed@example.test" })
    .getByRole("button", { name: "Edit access", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Pilot certificate number", { exact: true }),
  ).toHaveValue("P-98765");
  await expect(
    dialog.getByLabel("IA renewal date", { exact: true }),
  ).toHaveValue("2026-03-01");
  await expect(
    dialog.getByLabel("Certified mechanic certificate number", { exact: true }),
  ).toHaveValue("M-12345");
  await expect(
    dialog.getByRole("button", { name: "View license copy", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("pilot-license.pdf");
  await dialog
    .getByRole("button", { name: "Delete license copy", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "View license copy", exact: true }),
  ).toHaveCount(0);
});

test("saved personal certifications fill the work-order logbook preview", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "My certifications", exact: true })
    .click();
  const profile = page.getByRole("dialog");
  await expect(
    profile.getByRole("checkbox", { name: "Airframe", exact: true }),
  ).toHaveCount(0);
  await profile
    .getByRole("checkbox", { name: "Certified mechanic", exact: true })
    .check();
  for (const label of [
    "Airframe",
    "Powerplant",
    "Inspection Authorization (IA)",
  ]) {
    await profile
      .getByRole("group", {
        name: "Mechanic ratings and authorization",
        exact: true,
      })
      .getByRole("checkbox", { name: label, exact: true })
      .check();
    await expect(
      profile.getByLabel(`${label} certificate number`, { exact: true }),
    ).toHaveCount(0);
  }
  await profile
    .getByLabel("Certified mechanic certificate number", { exact: true })
    .fill("AP-12345");
  await profile
    .getByLabel("Certified mechanic date of issue", { exact: true })
    .fill("2020-01-01");
  await profile
    .getByLabel("IA renewal date", { exact: true })
    .fill("2026-03-01");
  await profile
    .getByRole("button", { name: "Save certifications", exact: true })
    .click();
  await expect(profile).not.toBeVisible();
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const order = page.getByRole("dialog");
  await expect(order.getByLabel("Sample log book entry text")).toHaveValue(
    /Certificate \/ license: A&P IA AP-12345/,
  );
});

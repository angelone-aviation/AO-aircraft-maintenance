import { test, expect } from "@playwright/test";
import path from "node:path";
for (const rangeOil of [false, true])
  test(`guided flight recovers preflight readings offline, reviews and logs fluids once (${rangeOil ? "range oil" : "measured oil"})`, async ({
    page,
    context,
  }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await page.goto("/flight-plans");
    await page
      .getByLabel("Upload Flight Plan PDF")
      .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Aircraft", { exact: true })
      .selectOption("demo-206");
    await dialog
      .getByLabel("Aircraft differs from the PDF: confirm reassignment")
      .check();
    await dialog
      .getByRole("button", { name: "Save flight plan", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("angel-one-v1");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("snapshots", "readwrite"),
            cursor = tx.objectStore("snapshots").openCursor();
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) return;
            const s = entry.value;
            // This scenario exercises turbine start readings; piston behavior has separate coverage.
            s.aircraft.find(
              (a: { uuid: string }) => a.uuid === "demo-206",
            ).turbine = true;
            s.management = [
              ...(s.management ?? []),
              {
                kind: "location",
                uuid: "oil-location",
                version: 0,
                programUuid: "demo-program",
                name: "Oil cabinet",
                address: "",
                contact: "",
              },
              {
                kind: "stock",
                uuid: "oil-stock",
                version: 0,
                programUuid: "demo-program",
                locationUuid: "oil-location",
                partNumber: "OIL-TEST",
                description: "Oil bottle",
                category: "supply",
                oil: true,
                condition: "new",
                alternates: "",
                quantity: 3,
                minimum: 0,
              },
            ];
            delete s.partsInventory;
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
    await page.goto("/checklists");
    await page
      .getByLabel("Import FMD checklist file")
      .setInputFiles(
        path.resolve("tests/fixtures/N377YB complete Check List.fmd"),
      );
    await dialog
      .getByRole("button", { name: "Save checklist", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await page.getByLabel("Enable guided flight trial").check();
    await page
      .getByRole("button", { name: "Start guided checklist", exact: true })
      .click();
    const guided = page.locator(".guided-flight");
    await guided
      .getByLabel("I verified the starting meter readings against the aircraft")
      .check();
    await guided
      .getByLabel("Fuel starting level (US gal)", { exact: true })
      .fill("30");
    await guided
      .getByRole("button", { name: "Pause flight and switch", exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByLabel("Guided aircraft", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Resume .*N206MA/ }).click();
    await expect(
      guided.getByLabel("Fuel starting level (US gal)", { exact: true }),
    ).toHaveValue("30");

    await guided
      .getByLabel("Fuel quantity added (US gal)", { exact: true })
      .fill("10");
    if (rangeOil) {
      await guided
        .getByLabel("Engine oil unit", { exact: true })
        .selectOption("range");
      await expect(
        guided
          .getByLabel("Engine oil starting level (range)")
          .locator("option"),
      ).toHaveText([
        "Select level",
        "Add",
        "25% above Add",
        "50% above Add",
        "75% above Add",
        "Full",
      ]);
      await guided
        .getByLabel("Engine oil starting level (range)")
        .selectOption("25");
    } else {
      await guided
        .getByLabel("Engine oil starting level (US qt)", { exact: true })
        .fill("6");
    }
    await guided
      .getByLabel("Engine oil quantity added (US qt)", { exact: true })
      .fill("1");
    await guided
      .getByLabel("Use inventory for engine oil", { exact: true })
      .check();
    await guided
      .getByLabel("Engine oil inventory location", { exact: true })
      .selectOption("oil-location");
    await guided
      .getByLabel("Engine oil inventory part number", { exact: true })
      .selectOption("oil-stock");
    await guided
      .getByLabel("Engine oil stock units used", { exact: true })
      .fill("1");
    await guided
      .getByRole("button", { name: "Check next item", exact: true })
      .click();
    await guided
      .getByRole("button", { name: "Skip next item", exact: true })
      .click();
    await guided
      .getByLabel("Engine start section (optional)")
      .selectOption({ index: 2 });
    await guided
      .getByRole("button", { name: "Go to engine start", exact: true })
      .click();
    await expect(
      guided.locator('.checklist-items + [aria-label="Engine start readings"]'),
    ).toBeVisible();
    await guided.getByLabel("Start time (seconds)", { exact: true }).fill("32");
    await guided.getByLabel("Start max EGT (°C)", { exact: true }).fill("680");
    await page.reload();
    await expect(
      guided.getByLabel("Engine oil inventory part number", { exact: true }),
    ).toHaveValue("oil-stock");
    await expect(
      guided.getByLabel("Fuel starting level (US gal)", { exact: true }),
    ).toHaveValue("30");
    await expect(
      guided.getByLabel(
        "I verified the starting meter readings against the aircraft",
      ),
    ).toBeChecked();
    await expect(
      guided
        .getByRole("checkbox")
        .filter({ hasText: "1. LANDING GEAR HANDLE" }),
    ).toHaveAttribute("aria-checked", "true");
    await guided
      .getByRole("button", { name: "Go to engine start", exact: true })
      .click();
    await expect(
      guided.getByLabel("Start time (seconds)", { exact: true }),
    ).toHaveValue("32");
    await expect(
      guided.getByLabel("Start max EGT (°C)", { exact: true }),
    ).toHaveValue("680");
    await guided
      .getByRole("button", { name: "Go to shutdown", exact: true })
      .click();
    await guided
      .getByLabel("Shutdown Hobbs (hours)", { exact: true })
      .fill("2342.2");
    await guided
      .getByLabel("Fuel shutdown level (US gal)", { exact: true })
      .fill("25");
    await expect(guided.getByLabel(/oil shutdown level/)).toHaveCount(0);
    await guided
      .getByRole("button", { name: "Review flight log", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Start time (seconds)", { exact: true }),
    ).toHaveValue("32");
    await expect(
      dialog.getByLabel("Start max EGT (°C)", { exact: true }),
    ).toHaveValue("680");
    await expect(dialog.getByLabel(/oil shutdown level/)).toHaveCount(0);
    await expect(dialog).toContainText("1/401 items checked · 1 skipped");
    await expect(
      dialog.getByLabel("Ending Hobbs *", { exact: true }),
    ).toHaveValue("2342.2");
    await expect(
      dialog.getByLabel("Fuel shutdown level (US gal)", { exact: true }),
    ).toHaveValue("25");
    await context.setOffline(true);
    await dialog
      .getByRole("button", { name: "Save flight", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(guided).toContainText("Flight saved on this device");
    await context.setOffline(false);
    await page.getByRole("link", { name: "Flight log", exact: true }).click();
    const row = page
      .getByRole("row")
      .filter({ hasText: "Fuel: 15 US gal used" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(
      "Inventory used: 1 × OIL-TEST · Oil cabinet",
    );
    const remaining = await page.evaluate(
      async () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open("angel-one-v1");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("snapshots", "readonly"),
              q = tx.objectStore("snapshots").getAll();
            q.onsuccess = () => {
              const records = q.result.flatMap((s) => s.management ?? []);
              resolve(records.find((r) => r.uuid === "oil-stock")?.quantity);
              db.close();
            };
          };
        }),
    );
    expect(remaining).toBe(2);
    await expect(row).toContainText("32 s · max EGT 680 °C");
    if (rangeOil) {
      await expect(row).toContainText("single oil: range only");
      await expect(row).toContainText("Start 25% above Add · added 1 US qt");
      await expect(row).toContainText("added 1 US qt");
      await expect(row).not.toContainText("US qt/hr");
    } else await expect(row).toContainText("Start 6 US qt · added 1 US qt");
    await expect(row).toContainText("15.00 US gal/hr");
    await expect(row).toContainText("1/401 checked · 1 skipped");
    await page.goto("/checklists");
    await page.getByLabel("Enable guided flight trial").uncheck();
    await expect(
      page.getByRole("button", { name: "Start guided checklist", exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("region", { name: "Interactive checklist" }),
    ).toHaveCount(1);
  });

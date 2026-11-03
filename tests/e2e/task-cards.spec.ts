import { test, expect } from "@playwright/test";
import { localDate } from "../../src/domain/model";
import path from "node:path";
test("creates a linked job card with notes, execution, parts, evidence and signoffs", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/inventory");
  await page.getByRole("button", { name: "New location", exact: true }).click();
  await page
    .getByLabel("Location name", { exact: true })
    .fill("Job card shelf");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "New stock item", exact: true })
    .click();
  await page.getByLabel("Part number", { exact: true }).fill("FILTER-1");
  await page.getByLabel("Description", { exact: true }).fill("Oil filter");
  await page.getByLabel("Qty", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("/work-orders");
  await page
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  const order = page.getByRole("dialog");
  await order.getByLabel("Work order number").fill("WO-CARD-EXECUTION");
  await order
    .getByRole("button", { name: "Open work order", exact: true })
    .click();
  await expect(order).not.toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "WO-CARD-EXECUTION" })
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await order
    .getByRole("button", { name: "Job cards (0)", exact: true })
    .click();
  const linked = page.getByRole("dialog", {
    name: "Work-order job cards",
    exact: true,
  });
  await linked
    .getByRole("button", { name: "Create linked job card", exact: true })
    .click();
  let editor = page.getByRole("dialog", { name: "New job card", exact: true });
  await editor
    .getByLabel("Card number (automatic if blank)")
    .fill("TC-BROWSER");
  await editor.getByLabel("Title", { exact: true }).fill("Pressure check");
  await editor.getByLabel("ATA chapter", { exact: true }).selectOption("29");
  // Maintenance-data reference fields are always shown, whatever the log book choice.
  await editor.getByLabel("Include in log book entry").uncheck();
  await editor
    .getByLabel("Maintenance-data reference")
    .fill("Test AMM reference");
  await editor
    .getByLabel("Notes / remarks", { exact: true })
    .fill("Measure system pressure, expected 10–20 psi.");
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  editor = page.getByRole("dialog", {
    name: "Job card TC-BROWSER",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await editor
    .getByLabel("Evidence category")
    .selectOption("parts-traceability");
  await editor
    .getByLabel("Evidence file", { exact: true })
    .setInputFiles(path.resolve("tests/fixtures/icao-flight-plan.pdf"));
  await editor
    .getByRole("button", { name: "Upload evidence", exact: true })
    .click();
  await expect(
    editor.getByRole("link", { name: "icao-flight-plan.pdf" }),
  ).toBeVisible();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("in-progress");
  await editor
    .getByLabel("Notes / remarks", { exact: true })
    .fill("Pressure stable at 15 psi.");
  await editor
    .getByLabel("Actual work performed")
    .fill("Measured system pressure and replaced seal");
  await editor.getByLabel("Actual labor (hours)").fill("1.5");
  await editor.getByLabel("Completion date", { exact: true }).fill(localDate());
  await editor
    .getByText("Parts used and component changes", { exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Add part used", exact: true })
    .click();
  await expect(editor.getByLabel("Part 1 source", { exact: true })).toHaveValue(
    "non-stock",
  );
  await editor.getByLabel("Part 1 Part number", { exact: true }).fill("SEAL-1");
  await editor
    .getByRole("button", { name: "Add part used", exact: true })
    .click();
  await editor
    .getByLabel("Part 2 source", { exact: true })
    .selectOption("stock");
  await editor
    .getByLabel("Part 2 inventory location", { exact: true })
    .selectOption({ label: "Job card shelf" });
  await editor
    .getByLabel("Part 2 stock item", { exact: true })
    .selectOption({ label: "FILTER-1 · Oil filter · Available: 5" });
  await expect(
    editor.getByLabel("Part 2 Part number", { exact: true }),
  ).toHaveValue("FILTER-1");
  await expect(
    editor.getByLabel("Part 2 Description", { exact: true }),
  ).toHaveValue("Oil filter");

  await editor
    .getByLabel("Part 1 Serial / lot", { exact: true })
    .fill("LOT-42");
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Technician signoff", exact: true })
    .click();
  await expect(editor.getByText(/Technician: Alex Morgan/)).toBeVisible();
  // The technician cannot also give the independent inspection signoff.
  await expect(
    editor.getByRole("button", { name: "Inspection signoff", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText(/must be signed by a different person/),
  ).toBeVisible();
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("completed");
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Save job card", exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(
    linked.getByLabel("Task status for TC-BROWSER", { exact: true }),
  ).toHaveValue("completed");
  await linked
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.goto("/task-cards");
  await page.reload();
  const taskRow = page.getByRole("row").filter({ hasText: "TC-BROWSER" });
  await expect(taskRow).toContainText("completed");
  await taskRow
    .getByRole("button", { name: "Details for TC-BROWSER", exact: true })
    .click();
  await editor
    .getByText("Parts used and component changes", { exact: true })
    .click();
  await expect(
    editor.getByLabel("Part 2 stock item", { exact: true }),
  ).toContainText("FILTER-1");
  await expect(
    editor.getByLabel("Notes / remarks", { exact: true }),
  ).toHaveValue("Pressure stable at 15 psi.");
});

test("inspection signoff waits for a certificate on file, technician signoff does not", async ({
  page,
}) => {
  const hint =
    "Add your certificate type and number under My certifications to sign as inspector.";
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/task-cards");
  await page.getByRole("button", { name: "New job card", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "New job card", exact: true });
  await editor
    .getByLabel("Card number (automatic if blank)")
    .fill("TC-INSPECT");
  await editor.getByLabel("Title", { exact: true }).fill("Control cable");
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  editor = page.getByRole("dialog", {
    name: "Job card TC-INSPECT",
    exact: true,
  });
  await editor
    .getByLabel("Task status", { exact: true })
    .selectOption("in-progress");
  await editor
    .getByLabel("Actual work performed")
    .fill("Adjusted cable tension");
  await editor.getByLabel("Completion date", { exact: true }).fill(localDate());
  await editor
    .getByRole("button", { name: "Save job card", exact: true })
    .click();
  // The demo user has no certificate on file and can still sign the work.
  await editor
    .getByRole("button", { name: "Technician signoff", exact: true })
    .click();
  await expect(editor.getByText(/Technician: Alex Morgan/)).toBeVisible();
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  // Another technician signed this card, so only the certificate is missing.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          for (const card of s.taskCards ?? [])
            if (card.cardNumber === "TC-INSPECT")
              card.technicianSignoff = {
                userId: "demo-pilot",
                name: "Jordan Lee",
                at: Date.now(),
              };
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
  const row = page.getByRole("row").filter({ hasText: "TC-INSPECT" });
  const compact = row.getByRole("button", {
    name: "Inspection signoff",
    exact: true,
  });
  await expect(compact).toBeDisabled();
  await expect(compact).toHaveAttribute("title", hint);
  await row
    .getByRole("button", { name: "Details for TC-INSPECT", exact: true })
    .click();
  const inspect = editor.getByRole("button", {
    name: "Inspection signoff",
    exact: true,
  });
  await expect(editor.getByText(/Technician: Jordan Lee/)).toBeVisible();
  await expect(inspect).toBeDisabled();
  await expect(inspect).toHaveAccessibleDescription(hint);
  await expect(editor.getByText(hint, { exact: true })).toBeVisible();
  await editor
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  // A pilot certificate is not a maintenance certificate.
  const myCertifications = page
    .locator(".profile-links")
    .getByRole("button", { name: "My certifications", exact: true });
  const profile = page.getByRole("dialog", { name: "My certifications" });
  await myCertifications.click();
  await profile.getByRole("checkbox", { name: "Pilot", exact: true }).check();
  await profile
    .getByLabel("Pilot certificate number", { exact: true })
    .fill("P-98765");
  await profile
    .getByRole("button", { name: "Save certifications", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  await expect(compact).toBeDisabled();
  await expect(compact).toHaveAttribute(
    "title",
    "Add a mechanic, repairman or inspection authorization certificate under My certifications to sign as inspector.",
  );
  // Record a mechanic certificate type and number under My certifications.
  await myCertifications.click();
  await profile
    .getByRole("checkbox", { name: "Certified mechanic", exact: true })
    .check();
  await profile
    .getByLabel("Certified mechanic certificate number", { exact: true })
    .fill("3456789");
  await profile
    .getByRole("group", { name: "Mechanic ratings and authorization" })
    .getByRole("checkbox", { name: "Airframe", exact: true })
    .check();
  await profile
    .getByRole("button", { name: "Save certifications", exact: true })
    .click();
  await expect(profile).toHaveCount(0);
  await expect(compact).toBeEnabled();
  await row
    .getByRole("button", { name: "Details for TC-INSPECT", exact: true })
    .click();
  await expect(editor.getByText(hint, { exact: true })).toHaveCount(0);
  await inspect.click();
  await expect(editor.getByText(/Inspection: Alex Morgan/)).toBeVisible();
});

test("job-card stock picker shows usable quantity and refuses expired lots", async ({
  page,
}) => {
  const expired = new Date(Date.parse(localDate()) - 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  const stock = (uuid: string, partNumber: string, extra: object) => ({
    kind: "stock",
    uuid,
    programUuid: "demo-program",
    version: 1,
    locationUuid: "jc-shelf",
    partNumber,
    description: "O-ring seal",
    quantity: 5,
    minimum: 0,
    alternates: "",
    category: "part",
    condition: "new",
    ...extra,
  });
  const records = [
    {
      kind: "location",
      uuid: "jc-shelf",
      programUuid: "demo-program",
      version: 1,
      name: "Job card shelf",
      address: "",
      contact: "",
    },
    stock("seal-reserved", "SEAL-RES", { reservedQuantity: 2 }),
    stock("seal-expired", "SEAL-EXP", { quantity: 4, expirationDate: expired }),
  ];
  await page.addInitScript(() =>
    sessionStorage.setItem("angel-one-demo", "true"),
  );
  await page.goto("/task-cards");
  await expect(
    page.getByRole("heading", { name: "Job cards", exact: true }),
  ).toBeVisible();
  await page.evaluate(async (records) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("angel-one-v1");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result,
          tx = db.transaction("snapshots", "readwrite"),
          cursor = tx.objectStore("snapshots").openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const s = entry.value;
          s.management = [...(s.management ?? []), ...records];
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
  }, records);
  await page.reload();
  await page.getByRole("button", { name: "New job card", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "New job card",
    exact: true,
  });
  await editor
    .getByText("Parts used and component changes", { exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Add part used", exact: true })
    .click();
  await editor
    .getByLabel("Part 1 source", { exact: true })
    .selectOption("stock");
  await editor
    .getByLabel("Part 1 inventory location", { exact: true })
    .selectOption({ label: "Job card shelf" });
  const picker = editor.getByLabel("Part 1 stock item", { exact: true });
  // Available means on hand less reservations, as in parts requests.
  await expect(
    picker.getByRole("option", {
      name: "SEAL-RES · O-ring seal · Available: 3",
      exact: true,
    }),
  ).toBeEnabled();
  // An expired lot is shown as expired and cannot be chosen.
  await expect(
    picker.getByRole("option", {
      name: `SEAL-EXP · O-ring seal · Expired ${expired}`,
      exact: true,
    }),
  ).toBeDisabled();
  await picker.selectOption({ label: "SEAL-RES · O-ring seal · Available: 3" });
  await expect(
    editor.getByLabel("Part 1 Part number", { exact: true }),
  ).toHaveValue("SEAL-RES");
});

for (const width of [900, 390])
  test(`an empty job-card list has no unreachable scrolling region at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      sessionStorage.setItem("angel-one-demo", "true"),
    );
    await page.goto("/task-cards");
    await expect(
      page.getByRole("heading", { name: "No job cards", exact: true }),
    ).toBeVisible();
    await expect(page.locator("main table")).toHaveCount(0);
    // axe scrollable-region-focusable: a region that scrolls must be
    // reachable by keyboard, itself or through focusable content.
    const unreachable = await page.locator("main *").evaluateAll((all) =>
      all
        .filter((el) => {
          const style = getComputedStyle(el);
          const scrolls = (overflow: string, size: number, client: number) =>
            ["auto", "scroll"].includes(overflow) && size > client;
          return (
            (scrolls(style.overflowX, el.scrollWidth, el.clientWidth) ||
              scrolls(style.overflowY, el.scrollHeight, el.clientHeight)) &&
            el.getAttribute("tabindex") === null &&
            !el.querySelector(
              "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])",
            )
          );
        })
        .map((el) => el.className),
    );
    expect(unreachable).toEqual([]);
  });

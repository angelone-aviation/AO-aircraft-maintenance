// docs/inventory-attachments.md and docs/purchase-orders.md promise attachments
// "up to 10 MB per file"; an 8 MB PDF is rejected on an inventory item.
const fs = require("fs");
const path = require("path");
const { start, go, seed, loc, stock, result } = require("./lib");
// The per-file limit each doc promises; the bug is a mismatch with what the app enforces.
const documented = ["inventory-attachments.md", "purchase-orders.md"].map((f) =>
  Number(/(\d+) MB per/.exec(fs.readFileSync(path.join(__dirname, "../../../..", f), "utf8"))[1]));
(async () => {
  const { browser, page } = await start();
  try {
    await seed(page, [loc("L1", "Main hangar"), stock("S1", "L1", "FILTER-1", { description: "Oil filter", quantity: 5 })]);
    await go(page, "/inventory");
    const row = page.getByRole("row").filter({ hasText: "FILTER-1" });
    await row.getByRole("button", { name: "Details" }).click();
    const d = page.getByRole("dialog", { name: "Stock item" });
    const size = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(size, 0x20);
    Buffer.from("%PDF-1.4\n").copy(buffer);
    await d.getByLabel("Inventory attachment file").setInputFiles({ name: "8130-form.pdf", mimeType: "application/pdf", buffer });
    await d.getByRole("button", { name: "Upload attachment" }).click();
    const alert = d.getByRole("alert");
    await alert.waitFor();
    const message = (await alert.innerText()).trim();
    console.log("8 MB PDF upload:", message, "| documented limits (MB):", documented.join(", "));
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "bug-attachment-limit.png" });
    const enforced = Number(/(\d+) MB/.exec(message)?.[1]);
    result(documented.some((mb) => mb !== enforced || size <= mb * 1024 * 1024),
      `an 8 MB PDF (documented limit ${documented.join(" / ")} MB) is rejected: "${message}"`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(2); });

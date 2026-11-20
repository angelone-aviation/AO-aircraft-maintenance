/**
 * Responsibility: Approves the signed-in demo user's own certificates in the
 *   stored demo records, standing in for a second administrator.
 * Layer: Test. Playwright helper against the demo.
 * Dependencies: @playwright/test.
 *
 * Nobody approves their own certificate, and the demo has one
 * administrator, so specs that sign or print as that administrator approve
 * their certificates here.
 */
import type { Page } from "@playwright/test";

/**
 * Clears the pending flag on the signed-in user's certificates in every
 * stored demo snapshot; reload the page to see them approved.
 *
 * @param page - A page with the demo open.
 */
export async function approveOwnCertificatesInStore(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("angel-one-v1");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("snapshots", "readwrite");
    const cursor = tx.objectStore("snapshots").openCursor();
    const approve = (m: { certifications?: { pending?: boolean }[] }) =>
      m.certifications?.forEach((c) => delete c.pending);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      const s = entry.value;
      approve(s.user);
      for (const m of s.members ?? []) if (m.id === s.user.id) approve(m);
      entry.update(s);
      entry.continue();
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

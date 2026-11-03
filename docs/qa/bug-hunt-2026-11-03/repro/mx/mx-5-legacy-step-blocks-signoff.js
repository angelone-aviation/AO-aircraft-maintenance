// docs/task-cards.md: "Previous step data remains readable ... it is no longer an
// editable checklist or a signoff prerequisite." A job card that carries a
// retained (legacy) step with signoffRequired cannot be technician-signed, and
// the UI offers no way to sign that step, so the card can never be completed.
const L = require("./lib");
(async () => {
  const { browser, page } = await L.start();
  let bug = false, msg = "";
  try {
    const today = L.localDate();
    await L.patchSnapshot(page, `
      const now = Date.now();
      s.taskCards = [...(s.taskCards || []).filter((t) => t.uuid !== "5b0c3d5e-4c1a-4d55-9d0e-000000000005"), {
        aircraftUuid: "demo-206", cardNumber: "TC-MX5-LEGACY", title: "Legacy brake card",
        workOrderUuid: "", inspectionUuid: "", componentUuid: "", requirementUuid: "", discrepancyUuid: "",
        description: "Card created before the simplified completion flow", includeInLogbook: false, logbookPhrase: "Performed",
        maintenanceReference: "", referenceRevision: "", referenceDate: "", applicability: "", notesRemarks: "",
        steps: [{ uuid: "5b0c3d5e-4c1a-4d55-9d0e-0000000000a1", instruction: "Torque caliper bolts", requiredResult: "", result: "Torqued",
                  measurementRequired: false, measurement: null, units: "", lowerLimit: null, upperLimit: null, signoffRequired: true }],
        assignedTechnician: "", estimatedLabor: null, requiredParts: "", requiredTools: "", prerequisiteUuids: [], prerequisites: "",
        findings: "", actualWork: "Replaced brake linings", measurements: "", actualLabor: null, completionDate: arg,
        partsUsed: [], inspectionSignoffRequired: false, functionalTestRequired: false, functionalTestOutcome: "not-required",
        functionalTestResults: "", status: "in-progress",
        uuid: "5b0c3d5e-4c1a-4d55-9d0e-000000000005", version: 3, createdAt: now - 86400000, createdBy: s.user.id, updatedAt: now - 86400000,
        technicianSignoff: null, inspectionSignoff: null, stepSignoffs: {},
      }];
    `, today);
    await page.goto(L.BASE + "/task-cards");
    await page.getByText("TC-MX5-LEGACY").first().waitFor();
    await page.getByText("TC-MX5-LEGACY").first().click();
    let editor = page.getByRole("dialog").last();
    await editor.waitFor();
    await page.waitForTimeout(600);
    let btn = editor.getByRole("button", { name: "Technician signoff", exact: true });
    if (!(await btn.count())) {
      // The list may need an explicit open action.
      await page.getByRole("row").filter({ hasText: "TC-MX5-LEGACY" }).getByRole("button").first().click();
      editor = page.getByRole("dialog").last();
      btn = editor.getByRole("button", { name: "Technician signoff", exact: true });
    }
    const disabled = await btn.isDisabled();
    const text = (await editor.innerText()).replace(/\n/g, " | ");
    const blockedMsg = /Sign off required steps first: Step 1: Torque caliper bolts/.test(text);
    // Is there any control to sign the step?
    const stepSignButtons = await editor.getByRole("button", { name: /step/i }).count();
    console.log("Technician signoff disabled:", disabled, "| blocked message:", blockedMsg, "| step-sign buttons:", stepSignButtons);
    await page.screenshot({ path: L.SHOTS + "/mx-5-legacy-step.png", fullPage: true });
    // Trying to complete the card is rejected as well.
    await editor.getByLabel("Task status", { exact: true }).selectOption("completed");
    await editor.getByRole("button", { name: "Save job card", exact: true }).click();
    await page.waitForTimeout(800);
    const err = (await editor.getByRole("alert").allInnerTexts().catch(() => [])).join(" / ");
    console.log("Completion error:", err);
    if (disabled && blockedMsg && stepSignButtons === 0) {
      bug = true;
      msg = "Job card with a retained required step: Technician signoff disabled ('Sign off required steps first'), no step-signoff control exists, card cannot be completed";
    }
  } finally {
    await browser.close();
  }
  L.result(bug, msg);
})();

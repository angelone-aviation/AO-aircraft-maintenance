import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { persistOperation, readQueue, readSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Backend } from "./backend";
it("automatically flushes preserved entries when login supplies a new snapshot", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const snapshot = demoSnapshot();
  const namespace = "relogin-test";
  const operation = {
    programUuid: "demo-program",
    kind: "discrepancy" as const,
    uuid: crypto.randomUUID(),
    authorId: snapshot.user.id,
    aircraftUuid: snapshot.aircraft[0].uuid,
    description: "Preserved after logout",
  };
  await persistOperation(namespace, { operation, queuedAt: Date.now() });
  const submit = vi.fn().mockResolvedValue({ status: "accepted" });
  await useWorkspace.getState().initialize(namespace, false);
  // Connection can be established before the authenticated query returns.
  useWorkspace.setState({
    snapshot: null,
    blocked: true,
    online: true,
    connected: true,
    backend: {
      saveCertifications: vi.fn(),
      certificationFiles: vi.fn(),
      uploadCertification: vi.fn(),
      certificationFileUrl: vi.fn(),
      deleteCertificationFile: vi.fn(),
      addressChoices: vi.fn(),
      saveAddress: vi.fn(),
      spruceStatus: vi.fn(),
      spruceLink: vi.fn(),
      spruceDisconnect: vi.fn(),
      spruceRefresh: vi.fn(),
      spruceSearch: vi.fn(),
      spruceOrders: vi.fn(),
      spruceSync: vi.fn(),
      partsRequest: vi.fn(),
      searchFAA: vi.fn(),
      updateFaaKey: vi.fn(),
      faaCommand: vi.fn(),
      saveAD: vi.fn(),
      purchaseOrder: vi.fn(),
      costs: vi.fn(),
      addressSettings: vi.fn(),
      setAddressKey: vi.fn(),
      lookupAddress: vi.fn(),
      poFiles: vi.fn(),
      attachPOFile: vi.fn(),
      saveChecklist: vi.fn(),
      saveDiscrepancyParts: vi.fn(),
      saveLicense: vi.fn(),
      saveLogbookPhrases: vi.fn(),
      saveReleaseStatements: vi.fn(),
      importTaskCsv: vi.fn(),
      activateTemplate: vi.fn(),
      deleteInspectionTemplates: vi.fn(),
      saveInspectionTemplates: vi.fn(),
      editManual: vi.fn(),
      saveComponentTemplate: vi.fn(),
      applyComponentTemplate: vi.fn(),
      renameManual: vi.fn(),
      setManualApplicability: vi.fn(),
      uploadManual: vi.fn(),
      openManual: vi.fn(),
      taskCard: vi.fn(),
      attachTaskEvidence: vi.fn(),
      workOrder: vi.fn(),
      resumeWorkOrderTemplates: vi.fn(),
      attachWorkOrderFile: vi.fn(),
      auditPage: vi.fn(),
      removeInventoryFile: vi.fn(),
      removeWorkOrderFile: vi.fn(),
      removeTaskEvidence: vi.fn(),
      removePOFile: vi.fn(),
      attachInventoryFile: vi.fn(),
      savePlan: vi.fn(),
      manage: vi.fn(),
      transferProgram: vi.fn(),
      selectProgram: vi.fn(),
      fleet: vi.fn(),
      submit,
      resolve: vi.fn(),
      deferDiscrepancy: vi.fn(),
      review: vi.fn(),
      createProgramUser: vi.fn(),
      updateProgramAccess: vi.fn(),
      addExistingProgramUser: vi.fn(),
      uploadAircraftPhoto: vi.fn(),
      removeAircraftPhoto: vi.fn(),
      uploadAircraftFile: vi.fn(),
      archiveAircraftFile: vi.fn(),
      createUser: vi.fn(),
      updateUser: vi.fn(),
      groupAccessReview: vi.fn(),
      previewGroupDeletion: vi.fn(),
      deleteGroup: vi.fn(),
      saveGroup: vi.fn(),
      createAircraft: vi.fn(),
      resetPassword: vi.fn(),
      linkedIdentities: vi.fn(),
      removeIdentity: vi.fn(),
      alertReads: vi.fn(),
      markAlertsRead: vi.fn(),
      setAlertEmails: vi.fn(),
      engineTrends: vi.fn(),
      engineTrend: vi.fn(),
    },
  });
  await useWorkspace.getState().flush();
  expect(submit).not.toHaveBeenCalled();
  await useWorkspace.getState().receive(snapshot);
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  await vi.waitFor(async () =>
    expect(await readQueue(namespace)).toHaveLength(0),
  );
  vi.unstubAllGlobals();
});
it("syncs only entries from the active Flight Program and preserves other program queues", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const snapshot = demoSnapshot();
  const namespace = "program-queue-test";
  const operation = (programUuid: string) => ({
    kind: "discrepancy" as const,
    programUuid,
    uuid: crypto.randomUUID(),
    authorId: snapshot.user.id,
    aircraftUuid: "plane-" + programUuid,
    description: "Pending " + programUuid,
  });
  const a = operation("A"),
    b = operation("B");
  await persistOperation(namespace, { operation: a, queuedAt: Date.now() });
  await persistOperation(namespace, { operation: b, queuedAt: Date.now() });
  await useWorkspace.getState().initialize(namespace, false);
  const submit = vi.fn().mockResolvedValue({ status: "accepted" });
  useWorkspace.setState({
    snapshot: { ...snapshot, activeProgramUuid: "A" },
    online: true,
    connected: true,
    blocked: false,
    backend: { ...useWorkspace.getState().backend!, submit },
  });
  await useWorkspace.getState().flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith(a);
  expect((await readQueue(namespace)).map((q) => q.operation.uuid)).toEqual([
    b.uuid,
  ]);
  useWorkspace.setState({ snapshot: { ...snapshot, activeProgramUuid: "B" } });
  await useWorkspace.getState().flush();
  expect(submit).toHaveBeenLastCalledWith(b);
  expect(await readQueue(namespace)).toEqual([]);
  vi.unstubAllGlobals();
});
const discrepancy = (programUuid: string, aircraftUuid = "plane") => ({
  kind: "discrepancy" as const,
  programUuid,
  uuid: crypto.randomUUID(),
  authorId: demoSnapshot().user.id,
  aircraftUuid,
  description: "Pending " + programUuid,
});
async function liveWorkspace(namespace: string, submit: Backend["submit"]) {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize(namespace, false);
  useWorkspace.setState({
    snapshot: { ...demoSnapshot(), activeProgramUuid: "A" },
    online: true,
    connected: true,
    blocked: false,
    backend: { submit } as unknown as Backend,
  });
  return useWorkspace;
}
it("retries transient sync failures automatically and holds server rejections for attention", async () => {
  const namespace = "sync-errors-test";
  const flaky = discrepancy("A"),
    rejected = discrepancy("A");
  await persistOperation(namespace, { operation: flaky, queuedAt: 1 });
  await persistOperation(namespace, { operation: rejected, queuedAt: 2 });
  const submit = vi.fn(
    async (op: { uuid: string }): Promise<{ status: string }> => {
      if (op.uuid === rejected.uuid)
        throw new Error(
          "[CONVEX M(operations:submit)] [Request ID: x] Server Error\n  Called by client",
        );
      throw new Error("WebSocket closed");
    },
  );
  const workspace = await liveWorkspace(namespace, submit);
  await workspace.getState().flush();
  const queue = await readQueue(namespace);
  expect(queue.find((q) => q.operation.uuid === flaky.uuid)?.error).toBe(
    undefined,
  );
  expect(
    queue.find((q) => q.operation.uuid === rejected.uuid)?.error,
  ).toContain("Server Error");
  submit.mockClear();
  submit.mockResolvedValue({ status: "accepted" });
  await workspace.getState().flush();
  // The transient failure is resent; the rejected entry waits for the user.
  expect(submit).toHaveBeenCalledExactlyOnceWith(flaky);
  await workspace.getState().flush(true);
  expect(submit).toHaveBeenLastCalledWith(rejected);
  expect(await readQueue(namespace)).toEqual([]);
  vi.unstubAllGlobals();
});
it("sends an entry queued while a flush is already running", async () => {
  const namespace = "flush-during-sync-test";
  const first = discrepancy("A"),
    second = discrepancy("A");
  await persistOperation(namespace, { operation: first, queuedAt: 1 });
  let release!: () => void;
  const submit = vi.fn(async (op: { uuid: string }) => {
    if (op.uuid === first.uuid)
      await new Promise<void>((resolve) => (release = resolve));
    return { status: "accepted" };
  });
  const workspace = await liveWorkspace(namespace, submit);
  const running = workspace.getState().flush();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  await persistOperation(namespace, { operation: second, queuedAt: 2 });
  await workspace.getState().flush();
  release();
  await running;
  expect(submit).toHaveBeenLastCalledWith(second);
  expect(await readQueue(namespace)).toEqual([]);
  vi.unstubAllGlobals();
});
it("discards a failed entry from the device outbox", async () => {
  const namespace = "discard-test";
  const entry = discrepancy("A");
  await persistOperation(namespace, {
    operation: entry,
    queuedAt: 1,
    error: "Rejected",
  });
  const workspace = await liveWorkspace(namespace, vi.fn());
  expect(workspace.getState().queue).toHaveLength(1);
  await workspace.getState().discard(entry.uuid);
  expect(workspace.getState().queue).toEqual([]);
  expect(await readQueue(namespace)).toEqual([]);
  vi.unstubAllGlobals();
});
it("ignores a snapshot that finishes loading after a newer sign-out", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize("receive-order-test", false);
  const stale = useWorkspace.getState().receive(demoSnapshot());
  await useWorkspace.getState().receive(null);
  await stale;
  expect(useWorkspace.getState().snapshot).toBeNull();
  expect(useWorkspace.getState().blocked).toBe(true);
  vi.unstubAllGlobals();
});
it("applies concurrent demo commands without losing either change", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize("demo-serial-test", true);
  useWorkspace.setState({ online: true, connected: false });
  const aircraftUuid = useWorkspace.getState().snapshot!.aircraft[0].uuid;
  const a = discrepancy("demo-program", aircraftUuid),
    b = discrepancy("demo-program", aircraftUuid);
  const backend = useWorkspace.getState().backend!;
  await Promise.all([backend.submit(a), backend.submit(b)]);
  const saved = await readSnapshot("demo-serial-test:all");
  expect(saved!.discrepancies.map((d) => d.uuid)).toEqual(
    expect.arrayContaining([a.uuid, b.uuid]),
  );
  vi.unstubAllGlobals();
});
it("gates flights on grounded aircraft locally and shows the server's grounded rejection in the Sync center", async () => {
  const { ConvexError } = await import("convex/values");
  const namespace = "dispatch-gate-test";
  const snapshot = demoSnapshot();
  snapshot.discrepancies.push({
    uuid: "grounding",
    aircraftUuid: snapshot.aircraft[0].uuid,
    description: "Alternator inoperative",
    status: "open",
    grounding: true,
    authorId: snapshot.user.id,
    createdAt: 0,
  });
  const flight = {
    programUuid: "demo-program",
    kind: "flight" as const,
    uuid: crypto.randomUUID(),
    authorId: snapshot.user.id,
    baseVersion: 0,
    input: {
      aircraftUuid: snapshot.aircraft[0].uuid,
      pilotId: snapshot.user.id,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      hobbsOn: snapshot.aircraft[0].currentHobbs + 3600,
      landings: 1,
      cycles: 0,
      origin: "AAA",
      destination: "BBB",
      operation: "Mission" as const,
      flightRules: "VFR" as const,
      remarks: "",
      discrepancy: "",
    },
  };
  const submit = vi.fn(async () => {
    throw new ConvexError("N206MA is grounded: Annual inspection overdue.");
  });
  const workspace = await liveWorkspace(namespace, submit);
  workspace.setState({ snapshot: { ...snapshot } });
  await expect(workspace.getState().enqueue(flight)).rejects.toThrow(
    "N206MA is grounded: Open discrepancy: Alternator inoperative",
  );
  expect(await readQueue(namespace)).toEqual([]);
  // Grounded only at sync time: the server rejection is held for attention.
  await persistOperation(namespace, { operation: flight, queuedAt: 1 });
  await workspace.getState().flush();
  expect((await readQueue(namespace))[0].error).toBe(
    "N206MA is grounded: Annual inspection overdue.",
  );
  vi.unstubAllGlobals();
});
it("removes demo job-card evidence until the card is signed", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const { taskCardCommand } = await import("../../tests/fixtures/taskCards");
  await useWorkspace.getState().initialize("demo-evidence-test", true);
  useWorkspace.setState({ online: true, connected: true });
  const backend = useWorkspace.getState().backend!;
  const command = taskCardCommand();
  await backend.taskCard(command);
  const photo = new File(["img"], "photo.png", { type: "image/png" });
  await backend.attachTaskEvidence(command.uuid, "photo", photo);
  const evidence = () => useWorkspace.getState().snapshot!.taskEvidence ?? [];
  const [file] = evidence();
  await backend.removeTaskEvidence(file.uuid);
  expect(evidence()).toEqual([]);
  expect(useWorkspace.getState().snapshot!.audit[0]).toMatchObject({
    action: "taskCard.evidence_removed",
    entityUuid: command.uuid,
  });
  await backend.attachTaskEvidence(command.uuid, "photo", photo);
  const saved = await readSnapshot("demo-evidence-test:all");
  saved!.taskCards!.find((t) => t.uuid === command.uuid)!.technicianSignoff = {
    userId: "tech",
    name: "Tech",
    at: 1,
  };
  const local = await import("./local");
  await local.saveSnapshot("demo-evidence-test:all", saved!);
  await expect(backend.removeTaskEvidence(evidence()[0].uuid)).rejects.toThrow(
    "unsigned",
  );
  vi.unstubAllGlobals();
});
it("pages the demo change history with the snapshot's visibility rules", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize("demo-history-test", true);
  useWorkspace.setState({ online: true, connected: true });
  const backend = useWorkspace.getState().backend!;
  const aircraftUuid = useWorkspace.getState().snapshot!.aircraft[0].uuid;
  for (let i = 0; i < 3; i++)
    await backend.submit(discrepancy("demo-program", aircraftUuid));
  const first = await backend.auditPage({ cursor: null, numItems: 2 });
  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  const rest = await backend.auditPage({
    cursor: first.continueCursor,
    numItems: 100,
    aircraftUuid,
  });
  expect(rest.isDone).toBe(true);
  expect(rest.page.every((a) => a.aircraftUuid === aircraftUuid)).toBe(true);
  vi.unstubAllGlobals();
});
it("records an AD's due limits before and after a demo edit", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const { blankAD, blankADTask } = await import("../domain/airworthiness");
  await useWorkspace.getState().initialize("demo-ad-audit-test", true);
  useWorkspace.setState({ online: true, connected: true });
  const backend = useWorkspace.getState().backend!;
  const r = blankAD(useWorkspace.getState().snapshot!.aircraft[0].uuid);
  r.source.number = "2026-09-09";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect fittings",
      recurrence: "One-time",
      dueHours: 2300,
    },
  ];
  await backend.saveAD({ kind: "save", record: r });
  const saved = useWorkspace.getState().snapshot!.airworthiness![0];
  const edit = structuredClone(saved);
  edit.tasks[0].dueHours = 3000;
  // A decided AD is a record: changing it needs a reason (issue #21).
  await expect(backend.saveAD({ kind: "save", record: edit })).rejects.toThrow(
    "reason",
  );
  await backend.saveAD({
    kind: "save",
    record: edit,
    reason: "Due hours corrected from paragraph (g)",
  });
  const [edited, created] = useWorkspace
    .getState()
    .snapshot!.audit.filter((a) => a.action === "ad.save");
  expect(created).toMatchObject({ entityUuid: r.uuid, before: undefined });
  expect(created.reason).toBeUndefined();
  expect(edited.reason).toBe("Due hours corrected from paragraph (g)");
  expect(JSON.parse(created.after!)).toMatchObject({
    source: { number: "2026-09-09" },
    applicability: "Applicable",
    tasks: [{ dueHours: 2300 }],
  });
  expect(JSON.parse(edited.before!)).toMatchObject({
    version: 1,
    tasks: [{ dueHours: 2300 }],
  });
  expect(JSON.parse(edited.after!)).toMatchObject({
    version: 2,
    tasks: [{ dueHours: 3000 }],
  });
  vi.unstubAllGlobals();
});
const demoFlight = (
  aircraftUuid: string,
  hoursAgo: number,
  hobbsOn: number,
  baseVersion: number,
) => ({
  programUuid: "demo-program",
  kind: "flight" as const,
  uuid: crypto.randomUUID(),
  authorId: demoSnapshot().user.id,
  baseVersion,
  input: {
    aircraftUuid,
    pilotId: demoSnapshot().user.id,
    startTime: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    hobbsOn,
    landings: 1,
    cycles: 0,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission" as const,
    flightRules: "VFR" as const,
    remarks: "",
    discrepancy: "",
  },
});
it("audits a demo review with the rebuilt flight and each flight it resequenced", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize("demo-review-audit-test", true);
  useWorkspace.setState({ online: true, connected: true });
  const backend = useWorkspace.getState().backend!;
  const a = useWorkspace.getState().snapshot!.aircraft[0];
  const later = demoFlight(a.uuid, 1, a.currentHobbs + 3600, 0);
  await backend.submit(later);
  const earlier = demoFlight(a.uuid, 3, a.currentHobbs + 1800, 1);
  await backend.submit(earlier);
  await backend.review(earlier.uuid, "accept", "Late entry verified", {
    ...earlier.input,
  });
  const { audit } = useWorkspace.getState().snapshot!;
  const reviewed = audit.find((e) => e.action === "flight.reviewed")!;
  expect(JSON.parse(reviewed.after!)).toMatchObject({
    status: "accepted",
    hobbsOff: a.currentHobbs,
    hobbsOn: a.currentHobbs + 1800,
  });
  const resequenced = audit.filter((e) => e.action === "flight.resequenced");
  expect(resequenced).toEqual([
    expect.objectContaining({
      entityUuid: later.uuid,
      aircraftUuid: a.uuid,
      reason: expect.stringContaining("was accepted"),
    }),
  ]);
  expect(JSON.parse(resequenced[0].before!)).toEqual({
    hobbsOff: a.currentHobbs,
  });
  expect(JSON.parse(resequenced[0].after!)).toEqual({
    hobbsOff: a.currentHobbs + 1800,
  });
  vi.unstubAllGlobals();
});
it("applies a demo correction made after a legacy counter event and records what the event changed", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace } = await import("./store");
  const namespace = "demo-legacy-counter-test";
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true, connected: true });
  const backend = useWorkspace.getState().backend!;
  const a = useWorkspace.getState().snapshot!.aircraft[0];
  const flight = demoFlight(a.uuid, 3, a.currentHobbs + 3600, 0);
  await backend.submit(flight);
  // A counter event saved by an earlier version: every counter, no change list.
  const saved = (await readSnapshot(namespace + ":all"))!;
  const flown = saved.aircraft.find((x) => x.uuid === a.uuid)!;
  const legacy = {
    at: new Date(Date.now() - 3600000).toISOString(),
    meter: flown.meter,
    adjustmentSeconds: flown.adjustmentSeconds,
    currentHobbs: flown.currentHobbs,
    currentTach: flown.currentTach,
    currentFlightTimeLog: 360000,
    cycles: flown.cycles,
    landings: flown.landings,
  };
  Object.assign(flown, {
    flightTimeLog: true,
    currentFlightTimeLog: 360000,
    counterEvents: [legacy],
  });
  const local = await import("./local");
  await local.saveSnapshot(namespace + ":all", saved);
  await backend.review(flight.uuid, "accept", "Paper log shows 2342.6", {
    ...flight.input,
    hobbsOn: a.currentHobbs + 5040,
    landings: 3,
  });
  const after = useWorkspace
    .getState()
    .snapshot!.aircraft.find((x) => x.uuid === a.uuid)!;
  expect(after).toMatchObject({
    currentHobbs: a.currentHobbs + 5040,
    landings: a.landings + 3,
    currentFlightTimeLog: 360000,
  });
  expect(after.counterEvents).toEqual([
    { ...legacy, changed: ["currentFlightTimeLog"], previous: {} },
  ]);
  vi.unstubAllGlobals();
});
it("keeps renewed demo access after the next demo change", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const { useWorkspace, renewDemoAccess } = await import("./store");
  const { offlineValid } = await import("../domain/model");
  const local = await import("./local");
  const namespace = "demo-renew-test";
  await useWorkspace.getState().initialize(namespace, true);
  // Eight days pass: both stored demo snapshots carry the old sign-in time.
  for (const key of [namespace, namespace + ":all"]) {
    const s = (await readSnapshot(key))!;
    await local.saveSnapshot(key, {
      ...s,
      authenticatedAt: Date.now() - 8 * 86400000,
    });
  }
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true, connected: true });
  expect(offlineValid(useWorkspace.getState().snapshot!)).toBe(false);
  await renewDemoAccess();
  expect(offlineValid(useWorkspace.getState().snapshot!)).toBe(true);
  const aircraftUuid = useWorkspace.getState().snapshot!.aircraft[0].uuid;
  await useWorkspace
    .getState()
    .backend!.submit(discrepancy("demo-program", aircraftUuid));
  expect(offlineValid(useWorkspace.getState().snapshot!)).toBe(true);
  expect(offlineValid((await readSnapshot(namespace + ":all"))!)).toBe(true);
  vi.unstubAllGlobals();
});
it("removes kept manuals on sign-out, when the session ends and when a snapshot no longer allows them", async () => {
  const { MemoryCacheStorage, pdfBytes, streamedResponse } =
    await import("../../tests/fixtures/cacheStorage");
  const { keepManual, listKeptManuals } = await import("./deviceManuals");
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("caches", new MemoryCacheStorage());
  const { useWorkspace } = await import("./store");
  const namespace = "kept-manuals-test";
  const manual = (uuid: string) => ({
    uuid,
    aircraftUuid: "demo-206",
    title: "Manual",
    documentNumber: "",
    revision: "1",
    revisionDate: "",
    filename: "manual.pdf",
    size: 64,
    pageCount: 1,
    uploadedAt: 1,
    uploadedBy: "demo-admin",
  });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const snapshot = { ...demoSnapshot(), manuals: [manual(a), manual(b)] };
  const keep = (uuid: string) =>
    keepManual({
      namespace,
      snapshot,
      uuid,
      download: async () => streamedResponse(pdfBytes(64)),
    });
  const kept = async () =>
    (await listKeptManuals(namespace, snapshot)).map((m) => m.uuid).sort();
  await useWorkspace.getState().initialize(namespace, false);
  await useWorkspace.getState().receive(snapshot);
  await keep(a);
  await keep(b);
  expect(await kept()).toEqual([a, b].sort());

  // Program switched away from b's aircraft: the next snapshot drops it.
  await useWorkspace.getState().receive({ ...snapshot, manuals: [manual(a)] });
  await vi.waitFor(async () => expect(await kept()).toEqual([a]));

  // The session ended on the server.
  await useWorkspace.getState().receive(null);
  expect(await kept()).toEqual([]);

  await useWorkspace.getState().receive(snapshot);
  await keep(a);
  await useWorkspace.getState().signOutLocal();
  expect(await kept()).toEqual([]);
  vi.unstubAllGlobals();
});

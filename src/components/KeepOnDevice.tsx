/**
 * Responsibility: "Keep on this device" for reference manuals: the shared
 *   download, kept-copy and error state, and the controls that show it.
 * Layer: UI. Components over a zustand store; storage rules live in
 *   src/data/deviceManuals.ts.
 * Dependencies: react, zustand, @phosphor-icons/react, src/data/store.ts,
 *   src/data/backend.ts (types), src/data/deviceManuals.ts,
 *   src/data/pdfOffline.ts, src/domain/manuals.ts (types), ./design.tsx,
 *   ./ui.tsx, ./manuals.css.
 *
 * The library, the viewer and any open reference share the state, so a
 * download started in one place shows its progress everywhere and keeps
 * running across navigation.
 */
import { useEffect } from "react";
import { create } from "zustand";
import {
  CheckCircle,
  CloudArrowDown,
  HardDrives,
  ShieldCheck,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import type { Manual } from "../domain/manuals";
import {
  DeviceStorageError,
  formatBytes,
  keepManual,
  keptManualsSupported,
  keptStorage,
  listKeptManuals,
  onKeptManualsChange,
  readKeptManual,
  removeKeptManual,
  requestPersistentStorage,
  type KeptManual,
} from "../data/deviceManuals";
import { warmPdfViewer } from "../data/pdfOffline";
import { ListRow, NoticeBar, ProgressTrack, StatusPill } from "./design";
import { errorText } from "./ui";
import "./manuals.css";

// Progress re-renders every open view, so it is published at most this often
// (the final chunk always is).
const PROGRESS_INTERVAL_MS = 150;

type Download = {
  received: number;
  total: number;
  controller: AbortController;
};
interface DeviceManuals {
  /** Namespace and user the lists below were read for. */
  scope: string;
  kept: Record<string, KeptManual>;
  downloads: Record<string, Download>;
  errors: Record<string, string>;
  storage: { usage?: number; quota?: number; persisted?: boolean };
}
const useDeviceManuals = create<DeviceManuals>(() => ({
  scope: "",
  kept: {},
  downloads: {},
  errors: {},
  storage: {},
}));
const scopeOf = (namespace: string, userId?: string) =>
  userId ? `${namespace}\n${userId}` : "";
const currentScope = () => {
  const { namespace, snapshot } = useWorkspace.getState();
  return scopeOf(namespace, snapshot?.user.id);
};
const patch = <K extends "downloads" | "errors">(
  key: K,
  uuid: string,
  value: DeviceManuals[K][string] | undefined,
) =>
  useDeviceManuals.setState((s) => {
    const next = { ...s[key] };
    if (value === undefined) delete next[uuid];
    else next[uuid] = value;
    return { [key]: next } as Pick<DeviceManuals, K>;
  });

// Counts list reads so that only the latest one is stored: an older read that
// finishes late would bring back another user's or a stale list.
let reads = 0;
async function refresh() {
  const { namespace, snapshot } = useWorkspace.getState();
  const scope = scopeOf(namespace, snapshot?.user.id);
  const read = ++reads;
  const [kept, storage] = await Promise.all([
    snapshot ? listKeptManuals(namespace, snapshot) : [],
    keptStorage(),
  ]);
  if (read !== reads) return;
  useDeviceManuals.setState((s) => ({
    scope,
    kept: Object.fromEntries(kept.map((m) => [m.uuid, m])),
    storage,
    errors: s.scope === scope ? s.errors : {},
  }));
}
onKeptManualsChange(() => void refresh());

/**
 * Re-reads the signed-in user's kept manuals and storage use whenever the
 * namespace, the user or the program's manuals change. Call once per screen.
 */
export function useKeptManualsRefresh() {
  const namespace = useWorkspace((s) => s.namespace);
  const userId = useWorkspace((s) => s.snapshot?.user.id);
  const manuals = useWorkspace((s) =>
    (s.snapshot?.manuals ?? []).map((m) => m.uuid).join(),
  );
  useEffect(() => {
    void refresh();
  }, [namespace, userId, manuals]);
}
function useKeptManual(uuid: string) {
  const namespace = useWorkspace((s) => s.namespace);
  const userId = useWorkspace((s) => s.snapshot?.user.id);
  const current =
    useDeviceManuals((s) => s.scope) === scopeOf(namespace, userId);
  const kept = useDeviceManuals((s) => s.kept[uuid]);
  const download = useDeviceManuals((s) => s.downloads[uuid]);
  const error = useDeviceManuals((s) => s.errors[uuid]);
  // Never show another account's state while the lists are re-read.
  return current ? { kept, download, error } : {};
}

/**
 * Downloads the manual once through its authorized file URL and keeps it on
 * this device, publishing progress to every open view. Does nothing without a
 * signed-in snapshot and backend, or while that manual is already downloading.
 * A failure other than a cancel is kept for KeepManualError, unless the user
 * changed meanwhile.
 *
 * @param manual - The manual; its recorded size is the progress total.
 */
export async function keepOnDevice(manual: Manual) {
  const { namespace, snapshot, backend } = useWorkspace.getState();
  if (
    !snapshot ||
    !backend ||
    useDeviceManuals.getState().downloads[manual.uuid]
  )
    return;
  // Asked while the tap still counts as a user action. Persistent storage
  // makes mobile browsers far less likely to evict kept manuals.
  const persisted = requestPersistentStorage();
  const controller = new AbortController();
  const scope = currentScope();
  patch("errors", manual.uuid, undefined);
  patch("downloads", manual.uuid, {
    received: 0,
    total: manual.size,
    controller,
  });
  try {
    await keepManual({
      namespace,
      snapshot,
      uuid: manual.uuid,
      signal: controller.signal,
      download: (signal) => fetchManual(backend, manual.uuid, signal),
      onProgress: throttleProgress(manual.uuid, controller),
    });
    void warmPdfViewer();
  } catch (error) {
    if (scope === currentScope()) recordKeepError(manual.uuid, error);
  } finally {
    patch("downloads", manual.uuid, undefined);
    await persisted;
    await refresh();
  }
}

/** Aborts the manual's running download, if any. */
export function cancelKeep(uuid: string) {
  useDeviceManuals.getState().downloads[uuid]?.controller.abort();
}

/**
 * Deletes the manual's kept copy for the signed-in user; a failure is kept
 * for KeepManualError.
 */
export async function removeFromDevice(manual: Manual) {
  const { namespace, snapshot } = useWorkspace.getState();
  if (!snapshot) return;
  patch("errors", manual.uuid, undefined);
  try {
    await removeKeptManual(namespace, snapshot, manual.uuid);
  } catch (error) {
    patch(
      "errors",
      manual.uuid,
      errorText(error, "The manual was not removed."),
    );
  }
}

/**
 * A URL for the manual's PDF: the copy kept on this device when there is a
 * readable one (no network, so it opens offline), otherwise the existing
 * authorized online file. Blob URLs are the caller's to revoke.
 *
 * @param options.useDevice - False skips the kept copy.
 * @throws Error "Manual is not available." with no kept copy and no backend.
 */
export async function openManualFile(
  uuid: string,
  { useDevice = true }: { useDevice?: boolean } = {},
): Promise<{ url: string; fromDevice: boolean }> {
  const { namespace, snapshot, backend } = useWorkspace.getState();
  const kept =
    useDevice && snapshot
      ? await readKeptManual(namespace, snapshot, uuid)
      : undefined;
  if (kept) return { url: URL.createObjectURL(kept), fromDevice: true };
  if (!backend) throw new Error("Manual is not available.");
  return { url: await backend.openManual(uuid), fromDevice: false };
}

function DownloadProgress({
  manual,
  download,
}: {
  manual: Manual;
  download: Download;
}) {
  return (
    <span className="manual-keep-progress">
      <ProgressTrack
        value={download.received / download.total}
        label={`Keeping ${manual.title} on this device`}
      />
      <span className="manual-keep-note">
        {formatBytes(download.received)} of {formatBytes(download.total)}
      </span>
    </span>
  );
}

/**
 * The manual's device action: Cancel download while downloading, Remove from
 * this device once kept, otherwise Keep on this device (disabled offline).
 */
export function KeepManualButton({ manual }: { manual: Manual }) {
  const online = useWorkspace((s) => s.online && s.connected);
  const { kept, download } = useKeptManual(manual.uuid);
  if (download)
    return (
      <button
        type="button"
        className="button small"
        onClick={() => cancelKeep(manual.uuid)}
      >
        Cancel download
      </button>
    );
  if (kept)
    return (
      <button
        type="button"
        className="button small"
        onClick={() => void removeFromDevice(manual)}
      >
        Remove from this device
      </button>
    );
  return (
    <button
      type="button"
      className="button small"
      disabled={!online}
      onClick={() => void keepOnDevice(manual)}
    >
      <CloudArrowDown size={17} aria-hidden="true" />
      Keep on this device
    </button>
  );
}

/** The manual's last keep or remove failure as an alert, or nothing. */
export function KeepManualError({ manual }: { manual: Manual }) {
  const { error } = useKeptManual(manual.uuid);
  return error ? (
    <p className="manual-keep-error" role="alert">
      <WarningCircle size={16} weight="bold" aria-hidden="true" />
      {error}
    </p>
  ) : null;
}

/**
 * A library row's device state: download progress, an "On this device" pill,
 * or nothing. The row places it under the file size, the button among its
 * actions and any error below them.
 */
export function KeepManualStatus({ manual }: { manual: Manual }) {
  const { kept, download } = useKeptManual(manual.uuid);
  return download ? (
    <DownloadProgress manual={manual} download={download} />
  ) : kept ? (
    <span className="manual-keep-status">
      <StatusPill tone="good" icon={CheckCircle}>
        On this device
      </StatusPill>
    </span>
  ) : null;
}

/**
 * The manual viewer's "This device" panel: where this copy came from, what
 * keeping it means, the device action and any progress or error. Refreshes
 * the kept list; renders nothing where kept manuals are unsupported.
 *
 * @param props.fromDevice - The open copy was read from this device.
 */
export function KeepManualPanel({
  manual,
  fromDevice,
}: {
  manual: Manual;
  fromDevice: boolean;
}) {
  useKeptManualsRefresh();
  const online = useWorkspace((s) => s.online && s.connected);
  const { kept, download } = useKeptManual(manual.uuid);
  if (!keptManualsSupported()) return null;
  const size = formatBytes(manual.size);
  return (
    <section className="manual-keep-panel" aria-label="This device">
      <ListRow
        icon={kept ? CheckCircle : HardDrives}
        tone={kept ? "good" : "blue"}
        title={panelTitle(!!kept, !!download)}
        sub={panelSub(size, {
          kept: !!kept,
          download: !!download,
          fromDevice,
          online,
        })}
        action={<KeepManualButton manual={manual} />}
      />
      {download && <DownloadProgress manual={manual} download={download} />}
      <KeepManualError manual={manual} />
    </section>
  );
}

/**
 * The library's summary of kept manuals: how many, the space they use, the
 * space left and whether the browser protects them from clean-up. Renders
 * nothing where kept manuals are unsupported.
 */
export function KeptManualsSummary() {
  const namespace = useWorkspace((s) => s.namespace);
  const userId = useWorkspace((s) => s.snapshot?.user.id);
  const { scope, kept, storage } = useDeviceManuals();
  if (!keptManualsSupported()) return null;
  const manuals =
    scope === scopeOf(namespace, userId) ? Object.values(kept) : [];
  const used = manuals.reduce((total, m) => total + m.size, 0);
  const left =
    storage.quota !== undefined && storage.usage !== undefined
      ? Math.max(0, storage.quota - storage.usage)
      : undefined;
  return (
    <section
      className="ds-list-card manual-keep-summary"
      aria-label="Manuals on this device"
    >
      <ListRow
        icon={HardDrives}
        title="Manuals on this device"
        sub={
          manuals.length
            ? `${manuals.length} ${manuals.length === 1 ? "manual" : "manuals"} · ${formatBytes(used)} used`
            : "None kept yet. Keep a manual to open it instantly, even offline."
        }
        meta={left === undefined ? undefined : `${formatBytes(left)} left`}
        badge={
          storage.persisted ? (
            <StatusPill tone="good" icon={ShieldCheck}>
              Protected from clean-up
            </StatusPill>
          ) : manuals.length ? (
            <StatusPill tone="warn" icon={Warning}>
              May be cleared if storage runs low
            </StatusPill>
          ) : undefined
        }
      />
    </section>
  );
}

/** Says the kept copy could not be opened and the online file is opening. */
export function DeviceCopyNotice() {
  return (
    <NoticeBar tone="warn" icon={WarningCircle} role="status">
      This manual could not be opened from this device, so the online file is
      opening instead. This needs a connection.
    </NoticeBar>
  );
}

async function fetchManual(
  backend: Backend,
  uuid: string,
  signal: AbortSignal,
) {
  const url = await backend.openManual(uuid);
  try {
    return await fetch(url, { signal });
  } finally {
    // The demo backend makes a blob URL for each open; free it once fetched.
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

function throttleProgress(uuid: string, controller: AbortController) {
  let shown = 0;
  return (received: number, total: number) => {
    const now = Date.now();
    if (received < total && now - shown < PROGRESS_INTERVAL_MS) return;
    shown = now;
    patch("downloads", uuid, { received, total, controller });
  };
}

function recordKeepError(uuid: string, error: unknown) {
  if (error instanceof DeviceStorageError && error.kind === "canceled") return;
  patch(
    "errors",
    uuid,
    errorText(error, "The manual could not be kept on this device."),
  );
}

function panelTitle(kept: boolean, download: boolean): string {
  if (download) return "Keeping on this device…";
  if (kept) return "On this device";
  return "Not on this device";
}

function panelSub(
  size: string,
  state: {
    kept: boolean;
    download: boolean;
    fromDevice: boolean;
    online: boolean;
  },
): string {
  if (state.kept)
    return `${size} · ${state.fromDevice ? "Opened from this device. " : ""}Opens instantly, even offline.`;
  if (state.download)
    return `${size} · Downloading once; afterwards it opens instantly, even offline.`;
  return `${size} · Keep it to open it instantly, even offline.${state.online ? "" : " Connect to keep it."}`;
}

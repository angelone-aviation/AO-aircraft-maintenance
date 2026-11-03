import { useEffect } from "react";
import { create } from "zustand";
import {
  CheckCircle,
  CloudArrowDown,
  HardDrives,
  WarningCircle,
} from "@phosphor-icons/react";
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

/* "Keep on this device" for reference manuals: state shared by the library,
 * the viewer and any open reference, so a download started in one place
 * shows its progress everywhere and keeps running across navigation. Storage
 * rules live in src/data/deviceManuals.ts. */

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

/** Reads the kept manuals for the signed-in user; call once per screen. */
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

/** Downloads the manual once, with progress, through the authorized file URL. */
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
  let shown = 0;
  try {
    await keepManual({
      namespace,
      snapshot,
      uuid: manual.uuid,
      signal: controller.signal,
      download: async (signal) => {
        const url = await backend.openManual(manual.uuid);
        try {
          return await fetch(url, { signal });
        } finally {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
        }
      },
      onProgress: (received, total) => {
        const now = Date.now();
        if (received < total && now - shown < 150) return;
        shown = now;
        patch("downloads", manual.uuid, { received, total, controller });
      },
    });
    void warmPdfViewer();
  } catch (error) {
    if (
      !(error instanceof DeviceStorageError && error.kind === "canceled") &&
      scope === currentScope()
    )
      patch(
        "errors",
        manual.uuid,
        error instanceof Error
          ? error.message
          : "The manual could not be kept on this device.",
      );
  } finally {
    patch("downloads", manual.uuid, undefined);
    await persisted;
    await refresh();
  }
}
export function cancelKeep(uuid: string) {
  useDeviceManuals.getState().downloads[uuid]?.controller.abort();
}
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
      error instanceof Error ? error.message : "The manual was not removed.",
    );
  }
}

/**
 * A URL for the manual's PDF: the copy kept on this device when there is a
 * readable one (no network, so it opens offline), otherwise the existing
 * authorized online file. Blob URLs are the caller's to revoke.
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
    <span className="shop-keep-progress">
      <ProgressTrack
        value={download.received / download.total}
        label={`Keeping ${manual.title} on this device`}
      />
      <span className="shop-keep-note">
        {formatBytes(download.received)} of {formatBytes(download.total)}
      </span>
    </span>
  );
}

/** Keep on this device, Cancel download or Remove from this device. */
export function KeepManualButton({ manual }: { manual: Manual }) {
  const online = useWorkspace((s) => s.online && s.connected);
  const { kept, download } = useKeptManual(manual.uuid);
  return download ? (
    <button
      type="button"
      className="button small"
      onClick={() => cancelKeep(manual.uuid)}
    >
      Cancel download
    </button>
  ) : kept ? (
    <button
      type="button"
      className="button small"
      onClick={() => void removeFromDevice(manual)}
    >
      Remove from this device
    </button>
  ) : (
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
export function KeepManualError({ manual }: { manual: Manual }) {
  const { error } = useKeptManual(manual.uuid);
  return error ? (
    <p className="shop-keep-error" role="alert">
      <WarningCircle size={16} weight="bold" aria-hidden="true" />
      {error}
    </p>
  ) : null;
}

/* Reference library row: the state sits under the file size, the button
 * among the row's actions and any error below them. */
export function KeepManualStatus({ manual }: { manual: Manual }) {
  const { kept, download } = useKeptManual(manual.uuid);
  return download ? (
    <DownloadProgress manual={manual} download={download} />
  ) : kept ? (
    <span className="shop-keep-status">
      <StatusPill tone="good">On this device</StatusPill>
    </span>
  ) : null;
}

/** Manual viewer: where this copy came from and what keeping it means. */
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
    <section className="shop-keep-panel" aria-label="This device">
      <ListRow
        icon={kept ? CheckCircle : HardDrives}
        tone={kept ? "good" : "blue"}
        title={
          download
            ? "Keeping on this device…"
            : kept
              ? "On this device"
              : "Not on this device"
        }
        sub={
          kept
            ? `${size} · ${fromDevice ? "Opened from this device. " : ""}Opens instantly, even offline.`
            : download
              ? `${size} · Downloading once; afterwards it opens instantly, even offline.`
              : `${size} · Keep it to open it instantly, even offline.${online ? "" : " Connect to keep it."}`
        }
        action={<KeepManualButton manual={manual} />}
      />
      {download && <DownloadProgress manual={manual} download={download} />}
      <KeepManualError manual={manual} />
    </section>
  );
}

/** Reference library: space used by kept manuals and space left. */
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
      className="ds-list-card shop-keep-summary"
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
            <StatusPill tone="good">Protected from clean-up</StatusPill>
          ) : manuals.length ? (
            <StatusPill tone="warn">
              May be cleared if storage runs low
            </StatusPill>
          ) : undefined
        }
      />
    </section>
  );
}

export function DeviceCopyNotice() {
  return (
    <NoticeBar tone="warn" icon={WarningCircle} role="status">
      This manual could not be opened from this device, so the online file is
      opening instead. This needs a connection.
    </NoticeBar>
  );
}

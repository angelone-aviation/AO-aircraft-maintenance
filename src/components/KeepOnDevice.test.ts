/**
 * Responsibility: Pins the keep, cancel and remove flows, the device-first
 *   file opening and the controls of "Keep on this device".
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/KeepOnDevice.tsx, react-dom/server, zustand
 *   (wrapped so server rendering reads the live store).
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Manual } from "../domain/manuals";
import { DeviceStorageError, type KeepOptions } from "../data/deviceManuals";
import {
  cancelKeep,
  DeviceCopyNotice,
  KeepManualButton,
  KeepManualError,
  KeepManualPanel,
  KeepManualStatus,
  KeptManualsSummary,
  keepOnDevice,
  openManualFile,
  removeFromDevice,
} from "./KeepOnDevice";

type State = {
  scope: string;
  kept: Record<string, object>;
  downloads: Record<string, { controller: AbortController }>;
  errors: Record<string, string>;
  storage: object;
};
type Api = { getState: () => State; setState: (s: Partial<State>) => void };

// Server rendering reads a zustand store's initial state; this store reads its
// live state instead, so the tests can render each download state.
const device = vi.hoisted(() => ({ store: undefined as unknown as Api }));
vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  return {
    ...actual,
    create: (init: never) => {
      const api = actual.createStore(init);
      api.getInitialState = api.getState;
      device.store = api as never;
      const hook = (select: never) => actual.useStore(api, select);
      return Object.assign(hook, api);
    },
  };
});

const workspace = vi.hoisted(() => ({
  state: {} as {
    namespace: string;
    snapshot?: { user: { id: string }; manuals: [] };
    backend?: { openManual: (uuid: string) => Promise<string> };
    online: boolean;
    connected: boolean;
  },
}));
vi.mock("../data/store", () => {
  const read = () => workspace.state;
  const useWorkspace = (select?: (s: typeof workspace.state) => unknown) =>
    select ? select(read()) : read();
  return { useWorkspace: Object.assign(useWorkspace, { getState: read }) };
});

const storage = vi.hoisted(() => ({
  supported: true,
  keepManual: vi.fn<(options: KeepOptions) => Promise<unknown>>(),
  readKeptManual: vi.fn<() => Promise<Blob | undefined>>(),
  removeKeptManual: vi.fn<() => Promise<void>>(),
}));
vi.mock("../data/deviceManuals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/deviceManuals")>()),
  keptManualsSupported: () => storage.supported,
  keepManual: storage.keepManual,
  readKeptManual: storage.readKeptManual,
  removeKeptManual: storage.removeKeptManual,
  listKeptManuals: async () => [],
  keptStorage: async () => ({}),
  requestPersistentStorage: async () => true,
  onKeptManualsChange: () => () => {},
}));
vi.mock("../data/pdfOffline", () => ({ warmPdfViewer: async () => {} }));

const SCOPE = "ns\nu1";
const manual = {
  uuid: "m1",
  title: "Hangar manual",
  size: 2_000_000,
} as Manual;
const openManual = vi.fn(async () => "https://files.example/m1");
const render = (element: ReactElement) => renderToStaticMarkup(element);

beforeEach(() => {
  storage.supported = true;
  storage.keepManual.mockReset();
  storage.readKeptManual.mockReset();
  storage.removeKeptManual.mockReset();
  workspace.state = {
    namespace: "ns",
    snapshot: { user: { id: "u1" }, manuals: [] },
    backend: { openManual },
    online: true,
    connected: true,
  };
  device.store.setState({ scope: SCOPE, kept: {}, downloads: {}, errors: {} });
});

describe("keepOnDevice", () => {
  it("does nothing without a backend", async () => {
    workspace.state.backend = undefined;
    await keepOnDevice(manual);
    expect(storage.keepManual).not.toHaveBeenCalled();
  });

  it("ignores a second request while the manual is downloading", async () => {
    let finish = () => {};
    storage.keepManual.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(undefined))),
    );
    const first = keepOnDevice(manual);
    await keepOnDevice(manual);
    expect(storage.keepManual).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(device.store.getState().downloads).toEqual({});
  });

  it("keeps a failure's message for KeepManualError", async () => {
    storage.keepManual.mockRejectedValue(new Error("The download stopped."));
    await keepOnDevice(manual);
    expect(device.store.getState().errors).toEqual({
      m1: "The download stopped.",
    });
    expect(render(h(KeepManualError, { manual }))).toContain(
      "The download stopped.</p>",
    );
  });

  it("keeps no error for a cancel", async () => {
    storage.keepManual.mockRejectedValue(
      new DeviceStorageError("canceled", "Canceled."),
    );
    await keepOnDevice(manual);
    expect(device.store.getState().errors).toEqual({});
  });

  it("keeps no error when the user changed during the download", async () => {
    storage.keepManual.mockImplementation(async () => {
      workspace.state.snapshot = { user: { id: "u2" }, manuals: [] };
      // The new user's lists were already read when the download fails.
      device.store.setState({ scope: "ns\nu2" });
      throw new Error("The download stopped.");
    });
    await keepOnDevice(manual);
    expect(device.store.getState().errors).toEqual({});
  });

  it("publishes progress at most every 150 ms, and always the last chunk", async () => {
    const now = vi.spyOn(Date, "now");
    const shown: unknown[] = [];
    storage.keepManual.mockImplementation(async ({ onProgress }) => {
      for (const [time, received] of [
        [1000, 10],
        [1100, 20],
        [1150, 30],
        [1200, 100],
      ]) {
        now.mockReturnValue(time);
        onProgress?.(received, 100);
        shown.push(device.store.getState().downloads.m1);
      }
    });
    await keepOnDevice(manual);
    now.mockRestore();
    expect(shown.map((d) => (d as { received: number }).received)).toEqual([
      10, 10, 30, 100,
    ]);
  });

  it("frees a blob URL after fetching it, but not an online URL", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    vi.stubGlobal("fetch", async () => new Response("pdf"));
    storage.keepManual.mockImplementation(async ({ download }) => {
      openManual.mockResolvedValueOnce("blob:demo-1");
      await download(new AbortController().signal);
      await download(new AbortController().signal);
    });
    await keepOnDevice(manual);
    expect(revoke.mock.calls).toEqual([["blob:demo-1"]]);
    vi.unstubAllGlobals();
    revoke.mockRestore();
  });
});

describe("cancelKeep and removeFromDevice", () => {
  it("aborts the running download", () => {
    const controller = new AbortController();
    device.store.setState({ downloads: { m1: { controller } } });
    cancelKeep("m1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps a removal failure's message", async () => {
    storage.removeKeptManual.mockRejectedValue(new Error("Storage locked."));
    await removeFromDevice(manual);
    expect(device.store.getState().errors).toEqual({ m1: "Storage locked." });
  });
});

describe("openManualFile", () => {
  it("opens the copy kept on this device first", async () => {
    storage.readKeptManual.mockResolvedValue(new Blob(["pdf"]));
    const file = await openManualFile("m1");
    expect(file.fromDevice).toBe(true);
    expect(file.url).toMatch(/^blob:/);
    URL.revokeObjectURL(file.url);
  });

  it("downloads the online file once when told to skip the device", async () => {
    storage.readKeptManual.mockResolvedValue(new Blob(["pdf"]));
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response("pdf");
    });
    // An object URL, so the viewer's buttons outlive the five-minute link.
    expect(await openManualFile("m1", { useDevice: false })).toEqual({
      url: expect.stringMatching(/^blob:/),
      fromDevice: false,
    });
    expect(fetched).toEqual(["https://files.example/m1"]);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));
    await expect(openManualFile("m1", { useDevice: false })).rejects.toThrow(
      "Manual file is unavailable.",
    );
  });

  it("refuses with no kept copy and no backend", async () => {
    workspace.state.backend = undefined;
    await expect(openManualFile("m1")).rejects.toThrow(
      "Manual is not available.",
    );
  });
});

describe("controls", () => {
  it("offers Keep on this device, disabled offline", () => {
    expect(render(h(KeepManualButton, { manual }))).toContain(
      "Keep on this device</button>",
    );
    workspace.state.online = false;
    expect(render(h(KeepManualButton, { manual }))).toContain('disabled=""');
  });

  it("offers Cancel download while downloading, with progress", () => {
    const controller = new AbortController();
    device.store.setState({
      downloads: { m1: { received: 500_000, total: 2_000_000, controller } },
    } as never);
    expect(render(h(KeepManualButton, { manual }))).toContain(
      "Cancel download</button>",
    );
    expect(render(h(KeepManualStatus, { manual }))).toContain(
      "0.5 MB of 1.9 MB",
    );
  });

  it("offers Remove from this device once kept", () => {
    device.store.setState({ kept: { m1: { uuid: "m1", size: 2_000_000 } } });
    expect(render(h(KeepManualButton, { manual }))).toContain(
      "Remove from this device</button>",
    );
    expect(render(h(KeepManualStatus, { manual }))).toContain("On this device");
  });

  it("hides another user's state while the lists are re-read", () => {
    device.store.setState({
      scope: "ns\nu2",
      kept: { m1: { uuid: "m1", size: 2_000_000 } },
      errors: { m1: "Old error" },
    });
    expect(render(h(KeepManualButton, { manual }))).toContain(
      "Keep on this device",
    );
    expect(render(h(KeepManualError, { manual }))).toBe("");
  });

  it("renders no panel or summary where kept manuals are unsupported", () => {
    storage.supported = false;
    expect(render(h(KeepManualPanel, { manual, fromDevice: false }))).toBe("");
    expect(render(h(KeptManualsSummary))).toBe("");
  });

  it("says where the open copy came from", () => {
    device.store.setState({ kept: { m1: { uuid: "m1", size: 2_000_000 } } });
    expect(render(h(KeepManualPanel, { manual, fromDevice: true }))).toContain(
      "1.9 MB · Opened from this device. Opens instantly, even offline.",
    );
  });

  it("asks for a connection to keep a manual offline", () => {
    workspace.state.online = false;
    expect(render(h(KeepManualPanel, { manual, fromDevice: false }))).toContain(
      "Keep it to open it instantly, even offline. Connect to keep it.",
    );
  });

  it("summarizes the kept manuals and whether they are protected", () => {
    device.store.setState({
      kept: { m1: { uuid: "m1", size: 2_000_000 } },
      storage: { usage: 2_000_000, quota: 1_000_000_000, persisted: true },
    });
    const html = render(h(KeptManualsSummary));
    expect(html).toContain("1 manual · 1.9 MB used");
    expect(html).toContain("Protected from clean-up");
  });

  it("explains a failed device copy", () => {
    expect(render(h(DeviceCopyNotice))).toContain(
      "the online file is opening instead",
    );
  });
});

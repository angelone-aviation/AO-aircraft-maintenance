/**
 * Responsibility: Pins the scanner's first render (camera preview, typed-code
 *   form, Scan button, Scan label page), that closing it stops the scan
 *   timer, and that a scanned label it cannot open stops the camera.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InventoryScanner.tsx, src/data/demo.ts,
 *   react-dom/server.
 *
 * Server rendering never runs effects, so a partial react mock records them:
 * running them mounts the camera loop and their cleanups close the scanner.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { InventoryScanner, ScanButton, ScanPage } from "./InventoryScanner";

const SCANNED_CODE = "UNKNOWN-1";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  refs: [] as { current: unknown }[],
  // useState slots in call order, kept across renders so a setter called by
  // the camera loop shows on the next render.
  states: [] as unknown[],
  slot: 0,
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: () => unknown) => {
      hooks.effects.push(effect);
    },
    useRef: (initial: unknown) => {
      const ref = react.useRef(initial);
      hooks.refs.push(ref);
      return ref;
    },
    useState: (initial: unknown) => {
      const slot = hooks.slot++;
      if (!(slot in hooks.states)) hooks.states[slot] = initial;
      const set = (next: unknown) =>
        (hooks.states[slot] =
          typeof next === "function" ? next(hooks.states[slot]) : next);
      return [hooks.states[slot], set];
    },
  };
});

vi.mock("../data/store", async () => {
  const { demoSnapshot } = await import("../data/demo");
  const snapshot = demoSnapshot();
  return {
    useWorkspace: (select: (state: unknown) => unknown) => select({ snapshot }),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("jsqr", () => ({ default: () => ({ data: SCANNED_CODE }) }));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("starts with the camera preview beside the typed-code form", () => {
  const html = render();
  expect(html).toContain('data-state="idle"');
  expect(html).toContain("<video");
  expect(html).toContain("<strong>Camera preview</strong>");
  expect(html).toContain("Enter a label manually");
  expect(html).toContain('aria-label="Enter code manually"');
  expect(html).not.toContain('role="alert"');
});

it("shows only the Scan button until it is pressed", () => {
  const html = renderToStaticMarkup(h(ScanButton));
  expect(html).toMatch(
    /^<button type="button" class="button">.*Scan<\/button>$/,
  );
});

it("puts the scanner under the Scan label page header", () => {
  const html = renderToStaticMarkup(h(ScanPage));
  expect(html).toContain("Scan label");
  expect(html).toContain("inventory-scanner");
});

it("stops the camera on a label it cannot open and says why on the camera", async () => {
  const { timers, tick, track } = stubCamera();
  const camera = fakeVideo();
  mountScanner(camera.video);
  await vi.waitFor(() => expect(camera.video.play).toHaveBeenCalled());
  camera.start();
  await vi.waitFor(() => expect(timers.size).toBe(1));
  tick();
  expect(timers.size).toBe(0);
  expect(track.stop).toHaveBeenCalled();
  const [panel, form] = render().split('class="ops-manual"');
  expect(panel).toContain(
    `No inventory item you can access matches “${SCANNED_CODE}”.`,
  );
  expect(panel).toContain("Scan again");
  expect(panel).not.toContain("<video");
  expect(form).not.toContain('role="alert"');
});

it("runs the scan timer while the camera plays and stops it on close", async () => {
  const { timers } = stubCamera();
  const camera = fakeVideo();
  const close = mountScanner(camera.video);
  await vi.waitFor(() => expect(camera.video.play).toHaveBeenCalled());
  camera.start();
  await vi.waitFor(() => expect(timers.size).toBe(1));
  close();
  expect(timers.size).toBe(0);
});

it("starts no scan timer when it closes before the camera plays", async () => {
  const { timers } = stubCamera();
  const camera = fakeVideo();
  const close = mountScanner(camera.video);
  await vi.waitFor(() => expect(camera.video.play).toHaveBeenCalled());
  close();
  camera.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(timers.size).toBe(0);
});

function render() {
  hooks.slot = 0;
  return renderToStaticMarkup(h(InventoryScanner, {}));
}

// Renders the scanner, hands its video ref the fake element and runs its
// effects; the returned function runs their cleanups, as closing would.
function mountScanner(video: unknown) {
  hooks.effects.length = 0;
  hooks.refs.length = 0;
  hooks.states.length = 0;
  render();
  const videoRef = hooks.refs.find((ref) => ref.current === null);
  if (!videoRef) throw new Error("The scanner rendered no video ref.");
  videoRef.current = video;
  const cleanups = hooks.effects.map((effect) => effect());
  return () =>
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === "function") cleanup();
    });
}

// A camera that grants a stream at once. Returns the ids of running timers,
// tick() to read one frame, and the stream's track.
function stubCamera() {
  const timers = new Set<number>();
  let lastTimer = 0;
  let scan = () => {};
  const track = { stop: vi.fn() };
  vi.stubGlobal("window", {
    setInterval: (callback: () => void) => {
      scan = callback;
      lastTimer += 1;
      timers.add(lastTimer);
      return lastTimer;
    },
    clearInterval: (timer: number) => timers.delete(timer),
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  const context = {
    drawImage: () => {},
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }),
  };
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => context }),
  });
  return { timers, tick: () => scan(), track };
}

// A ready video element whose play() waits until the test calls start().
function fakeVideo() {
  let resolvePlay = () => {};
  const play = vi.fn(
    () => new Promise<void>((resolve) => (resolvePlay = resolve)),
  );
  const frame = { readyState: 4, HAVE_ENOUGH_DATA: 4, videoWidth: 1 };
  return {
    video: { srcObject: null, play, ...frame, videoHeight: 1 },
    start: () => resolvePlay(),
  };
}

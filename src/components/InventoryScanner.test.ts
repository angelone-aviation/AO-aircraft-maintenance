/**
 * Responsibility: Pins the scanner's first render (camera preview, typed-code
 *   form, Scan button, Scan label page) and that closing it stops the scan
 *   timer.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InventoryScanner.tsx, react-dom/server.
 *
 * Server rendering never runs effects, so a partial react mock records them:
 * running them mounts the camera loop and their cleanups close the scanner.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { InventoryScanner, ScanButton, ScanPage } from "./InventoryScanner";

const hooks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  refs: [] as { current: unknown }[],
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
  };
});

vi.mock("../data/store", () => ({
  useWorkspace: (select: (state: unknown) => unknown) =>
    select({ snapshot: { management: [] } }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("starts with the camera preview beside the typed-code form", () => {
  const html = renderToStaticMarkup(h(InventoryScanner, {}));
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

it("runs the scan timer while the camera plays and stops it on close", async () => {
  const timers = stubCamera();
  const camera = fakeVideo();
  const close = mountScanner(camera.video);
  await vi.waitFor(() => expect(camera.video.play).toHaveBeenCalled());
  camera.start();
  await vi.waitFor(() => expect(timers.size).toBe(1));
  close();
  expect(timers.size).toBe(0);
});

it("starts no scan timer when it closes before the camera plays", async () => {
  const timers = stubCamera();
  const camera = fakeVideo();
  const close = mountScanner(camera.video);
  await vi.waitFor(() => expect(camera.video.play).toHaveBeenCalled());
  close();
  camera.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(timers.size).toBe(0);
});

// Renders the scanner, hands its video ref the fake element and runs its
// effects; the returned function runs their cleanups, as closing would.
function mountScanner(video: unknown) {
  hooks.effects.length = 0;
  hooks.refs.length = 0;
  renderToStaticMarkup(h(InventoryScanner, {}));
  const videoRef = hooks.refs.find((ref) => ref.current === null);
  if (!videoRef) throw new Error("The scanner rendered no video ref.");
  videoRef.current = video;
  const cleanups = hooks.effects.map((effect) => effect());
  return () =>
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === "function") cleanup();
    });
}

// A camera that grants a stream at once; returns the ids of running timers.
function stubCamera() {
  const timers = new Set<number>();
  let lastTimer = 0;
  vi.stubGlobal("window", {
    setInterval: () => {
      lastTimer += 1;
      timers.add(lastTimer);
      return lastTimer;
    },
    clearInterval: (timer: number) => timers.delete(timer),
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => null }),
  });
  return timers;
}

// A video element whose play() waits until the test calls start().
function fakeVideo() {
  let resolvePlay = () => {};
  const play = vi.fn(
    () => new Promise<void>((resolve) => (resolvePlay = resolve)),
  );
  return { video: { srcObject: null, play }, start: () => resolvePlay() };
}

/**
 * Responsibility: Pins the live session's rules: which screen a cached
 *   snapshot opens, when a sign-out clears the device, the sign-in failure
 *   message and signing out offline.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/main.tsx, react-dom/server, convex/server.
 *
 * CI never reaches a live backend (tests/e2e/live.spec.ts skips itself), so
 * the Convex and auth hooks are mocked; tests/e2e covers the demo screens.
 */
// @vitest-environment node
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONVEX_URL = "https://test.convex.cloud";
const TOKEN_KEY = `angel-one-auth:${CONVEX_URL}:token`;
const SIGNED_IN = { isLoading: false, isAuthenticated: true };
const SIGNED_OUT = { isLoading: false, isAuthenticated: false };
const SIGNED_IN_AT = Date.now();

const live = vi.hoisted(() => ({
  root: null as ReactElement | null,
  auth: { isLoading: false, isAuthenticated: false },
  socket: true,
  result: undefined as unknown,
  effects: [] as (() => unknown)[],
  signIn: vi.fn(),
  signOut: vi.fn(),
  onSubmit: undefined as ((data: FormData) => Promise<void>) | undefined,
  onExit: undefined as (() => void) | undefined,
  workspace: {} as Record<string, unknown>,
}));

vi.mock("virtual:pwa-register", () => ({ registerSW: () => {} }));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: (root: ReactElement) => (live.root = root) }),
}));
vi.mock("convex/react", () => ({
  ConvexReactClient: class {},
  useConvexAuth: () => live.auth,
  useConvexConnectionState: () => ({ isWebSocketConnected: live.socket }),
  useQuery: (query: FunctionReference<"query">, args: unknown) => {
    if (getFunctionName(query) !== "operations:snapshot") return [];
    return args === "skip" ? undefined : live.result;
  },
}));
vi.mock("@convex-dev/auth/react", () => ({
  ConvexAuthProvider: ({ children }: { children: unknown }) => children,
  useAuthActions: () => ({ signIn: live.signIn, signOut: live.signOut }),
}));
vi.mock("./data/store", () => {
  const useWorkspace = () => live.workspace;
  useWorkspace.getState = () => live.workspace;
  useWorkspace.setState = () => {};
  return { useWorkspace, renewDemoAccess: vi.fn() };
});
vi.mock("./data/deviceManuals", () => ({
  hasKeptManuals: async () => false,
  removeAllKeptManuals: async () => {},
}));
vi.mock("./data/pdfOffline", () => ({ warmPdfViewer: vi.fn() }));
vi.mock("./data/backend", () => ({ convexBackend: () => ({}) }));
vi.mock("./App", () => ({
  App: ({ onExit }: { onExit: () => void }) => {
    live.onExit = onExit;
    return h("p", null, "Workspace open");
  },
}));
vi.mock("./components/design", async (original) => ({
  ...(await original<typeof import("./components/design")>()),
  initTheme: () => {},
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => unknown) => void live.effects.push(effect),
}));
// Vitest compiles JSX for development, through jsxDEV.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, ...rest) => {
    const form = props as { submitLabel?: string; onSubmit?: never };
    // The form footer gets the label too, without the handler.
    if (form.submitLabel === "Sign in" && form.onSubmit)
      live.onSubmit = form.onSubmit;
    return runtime.jsxDEV(type, props, ...rest);
  };
  return { ...runtime, jsxDEV };
});

beforeEach(async () => {
  stubBrowser();
  vi.stubEnv("VITE_CONVEX_URL", CONVEX_URL);
  vi.resetModules();
  await import("./main");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("which screen a cached snapshot opens", () => {
  it("opens offline, or with the socket down, even when signed out", () => {
    expect(screen({ online: false }, SIGNED_OUT)).toContain("Workspace open");
    expect(screen({}, SIGNED_OUT, undefined, false)).toContain(
      "Workspace open",
    );
  });

  it("opens connected only once the server's snapshot is for the same user", () => {
    expect(screen({}, SIGNED_IN, snapshot("pilot"))).toContain(
      "Workspace open",
    );
    expect(screen({}, SIGNED_IN, snapshot("other"))).toContain("Welcome back.");
    expect(screen({}, SIGNED_IN, null)).toContain("Welcome back.");
    expect(screen({}, SIGNED_OUT)).toContain("Welcome back.");
  });

  it("waits for sign-in and the first snapshot only on a working connection", () => {
    const loading = "Opening your workspace…";
    expect(screen({}, { isLoading: true, isAuthenticated: false })).toContain(
      loading,
    );
    expect(screen({}, SIGNED_IN, undefined)).toContain(loading);
    expect(screen({ ready: false }, SIGNED_IN, snapshot("pilot"))).toContain(
      loading,
    );
    expect(
      screen({ online: false }, { isLoading: true, isAuthenticated: true }),
    ).toContain("Workspace open");
  });
});

describe("handing the server's snapshot to the workspace", () => {
  it("clears the device on a sign-out only once settled on a working connection", () => {
    expect(received({}, SIGNED_OUT)).toEqual([[null]]);
    expect(received({ online: false }, SIGNED_OUT)).toEqual([]);
    expect(received({}, SIGNED_OUT, undefined, false)).toEqual([]);
    expect(received({}, { isLoading: true, isAuthenticated: false })).toEqual(
      [],
    );
    expect(received({ ready: false }, SIGNED_OUT)).toEqual([]);
  });

  it("passes on every signed-in answer, null for an inactive account included", () => {
    expect(received({}, SIGNED_IN, snapshot("pilot"))).toEqual([
      [snapshot("pilot")],
    ]);
    expect(received({}, SIGNED_IN, null)).toEqual([[null]]);
    expect(received({}, SIGNED_IN, undefined)).toEqual([]);
  });
});

describe("signing in and out", () => {
  it("signs in with the password flow and names the likely cause on refusal", async () => {
    screen({}, SIGNED_OUT);
    const data = new FormData();
    data.set("email", " pilot@example.test ");
    data.set("password", "secret");
    await live.onSubmit!(data);
    expect(live.signIn).toHaveBeenCalledWith("password", {
      email: "pilot@example.test",
      password: "secret",
      flow: "signIn",
    });
    live.signIn.mockRejectedValueOnce(
      new Error("[CONVEX A(auth:signIn)] [Request ID: 1] Server Error"),
    );
    await expect(live.onSubmit!(data)).rejects.toThrow(
      /^Email or password is incorrect\. After too many wrong tries/,
    );
  });

  it("signs out offline by removing this deployment's tokens without the server", async () => {
    screen({ online: false }, SIGNED_OUT);
    vi.stubGlobal("navigator", { onLine: false });
    live.onExit!();
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled());
    expect(live.workspace.signOutLocal).toHaveBeenCalled();
    expect(live.signOut).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem("other-key")).toBe("kept");
  });

  it("also ends the server session when online", async () => {
    screen({}, SIGNED_IN, snapshot("pilot"));
    live.onExit!();
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalled());
    expect(live.signOut).toHaveBeenCalled();
  });
});

function screen(
  workspace: Record<string, unknown>,
  auth: typeof live.auth,
  result?: unknown,
  socket = true,
) {
  Object.assign(live, { auth, result, socket, effects: [] });
  live.workspace = {
    ready: true,
    online: true,
    snapshot: snapshot("pilot"),
    queue: [],
    namespace: `live:${CONVEX_URL}`,
    initialize: vi.fn(async () => {}),
    receive: vi.fn(async () => {}),
    setConnection: vi.fn(),
    signOutLocal: vi.fn(async () => {}),
    ...workspace,
  };
  return renderToStaticMarkup(live.root!);
}

function received(
  workspace: Record<string, unknown>,
  auth: typeof live.auth,
  result?: unknown,
  socket = true,
) {
  screen(workspace, auth, result, socket);
  for (const effect of live.effects) effect();
  const receive = live.workspace.receive as ReturnType<typeof vi.fn>;
  return receive.mock.calls;
}

function snapshot(userId: string) {
  return {
    user: { id: userId, active: true },
    authenticatedAt: SIGNED_IN_AT,
  };
}

function stubBrowser() {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_KEY, "token");
  storage.setItem("other-key", "kept");
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", { href: "https://app.test/", reload: vi.fn() });
  vi.stubGlobal("window", {
    location,
    history: { replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("document", { getElementById: () => ({}) });
}

// Like the browser's Storage, the stored keys are the object's own keys,
// which clearAuthStorage lists with Object.keys.
class MemoryStorage {
  [key: string]: unknown;
  getItem(key: string) {
    return Object.hasOwn(this, key) ? String(this[key]) : null;
  }
  setItem(key: string, value: string) {
    this[key] = value;
  }
  removeItem(key: string) {
    delete this[key];
  }
}

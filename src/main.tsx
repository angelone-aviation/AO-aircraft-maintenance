/**
 * Responsibility: Boots the app: starts error reporting, chooses the live or
 *   demo backend, signs the user in and mounts the workspace.
 * Layer: UI. The browser entry point; the only module that creates the Convex
 *   client.
 * Dependencies: convex/react, convex/server, @convex-dev/auth/react,
 *   src/data (store, backend, deviceManuals, pdfOffline, pendingEntries,
 *   pushDevice, errorReporting), src/domain/model.ts, src/App.tsx,
 *   src/components.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConvexReactClient,
  useConvexAuth,
  useQueries,
  useConvexConnectionState,
} from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { registerSW } from "virtual:pwa-register";
import { AirplaneTilt, ArrowRight } from "@phosphor-icons/react";
import { api } from "../convex/_generated/api";
import { guardNumberEntry } from "./components/numberEntry";
import { renewDemoAccess, useWorkspace, type Workspace } from "./data/store";
import { hasKeptManuals, removeAllKeptManuals } from "./data/deviceManuals";
import { warmPdfViewer } from "./data/pdfOffline";
import { pendingEntriesFile } from "./data/pendingEntries";
import { convexBackend } from "./data/backend";
import { releasePushDevice } from "./data/pushDevice";
import {
  captureError,
  initErrorReporting,
  reactErrorHandlers,
} from "./data/errorReporting";
import {
  deviceClockBehind,
  offlineValid,
  OFFLINE_WINDOW,
  type Snapshot,
} from "./domain/model";
import { AsyncForm, Field, download, errorText, value } from "./components/ui";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles.css";
import { Wordmark, initTheme } from "./components/design";
import { SignInNotice, SsoSignIn } from "./components/SignInMethods";
import {
  chooseLiveScreen,
  keptCopyIsTheirs,
  type LiveSession,
} from "./components/liveScreen";
import { WorkspaceUnavailable } from "./components/WorkspaceUnavailable";
import { ErrorBoundary, RenderFailure } from "./components/ErrorBoundary";
void initErrorReporting();
initTheme();
const configuredUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
// Production builds offer the local demo only when built with VITE_DEMO_MODE
// (demo forced) or VITE_ALLOW_DEMO (demo offered; used by the e2e build).
const demoAllowed =
  import.meta.env.DEV ||
  import.meta.env.VITE_DEMO_MODE === "true" ||
  import.meta.env.VITE_ALLOW_DEMO === "true";
// Convex Auth refuses a wrong email or password, and an account locked after
// too many tries (convex/auth.ts), with a plain Error that production hides as
// "Server Error". Those are by far the likeliest causes, so name them.
const SIGN_IN_FAILED =
  "Email or password is incorrect. After too many wrong tries, sign-in pauses for a while; your administrator can reset your password.";
const DEMO_SESSION_KEY = "angel-one-demo";
// Re-render on this beat so seven-day offline access also ends in an app left
// open, not only at the next reload.
const ACCESS_RECHECK_MS = 15_000;
const DAY_MS = 86_400_000;
const client = configuredUrl ? new ConvexReactClient(configuredUrl) : null;
const authPrefix = "angel-one-auth:" + configuredUrl + ":";
const authStorage = {
  getItem: (key: string) => localStorage.getItem(authPrefix + key),
  setItem: (key: string, val: string) =>
    localStorage.setItem(authPrefix + key, val),
  removeItem: (key: string) => localStorage.removeItem(authPrefix + key),
};

type AuthActions = ReturnType<typeof useAuthActions>;
type ArglessQuery = FunctionReference<"query", "public", Record<string, never>>;

function clearAuthStorage() {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(authPrefix)) localStorage.removeItem(key);
}
function Root() {
  const [demo, setDemo] = useState(
    import.meta.env.VITE_DEMO_MODE === "true" ||
      (demoAllowed && sessionStorage.getItem(DEMO_SESSION_KEY) === "true"),
  );
  const selectDemo = () => {
    sessionStorage.setItem(DEMO_SESSION_KEY, "true");
    setDemo(true);
  };
  if (demo) return <DemoRoot onExit={exitDemo} />;
  if (client)
    return (
      <ConvexAuthProvider client={client} storage={authStorage}>
        <LiveRoot
          client={client}
          onDemo={demoAllowed ? selectDemo : undefined}
        />
      </ConvexAuthProvider>
    );
  if (!demoAllowed) return <ConfigurationError />;
  return <SetupWelcome onDemo={selectDemo} />;
}
function exitDemo() {
  sessionStorage.removeItem(DEMO_SESSION_KEY);
  // Signing out of the demo removes its kept manuals, as signing out
  // of a connected workspace does.
  void removeAllKeptManuals(useWorkspace.getState().namespace).finally(() =>
    window.location.assign("/"),
  );
}
function ConfigurationError() {
  return (
    <Welcome>
      <h1>Configuration error</h1>
      <p role="alert">
        This build has no backend configured (VITE_CONVEX_URL is missing), so
        sign-in and synchronization are unavailable. Contact your administrator.
      </p>
    </Welcome>
  );
}
function SetupWelcome({ onDemo }: { onDemo: () => void }) {
  return (
    <Welcome>
      <h1>
        Your next mission
        <br />
        starts here.
      </h1>
      <p>
        Flight records, aircraft status, and your maintenance team. Together in
        one workspace.
      </p>
      <div className="setup-box">
        <strong>Connect your Convex backend</strong>
        <p>
          Run <code>npm run dev:backend</code>, then follow the setup steps in
          README.md to create your administrator account.
        </p>
      </div>
      <button className="button primary" onClick={onDemo}>
        Explore the local demo{" "}
        <ArrowRight size={18} weight="bold" aria-hidden="true" />
      </button>
      <p className="welcome-footnote">
        Fictional data · Saved only in this browser
      </p>
    </Welcome>
  );
}
function useConnection(demo: boolean) {
  useEffect(() => {
    const update = () =>
      useWorkspace
        .getState()
        .setConnection(navigator.onLine, demo && navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [demo]);
}
function DemoRoot({ onExit }: { onExit: () => void }) {
  const { ready, snapshot, initialize } = useWorkspace();
  useConnection(true);
  useEffect(() => {
    void initialize("demo", true);
  }, [initialize]);
  useEffect(() => {
    if (ready) void useWorkspace.getState().flush();
  }, [ready]);
  if (!ready) return <Loading />;
  if (!snapshot)
    return (
      <Welcome>
        <h1>Storage unavailable</h1>
        <p>Enable persistent browser storage and reload to use the demo.</p>
      </Welcome>
    );
  return (
    <AccessGate onExit={onExit}>
      <App onExit={onExit} />
    </AccessGate>
  );
}
function LiveRoot({
  client,
  onDemo,
}: {
  client: ConvexReactClient;
  onDemo?: () => void;
}) {
  const { signOut } = useAuthActions();
  const [openKeptCopy, setOpenKeptCopy] = useState(false);
  const session = useLiveSession(client);
  const screen = chooseLiveScreen(session, openKeptCopy);
  const exit = () => void signOutOfLive(signOut);
  if (screen === "loading") return <Loading />;
  if (screen === "unavailable")
    return (
      <Welcome>
        <WorkspaceUnavailable
          keptCopySyncedAt={
            keptCopyIsTheirs(session) ? session.snapshot?.syncedAt : undefined
          }
          userId={session.signedInUserId}
          onRetry={() => window.location.reload()}
          onOpenKeptCopy={() => setOpenKeptCopy(true)}
          onSignOut={exit}
        />
      </Welcome>
    );
  if (screen === "workspace")
    return (
      <AccessGate onExit={exit}>
        <App onExit={exit} />
      </AccessGate>
    );
  return <SignIn onDemo={onDemo} />;
}
function useLiveSession(client: ConvexReactClient): LiveSession {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const connection = useConvexConnectionState();
  const { ready, snapshot, initialize, receive, online } = useWorkspace();
  const outcome = useQueryOutcome(api.operations.snapshot, isAuthenticated);
  const failure = outcome instanceof Error ? outcome : undefined;
  const result = outcome instanceof Error ? undefined : outcome;
  const signedIn = useQueryOutcome(api.operations.signedInUser, !!failure);
  useEffect(() => {
    useWorkspace.setState({ backend: convexBackend(client) });
    void initialize("live:" + configuredUrl, false);
  }, [initialize, client]);
  const session = {
    ready,
    snapshot,
    online,
    socket: connection.isWebSocketConnected,
    isLoading,
    isAuthenticated,
    result,
    failure,
    signedInUserId: signedIn instanceof Error ? undefined : signedIn,
  };
  useReportConnection(session);
  useReceiveSnapshot(session, receive);
  useConnection(false);
  return session;
}
// useQuery throws a failed query into render, which left a blank page that a
// reload could not clear; useQueries hands the Error back instead. Memoized
// by name, as useQuery is: each `api.x.y` access is a new reference.
function useQueryOutcome<Query extends ArglessQuery>(
  query: Query,
  enabled: boolean,
): FunctionReturnType<Query> | Error | undefined {
  const name = getFunctionName(query);
  const queries = useMemo(() => {
    const request: Parameters<typeof useQueries>[0] = {};
    if (enabled)
      request.outcome = { query: makeFunctionReference(name), args: {} };
    return request;
  }, [name, enabled]);
  return useQueries(queries).outcome;
}
function useReportConnection(session: LiveSession) {
  const { online, isAuthenticated, socket, ready, result } = session;
  useEffect(() => {
    if (!ready) return;
    useWorkspace
      .getState()
      .setConnection(online, isAuthenticated && socket && !!result);
  }, [online, isAuthenticated, socket, ready, result]);
}
// A sign-out clears the device cache only once sign-in has settled on a
// working connection; offline, the cached snapshot keeps its seven-day access.
function useReceiveSnapshot(
  session: LiveSession,
  receive: Workspace["receive"],
) {
  const { result, isAuthenticated, isLoading, online, socket, ready } = session;
  useEffect(() => {
    if (!ready) return;
    if (result !== undefined && isAuthenticated) void receive(result);
    else if (!isLoading && !isAuthenticated && online && socket)
      void receive(null);
  }, [result, isAuthenticated, isLoading, online, socket, ready, receive]);
}
async function signOutOfLive(signOut: AuthActions["signOut"]) {
  const { backend } = useWorkspace.getState();
  // While the session lasts, so the next person on this device never sees
  // the previous member's alerts (ADR-0012). A browser that cannot
  // unsubscribe must not keep anyone signed in; the failure is reported.
  if (backend) await releasePushDevice(backend).catch(captureError);
  await useWorkspace.getState().signOutLocal();
  // Offline the server can't be told; removing the stored tokens is what
  // signs this device out.
  clearAuthStorage();
  if (navigator.onLine) await signOut();
  window.location.reload();
}
function SignIn({ onDemo }: { onDemo?: () => void }) {
  const { signIn } = useAuthActions();
  const { online } = useWorkspace();
  return (
    <Welcome>
      <h1>Welcome back.</h1>
      <p>Sign in to your aircraft operations workspace.</p>
      <SignInNotice />
      <AsyncForm
        submitLabel="Sign in"
        disabled={!online}
        onSubmit={(data) => signInWithPassword(signIn, data)}
      >
        <Field label="Email">
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <PasswordField />
      </AsyncForm>
      <SsoSignIn disabled={!online} />
      {!online && (
        <p className="callout">
          Connect to sign in for the first time on this device.
        </p>
      )}
      {onDemo && (
        <>
          <p className="welcome-divider">or</p>
          <button className="button" onClick={onDemo}>
            <AirplaneTilt size={18} aria-hidden="true" /> Explore the local demo
          </button>
        </>
      )}
      <p className="welcome-footnote">
        Accounts are created by your administrator. No public signup.
      </p>
    </Welcome>
  );
}
async function signInWithPassword(
  signIn: AuthActions["signIn"],
  data: FormData,
) {
  try {
    await signIn("password", {
      email: value(data, "email"),
      password: String(data.get("password") ?? ""),
      flow: "signIn",
    });
  } catch (error) {
    throw new Error(errorText(error, SIGN_IN_FAILED));
  }
}
function AccessGate({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  const { snapshot } = useWorkspace();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setTick((tick) => tick + 1),
      ACCESS_RECHECK_MS,
    );
    return () => clearInterval(id);
  }, []);
  if (!snapshot || !offlineValid(snapshot))
    return <AccessExpired onExit={onExit} />;
  return children;
}
function AccessExpired({ onExit }: { onExit: () => void }) {
  const { snapshot, queue, demo, online } = useWorkspace();
  return (
    <Welcome>
      <h1>Time to reconnect.</h1>
      {snapshot && deviceClockBehind(snapshot) ? (
        <p>
          This device&apos;s clock is behind the time you signed in. Set the
          date and time to update automatically, then reopen the app. Pending
          entries are preserved.
        </p>
      ) : (
        <p>
          Your seven-day offline access has expired. Pending entries are
          preserved. Sign in again to continue.
        </p>
      )}
      <button className="button primary" onClick={onExit}>
        Return to sign in
      </button>
      {demo && online && (
        <button
          className="button"
          onClick={() => {
            if (snapshot) void renewDemoAccess();
          }}
        >
          Renew demo access
        </button>
      )}
      {snapshot && (
        <button
          className="text-button"
          onClick={() => exportPendingEntries(queue, snapshot.user.id)}
        >
          Export my pending entries
        </button>
      )}
      <small>
        Offline access lasts {OFFLINE_WINDOW / DAY_MS} days from authentication.
      </small>
    </Welcome>
  );
}
function exportPendingEntries(queue: Workspace["queue"], userId: string) {
  const file = pendingEntriesFile(queue, userId);
  download(file.name, file.text);
}
// Accounts are managed by administrators and there is no self-service reset
// (ADR-0002): "Forgot?" only explains whom to ask; it makes no request.
function PasswordField() {
  const id = useId();
  const [forgot, setForgot] = useState(false);
  return (
    <div className="field">
      <div className="welcome-label-row">
        <label htmlFor={id}>Password</label>
        <button
          type="button"
          className="forgot-link"
          aria-expanded={forgot}
          aria-controls={id + "-forgot"}
          onClick={() => setForgot((v) => !v)}
        >
          Forgot?
        </button>
      </div>
      <input
        id={id}
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <p className="forgot-help" id={id + "-forgot"} hidden={!forgot}>
        Ask your administrator to reset your password.
      </p>
    </div>
  );
}
function Welcome({ children }: { children: React.ReactNode }) {
  return (
    <div className="welcome">
      <main className="welcome-card">
        <Wordmark width={176} />
        {children}
      </main>
      <p className="welcome-bottom">
        TO EVERY NATION, KINDRED, TONGUE AND PEOPLE
      </p>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <AirplaneTilt size={32} weight="duotone" aria-hidden="true" />
      <p>Opening your workspace…</p>
    </div>
  );
}
registerSW({
  onRegisteredSW() {
    // An update gives the PDF viewer files new addresses: cache them again
    // while online so kept manuals keep opening offline.
    if (navigator.onLine)
      void hasKeptManuals().then((kept) => {
        if (kept) void warmPdfViewer();
      });
  },
  onOfflineReady() {
    useWorkspace.setState({
      notice:
        "App installed for offline use. Sign in online to cache your permitted aircraft.",
    });
  },
  onNeedRefresh() {
    useWorkspace.setState({
      notice:
        "An app update is available. Save your current form, then close all app tabs and reopen to update.",
    });
  },
  onRegisterError: captureError,
});
guardNumberEntry(document);
createRoot(document.getElementById("root")!, reactErrorHandlers()).render(
  <ErrorBoundary
    fallback={
      <Welcome>
        <RenderFailure />
      </Welcome>
    }
  >
    <Root />
  </ErrorBoundary>,
);

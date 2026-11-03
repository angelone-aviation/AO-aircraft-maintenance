import { MissionSlogan } from "./components/MissionSlogan";
import { useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConvexReactClient,
  useConvexAuth,
  useQuery,
  useConvexConnectionState,
} from "convex/react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { registerSW } from "virtual:pwa-register";
import { AirplaneTilt, ArrowRight } from "@phosphor-icons/react";
import { api } from "../convex/_generated/api";
import { renewDemoAccess, useWorkspace } from "./data/store";
import { hasKeptManuals, removeAllKeptManuals } from "./data/deviceManuals";
import { warmPdfViewer } from "./data/pdfOffline";
import { convexBackend } from "./data/backend";
import { offlineValid, OFFLINE_WINDOW } from "./domain/model";
import { AsyncForm, Field, download, value } from "./components/ui";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles.css";
import { AircraftArt, Wordmark, initTheme } from "./components/design";
import { ThemeToggle } from "./components/AppShell";
import { SignInNotice, SsoSignIn } from "./components/SignInMethods";
initTheme();
const configuredUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
// Production builds offer the local demo only when built with VITE_DEMO_MODE
// (demo forced) or VITE_ALLOW_DEMO (demo offered; used by the e2e build).
const demoAllowed =
  import.meta.env.DEV ||
  import.meta.env.VITE_DEMO_MODE === "true" ||
  import.meta.env.VITE_ALLOW_DEMO === "true";
const client = configuredUrl ? new ConvexReactClient(configuredUrl) : null;
const authPrefix = "angel-one-auth:" + configuredUrl + ":";
const authStorage = {
  getItem: (key: string) => localStorage.getItem(authPrefix + key),
  setItem: (key: string, val: string) =>
    localStorage.setItem(authPrefix + key, val),
  removeItem: (key: string) => localStorage.removeItem(authPrefix + key),
};
function clearAuthStorage() {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(authPrefix)) localStorage.removeItem(key);
}
function Root() {
  const [demo, setDemo] = useState(
    import.meta.env.VITE_DEMO_MODE === "true" ||
      (demoAllowed && sessionStorage.getItem("angel-one-demo") === "true"),
  );
  const selectDemo = () => {
    sessionStorage.setItem("angel-one-demo", "true");
    setDemo(true);
  };
  if (demo)
    return (
      <DemoRoot
        onExit={() => {
          sessionStorage.removeItem("angel-one-demo");
          // Signing out of the demo removes its kept manuals, as signing out
          // of a connected workspace does.
          void removeAllKeptManuals(useWorkspace.getState().namespace).finally(
            () => window.location.assign("/"),
          );
        }}
      />
    );
  if (client)
    return (
      <ConvexAuthProvider client={client} storage={authStorage}>
        <LiveRoot
          client={client}
          onDemo={demoAllowed ? selectDemo : undefined}
        />
      </ConvexAuthProvider>
    );
  if (!demoAllowed)
    return (
      <Welcome>
        <h1>Configuration error</h1>
        <p role="alert">
          This build has no backend configured (VITE_CONVEX_URL is missing), so
          sign-in and synchronization are unavailable. Contact your
          administrator.
        </p>
      </Welcome>
    );
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
      <button className="button primary" onClick={selectDemo}>
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
  const { signIn, signOut } = useAuthActions();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const connection = useConvexConnectionState();
  const { ready, snapshot, initialize, receive, online } = useWorkspace();
  const result = useQuery(
    api.operations.snapshot,
    isAuthenticated ? {} : "skip",
  );
  useEffect(() => {
    useWorkspace.setState({ backend: convexBackend(client) });
    void initialize("live:" + configuredUrl, false);
  }, [initialize, client]);
  useEffect(() => {
    if (!ready) return;
    useWorkspace
      .getState()
      .setConnection(
        online,
        isAuthenticated && connection.isWebSocketConnected && !!result,
      );
  }, [online, isAuthenticated, connection.isWebSocketConnected, ready, result]);
  useEffect(() => {
    if (!ready) return;
    if (result !== undefined && isAuthenticated) void receive(result);
    else if (
      !isLoading &&
      !isAuthenticated &&
      online &&
      connection.isWebSocketConnected
    )
      void receive(null);
  }, [
    result,
    isAuthenticated,
    isLoading,
    online,
    connection.isWebSocketConnected,
    ready,
    receive,
  ]);
  useConnection(false);
  async function exit() {
    await useWorkspace.getState().signOutLocal();
    clearAuthStorage();
    if (navigator.onLine) await signOut();
    window.location.reload();
  }
  const liveConnection = online && connection.isWebSocketConnected;
  if (
    !ready ||
    (liveConnection && (isLoading || (isAuthenticated && result === undefined)))
  )
    return <Loading />;
  if (
    snapshot &&
    (!liveConnection ||
      (isAuthenticated && result && snapshot.user.id === result.user.id))
  )
    return (
      <AccessGate onExit={() => void exit()}>
        <App onExit={() => void exit()} />
      </AccessGate>
    );
  return (
    <Welcome>
      <h1>Welcome back.</h1>
      <p>Sign in to your aircraft operations workspace.</p>
      <SignInNotice />
      <AsyncForm
        submitLabel="Sign in"
        disabled={!online}
        onSubmit={async (data) => {
          await signIn("password", {
            email: value(data, "email"),
            password: String(data.get("password") ?? ""),
            flow: "signIn",
          });
        }}
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
function AccessGate({
  children,
  onExit,
}: {
  children: React.ReactNode;
  onExit: () => void;
}) {
  const { snapshot, queue, demo, online } = useWorkspace();
  const [, setNow] = useState(Date.now());
  const now = Date.now();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  if (!snapshot || !offlineValid(snapshot, now))
    return (
      <Welcome>
        <h1>Time to reconnect.</h1>
        <p>
          Your seven-day offline access has expired. Pending entries are
          preserved. Sign in again to continue.
        </p>
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
            onClick={() =>
              download(
                "angel-one-pending-entries.json",
                JSON.stringify(
                  queue.filter(
                    (q) => q.operation.authorId === snapshot.user.id,
                  ),
                  null,
                  2,
                ),
              )
            }
          >
            Export my pending entries
          </button>
        )}
        <small>
          Offline access lasts {OFFLINE_WINDOW / 86400000} days from
          authentication.
        </small>
      </Welcome>
    );
  return children;
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
      <span className="welcome-grid" aria-hidden="true" />
      <AircraftArt className="welcome-art" opacity={0.12} drift />
      <ThemeToggle className="welcome-theme" />
      <main className="welcome-card">
        <Wordmark width={176} />
        {children}
      </main>
      <MissionSlogan />
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
});
createRoot(document.getElementById("root")!).render(<Root />);

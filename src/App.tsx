/**
 * Responsibility: The signed-in app shell (workspace banners, then the owner
 *   portal, the board view or the routed screen) and the route table of every
 *   screen.
 * Layer: UI (entry). Composes screens; holds no business rules.
 * Dependencies: @tanstack/react-router, src/components (AppShell, screens),
 *   src/data/store.ts, src/domain (ownerView, boardView, aircraftSetup).
 */
import { isOwnerView } from "./domain/ownerView";
import { isBoardView } from "./domain/boardView";
import { AppShell } from "./components/AppShell";
import { AppUpdateNotice } from "./components/appUpdate";
import { setDialogHistory } from "./components/design";
import { createContext, useContext, lazy, Suspense } from "react";
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { X } from "@phosphor-icons/react";
import { useWorkspace } from "./data/store";
import type { Snapshot } from "./domain/model";
import { Dashboard } from "./components/Dashboard";
import { EmptyState } from "./components/design";
import { readSetupStep, type SetupStep } from "./domain/aircraftSetup";
// Loaded at startup: the "Larger text" setting applies on every screen,
// the sign-in screen included.
import "./styles/largeText.css";

const BOARD_PATH = "/board";
const GLOSSARY_PATH = "/glossary";

// Screens load on demand so older phones parse less code at startup.
const OwnerPortal = lazy(() =>
  import("./components/OwnerPortal").then((m) => ({ default: m.OwnerPortal })),
);
const Board = lazy(() =>
  import("./components/Board").then((m) => ({ default: m.Board })),
);
const AlertsPage = lazy(() =>
  import("./components/Alerts").then((m) => ({ default: m.AlertsPage })),
);
const SavedAddresses = lazy(() =>
  import("./components/SavedAddresses").then((m) => ({
    default: m.SavedAddresses,
  })),
);
const Vendors = lazy(() =>
  import("./components/Vendors").then((m) => ({ default: m.Vendors })),
);
const PartsRequests = lazy(() =>
  import("./components/PartsRequests").then((m) => ({
    default: m.PartsRequests,
  })),
);
const ImportedComponents = lazy(() =>
  import("./components/ComponentTemplates").then((m) => ({
    default: m.ImportedComponents,
  })),
);
const PurchaseOrders = lazy(() =>
  import("./components/PurchaseOrders").then((m) => ({
    default: m.PurchaseOrders,
  })),
);
const Airworthiness = lazy(() =>
  import("./components/Airworthiness").then((m) => ({
    default: m.Airworthiness,
  })),
);
const InspectionTemplates = lazy(() =>
  import("./components/InspectionTemplates").then((m) => ({
    default: m.InspectionTemplates,
  })),
);
const ReferenceLibrary = lazy(() =>
  import("./components/Manuals").then((m) => ({ default: m.ReferenceLibrary })),
);
const ManualViewer = lazy(() =>
  import("./components/Manuals").then((m) => ({ default: m.ManualViewer })),
);
const Checklists = lazy(() =>
  import("./components/Checklists").then((m) => ({ default: m.Checklists })),
);
const AircraftPage = lazy(() =>
  import("./components/Fleet").then((m) => ({ default: m.AircraftPage })),
);
const ProgramsPage = lazy(() =>
  import("./components/Fleet").then((m) => ({ default: m.ProgramsPage })),
);
const AircraftSetupPage = lazy(() =>
  import("./components/AircraftSetup").then((m) => ({
    default: m.AircraftSetupPage,
  })),
);
const TaskCards = lazy(() =>
  import("./components/TaskCards").then((m) => ({ default: m.TaskCards })),
);
const WorkOrders = lazy(() =>
  import("./components/WorkOrders").then((m) => ({ default: m.WorkOrders })),
);
const FlightPlans = lazy(() =>
  import("./components/FlightPlans").then((m) => ({ default: m.FlightPlans })),
);
const Flights = lazy(() =>
  import("./components/Records").then((m) => ({ default: m.Flights })),
);
const Discrepancies = lazy(() =>
  import("./components/Records").then((m) => ({ default: m.Discrepancies })),
);
const SyncCenter = lazy(() =>
  import("./components/Records").then((m) => ({ default: m.SyncCenter })),
);
const History = lazy(() =>
  import("./components/Records").then((m) => ({ default: m.History })),
);
const Administration = lazy(() =>
  import("./components/Admin").then((m) => ({ default: m.Administration })),
);
const Settings = lazy(() =>
  import("./components/Settings").then((m) => ({ default: m.Settings })),
);
const Planning = lazy(() =>
  import("./components/Planning").then((m) => ({ default: m.Planning })),
);
const MaintenanceCalendar = lazy(() =>
  import("./components/MaintenanceCalendar").then((m) => ({
    default: m.MaintenanceCalendar,
  })),
);
const Inspections = lazy(() =>
  import("./components/Management").then((m) => ({ default: m.Inspections })),
);
const Components = lazy(() =>
  import("./components/Management").then((m) => ({ default: m.Components })),
);
const CostsPage = lazy(() =>
  import("./components/Costs").then((m) => ({ default: m.CostsPage })),
);
const ScanPage = lazy(() =>
  import("./components/InventoryScanner").then((m) => ({
    default: m.ScanPage,
  })),
);
const GlossaryPage = lazy(() =>
  import("./components/Glossary").then((m) => ({ default: m.GlossaryPage })),
);
const Inventory = lazy(() =>
  import("./components/Management").then((m) => ({ default: m.Inventory })),
);
const ExitContext = createContext<() => void>(() => {});
const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <EmptyState
      title="Page not found"
      action={
        <Link to="/" className="button">
          Back to Overview
        </Link>
      }
    >
      This address does not match a page in Angel One.
    </EmptyState>
  ),
});
const manualRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/manuals/$manualUuid",
  validateSearch: readManualPage,
  component: () => {
    const { manualUuid } = manualRoute.useParams();
    const { page } = manualRoute.useSearch();
    return <ManualViewer uuid={manualUuid} page={page} />;
  },
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aircraft/setup",
  validateSearch: readSetupSearch,
  component: () => {
    const { step } = setupRoute.useSearch();
    return <AircraftSetupPage step={step} />;
  },
});
const setupAircraftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/aircraft/setup/$aircraftUuid",
  validateSearch: readSetupSearch,
  component: () => {
    const { aircraftUuid } = setupAircraftRoute.useParams();
    const { step } = setupAircraftRoute.useSearch();
    return <AircraftSetupPage aircraftUuid={aircraftUuid} step={step} />;
  },
});
const routes = [
  setupRoute,
  setupAircraftRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/airworthiness",
    component: Airworthiness,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/checklists",
    component: Checklists,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/inspection-templates",
    component: InspectionTemplates,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/purchase-orders",
    component: PurchaseOrders,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/vendors",
    component: Vendors,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/costs",
    component: CostsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/parts-requests",
    component: PartsRequests,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/saved-addresses",
    component: SavedAddresses,
  }),
  manualRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/manuals",
    component: ReferenceLibrary,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/task-cards",
    component: TaskCards,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/work-orders",
    component: WorkOrders,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/flight-plans",
    component: FlightPlans,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/aircraft",
    component: AircraftPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/programs",
    component: ProgramsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/inspections",
    component: Inspections,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/planning",
    component: Planning,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/planning/calendar",
    component: MaintenanceCalendar,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/components",
    validateSearch: (search: Record<string, unknown>): { item?: string } => ({
      item: readString(search.item),
    }),
    component: Components,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/scan",
    component: ScanPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/components/imported",
    component: ImportedComponents,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/inventory",
    validateSearch: (search: Record<string, unknown>) => ({
      item: readString(search.item),
      program: readString(search.program),
    }),
    component: Inventory,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Dashboard,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/flights",
    component: Flights,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/discrepancies",
    component: Discrepancies,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/sync",
    component: SyncCenter,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/history",
    component: History,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: BOARD_PATH,
    component: Board,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/alerts",
    component: AlertsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: Administration,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: Settings,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: GLOSSARY_PATH,
    component: GlossaryPage,
  }),
];
const router = createRouter({ routeTree: rootRoute.addChildren(routes) });
setDialogHistory(router.history);

// Registers the route tree so Link, useSearch and useNavigate type-check
// paths and search params against it.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * The signed-in app: shell, router and every screen. Render it only once the
 * workspace holds a snapshot.
 *
 * @param props.onExit - Signs out or leaves the demo; the shell's exit control
 *   calls it.
 * @returns The router over the app shell.
 */
export function App({ onExit }: { onExit: () => void }) {
  return (
    <ExitContext.Provider value={onExit}>
      <RouterProvider router={router} />
    </ExitContext.Provider>
  );
}

function Shell() {
  const { snapshot: s, demo, error, notice } = useWorkspace();
  const exit = useContext(ExitContext);
  // Keyed by program so switching Flight Program remounts the screen and
  // drops state that belonged to the previous program.
  const programKey = s!.activeProgramUuid ?? "unassigned";
  return (
    <AppShell exit={exit}>
      <main>
        {demo && (
          <div className="demo-banner">
            Demo workspace · Fictional aircraft and local browser data.
          </div>
        )}
        <AppUpdateNotice />
        {notice && <Notice text={notice} />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Suspense fallback={<p className="muted">Opening page…</p>}>
          <Screen key={programKey} s={s!} />
        </Suspense>
      </main>
    </AppShell>
  );
}

// Owners and board members get their one view whatever the route, so a
// bookmarked or typed path cannot open a screen they cannot use. An owner
// who also sits on the board opens the board view at its own path and the
// owner portal everywhere else. The Glossary holds no records, so it opens
// for everyone.
function Screen({ s }: { s: Snapshot }) {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const onBoardPath = pathname === BOARD_PATH;
  if (pathname === GLOSSARY_PATH) return <Outlet />;
  const owner = isOwnerView(s);
  if (isBoardView(s) && (!owner || onBoardPath)) return <Board />;
  if (owner) return <OwnerPortal />;
  return <Outlet />;
}

function Notice({ text }: { text: string }) {
  return (
    <div className="notice" role="status">
      <span>{text}</span>
      <button
        className="icon-button"
        aria-label="Dismiss notice"
        onClick={() => useWorkspace.setState({ notice: "" })}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// A page that is not a positive whole number opens the manual at page 1.
function readManualPage(search: Record<string, unknown>): { page: number } {
  const page = Number(search.page);
  return { page: Number.isInteger(page) && page > 0 ? page : 1 };
}

// An unknown step opens the wizard at its default step.
function readSetupSearch(search: Record<string, unknown>): {
  step?: SetupStep;
} {
  const step = readSetupStep(search.step);
  return step ? { step } : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

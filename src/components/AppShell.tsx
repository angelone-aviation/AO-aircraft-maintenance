/**
 * Responsibility: The application shell: grouped sidebar (≥1100px), icon rail
 *   (760–1099px), phone top bar and bottom tab bar (<760px), the "All
 *   sections" sheet, the top bar and the footer.
 * Layer: UI. React components around the routed screens.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (pilotView, ownerView, programs, model),
 *   ./Alerts, ./UserProfile, ./ComponentIcon, ./InspectionIcon,
 *   ./WorkOrderIcon, ./FlightForm, ./ui, ./design.
 *
 * Navigation visibility follows the same rules as before the redesign: pilot
 * view shows pilotNavigation only, the owner view shows the overview only, and
 * program administrators additionally get Administration and Costs. Settings
 * is the last Manage link for everyone except the owner view (owners keep
 * their portal).
 */
import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Airplane,
  AirplaneTakeoff,
  ArrowsClockwise,
  Bell,
  BookOpen,
  Books,
  Buildings,
  CalendarDots,
  Cards,
  CaretDown,
  ClockCounterClockwise,
  CurrencyCircleDollar,
  GearSix,
  List,
  ListChecks,
  MapPin,
  Moon,
  Package,
  Plus,
  Receipt,
  Scan,
  ShieldCheck,
  SignOut,
  SquaresFour,
  Stack,
  Storefront,
  Sun,
  Users,
  Warning,
} from "@phosphor-icons/react";
import { useWorkspace, previewDemoOwner } from "../data/store";
import { isPilotView, pilotNavigation } from "../domain/pilotView";
import { isOwnerView } from "../domain/ownerView";
import { programPermission } from "../domain/programs";
import { can, type Snapshot } from "../domain/model";
import { AlertBell, useUnreadAlertCount } from "./Alerts";
import { MyCertifications } from "./UserProfile";
import { ComponentIcon } from "./ComponentIcon";
import { InspectionIcon } from "./InspectionIcon";
import { WorkOrderIcon } from "./WorkOrderIcon";
import { FlightForm } from "./FlightForm";
import { Badge, Modal, errorText } from "./ui";
import {
  Dialog,
  Wordmark,
  useBreakpoint,
  useTheme,
  type IconType,
} from "./design";

type GroupKey = "fly" | "maintain" | "manage";
type NavItem = {
  path: string;
  label: string;
  icon: IconType;
  group: GroupKey;
};
const groups: { key: GroupKey; label: string }[] = [
  { key: "fly", label: "Fly" },
  { key: "maintain", label: "Maintain" },
  { key: "manage", label: "Manage" },
];
const railPaths = [
  "/",
  "/flights",
  "/discrepancies",
  "/inspections",
  "/work-orders",
  "/inventory",
  "/admin",
];
// Screens reached from inside other screens, for the top-bar title.
const extraTitles: [RegExp, string][] = [
  [/^\/manuals\//, "Reference library"],
  [/^\/inspection-templates/, "Inspection templates"],
  [/^\/task-cards/, "Job cards"],
  [/^\/components\//, "Components"],
];

function useNavigation() {
  const s = useWorkspace((x) => x.snapshot)!;
  const pilotView = isPilotView(s);
  const ownerView = isOwnerView(s);
  const admin = programPermission(s, "admin");
  // Workspace links, in the redesign's group order. The visibility rules are
  // unchanged: admin-only entries, then the owner / pilot filters.
  const workspace: (NavItem | false)[] = [
    { path: "/", label: "Overview", icon: SquaresFour, group: "fly" },
    {
      path: "/flight-plans",
      label: "Flight plans",
      icon: AirplaneTakeoff,
      group: "fly",
    },
    {
      path: "/checklists",
      label: "Checklists",
      icon: ListChecks,
      group: "fly",
    },
    { path: "/flights", label: "Flight log", icon: BookOpen, group: "fly" },
    {
      path: "/discrepancies",
      label: "Discrepancies",
      icon: Warning,
      group: "fly",
    },
    {
      path: "/inspections",
      label: "Inspections",
      icon: InspectionIcon,
      group: "maintain",
    },
    {
      path: "/planning",
      label: "Planning",
      icon: CalendarDots,
      group: "maintain",
    },
    {
      path: "/airworthiness",
      label: "Airworthiness directives",
      icon: ShieldCheck,
      group: "maintain",
    },
    {
      path: "/work-orders",
      label: "Work orders",
      icon: WorkOrderIcon,
      group: "maintain",
    },
    // Readable by every workspace member, like Work orders; creating,
    // editing and signing check maintenance access on the aircraft.
    { path: "/task-cards", label: "Job cards", icon: Cards, group: "maintain" },
    {
      path: "/parts-requests",
      label: "Parts & repair requests",
      icon: Package,
      group: "maintain",
    },
    {
      path: "/components",
      label: "Components",
      icon: ComponentIcon,
      group: "maintain",
    },
    { path: "/scan", label: "Scan label", icon: Scan, group: "maintain" },
    admin && {
      path: "/inventory",
      label: "Inventory",
      icon: Stack,
      group: "maintain",
    },
    {
      path: "/programs",
      label: "Flight Programs",
      icon: Buildings,
      group: "manage",
    },
    { path: "/aircraft", label: "Aircraft", icon: Airplane, group: "manage" },
    admin && {
      path: "/purchase-orders",
      label: "Purchase orders",
      icon: Receipt,
      group: "manage",
    },
    admin && {
      path: "/vendors",
      label: "Vendors",
      icon: Storefront,
      group: "manage",
    },
    {
      path: "/saved-addresses",
      label: "Saved addresses",
      icon: MapPin,
      group: "manage",
    },
    {
      path: "/manuals",
      label: "Reference library",
      icon: Books,
      group: "manage",
    },
    {
      path: "/sync",
      label: "Sync center",
      icon: ArrowsClockwise,
      group: "manage",
    },
    {
      path: "/history",
      label: "Change history",
      icon: ClockCounterClockwise,
      group: "manage",
    },
    // Alerts were reachable only from the bell; the bell stays, and the link
    // follows the same owner / pilot filters as every workspace link.
    { path: "/alerts", label: "Alerts", icon: Bell, group: "manage" },
  ];
  const visible = workspace
    .filter((item): item is NavItem => !!item)
    .filter((item) =>
      ownerView
        ? item.path === "/"
        : !pilotView || pilotNavigation.has(item.path),
    );
  // Management links keep their own rule: shown to program administrators.
  if (admin)
    visible.push(
      { path: "/admin", label: "Administration", icon: Users, group: "manage" },
      {
        path: "/costs",
        label: "Costs",
        icon: CurrencyCircleDollar,
        group: "manage",
      },
    );
  // Settings (account, device, program and system settings) is for every
  // signed-in user; each section inside checks its own permission.
  if (!ownerView)
    visible.push({
      path: "/settings",
      label: "Settings",
      icon: GearSix,
      group: "manage",
    });
  return visible;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
}

function roleLabel(s: Snapshot) {
  return s.user.isAdmin
    ? "Administrator"
    : isOwnerView(s)
      ? "Aircraft owner"
      : isPilotView(s)
        ? "Pilot"
        : "Team member";
}

const year = new Date().getFullYear();
const closedKey = "angelone-nav-closed";
function readClosed(): GroupKey[] {
  try {
    const saved = JSON.parse(localStorage.getItem(closedKey) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((k): k is GroupKey => groups.some((g) => g.key === k))
      : [];
  } catch {
    return [];
  }
}

function useCounts() {
  const s = useWorkspace((x) => x.snapshot)!;
  const queue = useWorkspace((x) => x.queue);
  const pending = queue.filter(
    (q) => q.operation.authorId === s.user.id,
  ).length;
  const unread = useUnreadAlertCount();
  return (path: string) =>
    path === "/sync" ? pending : path === "/alerts" ? unread : 0;
}

/** The active Flight Program selector (same behaviour as before: disabled
 * while offline, switches through the backend). */
function ProgramSwitcher({ tone }: { tone: "navy" | "surface" }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const online = useWorkspace((x) => x.online);
  const connected = useWorkspace((x) => x.connected);
  return (
    <label className={"program-switcher " + tone}>
      <Buildings size={20} weight="duotone" aria-hidden="true" />
      <span className="program-switcher-text">
        <span className="program-switcher-label" aria-hidden="true">
          FLIGHT PROGRAM
        </span>
        <select
          aria-label="Active Flight Program"
          value={s.activeProgramUuid ?? ""}
          disabled={!online || !connected}
          onChange={async (e) => {
            try {
              await useWorkspace
                .getState()
                .backend!.selectProgram(e.target.value);
            } catch (error) {
              useWorkspace.setState({
                error: errorText(error, "Unable to switch Flight Program."),
              });
            }
          }}
        >
          {s.user.isAdmin && <option value="">Unassigned records</option>}
          {!s.user.isAdmin && !s.programs?.length && (
            <option value="">No Flight Program assigned</option>
          )}
          {s.programs?.map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.name}
            </option>
          ))}
        </select>
      </span>
      <CaretDown size={14} aria-hidden="true" className="program-caret" />
    </label>
  );
}

function NavLink({
  item,
  count,
  onNavigate,
  variant,
}: {
  item: NavItem;
  count?: number;
  onNavigate?: () => void;
  variant: "sidebar" | "rail" | "tile";
}) {
  const Icon = item.icon;
  const exact = item.path !== "/admin" && item.path !== "/costs";
  return (
    <Link
      to={item.path}
      activeOptions={{ exact }}
      activeProps={{ className: "active" }}
      onClick={onNavigate}
      aria-label={variant === "rail" ? item.label : undefined}
      title={variant === "rail" ? item.label : undefined}
    >
      {({ isActive }) => (
        <>
          <span className="nav-icon">
            <Icon
              size={variant === "rail" ? 22 : 19}
              weight={isActive && variant !== "tile" ? "duotone" : "regular"}
              aria-hidden="true"
            />
          </span>
          {variant !== "rail" && <span className="nav-text">{item.label}</span>}
          {variant === "sidebar" && !!count && (
            <span className="nav-count">{count > 99 ? "99+" : count}</span>
          )}
        </>
      )}
    </Link>
  );
}

function ProfileFooter({
  exit,
  variant,
}: {
  exit: () => void;
  variant: "sidebar" | "sheet";
}) {
  const s = useWorkspace((x) => x.snapshot)!;
  const ownerView = isOwnerView(s);
  return (
    <div className={"profile profile-" + variant}>
      <span className="avatar" aria-hidden="true">
        {initials(s.user.name)}
      </span>
      <div className="profile-text">
        <strong>{s.user.name}</strong>
        <small>{roleLabel(s)}</small>
        {!ownerView && variant === "sheet" && <MyCertifications />}
      </div>
      {variant === "sidebar" ? (
        <button className="icon-button" aria-label="Sign out" onClick={exit}>
          <SignOut size={20} aria-hidden="true" />
        </button>
      ) : (
        <button className="button small" onClick={exit}>
          <SignOut size={16} aria-hidden="true" /> Sign out
        </button>
      )}
      {/* The sheet lists Settings as the last Manage tile, right above. */}
      {!ownerView && variant === "sidebar" && (
        <div className="profile-links">
          <MyCertifications />
          <Link to="/settings" className="text-button">
            <GearSix size={15} aria-hidden="true" />
            Settings
          </Link>
        </div>
      )}
    </div>
  );
}

function Sidebar({ items, exit }: { items: NavItem[]; exit: () => void }) {
  const [closed, setClosed] = useState(readClosed);
  const count = useCounts();
  const toggle = (key: GroupKey) =>
    setClosed((current) => {
      const next = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
      try {
        localStorage.setItem(closedKey, JSON.stringify(next));
      } catch {
        // Collapsed groups are a convenience; ignore blocked storage.
      }
      return next;
    });
  return (
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="Angel One overview">
        <Wordmark variant="white" width={156} />
        <small>AIRCRAFT OPERATIONS</small>
      </Link>
      <ProgramSwitcher tone="navy" />
      <nav aria-label="Main">
        {groups.map((g) => {
          const groupItems = items.filter((i) => i.group === g.key);
          if (!groupItems.length) return null;
          const open = !closed.includes(g.key);
          const id = "nav-group-" + g.key;
          return (
            <div className={"nav-group" + (open ? "" : " closed")} key={g.key}>
              <button
                type="button"
                className="nav-group-toggle"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => toggle(g.key)}
              >
                <span>{g.label}</span>
                <CaretDown size={13} weight="bold" aria-hidden="true" />
              </button>
              <div className="nav-group-items" id={id} inert={!open}>
                <div>
                  {groupItems.map((item) => (
                    <NavLink
                      key={item.path}
                      item={item}
                      count={count(item.path)}
                      variant="sidebar"
                    />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>
      <ProfileFooter exit={exit} variant="sidebar" />
    </aside>
  );
}

function Rail({ items, onMore }: { items: NavItem[]; onMore: () => void }) {
  const railItems = railPaths
    .map((p) => items.find((i) => i.path === p))
    .filter((i): i is NavItem => !!i);
  return (
    <aside className="rail">
      <Link to="/" className="rail-brand" aria-label="Angel One overview">
        A
      </Link>
      <nav aria-label="Main">
        {railItems.map((item) => (
          <NavLink key={item.path} item={item} variant="rail" />
        ))}
      </nav>
      <button
        type="button"
        className="rail-more"
        aria-label="All sections"
        aria-haspopup="dialog"
        onClick={onMore}
      >
        <List size={24} aria-hidden="true" />
      </button>
    </aside>
  );
}

function TabBar({
  items,
  onMore,
  onLog,
}: {
  items: NavItem[];
  onMore: () => void;
  onLog?: () => void;
}) {
  const tab = (path: string) => items.find((i) => i.path === path);
  const link = (item: NavItem | undefined) =>
    item && (
      <Link
        key={item.path}
        to={item.path}
        activeOptions={{ exact: true }}
        activeProps={{ className: "active" }}
      >
        {({ isActive }) => {
          const Icon = item.icon;
          return (
            <>
              <span className="tab-icon">
                <Icon
                  size={22}
                  weight={isActive ? "duotone" : "regular"}
                  aria-hidden="true"
                />
              </span>
              <span>{item.label}</span>
            </>
          );
        }}
      </Link>
    );
  return (
    <nav className="tabbar" aria-label="Primary">
      {link(tab("/"))}
      {link(tab("/flights"))}
      {onLog && (
        <button type="button" className="tab-log" onClick={onLog}>
          <span className="tab-icon">
            <Plus size={24} weight="bold" aria-hidden="true" />
          </span>
          <span>Log flight</span>
        </button>
      )}
      {link(tab("/inspections"))}
      <button
        type="button"
        aria-haspopup="dialog"
        className="tab-more"
        onClick={onMore}
      >
        <span className="tab-icon">
          <List size={22} aria-hidden="true" />
        </span>
        <span>More</span>
      </button>
    </nav>
  );
}

function MoreSheet({
  items,
  onClose,
  exit,
}: {
  items: NavItem[];
  onClose: () => void;
  exit: () => void;
}) {
  const count = useCounts();
  return (
    <Dialog
      title="All sections"
      onClose={onClose}
      className="more-sheet"
      closeLabel="Close"
    >
      <ProgramSwitcher tone="surface" />
      {groups.map((g) => {
        const groupItems = items.filter((i) => i.group === g.key);
        if (!groupItems.length) return null;
        return (
          <section className="sheet-group" key={g.key}>
            <h3>{g.label}</h3>
            <nav aria-label={g.label}>
              {groupItems.map((item) => (
                <NavLink
                  key={item.path}
                  item={item}
                  count={count(item.path)}
                  variant="tile"
                  onNavigate={onClose}
                />
              ))}
            </nav>
          </section>
        );
      })}
      <ProfileFooter exit={exit} variant="sheet" />
    </Dialog>
  );
}

function ThemeToggle({ className = "icon-button" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className={className}
      aria-label={
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      onClick={toggle}
    >
      {theme === "dark" ? (
        <Sun size={22} aria-hidden="true" />
      ) : (
        <Moon size={22} aria-hidden="true" />
      )}
    </button>
  );
}
export { ThemeToggle };

function TopBar({ items, phone }: { items: NavItem[]; phone: boolean }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const { queue, online, connected, demo } = useWorkspace();
  const ownerView = isOwnerView(s);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const pending = queue.filter(
    (q) => q.operation.authorId === s.user.id,
  ).length;
  const live = online && connected;
  const title =
    items.find((i) => i.path === pathname)?.label ??
    extraTitles.find(([re]) => re.test(pathname))?.[1] ??
    (pathname === "/alerts" ? "Alerts" : "Overview");
  return (
    <header className="topbar">
      <div className="topbar-title">
        {phone ? (
          <Link to="/" aria-label="Angel One overview">
            <Wordmark height={24} />
          </Link>
        ) : (
          <span>{title}</span>
        )}
      </div>
      <div className="topbar-status">
        {demo && <Badge>LOCAL DEMO</Badge>}
        {demo && !ownerView && (
          <button
            className="button small owner-preview-button"
            onClick={() =>
              previewDemoOwner(true).catch((e) =>
                useWorkspace.setState({
                  error: errorText(e, "Unable to preview the owner portal."),
                }),
              )
            }
          >
            Preview owner portal
          </button>
        )}
        <span className={"connection " + (live ? "" : "offline")}>
          <span className="connection-dot" aria-hidden="true" />
          <span className="connection-label">
            {live ? "Connected" : "Offline"}
            {pending > 0 && ` · ${pending} pending`}
          </span>
        </span>
        {!ownerView && <AlertBell />}
        <ThemeToggle />
      </div>
    </header>
  );
}

export function AppShell({
  exit,
  children,
}: {
  exit: () => void;
  children: ReactNode;
}) {
  const s = useWorkspace((x) => x.snapshot)!;
  const items = useNavigation();
  const breakpoint = useBreakpoint();
  const [more, setMore] = useState(false);
  // The sheet only exists below the desktop breakpoint. Close it when the
  // window grows past it (e.g. a tablet rotating), rather than only hiding
  // it, so it does not reopen by itself when the window narrows again.
  if (more && breakpoint === "desktop") setMore(false);
  const [logging, setLogging] = useState(false);
  // The bottom tab bar's "Log flight" opens the same flight form as the
  // overview's "Log a flight" button, under the same permission.
  const canLog =
    !isOwnerView(s) && s.aircraft.some((a) => can(s, a.uuid, "flight"));
  return (
    <div className={"app-layout " + breakpoint}>
      {breakpoint === "desktop" && <Sidebar items={items} exit={exit} />}
      {breakpoint === "tablet" && (
        <Rail items={items} onMore={() => setMore(true)} />
      )}
      <div className="main-area">
        <TopBar items={items} phone={breakpoint === "phone"} />
        {children}
        <footer className="app-footer">
          <span>
            ANGEL ONE <span className="footer-dot">·</span>{" "}
            <em>To every nation, kindred, tongue and people.</em>
          </span>
          <span>{year} · Aircraft operations</span>
        </footer>
      </div>
      {breakpoint === "phone" && (
        <TabBar
          items={items}
          onMore={() => setMore(true)}
          onLog={canLog ? () => setLogging(true) : undefined}
        />
      )}
      {more && breakpoint !== "desktop" && (
        <MoreSheet items={items} onClose={() => setMore(false)} exit={exit} />
      )}
      {logging && (
        <Modal title="Log a flight" onClose={() => setLogging(false)}>
          <FlightForm
            onDone={() => setLogging(false)}
            onCancel={() => setLogging(false)}
          />
        </Modal>
      )}
    </div>
  );
}

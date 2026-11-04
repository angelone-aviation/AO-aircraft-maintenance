/**
 * Responsibility: The application shell: grouped sidebar (≥1100px), icon rail
 *   (760–1099px), phone top bar and bottom tab bar (<760px), the "All
 *   sections" sheet, the top bar and the footer.
 * Layer: UI. React components around the routed screens.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (pilotView, ownerView, programs, model),
 *   ./Alerts, ./UserProfile, ./ComponentIcon, ./InspectionIcon,
 *   ./WorkOrderIcon, ./FlightForm, ./ui, ./design.
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
type WorkspaceLink = NavItem & { adminOnly?: boolean };

const NAV_GROUPS: { key: GroupKey; label: string }[] = [
  { key: "fly", label: "Fly" },
  { key: "maintain", label: "Maintain" },
  { key: "manage", label: "Manage" },
];
const RAIL_PATHS = [
  "/",
  "/flights",
  "/discrepancies",
  "/inspections",
  "/work-orders",
  "/inventory",
  "/admin",
];
// Screens reached from inside other screens, for the top-bar title.
const EXTRA_TITLES: [RegExp, string][] = [
  [/^\/manuals\//, "Reference library"],
  [/^\/inspection-templates/, "Inspection templates"],
  [/^\/task-cards/, "Job cards"],
  [/^\/components\//, "Components"],
];
// Workspace links in group order; the owner and pilot views filter them.
const WORKSPACE_LINKS: WorkspaceLink[] = [
  { path: "/", label: "Overview", icon: SquaresFour, group: "fly" },
  {
    path: "/flight-plans",
    label: "Flight plans",
    icon: AirplaneTakeoff,
    group: "fly",
  },
  { path: "/checklists", label: "Checklists", icon: ListChecks, group: "fly" },
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
  {
    path: "/inventory",
    label: "Inventory",
    icon: Stack,
    group: "maintain",
    adminOnly: true,
  },
  {
    path: "/programs",
    label: "Flight Programs",
    icon: Buildings,
    group: "manage",
  },
  { path: "/aircraft", label: "Aircraft", icon: Airplane, group: "manage" },
  {
    path: "/purchase-orders",
    label: "Purchase orders",
    icon: Receipt,
    group: "manage",
    adminOnly: true,
  },
  {
    path: "/vendors",
    label: "Vendors",
    icon: Storefront,
    group: "manage",
    adminOnly: true,
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
// Management links keep their own rule: shown to program administrators.
const ADMIN_LINKS: NavItem[] = [
  { path: "/admin", label: "Administration", icon: Users, group: "manage" },
  {
    path: "/costs",
    label: "Costs",
    icon: CurrencyCircleDollar,
    group: "manage",
  },
];
// Settings (account, device, program and system settings) is for every
// signed-in user; each section inside checks its own permission.
const SETTINGS_LINK: NavItem = {
  path: "/settings",
  label: "Settings",
  icon: GearSix,
  group: "manage",
};
const CLOSED_GROUPS_KEY = "angelone-nav-closed";
/** Sidebar counts above this show as "99+". */
const MAX_NAV_COUNT = 99;
const FOOTER_YEAR = new Date().getFullYear();

function useNavigation() {
  const s = useWorkspace((x) => x.snapshot)!;
  const pilotView = isPilotView(s);
  const ownerView = isOwnerView(s);
  const admin = programPermission(s, "admin");
  const visible: NavItem[] = WORKSPACE_LINKS.filter(
    (link) => admin || !link.adminOnly,
  ).filter((item) =>
    ownerView
      ? item.path === "/"
      : !pilotView || pilotNavigation.has(item.path),
  );
  if (admin) visible.push(...ADMIN_LINKS);
  if (!ownerView) visible.push(SETTINGS_LINK);
  return visible;
}

/**
 * The sun or moon button that switches between the light and dark themes.
 *
 * @param props.className - Defaults to "icon-button".
 * @returns The button, named for the theme it switches to.
 */
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

/**
 * The shell around the routed screens, laid out by breakpoint: the grouped
 * sidebar on desktops, an icon rail on tablets, and a tab bar on phones, with
 * the "All sections" sheet below desktop width.
 *
 * @param props.exit - Signs out, from the profile footer.
 * @param props.children - The current screen.
 * @returns The layout. Pilots see only pilot navigation and owners only the
 *   overview; program administrators also get inventory and purchasing,
 *   Administration and Costs; Settings ends the list for everyone but owners,
 *   who keep their portal. Phones offer Log flight to anyone who may log one.
 */
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
  const [more, setMore] = useMoreSheet(breakpoint);
  const [logging, setLogging] = useState(false);
  const canLog = canLogFlight(s);
  return (
    <div className={"app-layout " + breakpoint}>
      {breakpoint === "desktop" && <Sidebar items={items} exit={exit} />}
      {breakpoint === "tablet" && (
        <Rail items={items} onMore={() => setMore(true)} />
      )}
      <div className="main-area">
        <TopBar items={items} phone={breakpoint === "phone"} />
        {children}
        <AppFooter />
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
      {logging && <LogFlightModal onClose={() => setLogging(false)} />}
    </div>
  );
}

// The sheet only exists below the desktop breakpoint. Close it when the
// window grows past it (e.g. a tablet rotating), rather than only hiding it,
// so it does not reopen by itself when the window narrows again.
function useMoreSheet(breakpoint: string) {
  const [more, setMore] = useState(false);
  if (more && breakpoint === "desktop") setMore(false);
  return [more, setMore] as const;
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

// Closed sidebar groups stay closed on this device.
function useClosedGroups() {
  const [closed, setClosed] = useState(readClosed);
  const toggle = (key: GroupKey) =>
    setClosed((current) => {
      const next = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
      try {
        localStorage.setItem(CLOSED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // Collapsed groups are a convenience; ignore blocked storage.
      }
      return next;
    });
  return { closed, toggle };
}

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
          onChange={(e) => switchProgram(e.target.value)}
        >
          <ProgramOptions s={s} />
        </select>
      </span>
      <CaretDown size={14} aria-hidden="true" className="program-caret" />
    </label>
  );
}

function ProgramOptions({ s }: { s: Snapshot }) {
  return (
    <>
      {s.user.isAdmin && <option value="">Unassigned records</option>}
      {!s.user.isAdmin && !s.programs?.length && (
        <option value="">No Flight Program assigned</option>
      )}
      {s.programs?.map((p) => (
        <option key={p.uuid} value={p.uuid}>
          {p.name}
        </option>
      ))}
    </>
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
  // Administration and Costs stay highlighted on their sub-pages.
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
        <NavLinkBody
          item={item}
          count={count}
          variant={variant}
          isActive={isActive}
        />
      )}
    </Link>
  );
}

function NavLinkBody(props: {
  item: NavItem;
  count?: number;
  variant: "sidebar" | "rail" | "tile";
  isActive: boolean;
}) {
  const { item, count, variant } = props;
  const Icon = item.icon;
  return (
    <>
      <span className="nav-icon">
        <Icon
          size={variant === "rail" ? 22 : 19}
          weight={props.isActive && variant !== "tile" ? "duotone" : "regular"}
          aria-hidden="true"
        />
      </span>
      {variant !== "rail" && <span className="nav-text">{item.label}</span>}
      {variant === "sidebar" && !!count && (
        <span className="nav-count">
          {count > MAX_NAV_COUNT ? `${MAX_NAV_COUNT}+` : count}
        </span>
      )}
    </>
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
      <SignOutButton exit={exit} variant={variant} />
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

function SignOutButton(props: {
  exit: () => void;
  variant: "sidebar" | "sheet";
}) {
  if (props.variant === "sidebar")
    return (
      <button
        className="icon-button"
        aria-label="Sign out"
        onClick={props.exit}
      >
        <SignOut size={20} aria-hidden="true" />
      </button>
    );
  return (
    <button className="button small" onClick={props.exit}>
      <SignOut size={16} aria-hidden="true" /> Sign out
    </button>
  );
}

function Sidebar({ items, exit }: { items: NavItem[]; exit: () => void }) {
  const { closed, toggle } = useClosedGroups();
  const count = useCounts();
  return (
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="Angel One overview">
        <Wordmark variant="white" width={156} />
        <small>AIRCRAFT OPERATIONS</small>
      </Link>
      <ProgramSwitcher tone="navy" />
      <nav aria-label="Main">
        {NAV_GROUPS.map((g) => (
          <SidebarGroup
            key={g.key}
            group={g}
            items={items.filter((i) => i.group === g.key)}
            open={!closed.includes(g.key)}
            count={count}
            onToggle={() => toggle(g.key)}
          />
        ))}
      </nav>
      <ProfileFooter exit={exit} variant="sidebar" />
    </aside>
  );
}

function SidebarGroup(props: {
  group: (typeof NAV_GROUPS)[number];
  items: NavItem[];
  open: boolean;
  count: (path: string) => number;
  onToggle: () => void;
}) {
  const { group: g, open } = props;
  if (!props.items.length) return null;
  const id = "nav-group-" + g.key;
  return (
    <div className={"nav-group" + (open ? "" : " closed")}>
      <button
        type="button"
        className="nav-group-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={props.onToggle}
      >
        <span>{g.label}</span>
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>
      <div className="nav-group-items" id={id} inert={!open}>
        <div>
          {props.items.map((item) => (
            <NavLink
              key={item.path}
              item={item}
              count={props.count(item.path)}
              variant="sidebar"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Rail({ items, onMore }: { items: NavItem[]; onMore: () => void }) {
  const railItems = RAIL_PATHS.map((p) =>
    items.find((i) => i.path === p),
  ).filter((i): i is NavItem => !!i);
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
  return (
    <nav className="tabbar" aria-label="Primary">
      <TabLink item={tab("/")} />
      <TabLink item={tab("/flights")} />
      {onLog && (
        <button type="button" className="tab-log" onClick={onLog}>
          <span className="tab-icon">
            <Plus size={24} weight="bold" aria-hidden="true" />
          </span>
          <span>Log flight</span>
        </button>
      )}
      <TabLink item={tab("/inspections")} />
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

function TabLink({ item }: { item: NavItem | undefined }) {
  if (!item) return null;
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      activeOptions={{ exact: true }}
      activeProps={{ className: "active" }}
    >
      {({ isActive }) => (
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
      )}
    </Link>
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
      {NAV_GROUPS.map((g) => (
        <SheetGroup
          key={g.key}
          group={g}
          items={items.filter((i) => i.group === g.key)}
          count={count}
          onNavigate={onClose}
        />
      ))}
      <ProfileFooter exit={exit} variant="sheet" />
    </Dialog>
  );
}

function SheetGroup(props: {
  group: (typeof NAV_GROUPS)[number];
  items: NavItem[];
  count: (path: string) => number;
  onNavigate: () => void;
}) {
  if (!props.items.length) return null;
  const { label } = props.group;
  return (
    <section className="sheet-group">
      <h3>{label}</h3>
      <nav aria-label={label}>
        {props.items.map((item) => (
          <NavLink
            key={item.path}
            item={item}
            count={props.count(item.path)}
            variant="tile"
            onNavigate={props.onNavigate}
          />
        ))}
      </nav>
    </section>
  );
}

function TopBar({ items, phone }: { items: NavItem[]; phone: boolean }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const { demo } = useWorkspace();
  const ownerView = isOwnerView(s);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <header className="topbar">
      <div className="topbar-title">
        {phone ? (
          <Link to="/" aria-label="Angel One overview">
            <Wordmark height={24} />
          </Link>
        ) : (
          <span>{topBarTitle(items, pathname)}</span>
        )}
      </div>
      <div className="topbar-status">
        {demo && <Badge>LOCAL DEMO</Badge>}
        {demo && !ownerView && <OwnerPreviewButton />}
        <ConnectionStatus s={s} />
        {!ownerView && <AlertBell />}
        <ThemeToggle />
      </div>
    </header>
  );
}

function OwnerPreviewButton() {
  return (
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
  );
}

function ConnectionStatus({ s }: { s: Snapshot }) {
  const { queue, online, connected } = useWorkspace();
  const pending = queue.filter(
    (q) => q.operation.authorId === s.user.id,
  ).length;
  const live = online && connected;
  return (
    <span className={"connection " + (live ? "" : "offline")}>
      <span className="connection-dot" aria-hidden="true" />
      <span className="connection-label">
        {live ? "Connected" : "Offline"}
        {pending > 0 && ` · ${pending} pending`}
      </span>
    </span>
  );
}

function AppFooter() {
  return (
    <footer className="app-footer">
      <span>
        ANGEL ONE <span className="footer-dot">·</span>{" "}
        <em>To every nation, kindred, tongue and people.</em>
      </span>
      <span>{FOOTER_YEAR} · Aircraft operations</span>
    </footer>
  );
}

function LogFlightModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Log a flight" onClose={onClose}>
      <FlightForm onDone={onClose} onCancel={onClose} />
    </Modal>
  );
}

// The bottom tab bar's "Log flight" opens the same flight form as the
// overview's "Log a flight" button, under the same permission.
function canLogFlight(s: Snapshot) {
  return !isOwnerView(s) && s.aircraft.some((a) => can(s, a.uuid, "flight"));
}

function topBarTitle(items: NavItem[], pathname: string) {
  return (
    items.find((i) => i.path === pathname)?.label ??
    EXTRA_TITLES.find(([re]) => re.test(pathname))?.[1] ??
    (pathname === "/alerts" ? "Alerts" : "Overview")
  );
}

async function switchProgram(programUuid: string) {
  try {
    await useWorkspace.getState().backend!.selectProgram(programUuid);
  } catch (error) {
    // Shown in the app's error banner; the selector keeps the active program.
    useWorkspace.setState({
      error: errorText(error, "Unable to switch Flight Program."),
    });
  }
}

function readClosed(): GroupKey[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_GROUPS_KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((k): k is GroupKey => NAV_GROUPS.some((g) => g.key === k))
      : [];
  } catch {
    // Blocked storage or an unreadable value: every group starts open.
    return [];
  }
}

function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
}

function roleLabel(s: Snapshot) {
  if (s.user.isAdmin) return "Administrator";
  if (isOwnerView(s)) return "Aircraft owner";
  return isPilotView(s) ? "Pilot" : "Team member";
}

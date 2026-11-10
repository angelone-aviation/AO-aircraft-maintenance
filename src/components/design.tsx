/**
 * Responsibility: The design system's shared building blocks: layout, status
 *   and data display, controls, dialogs, brand images, breakpoint and theme.
 * Layer: UI. Presentational React components and hooks; no workspace data.
 * Dependencies: react, @phosphor-icons/react, src/styles/design.css.
 *
 * Screens build from these and from the global primitives in src/styles.css
 * (.button, .panel, .field, tables), styled by the tokens in
 * src/styles/tokens.css; restyling either per screen breaks the shared look.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { MagnifyingGlass, X, type IconWeight } from "@phosphor-icons/react";
import "../styles/design.css";

const DESKTOP_QUERY = "(min-width: 1100px)";
const PHONE_QUERY = "(max-width: 759px)";
const THEME_KEY = "angelone-theme";
const INLINE_ICON_SIZE = 18;
const TILE_ICON_SIZES = { lg: 22, md: 20, sm: 18 } as const;
const WORDMARK_SRC = {
  navy: "/branding/angelone.png",
  white: "/branding/angelone-white.png",
} as const;
const WORDMARK_WIDTH = 156;

/**
 * A Phosphor icon component, passed as `Airplane`, not `<Airplane />`.
 * Weights: regular by default, duotone in KPI and list tiles (set here),
 * bold inside primary buttons, fill for a selected favourite star.
 */
export type IconType = ComponentType<{
  size?: number | string;
  weight?: IconWeight;
  "aria-hidden"?: boolean | "true" | "false";
}>;
/**
 * A colour role. Aircraft status maps airworthy to good, due soon to warn,
 * grounded to danger and scheduled to neutral.
 */
export type Tone = "good" | "warn" | "danger" | "neutral" | "blue";
// Badge's "warning" tone means "warn", so Badge tones pass straight through.
type ToneInput = Tone | "warning";
type DialogProps = {
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  size?: "default" | "narrow" | "wide" | "full";
  dismissOnScrim?: boolean;
  /** False when the dialog asks before discarding by itself. */
  confirmDiscard?: boolean;
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
};
const tone = (t: ToneInput | undefined, fallback: Tone = "neutral"): Tone =>
  t === "warning" ? "warn" : (t ?? fallback);
const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

/* ───────────────────────────── Hooks ───────────────────────────── */

/** A layout size: desktop from 1100px wide, phone below 760px. */
export type Breakpoint = "desktop" | "tablet" | "phone";

/**
 * The current layout size, updated as the window crosses a breakpoint.
 *
 * @returns "desktop" without a window or matchMedia (server rendering).
 */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(
    subscribeBreakpoint,
    readBreakpoint,
    () => "desktop",
  );
}

/** The colour theme; dark puts `.dark` on <html>. */
export type Theme = "light" | "dark";
const themeListeners = new Set<() => void>();
let currentTheme: Theme =
  typeof window === "undefined" ? "light" : storedTheme();

/**
 * Applies the saved theme, or else the system preference, to <html>. Call it
 * before the first render so the page does not flash the wrong theme.
 */
export function initTheme() {
  currentTheme = storedTheme();
  applyTheme(currentTheme);
}

/**
 * Switches the theme for every useTheme caller and saves it on the device
 * (localStorage "angelone-theme").
 *
 * @param theme - Applied at once; when storage is blocked it lasts this visit.
 */
export function setTheme(theme: Theme) {
  currentTheme = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not persisted when storage is unavailable; the choice lasts this visit.
  }
  themeListeners.forEach((l) => l());
}

/**
 * The current theme and ways to change it.
 *
 * @returns `theme` ("light" when server rendered), `toggle` between light
 *   and dark, and `setTheme`.
 */
export function useTheme() {
  const theme = useSyncExternalStore(
    (l) => {
      themeListeners.add(l);
      return () => themeListeners.delete(l);
    },
    () => currentTheme,
    () => "light" as Theme,
  );
  const toggle = useCallback(
    () => setTheme(currentTheme === "dark" ? "light" : "dark"),
    [],
  );
  return { theme, toggle, setTheme };
}

/* ───────────────────────────── Layout ──────────────────────────── */

/**
 * A page's heading block: eyebrow, h1, description, and actions on the right
 * that wrap on phones.
 *
 * @param props.accent - A second clause in blue inside the same h1: "Your
 *   fleet," and "at a glance." read "Your fleet, at a glance.".
 * @param props.hero - The dashboard-size heading.
 */
export function PageHeader({
  eyebrow,
  title,
  accent,
  description,
  actions,
  hero = false,
  className,
}: {
  eyebrow?: string;
  title: string;
  accent?: string;
  description?: ReactNode;
  actions?: ReactNode;
  hero?: boolean;
  className?: string;
}) {
  return (
    <header className={cx("ds-page-header", hero && "hero", className)}>
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>
          {title}
          {accent && (
            <>
              {" "}
              <span className="ds-accent">{accent}</span>
            </>
          )}
        </h1>
        {description && <p className="ds-page-description">{description}</p>}
      </div>
      {actions && <div className="ds-page-actions">{actions}</div>}
    </header>
  );
}

/** A filter row: children on the left, `end` on the right; both wrap. */
export function Toolbar({
  children,
  end,
  className,
}: {
  children?: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ds-toolbar", className)}>
      {children}
      {end && <div className="ds-toolbar-end">{end}</div>}
    </div>
  );
}

/**
 * A search input with a magnifier icon.
 *
 * @param props.label - Its accessible name, and the placeholder unless one is
 *   given.
 * @param props.onChange - Receives the typed text.
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cx("ds-search", className)}>
      <MagnifyingGlass size={INLINE_ICON_SIZE} aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/* ───────────────────────── Status / data ───────────────────────── */

/**
 * A status pill with a coloured dot.
 *
 * @param props.tone - Defaults to neutral.
 * @param props.dot - False leaves the dot out.
 */
export function StatusPill({
  tone: t,
  dot = true,
  children,
  className,
}: {
  tone?: ToneInput;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("ds-pill", "ds-tone-" + tone(t), className)}>
      {dot && <span className="ds-pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A rounded tinted tile holding an icon; decorative, so hidden from screen
 * readers.
 *
 * @param props.tone - Defaults to blue.
 * @param props.size - lg (the default), md or sm.
 * @param props.weight - Defaults to duotone.
 */
export function IconTile({
  icon: Icon,
  tone: t,
  size = "lg",
  weight = "duotone",
  className,
}: {
  icon: IconType;
  tone?: ToneInput;
  size?: "lg" | "md" | "sm";
  weight?: IconWeight;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "ds-icon-tile",
        size !== "lg" && size,
        "ds-tone-" + tone(t, "blue"),
        className,
      )}
      aria-hidden="true"
    >
      <Icon size={TILE_ICON_SIZES[size]} weight={weight} aria-hidden="true" />
    </span>
  );
}

/**
 * One bordered strip of KpiTiles: two by two, or `columns` across (default
 * 4) from 1100px wide.
 */
export function KpiStrip({
  columns = 4,
  children,
  className,
}: {
  columns?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("ds-kpi-strip", className)}
      style={{ "--kpi-cols": columns } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * A key figure: label, large tabular value, and an optional icon tile and
 * footnote.
 *
 * @param props.tone - The icon tile's tone; defaults to blue.
 * @param props.valueTone - Colours the value, such as warn for inspections
 *   coming due or danger for open discrepancies.
 */
export function KpiTile({
  label,
  value,
  icon,
  tone: t,
  valueTone,
  footnote,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: IconType;
  tone?: ToneInput;
  valueTone?: ToneInput;
  footnote?: ReactNode;
}) {
  return (
    <div className="ds-kpi-tile">
      <div className="ds-kpi-label">
        <span>{label}</span>
        {icon && <IconTile icon={icon} tone={t ?? "blue"} size="sm" />}
      </div>
      <strong
        className={cx(
          "ds-kpi-value",
          valueTone && "ds-tone-" + tone(valueTone),
        )}
      >
        {value}
      </strong>
      {footnote && <span className="ds-kpi-foot">{footnote}</span>}
    </div>
  );
}

/** A strip of StatTiles that fits as many across as there is room for. */
export function StatsStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("ds-stats-strip", className)}>{children}</div>;
}

/** A label over a value, inside a StatsStrip. */
export function StatTile({
  label,
  value,
}: {
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <div className="ds-stat-tile">
      <span className="ds-stat-label">{label}</span>
      <strong className="ds-stat-value">{value}</strong>
    </div>
  );
}

/**
 * A progress bar.
 *
 * @param props.value - From 0 to 1; clamped, and shown to a tenth of a
 *   percent.
 * @param props.marker - Draws a ring at the progress point.
 * @param props.label - Makes it a named progressbar from 0 to 100; without
 *   one it is decorative and hidden from screen readers.
 */
export function ProgressTrack({
  value,
  tone: t,
  marker = false,
  thin = false,
  label,
  className,
}: {
  value: number;
  tone?: ToneInput;
  marker?: boolean;
  thin?: boolean;
  label?: string;
  className?: string;
}) {
  const pct = progressPercent(value);
  return (
    <div
      className={cx(
        "ds-progress",
        thin && "thin",
        "ds-tone-" + tone(t, "blue"),
        className,
      )}
      {...progressRole(label, pct)}
    >
      <div className="ds-progress-fill" style={{ width: pct + "%" }} />
      {marker && (
        <span className="ds-progress-marker" style={{ left: pct + "%" }} />
      )}
    </div>
  );
}

/** A padded card of ListRows, with an optional h2 title. */
export function ListCard({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("ds-list-card", className)}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

/**
 * A list row: icon tile, title over a muted sub-line, then meta, badge and
 * action columns that stack on narrower screens.
 *
 * @param props.meta - Left out when undefined, null or "" (0 still shows).
 * @param props.onClick - Makes the whole row one button; pass no interactive
 *   `action` with it, since controls cannot nest.
 */
export function ListRow({
  onClick,
  className,
  ...content
}: RowContent & {
  onClick?: () => void;
  className?: string;
}) {
  return onClick ? (
    <button
      type="button"
      className={cx("ds-list-row", className)}
      onClick={onClick}
    >
      <ListRowContent {...content} />
    </button>
  ) : (
    <div className={cx("ds-list-row", className)}>
      <ListRowContent {...content} />
    </div>
  );
}

/** A dashed empty-state box: title, explanation and an optional action. */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ds-empty", className)}>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="ds-empty-action">{action}</div>}
    </div>
  );
}

/**
 * An inline notice, such as the amber "Local demo." bar.
 *
 * @param props.tone - Defaults to blue.
 * @param props.role - "status" or "alert" when it should be announced.
 */
export function NoticeBar({
  tone: t,
  icon: Icon,
  role,
  children,
  className,
}: {
  tone?: ToneInput;
  icon?: IconType;
  role?: "status" | "alert";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("ds-notice", "ds-tone-" + tone(t, "blue"), className)}
      role={role}
    >
      {Icon && (
        <span className="ds-notice-icon">
          <Icon size={INLINE_ICON_SIZE} weight="duotone" aria-hidden="true" />
        </span>
      )}
      <div className="ds-notice-body">{children}</div>
    </div>
  );
}

/* ─────────────────────────── Controls ──────────────────────────── */

/**
 * An on/off switch: a native checkbox with role="switch", found by its label
 * or as a switch.
 *
 * @param props.onChange - Receives the new checked state.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  name,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  return (
    <label className={cx("ds-switch", className)}>
      <input
        type="checkbox"
        role="switch"
        name={name}
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ds-switch-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

/** One choice in a Segmented control; a count shows after its label. */
export type SegmentedOption = {
  value: string;
  label: string;
  count?: number | string;
  icon?: IconType;
  disabled?: boolean;
};

/**
 * A pill track of buttons that picks one value.
 *
 * @param props.label - The group's accessible name.
 * @param props.mode - Marks the chosen button aria-pressed ("pressed", the
 *   default) or aria-current="page" ("current").
 * @returns The group. Each button is named by its label alone: counts are
 *   hidden from screen readers, and an empty count is left out.
 */
export function Segmented({
  label,
  options,
  value,
  onChange,
  mode = "pressed",
  className,
}: {
  label: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  mode?: "pressed" | "current";
  className?: string;
}) {
  return (
    <div
      className={cx("ds-segmented", className)}
      role="group"
      aria-label={label}
    >
      {options.map((o) => (
        <SegmentButton
          key={o.value}
          option={o}
          selected={o.value === value}
          mode={mode}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/**
 * A round icon button, such as a dialog's close button.
 *
 * @param props.label - Its accessible name.
 * @param props.icon - Defaults to X.
 * @param props.onNavy - Colours it for a navy background.
 */
export function RoundButton({
  label,
  onClick,
  icon: Icon = X,
  onNavy = false,
  className,
}: {
  label: string;
  onClick: () => void;
  icon?: IconType;
  onNavy?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cx("ds-round-button", onNavy && "on-navy", className)}
      aria-label={label}
      onClick={onClick}
    >
      <Icon size={INLINE_ICON_SIZE} aria-hidden="true" />
    </button>
  );
}

/* ─────────────────────────── Overlays ──────────────────────────── */

/**
 * A modal dialog on the native <dialog>, named by its title: focus stays
 * inside while it is open and returns to the opener when it closes. It is a
 * centred panel from 760px wide and a bottom sheet below.
 *
 * @param props.open - False renders nothing; defaults to true.
 * @param props.onClose - Called by Escape (the top-most dialog only), the
 *   close button and, unless `dismissOnScrim` is false, a click on the scrim.
 *   Once the user has typed or chosen anything in a form inside the dialog,
 *   Escape, the scrim and the browser's Back or Forward first ask
 *   "Discard what you have entered in this form?", and do nothing if the
 *   answer is no.
 * @param props.confirmDiscard - False for a dialog that asks by itself.
 * @param props.size - default (720px), narrow (560), wide (1100) or full
 *   (1480).
 * @param props.header - Replaces the title and close button; the title then
 *   names the dialog through aria-label.
 * @param props.footer - A sticky action row, such as Cancel and Save.
 */
export function Dialog({
  open = true,
  ...props
}: DialogProps & { open?: boolean }) {
  if (!open) return null;
  return <DialogInner {...props} />;
}

/** The Dialog frame without `open`: mount it only while it is shown. */
export const DialogFrame = DialogInner;
function DialogInner({
  size = "default",
  dismissOnScrim = true,
  confirmDiscard = true,
  closeLabel = "Close dialog",
  ...props
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const mayDiscard = useDiscardGuard(ref, confirmDiscard);
  const dismiss = useDismiss(props.onClose, dismissOnScrim, mayDiscard);
  const titleId = useId();
  const subtitleId = useId();
  useModal(ref);
  // The scrim click is a pointer convenience; Escape (onCancel) and the
  // close button are the keyboard paths.
  return (
    <dialog
      ref={ref}
      className={cx("ds-dialog", size !== "default" && size, props.className)}
      aria-modal="true"
      {...dialogNames(props, titleId, subtitleId)}
      onCancel={dismiss.onCancel}
      onPointerDown={dismiss.onPointerDown}
      onClick={dismiss.onClick}
    >
      <DialogPanel
        {...props}
        ids={[titleId, subtitleId]}
        closeLabel={closeLabel}
        onClose={dismiss.close}
      />
    </dialog>
  );
}

function DialogPanel({
  ids,
  closeLabel,
  onClose,
  ...props
}: DialogProps & { ids: [string, string]; closeLabel: string }) {
  return (
    <div className="ds-dialog-panel">
      {props.header ?? (
        <DialogHeader
          title={props.title}
          subtitle={props.subtitle}
          ids={ids}
          closeLabel={closeLabel}
          onClose={onClose}
        />
      )}
      <div className="ds-dialog-body">{props.children}</div>
      {props.footer && <div className="ds-dialog-footer">{props.footer}</div>}
    </div>
  );
}

/* ───────────────────────────── Brand ───────────────────────────── */

/**
 * The Angel One wordmark.
 *
 * @param props.variant - navy, white, or auto (the default): navy in the
 *   light theme and white in the dark one.
 * @param props.width - In pixels; 156 unless only a height is given.
 */
export function Wordmark({
  variant = "auto",
  className,
  ...size
}: WordmarkProps) {
  // Auto renders both images; CSS shows the one that suits the theme.
  const themed = (kind: "navy" | "white") => (
    <WordmarkImage
      key={kind}
      kind={kind}
      {...size}
      className={cx(
        "ds-wordmark",
        variant === "auto" && "auto",
        "ds-wordmark-" + kind,
        className,
      )}
    />
  );
  if (variant === "navy") return themed("navy");
  if (variant === "white")
    return (
      <WordmarkImage
        kind="white"
        {...size}
        className={cx("ds-wordmark", className)}
      />
    );
  return (
    <>
      {themed("navy")}
      {themed("white")}
    </>
  );
}

/**
 * The inverted aircraft line drawing for navy panels; decorative, and never
 * placed behind text.
 *
 * @param props.drift - Lets it drift slowly.
 */
export function AircraftArt({
  className,
  opacity = 0.34,
  drift = false,
}: {
  className?: string;
  opacity?: number;
  drift?: boolean;
}) {
  return (
    <img
      src="/branding/cessna-oblique.svg"
      alt=""
      aria-hidden="true"
      className={cx("ds-aircraft-art", drift && "drift", className)}
      style={{ "--art-opacity": opacity } as CSSProperties}
    />
  );
}

type WordmarkProps = {
  variant?: "auto" | "navy" | "white";
  width?: number;
  height?: number;
  className?: string;
};
type RowContent = {
  icon?: IconType;
  tone?: ToneInput;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
};

function readBreakpoint(): Breakpoint {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  return window.matchMedia(PHONE_QUERY).matches ? "phone" : "tablet";
}

function subscribeBreakpoint(notify: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const queries = [DESKTOP_QUERY, PHONE_QUERY].map((q) => window.matchMedia(q));
  queries.forEach((q) => q.addEventListener("change", notify));
  return () => queries.forEach((q) => q.removeEventListener("change", notify));
}

function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Storage blocked: fall through to the system preference.
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    // No matchMedia to ask: light.
    return "light";
  }
}

function applyTheme(theme: Theme) {
  if (typeof document !== "undefined")
    document.documentElement.classList.toggle("dark", theme === "dark");
}

// The fill's width in percent: clamped to 0–100 (NaN reads as 0) and rounded
// to one decimal place.
function progressPercent(value: number) {
  return Math.round(Math.min(1, Math.max(0, value || 0)) * 1000) / 10;
}

function progressRole(label: string | undefined, pct: number) {
  if (!label) return { "aria-hidden": true } as const;
  return {
    role: "progressbar",
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": pct,
  } as const;
}

function ListRowContent({
  icon,
  tone: t,
  title,
  sub,
  meta,
  badge,
  action,
}: RowContent) {
  return (
    <>
      <span className="ds-list-lead">
        {icon && <IconTile icon={icon} tone={t ?? "blue"} />}
        <span className="ds-list-text">
          <strong className="ds-list-title">{title}</strong>
          {sub && <span className="ds-list-sub">{sub}</span>}
        </span>
      </span>
      {meta !== undefined && meta !== null && meta !== "" && (
        <span className="ds-list-meta">{meta}</span>
      )}
      {badge && <span className="ds-list-badge">{badge}</span>}
      {action && <span className="ds-list-action">{action}</span>}
    </>
  );
}

function SegmentButton({
  option: o,
  selected,
  mode,
  onChange,
}: {
  option: SegmentedOption;
  selected: boolean;
  mode: "pressed" | "current";
  onChange: (value: string) => void;
}) {
  const Icon = o.icon;
  return (
    <button
      type="button"
      disabled={o.disabled}
      aria-pressed={mode === "pressed" ? selected : undefined}
      aria-current={mode === "current" && selected ? "page" : undefined}
      onClick={() => onChange(o.value)}
    >
      {Icon && (
        <Icon
          size={17}
          weight={selected ? "duotone" : "regular"}
          aria-hidden="true"
        />
      )}
      {o.label}
      {o.count !== undefined && o.count !== "" && (
        <span className="ds-seg-count" aria-hidden="true">
          {o.count}
        </span>
      )}
    </button>
  );
}

// Opens the dialog modally on mount; on unmount closes it and returns focus
// to the element that opened it.
function useModal(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = ref.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref]);
}

// The handlers read the latest onClose through a ref, so a new onClose never
// re-runs the effect that opened the dialog.
function useDismiss(
  onClose: () => void,
  dismissOnScrim: boolean,
  mayDiscard: () => boolean,
) {
  const onCloseRef = useRef(onClose);
  const pressStartedOnScrim = useRef(false);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  return {
    close: () => onCloseRef.current(),
    onCancel: (e: SyntheticEvent<HTMLDialogElement>) => {
      // React passes a nested dialog's cancel (Escape) up the component
      // tree, through portals, to every dialog that renders it. Only the
      // dialog the browser cancelled closes; its parents keep their forms.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      if (mayDiscard()) onCloseRef.current();
    },
    onPointerDown: (e: PointerEvent<HTMLDialogElement>) => {
      pressStartedOnScrim.current = e.target === e.currentTarget;
    },
    // Only a press that began on the scrim closes, so a drag that starts in
    // the panel and ends outside it leaves the dialog open.
    onClick: (e: MouseEvent<HTMLDialogElement>) => {
      const own = pressStartedOnScrim.current && e.target === e.currentTarget;
      if (dismissOnScrim && own && mayDiscard()) onCloseRef.current();
      pressStartedOnScrim.current = false;
    },
  };
}

const DISCARD_QUESTION = "Discard what you have entered in this form?";
const HISTORY_MOVES: readonly string[] = ["BACK", "FORWARD", "GO"];

/** The part of the router's history a dialog uses to hold up Back. */
export interface DialogHistory {
  block(blocker: {
    blockerFn: (move: { action: string }) => boolean;
    enableBeforeUnload: boolean;
  }): () => void;
}

let dialogHistory: DialogHistory | undefined;

/**
 * Gives dialogs the app's browser history, so a dialog holding unsaved input
 * can ask before Back or Forward discards it. The app calls it once, when it
 * creates its router; without it, dialogs guard Escape and the scrim only.
 *
 * @param history - The router's history.
 */
export function setDialogHistory(history: DialogHistory) {
  dialogHistory = history;
}

// Whether the dialog may close without losing the user's input: true until
// they type or choose something in one of its forms, then only once they
// confirm. A real input event is the test, because forms also set values
// themselves after opening. The history asks it before Back or Forward, the
// phone's usual way to close a sheet; the app's own navigation after a save
// is never held up.
function useDiscardGuard(
  ref: RefObject<HTMLDialogElement | null>,
  enabled: boolean,
) {
  const touched = useRef(false);
  const mayDiscard = useCallback(
    () => !enabled || !touched.current || window.confirm(DISCARD_QUESTION),
    [enabled],
  );
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !enabled) return;
    const mark = (e: Event) => {
      if (e.isTrusted && isEntryField(e.target)) touched.current = true;
    };
    dialog.addEventListener("input", mark);
    return () => dialog.removeEventListener("input", mark);
  }, [ref, enabled]);
  useEffect(() => {
    if (!dialogHistory || !enabled) return;
    return dialogHistory.block({
      enableBeforeUnload: false,
      blockerFn: ({ action }) =>
        HISTORY_MOVES.includes(action) && !mayDiscard(),
    });
  }, [enabled, mayDiscard]);
  return mayDiscard;
}

// A field of a form, where entries live; a search box only filters.
function isEntryField(target: EventTarget | null) {
  if (target instanceof HTMLInputElement)
    return !!target.form && target.type !== "search";
  return (
    (target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement) &&
    !!target.form
  );
}

// A custom header has no h2 to point at, so the title names the dialog.
function dialogNames(
  { header, title, subtitle }: DialogProps,
  titleId: string,
  subtitleId: string,
) {
  return {
    "aria-labelledby": header ? undefined : titleId,
    "aria-label": header ? title : undefined,
    "aria-describedby": !header && subtitle ? subtitleId : undefined,
  };
}

function DialogHeader(props: {
  title: string;
  subtitle?: ReactNode;
  ids: [title: string, subtitle: string];
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="ds-dialog-header">
      <div>
        <h2 id={props.ids[0]}>{props.title}</h2>
        {props.subtitle && <p id={props.ids[1]}>{props.subtitle}</p>}
      </div>
      <RoundButton label={props.closeLabel} onClick={props.onClose} />
    </div>
  );
}

function WordmarkImage(
  props: Pick<WordmarkProps, "width" | "height"> & {
    kind: "navy" | "white";
    className: string;
  },
) {
  const { width, height } = props;
  return (
    <img
      src={WORDMARK_SRC[props.kind]}
      alt="Angel One"
      className={props.className}
      style={{
        width: width ?? (height ? "auto" : WORDMARK_WIDTH),
        height: height ?? "auto",
      }}
      width={width}
      height={height}
    />
  );
}

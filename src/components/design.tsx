/**
 * Angel One design system — shared building blocks (UI redesign v2).
 *
 * THIS COMMENT IS THE CONTRACT for screen work. Tokens live in
 * src/styles/tokens.css (imported once by main.tsx); component styles live in
 * src/styles/design.css (imported here). Icons: import from
 * "@phosphor-icons/react" (e.g. `import { Airplane } from "@phosphor-icons/react"`)
 * and pass the component itself (not an element) wherever a prop is typed
 * `IconType`. Weights: regular by default, "duotone" for KPI / list leading
 * icons (the components below apply it), "bold" inside primary buttons,
 * "fill" for a selected favourite star.
 *
 * Tones: `Tone = "good" | "warn" | "danger" | "neutral" | "blue"`; "warning"
 * is accepted as an alias of "warn" so existing Badge tones map directly.
 * Status mapping: airworthy → good, due soon → warn, grounded → danger,
 * scheduled → neutral.
 *
 * ── Layout ──────────────────────────────────────────────────────────────
 * <PageHeader eyebrow title accent? description? actions? hero? className?>
 *   eyebrow: string (rendered uppercase, --blue), title: string,
 *   accent?: string — second clause rendered in --blue weight 300 inside the
 *   same <h1> ("Your fleet," + "at a glance." → accessible name
 *   "Your fleet, at a glance."), description?: ReactNode, actions?: ReactNode
 *   (buttons, right-aligned, wrap on phones), hero?: boolean — dashboard-size h1.
 * <Toolbar end?> children left, `end` right (wraps). For filter rows.
 * <SearchField label value onChange placeholder?> 42px search input with
 *   magnifying-glass icon; label is the accessible name (aria-label).
 *
 * ── Status / data display ───────────────────────────────────────────────
 * <StatusPill tone dot?=true> label — 12.5px/600 pill with a 6px dot.
 * <IconTile icon tone?="blue" size?="lg"|"md"|"sm" weight?="duotone">
 *   44/40/34px rounded tile with a tinted background and the icon.
 * <KpiStrip columns?=4> one bordered container of <KpiTile>s (4-up ≥1100px,
 *   2×2 below). <KpiTile label value icon? tone?="blue" valueTone? footnote?>
 *   value: ReactNode (42px tabular); valueTone colours the number
 *   (e.g. "warn" for inspections approaching, "danger" for open discrepancies).
 * <StatsStrip> container of <StatTile label value> (30px values, auto-fit).
 * <ProgressTrack value tone?="blue" marker? thin? label?>
 *   value 0–1; marker draws the 14px ring at the progress point; label →
 *   aria-label (role="progressbar" when given, otherwise decorative).
 * <ListCard title? className? children> padded surface card holding ListRows
 *   (hairline between rows, none above the first). title renders an <h2>.
 * <ListRow icon? tone? title sub? meta? badge? action? onClick? className?>
 *   44px duotone icon tile, title (16.5px/600) + sub (14px muted), both
 *   ellipsised; meta (15px tabular), badge (usually a StatusPill), action
 *   (usually buttons). Grid 1fr auto auto auto (desktop) → 1fr auto (tablet)
 *   → 1fr (phone). onClick renders the whole row as a <button>; do NOT pass an
 *   interactive `action` together with onClick (no nested controls).
 * <EmptyState title children? action?> dashed empty box.
 * <NoticeBar tone?="blue" icon? children> inline notice (e.g. the amber
 *   "Local demo." bar). Pass role="status"/"alert" via `role` if it announces.
 *   Links inside it are underlined in --blue-on-soft.
 *
 * ── Controls ────────────────────────────────────────────────────────────
 * <Switch checked onChange(checked) label disabled? name? className?>
 *   Native checkbox with role="switch" (aria-checked follows `checked`), so
 *   Playwright getByLabel(label).check() and getByRole("switch") both work.
 * <Segmented label options value onChange mode?="pressed">
 *   options: { value: string; label: string; count?: number|string;
 *   icon?: IconType; disabled?: boolean }[]. Pill track of <button>s; the
 *   selected one gets aria-pressed="true" (mode "pressed") or
 *   aria-current="page" (mode "current"). Button accessible name is the label
 *   only (count is aria-hidden), so getByRole("button", { name }) keeps working.
 * <RoundButton label onClick icon? onNavy?> 40px round icon button
 *   (dialog/sheet close). label → aria-label.
 *
 * ── Overlays ────────────────────────────────────────────────────────────
 * <Dialog open?=true onClose title subtitle? footer? size? header?
 *         dismissOnScrim?=true closeLabel?="Close dialog" className? children>
 *   Native <dialog> opened with showModal(): role=dialog + aria-modal, focus
 *   trapped by the browser, Escape closes (only the top-most of nested
 *   dialogs), a click on the scrim closes
 *   (dismissOnScrim), focus returns to the opener on close. Centred modal
 *   ≥760px (`pop`), bottom sheet with grab handle <760px (`sheet`).
 *   size: "default" (720px) | "narrow" (560) | "wide" (1100) | "full" (1480).
 *   header: replaces the standard header (e.g. a navy hero header); the title
 *   is then used as aria-label. footer: sticky action row (Cancel / Save).
 *   Accessible name = title, so getByRole("dialog", { name: title }) works.
 *
 * ── Brand ───────────────────────────────────────────────────────────────
 * <Wordmark variant?="auto"|"navy"|"white" width? height? className?>
 *   "auto" shows the navy wordmark in light and the white one in dark.
 * <AircraftArt className? opacity?=0.34 drift?> the inverted line drawing
 *   (public/branding/cessna-oblique.svg) for navy panels; decorative only,
 *   never behind text.
 *
 * ── Hooks ───────────────────────────────────────────────────────────────
 * useBreakpoint(): "desktop" (≥1100) | "tablet" (760–1099) | "phone" (<760).
 * useTheme(): { theme: "light"|"dark", toggle(), setTheme(t) } — persisted in
 *   localStorage["angelone-theme"]; applies `.dark` on <html>.
 *
 * ── Global CSS primitives (restyled in src/styles.css; use, don't restyle) ─
 * .button (outline, 46px) · .button.primary (blue fill, white text; put a
 * bold Phosphor icon first) · .button.soft (blue-soft fill) · .button.small
 * (40px) · .button.danger · .icon-button (44px square) · .text-button ·
 * .panel (surface card, 14px radius) · .badge.{neutral,good,warning,danger}
 * (pills; prefer StatusPill in new markup) · .field / .form-grid (labels 14px
 * muted, inputs 48px on --bg) · .table-scroll + table (uppercase 12px headers,
 * hairline rows) · .tabs (now a segmented pill track) · .notice / .callout /
 * .error · .eyebrow · .muted · .rise (entrance; style={{"--i": n}} staggers).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { MagnifyingGlass, X, type IconWeight } from "@phosphor-icons/react";
import "../styles/design.css";

export type IconType = ComponentType<{
  size?: number | string;
  weight?: IconWeight;
  "aria-hidden"?: boolean | "true" | "false";
}>;
export type Tone = "good" | "warn" | "danger" | "neutral" | "blue";
type ToneInput = Tone | "warning";
const tone = (t: ToneInput | undefined, fallback: Tone = "neutral"): Tone =>
  t === "warning" ? "warn" : (t ?? fallback);
const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

/* ───────────────────────────── Hooks ───────────────────────────── */

export type Breakpoint = "desktop" | "tablet" | "phone";
const desktopQuery = "(min-width: 1100px)";
const phoneQuery = "(max-width: 759px)";
function readBreakpoint(): Breakpoint {
  if (typeof window === "undefined" || !window.matchMedia) return "desktop";
  if (window.matchMedia(desktopQuery).matches) return "desktop";
  return window.matchMedia(phoneQuery).matches ? "phone" : "tablet";
}
function subscribeBreakpoint(notify: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const queries = [desktopQuery, phoneQuery].map((q) => window.matchMedia(q));
  queries.forEach((q) => q.addEventListener("change", notify));
  return () => queries.forEach((q) => q.removeEventListener("change", notify));
}
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(
    subscribeBreakpoint,
    readBreakpoint,
    () => "desktop",
  );
}

export type Theme = "light" | "dark";
const THEME_KEY = "angelone-theme";
const themeListeners = new Set<() => void>();
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
    return "light";
  }
}
let currentTheme: Theme =
  typeof window === "undefined" ? "light" : storedTheme();
function applyTheme(theme: Theme) {
  if (typeof document !== "undefined")
    document.documentElement.classList.toggle("dark", theme === "dark");
}
/** Applies the persisted theme to <html>; main.tsx calls it before render. */
export function initTheme() {
  currentTheme = storedTheme();
  applyTheme(currentTheme);
}
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
      <MagnifyingGlass size={18} aria-hidden="true" />
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

const tileSize = { lg: 22, md: 20, sm: 18 } as const;
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
      <Icon size={tileSize[size]} weight={weight} aria-hidden="true" />
    </span>
  );
}

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

export function StatsStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("ds-stats-strip", className)}>{children}</div>;
}

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
  const pct = Math.round(Math.min(1, Math.max(0, value || 0)) * 1000) / 10;
  return (
    <div
      className={cx(
        "ds-progress",
        thin && "thin",
        "ds-tone-" + tone(t, "blue"),
        className,
      )}
      {...(label
        ? {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": pct,
          }
        : { "aria-hidden": true })}
    >
      <div className="ds-progress-fill" style={{ width: pct + "%" }} />
      {marker && (
        <span className="ds-progress-marker" style={{ left: pct + "%" }} />
      )}
    </div>
  );
}

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

export function ListRow({
  icon,
  tone: t,
  title,
  sub,
  meta,
  badge,
  action,
  onClick,
  className,
}: {
  icon?: IconType;
  tone?: ToneInput;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const content = (
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
  return onClick ? (
    <button
      type="button"
      className={cx("ds-list-row", className)}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={cx("ds-list-row", className)}>{content}</div>
  );
}

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
          <Icon size={18} weight="duotone" aria-hidden="true" />
        </span>
      )}
      <div className="ds-notice-body">{children}</div>
    </div>
  );
}

/* ─────────────────────────── Controls ──────────────────────────── */

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

export type SegmentedOption = {
  value: string;
  label: string;
  count?: number | string;
  icon?: IconType;
  disabled?: boolean;
};
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
      {options.map((o) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
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
      })}
    </div>
  );
}

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
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

/* ─────────────────────────── Overlays ──────────────────────────── */

export function Dialog({
  open = true,
  onClose,
  title,
  subtitle,
  header,
  footer,
  size = "default",
  dismissOnScrim = true,
  closeLabel = "Close dialog",
  className,
  children,
}: {
  open?: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  size?: "default" | "narrow" | "wide" | "full";
  dismissOnScrim?: boolean;
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  if (!open) return null;
  return (
    <DialogInner
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      header={header}
      footer={footer}
      size={size}
      dismissOnScrim={dismissOnScrim}
      closeLabel={closeLabel}
      className={className}
    >
      {children}
    </DialogInner>
  );
}

/** Dialog without the `open` switch; Modal in ui.tsx renders through it. */
export const DialogFrame = DialogInner;
function DialogInner({
  onClose,
  title,
  subtitle,
  header,
  footer,
  size = "default",
  dismissOnScrim = true,
  closeLabel = "Close dialog",
  className,
  children,
}: {
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  size?: "default" | "narrow" | "wide" | "full";
  dismissOnScrim?: boolean;
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressStartedOnScrim = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const titleId = useId();
  const subtitleId = useId();
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
  }, []);
  // The scrim click is a pointer convenience; Escape (onCancel) and the
  // close button are the keyboard paths.
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      className={cx("ds-dialog", size !== "default" && size, className)}
      aria-modal="true"
      aria-labelledby={header ? undefined : titleId}
      aria-label={header ? title : undefined}
      aria-describedby={!header && subtitle ? subtitleId : undefined}
      onCancel={(e) => {
        // React passes a nested dialog's cancel (Escape) up the component
        // tree, through portals, to every dialog that renders it. Only the
        // dialog the browser cancelled closes; its parents keep their forms.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onCloseRef.current();
      }}
      onPointerDown={(e) => {
        pressStartedOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (
          dismissOnScrim &&
          pressStartedOnScrim.current &&
          e.target === e.currentTarget
        )
          onCloseRef.current();
        pressStartedOnScrim.current = false;
      }}
    >
      <div className="ds-dialog-panel">
        {header ?? (
          <div className="ds-dialog-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p id={subtitleId}>{subtitle}</p>}
            </div>
            <RoundButton
              label={closeLabel}
              onClick={() => onCloseRef.current()}
            />
          </div>
        )}
        <div className="ds-dialog-body">{children}</div>
        {footer && <div className="ds-dialog-footer">{footer}</div>}
      </div>
    </dialog>
  );
}

/* ───────────────────────────── Brand ───────────────────────────── */

export function Wordmark({
  variant = "auto",
  width,
  height,
  className,
}: {
  variant?: "auto" | "navy" | "white";
  width?: number;
  height?: number;
  className?: string;
}) {
  const style: CSSProperties = {
    width: width ?? (height ? "auto" : 156),
    height: height ?? "auto",
  };
  const img = (src: string, kind: "navy" | "white") => (
    <img
      key={kind}
      src={src}
      alt="Angel One"
      className={cx(
        "ds-wordmark",
        variant === "auto" && "auto",
        "ds-wordmark-" + kind,
        className,
      )}
      style={style}
      width={width}
      height={height}
    />
  );
  if (variant === "navy") return img("/branding/angelone.png", "navy");
  if (variant === "white")
    return (
      <img
        src="/branding/angelone-white.png"
        alt="Angel One"
        className={cx("ds-wordmark", className)}
        style={style}
        width={width}
        height={height}
      />
    );
  return (
    <>
      {img("/branding/angelone.png", "navy")}
      {img("/branding/angelone-white.png", "white")}
    </>
  );
}

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

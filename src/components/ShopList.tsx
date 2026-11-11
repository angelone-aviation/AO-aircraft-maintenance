/**
 * Responsibility: Building blocks for the shop screens: a table card, a list
 *   lead, a filter select, a stat tile and a status pill with an icon.
 * Layer: UI. Presentational components; no state or data access.
 * Dependencies: src/components/design.tsx (IconTile, StatusPill, types),
 *   @phosphor-icons/react, src/styles/screens/shop.css.
 *
 * These screens keep semantic <table>s, because their rows and cells are what
 * people and the e2e specs navigate by, dressed as the redesign's list and
 * table cards. Candidates for promotion into src/components/design.tsx.
 */
import type { ReactNode } from "react";
import {
  CaretDown,
  CheckCircle,
  Circle,
  Info,
  WarningCircle,
  WarningOctagon,
} from "@phosphor-icons/react";
import { IconTile, StatusPill, type IconType, type Tone } from "./design";
import "../styles/screens/shop.css";

/**
 * Bordered card around a `table.shop-table`, which scrolls sideways inside
 * the card below its `--shop-table-min` width (760px unless set). Adding
 * `shop-list-look` to `className` hides the header row visually (screen
 * readers keep it) and dresses the rows as list rows.
 *
 * @param props.label - Accessible name of the card's `<section>`.
 * @param props.title - Heading (h2) for a head row; `actions` also shows it.
 * @param props.stack - Below 760px, lays rows out as cards: cells show their
 *   `data-label`, and `.shop-wide` cells span the card.
 * @returns The card section wrapping `children` in the scrolling container.
 */
export function ShopTableCard({
  label,
  title,
  actions,
  stack = false,
  className,
  children,
}: {
  label?: string;
  title?: ReactNode;
  actions?: ReactNode;
  stack?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={joinClassNames(
        "shop-table-card",
        stack && "shop-stack",
        className,
      )}
      aria-label={label}
    >
      {(title || actions) && (
        <div className="shop-table-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="shop-table-head-actions">{actions}</div>}
        </div>
      )}
      <div className="shop-table-scroll">{children}</div>
    </section>
  );
}

/**
 * The lead of a list-style row, for a table's first cell: a duotone icon
 * tile, a title and an optional muted sub-line.
 *
 * @param props.tone - Tile tone; missing or `neutral` draws the blue tile, as
 *   the design's generic list rows do.
 * @returns A `span.shop-lead` laid out like the design's ListRow lead.
 */
export function ShopLead({
  icon,
  tone,
  title,
  sub,
}: {
  icon: IconType;
  tone?: Tone | "warning";
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <span className="ds-list-lead shop-lead">
      <IconTile
        icon={icon}
        tone={!tone || tone === "neutral" ? "blue" : tone}
      />
      <span className="ds-list-text">
        <strong className="ds-list-title">{title}</strong>
        {sub && <span className="ds-list-sub">{sub}</span>}
      </span>
    </span>
  );
}

/**
 * Filter select with an optional leading icon and a caret.
 *
 * @param props.label - The select's accessible name (`aria-label`); no
 *   visible label is drawn.
 * @param props.onChange - Called with the chosen option's value.
 * @returns A `label.shop-select` wrapping the `<select>` and its icons.
 */
export function ShopSelect({
  label,
  icon: Icon,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  icon?: IconType;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={joinClassNames("shop-select", className)}>
      {Icon && <Icon size={17} aria-hidden="true" />}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <CaretDown size={14} aria-hidden="true" className="shop-select-caret" />
    </label>
  );
}

/**
 * A stats-strip tile with an optional footnote.
 *
 * @param props.tone - Colours the value as a warning, danger or good figure.
 * @returns A `div.ds-stat-tile` holding the label, value and footnote.
 */
export function ShopStat({
  label,
  value,
  foot,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  tone?: "warn" | "danger" | "good";
}) {
  return (
    <div className="ds-stat-tile">
      <span className="ds-stat-label">{label}</span>
      <strong
        className={joinClassNames("ds-stat-value", tone && "shop-tone-" + tone)}
      >
        {value}
      </strong>
      {foot && <span className="shop-stat-foot">{foot}</span>}
    </div>
  );
}

// A status needs a word and an icon, never colour alone; each tone has one.
const PILL_ICON: Record<Tone, IconType> = {
  good: CheckCircle,
  warn: WarningCircle,
  danger: WarningOctagon,
  blue: Info,
  neutral: Circle,
};

/**
 * A status pill whose icon follows its tone.
 *
 * @param props.tone - "warning" is read as "warn"; neutral when omitted.
 * @returns A {@link StatusPill} with a check, caution, stop, info or ring
 *   icon before the words.
 */
export function ShopPill({
  tone = "neutral",
  children,
}: {
  tone?: Tone | "warning";
  children: ReactNode;
}) {
  const resolved = tone === "warning" ? "warn" : tone;
  return (
    <StatusPill tone={resolved} icon={PILL_ICON[resolved]}>
      {children}
    </StatusPill>
  );
}

function joinClassNames(
  ...names: (string | false | null | undefined)[]
): string {
  return names.filter(Boolean).join(" ");
}

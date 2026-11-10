/**
 * Responsibility: Building blocks for the operations screens: a record list
 *   and its rows, label/value meters and a filter select.
 * Layer: UI. Presentational components; no state or data access.
 * Dependencies: src/components/design.tsx (IconTile, tone and icon types),
 *   src/styles/screens/operations.css.
 *
 * They mirror the design's ListRow and toolbar look but add what these
 * screens need and its contract lacks: a semantic list, a details block and
 * a row of secondary actions.
 */
import type { ReactNode } from "react";
import { IconTile, type IconType, type Tone } from "./design";
import "../styles/screens/operations.css";

type OpsRowProps = {
  icon?: IconType;
  tone?: Tone | "warning";
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/**
 * A semantic list of {@link OpsRow}s, so screen readers announce the count
 * and specs can find a record with `getByRole("listitem")`.
 *
 * @param props.label - The list's accessible name.
 * @returns A `ul.ops-list` wrapping `children`.
 */
export function OpsList({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul className={joinClassNames("ops-list", className)} aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One record row: an icon tile with the title and sub-line, then meta and a
 * status badge, actions, a details block and a row of secondary actions.
 *
 * @param props.tone - Icon tile tone; blue when omitted.
 * @param props.meta - Text before the badge; left out when undefined, null or
 *   "" (0 still shows).
 * @param props.children - Details under the text: meters, reasons, notes.
 * @param props.extra - Secondary actions, last in the row.
 * @returns An `li.ops-row` in which each part renders only when given.
 */
export function OpsRow({
  icon,
  tone,
  title,
  sub,
  meta,
  badge,
  actions,
  extra,
  children,
  className,
}: OpsRowProps) {
  const hasMeta = meta !== undefined && meta !== null && meta !== "";
  return (
    <li className={joinClassNames("ops-row", className)}>
      <div className="ops-row-lead">
        {icon && <IconTile icon={icon} tone={tone ?? "blue"} />}
        <div className="ops-row-text">
          <strong className="ops-row-title">{title}</strong>
          {sub && <span className="ops-row-sub">{sub}</span>}
        </div>
      </div>
      {(hasMeta || badge) && (
        <div className="ops-row-status">
          {hasMeta && <span className="ops-row-meta">{meta}</span>}
          {badge}
        </div>
      )}
      {actions && <div className="ops-row-actions">{actions}</div>}
      {children && <div className="ops-row-details">{children}</div>}
      {extra && <div className="ops-row-extra">{extra}</div>}
    </li>
  );
}

/**
 * Label/value pairs styled like the dashboard meters.
 *
 * @param props.items - `[label, value]` pairs in display order; labels are
 *   the React keys, so they must be unique.
 * @returns A `dl.ops-meters`. Each term ends in a visually hidden ": ", so
 *   screen readers and text matching read "Label: value".
 */
export function OpsMeters({
  items,
  className,
}: {
  items: [label: string, value: ReactNode][];
  className?: string;
}) {
  return (
    <dl className={joinClassNames("ops-meters", className)}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>
            {label}
            <span className="ops-sr-only">: </span>
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Filter select with an optional leading icon and a drawn caret.
 *
 * @param props.label - The select's accessible name (`aria-label`), so
 *   `getByLabel(label)` finds it; no visible label is drawn.
 * @param props.onChange - Called with the chosen option's value, as a string.
 * @returns A `label.ops-select` wrapping the `<select>`.
 */
export function OpsSelect({
  label,
  icon: Icon,
  value,
  onChange,
  disabled,
  children,
  className,
}: {
  label: string;
  icon?: IconType;
  value: string | number;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={joinClassNames("ops-select", className)}>
      {Icon && <Icon size={18} aria-hidden="true" />}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <span className="ops-select-caret" aria-hidden="true" />
    </label>
  );
}

function joinClassNames(
  ...names: (string | false | null | undefined)[]
): string {
  return names.filter(Boolean).join(" ");
}

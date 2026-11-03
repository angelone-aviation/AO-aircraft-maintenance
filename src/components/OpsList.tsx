/**
 * Local building blocks for the operations screens (Aircraft, Flight
 * Programs, Flight plans, Checklists, Planning, Airworthiness directives,
 * Scan label). They mirror the shared ListRow / toolbar look from design.tsx
 * but add what those screens need and the contract lacks:
 *
 * <OpsList label> a semantic <ul> of OpsRows (screen readers announce the
 *   count; specs can find a record with getByRole("listitem")).
 * <OpsRow icon? tone? title sub? meta? badge? actions? extra? children?>
 *   one <li>: 44px duotone icon tile, title + sub, meta + status pill,
 *   actions, an optional details block (children: meters, reasons, notes)
 *   under the text, and an optional row of secondary actions (extra).
 *   Grid: lead · status · actions (≥1100px), lead · status / details ·
 *   actions (760–1099px), stacked with the actions last (<760px).
 * <OpsMeters items> label/value pairs styled like the dashboard meters.
 * <OpsSelect label icon value onChange> 44px filter select with a leading
 *   icon; label is the select's accessible name (aria-label), so
 *   getByLabel(label) keeps working.
 */
import type { ReactNode } from "react";
import { IconTile, type IconType, type Tone } from "./design";
import "../styles/screens/operations.css";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

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
    <ul className={cx("ops-list", className)} aria-label={label}>
      {children}
    </ul>
  );
}

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
}: {
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
}) {
  const hasMeta = meta !== undefined && meta !== null && meta !== "";
  return (
    <li className={cx("ops-row", className)}>
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

export function OpsMeters({
  items,
  className,
}: {
  items: [label: string, value: ReactNode][];
  className?: string;
}) {
  return (
    <dl className={cx("ops-meters", className)}>
      {items.map(([label, value]) => (
        <div key={label}>
          {/* The hidden colon keeps "Label: value" for screen readers and
              for text matching, without showing punctuation. */}
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
    <label className={cx("ops-select", className)}>
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

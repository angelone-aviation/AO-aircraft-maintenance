/**
 * Local building blocks for the shop screens (work orders, parts requests,
 * purchase orders, vendors, saved addresses, reference library and costs).
 *
 * These screens keep semantic <table>s (their rows and cells are what people
 * and the e2e specs navigate by), dressed as the redesign's list / table
 * cards. Candidates for promotion into src/components/design.tsx:
 *
 * <ShopTableCard label? title? actions? stack? className?> bordered card
 *   around a `<table className="shop-table">`, which scrolls sideways inside
 *   the card once narrower than its `--shop-table-min` (default 760px).
 *   `stack` turns rows into stacked cards below 760px (cells carry
 *   `data-label`, `.shop-wide` cells span the card); `title` / `actions`
 *   render a heading row. Add `shop-list-look` to drop the visible header
 *   row and dress the rows as ListCard rows (the header stays for screen
 *   readers).
 * <ShopLead icon tone? title sub?> the ListRow lead (44px duotone tile,
 *   16.5px title, 14px muted sub) for a table's first cell. Neutral rows get
 *   the blue tile, as the README's generic list rows do.
 * <ShopSelect label icon? value onChange> 44px filter select with a leading
 *   icon; `label` is the accessible name (aria-label).
 * <ShopStat label value foot?> a StatsStrip tile with an optional footnote.
 */
import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { IconTile, type IconType, type Tone } from "./design";
import "../styles/screens/shop.css";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

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
      className={cx("shop-table-card", stack && "shop-stack", className)}
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
    <label className={cx("shop-select", className)}>
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
      <strong className={cx("ds-stat-value", tone && "shop-tone-" + tone)}>
        {value}
      </strong>
      {foot && <span className="shop-stat-foot">{foot}</span>}
    </div>
  );
}

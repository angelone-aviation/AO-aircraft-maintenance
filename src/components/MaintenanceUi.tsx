/**
 * Responsibility: Small pieces shared by the maintenance screens: an icon
 *   filter select, the visible caption of a record fact cell, and a table of
 *   rows that restacks on narrow screens.
 * Layer: UI. Presentational components; no state or data access.
 * Dependencies: src/components/design.tsx (IconType), @phosphor-icons/react,
 *   src/styles/screens/maintenance.css.
 *
 * Candidates for promotion into src/components/design.tsx.
 */
import type { CSSProperties, ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { IconType } from "./design";
import "../styles/screens/maintenance.css";

/**
 * Filter select with a leading icon and a caret.
 *
 * @param props.label - The select's accessible name (`aria-label`); no
 *   visible label is drawn.
 * @param props.onChange - Called with the chosen option's value.
 * @returns A `label.mx-select` wrapping the `<select>`.
 */
export function IconSelect({
  icon: Icon,
  label,
  value,
  onChange,
  children,
  className,
}: {
  icon: IconType;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={"mx-select" + (className ? " " + className : "")}>
      <Icon size={17} aria-hidden="true" />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <CaretDown className="mx-select-caret" size={14} aria-hidden="true" />
    </label>
  );
}

/**
 * Visible caption for a record fact cell, hidden from assistive technology:
 * the table keeps a visually hidden header row, so the column name would
 * otherwise be announced twice.
 *
 * @returns A `span.mx-fact-label` holding `children`.
 */
export function FactLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mx-fact-label" aria-hidden="true">
      {children}
    </span>
  );
}

/**
 * A table drawn as airy rows in one card. On desktop its column header
 * shows; below 1100px each row restacks and every captioned cell shows its
 * own caption instead. It is built from ARIA table roles on plain elements,
 * so the rows can restack without losing the table a screen reader hears.
 *
 * @param props.label - The table's accessible name.
 * @param props.columns - Header texts, one per cell of a row, in order.
 * @param props.cols - The desktop `grid-template-columns` of every row.
 * @param props.hiddenColumns - Headers read by screen readers but not
 *   shown, such as "Actions" over a column of buttons.
 * @param props.children - {@link RowsRow} elements.
 */
export function RowsTable({
  label,
  columns,
  cols,
  hiddenColumns = [],
  className,
  children,
}: {
  label: string;
  columns: readonly string[];
  cols: string;
  hiddenColumns?: readonly string[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={"mx-rt ds-rows" + (className ? " " + className : "")}
      role="table"
      aria-label={label}
      style={{ "--cols": cols } as CSSProperties}
    >
      <div role="rowgroup" className="mx-rt-head">
        <div role="row" className="mx-rt-row">
          {columns.map((column) => (
            <span role="columnheader" key={column}>
              <span className={hiddenColumns.includes(column) ? "sr-only" : ""}>
                {column}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">{children}</div>
    </div>
  );
}

/**
 * One row of a {@link RowsTable}.
 *
 * @param props.children - {@link RowsCell} elements, one per column.
 */
export function RowsRow({ children }: { children: ReactNode }) {
  return (
    <div role="row" className="mx-rt-row">
      {children}
    </div>
  );
}

/**
 * One cell of a {@link RowsRow}.
 *
 * @param props.caption - The column's name, shown above the value once the
 *   row restacks; leave it out for a cell that explains itself.
 * @param props.kind - "main" and "actions" take the row's full width when
 *   restacked; "check" is a narrow leading checkbox.
 */
export function RowsCell({
  caption,
  kind,
  children,
}: {
  caption?: string;
  kind?: "main" | "actions" | "check";
  children: ReactNode;
}) {
  return (
    <div role="cell" className={kind ? "mx-rt-" + kind : undefined}>
      {caption && <FactLabel>{caption}</FactLabel>}
      {children}
    </div>
  );
}

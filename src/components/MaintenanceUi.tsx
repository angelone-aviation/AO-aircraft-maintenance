/**
 * Responsibility: Small pieces shared by the maintenance screens: an icon
 *   filter select and the visible caption of a record fact cell.
 * Layer: UI. Presentational components; no state or data access.
 * Dependencies: src/components/design.tsx (IconType), @phosphor-icons/react,
 *   src/styles/screens/maintenance.css.
 *
 * Candidates for promotion into src/components/design.tsx.
 */
import type { ReactNode } from "react";
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

/**
 * Small presentation pieces shared by the maintenance screens (Inspections,
 * Components, Inventory). Built locally during the UI redesign; candidates
 * for promotion into design.tsx. Styles: src/styles/screens/maintenance.css.
 */
import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { IconType } from "./design";
import "../styles/screens/maintenance.css";

/** A 44px filter control: leading icon, borderless native select, caret.
 * `label` is the accessible name (aria-label). */
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

/** Visible caption for a record "fact" cell. The table keeps a visually
 * hidden header row for assistive technology, so the caption is hidden from
 * it to avoid announcing the column name twice. */
export function FactLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mx-fact-label" aria-hidden="true">
      {children}
    </span>
  );
}

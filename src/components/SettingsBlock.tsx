/**
 * Responsibility: The building blocks the Settings sections share: a titled
 *   block of controls and the date-and-time format its facts use.
 * Layer: UI. React component and a formatter; no data access.
 * Dependencies: react.
 */
import type { ReactNode } from "react";

/**
 * A titled group of controls inside a Settings section.
 *
 * @param props.title - The block's h3; none when absent.
 * @param props.description - Grey help text under the title.
 */
export function Block({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={"set-block" + (className ? " " + className : "")}>
      {title && <h3>{title}</h3>}
      {description && <p className="set-hint">{description}</p>}
      {children}
    </div>
  );
}

/**
 * A moment as Settings shows it, in the device's locale and a 24-hour clock.
 *
 * @param at - Epoch milliseconds.
 * @returns For example "4 Nov 2026 · 12:00".
 */
export function settingsDateTime(at: number) {
  const day = new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${day} · ${time}`;
}

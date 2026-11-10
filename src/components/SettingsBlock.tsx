/**
 * Responsibility: The building blocks the Settings sections share: a titled
 *   block of controls, the row each outside-service panel opens with, and the
 *   date-and-time format its facts use.
 * Layer: UI. React components and a formatter; no data access.
 * Dependencies: react, ./design.tsx.
 */
import type { ReactNode } from "react";
import { StatusPill, type Tone } from "./design";

/** What an integration's status pill says; the words carry the meaning. */
export type IntegrationStatus = { tone: Tone; label: string };

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
 * The opening row of an outside-service panel (FAA, Geoapify, Aircraft
 * Spruce): its name, a status pill, one short line, and its Update… button,
 * with the panel's notes and dialogs below.
 *
 * @param props.heading - h3 by default; h2 where the panel stands alone.
 * @param props.action - Usually an {@link UpdateButton}; none for readers
 *   who cannot change the integration.
 */
export function IntegrationRow({
  name,
  heading: Heading = "h3",
  status,
  summary,
  action,
  children,
}: {
  name: string;
  heading?: "h2" | "h3";
  status: IntegrationStatus;
  summary: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="panel set-integration">
      <div className="set-integration-row">
        <div className="set-integration-text">
          <Heading>{name}</Heading>
          <p className="set-integration-summary">{summary}</p>
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The Update… button of an {@link IntegrationRow}.
 *
 * @param props.label - The accessible name, starting "Update", such as
 *   "Update Geoapify API key"; the button shows "Update…".
 */
export function UpdateButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="button small"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      Update…
    </button>
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

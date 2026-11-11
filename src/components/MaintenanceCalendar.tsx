/**
 * Responsibility: The maintenance calendar: a month of what falls due across
 *   the fleet, as a grid on wider screens and a day-by-day agenda on phones,
 *   with the items that have no date listed beside it.
 * Layer: UI. Read-only; projections from src/domain/forecast.ts, laid out by
 *   src/domain/dueCalendar.ts.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (dueCalendar, forecast, model), ./Planning
 *   (readable items, tones), ./OpsList, ./design, ./maintenanceCalendar.css.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Airplane, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  dueMonth,
  monthOf,
  shiftMonth,
  type CalendarDay,
} from "../domain/dueCalendar";
import type { ForecastItem } from "../domain/forecast";
import { localDate, type Snapshot } from "../domain/model";
import { readableAircraft, readableForecast, statusTone } from "./Planning";
import { OpsSelect } from "./OpsList";
import { EmptyState, PageHeader, Toolbar, useBreakpoint } from "./design";
import "./maintenanceCalendar.css";

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;
const ITEM_SCREENS = {
  inspection: "/inspections",
  component: "/components",
  ad: "/airworthiness",
} as const;
const BASIS_WORDS = { hours: "hours", cycles: "cycles", landings: "landings" };

type Calendar = ReturnType<typeof useCalendar>;
type CalendarProps = { calendar: Calendar };

/**
 * The maintenance calendar screen: every inspection, component requirement
 * and AD task the user may read, on the date it falls due, a month at a
 * time. Usage-limited items sit on the date the forecast projects; overdue
 * items sit on today; items with no date are listed apart.
 *
 * @returns The screen; it changes no records.
 */
export function MaintenanceCalendar() {
  const calendar = useCalendar();
  const phone = useBreakpoint() === "phone";
  return (
    <div className="mcal ops-page">
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Maintenance"
        accent="calendar"
        description="What falls due across the fleet, by day. Dates for hours, cycles and landings are projected from recent flights."
      />
      <CalendarToolbar calendar={calendar} />
      <div className="mcal-body">
        {phone ? (
          <Agenda calendar={calendar} />
        ) : (
          <MonthGrid calendar={calendar} />
        )}
        <Undated calendar={calendar} />
      </div>
    </div>
  );
}

function useCalendar() {
  const s = useWorkspace((x) => x.snapshot)!;
  const today = localDate();
  const [month, setMonth] = useState(monthOf(today));
  const [aircraft, setAircraft] = useState("");
  const all = useMemo(() => readableForecast(s, today), [s, today]);
  const items = all.filter((i) => !aircraft || i.aircraftUuid === aircraft);
  return {
    s,
    today,
    month,
    setMonth,
    aircraft,
    setAircraft,
    layout: dueMonth(items, month),
  };
}

function CalendarToolbar({ calendar: c }: CalendarProps) {
  const label = monthLabel(c.month);
  return (
    <Toolbar className="mcal-toolbar">
      <div className="mcal-nav">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous month"
          onClick={() => c.setMonth(shiftMonth(c.month, -1))}
        >
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <h2 className="mcal-month" aria-live="polite">
          {label}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Next month"
          onClick={() => c.setMonth(shiftMonth(c.month, 1))}
        >
          <CaretRight size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => c.setMonth(monthOf(c.today))}
        >
          Today
        </button>
      </div>
      <AircraftFilter calendar={c} />
    </Toolbar>
  );
}

function AircraftFilter({ calendar: c }: CalendarProps) {
  return (
    <OpsSelect
      label="Aircraft"
      icon={Airplane}
      value={c.aircraft}
      onChange={c.setAircraft}
    >
      <option value="">All aircraft</option>
      {readableAircraft(c.s).map((a) => (
        <option key={a.uuid} value={a.uuid}>
          {a.registration}
        </option>
      ))}
    </OpsSelect>
  );
}

function MonthGrid({ calendar: c }: CalendarProps) {
  return (
    <table className="mcal-grid">
      <caption className="sr-only">
        Maintenance due in {monthLabel(c.month)}
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map(([short, long]) => (
            <th key={short} scope="col">
              <abbr title={long}>{short}</abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {c.layout.weeks.map((week) => (
          <tr key={week[0].date}>
            {week.map((day) => (
              <GridDay key={day.date} day={day} calendar={c} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GridDay({
  day,
  calendar: c,
}: CalendarProps & { day: CalendarDay<ForecastItem> }) {
  const isToday = day.date === c.today;
  const classes = ["mcal-day", !day.inMonth && "outside", isToday && "today"];
  return (
    <td
      className={classes.filter(Boolean).join(" ")}
      aria-current={isToday ? "date" : undefined}
    >
      <span className="mcal-date" aria-hidden="true">
        {Number(day.date.slice(8))}
      </span>
      <span className="sr-only">
        {dayLabel(day.date)}
        {isToday ? ", today" : ""}
      </span>
      {day.items.length > 0 && (
        <DueList items={day.items} s={c.s} label={dayLabel(day.date)} />
      )}
    </td>
  );
}

function Agenda({ calendar: c }: CalendarProps) {
  const { agenda } = c.layout;
  if (!agenda.length)
    return (
      <EmptyState title={`Nothing falls due in ${monthLabel(c.month)}`}>
        Items with no projected date are listed below.
      </EmptyState>
    );
  return (
    <ol className="mcal-agenda" aria-label={`Due in ${monthLabel(c.month)}`}>
      {agenda.map((day) => (
        <li key={day.date} className="mcal-agenda-day">
          <h3 aria-current={day.date === c.today ? "date" : undefined}>
            {dayLabel(day.date)}
            {day.date === c.today && <span className="mcal-today"> Today</span>}
          </h3>
          <DueList items={day.items} s={c.s} label={dayLabel(day.date)} />
        </li>
      ))}
    </ol>
  );
}

function Undated({ calendar: c }: CalendarProps) {
  const { undated } = c.layout;
  return (
    <aside className="mcal-undated" aria-labelledby="mcal-undated-title">
      <h2 id="mcal-undated-title">Due by hours, no date</h2>
      <p className="mcal-help">
        Limits in hours, cycles or landings with too little flight history to
        project a date.
      </p>
      {undated.length ? (
        <DueList items={undated} s={c.s} label="Due by hours, no date" />
      ) : (
        <p className="mcal-help">None.</p>
      )}
    </aside>
  );
}

function DueList({
  items,
  s,
  label,
}: {
  items: ForecastItem[];
  s: Snapshot;
  label: string;
}) {
  return (
    <ul className="mcal-items" aria-label={label}>
      {items.map((item) => (
        <li key={item.key}>
          <DueLink item={item} s={s} />
        </li>
      ))}
    </ul>
  );
}

function DueLink({ item, s }: { item: ForecastItem; s: Snapshot }) {
  const tone = statusTone(item);
  const overdue = !!item.projection?.overdue;
  const basis = item.projection?.basis;
  return (
    <Link
      to={ITEM_SCREENS[item.kind]}
      className={"mcal-item mcal-tone-" + (overdue ? "danger" : tone)}
    >
      <strong>
        {registrationOf(s, item)} · {item.title}
      </strong>
      {overdue && <span className="mcal-overdue">Overdue</span>}
      {basis && basis !== "calendar" && !overdue && (
        <span className="mcal-note">Projected by {BASIS_WORDS[basis]}</span>
      )}
      {!item.projection && item.remaining && (
        <span className="mcal-note">{item.remaining}</span>
      )}
    </Link>
  );
}

function registrationOf(s: Snapshot, item: ForecastItem) {
  if (!item.aircraftUuid) return "Inventory";
  const aircraft = s.aircraft.find((a) => a.uuid === item.aircraftUuid);
  return aircraft?.registration ?? "Unknown aircraft";
}

function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

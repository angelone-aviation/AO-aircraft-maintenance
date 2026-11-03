import { jsPDF } from "jspdf";
import { localDate } from "../domain/model";
import {
  totalSeconds,
  aircraftMeterLabels,
  type Snapshot,
} from "../domain/model";
import { inspectionDueDate, inspectionStatus } from "../domain/maintenance";
import { inspectionCounters } from "../domain/management";
import { componentTotals } from "../domain/components";
import { daysPerServiceMonth } from "../domain/componentCalendar";
import { adAircraftUuid, adStatus } from "../domain/airworthiness";
import { adRemaining } from "../domain/adRemaining";

export function aircraftStatusReport(
  state: Snapshot,
  aircraftUuid: string,
  now = new Date(),
) {
  const a = state.aircraft.find((x) => x.uuid === aircraftUuid);
  if (!a) throw Error("Aircraft not found.");
  const today = localDate(now.getTime());
  const pdf = new jsPDF({
    unit: "mm",
    format: "letter",
    orientation: "landscape",
  });
  const left = 10,
    width = 259,
    bottom = 194,
    line = 3.8;
  let y = 26;
  const clean = (value: string) =>
    value.replace(/[–—]/g, "-").replace(/[^\x20-\x7e\n]/g, " ");
  const header = () => {
    pdf.setFillColor(28, 69, 57);
    pdf.rect(0, 0, 279.4, 20, "F");
    pdf.setTextColor(255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.text(clean(`${a.registration} | AIRCRAFT STATUS SHEET`), left, 10);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.text(clean(`${a.make} ${a.model} | S/N ${a.serial}`), left, 16);
    pdf.text(
      `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
      269,
      10,
      { align: "right" },
    );
  };
  const newPage = () => {
    pdf.addPage();
    header();
    y = 26;
  };
  header();
  function note(value: string) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(60);
    const lines: string[] = pdf.splitTextToSize(clean(value), width);
    for (const text of lines) {
      if (y + 5 > bottom) newPage();
      pdf.setTextColor(60);
      pdf.setFontSize(8);
      pdf.text(text, left, y + 3);
      y += 4;
    }
    y += 2;
  }
  function table(
    title: string,
    labels: string[],
    shares: number[],
    rows: string[][],
  ) {
    const sum = shares.reduce((x, z) => x + z, 0),
      widths = shares.map((x) => (x / sum) * width);
    const wrap = (cells: string[]) =>
      cells.map(
        (text, index) =>
          pdf.splitTextToSize(
            clean(text || "-"),
            widths[index] - 4,
          ) as string[],
      );
    function heading() {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10);
      pdf.setTextColor(28, 69, 57);
      pdf.text(title.toUpperCase(), left, y + 4);
      y += 7;
      pdf.setFontSize(8);
      const cells = wrap(labels),
        height = Math.max(...cells.map((c) => c.length)) * line + 4;
      let x = left;
      pdf.setFillColor(48, 91, 77);
      pdf.rect(left, y, width, height, "F");
      cells.forEach((lines, i) => {
        pdf.setTextColor(255);
        pdf.text(lines, x + 2, y + 5);
        x += widths[i];
      });
      y += height;
    }
    if (y + 35 > bottom) newPage();
    heading();
    rows.forEach((row, index) => {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      const cells = wrap(row);
      let offset = 0;
      const count = Math.max(...cells.map((c) => c.length));
      // Keep ordinary rows together; split only exceptionally long rows.
      if (count * line + 4 <= 140 && y + count * line + 4 > bottom) {
        newPage();
        heading();
      }
      while (offset < count) {
        if (y + 8 > bottom) {
          newPage();
          heading();
        }
        const take = Math.min(
          count - offset,
          Math.max(1, Math.floor((bottom - y - 4) / line)),
        );
        const height = take * line + 4;
        let x = left;
        pdf.setFillColor(
          ...((index % 2 === 0 ? [239, 246, 241] : [255, 255, 255]) as [
            number,
            number,
            number,
          ]),
        );
        pdf.rect(left, y, width, height, "F");
        cells.forEach((lines, i) => {
          const value = row[i] || "";
          const danger = /overdue|^-/i.test(value) && value !== "-";
          pdf.setTextColor(
            ...((danger
              ? [165, 35, 35]
              : /Needs review|due-soon/i.test(value)
                ? [134, 83, 0]
                : [35, 48, 43]) as [number, number, number]),
          );
          pdf.setFont("helvetica", i === 0 || danger ? "bold" : "normal");
          pdf.setFontSize(8.5);
          pdf.text(lines.slice(offset, offset + take), x + 2, y + 5);
          pdf.setDrawColor(195, 211, 201);
          pdf.setLineWidth(0.15);
          pdf.rect(x, y, widths[i], height);
          x += widths[i];
        });
        y += height;
        offset += take;
      }
    });
    y += 6;
  }
  const hrs = (seconds: number | null | undefined) =>
    seconds == null ? "-" : (seconds / 3600).toFixed(1);
  const number = (v: number | undefined, digits = 1) =>
    v === undefined ? "-" : v.toFixed(digits);
  table(
    "Aircraft overview",
    [
      "Recorded aircraft status:",
      "Aircraft total time:",
      "Hobbs / Tach (hours)",
      "Cycles / Landings",
      "Tracking meter",
      "Flight program",
    ],
    [34, 32, 42, 32, 38, 60],
    [
      [
        a.operationalStatus,
        `${hrs(totalSeconds(a))} hours`,
        `${hrs(a.currentHobbs)} / ${hrs(a.currentTach)}`,
        `${a.cycles} / ${a.landings}`,
        aircraftMeterLabels[a.meter],
        a.program,
      ],
    ],
  );
  if (a.flightTimeLog && a.currentFlightTimeLog !== undefined)
    note(`Flight time log: ${hrs(a.currentFlightTimeLog)} hours`);
  if (a.currentCyclicHobbs !== undefined)
    note(`Collective hourmeter: ${hrs(a.currentCyclicHobbs)} hours`);
  note(
    `Data synchronized ${new Date(state.syncedAt).toISOString().slice(0, 16).replace("T", " ")} UTC. Negative remaining values are overdue; months are approximate. Calendar exempt suppresses calendar only.`,
  );
  const components = (state.management ?? []).filter(
    (c) => c.kind === "component" && c.installed && c.aircraftUuid === a.uuid,
  );
  table(
    "Installed components",
    [
      "Position / component",
      "Part number / model",
      "Serial number",
      "TSN hours",
      "TSO hours",
      "TSR hours",
      "Cycles",
    ],
    [45, 65, 39, 28, 28, 28, 26],
    components.length
      ? components.map((c) => {
          if (c.kind !== "component") throw Error("Invalid component");
          const identity = [
            `${c.installPosition || ""} ${c.componentType}`,
            c.partNumber,
            c.serial,
          ];
          try {
            const t = componentTotals(c, a, today);
            return [
              ...identity,
              ...(c.trackTime
                ? [
                    hrs(t.timeSinceNew),
                    hrs(t.timeSinceOverhaul),
                    hrs(t.timeSinceRepair),
                  ]
                : ["Not tracked", "Not tracked", "Not tracked"]),
              c.trackCycles ? String(t.cyclesSinceNew) : "Not tracked",
            ];
          } catch {
            return [...identity, "Review", "Review", "Review", "Review"];
          }
        })
      : [["No installed component records", "-", "-", "-", "-", "-", "-"]],
  );
  const inspections = state.inspections
    .filter((i) => !i.archived && i.aircraftUuid === a.uuid)
    .sort((x, z) =>
      x.reference.localeCompare(z.reference, undefined, { numeric: true }),
    );
  table(
    "Inspection schedules",
    [
      "Inspection / component",
      "Repeat interval",
      "Last completed",
      "Next due\nHours / cycles / landings",
      "Date due",
      "Hours remaining",
      "Months remaining*",
      "Cycles / landings remaining",
      "Status",
    ],
    [46, 27, 29, 25, 24, 23, 22, 22, 28],
    inspections.length
      ? inspections.map((i) => {
          const r = inspectionStatus(
            i,
            a,
            today,
            inspectionCounters(i, a, state.management),
          );
          const component = components.find((c) => c.uuid === i.componentUuid);
          const asset =
            component?.kind === "component"
              ? `\n${component.installPosition || ""} S/N ${component.serial}`
              : "";
          return [
            (i.reference || i.description) + asset,
            [
              i.intervalSeconds ? `${hrs(i.intervalSeconds)} h` : null,
              i.intervalCycles ? `${i.intervalCycles} cyc` : null,
              i.intervalLandings ? `${i.intervalLandings} landings` : null,
              i.intervalMonths
                ? `${i.intervalMonths} mo${i.calendarExempt ? " (exempt)" : ""}`
                : null,
            ]
              .filter(Boolean)
              .join("\n") || "One-time",
            [
              i.lastSeconds !== undefined ? `${hrs(i.lastSeconds)} h` : null,
              i.lastCycles !== undefined ? `${i.lastCycles} cyc` : null,
              i.lastLandings !== undefined
                ? `${i.lastLandings} landings`
                : null,
              i.lastDate,
            ]
              .filter(Boolean)
              .join("\n") || "-",
            [
              i.dueSeconds !== undefined ? `${hrs(i.dueSeconds)} h` : null,
              i.dueCycles !== undefined ? `${i.dueCycles} cyc` : null,
              i.dueLandings !== undefined ? `${i.dueLandings} landings` : null,
            ]
              .filter(Boolean)
              .join("\n") || "-",
            i.calendarExempt ? "Calendar exempt" : inspectionDueDate(i) || "-",
            number(r.hoursRemaining),
            number(
              r.daysRemaining === undefined
                ? undefined
                : r.daysRemaining / daysPerServiceMonth,
            ),
            [
              r.cyclesRemaining === undefined
                ? ""
                : `${number(r.cyclesRemaining, 0)} cyc`,
              r.landingsRemaining === undefined
                ? ""
                : `${number(r.landingsRemaining, 0)} landings`,
            ]
              .filter(Boolean)
              .join("\n") || "-",
            r.status,
          ];
        })
      : [
          [
            "No active inspection schedules",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
          ],
        ],
  );
  const exempt = inspections.filter((i) => i.calendarExempt);
  if (exempt.length) {
    const reasons = new Map<string, string[]>();
    for (const i of exempt) {
      const reason = i.calendarExemptReason || "Reason not recorded";
      reasons.set(reason, [...(reasons.get(reason) || []), i.reference]);
    }
    for (const [reason, refs] of reasons)
      note(`Calendar exemption - ${refs.join(", ")}: ${reason}`);
  }
  note(
    "* Months remaining are approximate; the exact date due controls. Hours and cycles use each inspection's configured counter; landings use aircraft total landings.",
  );
  const ads = (state.airworthiness ?? [])
    .filter((r) => adAircraftUuid(state, r) === a.uuid)
    .sort(
      (x, z) =>
        x.componentUuid.localeCompare(z.componentUuid) ||
        x.source.number.localeCompare(z.source.number, undefined, {
          numeric: true,
        }),
    );
  table(
    "Airworthiness directives",
    [
      "AD number",
      "Aircraft / component",
      "Subject / required action",
      "Remaining / prior compliance",
      "Status",
    ],
    [31, 45, 80, 63, 40],
    ads.length
      ? ads.map((r) => {
          const component = components.find((c) => c.uuid === r.componentUuid);
          const asset =
            component?.kind === "component"
              ? `${component.installPosition || ""} ${component.componentType}\nS/N ${component.serial}`
              : r.source.section;
          const units = r.tasks.flatMap((t) =>
            adRemaining(state, r, t, today).map(
              (x) => `${x.label}: ${x.value}`,
            ),
          );
          if (r.priorCompliance)
            units.push(
              `PCW ${r.priorCompliance.date}`,
              r.priorCompliance.componentHours !== null
                ? `Engine/component ${r.priorCompliance.componentHours.toFixed(1)} h`
                : r.priorCompliance.aircraftHours !== null
                  ? `Aircraft ${r.priorCompliance.aircraftHours.toFixed(1)} h`
                  : "",
            );
          return [
            r.source.number,
            asset,
            [r.source.subject, ...r.tasks.map((t) => t.description)].join("\n"),
            units.join("\n") || "-",
            adStatus(state, r),
          ];
        })
      : [["No AD records", "-", "-", "-", "-"]],
  );
  const discrepancies = state.discrepancies.filter(
    (d) => d.aircraftUuid === a.uuid && d.status === "open",
  );
  table(
    "Open discrepancies",
    ["Reported", "Description", "Status"],
    [30, 200, 29],
    discrepancies.length
      ? discrepancies.map((d) => [
          localDate(d.createdAt),
          d.description,
          "Open",
        ])
      : [["-", "No open discrepancies recorded", "-"]],
  );
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(75);
    pdf.text(
      "Recorded status only. Consult aircraft records for actual sign-offs; not a maintenance release.",
      left,
      204,
    );
    pdf.text(`${a.registration} | Page ${page} of ${pages}`, 269, 204, {
      align: "right",
    });
  }
  return pdf;
}

import { jsPDF } from "jspdf";
import { localDate } from "../domain/model";
import {
  adAircraftUuid,
  adStatus,
  adTaskStatus,
  effectiveCompliance,
  type AD,
} from "../domain/airworthiness";
import { totalSeconds, type Snapshot } from "../domain/model";
import { componentTotals } from "../domain/components";

type Cell = { text: string; share: number; bold?: boolean };
const cell = (text: string, share = 1, bold = false): Cell => ({
  text,
  share,
  bold,
});
const date = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${Number(value.slice(5, 7))}/${Number(value.slice(8))}/${value.slice(0, 4)}`
    : value;
const hours = (value: number | null | undefined) =>
  value == null ? "" : value.toFixed(1);

/** Letter-size compliance worksheet based on CompReport_N626KB.docx. */
export function adReport(s: Snapshot, aircraftUuid: string) {
  const foundAircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!foundAircraft) throw Error("Aircraft not found.");
  const a = foundAircraft;
  const pdf = new jsPDF({ unit: "mm", format: "letter" });
  const left = 12.7,
    width = 190.5,
    bottom = 261,
    leading = 3.5,
    padding = 1;
  let y = 15;
  let activeGroup: AD[] = [];
  let continuedAD = "";
  const records = (s.airworthiness ?? []).filter(
    (r) => adAircraftUuid(s, r) === aircraftUuid,
  );
  const sectionOrder = ["Airframe", "Engine", "Propeller", "Appliance"];
  records.sort(
    (x, z) =>
      sectionOrder.indexOf(x.source.section) -
        sectionOrder.indexOf(z.source.section) ||
      x.componentUuid.localeCompare(z.componentUuid) ||
      x.source.number.localeCompare(z.source.number, undefined, {
        numeric: true,
      }),
  );
  const groups = new Map<string, AD[]>();
  for (const r of records) {
    const key = `${r.source.section}:${r.componentUuid}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  function lines(c: Cell) {
    pdf.setFont("helvetica", c.bold ? "bold" : "normal");
    pdf.setFontSize(8);
    return pdf.splitTextToSize(
      c.text || " ",
      width * c.share - padding * 2,
    ) as string[];
  }
  function drawRow(
    cells: Cell[],
    chunks: string[][],
    count: number,
    dotted = true,
  ) {
    const h = Math.max(5.2, count * leading + padding * 2);
    let x = left;
    pdf.setDrawColor(90);
    pdf.setLineWidth(0.12);
    pdf.setLineDashPattern(dotted ? [0.3, 0.6] : [], 0);
    cells.forEach((c, i) => {
      const w = width * c.share;
      pdf.rect(x, y, w, h);
      pdf.setFont("helvetica", c.bold ? "bold" : "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(0);
      pdf.text(chunks[i], x + padding, y + padding + 2.7, {
        lineHeightFactor: leading / ((8 * 25.4) / 72),
      });
      x += w;
    });
    y += h;
    pdf.setLineDashPattern([], 0);
  }
  function header() {
    const r = activeGroup[0];
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === r?.componentUuid,
    );
    const component = c?.kind === "component" ? c : undefined;
    let componentHours = "";
    if (component) {
      try {
        componentHours = hours(
          componentTotals(component, a).timeSinceNew / 3600,
        );
      } catch {
        componentHours = "Unavailable";
      }
    }
    const section = r?.source.section ?? "Airframe";
    const info = [
      cell(
        `Make: ${component?.manufacturer || a.make}\nModel: ${component?.faaSearchModel || component?.model || a.model}`,
        1 / 3,
      ),
      cell(
        `Serial: ${component?.serial || a.serial || ""}\n${component ? "Label: " + (component.installPosition || "") : "N-No.: " + a.registration}`,
        4 / 15,
      ),
      cell(
        `${component ? "Hours (TSN): " + componentHours : "Total AC Hours: " + hours(totalSeconds(a) / 3600)}\n${component ? "N-No.: " + a.registration : "Hrs. Since Last:"}`,
        4 / 15,
      ),
    ];
    const chunks = info.map(lines);
    const h = Math.max(10, ...chunks.map((l) => l.length * leading + 2));
    pdf.setFillColor(0, 0, 0);
    pdf.rect(left, y, (width * 2) / 15, h + 6, "F");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(10);
    pdf.setTextColor(255);
    pdf.text(section, left + width / 15, y + (h + 6) / 2, { align: "center" });
    pdf.setTextColor(0);
    pdf.setDrawColor(0);
    pdf.setLineWidth(0.15);
    let x = left + (width * 2) / 15;
    info.forEach((c, i) => {
      pdf.rect(x, y, width * c.share, h);
      pdf.setFontSize(8);
      pdf.setFont("helvetica", "normal");
      pdf.text(chunks[i], x + 1, y + 3.7, {
        lineHeightFactor: leading / ((8 * 25.4) / 72),
      });
      pdf.rect(x, y + h, width * c.share, 6);
      pdf.text(["Prepared by:", "Cert #:", "Date:"][i], x + 1, y + h + 4);
      x += width * c.share;
    });
    y += h + 10;
  }
  function newPage() {
    pdf.addPage();
    y = 15;
    header();
    if (continuedAD) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8);
      pdf.text(`AD ${continuedAD} (continued)`, left, y + 3);
      y += 6;
    }
  }
  function row(cells: Cell[]) {
    const wrapped = cells.map(lines);
    const n = Math.max(...wrapped.map((l) => l.length));
    const height = Math.max(5.2, n * leading + 2);
    if (height <= bottom - 45 && y + height > bottom) newPage();
    let offset = 0;
    while (offset < n) {
      let available = Math.floor((bottom - y - 2) / leading);
      if (available < 1) {
        newPage();
        available = Math.floor((bottom - y - 2) / leading);
      }
      const count = Math.min(n - offset, available);
      drawRow(
        cells,
        wrapped.map((l) => l.slice(offset, offset + count)),
        count,
      );
      offset += count;
      if (offset < n) newPage();
    }
  }
  if (!records.length) {
    header();
    row([
      cell(
        "No AD records have been entered for this aircraft. This does not establish that no ADs apply.",
      ),
    ]);
  }
  for (const group of groups.values()) {
    activeGroup = group;
    continuedAD = "";
    if (y > 15) {
      pdf.addPage();
      y = 15;
    }
    header();
    for (const r of group) {
      continuedAD = "";
      if (y + 38 > bottom) newPage();
      continuedAD = r.source.number;
      // Corrections replace the entries they correct; originals are listed
      // with them below.
      const history = effectiveCompliance(r);
      const latest = [...history]
        .sort(
          (x, z) => x.date.localeCompare(z.date) || x.recordedAt - z.recordedAt,
        )
        .at(-1);
      const due = r.tasks
        .map((t) =>
          [
            t.dueDate && date(t.dueDate),
            t.dueHours != null && `${hours(t.dueHours)} h`,
            t.dueCycles != null && `${t.dueCycles} cyc`,
            t.dueLandings != null && `${t.dueLandings} landings`,
          ]
            .filter(Boolean)
            .join(" / "),
        )
        .filter(Boolean)
        .join("; ");
      row([
        cell(r.source.number, 0.2, true),
        cell(`Amdt: ${r.source.amendment}`, 0.16),
        cell(`Iss: ${date(r.source.issued)}`, 0.16),
        cell(`Eff: ${date(r.source.effective)}`, 0.16),
        cell(`Recurring: ${r.source.recurring}`, 0.16),
        cell(
          `Hrs: ${hours(latest?.hours ?? (r.componentUuid ? r.priorCompliance?.componentHours : r.priorCompliance?.aircraftHours))}`,
          0.16,
        ),
      ]);
      row([
        cell(`Subject: ${r.source.subject}`, 0.52),
        cell(`Superseded by: ${r.source.supersededBy}`, 0.32),
        cell(
          `Due: ${due || (["Not applicable", "Superseded"].includes(r.applicability) ? "N/A" : "Not set")}`,
          0.16,
        ),
      ]);
      row([
        cell(`Method: ${latest?.method || ""}`, 0.84),
        cell(`SB #: ${latest?.serviceBulletin || ""}`, 0.16),
      ]);
      row([
        cell(`Terminated by: ${latest?.terminatedBy || ""}`, 0.84),
        cell("SB #:", 0.16),
      ]);
      row([
        cell(`Name: ${latest?.mechanic || ""}`, 0.36),
        cell("Sig:", 0.32),
        cell(`Cert: ${latest?.certificate || ""}`, 0.16),
        cell(
          `Date: ${date(latest?.date || r.priorCompliance?.date || "")}`,
          0.16,
        ),
      ]);
      row([
        cell(
          `Applicability: ${r.applicability}${r.reason ? " - " + r.reason : ""} | Status: ${adStatus(s, r)}`,
        ),
      ]);
      if (r.priorCompliance)
        row([
          cell(
            `Previously Complied With (PCW): ${date(r.priorCompliance.date)} | Aircraft total time: ${hours(r.priorCompliance.aircraftHours) || "Not recorded"} h${r.componentUuid ? " | Component total time: " + (hours(r.priorCompliance.componentHours) || "Not recorded") + " h" : ""}`,
          ),
        ]);
      for (const t of r.tasks) {
        row([
          cell(`Required action: ${t.description} | ${adTaskStatus(s, r, t)}`),
        ]);
        row([
          cell(
            `Due: ${[t.dueDate && date(t.dueDate), t.dueHours != null && hours(t.dueHours) + " h", t.dueCycles != null && t.dueCycles + " cycles", t.dueLandings != null && t.dueLandings + " landings"].filter(Boolean).join(" / ") || "Not set"} | Repeat: ${[t.intervalDays && t.intervalDays + " days", t.intervalHours && t.intervalHours + " h", t.intervalCycles && t.intervalCycles + " cycles", t.intervalLandings && t.intervalLandings + " landings"].filter(Boolean).join(" / ") || "None recorded"}`,
          ),
        ]);
      }
      for (const h of history) {
        const w = s.workOrders?.find((w) => w.uuid === h.workOrderUuid);
        row([
          cell(
            `Compliance record: ${date(h.date)} | ${hours(h.hours) || "Unrecorded"} h | Cycles: ${h.cycles ?? "Unrecorded"} | Work order: ${w?.number || h.workOrderUuid || "Unrecorded"}`,
          ),
        ]);
        const original = h.corrects
          ? r.history.find((x) => x.uuid === h.corrects)
          : undefined;
        if (original)
          row([
            cell(
              `Corrected ${date(localDate(h.recordedAt))}: ${h.correctionReason ?? ""} | Originally recorded: ${date(original.date)} | ${hours(original.hours) || "Unrecorded"} h | Cycles: ${original.cycles ?? "Unrecorded"} | Method: ${original.method} | Name: ${original.mechanic}`,
            ),
          ]);
        if (h !== latest) {
          row([
            cell(
              `Method: ${h.method} | SB #: ${h.serviceBulletin} | Terminated by: ${h.terminatedBy}`,
            ),
          ]);
          row([cell(`Name: ${h.mechanic} | Cert: ${h.certificate}`)]);
        }
        if (h.evidence)
          row([cell(`Evidence / logbook reference: ${h.evidence}`)]);
      }
      y += 3;
    }
    continuedAD = "";
    row([
      cell(
        `Number of ADs: ${group.length} recorded for this ${group[0].source.section.toLowerCase()}.`,
      ),
    ]);
  }
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(70);
    pdf.text(
      `${a.registration} | AD Compliance Report | ${localDate()}`,
      left,
      269,
    );
    pdf.text(`Page ${p} of ${pages}`, left + width, 269, { align: "right" });
    pdf.text(
      "Recorded information only. Blank fields are not certification of compliance. Signatures are not generated.",
      left,
      273,
    );
  }
  return {
    pdf,
    filename: `AD-Compliance-${a.registration}-${localDate()}.pdf`,
  };
}
export function saveADReport(s: Snapshot, id: string) {
  const { pdf, filename } = adReport(s, id);
  pdf.save(filename);
}
// Pass a tab opened in the click handler when this module is loaded on
// demand: browsers block pop-ups opened after an await.
export function printADReport(
  s: Snapshot,
  id: string,
  opened: Window | null = window.open("", "_blank"),
) {
  const tab = opened;
  if (!tab) throw Error("Allow pop-ups to print the report.");
  try {
    const { pdf } = adReport(s, id);
    pdf.autoPrint();
    const url = URL.createObjectURL(pdf.output("blob"));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) {
    tab.close();
    throw e;
  }
}

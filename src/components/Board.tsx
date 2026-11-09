/**
 * Responsibility: The read-only board view (route "/board"): fleet status
 *   tiles, each aircraft's line, what falls due in the next 30 days, spend
 *   against budget, the last off-site backup and the PDF board summary.
 * Layer: UI. React components; reads the board snapshot (or a program
 *   administrator's) and changes no records.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/boardSummaryPdf.ts (on demand), src/domain (model, boardView,
 *   boardSummary, aircraftStatus, costs, programs), ./design, ./ui.
 */
import { useState } from "react";
import {
  AirplaneTilt,
  HourglassMedium,
  Prohibit,
  WarningCircle,
} from "@phosphor-icons/react";
import { previewDemoBoard, useWorkspace } from "../data/store";
import { localDate, type Snapshot } from "../domain/model";
import { isBoardView } from "../domain/boardView";
import { programPermission } from "../domain/programs";
import {
  boardSummary,
  type BoardAircraftLine,
  type BoardDueLine,
  type BoardSummary,
} from "../domain/boardSummary";
import {
  aircraftStatusLabels,
  type AircraftStatusLevel,
} from "../domain/aircraftStatus";
import { formatCents } from "../domain/costs";
import {
  EmptyState,
  KpiStrip,
  KpiTile,
  ListCard,
  ListRow,
  NoticeBar,
  PageHeader,
  StatusPill,
  type Tone,
} from "./design";
import { errorText } from "./ui";
import "../styles/screens/board.css";

const STATUS_TONES: Record<AircraftStatusLevel, Tone> = {
  airworthy: "good",
  "due-soon": "warn",
  grounded: "danger",
};
const DUE_TONES: Record<BoardDueLine["status"], Tone> = {
  overdue: "danger",
  "due-soon": "warn",
  unknown: "neutral",
  ok: "blue",
};
const DUE_LABELS: Record<BoardDueLine["status"], string> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  unknown: "Needs review",
  ok: "Scheduled",
};

/**
 * The board view: fleet status tiles (airworthy, due soon, grounded, overdue
 * items), one line per aircraft with its open discrepancies and spend against
 * budget, the due list for the next 30 days, the last off-site backup and a
 * PDF download. Board members see it for every route; program and system
 * administrators open it at /board.
 *
 * @returns The view, or an access notice for anyone else; it changes no
 *   records.
 */
export function Board() {
  const { snapshot, demo } = useWorkspace();
  const s = snapshot!;
  const [error, setError] = useState("");
  if (!isBoardView(s) && !programPermission(s, "admin") && !s.user.isAdmin)
    return <BoardMembersOnly />;
  const summary = boardSummary(s);
  return (
    <div className="board">
      <PageHeader
        eyebrow="BOARD VIEW"
        title="Fleet summary"
        description="Recorded status, what falls due, spend against budget and backups. Read-only."
        actions={
          <>
            <DownloadButton summary={summary} onError={setError} />
            {demo && isBoardView(s) && <ExitPreviewButton onError={setError} />}
          </>
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <FleetTiles summary={summary} />
      <AircraftLines lines={summary.aircraft} />
      <UpcomingDue items={summary.upcoming} />
      <BackupLine s={s} summary={summary} demo={demo} />
      <p className="muted">
        Recorded status only. Missing information never implies aircraft
        readiness; this is not a maintenance release.
      </p>
    </div>
  );
}

function BoardMembersOnly() {
  return (
    <EmptyState title="Board view">
      The board view is for board members and Flight Program administrators.
    </EmptyState>
  );
}

function FleetTiles({ summary }: { summary: BoardSummary }) {
  const { fleet } = summary;
  return (
    <KpiStrip className="board-kpis">
      <KpiTile
        label="Airworthy"
        value={fleet.airworthy}
        icon={AirplaneTilt}
        tone="good"
        footnote="Aircraft with no due or grounding item"
      />
      <KpiTile
        label="Due soon"
        value={fleet["due-soon"]}
        icon={HourglassMedium}
        tone="warn"
        valueTone={fleet["due-soon"] ? "warn" : undefined}
        footnote="Aircraft with an item coming due"
      />
      <KpiTile
        label="Grounded"
        value={fleet.grounded}
        icon={Prohibit}
        tone="danger"
        valueTone={fleet.grounded ? "danger" : undefined}
        footnote="Overdue item, expired deferral or grounding discrepancy"
      />
      <KpiTile
        label="Overdue items"
        value={summary.overdue}
        icon={WarningCircle}
        tone="danger"
        valueTone={summary.overdue ? "danger" : undefined}
        footnote="Inspections, component limits and ADs past their limit"
      />
    </KpiStrip>
  );
}

function AircraftLines({ lines }: { lines: BoardAircraftLine[] }) {
  return (
    <ListCard title="Aircraft" className="board-aircraft">
      {lines.map((line) => (
        <ListRow
          key={line.aircraft.uuid}
          title={line.aircraft.registration}
          sub={`${line.aircraft.make} ${line.aircraft.model} · ${line.overdue} overdue · ${line.dueSoon} due soon · ${describeDiscrepancies(line)}`}
          meta={describeSpend(line)}
          badge={
            <StatusPill tone={STATUS_TONES[line.status]}>
              {aircraftStatusLabels[line.status]}
            </StatusPill>
          }
        />
      ))}
      {!lines.length && (
        <EmptyState title="No aircraft">
          This Flight Program has no aircraft yet.
        </EmptyState>
      )}
    </ListCard>
  );
}

function describeDiscrepancies(line: BoardAircraftLine) {
  const count = `${line.openDiscrepancies} open discrepanc${line.openDiscrepancies === 1 ? "y" : "ies"}`;
  return line.grounding ? `${count} (${line.grounding} grounding)` : count;
}

function describeSpend({ costs }: BoardAircraftLine) {
  if (!costs) return "Spend not available";
  const quarter = `${costs.quarterLabel}: ${formatCents(costs.quarterCents)}`;
  if (costs.budgetCents === undefined)
    return `${quarter} · ${costs.year}: ${formatCents(costs.yearCents)}, no budget set`;
  return `${quarter} · ${costs.year}: ${formatCents(costs.yearCents)} of ${formatCents(costs.budgetCents)}${costs.overBudget ? " (over budget)" : ""}`;
}

function UpcomingDue({ items }: { items: BoardDueLine[] }) {
  return (
    <ListCard title="Due in the next 30 days" className="board-due">
      {items.map((i) => (
        <ListRow
          key={`${i.registration}-${i.uuid}`}
          title={`${i.registration} · ${i.label}`}
          sub={`${i.kind} · ${i.remaining}`}
          badge={
            <StatusPill tone={DUE_TONES[i.status]}>
              {DUE_LABELS[i.status]}
            </StatusPill>
          }
        />
      ))}
      {!items.length && (
        <EmptyState title="Nothing due in the next 30 days">
          No inspection, component limit or AD is overdue, due soon or dated
          within 30 days.
        </EmptyState>
      )}
    </ListCard>
  );
}

// The demo has no backups; a live administrator's snapshot carries no backup
// time either, since Settings → System already reports it to them.
function BackupLine({
  s,
  summary,
  demo,
}: {
  s: Snapshot;
  summary: BoardSummary;
  demo: boolean;
}) {
  if (demo)
    return (
      <NoticeBar tone="neutral" role="status">
        Off-site backups run only on the production deployment.
      </NoticeBar>
    );
  if (!summary.backup)
    return (
      <NoticeBar tone="neutral" role="status">
        {isBoardView(s)
          ? "No off-site backup has been recorded yet."
          : "Backup status is reported to board members here and to system administrators in Settings → System."}
      </NoticeBar>
    );
  return (
    <NoticeBar
      tone={summary.backup.status === "ok" ? "good" : "warn"}
      role="status"
    >
      {summary.backup.message}
    </NoticeBar>
  );
}

function DownloadButton({
  summary,
  onError,
}: {
  summary: BoardSummary;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    onError("");
    try {
      // Loaded on demand, so jsPDF stays out of the view until it is used.
      const { boardSummaryPdf } = await import("../data/boardSummaryPdf");
      boardSummaryPdf(summary).save(`board-summary-${localDate()}.pdf`);
    } catch (e) {
      onError(errorText(e, "Unable to download the board summary."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="button" disabled={busy} onClick={save}>
      {busy ? "Generating PDF…" : "Download board summary (PDF)"}
    </button>
  );
}

function ExitPreviewButton({ onError }: { onError: (error: string) => void }) {
  return (
    <button
      type="button"
      className="button secondary"
      onClick={() =>
        previewDemoBoard(false).catch((e) => onError(errorText(e)))
      }
    >
      Exit board preview
    </button>
  );
}

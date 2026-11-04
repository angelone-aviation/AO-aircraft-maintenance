/**
 * Responsibility: The checklists screen: browsing, reading, importing,
 *   exporting and editing ForeFlight checklists.
 * Layer: UI. React components; .fmd files are read and written in src/data.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/fmd.ts, src/domain/checklists.ts, src/domain/programs.ts,
 *   ./GuidedFlight, ./ChecklistEditor, ./OpsList, ./design, ./ui,
 *   ./checklists.css, src/styles/screens/operations.css.
 */
import { GuidedFlight } from "./GuidedFlight";
import { useRef, useState, type ReactNode } from "react";
import {
  Airplane,
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  Check,
  DownloadSimple,
  ListChecks,
  PencilSimple,
  Plus,
  UploadSimple,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { activeProgram } from "../domain/programs";
import {
  checklistCounts,
  checklistEditable,
  checklistReadable,
  emptyChecklist,
  type ChecklistRecord,
} from "../domain/checklists";
import { importFmd, exportFmd } from "../data/fmd";
import { ChecklistEditor } from "./ChecklistEditor";
import { EmptyState, IconTile, PageHeader, SearchField } from "./design";
import { OpsSelect } from "./OpsList";
import { errorText } from "./ui";
import "./checklists.css";
import "../styles/screens/operations.css";
export type Progress = Record<string, "checked" | "skipped">;
function readProgress(key: string): Progress {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object"
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            ([, v]) => v === "checked" || v === "skipped",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
export function ChecklistReader({
  record,
  onEdit,
  progress: controlledProgress,
  onProgress,
  initialList,
  sectionExtras,
  sectionEndExtras,
  library,
  onBrowse,
}: {
  record: ChecklistRecord;
  library?: ReactNode;
  onBrowse?: () => void;
  onEdit?: () => void;
  progress?: Progress;
  onProgress?: (progress: Progress) => void;
  initialList?: string;
  sectionExtras?: (listId: string) => ReactNode;
  sectionEndExtras?: (listId: string) => ReactNode;
}) {
  const { namespace, snapshot: s } = useWorkspace();
  const key = `angel-one-checks:${namespace}:${s!.user.id}:${record.uuid}:${record.version}`;
  const [storedProgress, setProgress] = useState<Progress>(() =>
    readProgress(key),
  );
  const progress = controlledProgress ?? storedProgress;
  const categories = record.document.payload.groups;
  const initialCategory =
    categories.find((c) =>
      c.items.some((g) => g.items.some((l) => l.objectId === initialList)),
    ) ??
    categories.find((c) => c.items.some((g) => g.items.length)) ??
    categories[0];
  const [categoryId, setCategory] = useState(initialCategory?.objectId ?? "");
  const [listId, setList] = useState(
    initialList ??
      initialCategory?.items.flatMap((g) => g.items)[0]?.objectId ??
      "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const category = categories.find((c) => c.objectId === categoryId);
  const lists = category?.items.flatMap((g) => g.items) ?? [];
  const list = lists.find((l) => l.objectId === listId) ?? lists[0];
  const index = lists.findIndex((l) => l.objectId === list?.objectId);
  const checks = list?.items.filter((i) => i.type !== "comment") ?? [];
  const done = checks.filter((i) => progress[i.objectId] === "checked").length;
  const skipped = checks.filter(
    (i) => progress[i.objectId] === "skipped",
  ).length;
  const nextItem = checks.find(
    (i) =>
      progress[i.objectId] !== "checked" && progress[i.objectId] !== "skipped",
  );
  const persist = (next: Progress) => {
    if (onProgress) {
      onProgress(next);
      return;
    }
    setProgress(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setError("");
    } catch {
      setError(
        "Browser storage is unavailable. These checkmarks will not survive a reload.",
      );
    }
  };
  const toggle = (id: string, state: "checked" | "skipped") => {
    const next = { ...progress };
    if (next[id] === state) delete next[id];
    else next[id] = state;
    persist(next);
  };
  const reset = (all: boolean) => {
    if (
      !window.confirm(
        all
          ? "Reset all personal checkmarks in this checklist set?"
          : "Reset personal checkmarks in this checklist?",
      )
    )
      return;
    const next = { ...progress };
    if (all) persist({});
    else {
      for (const i of checks) delete next[i.objectId];
      persist(next);
    }
  };
  return (
    <section className="checklist-reader" aria-label="Interactive checklist">
      <header className="checklist-banner">
        <div className="ops-checklist-banner-text">
          {onBrowse && (
            <button
              className="button checklist-library-back"
              onClick={onBrowse}
              aria-expanded={!!library}
            >
              <CaretLeft size={16} aria-hidden="true" /> Checklists
            </button>
          )}
          <span className="eyebrow">
            {record.document.payload.metadata.tailNumber ||
              s!.aircraft.find((a) => a.uuid === record.aircraftUuid)
                ?.registration ||
              "Flight Program library"}
          </span>
          <h2>
            {record.document.payload.metadata.name ||
              record.sourceName ||
              "Untitled checklist"}
          </h2>
          <p>{record.document.payload.metadata.detail}</p>
        </div>
        <div className="management-actions ops-checklist-banner-actions">
          {onEdit && (
            <button className="button" onClick={onEdit}>
              <PencilSimple size={17} aria-hidden="true" /> Edit checklist
            </button>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const blob = await exportFmd(record.document);
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${(record.document.payload.metadata.name || "checklist").replace(/[^a-zA-Z0-9 _.-]/g, "_")}.fmd`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(errorText(e, "Export failed."));
              } finally {
                setBusy(false);
              }
            }}
          >
            <DownloadSimple size={17} aria-hidden="true" /> Export .fmd
          </button>
        </div>
      </header>
      <div className="checklist-categories" aria-label="Checklist categories">
        {categories.map((c) => (
          <button
            key={c.objectId}
            className={`checklist-category ${c.groupType}`}
            aria-pressed={c.objectId === categoryId}
            onClick={() => {
              setCategory(c.objectId);
              setList(c.items.flatMap((g) => g.items)[0]?.objectId ?? "");
            }}
          >
            {c.groupType}
            <span>{c.items.reduce((n, g) => n + g.items.length, 0)}</span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="checklist-workspace">
        <nav
          className="checklist-nav"
          aria-label={library ? "Checklist library" : "Checklist sections"}
        >
          {library ?? (
            <>
              {category?.items.map((g) => (
                <div key={g.objectId}>
                  <h3>{g.title || "Untitled group"}</h3>
                  {g.items.map((l) => {
                    const count = l.items.filter((i) => i.type !== "comment");
                    const complete = count.filter(
                      (i) => progress[i.objectId] === "checked",
                    ).length;
                    return (
                      <button
                        key={l.objectId}
                        aria-current={
                          list?.objectId === l.objectId ? "page" : undefined
                        }
                        onClick={() => setList(l.objectId)}
                      >
                        <span>{l.title || "Untitled checklist"}</span>
                        <small>
                          {complete}/{count.length}{" "}
                          {count.length > 0 && complete === count.length
                            ? "✓"
                            : ""}
                        </small>
                      </button>
                    );
                  })}
                </div>
              ))}
              <button
                className="text-button checklist-reset-all"
                onClick={() => reset(true)}
              >
                Reset all checklists
              </button>
            </>
          )}
        </nav>
        <main className="checklist-content">
          {list ? (
            <>
              <div className="checklist-list-heading">
                <div>
                  <h3>{list.title || "Untitled checklist"}</h3>
                  <p role="status">
                    {done} of {checks.length} checked
                    {skipped ? ` · ${skipped} skipped` : ""}
                    {checks.length > 0 && done === checks.length
                      ? " · Checklist complete"
                      : ""}
                  </p>
                </div>
                <button className="button small" onClick={() => reset(false)}>
                  <ArrowCounterClockwise size={16} aria-hidden="true" /> Reset
                  checklist
                </button>
              </div>
              {sectionExtras?.(list.objectId)}
              <progress
                aria-label="Checklist progress"
                max={checks.length || 1}
                value={done}
              />
              {checks.length > 0 && (
                <div className="checklist-quick-actions">
                  <span>
                    {nextItem
                      ? `Next: ${nextItem.title || "Untitled item"}`
                      : skipped
                        ? "Review skipped items before completing"
                        : "All items checked"}
                  </span>
                  <button
                    className="button"
                    disabled={!nextItem}
                    onClick={() =>
                      nextItem && toggle(nextItem.objectId, "skipped")
                    }
                  >
                    Skip next item
                  </button>
                  <button
                    className="button primary"
                    disabled={!nextItem}
                    onClick={() =>
                      nextItem && toggle(nextItem.objectId, "checked")
                    }
                  >
                    <Check size={18} weight="bold" aria-hidden="true" /> Check
                    next item
                  </button>
                </div>
              )}
              <div className="checklist-items">
                {list.items.map((item) =>
                  item.type === "comment" ? (
                    <div key={item.objectId} className="checklist-note">
                      {item.title && <h4>{item.title}</h4>}
                      {item.detail && <p>{item.detail}</p>}
                      {item.note && <p>{item.note}</p>}
                      {!item.title && !item.detail && !item.note && <hr />}
                    </div>
                  ) : (
                    <div
                      key={item.objectId}
                      className={`checklist-check ${progress[item.objectId] ?? "pending"} ${nextItem?.objectId === item.objectId ? "next-item" : ""}`}
                    >
                      <button
                        className="checklist-check-button"
                        role="checkbox"
                        aria-checked={progress[item.objectId] === "checked"}
                        onClick={() => toggle(item.objectId, "checked")}
                      >
                        <span className="checklist-box" aria-hidden="true">
                          {progress[item.objectId] === "checked" ? (
                            <Check size={18} weight="bold" aria-hidden="true" />
                          ) : (
                            ""
                          )}
                        </span>
                        <span className="checklist-challenge">
                          {item.title || "Untitled item"}
                        </span>
                        {item.detail && (
                          <>
                            <span
                              className="checklist-leader"
                              aria-hidden="true"
                            />
                            <strong className="checklist-response">
                              {item.detail}
                            </strong>
                          </>
                        )}
                      </button>
                      <button
                        className="checklist-skip"
                        aria-label={`${progress[item.objectId] === "skipped" ? "Unskip" : "Skip"} ${item.title || "item"}`}
                        aria-pressed={progress[item.objectId] === "skipped"}
                        onClick={() => toggle(item.objectId, "skipped")}
                      >
                        {progress[item.objectId] === "skipped"
                          ? "Skipped"
                          : "Skip"}
                      </button>
                      {item.note && (
                        <p className="checklist-item-note">{item.note}</p>
                      )}
                      {!!item.actions?.length && (
                        <p className="checklist-item-note">
                          This entry contains additional source actions; they
                          are retained for export but are not executed here.
                        </p>
                      )}
                    </div>
                  ),
                )}
              </div>
              {sectionEndExtras?.(list.objectId)}
              <footer className="checklist-next">
                <button
                  className="button"
                  disabled={index <= 0}
                  onClick={() => setList(lists[index - 1].objectId)}
                >
                  <CaretLeft size={17} aria-hidden="true" /> Previous checklist
                </button>
                <span>
                  {index + 1} / {lists.length}
                </span>
                <button
                  className="button primary"
                  disabled={index >= lists.length - 1}
                  onClick={() => setList(lists[index + 1].objectId)}
                >
                  Next checklist{" "}
                  <CaretRight size={17} weight="bold" aria-hidden="true" />
                </button>
              </footer>
            </>
          ) : (
            <EmptyState title="No checklists in this category">
              {onEdit
                ? "Use Edit checklist to add a group and checklist."
                : "Choose another category."}
            </EmptyState>
          )}
        </main>
      </div>
      <p className="checklist-progress-note">
        Revision {record.version} · Checkmarks and skips are personal to this
        user and browser. Skipped items remain incomplete.
      </p>
    </section>
  );
}
export function Checklists() {
  const { snapshot: s, online, connected, namespace } = useWorkspace();
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [browse, setBrowse] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ChecklistRecord>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const program = activeProgram(s!);
  const records = (s!.checklists ?? []).filter(
    (r) =>
      checklistReadable(s!, r) &&
      (!filter || !r.aircraftUuid || r.aircraftUuid === filter),
  );
  const readable = (s!.checklists ?? []).filter((r) =>
    checklistReadable(s!, r),
  );
  const current = readable.find((r) => r.uuid === selected) ?? readable[0];
  const libraryRecords = records.filter((r) => {
    const metadata = r.document.payload.metadata;
    const registration =
      s!.aircraft.find((a) => a.uuid === r.aircraftUuid)?.registration ?? "";
    return `${metadata.name} ${metadata.tailNumber} ${metadata.detail} ${registration} ${r.sourceName}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  });
  const library = (
    <div className="checklist-library-list ops-checklist-library">
      <h3>Checklists</h3>
      <SearchField
        label="Search checklists"
        value={search}
        onChange={setSearch}
        placeholder="Name or registration"
      />
      <OpsSelect
        label="Filter checklist aircraft"
        icon={Airplane}
        value={filter}
        onChange={setFilter}
      >
        <option value="">All accessible aircraft</option>
        {s!.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </OpsSelect>
      {libraryRecords.map((r) => (
        <button
          key={r.uuid}
          className="checklist-library-entry"
          aria-current={r.uuid === current?.uuid ? "page" : undefined}
          onClick={() => {
            setSelected(r.uuid);
            setBrowse(false);
          }}
        >
          <IconTile icon={ListChecks} size="sm" />
          <span>
            <strong>
              {r.document.payload.metadata.name ||
                r.sourceName ||
                "Untitled checklist"}
            </strong>
            <small>
              {s!.aircraft.find((a) => a.uuid === r.aircraftUuid)
                ?.registration ||
                r.document.payload.metadata.tailNumber ||
                "Flight Program library"}{" "}
              · {checklistCounts(r.document).lists} sections
            </small>
          </span>
          <CaretRight size={16} aria-hidden="true" />
        </button>
      ))}
      {!libraryRecords.length && (
        <p className="ops-checklist-library-empty">No matching checklists.</p>
      )}
    </div>
  );
  const canCreate =
    !!program &&
    (checklistEditable(s!, "", program) ||
      s!.aircraft.some((a) => checklistEditable(s!, a.uuid, program)));
  const writable = online && connected && canCreate;
  const draft = (
    document = emptyChecklist(),
    sourceName = "",
  ): ChecklistRecord => {
    const tail =
      document.payload.metadata.tailNumber?.trim().toUpperCase() ||
      document.payload.metadata.name?.trim().toUpperCase();
    const aircraft = s!.aircraft.filter((a) =>
      checklistEditable(s!, a.uuid, program),
    );
    return {
      uuid: crypto.randomUUID(),
      version: 0,
      programUuid: program!,
      aircraftUuid:
        aircraft.find((a) => a.registration.toUpperCase() === tail)?.uuid ??
        (checklistEditable(s!, "", program) ? "" : (aircraft[0]?.uuid ?? "")),
      sourceName,
      updatedAt: Date.now(),
      updatedBy: s!.user.id,
      document,
    };
  };
  return (
    <div className="ops-page ops-checklists">
      <PageHeader
        eyebrow="FLIGHT OPERATIONS"
        title="Checklists"
        description="Aircraft-specific checklists pilots run before, during and after each flight."
        actions={
          <>
            <button
              className="button"
              disabled={!writable || loading}
              onClick={() => fileInput.current?.click()}
            >
              <UploadSimple size={18} aria-hidden="true" />{" "}
              {loading ? "Reading file…" : "Import .fmd"}
            </button>
            <button
              className="button primary"
              disabled={!writable}
              onClick={() => setEditing(draft())}
            >
              <Plus size={18} weight="bold" aria-hidden="true" /> New checklist
            </button>
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".fmd"
        aria-label="Import FMD checklist file"
        className="checklist-file-input"
        tabIndex={-1}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setLoading(true);
          setError("");
          try {
            if (
              !file.name.toLowerCase().endsWith(".fmd") ||
              file.size > 2 * 1024 * 1024
            )
              throw new Error("Choose a ForeFlight .fmd checklist under 2 MB.");
            const document = await importFmd(await file.arrayBuffer());
            if (!document.payload.metadata.name)
              document.payload.metadata.name = file.name.replace(/\.fmd$/i, "");
            setEditing(draft(document, file.name));
          } catch (err) {
            setError(errorText(err, "Import failed."));
          } finally {
            setLoading(false);
          }
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <GuidedFlight
        selectedChecklist={current}
        onSelectChecklist={setSelected}
        key={`${namespace}:${s!.user.id}:${program}`}
        records={(s!.checklists ?? []).filter((r) => checklistReadable(s!, r))}
      />
      {current ? (
        <ChecklistReader
          key={`${namespace}:${s!.user.id}:${current.uuid}:${current.version}`}
          record={current}
          library={browse ? library : undefined}
          onBrowse={() => setBrowse(!browse)}
          onEdit={
            writable &&
            checklistEditable(s!, current.aircraftUuid, current.programUuid)
              ? () => setEditing(current)
              : undefined
          }
        />
      ) : (
        <EmptyState title="Your checklist library is ready">
          Import a ForeFlight .fmd file or create a checklist to get started.
        </EmptyState>
      )}
      {editing && (
        <ChecklistEditor
          key={editing.uuid}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(uuid) => {
            setSelected(uuid);
            setBrowse(false);
            setFilter("");
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

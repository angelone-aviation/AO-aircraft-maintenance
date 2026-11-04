/**
 * Responsibility: The checklists screen: browsing, reading, importing,
 *   exporting and editing ForeFlight checklists.
 * Layer: UI. React components; .fmd files are read and written in src/data.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/fmd.ts, src/domain/checklists.ts, src/domain/model.ts (types),
 *   src/domain/programs.ts, ./GuidedFlight, ./ChecklistEditor, ./OpsList,
 *   ./design, ./ui, ./checklists.css, src/styles/screens/operations.css.
 */
import { GuidedFlight } from "./GuidedFlight";
import {
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
  type ChecklistDocument,
  type ChecklistItem,
  type ChecklistList,
  type ChecklistRecord,
} from "../domain/checklists";
import type { Snapshot } from "../domain/model";
import { importFmd, exportFmd } from "../data/fmd";
import { ChecklistEditor } from "./ChecklistEditor";
import { EmptyState, IconTile, PageHeader, SearchField } from "./design";
import { OpsSelect } from "./OpsList";
import { errorText } from "./ui";
import "./checklists.css";
import "../styles/screens/operations.css";

// importFmd's limit, checked before the file is read.
const FMD_MAX_BYTES = 2 * 1024 * 1024;
// Long enough for the browser to start the download.
const EXPORT_URL_LIFETIME_MS = 1000;

/** A user's marks on a checklist set's entries, by entry objectId. */
export type Progress = Record<string, "checked" | "skipped">;
type Mark = Progress[string];
type Category = ChecklistDocument["payload"]["groups"][number];
type ReaderProps = {
  record: ChecklistRecord;
  library?: ReactNode;
  onBrowse?: () => void;
  onEdit?: () => void;
  progress?: Progress;
  onProgress?: (progress: Progress) => void;
  initialList?: string;
  sectionExtras?: (listId: string) => ReactNode;
  sectionEndExtras?: (listId: string) => ReactNode;
};
type Reader = ReturnType<typeof useReader>;
type LibraryView = ReturnType<typeof useLibraryView>;

/**
 * Runs one checklist set: categories, a list per section, and check and skip
 * marks with the next open entry. Marks are personal to the user, browser,
 * set and revision, kept in local storage unless the caller keeps them.
 *
 * @param props.library - Shown instead of the section list, with a
 *   Checklists button (`onBrowse`) to toggle it.
 * @param props.onEdit - Offers Edit checklist when given.
 * @param props.progress - Marks the caller keeps; changes go to
 *   `onProgress` instead of storage.
 * @param props.initialList - The list to open on, in its category.
 * @param props.sectionExtras - Content shown above a list's entries, and
 *   `sectionEndExtras` below them.
 */
export function ChecklistReader(props: ReaderProps) {
  const r = useReader(props);
  return (
    <section className="checklist-reader" aria-label="Interactive checklist">
      <ReaderBanner {...props} onError={r.setError} />
      <CategoryTabs r={r} />
      {r.error && (
        <p role="alert" className="error">
          {r.error}
        </p>
      )}
      <div className="checklist-workspace">
        <ReaderNav r={r} library={props.library} />
        <main className="checklist-content">
          {r.list ? (
            <ListView r={r} list={r.list} {...props} />
          ) : (
            <EmptyState title="No checklists in this category">
              {props.onEdit
                ? "Use Edit checklist to add a group and checklist."
                : "Choose another category."}
            </EmptyState>
          )}
        </main>
      </div>
      <p className="checklist-progress-note">
        Revision {props.record.version} · Checkmarks and skips are personal to
        this user and browser. Skipped items remain incomplete.
      </p>
    </section>
  );
}

/**
 * The Checklists screen: the active program's readable checklist sets, with a
 * searchable library, guided flight, and (connected, with edit access) new
 * and imported .fmd checklists for the editor.
 */
export function Checklists() {
  const { snapshot, online, connected, namespace } = useWorkspace();
  const s = snapshot!;
  const view = useLibraryView();
  const [editing, setEditing] = useState<ChecklistRecord>();
  const program = activeProgram(s);
  const draft = (document?: ChecklistDocument, sourceName?: string) =>
    setEditing(draftChecklist(s, program, document, sourceName));
  const readable = (s.checklists ?? []).filter((r) => checklistReadable(s, r));
  const current = readable.find((r) => r.uuid === view.selected) ?? readable[0];
  const writable = online && connected && canCreateChecklist(s, program);
  return (
    <div className="ops-page ops-checklists">
      <ChecklistActions writable={writable} onDraft={draft} />
      <GuidedFlight
        selectedChecklist={current}
        onSelectChecklist={view.setSelected}
        key={`${namespace}:${s.user.id}:${program}`}
        records={readable}
      />
      <CurrentChecklist
        s={s}
        current={current}
        view={view}
        onEdit={writable ? setEditing : undefined}
      />
      {editing && (
        <ChecklistEditor
          key={editing.uuid}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(uuid) => {
            view.reopen(uuid);
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

// Marks that cannot be read start the set over; storage holds only marks.
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
    // Damaged JSON or blocked storage: no marks rather than a broken reader.
    return {};
  }
}

function useReader(props: ReaderProps) {
  const store = useStoredProgress(props);
  const nav = useReaderNav(props.record, props.initialList);
  const marks = listMarks(nav.list, store.progress);
  const toggle = (id: string, mark: Mark) =>
    store.persist(toggled(store.progress, id, mark));
  const reset = (all: boolean) => {
    if (
      !window.confirm(
        all
          ? "Reset all personal checkmarks in this checklist set?"
          : "Reset personal checkmarks in this checklist?",
      )
    )
      return;
    const next = { ...store.progress };
    if (all) return store.persist({});
    for (const i of marks.checks) delete next[i.objectId];
    store.persist(next);
  };
  return { ...store, ...nav, ...marks, toggle, reset };
}

function useStoredProgress({ record, progress, onProgress }: ReaderProps) {
  const { namespace, snapshot: s } = useWorkspace();
  const key = `angel-one-checks:${namespace}:${s!.user.id}:${record.uuid}:${record.version}`;
  const [stored, setStored] = useState<Progress>(() => readProgress(key));
  const [error, setError] = useState("");
  const persist = (next: Progress) => {
    if (onProgress) {
      onProgress(next);
      return;
    }
    setStored(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setError("");
    } catch {
      // Full or blocked storage: the marks last until the page reloads.
      setError(
        "Browser storage is unavailable. These checkmarks will not survive a reload.",
      );
    }
  };
  return { progress: progress ?? stored, persist, error, setError };
}

function useReaderNav(record: ChecklistRecord, initialList?: string) {
  const categories = record.document.payload.groups;
  const initial = initialCategory(categories, initialList);
  const [categoryId, setCategory] = useState(initial?.objectId ?? "");
  const [listId, setList] = useState(
    initialList ?? listsOf(initial)[0]?.objectId ?? "",
  );
  const category = categories.find((c) => c.objectId === categoryId);
  const lists = listsOf(category);
  const list = lists.find((l) => l.objectId === listId) ?? lists[0];
  const index = lists.findIndex((l) => l.objectId === list?.objectId);
  const chooseCategory = (c: Category) => {
    setCategory(c.objectId);
    setList(listsOf(c)[0]?.objectId ?? "");
  };
  const position = { categoryId, category, lists, list, index };
  return { categories, ...position, setList, chooseCategory };
}

// Opens on the category holding initialList, else the first with a list.
function initialCategory(categories: Category[], initialList?: string) {
  return (
    categories.find((c) =>
      c.items.some((g) => g.items.some((l) => l.objectId === initialList)),
    ) ??
    categories.find((c) => c.items.some((g) => g.items.length)) ??
    categories[0]
  );
}

function listsOf(category?: Category) {
  return category?.items.flatMap((g) => g.items) ?? [];
}

// Comments are not checks. A skipped check is never next, but leaves the
// list incomplete.
function listMarks(list: ChecklistList | undefined, progress: Progress) {
  const checks = list?.items.filter((i) => i.type !== "comment") ?? [];
  const count = (mark: Mark) =>
    checks.filter((i) => progress[i.objectId] === mark).length;
  const nextItem = checks.find(
    (i) =>
      progress[i.objectId] !== "checked" && progress[i.objectId] !== "skipped",
  );
  return {
    checks,
    done: count("checked"),
    skipped: count("skipped"),
    nextItem,
  };
}

// Marking an entry the way it is already marked clears the mark.
function toggled(progress: Progress, id: string, mark: Mark): Progress {
  const next = { ...progress };
  if (next[id] === mark) delete next[id];
  else next[id] = mark;
  return next;
}

function ReaderBanner({
  record,
  library,
  onBrowse,
  onEdit,
  onError,
}: ReaderProps & { onError: (error: string) => void }) {
  return (
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
        <BannerTitle record={record} />
      </div>
      <div className="management-actions ops-checklist-banner-actions">
        {onEdit && (
          <button className="button" onClick={onEdit}>
            <PencilSimple size={17} aria-hidden="true" /> Edit checklist
          </button>
        )}
        <ExportButton record={record} onError={onError} />
      </div>
    </header>
  );
}

function BannerTitle({ record }: { record: ChecklistRecord }) {
  const { snapshot: s } = useWorkspace();
  const { metadata } = record.document.payload;
  return (
    <>
      <span className="eyebrow">
        {metadata.tailNumber ||
          s!.aircraft.find((a) => a.uuid === record.aircraftUuid)
            ?.registration ||
          "Flight Program library"}
      </span>
      <h2>{metadata.name || record.sourceName || "Untitled checklist"}</h2>
      <p>{metadata.detail}</p>
    </>
  );
}

function ExportButton({
  record,
  onError,
}: {
  record: ChecklistRecord;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await downloadFmd(record.document);
    } catch (e) {
      onError(errorText(e, "Export failed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="button" disabled={busy} onClick={run}>
      <DownloadSimple size={17} aria-hidden="true" /> Export .fmd
    </button>
  );
}

async function downloadFmd(checklist: ChecklistDocument) {
  const blob = await exportFmd(checklist);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(checklist.payload.metadata.name || "checklist").replace(/[^a-zA-Z0-9 _.-]/g, "_")}.fmd`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
}

function CategoryTabs({ r }: { r: Reader }) {
  return (
    <div className="checklist-categories" aria-label="Checklist categories">
      {r.categories.map((c) => (
        <button
          key={c.objectId}
          className={`checklist-category ${c.groupType}`}
          aria-pressed={c.objectId === r.categoryId}
          onClick={() => r.chooseCategory(c)}
        >
          {c.groupType}
          <span>{c.items.reduce((n, g) => n + g.items.length, 0)}</span>
        </button>
      ))}
    </div>
  );
}

function ReaderNav({ r, library }: { r: Reader; library?: ReactNode }) {
  return (
    <nav
      className="checklist-nav"
      aria-label={library ? "Checklist library" : "Checklist sections"}
    >
      {library ?? (
        <>
          {r.category?.items.map((g) => (
            <div key={g.objectId}>
              <h3>{g.title || "Untitled group"}</h3>
              {g.items.map((l) => (
                <SectionButton key={l.objectId} r={r} list={l} />
              ))}
            </div>
          ))}
          <button
            className="text-button checklist-reset-all"
            onClick={() => r.reset(true)}
          >
            Reset all checklists
          </button>
        </>
      )}
    </nav>
  );
}

function SectionButton({ r, list: l }: { r: Reader; list: ChecklistList }) {
  const checks = l.items.filter((i) => i.type !== "comment");
  const complete = checks.filter(
    (i) => r.progress[i.objectId] === "checked",
  ).length;
  return (
    <button
      aria-current={r.list?.objectId === l.objectId ? "page" : undefined}
      onClick={() => r.setList(l.objectId)}
    >
      <span>{l.title || "Untitled checklist"}</span>
      <small>
        {complete}/{checks.length}{" "}
        {checks.length > 0 && complete === checks.length ? "✓" : ""}
      </small>
    </button>
  );
}

function ListView({
  r,
  list,
  sectionExtras,
  sectionEndExtras,
}: ReaderProps & { r: Reader; list: ChecklistList }) {
  return (
    <>
      <ListHeading r={r} list={list} />
      {sectionExtras?.(list.objectId)}
      <progress
        aria-label="Checklist progress"
        max={r.checks.length || 1}
        value={r.done}
      />
      {r.checks.length > 0 && <QuickActions r={r} />}
      <div className="checklist-items">
        {list.items.map((item) =>
          item.type === "comment" ? (
            <ChecklistNote key={item.objectId} item={item} />
          ) : (
            <ChecklistCheck key={item.objectId} r={r} item={item} />
          ),
        )}
      </div>
      {sectionEndExtras?.(list.objectId)}
      <ListPager r={r} />
    </>
  );
}

function ListHeading({ r, list }: { r: Reader; list: ChecklistList }) {
  const complete = r.checks.length > 0 && r.done === r.checks.length;
  return (
    <div className="checklist-list-heading">
      <div>
        <h3>{list.title || "Untitled checklist"}</h3>
        <p role="status">
          {r.done} of {r.checks.length} checked
          {r.skipped ? ` · ${r.skipped} skipped` : ""}
          {complete ? " · Checklist complete" : ""}
        </p>
      </div>
      <button className="button small" onClick={() => r.reset(false)}>
        <ArrowCounterClockwise size={16} aria-hidden="true" /> Reset checklist
      </button>
    </div>
  );
}

function QuickActions({ r }: { r: Reader }) {
  const next = r.nextItem;
  return (
    <div className="checklist-quick-actions">
      <span>{nextLabel(r)}</span>
      <button
        className="button"
        disabled={!next}
        onClick={() => next && r.toggle(next.objectId, "skipped")}
      >
        Skip next item
      </button>
      <button
        className="button primary"
        disabled={!next}
        onClick={() => next && r.toggle(next.objectId, "checked")}
      >
        <Check size={18} weight="bold" aria-hidden="true" /> Check next item
      </button>
    </div>
  );
}

function nextLabel({ nextItem, skipped }: Reader) {
  if (nextItem) return `Next: ${nextItem.title || "Untitled item"}`;
  return skipped
    ? "Review skipped items before completing"
    : "All items checked";
}

function ChecklistNote({ item }: { item: ChecklistItem }) {
  return (
    <div className="checklist-note">
      {item.title && <h4>{item.title}</h4>}
      {item.detail && <p>{item.detail}</p>}
      {item.note && <p>{item.note}</p>}
      {!item.title && !item.detail && !item.note && <hr />}
    </div>
  );
}

function ChecklistCheck({ r, item }: { r: Reader; item: ChecklistItem }) {
  const mark = r.progress[item.objectId];
  const next = r.nextItem?.objectId === item.objectId ? "next-item" : "";
  return (
    <div className={`checklist-check ${mark ?? "pending"} ${next}`}>
      <button
        className="checklist-check-button"
        role="checkbox"
        aria-checked={mark === "checked"}
        onClick={() => r.toggle(item.objectId, "checked")}
      >
        <span className="checklist-box" aria-hidden="true">
          {mark === "checked" ? (
            <Check size={18} weight="bold" aria-hidden="true" />
          ) : (
            ""
          )}
        </span>
        <CheckText item={item} />
      </button>
      <SkipButton r={r} item={item} />
      {item.note && <p className="checklist-item-note">{item.note}</p>}
      {!!item.actions?.length && (
        <p className="checklist-item-note">
          This entry contains additional source actions; they are retained for
          export but are not executed here.
        </p>
      )}
    </div>
  );
}

function CheckText({ item }: { item: ChecklistItem }) {
  return (
    <>
      <span className="checklist-challenge">
        {item.title || "Untitled item"}
      </span>
      {item.detail && (
        <>
          <span className="checklist-leader" aria-hidden="true" />
          <strong className="checklist-response">{item.detail}</strong>
        </>
      )}
    </>
  );
}

function SkipButton({ r, item }: { r: Reader; item: ChecklistItem }) {
  const skipped = r.progress[item.objectId] === "skipped";
  return (
    <button
      className="checklist-skip"
      aria-label={`${skipped ? "Unskip" : "Skip"} ${item.title || "item"}`}
      aria-pressed={skipped}
      onClick={() => r.toggle(item.objectId, "skipped")}
    >
      {skipped ? "Skipped" : "Skip"}
    </button>
  );
}

function ListPager({ r: { lists, index, setList } }: { r: Reader }) {
  return (
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
        Next checklist <CaretRight size={17} weight="bold" aria-hidden="true" />
      </button>
    </footer>
  );
}

function useLibraryView() {
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [browse, setBrowse] = useState(true);
  const [search, setSearch] = useState("");
  const open = (uuid: string) => {
    setSelected(uuid);
    setBrowse(false);
  };
  // A saved set opens with the aircraft filter cleared, so it is listed.
  const reopen = (uuid: string) => {
    open(uuid);
    setFilter("");
  };
  const state = { selected, filter, browse, search };
  return {
    ...state,
    setSelected,
    setFilter,
    setBrowse,
    setSearch,
    open,
    reopen,
  };
}

function canCreateChecklist(s: Snapshot, program?: string) {
  return (
    !!program &&
    (checklistEditable(s, "", program) ||
      s.aircraft.some((a) => checklistEditable(s, a.uuid, program)))
  );
}

// A new set goes to the editable aircraft whose registration matches its tail
// number (or, failing that, its name); otherwise to the program library when
// the user may edit it, else to the first editable aircraft.
function draftChecklist(
  s: Snapshot,
  program: string | undefined,
  document = emptyChecklist(),
  sourceName = "",
): ChecklistRecord {
  const { tailNumber, name } = document.payload.metadata;
  const tail = tailNumber?.trim().toUpperCase() || name?.trim().toUpperCase();
  const aircraft = s.aircraft.filter((a) =>
    checklistEditable(s, a.uuid, program),
  );
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: program!,
    aircraftUuid:
      aircraft.find((a) => a.registration.toUpperCase() === tail)?.uuid ??
      (checklistEditable(s, "", program) ? "" : (aircraft[0]?.uuid ?? "")),
    sourceName,
    updatedAt: Date.now(),
    updatedBy: s.user.id,
    document,
  };
}

function useFmdImport(
  onImported: (document: ChecklistDocument, fileName: string) => void,
) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      onImported(await readFmdFile(file), file.name);
    } catch (err) {
      setError(errorText(err, "Import failed."));
    } finally {
      setLoading(false);
    }
  }
  return { error, loading, onChange };
}

// A set without a name takes the file's.
async function readFmdFile(file: File) {
  if (!file.name.toLowerCase().endsWith(".fmd") || file.size > FMD_MAX_BYTES)
    throw new Error("Choose a ForeFlight .fmd checklist under 2 MB.");
  const document = await importFmd(await file.arrayBuffer());
  if (!document.payload.metadata.name)
    document.payload.metadata.name = file.name.replace(/\.fmd$/i, "");
  return document;
}

function ChecklistActions({
  writable,
  onDraft,
}: {
  writable: boolean;
  onDraft: (document?: ChecklistDocument, sourceName?: string) => void;
}) {
  const fmd = useFmdImport(onDraft);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <ChecklistsHeader
        writable={writable}
        loading={fmd.loading}
        onImport={() => fileInput.current?.click()}
        onNew={() => onDraft()}
      />
      <FmdInput inputRef={fileInput} fmd={fmd} />
    </>
  );
}

function ChecklistsHeader({
  writable,
  loading,
  onImport,
  onNew,
}: {
  writable: boolean;
  loading: boolean;
  onImport: () => void;
  onNew: () => void;
}) {
  return (
    <PageHeader
      eyebrow="FLIGHT OPERATIONS"
      title="Checklists"
      description="Aircraft-specific checklists pilots run before, during and after each flight."
      actions={
        <>
          <button
            className="button"
            disabled={!writable || loading}
            onClick={onImport}
          >
            <UploadSimple size={18} aria-hidden="true" />{" "}
            {loading ? "Reading file…" : "Import .fmd"}
          </button>
          <button
            className="button primary"
            disabled={!writable}
            onClick={onNew}
          >
            <Plus size={18} weight="bold" aria-hidden="true" /> New checklist
          </button>
        </>
      }
    />
  );
}

function FmdInput({
  inputRef,
  fmd,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  fmd: ReturnType<typeof useFmdImport>;
}) {
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".fmd"
        aria-label="Import FMD checklist file"
        className="checklist-file-input"
        tabIndex={-1}
        onChange={fmd.onChange}
      />
      {fmd.error && (
        <p className="error" role="alert">
          {fmd.error}
        </p>
      )}
    </>
  );
}

function CurrentChecklist({
  s,
  current,
  view,
  onEdit,
}: {
  s: Snapshot;
  current?: ChecklistRecord;
  view: LibraryView;
  onEdit?: (record: ChecklistRecord) => void;
}) {
  const { namespace } = useWorkspace();
  if (!current)
    return (
      <EmptyState title="Your checklist library is ready">
        Import a ForeFlight .fmd file or create a checklist to get started.
      </EmptyState>
    );
  const editable =
    onEdit && checklistEditable(s, current.aircraftUuid, current.programUuid);
  return (
    <ChecklistReader
      key={`${namespace}:${s.user.id}:${current.uuid}:${current.version}`}
      record={current}
      library={
        view.browse ? (
          <ChecklistLibrary s={s} current={current} view={view} />
        ) : undefined
      }
      onBrowse={() => view.setBrowse(!view.browse)}
      onEdit={editable ? () => onEdit(current) : undefined}
    />
  );
}

function ChecklistLibrary({
  s,
  current,
  view,
}: {
  s: Snapshot;
  current?: ChecklistRecord;
  view: LibraryView;
}) {
  const shown = libraryRecords(s, view.filter, view.search);
  return (
    <div className="checklist-library-list ops-checklist-library">
      <h3>Checklists</h3>
      <SearchField
        label="Search checklists"
        value={view.search}
        onChange={view.setSearch}
        placeholder="Name or registration"
      />
      <AircraftFilter s={s} value={view.filter} onChange={view.setFilter} />
      {shown.map((r) => (
        <LibraryEntry
          key={r.uuid}
          s={s}
          record={r}
          current={r.uuid === current?.uuid}
          onOpen={() => view.open(r.uuid)}
        />
      ))}
      {!shown.length && (
        <p className="ops-checklist-library-empty">No matching checklists.</p>
      )}
    </div>
  );
}

function AircraftFilter({
  s,
  value,
  onChange,
}: {
  s: Snapshot;
  value: string;
  onChange: (aircraftUuid: string) => void;
}) {
  return (
    <OpsSelect
      label="Filter checklist aircraft"
      icon={Airplane}
      value={value}
      onChange={onChange}
    >
      <option value="">All accessible aircraft</option>
      {s.aircraft.map((a) => (
        <option key={a.uuid} value={a.uuid}>
          {a.registration}
        </option>
      ))}
    </OpsSelect>
  );
}

// Program library sets show under every aircraft filter.
function libraryRecords(s: Snapshot, filter: string, search: string) {
  const text = search.trim().toLowerCase();
  return (s.checklists ?? []).filter((r) => {
    if (!checklistReadable(s, r)) return false;
    if (filter && r.aircraftUuid && r.aircraftUuid !== filter) return false;
    const { name, tailNumber, detail } = r.document.payload.metadata;
    const registration =
      s.aircraft.find((a) => a.uuid === r.aircraftUuid)?.registration ?? "";
    return `${name} ${tailNumber} ${detail} ${registration} ${r.sourceName}`
      .toLowerCase()
      .includes(text);
  });
}

function LibraryEntry({
  s,
  record: r,
  current,
  onOpen,
}: {
  s: Snapshot;
  record: ChecklistRecord;
  current: boolean;
  onOpen: () => void;
}) {
  const { metadata } = r.document.payload;
  return (
    <button
      className="checklist-library-entry"
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
    >
      <IconTile icon={ListChecks} size="sm" />
      <span>
        <strong>{metadata.name || r.sourceName || "Untitled checklist"}</strong>
        <small>
          {s.aircraft.find((a) => a.uuid === r.aircraftUuid)?.registration ||
            metadata.tailNumber ||
            "Flight Program library"}{" "}
          · {checklistCounts(r.document).lists} sections
        </small>
      </span>
      <CaretRight size={16} aria-hidden="true" />
    </button>
  );
}

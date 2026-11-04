/**
 * Responsibility: The checklist set editor: details, categories, groups,
 *   checklists and entries, edited as a draft and saved as one new revision.
 * Layer: UI. React component; the set saves through the workspace backend.
 * Dependencies: react, src/data/store.ts, src/domain/checklists.ts,
 *   src/domain/model.ts (Snapshot), ./ui.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import {
  checklistEditable,
  checklistId,
  checklistCounts,
  type ChecklistDocument,
  type ChecklistRecord,
  type ChecklistItem,
} from "../domain/checklists";
import type { Snapshot } from "../domain/model";
import { AsyncForm, Field, Modal } from "./ui";

/** fmdSchema allows one category of each type. */
const CATEGORY_TYPES = ["normal", "abnormal", "emergency"] as const;
/** fmdSchema's limit on every title, detail and note. */
const TEXT_MAX_LENGTH = 20000;
const DETAIL_FIELDS = [
  { key: "name", label: "Checklist name", maxLength: 200, required: true },
  { key: "tailNumber", label: "Tail number", maxLength: 100, required: false },
  {
    key: "detail",
    label: "Aircraft description",
    maxLength: 500,
    required: false,
  },
] as const;
const ENTRY_TEXT_FIELDS = [
  ["title", "challenge / heading"],
  ["detail", "response / detail"],
  ["note", "note"],
] as const;

type Draft = ReturnType<typeof useChecklistDraft>;
type Selection = ReturnType<typeof selectionIn>;
type EditorProps = {
  initial: ChecklistRecord;
  onClose: () => void;
  onSaved: (uuid: string) => void;
};
type OutlineProps = {
  noun: "group" | "checklist";
  label: string;
  title: string;
  first: boolean;
  last: boolean;
  onTitle: (title: string) => void;
  onMove: (step: number) => void;
  onDelete: () => void;
};
type EntryProps = {
  draft: Draft;
  item: ChecklistItem;
  index: number;
  count: number;
};

/**
 * Edits a checklist set as a draft: its name, tail number, description and
 * aircraft, and its categories, groups, checklists and entries.
 *
 * @param props.initial - The set; version 0 is a new or imported one.
 * @param props.onClose - Called on close, after "Discard unsaved checklist
 *   changes?" is confirmed when the draft has changes.
 * @param props.onSaved - Receives the set's uuid once it is saved.
 * @returns The editor dialog. Saving needs a connection and refuses a blank
 *   name ("Enter a checklist name."). Leaving the page with unsaved changes
 *   asks the browser to confirm.
 */
export function ChecklistEditor({ initial, onClose, onSaved }: EditorProps) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const draft = useChecklistDraft(initial);
  const { record } = draft;
  const close = () => {
    if (!draft.dirty || window.confirm("Discard unsaved checklist changes?"))
      onClose();
  };
  return (
    <Modal
      title={initial.version ? "Edit checklist" : "Import / create checklist"}
      wide
      onClose={close}
    >
      <AsyncForm
        submitLabel="Save checklist"
        disabled={!online || !connected}
        onSubmit={async () => {
          await backend!.saveChecklist(saveCommand(record, initial.version));
          onSaved(record.uuid);
        }}
      >
        <DraftCounts document={record.document} />
        <DetailFields s={s!} draft={draft} />
        <SelectionFields draft={draft} />
        <AddButtons draft={draft} />
        {draft.group && <GroupSection draft={draft} />}
        {draft.list && <ListSection draft={draft} />}
      </AsyncForm>
    </Modal>
  );
}

function useChecklistDraft(initial: ChecklistRecord) {
  const first = initial.document.payload.groups[0]?.items[0];
  const [record, setRecord] = useState(() => structuredClone(initial));
  const [dirty, setDirty] = useState(initial.version === 0);
  const [categoryIndex, setCategory] = useState(0);
  const [groupId, setGroup] = useState(first?.objectId ?? "");
  const [listId, setList] = useState(first?.items[0]?.objectId ?? "");
  useLeaveWarning(dirty);
  const patch = (change: (doc: ChecklistDocument) => void) => {
    setRecord((current) => {
      const next = structuredClone(current);
      change(next.document);
      return next;
    });
    setDirty(true);
  };
  return {
    ...selectionIn(record.document, categoryIndex, groupId, listId),
    record,
    dirty,
    patch,
    setRecord,
    setDirty,
    setCategory,
    setGroup,
    setList,
  };
}

// The browser shows its own leave-page prompt; older browsers also need
// returnValue set before they show it.
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

function DraftCounts({ document }: { document: ChecklistDocument }) {
  const counts = checklistCounts(document);
  return (
    <p>
      {counts.lists} checklists · {counts.entries} entries · {counts.checks}{" "}
      checkable items. Changes are saved together. Saving a new revision starts
      fresh personal checkmarks.
    </p>
  );
}

function DetailFields({ s, draft }: { s: Snapshot; draft: Draft }) {
  const { record } = draft;
  const metadata = record.document.payload.metadata;
  return (
    <div className="form-grid">
      {DETAIL_FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          <input
            required={f.required}
            maxLength={f.maxLength}
            value={metadata[f.key] ?? ""}
            onChange={(e) =>
              draft.patch((d) => {
                d.payload.metadata[f.key] = e.target.value;
              })
            }
          />
        </Field>
      ))}
      <AircraftField s={s} draft={draft} />
    </div>
  );
}

function AircraftField({ s, draft }: { s: Snapshot; draft: Draft }) {
  const { record } = draft;
  return (
    <Field label="Checklist aircraft">
      <select
        value={record.aircraftUuid}
        onChange={(e) => {
          draft.setRecord({ ...record, aircraftUuid: e.target.value });
          draft.setDirty(true);
        }}
      >
        {checklistEditable(s, "", record.programUuid) && (
          <option value="">Flight Program library (all aircraft)</option>
        )}
        {s.aircraft
          .filter((a) => checklistEditable(s, a.uuid, record.programUuid))
          .map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
      </select>
    </Field>
  );
}

function SelectionFields({ draft }: { draft: Draft }) {
  const { category, group, list } = draft;
  const titled = (
    items: { objectId: string; title: string }[],
    blank: string,
  ) =>
    items.map((x) => ({
      id: x.objectId,
      value: x.objectId,
      label: x.title || blank,
    }));
  return (
    <div className="checklist-editor-select form-grid">
      <ChoiceField
        label="Checklist category"
        value={draft.categoryIndex}
        options={draft.record.document.payload.groups.map((c, i) => ({
          id: c.objectId,
          value: i,
          label: c.groupType,
        }))}
        onChange={(value) => chooseCategory(draft, Number(value))}
      />
      <ChoiceField
        label="Checklist group"
        value={group?.objectId ?? ""}
        placeholder="Select group"
        options={titled(category?.items ?? [], "Untitled group")}
        onChange={(id) => chooseGroup(draft, id)}
      />
      <ChoiceField
        label="Checklist to edit"
        value={list?.objectId ?? ""}
        placeholder="Select checklist"
        options={titled(group?.items ?? [], "Untitled checklist")}
        onChange={draft.setList}
      />
    </div>
  );
}

function ChoiceField(props: {
  label: string;
  value: string | number;
  placeholder?: string;
  options: { id: string; value: string | number; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={props.label}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.placeholder !== undefined && (
          <option value="">{props.placeholder}</option>
        )}
        {props.options.map((o) => (
          <option key={o.id} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AddButtons({ draft }: { draft: Draft }) {
  const missing = CATEGORY_TYPES.filter(
    (type) =>
      !draft.record.document.payload.groups.some((c) => c.groupType === type),
  );
  return (
    <div className="management-actions">
      {missing.map((type) => (
        <button
          type="button"
          className="button"
          key={type}
          onClick={() => addCategory(draft, type)}
        >
          Add {type} category
        </button>
      ))}
      <button
        type="button"
        className="button"
        disabled={!draft.category}
        onClick={() => addGroup(draft)}
      >
        Add group
      </button>
      <button
        type="button"
        className="button"
        disabled={!draft.group}
        onClick={() => addList(draft)}
      >
        Add checklist
      </button>
    </div>
  );
}

function GroupSection({ draft }: { draft: Draft }) {
  const group = draft.group!;
  const groups = (d: ChecklistDocument) =>
    d.payload.groups[draft.categoryIndex].items;
  return (
    <OutlineSection
      noun="group"
      label="Group title"
      title={group.title}
      first={draft.groupIndex === 0}
      last={draft.groupIndex === draft.category!.items.length - 1}
      onTitle={(title) =>
        draft.patch((d) => {
          groupIn(d, draft).title = title;
        })
      }
      onMove={(step) =>
        draft.patch((d) => move(groups(d), draft.groupIndex, step))
      }
      onDelete={() => {
        if (
          !window.confirm(
            `Delete group “${group.title}” and its checklists from this draft?`,
          )
        )
          return;
        draft.patch((d) => groups(d).splice(draft.groupIndex, 1));
        draft.setGroup("");
        draft.setList("");
      }}
    />
  );
}

function ListSection({ draft }: { draft: Draft }) {
  const list = draft.list!;
  const lists = (d: ChecklistDocument) => groupIn(d, draft).items;
  return (
    <>
      <OutlineSection
        noun="checklist"
        label="Checklist title"
        title={list.title}
        first={draft.listIndex === 0}
        last={draft.listIndex === draft.group!.items.length - 1}
        onTitle={(title) =>
          draft.patch((d) => {
            listIn(d, draft).title = title;
          })
        }
        onMove={(step) =>
          draft.patch((d) => move(lists(d), draft.listIndex, step))
        }
        onDelete={() => {
          if (
            !window.confirm(`Delete checklist “${list.title}” from this draft?`)
          )
            return;
          draft.patch((d) => lists(d).splice(draft.listIndex, 1));
          draft.setList("");
        }}
      />
      <EntryList draft={draft} />
    </>
  );
}

function EntryList({ draft }: { draft: Draft }) {
  const { items } = draft.list!;
  return (
    <>
      <div className="checklist-edit-items">
        {items.map((item, i) => (
          <EntryEditor
            key={item.objectId}
            draft={draft}
            item={item}
            index={i}
            count={items.length}
          />
        ))}
      </div>
      <div className="management-actions">
        <button
          type="button"
          className="button"
          onClick={() => addEntry(draft)}
        >
          Add check item
        </button>
        <button
          type="button"
          className="button"
          onClick={() => addEntry(draft, "comment")}
        >
          Add heading / note
        </button>
      </div>
    </>
  );
}

function OutlineSection(props: OutlineProps) {
  const { noun } = props;
  return (
    <div className="checklist-editor-section">
      <Field label={props.label}>
        <input
          value={props.title}
          maxLength={TEXT_MAX_LENGTH}
          onChange={(e) => props.onTitle(e.target.value)}
        />
      </Field>
      <div className="management-actions">
        <button
          type="button"
          className="button small"
          disabled={props.first}
          onClick={() => props.onMove(-1)}
        >
          {`Move ${noun} up`}
        </button>
        <button
          type="button"
          className="button small"
          disabled={props.last}
          onClick={() => props.onMove(1)}
        >
          {`Move ${noun} down`}
        </button>
        <button type="button" className="text-button" onClick={props.onDelete}>
          {`Delete ${noun}`}
        </button>
      </div>
    </div>
  );
}

function EntryEditor(props: EntryProps) {
  const { item, index: i } = props;
  return (
    <details
      // A new, empty entry opens so it can be filled in at once.
      ref={(element) => {
        if (element && !item.title && !item.detail) element.open = true;
      }}
    >
      <summary>
        {i + 1}. {item.type === "comment" ? "Heading / note: " : ""}
        {item.title || item.detail || "New entry"}
      </summary>
      <EntryFields {...props} />
      {!!item.actions?.length && (
        <p>
          Additional source actions are retained for export; this app does not
          execute them.
        </p>
      )}
      <EntryActions {...props} />
    </details>
  );
}

function EntryFields({ draft, item, index: i }: EntryProps) {
  const edit = (changes: Partial<ChecklistItem>) =>
    editEntry(draft, i, changes);
  return (
    <div className="form-grid">
      <Field label={`Entry ${i + 1} type`}>
        <select
          value={item.type ?? "check"}
          onChange={(e) =>
            edit({ type: e.target.value === "comment" ? "comment" : undefined })
          }
        >
          <option value="check">Check item</option>
          <option value="comment">Heading / note</option>
        </select>
      </Field>
      {ENTRY_TEXT_FIELDS.map(([key, label]) => (
        <Field key={key} label={`Entry ${i + 1} ${label}`}>
          <textarea
            value={item[key] ?? ""}
            maxLength={TEXT_MAX_LENGTH}
            onChange={(e) => edit({ [key]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

function EntryActions({ draft, index: i, count }: EntryProps) {
  const moveEntry = (step: number) =>
    draft.patch((d) => move(listIn(d, draft).items, i, step));
  return (
    <div className="management-actions">
      <button
        type="button"
        className="button small"
        aria-label={`Move entry ${i + 1} up`}
        disabled={i === 0}
        onClick={() => moveEntry(-1)}
      >
        ↑ Move up
      </button>
      <button
        type="button"
        className="button small"
        aria-label={`Move entry ${i + 1} down`}
        disabled={i === count - 1}
        onClick={() => moveEntry(1)}
      >
        ↓ Move down
      </button>
      <button
        type="button"
        className="text-button"
        aria-label={`Delete entry ${i + 1}`}
        onClick={() => {
          if (window.confirm("Delete this entry from the draft?"))
            draft.patch((d) => listIn(d, draft).items.splice(i, 1));
        }}
      >
        Delete entry
      </button>
    </div>
  );
}

function saveCommand(record: ChecklistRecord, baseVersion: number) {
  if (!record.document.payload.metadata.name?.trim())
    throw new Error("Enter a checklist name.");
  return { record, baseVersion };
}

// The chosen category, and the group and checklist chosen in it, with their
// indexes (-1 when none is chosen).
function selectionIn(
  doc: ChecklistDocument,
  categoryIndex: number,
  groupId: string,
  listId: string,
) {
  const category = doc.payload.groups[categoryIndex];
  const groupIndex =
    category?.items.findIndex((g) => g.objectId === groupId) ?? -1;
  const group = category?.items[groupIndex];
  const listIndex = group?.items.findIndex((l) => l.objectId === listId) ?? -1;
  const list = group?.items[listIndex];
  return { categoryIndex, category, groupIndex, group, listIndex, list };
}

function groupIn(d: ChecklistDocument, at: Selection) {
  return d.payload.groups[at.categoryIndex].items[at.groupIndex];
}

function listIn(d: ChecklistDocument, at: Selection) {
  return groupIn(d, at).items[at.listIndex];
}

// A move past either end leaves the order as it is.
function move<T>(items: T[], index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
}

function chooseCategory(draft: Draft, index: number) {
  draft.setCategory(index);
  const first = draft.record.document.payload.groups[index].items[0];
  draft.setGroup(first?.objectId ?? "");
  draft.setList(first?.items[0]?.objectId ?? "");
}

function chooseGroup(draft: Draft, id: string) {
  draft.setGroup(id);
  draft.setList(
    draft.category!.items.find((g) => g.objectId === id)?.items[0]?.objectId ??
      "",
  );
}

function addCategory(draft: Draft, type: (typeof CATEGORY_TYPES)[number]) {
  const index = draft.record.document.payload.groups.length;
  draft.patch((d) =>
    d.payload.groups.push({
      objectId: checklistId(),
      groupType: type,
      items: [],
    }),
  );
  draft.setCategory(index);
  draft.setGroup("");
  draft.setList("");
}

function addGroup(draft: Draft) {
  const id = checklistId();
  draft.patch((d) =>
    d.payload.groups[draft.categoryIndex].items.push({
      objectId: id,
      title: "New group",
      items: [],
    }),
  );
  draft.setGroup(id);
  draft.setList("");
}

function addList(draft: Draft) {
  const id = checklistId();
  draft.patch((d) =>
    groupIn(d, draft).items.push({
      objectId: id,
      title: "New checklist",
      items: [],
    }),
  );
  draft.setList(id);
}

function addEntry(draft: Draft, type?: "comment") {
  draft.patch((d) =>
    listIn(d, draft).items.push({
      objectId: checklistId(),
      ...(type ? { type } : {}),
      title: "",
      detail: "",
      note: "",
    }),
  );
}

// A check item stores no type key at all, not an undefined one.
function editEntry(
  draft: Draft,
  index: number,
  changes: Partial<ChecklistItem>,
) {
  draft.patch((d) => {
    const item = listIn(d, draft).items[index];
    Object.assign(item, changes);
    if (changes.type === undefined && "type" in changes) delete item.type;
  });
}

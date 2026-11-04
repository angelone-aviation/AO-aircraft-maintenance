/**
 * Responsibility: The logbook wording of a task or job card: whether it goes
 *   in the logbook entry, its phrase, and the user's saved phrases editor.
 * Layer: UI. Saves phrases through the workspace backend.
 * Dependencies: react, src/data/store.ts (useWorkspace),
 *   src/domain/logbookWording.ts, src/components/ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  defaultLogbookPhrases,
  logbookPhrasesSchema,
} from "../domain/logbookWording";
import { Field, errorText } from "./ui";

// The phrase logbookWorkLine writes for a task that has none.
const DEFAULT_PHRASE = "Performed";

type WordingProps = {
  included?: boolean;
  phrase?: string;
  onChange: (patch: {
    includeInLogbook?: boolean;
    logbookPhrase?: string;
  }) => void;
};
type PhraseEditor = ReturnType<typeof usePhraseEditor>;

/**
 * The logbook choice for one task: a checkbox to include it, then the phrase
 * picked from the user's saved phrases, which they can edit here. A task with
 * no recorded choice shows as included, worded "Performed".
 *
 * @param props.included - Whether the task goes in the logbook entry;
 *   undefined for an entry that predates the choice, which adds a note.
 * @param props.phrase - The task's phrase; kept in the menu even when the
 *   user's saved list lacks it.
 * @param props.onChange - Called with both fields whenever either changes.
 * @returns The fields. Saving phrases writes the user's list through the
 *   backend; it needs a connection and closes the editor once saved.
 */
export function LogbookWording({ included, phrase, onChange }: WordingProps) {
  const { snapshot } = useWorkspace();
  const phrases = snapshot?.user.logbookPhrases ?? defaultLogbookPhrases;
  const selected = phrase || DEFAULT_PHRASE;
  const include = included ?? true;
  const editor = usePhraseEditor(phrases);
  return (
    <div>
      <label className="block">
        <input
          type="checkbox"
          checked={include}
          onChange={(e) =>
            onChange({
              includeInLogbook: e.target.checked,
              logbookPhrase: selected,
            })
          }
        />{" "}
        Include in log book entry
      </label>
      {included === undefined && (
        <p className="muted">
          Existing entry uses the original work summary. Select or clear this
          checkbox to set its inclusion explicitly.
        </p>
      )}
      {include && (
        <WordingFields
          phrases={phrases}
          selected={selected}
          editor={editor}
          onSelect={(next) =>
            onChange({ logbookPhrase: next, includeInLogbook: include })
          }
        />
      )}
    </div>
  );
}

// The editor's state lives in LogbookWording, so it survives clearing and
// re-checking the checkbox.
function WordingFields({
  phrases,
  selected,
  editor,
  onSelect,
}: {
  phrases: string[];
  selected: string;
  editor: PhraseEditor;
  onSelect: (phrase: string) => void;
}) {
  return (
    <>
      <Field label="Log book wording">
        <select value={selected} onChange={(e) => onSelect(e.target.value)}>
          {[...new Set([...phrases, selected])].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Field>
      <button type="button" className="text-button" onClick={editor.toggle}>
        Manage log book phrases
      </button>
      {editor.editing && <PhraseEditorPanel editor={editor} />}
    </>
  );
}

function PhraseEditorPanel({ editor }: { editor: PhraseEditor }) {
  return (
    <div className="panel">
      <Field label="My log book phrases (one per line)">
        <textarea
          value={editor.draft}
          onChange={(e) => editor.setDraft(e.target.value)}
        />
      </Field>
      <p className="muted">
        Add or edit phrases here. Saved choices are available on your other
        tasks. Existing task wording stays as recorded.
      </p>
      <button
        type="button"
        className="button"
        disabled={!editor.canSave}
        onClick={editor.save}
      >
        Save phrases
      </button>
      {editor.message && <p role="alert">{editor.message}</p>}
    </div>
  );
}

function usePhraseEditor(phrases: string[]) {
  const { backend, online, connected } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  function toggle() {
    setDraft(phrases.join("\n"));
    setEditing(!editing);
    setMessage("");
  }
  async function save() {
    setSaving(true);
    setMessage("");
    try {
      if (!backend) throw new Error("Connect before saving phrases.");
      await backend.saveLogbookPhrases(
        logbookPhrasesSchema.parse(draftPhrases(draft)),
      );
      setEditing(false);
    } catch (error) {
      setMessage(errorText(error, "Could not save phrases."));
    } finally {
      setSaving(false);
    }
  }
  const canSave = !saving && !!backend && online && connected;
  return { editing, draft, setDraft, message, canSave, toggle, save };
}

function draftPhrases(draft: string): string[] {
  return draft
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

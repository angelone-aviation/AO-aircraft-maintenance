/**
 * Responsibility: The release statement picker on a work order, and the
 *   editor for the signed-in user's saved statements.
 * Layer: UI. React component; saves through the workspace backend.
 * Dependencies: react, src/data/store.ts, src/domain/releaseStatements.ts,
 *   ./ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  defaultReleaseStatements,
  releaseStatementsSchema,
  type ReleaseStatement,
} from "../domain/releaseStatements";
import { Field, errorText } from "./ui";

// The limits releaseStatementsSchema sets; the work order's release outcome
// allows the same length as a statement's text.
const LABEL_MAX_LENGTH = 200;
const TEXT_MAX_LENGTH = 10000;
const MAX_STATEMENTS = 100;

// Draft rows carry a client-only id for stable React keys; the schema parse
// on save strips it, so the persisted shape is unchanged.
type DraftStatement = ReleaseStatement & { id: string };
type Editor = ReturnType<typeof useStatementEditor>;
type EditorProps = { editor: Editor; draft: DraftStatement[] };

const withId = (item: ReleaseStatement): DraftStatement => ({
  ...item,
  id: crypto.randomUUID(),
});

/**
 * A work order's release outcome and, while editable, a picker of the
 * signed-in user's release statements (the starter set until they save their
 * own) and an editor that saves that list to their account. Picking a
 * statement replaces the outcome text.
 *
 * @param props.value - The release outcome text.
 * @param props.onChange - Receives the new outcome text.
 * @param props.editable - Shows the picker and the statement editor.
 */
export function ReleaseStatements({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
}) {
  const { snapshot } = useWorkspace();
  const statements =
    snapshot?.user.releaseStatements ?? defaultReleaseStatements;
  const editor = useStatementEditor();
  return (
    <>
      {editable && (
        <StatementTools
          editor={editor}
          statements={statements}
          value={value}
          onChange={onChange}
        />
      )}
      <Field
        label="Release outcome"
        hint="This text is the closing release statement in the log book entry."
      >
        <textarea
          name="releaseOutcome"
          rows={5}
          maxLength={TEXT_MAX_LENGTH}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    </>
  );
}

function useStatementEditor() {
  const { backend, online, connected } = useWorkspace();
  const [draft, setDraft] = useState<DraftStatement[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = (statements: ReleaseStatement[]) => {
    setDraft(statements.map(withId));
    setError("");
  };
  const patch = (index: number, changes: Partial<ReleaseStatement>) =>
    setDraft((items) =>
      items!.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (!backend) throw new Error("Connect before saving statements.");
      await backend.saveReleaseStatements(releaseStatementsSchema.parse(draft));
      setDraft(null);
    } catch (error) {
      setError(errorText(error, "Could not save statements."));
    } finally {
      setBusy(false);
    }
  };
  const canSave = online && connected;
  return { draft, setDraft, busy, error, canSave, open, patch, save };
}

function StatementTools({
  editor,
  statements,
  value,
  onChange,
}: {
  editor: Editor;
  statements: ReleaseStatement[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <StatementPicker
        statements={statements}
        value={value}
        onChange={onChange}
      />
      <button
        type="button"
        className="text-button"
        onClick={() => editor.open(statements)}
      >
        Manage release statements
      </button>
      {editor.draft && <StatementEditor editor={editor} draft={editor.draft} />}
    </>
  );
}

function StatementPicker({
  statements,
  value,
  onChange,
}: {
  statements: ReleaseStatement[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      label="Release statement"
      hint="Choose a closing statement, then adjust the wording or dates below for this work order."
    >
      <select
        value={statements.findIndex((item) => item.text === value)}
        onChange={(e) => {
          const item = statements[Number(e.target.value)];
          if (item) onChange(item.text);
        }}
      >
        <option value={-1}>
          {value ? "Custom / edited statement" : "Select a release statement"}
        </option>
        {statements.map((item, index) => (
          <option key={item.label} value={index}>
            {item.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function StatementEditor({ editor, draft }: EditorProps) {
  return (
    <div className="panel" aria-label="Manage release statements">
      <h4>My release statements</h4>
      <p>
        Add or edit reusable statements for your account. Saved work-order
        statements keep their recorded wording.
      </p>
      {draft.map((item, index) => (
        <DraftRow key={item.id} index={index} editor={editor} draft={draft} />
      ))}
      <EditorActions editor={editor} draft={draft} />
      {editor.error && <p role="alert">{editor.error}</p>}
    </div>
  );
}

function DraftRow({ index, editor, draft }: EditorProps & { index: number }) {
  const item = draft[index];
  return (
    <div className="panel">
      <Field label={`Statement ${index + 1} name`}>
        <input
          maxLength={LABEL_MAX_LENGTH}
          value={item.label}
          disabled={editor.busy}
          onChange={(e) => editor.patch(index, { label: e.target.value })}
        />
      </Field>
      <Field label={`Statement ${index + 1} text`}>
        <textarea
          rows={4}
          maxLength={TEXT_MAX_LENGTH}
          value={item.text}
          disabled={editor.busy}
          onChange={(e) => editor.patch(index, { text: e.target.value })}
        />
      </Field>
      <button
        type="button"
        className="text-button"
        disabled={editor.busy}
        onClick={() => editor.setDraft(draft.filter((_, i) => i !== index))}
      >
        Remove statement {index + 1}
      </button>
    </div>
  );
}

function EditorActions({ editor, draft }: EditorProps) {
  const { busy } = editor;
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={busy || draft.length >= MAX_STATEMENTS}
        onClick={() =>
          editor.setDraft([...draft, withId({ label: "", text: "" })])
        }
      >
        Add release statement
      </button>{" "}
      <button
        type="button"
        className="button"
        disabled={busy || !editor.canSave}
        onClick={editor.save}
      >
        {busy ? "Saving…" : "Save release statements"}
      </button>{" "}
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => editor.setDraft(null)}
      >
        Cancel statement edits
      </button>
    </>
  );
}

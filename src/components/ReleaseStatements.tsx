import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  defaultReleaseStatements,
  releaseStatementsSchema,
  type ReleaseStatement,
} from "../domain/releaseStatements";
import { Field } from "./ui";
// Draft rows carry a client-only id for stable React keys; the schema parse
// on save strips it, so the persisted shape is unchanged.
type DraftStatement = ReleaseStatement & { id: string };
const withId = (item: ReleaseStatement): DraftStatement => ({
  ...item,
  id: crypto.randomUUID(),
});

export function ReleaseStatements({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
}) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const statements =
    snapshot?.user.releaseStatements ?? defaultReleaseStatements;
  const [draft, setDraft] = useState<DraftStatement[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (index: number, changes: Partial<ReleaseStatement>) =>
    setDraft((items) =>
      items!.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    );
  return (
    <>
      {editable && (
        <>
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
                {value
                  ? "Custom / edited statement"
                  : "Select a release statement"}
              </option>
              {statements.map((item, index) => (
                <option key={item.label} value={index}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(statements.map(withId));
              setError("");
            }}
          >
            Manage release statements
          </button>
          {draft && (
            <div className="panel" aria-label="Manage release statements">
              <h4>My release statements</h4>
              <p>
                Add or edit reusable statements for your account. Saved
                work-order statements keep their recorded wording.
              </p>
              {draft.map((item, index) => (
                <div className="panel" key={item.id}>
                  <Field label={`Statement ${index + 1} name`}>
                    <input
                      maxLength={200}
                      value={item.label}
                      disabled={busy}
                      onChange={(e) => patch(index, { label: e.target.value })}
                    />
                  </Field>
                  <Field label={`Statement ${index + 1} text`}>
                    <textarea
                      rows={4}
                      maxLength={10000}
                      value={item.text}
                      disabled={busy}
                      onChange={(e) => patch(index, { text: e.target.value })}
                    />
                  </Field>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setDraft(draft.filter((_, i) => i !== index))
                    }
                  >
                    Remove statement {index + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                disabled={busy || draft.length >= 100}
                onClick={() =>
                  setDraft([...draft, withId({ label: "", text: "" })])
                }
              >
                Add release statement
              </button>{" "}
              <button
                type="button"
                className="button"
                disabled={busy || !online || !connected}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    if (!backend)
                      throw new Error("Connect before saving statements.");
                    await backend.saveReleaseStatements(
                      releaseStatementsSchema.parse(draft),
                    );
                    setDraft(null);
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Could not save statements.",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Saving…" : "Save release statements"}
              </button>{" "}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel statement edits
              </button>
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </>
      )}
      <Field
        label="Release outcome"
        hint="This text is the closing release statement in the log book entry."
      >
        <textarea
          name="releaseOutcome"
          rows={5}
          maxLength={10000}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    </>
  );
}

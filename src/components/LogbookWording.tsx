/**
 * Responsibility: The logbook wording of a task or job card: whether it goes
 *   in the logbook entry, its phrase, and the user's saved phrases editor.
 * Layer: UI. React component; saves phrases through the workspace backend.
 * Dependencies: react, src/data/store.ts, src/domain/logbookWording.ts,
 *   ./ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  defaultLogbookPhrases,
  logbookPhrasesSchema,
} from "../domain/logbookWording";
import { Field, errorText } from "./ui";

export function LogbookWording({
  included,
  phrase,
  onChange,
}: {
  included?: boolean;
  phrase?: string;
  onChange: (patch: {
    includeInLogbook?: boolean;
    logbookPhrase?: string;
  }) => void;
}) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const phrases = snapshot?.user.logbookPhrases ?? defaultLogbookPhrases;
  const selected = phrase || "Performed";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div>
      <label className="block">
        <input
          type="checkbox"
          checked={included ?? true}
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
      {(included ?? true) && (
        <>
          <Field label="Log book wording">
            <select
              value={selected}
              onChange={(e) =>
                onChange({
                  logbookPhrase: e.target.value,
                  includeInLogbook: included ?? true,
                })
              }
            >
              {[...new Set([...phrases, selected])].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(phrases.join("\n"));
              setEditing(!editing);
              setMessage("");
            }}
          >
            Manage log book phrases
          </button>
          {editing && (
            <div className="panel">
              <Field label="My log book phrases (one per line)">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </Field>
              <p className="muted">
                Add or edit phrases here. Saved choices are available on your
                other tasks. Existing task wording stays as recorded.
              </p>
              <button
                type="button"
                className="button"
                disabled={saving || !backend || !online || !connected}
                onClick={async () => {
                  setSaving(true);
                  setMessage("");
                  try {
                    if (!backend)
                      throw new Error("Connect before saving phrases.");
                    await backend.saveLogbookPhrases(
                      logbookPhrasesSchema.parse(
                        draft
                          .split("\n")
                          .map((p) => p.trim())
                          .filter(Boolean),
                      ),
                    );
                    setEditing(false);
                  } catch (error) {
                    setMessage(errorText(error, "Could not save phrases."));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Save phrases
              </button>
              {message && <p role="alert">{message}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

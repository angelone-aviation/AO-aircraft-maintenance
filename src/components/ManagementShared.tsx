/**
 * Responsibility: Form fields, form readers and change-history views shared
 *   by the management screens.
 * Layer: UI. Shared components and form helpers.
 * Dependencies: src/data/store.ts, src/data/auditHistory.ts,
 *   src/domain/model.ts, src/domain/management.ts (types), ./ui.tsx.
 */
import { useWorkspace } from "../data/store";
import { useAuditHistory } from "../data/auditHistory";
import { localDate } from "../domain/model";
import { parseHours } from "../domain/model";
import type { ManagementCommand } from "../domain/management";
import { Field, value } from "./ui";

// Management commands refuse a longer reason (src/domain/management.ts).
const REASON_MAX_LENGTH = 2000;

/** Today's date on this device, as YYYY-MM-DD. */
export const today = () => localDate();

/**
 * A labelled number input of zero or more, blank unless `initial` is given.
 *
 * @param props.decimal - Steps by tenths instead of whole numbers.
 */
export function NumberField({
  name,
  label,
  initial,
  required = false,
  decimal = false,
}: {
  name: string;
  label: string;
  initial?: number;
  required?: boolean;
  decimal?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min="0"
        step={decimal ? "0.1" : "1"}
        defaultValue={initial}
        required={required}
      />
    </Field>
  );
}

/**
 * Reads an optional number field: undefined when blank or missing, otherwise
 * the trimmed text as a Number (NaN for text that is not a number).
 */
export const num = (d: FormData, k: string) =>
  value(d, k) === "" ? undefined : Number(value(d, k));

/**
 * Reads an hours field as seconds.
 *
 * @returns The seconds, or undefined when the field is blank.
 * @throws Error "Use positive hours with at most one decimal place." or
 *   "Meter reading is too large." from parseHours.
 */
export const secs = (d: FormData, k: string) => parseHours(value(d, k));

/**
 * The paging controls under a change history: loading status, error and
 * Load more until the last page.
 */
export function HistoryPager({
  history,
}: {
  history: ReturnType<typeof useAuditHistory>;
}) {
  return (
    <>
      {history.loading && <p role="status">Loading history…</p>}
      {history.error && (
        <p role="alert" className="error">
          {history.error}
        </p>
      )}
      {!history.isDone && !history.loading && (
        <button type="button" className="button" onClick={history.loadMore}>
          Load more
        </button>
      )}
    </>
  );
}

/**
 * The change history of the record `uuid`: each entry's action, time, reason
 * and recorded values, in the order the audit history pages them.
 */
export function History({ uuid }: { uuid: string }) {
  const history = useAuditHistory({ entityUuid: uuid });
  const entries = history.entries;
  return (
    <section>
      <h3>Record history</h3>
      {entries.length === 0 && history.isDone ? (
        <p className="muted">No recorded changes.</p>
      ) : (
        entries.map((a) => (
          <div className="management-event" key={a.uuid}>
            <strong>{a.action}</strong>
            <small>{new Date(a.at).toLocaleString()}</small>
            <p>{a.reason}</p>
            <details>
              <summary>Recorded values</summary>
              <pre>
                {JSON.stringify(a.after ? JSON.parse(a.after) : {}, null, 2)}
              </pre>
            </details>
          </div>
        ))
      )}
      <HistoryPager history={history} />
    </section>
  );
}

/**
 * The management screens' snapshot, whether they may write, and the command
 * runner they write through.
 *
 * @returns `s`, the snapshot, assumed loaded;
 *   `writable`, online and connected; and `execute`, which sends a command
 *   and shows the "Change saved." notice.
 * @throws Error "Reconnect to make this change." from `execute` when offline
 *   or without a backend.
 */
export function useManagement() {
  const { snapshot, backend, online, connected } = useWorkspace();
  return {
    s: snapshot!,
    writable: online && connected,
    execute: async (c: ManagementCommand) => {
      if (!online || !connected || !backend)
        throw new Error("Reconnect to make this change.");
      await backend.manage(c);
      useWorkspace.setState({ notice: "Change saved." });
    },
  };
}

/** The required "Work performed / reason" box a management command carries. */
export function Reason() {
  return (
    <Field label="Work performed / reason">
      <textarea name="reason" required maxLength={REASON_MAX_LENGTH} />
    </Field>
  );
}

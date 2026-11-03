import { useWorkspace } from "../data/store";
import { useAuditHistory } from "../data/auditHistory";
import { localDate } from "../domain/model";
import { parseHours } from "../domain/model";
import type { ManagementCommand } from "../domain/management";
import { Field, value } from "./ui";
export const today = () => localDate();
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
export const num = (d: FormData, k: string) =>
  value(d, k) === "" ? undefined : Number(value(d, k));
export const secs = (d: FormData, k: string) => parseHours(value(d, k));
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
export function Reason() {
  return (
    <Field label="Work performed / reason">
      <textarea name="reason" required maxLength={2000} />
    </Field>
  );
}

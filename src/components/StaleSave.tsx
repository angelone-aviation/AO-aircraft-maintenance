/**
 * Responsibility: The stale-save review: when a save is refused because
 *   someone else changed the record, shows every field either person
 *   changed (yours and theirs, with who saved last and when) and offers
 *   Keep mine, Use theirs or Cancel; also the difference table a held
 *   flight's review reuses.
 * Layer: UI. Shared dialog and hook; no Convex imports.
 * Dependencies: react, react-dom, ./design.tsx, src/data/store.ts,
 *   src/data/errors.ts, src/domain/fieldDiff.ts, src/domain/recordMerge.ts,
 *   src/domain/model.ts, src/styles/screens/stale-save.css.
 *
 * Keep mine never re-submits the whole draft: that put back fields the other
 * person had just saved. It saves only what the user changed since the form
 * opened, on top of the current record (src/domain/recordMerge.ts), and is
 * withheld when the two saves cannot be combined; Use theirs drops the draft.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./design";
import { useWorkspace } from "../data/store";
import { errorText, isStaleSave } from "../data/errors";
import type { FieldDifference, FieldSpecs } from "../domain/fieldDiff";
import {
  mergeKeepMine,
  type KeepMineMerge,
  type MergedField,
  type MergeRules,
} from "../domain/recordMerge";
import type { AuditEntry, Snapshot } from "../domain/model";
import "../styles/screens/stale-save.css";

/** A record with the version its saves are checked against. */
type Versioned = { version?: number };

/** One save a screen runs through {@link useStaleSave}. */
export interface StaleSaveAttempt<T extends Versioned> {
  /** The record as the user's form would save it. */
  draft?: T;
  /** The record as the form loaded it; absent for a new record. */
  loaded?: T;
  /** The record as it stands now, from the live snapshot. */
  find: (s: Snapshot) => T | undefined;
  /** Saves against a version: the draft against the loaded version on the
   * first try; on Keep mine, `merged` (the draft's changes on top of the
   * current record) against the current version. */
  save: (version: number, merged?: T) => Promise<void>;
  /** Reloads the form from the current record, dropping the draft; the
   * record is undefined when it is no longer in the snapshot. */
  useTheirs: (current: T | undefined) => void;
}

/** What {@link useStaleSave} needs to describe the record. */
export interface StaleSaveOptions<T extends Versioned> {
  /** The record's kind, in the dialog's text: "inspection". */
  label: string;
  /** Labels and formats for the fields shown. */
  specs?: FieldSpecs<T>;
  /** What Keep mine may not combine on this kind of record. */
  rules?: MergeRules<T>;
  /** The record's change-log id, for who saved it last. */
  entityUuid?: (record: T) => string;
}

const CONFIRM_USE_THEIRS =
  "Discard your changes and reload this record as it is now?";
const DEFAULT_LATEST_ACTOR = "Someone else";

/**
 * Runs a form's save and, when it is refused as stale, opens the review
 * dialog instead of showing the message; any other failure is rethrown for
 * the form to show.
 *
 * @param options - The record's label, field specs and change-log id.
 * @returns `run`, which saves one attempt; `dialog`, to render beside the
 *   form; and `formKey`, which changes when the user chose Use theirs so a
 *   form keyed by it reloads its fields.
 */
export function useStaleSave<T extends Versioned>(
  options: StaleSaveOptions<T>,
) {
  const [attempt, setAttempt] = useState<StaleSaveAttempt<T> | null>(null);
  const [formKey, setFormKey] = useState(0);
  async function run(next: StaleSaveAttempt<T>) {
    try {
      await next.save(next.loaded?.version ?? next.draft?.version ?? 0);
    } catch (error) {
      if (!isStaleSave(error)) throw error;
      setAttempt(next);
    }
  }
  const dialog = attempt
    ? createPortal(
        <StaleSaveDialog
          attempt={attempt}
          options={options}
          onClose={() => setAttempt(null)}
          onReloaded={() => setFormKey((k) => k + 1)}
        />,
        document.body,
      )
    : null;
  return { run, dialog, formKey };
}

/**
 * The review of a refused save: who saved the record last, every field
 * either person changed since the form opened, and the three choices.
 *
 * @param props.attempt - The refused save.
 * @param props.options - The record's label, specs, rules and change-log id.
 * @param props.onClose - Closes the dialog; Cancel keeps the form as it is.
 * @param props.onReloaded - Called after Use theirs, once confirmed.
 * @returns The dialog. Keep mine saves the user's changed fields on top of
 *   the current record, against its version, and shows a failure inside the
 *   dialog. It is unavailable when the record is gone, when the form holds
 *   no loaded copy to tell the user's changes by, until the current record
 *   has arrived, and when a rule says the two saves cannot be combined.
 */
export function StaleSaveDialog<T extends Versioned>({
  attempt,
  options,
  onClose,
  onReloaded,
}: {
  attempt: StaleSaveAttempt<T>;
  options: StaleSaveOptions<T>;
  onClose: () => void;
  onReloaded: () => void;
}) {
  const { snapshot } = useWorkspace();
  const current = snapshot ? attempt.find(snapshot) : undefined;
  const review = reviewOf(attempt, current, options);
  const choice = useStaleChoice(attempt, current, review, onClose, onReloaded);
  const theirs = current ?? attempt.loaded;
  return (
    <Dialog
      title={`Someone else changed this ${options.label}`}
      size="narrow"
      className="stale-save"
      dismissOnScrim={false}
      onClose={onClose}
      footer={
        <StaleSaveActions
          busy={choice.busy}
          canKeep={!!review?.merged}
          onKeepMine={() => void choice.keepMine()}
          onUseTheirs={choice.useTheirs}
          onCancel={onClose}
        />
      }
    >
      <LatestChange
        entityUuid={theirs && options.entityUuid?.(theirs)}
        label={options.label}
      />
      <ReviewBody review={review} current={current} label={options.label} />
      {choice.error && (
        <p role="alert" className="error">
          {choice.error}
        </p>
      )}
    </Dialog>
  );
}

// The merge Keep mine would save. None without the three copies, or while
// the snapshot still holds the version the form loaded: the refusal proves a
// newer one exists, and merging onto the old copy would show no difference.
function reviewOf<T extends Versioned>(
  attempt: StaleSaveAttempt<T>,
  current: T | undefined,
  options: StaleSaveOptions<T>,
): KeepMineMerge<T> | undefined {
  const { draft, loaded } = attempt;
  if (!current || !draft || !loaded) return undefined;
  if (current.version === loaded.version) return undefined;
  return mergeKeepMine(
    { base: loaded, mine: draft, theirs: current },
    { specs: options.specs, rules: options.rules },
  );
}

function ReviewBody<T extends Versioned>({
  review,
  current,
  label,
}: {
  review: KeepMineMerge<T> | undefined;
  current: T | undefined;
  label: string;
}) {
  if (!current) return <p>This {label} is no longer available.</p>;
  if (!review) return <p className="muted">{NO_MERGE_TEXT}</p>;
  return (
    <>
      <DifferenceTable
        differences={review.fields}
        mineLabel="Yours"
        theirsLabel="Theirs"
        empty="Only the version differs: the same values were saved again."
      />
      {review.blocked.length > 0 && <BlockedMerge reasons={review.blocked} />}
      <p className="muted">
        Keep mine saves only the fields you changed, on top of the {label} as it
        is now; fields changed only by them stay as they saved them. Use theirs
        reloads the form with the saved values and drops your changes. Either
        way the change log keeps both saves.
      </p>
    </>
  );
}

const NO_MERGE_TEXT =
  "Your changes cannot be told apart from theirs here, so Keep mine is not available. Use theirs to reload the saved values, or Cancel to go back to your form.";

function BlockedMerge({ reasons }: { reasons: string[] }) {
  return (
    <div className="stale-save-blocked" role="status">
      <p>
        <strong>Keep mine is not available</strong> because your changes cannot
        be combined with theirs:
      </p>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>{sentence(reason)}</li>
        ))}
      </ul>
      <p>
        Use theirs to reload the saved values, then make your change again;
        Cancel first if you need to copy something from your form.
      </p>
    </div>
  );
}

function sentence(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Keep mine saves the merge against the current version and keeps the
// dialog open on a failure (a third save in between is refused as stale
// again, and the table then shows the newer record); Use theirs asks first,
// since the draft is lost.
function useStaleChoice<T extends Versioned>(
  attempt: StaleSaveAttempt<T>,
  current: T | undefined,
  review: KeepMineMerge<T> | undefined,
  onClose: () => void,
  onReloaded: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function keepMine() {
    if (!current || !review?.merged) return;
    setBusy(true);
    setError("");
    try {
      await attempt.save(current.version ?? 0, review.merged);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function useTheirs() {
    if (!window.confirm(CONFIRM_USE_THEIRS)) return;
    attempt.useTheirs(current);
    onReloaded();
    onClose();
  }
  return { busy, error, keepMine, useTheirs };
}

/**
 * Two copies of a record side by side, one row per differing field, each
 * marked with who changed it and, in a stale-save review, what Keep mine
 * does with it.
 *
 * @param props.differences - From fieldDiff or mergeKeepMine; none renders
 *   `empty`.
 * @param props.mineLabel - The heading over the first copy.
 * @param props.theirsLabel - The heading over the second copy.
 * @param props.empty - Shown instead of the table when nothing differs.
 */
export function DifferenceTable({
  differences,
  mineLabel,
  theirsLabel,
  empty,
}: {
  differences: (FieldDifference | MergedField)[];
  mineLabel: ReactNode;
  theirsLabel: ReactNode;
  empty: ReactNode;
}) {
  if (!differences.length) return <p className="muted">{empty}</p>;
  return (
    <table className="diff-table">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">{mineLabel}</th>
          <th scope="col">{theirsLabel}</th>
        </tr>
      </thead>
      <tbody>
        {differences.map((d) => (
          <tr key={d.key}>
            <th scope="row">
              {d.label}
              {d.changedBy && (
                <small className="diff-changed-by">
                  {changeNote(d, d.changedBy)}
                </small>
              )}
            </th>
            <td>{d.mine}</td>
            <td>{d.theirs}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CHANGED_BY_TEXT: Record<
  NonNullable<FieldDifference["changedBy"]>,
  string
> = {
  you: "Changed by you",
  them: "Changed by them",
  both: "Changed by both",
};

const KEEPS_TEXT: Record<MergedField["keeps"], string> = {
  mine: "Keep mine saves yours",
  theirs: "stays as they saved it",
  neither: "cannot be combined",
};

// Who changed the field and, in a stale-save review, what Keep mine stores.
function changeNote(
  d: FieldDifference | MergedField,
  changedBy: NonNullable<FieldDifference["changedBy"]>,
) {
  const who = CHANGED_BY_TEXT[changedBy];
  if (!("keeps" in d)) return who;
  if (changedBy === "both" && d.keeps === "mine")
    return `${who}: Keep mine replaces theirs with yours`;
  return `${who}: ${KEEPS_TEXT[d.keeps]}`;
}

function StaleSaveActions({
  busy,
  canKeep,
  onKeepMine,
  onUseTheirs,
  onCancel,
}: {
  busy: boolean;
  canKeep: boolean;
  onKeepMine: () => void;
  onUseTheirs: () => void;
  onCancel: () => void;
}) {
  const actions: [string, string, boolean, () => void][] = [
    ["Keep mine", "button primary", busy || !canKeep, onKeepMine],
    ["Use theirs", "button", busy, onUseTheirs],
    ["Cancel", "button", busy, onCancel],
  ];
  return (
    <div className="stale-save-actions">
      {actions.map(([label, className, disabled, onClick]) => (
        <button
          key={label}
          type="button"
          className={className}
          disabled={disabled}
          onClick={onClick}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Who saved the record last, from the newest change-log row for it; silent
// when history cannot be read (offline, or no access), since the review
// itself does not depend on it.
function LatestChange({
  entityUuid,
  label,
}: {
  entityUuid?: string;
  label: string;
}) {
  const latest = useLatestChange(entityUuid);
  const { snapshot } = useWorkspace();
  const actor = latest
    ? (snapshot?.members.find((m) => m.id === latest.actorId)?.name ??
      DEFAULT_LATEST_ACTOR)
    : DEFAULT_LATEST_ACTOR;
  return (
    <p className="stale-save-who">
      <strong>{actor}</strong> saved this {label}
      {latest && ` on ${new Date(latest.at).toLocaleString()}`} after you opened
      it. Your changes have not been saved.
    </p>
  );
}

function useLatestChange(entityUuid?: string) {
  const { backend } = useWorkspace();
  const [latest, setLatest] = useState<AuditEntry | null>(null);
  useEffect(() => {
    if (!backend || !entityUuid) return;
    let cancelled = false;
    backend
      .auditPage({ entityUuid, cursor: null, numItems: 1 })
      .then((page) => {
        if (!cancelled) setLatest(page.page[0] ?? null);
      })
      // The newest row is a courtesy; the dialog reads the same without it.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [backend, entityUuid]);
  return latest;
}

/**
 * Responsibility: The Settings block of expiring dates (GLOSSARY "Expiring
 *   date") for one scope: the deployment's own, or the active Flight
 *   Program's, with the dialog that adds, edits and archives them.
 * Layer: UI. React components; the rules and the status come from
 *   src/domain/expiringItems.ts, writes go through the Backend.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (expiringItems, model, validationText), ./design, ./FaaKeySettings, ./ui.
 */
import { useMemo, useState } from "react";
import { CalendarBlank, Plus } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  EXPIRING_KINDS,
  expiringItemSchema,
  expiringKindLabels,
  expiringStatus,
  daysUntil,
  FAA_KEY_ITEM_UUID,
  listExpiringItems,
  type ExpiringItem,
  type ExpiringStatus,
} from "../domain/expiringItems";
import { localDate, type Snapshot } from "../domain/model";
import { validationText } from "../domain/validationText";
import { ListRow, StatusPill, type Tone } from "./design";
import { FaaKeyUpdateButton } from "./FaaKeySettings";
import { AsyncForm, Field, Modal, errorText, value } from "./ui";
import { ZodError } from "zod";

/** Whose dates the block lists. */
export type ExpiringScope = "system" | "program";

const STATUS_TONES: Record<ExpiringStatus, Tone> = {
  ok: "good",
  expiring: "warn",
  expired: "danger",
};
const DESCRIPTIONS: Record<ExpiringScope, string> = {
  system:
    "Dates the deployment must renew: the Cloudflare token, the sign-in client secret, security.txt, the push keys. Only system administrators see them; an alert goes out from the warning window and when a date passes.",
  program:
    "Insurance, registration and other renewals for this Flight Program, with an aircraft where one applies. Program administrators see them; an alert goes out from the warning window and when a date passes.",
};
// One page holds both scopes, so the heading and the add button say whose.
const SCOPE_LABELS: Record<ExpiringScope, { title: string; add: string }> = {
  system: {
    title: "Deployment expiring dates",
    add: "Add deployment expiring date",
  },
  program: {
    title: "Program expiring dates",
    add: "Add program expiring date",
  },
};
const NOTE_ROWS = 3;

/**
 * The "Expiring dates" block: current dates soonest first, each with its
 * status, and the add, edit and archive controls (online only). The FAA key
 * row is computed from the key, so it offers the key's own update instead.
 *
 * @param props.scope - "system" for the deployment's dates, "program" for
 *   the active Flight Program's.
 */
export function ExpiringDates({ scope }: { scope: ExpiringScope }) {
  const s = useWorkspace((x) => x.snapshot)!;
  const { online, connected } = useWorkspace();
  const live = online && connected;
  const items = useMemo(() => listExpiringItems(s, scope), [s, scope]);
  const [editing, setEditing] = useState<ExpiringItem | "new">();
  return (
    <div className="set-block">
      <h3>{SCOPE_LABELS[scope].title}</h3>
      <p className="set-hint">{DESCRIPTIONS[scope]}</p>
      <ExpiringList s={s} items={items} live={live} onEdit={setEditing} />
      <div className="set-actions">
        <button
          type="button"
          className="button small"
          disabled={!live}
          onClick={() => setEditing("new")}
        >
          <Plus size={15} aria-hidden="true" />
          {SCOPE_LABELS[scope].add}
        </button>
      </div>
      {editing && (
        <ExpiringDateDialog
          s={s}
          scope={scope}
          item={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function ExpiringList({
  s,
  items,
  live,
  onEdit,
}: {
  s: Snapshot;
  items: ExpiringItem[];
  live: boolean;
  onEdit: (item: ExpiringItem) => void;
}) {
  if (!items.length)
    return <p className="set-empty">No expiring dates recorded.</p>;
  return (
    <div className="set-dates">
      {items.map((item) => (
        <ExpiringRow
          key={item.uuid}
          s={s}
          item={item}
          live={live}
          onEdit={() => onEdit(item)}
        />
      ))}
    </div>
  );
}

function ExpiringRow({
  s,
  item,
  live,
  onEdit,
}: {
  s: Snapshot;
  item: ExpiringItem;
  live: boolean;
  onEdit: () => void;
}) {
  const today = localDate();
  const status = expiringStatus(item, today);
  const aircraft = s.aircraft.find((a) => a.uuid === item.aircraftUuid);
  return (
    <ListRow
      icon={CalendarBlank}
      tone={STATUS_TONES[status]}
      title={item.label}
      sub={[expiringKindLabels[item.kind], aircraft?.registration, item.note]
        .filter(Boolean)
        .join(" · ")}
      meta={`Expires ${item.expiresOn}`}
      badge={
        <StatusPill tone={STATUS_TONES[status]}>
          {statusLabel(status, daysUntil(today, item.expiresOn))}
        </StatusPill>
      }
      action={<RowAction item={item} live={live} onEdit={onEdit} />}
    />
  );
}

// The FAA key row is computed from the key, so it updates the key instead.
function RowAction({
  item,
  live,
  onEdit,
}: {
  item: ExpiringItem;
  live: boolean;
  onEdit: () => void;
}) {
  if (item.uuid === FAA_KEY_ITEM_UUID)
    return <FaaKeyUpdateButton label="Update key" />;
  return (
    <button
      type="button"
      className="button small"
      aria-label={`Edit ${item.label}`}
      disabled={!live}
      onClick={onEdit}
    >
      Edit
    </button>
  );
}

function statusLabel(status: ExpiringStatus, remaining: number) {
  if (status === "expired") return "Expired";
  if (status === "ok") return "Current";
  if (remaining === 0) return "Expires today";
  return `${remaining} day${remaining === 1 ? "" : "s"} left`;
}

// Mounted only while open, so each opening starts from the item as stored.
function ExpiringDateDialog({
  s,
  scope,
  item,
  onClose,
}: {
  s: Snapshot;
  scope: ExpiringScope;
  item?: ExpiringItem;
  onClose: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const live = online && connected;
  const programUuid = scope === "program" ? s.activeProgramUuid : undefined;
  const save = async (data: FormData) => {
    await backend!.expiringDate({
      action: "save",
      item: readItem(data, item, programUuid),
    });
    onClose();
  };
  return (
    <Modal
      title={item ? "Edit expiring date" : "Add expiring date"}
      onClose={onClose}
    >
      <AsyncForm
        submitLabel="Save expiring date"
        disabled={!live}
        onSubmit={save}
      >
        <WhatFields item={item} />
        <WhenFields s={s} scope={scope} item={item} />
      </AsyncForm>
      {item && <ArchiveButton item={item} live={live} onDone={onClose} />}
    </Modal>
  );
}

function WhatFields({ item }: { item?: ExpiringItem }) {
  return (
    <>
      <Field label="What expires">
        <input
          name="label"
          required
          maxLength={120}
          defaultValue={item?.label}
        />
      </Field>
      <Field label="Kind">
        <select name="kind" defaultValue={item?.kind ?? "other"}>
          {EXPIRING_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {expiringKindLabels[kind]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note">
        <textarea
          name="note"
          rows={NOTE_ROWS}
          maxLength={1000}
          defaultValue={item?.note}
        />
      </Field>
    </>
  );
}

function WhenFields({
  s,
  scope,
  item,
}: {
  s: Snapshot;
  scope: ExpiringScope;
  item?: ExpiringItem;
}) {
  return (
    <>
      <Field label="Expires on">
        <input
          name="expiresOn"
          type="date"
          required
          defaultValue={item?.expiresOn}
        />
      </Field>
      <Field
        label="Warn days before"
        hint="The alert starts this many days before the date."
      >
        <input
          name="warnDays"
          type="number"
          min={0}
          max={730}
          required
          defaultValue={item?.warnDays ?? 60}
        />
      </Field>
      {scope === "program" && <AircraftField s={s} item={item} />}
    </>
  );
}

// A system-wide date belongs to no aircraft, so only program dates offer one.
function AircraftField({ s, item }: { s: Snapshot; item?: ExpiringItem }) {
  return (
    <Field label="Aircraft">
      <select name="aircraftUuid" defaultValue={item?.aircraftUuid ?? ""}>
        <option value="">Whole Flight Program</option>
        {s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ArchiveButton({
  item,
  live,
  onDone,
}: {
  item: ExpiringItem;
  live: boolean;
  onDone: () => void;
}) {
  const { error, archive } = useArchive(item, onDone);
  return (
    <div className="set-actions">
      <button
        type="button"
        className="button small"
        aria-label={`Archive ${item.label}`}
        disabled={!live}
        onClick={() => void archive()}
      >
        Archive
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

// Archiving keeps the item and its history; the confirmation says so.
function useArchive(item: ExpiringItem, onDone: () => void) {
  const backend = useWorkspace((x) => x.backend);
  const [error, setError] = useState("");
  const archive = async () => {
    if (
      !window.confirm(
        `Archive ${item.label}? It leaves the list and stops alerting; its history is kept.`,
      )
    )
      return;
    try {
      await backend!.expiringDate({
        action: "archive",
        uuid: item.uuid,
        version: item.version,
      });
      onDone();
    } catch (e) {
      setError(errorText(e, "Unable to archive this expiring date."));
    }
  };
  return { error, archive };
}

// The form's fields as the domain's item; a refused value shows as the
// schema's own message rather than a JSON dump.
function readItem(
  data: FormData,
  item: ExpiringItem | undefined,
  programUuid: string | undefined,
): ExpiringItem {
  const parsed = expiringItemSchema.safeParse({
    uuid: item?.uuid ?? crypto.randomUUID(),
    programUuid,
    kind: value(data, "kind"),
    label: value(data, "label"),
    expiresOn: value(data, "expiresOn"),
    warnDays: Number(value(data, "warnDays")),
    note: value(data, "note") || undefined,
    aircraftUuid: value(data, "aircraftUuid") || undefined,
    version: item?.version ?? 0,
  });
  if (parsed.success) return parsed.data;
  throw new Error(validationText(parsed.error as ZodError));
}

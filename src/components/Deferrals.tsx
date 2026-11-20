/**
 * Responsibility: A discrepancy's deferral: its status, and the form that
 *   defers an open discrepancy under an MEL item or 14 CFR 91.213(d).
 * Layer: UI. React components; deferral rules and expiry live in
 *   src/domain/deferrals.ts.
 * Dependencies: src/data/store.ts, src/domain/deferrals.ts,
 *   src/domain/model.ts, ./design.tsx, ./ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  defectFoundOn,
  deferralDaysRemaining,
  deferralExpired,
  deferralInputSchema,
  deferralLabel,
  MEL_CATEGORY_DAYS,
  type Deferral,
} from "../domain/deferrals";
import { localDate, type Discrepancy } from "../domain/model";
import { StatusPill } from "./design";
import { AsyncForm, Field, value } from "./ui";

// The limits deferralInputSchema sets.
const MEL_ITEM_MAX_LENGTH = 50;
const MEL_DAYS_MAX = 365;
const PLACARD_MAX_LENGTH = 500;
const MEL_CATEGORIES = ["A", "B", "C", "D"] as const;

type DeferralBasis = Deferral["type"];
type MelCategory = (typeof MEL_CATEGORIES)[number];
type DeferFormProps = { uuid: string; onDone: () => void };
type Choice<T> = { value: T; onChange: (value: T) => void };

/**
 * A deferred discrepancy's deferral: its basis, placard, the day the defect
 * was found and who deferred it, and while the discrepancy is open, its
 * expiry. An expired deferral grounds the aircraft.
 *
 * @param props.report - A discrepancy that carries a deferral.
 */
export function DeferralStatus({ report }: { report: Discrepancy }) {
  const d = report.deferral!;
  const today = localDate();
  const open = report.status === "open";
  const expired = open && deferralExpired(d, today);
  return (
    <div className="deferral">
      <p>
        <StatusPill tone={deferralTone(open, expired)}>
          {expired ? "Deferral expired" : "Deferred"}
        </StatusPill>{" "}
        <strong>{deferralLabel(d)}</strong>
      </p>
      <p className="muted">{deferralNote(d, today, open)}</p>
      <p>Placard: {d.placard}</p>
      <small>
        Found {defectFoundOn(report)} · deferred by {d.deferredByName} on{" "}
        {d.deferredOn}
      </small>
    </div>
  );
}

/**
 * Defers an open discrepancy under an MEL item or 14 CFR 91.213(d), recorded
 * with the day the defect was found (the report's date unless changed), the
 * user's name and today's date. Needs a connection.
 *
 * @param props.uuid - The discrepancy to defer, in the workspace snapshot.
 * @param props.onDone - Called once the deferral is saved.
 * @returns A form that shows the first deferralInputSchema issue (such as
 *   "Enter the placard text.") or the server's refusal instead of saving.
 */
export function DeferDiscrepancyForm({ uuid, onDone }: DeferFormProps) {
  const { backend, online, connected, snapshot } = useWorkspace();
  const [type, setType] = useState<DeferralBasis>("mel");
  const [category, setCategory] = useState<MelCategory>("B");
  const report = snapshot?.discrepancies.find((d) => d.uuid === uuid);
  return (
    <AsyncForm
      submitLabel="Record deferral"
      disabled={!online || !connected}
      onSubmit={async (data) => {
        const deferral = parseDeferral(data, type, category);
        await backend!.deferDiscrepancy({
          uuid,
          foundOn: value(data, "foundOn"),
          deferredOn: localDate(),
          deferral,
        });
        onDone();
      }}
    >
      <BasisSelect value={type} onChange={setType} />
      <FoundOnField reported={report && defectFoundOn(report)} />
      {type === "mel" ? (
        <MelFields value={category} onChange={setCategory} />
      ) : (
        <NotHazardCheck />
      )}
      <PlacardField />
      <p className="muted">
        The deferral is recorded with your name and today&apos;s date. Resolving
        the discrepancy ends the deferral.
      </p>
    </AsyncForm>
  );
}

function BasisSelect({ value, onChange }: Choice<DeferralBasis>) {
  return (
    <Field label="Deferral basis">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DeferralBasis)}
      >
        <option value="mel">Minimum Equipment List (MEL) item</option>
        <option value="91.213d">14 CFR 91.213(d) inoperative equipment</option>
      </select>
    </Field>
  );
}

// A defect cannot be found after it was reported, so the report's date is
// both the default and the latest choice; the server checks it again.
function FoundOnField({ reported }: { reported?: string }) {
  return (
    <Field
      label="Date the defect was found"
      hint="An MEL repair interval counts from this day."
    >
      <input
        type="date"
        name="foundOn"
        required
        max={reported}
        defaultValue={reported}
      />
    </Field>
  );
}

function PlacardField() {
  return (
    <Field label="Placard text">
      <textarea
        name="placard"
        rows={2}
        maxLength={PLACARD_MAX_LENGTH}
        required
      />
    </Field>
  );
}

function deferralTone(open: boolean, expired: boolean) {
  if (!open) return "neutral";
  return expired ? "danger" : "warn";
}

function deferralNote(d: Deferral, today: string, open: boolean) {
  if (!open) return "Deferral ended when the discrepancy was resolved.";
  if (d.expiresOn === undefined)
    return "No expiry under 91.213(d); repair at the next required inspection.";
  if (deferralExpired(d, today))
    return `Expired ${d.expiresOn}. The aircraft is grounded until this is resolved.`;
  const days = deferralDaysRemaining(d, today);
  return `Expires ${d.expiresOn} · ${days} day${days === 1 ? "" : "s"} remaining`;
}

function parseDeferral(
  data: FormData,
  type: DeferralBasis,
  category: MelCategory,
) {
  const parsed = deferralInputSchema.safeParse(
    type === "mel"
      ? {
          type,
          melItem: value(data, "melItem"),
          category,
          days: category === "A" ? Number(value(data, "days")) : undefined,
          placard: value(data, "placard"),
        }
      : {
          type,
          placard: value(data, "placard"),
          notHazard: data.get("notHazard") === "on",
        },
  );
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}

function MelFields({ value: category, onChange }: Choice<MelCategory>) {
  return (
    <div className="form-grid">
      <Field label="MEL item number">
        <input name="melItem" maxLength={MEL_ITEM_MAX_LENGTH} required />
      </Field>
      <Field label="Repair category" hint={categoryHint(category)}>
        <select
          value={category}
          onChange={(e) => onChange(e.target.value as MelCategory)}
        >
          {MEL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              Category {c}
            </option>
          ))}
        </select>
      </Field>
      {category === "A" && (
        <Field label="Days allowed by the MEL">
          <input
            name="days"
            type="number"
            min={1}
            max={MEL_DAYS_MAX}
            step={1}
            required
          />
        </Field>
      )}
    </div>
  );
}

function categoryHint(category: MelCategory) {
  if (category === "A") return "Enter the interval stated in the MEL item.";
  return `${MEL_CATEGORY_DAYS[category]} calendar days after the day the defect was found.`;
}

function NotHazardCheck() {
  return (
    <label className="checkbox">
      <input type="checkbox" name="notHazard" required /> The inoperative
      equipment was determined not to be a hazard, and it is removed or
      deactivated and placarded.
    </label>
  );
}

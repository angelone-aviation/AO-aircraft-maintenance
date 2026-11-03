import { useState } from "react";
import { useWorkspace } from "../data/store";
import {
  deferralDaysRemaining,
  deferralInputSchema,
  deferralLabel,
  MEL_CATEGORY_DAYS,
} from "../domain/deferrals";
import { localDate, type Discrepancy } from "../domain/model";
import { AsyncForm, Badge, Field, value } from "./ui";

export function DeferralStatus({ report }: { report: Discrepancy }) {
  const d = report.deferral!;
  const days = deferralDaysRemaining(d, localDate());
  const open = report.status === "open";
  const expired = open && days !== undefined && days < 0;
  return (
    <div className="deferral">
      <p>
        <Badge tone={!open ? "neutral" : expired ? "danger" : "warning"}>
          {expired ? "Deferral expired" : "Deferred"}
        </Badge>{" "}
        <strong>{deferralLabel(d)}</strong>
      </p>
      <p className="muted">
        {!open
          ? "Deferral ended when the discrepancy was resolved."
          : d.expiresOn === undefined
            ? "No expiry under 91.213(d); repair at the next required inspection."
            : expired
              ? `Expired ${d.expiresOn}. The aircraft is grounded until this is resolved.`
              : `Expires ${d.expiresOn} · ${days} day${days === 1 ? "" : "s"} remaining`}
      </p>
      <p>Placard: {d.placard}</p>
      <small>
        Deferred by {d.deferredByName} on {d.deferredOn}
      </small>
    </div>
  );
}

export function DeferDiscrepancyForm({
  uuid,
  onDone,
}: {
  uuid: string;
  onDone: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const [type, setType] = useState<"mel" | "91.213d">("mel");
  const [category, setCategory] = useState<"A" | "B" | "C" | "D">("B");
  return (
    <AsyncForm
      submitLabel="Record deferral"
      disabled={!online || !connected}
      onSubmit={async (data) => {
        const parsed = deferralInputSchema.safeParse(
          type === "mel"
            ? {
                type,
                melItem: value(data, "melItem"),
                category,
                days:
                  category === "A" ? Number(value(data, "days")) : undefined,
                placard: value(data, "placard"),
              }
            : {
                type,
                placard: value(data, "placard"),
                notHazard: data.get("notHazard") === "on",
              },
        );
        if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        await backend!.deferDiscrepancy({
          uuid,
          deferredOn: localDate(),
          deferral: parsed.data,
        });
        onDone();
      }}
    >
      <Field label="Deferral basis">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="mel">Minimum Equipment List (MEL) item</option>
          <option value="91.213d">
            14 CFR 91.213(d) inoperative equipment
          </option>
        </select>
      </Field>
      {type === "mel" ? (
        <div className="form-grid">
          <Field label="MEL item number">
            <input name="melItem" maxLength={50} required />
          </Field>
          <Field
            label="Repair category"
            hint={
              category === "A"
                ? "Enter the interval stated in the MEL item."
                : `${MEL_CATEGORY_DAYS[category]} calendar days after today.`
            }
          >
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
            >
              {(["A", "B", "C", "D"] as const).map((c) => (
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
                max={365}
                step={1}
                required
              />
            </Field>
          )}
        </div>
      ) : (
        <label className="checkbox">
          <input type="checkbox" name="notHazard" required /> The inoperative
          equipment was determined not to be a hazard, and it is removed or
          deactivated and placarded.
        </label>
      )}
      <Field label="Placard text">
        <textarea name="placard" rows={2} maxLength={500} required />
      </Field>
      <p className="muted">
        The deferral is recorded with your name and today&apos;s date. Resolving
        the discrepancy ends the deferral.
      </p>
    </AsyncForm>
  );
}

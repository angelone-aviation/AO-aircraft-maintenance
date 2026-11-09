/**
 * Responsibility: The Set up an aircraft wizard (GLOSSARY "Aircraft setup"):
 *   its page, step navigation, the draft kept in this browser, and the
 *   Aircraft and Components installed steps.
 * Layer: UI. React components; setup rules live in src/domain/aircraftSetup.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts, src/domain
 *   (aircraftSetup, model, programs, components, componentTemplates), ./Fleet,
 *   ./Components, ./ComponentTemplates, ./AircraftSetupHistory, ./design, ./ui.
 *
 * The components step saves as it goes (through the component and template
 * forms); inspections and ADs are saved only by the commit step, after the
 * dry run. The draft (both CSV texts and the rows already saved) lives in
 * localStorage per aircraft, so a failed commit can be resumed.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { WifiSlash } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  SETUP_STEPS,
  setupDraftSchema,
  setupStatus,
  type SetupDraft,
  type SetupStatus,
  type SetupStep,
} from "../domain/aircraftSetup";
import {
  hours,
  recordedTotalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { programPermission } from "../domain/programs";
import type { Component } from "../domain/components";
import {
  matchesComponentTemplate,
  type ComponentSetup,
  type ComponentTemplate,
} from "../domain/componentTemplates";
import { AircraftForm } from "./Fleet";
import { ComponentForm } from "./Components";
import {
  PendingSetups,
  SetupWindow,
  TemplateEditor,
  TemplatePreview,
} from "./ComponentTemplates";
import {
  CommitStep,
  CsvStep,
  ReviewStep,
  type SetupDrafts,
} from "./AircraftSetupHistory";
import { EmptyState, NoticeBar, PageHeader } from "./design";
import { Modal } from "./ui";
import "../styles/screens/setup.css";

// src/data/store.ts clears localStorage keys with this prefix on sign-out.
const DRAFT_KEY_PREFIX = "angel-one-setup";
const EMPTY_DRAFT: SetupDraft = { inspectionCsv: "", adCsv: "", done: [] };
const STEP_LABELS: Record<SetupStep, string> = {
  aircraft: "Aircraft",
  components: "Components installed",
  inspections: "Inspections",
  ads: "AD compliance",
  review: "Review (dry run)",
  commit: "Save",
};

interface StepProps {
  s: Snapshot;
  aircraft: Aircraft;
  writable: boolean;
  drafts: SetupDrafts;
  onStep: (step: SetupStep) => void;
  nav: ReactNode;
}

type ComponentDialog =
  | { kind: "add" }
  | { kind: "template" }
  | { kind: "preview"; template: ComponentTemplate }
  | { kind: "setup"; setup: ComponentSetup }
  | null;

/**
 * The Set up an aircraft page, for Flight Program administrators: creates an
 * aircraft or resumes one, then walks through components, inspections and AD
 * compliance to a dry run and the commit.
 *
 * @param props.aircraftUuid - The aircraft being set up; none starts a new
 *   one.
 * @param props.step - The step to show; the aircraft step for a new aircraft,
 *   the components step otherwise.
 * @returns The page, or an access or not-found notice.
 */
export function AircraftSetupPage({
  aircraftUuid,
  step,
}: {
  aircraftUuid?: string;
  step?: SetupStep;
}) {
  const { snapshot, namespace, online, connected } = useWorkspace();
  const s = snapshot!;
  if (!programPermission(s, "admin"))
    return (
      <EmptyState title="Administrator access required">
        Only Flight Program administrators set up aircraft.
      </EmptyState>
    );
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (aircraftUuid && !aircraft)
    return (
      <EmptyState
        title="Aircraft not found"
        action={
          <Link className="button" to="/aircraft/setup">
            Start a new setup
          </Link>
        }
      >
        This aircraft is not in the active Flight Program.
      </EmptyState>
    );
  return (
    <SetupWizard
      key={aircraftUuid ?? "new"}
      s={s}
      aircraft={aircraft}
      step={step}
      writable={online && connected}
      draftKey={`${DRAFT_KEY_PREFIX}:${namespace}:${aircraftUuid ?? "new"}`}
    />
  );
}

function SetupWizard({
  s,
  aircraft,
  step,
  writable,
  draftKey,
}: {
  s: Snapshot;
  aircraft: Aircraft | undefined;
  step: SetupStep | undefined;
  writable: boolean;
  draftKey: string;
}) {
  const open = useOpenStep();
  const drafts = useSetupDraft(draftKey);
  const current = aircraft ? (step ?? "components") : "aircraft";
  const onStep = (next: SetupStep) => open(aircraft!.uuid, next);
  return (
    <div className="ops-page setup-page">
      <WizardChrome
        current={current}
        status={aircraft && setupStatus(s, aircraft.uuid)}
        writable={writable}
        storageError={drafts.storageError}
        onStep={onStep}
      />
      {aircraft ? (
        <StepPanel
          step={current}
          props={{ s, aircraft, writable, drafts, onStep, nav: null }}
        />
      ) : (
        <NewAircraftStep s={s} onSaved={(uuid) => open(uuid, "components")} />
      )}
    </div>
  );
}

// Opens a step of an aircraft's setup; the URL holds the step so a reload
// and the Fleet page's chips land on it.
function useOpenStep() {
  const navigate = useNavigate();
  return (aircraftUuid: string, step: SetupStep) =>
    void navigate({
      to: "/aircraft/setup/$aircraftUuid",
      params: { aircraftUuid },
      search: { step },
    });
}

function WizardChrome({
  current,
  status,
  writable,
  storageError,
  onStep,
}: {
  current: SetupStep;
  status: SetupStatus | undefined;
  writable: boolean;
  storageError: string;
  onStep: (step: SetupStep) => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="FLEET"
        title="Set up an aircraft"
        description="Load an aircraft's history in order: identity and baseline readings, installed components, inspections and AD compliance, with a dry run before anything from the templates is saved."
        actions={
          <Link className="button" to="/aircraft">
            Back to aircraft
          </Link>
        }
      />
      <Stepper current={current} status={status} onStep={onStep} />
      {!writable && (
        <NoticeBar tone="neutral" icon={WifiSlash}>
          Reconnect to save. You can still prepare the templates.
        </NoticeBar>
      )}
      {storageError && (
        <NoticeBar tone="warn" role="alert">
          {storageError}
        </NoticeBar>
      )}
    </>
  );
}

function StepPanel({ step, props }: { step: SetupStep; props: StepProps }) {
  const nav = <StepNav step={step} onStep={props.onStep} />;
  const all = { ...props, nav };
  switch (step) {
    case "aircraft":
      return <AircraftSummary aircraft={props.aircraft} nav={nav} />;
    case "components":
      return <ComponentsStep {...all} />;
    case "inspections":
      return <CsvStep kind="inspections" {...all} />;
    case "ads":
      return <CsvStep kind="ads" {...all} />;
    case "review":
      return <ReviewStep {...all} />;
    case "commit":
      return <CommitStep key={props.drafts.revision} {...all} />;
  }
}

function Stepper({
  current,
  status,
  onStep,
}: {
  current: SetupStep;
  status: SetupStatus | undefined;
  onStep: (step: SetupStep) => void;
}) {
  return (
    <ol className="setup-steps" aria-label="Setup steps">
      {SETUP_STEPS.map((step, i) => (
        <li key={step}>
          <button
            type="button"
            className={step === current ? "setup-step current" : "setup-step"}
            aria-current={step === current ? "step" : undefined}
            disabled={!status && step !== "aircraft"}
            onClick={() => onStep(step)}
          >
            <span className="setup-step-number">{i + 1}</span>
            <span>{STEP_LABELS[step]}</span>
            {status && <StepState step={step} status={status} />}
          </button>
        </li>
      ))}
    </ol>
  );
}

// What the aircraft already holds for a step; the CSV steps say nothing
// until the review.
function StepState({ step, status }: { step: SetupStep; status: SetupStatus }) {
  const text = {
    aircraft: status.baseline ? "Baseline set" : "Baseline missing",
    components: status.components
      ? "Installed"
      : status.pendingComponents
        ? `${status.pendingComponents} to complete`
        : "None yet",
    inspections: status.inspections ? "On record" : "None yet",
    ads: status.ads ? "Reviewed" : "None yet",
    review: "",
    commit: "",
  }[step];
  return text ? <small>{text}</small> : null;
}

function StepNav({
  step,
  onStep,
}: {
  step: SetupStep;
  onStep: (step: SetupStep) => void;
}) {
  const i = SETUP_STEPS.indexOf(step);
  const previous = SETUP_STEPS[i - 1];
  const next = SETUP_STEPS[i + 1];
  return (
    <div className="setup-nav">
      {previous && (
        <button
          type="button"
          className="button"
          onClick={() => onStep(previous)}
        >
          Back
        </button>
      )}
      {next && (
        <button
          type="button"
          className="button primary"
          onClick={() => onStep(next)}
        >
          Next: {STEP_LABELS[next]}
        </button>
      )}
    </div>
  );
}

function NewAircraftStep({
  s,
  onSaved,
}: {
  s: Snapshot;
  onSaved: (aircraftUuid: string) => void;
}) {
  const program = s.programs?.find((p) => p.uuid === s.activeProgramUuid);
  return (
    <section className="panel setup-panel">
      <h2>Aircraft</h2>
      <p>
        Enter the identity, the time source and the verified baseline readings
        from the logbooks. Saving creates the aircraft in{" "}
        {program?.name ?? "the active Flight Program"}.
      </p>
      <AircraftForm onDone={onSaved} />
    </section>
  );
}

function AircraftSummary({
  aircraft,
  nav,
}: {
  aircraft: Aircraft;
  nav: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const total = recordedTotalSeconds(aircraft);
  return (
    <section className="panel setup-panel">
      <h2>Aircraft</h2>
      <AircraftFacts aircraft={aircraft} total={total} />
      {!total && (
        <NoticeBar tone="warn">
          Total time is 0.0 h. Enter the baseline readings before loading
          history, or every last-done value will be above the current total.
        </NoticeBar>
      )}
      <button type="button" className="button" onClick={() => setEditing(true)}>
        Edit aircraft
      </button>
      {editing && (
        <Modal
          title={`Edit ${aircraft.registration}`}
          onClose={() => setEditing(false)}
        >
          <AircraftForm initial={aircraft} onDone={() => setEditing(false)} />
        </Modal>
      )}
      {nav}
    </section>
  );
}

function AircraftFacts({
  aircraft,
  total,
}: {
  aircraft: Aircraft;
  total: number | undefined;
}) {
  return (
    <dl className="setup-facts">
      <Fact label="Registration">{aircraft.registration}</Fact>
      <Fact label="Make and model">
        {aircraft.make} {aircraft.model}
      </Fact>
      <Fact label="Serial">{aircraft.serial || "—"}</Fact>
      <Fact label="Total time">
        {total === undefined ? "No reading" : `${hours(total)} h`}
      </Fact>
      <Fact label="Cycles / landings">
        {aircraft.cycles} / {aircraft.landings}
      </Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ComponentsStep({ s, aircraft, writable, nav }: StepProps) {
  const [dialog, setDialog] = useState<ComponentDialog>(null);
  const installed = (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" && r.installed && r.aircraftUuid === aircraft.uuid,
  );
  return (
    <section className="panel setup-panel">
      <h2>Components installed</h2>
      <p>
        Record the engines, propellers and life-tracked parts already on the
        aircraft, with their verified serials and opening readings. A component
        template adds them as Setup incomplete entries to finish one by one;
        each entry saves as soon as its form is saved.
      </p>
      <InstalledComponents components={installed} />
      <ComponentActions
        templates={(s.componentTemplates ?? []).filter((t) =>
          matchesComponentTemplate(t, aircraft),
        )}
        writable={writable}
        onOpen={setDialog}
      />
      <PendingSetups
        s={s}
        writable={writable}
        aircraftUuid={aircraft.uuid}
        onComplete={(setup) => setDialog({ kind: "setup", setup })}
      />
      <ComponentDialogs
        s={s}
        aircraft={aircraft}
        writable={writable}
        dialog={dialog}
        onClose={() => setDialog(null)}
      />
      {nav}
    </section>
  );
}

function ComponentActions({
  templates,
  writable,
  onOpen,
}: {
  templates: ComponentTemplate[];
  writable: boolean;
  onOpen: (dialog: ComponentDialog) => void;
}) {
  const choices: [string, ComponentDialog][] = [
    ["Add installed component", { kind: "add" }],
    ["New template / import CSV", { kind: "template" }],
    ...templates.map((template): [string, ComponentDialog] => [
      `Apply template: ${template.name}`,
      { kind: "preview", template },
    ]),
  ];
  return (
    <div className="setup-actions">
      {choices.map(([label, dialog], i) => (
        <button
          key={label}
          type="button"
          className={i === 0 ? "button primary" : "button"}
          disabled={!writable}
          onClick={() => onOpen(dialog)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function InstalledComponents({ components }: { components: Component[] }) {
  if (!components.length)
    return <p className="muted">No installed components recorded yet.</p>;
  return (
    <ul className="setup-list" aria-label="Installed components">
      {components.map((c) => (
        <li key={c.uuid}>
          <strong>{c.model || c.componentType}</strong> · {c.componentType}
          {c.installPosition && <> · {c.installPosition}</>} ·{" "}
          {c.serial ? `S/N ${c.serial}` : "no serial"}
        </li>
      ))}
    </ul>
  );
}

function ComponentDialogs({
  s,
  aircraft,
  writable,
  dialog,
  onClose,
}: {
  s: Snapshot;
  aircraft: Aircraft;
  writable: boolean;
  dialog: ComponentDialog;
  onClose: () => void;
}) {
  if (!dialog) return null;
  if (dialog.kind === "add")
    return <AddComponentDialog aircraft={aircraft} onClose={onClose} />;
  if (dialog.kind === "template")
    return (
      <TemplateEditor
        s={s}
        writable={writable}
        editing="new"
        onClose={onClose}
      />
    );
  if (dialog.kind === "preview")
    return (
      <TemplatePreview
        s={s}
        writable={writable}
        template={dialog.template}
        aircraftUuid={aircraft.uuid}
        onClose={onClose}
        onApplied={onClose}
      />
    );
  return <SetupWindow s={s} setup={dialog.setup} onClose={onClose} />;
}

function AddComponentDialog({
  aircraft,
  onClose,
}: {
  aircraft: Aircraft;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Add component · ${aircraft.registration} · Initial setup`}
      onClose={onClose}
    >
      <ComponentForm
        initialAircraftUuid={aircraft.uuid}
        aircraftUuids={[aircraft.uuid]}
        onDone={onClose}
      />
    </Modal>
  );
}

function useSetupDraft(key: string): SetupDrafts {
  const [loaded] = useState(() => loadDraft(key));
  const [draft, setDraft] = useState(loaded.draft);
  const [storageError, setStorageError] = useState(loaded.error);
  const [revision, setRevision] = useState(0);
  return {
    draft,
    revision,
    storageError,
    update: (patch) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      if ("inspectionCsv" in patch || "adCsv" in patch)
        setRevision((r) => r + 1);
      setStorageError(persistDraft(key, next));
    },
    clear: () => {
      setDraft(EMPTY_DRAFT);
      try {
        localStorage.removeItem(key);
      } catch {
        // Nothing to clear when storage is blocked.
      }
    },
  };
}

// Returns the storage error to show, or "" once the draft is stored.
function persistDraft(key: string, draft: SetupDraft): string {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return "";
  } catch {
    // Blocked or full storage: the draft stays on screen for this visit.
    return "Browser storage failed, so this setup cannot be resumed after leaving the page. Finish it in this visit.";
  }
}

function loadDraft(key: string): { draft: SetupDraft; error: string } {
  try {
    const raw = localStorage.getItem(key);
    return {
      draft: raw ? setupDraftSchema.parse(JSON.parse(raw)) : EMPTY_DRAFT,
      error: "",
    };
  } catch {
    // Blocked storage or a draft of another shape: start empty and say so,
    // since rows the lost draft recorded as saved are only found by the
    // review's duplicate check.
    return {
      draft: EMPTY_DRAFT,
      error:
        "The saved setup draft could not be loaded. Rows it had already saved are skipped as duplicates in the review.",
    };
  }
}

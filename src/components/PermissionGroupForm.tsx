/**
 * Responsibility: The permission group form: name, Flight Program, owner and
 *   administrator flags, aircraft access and permissions.
 * Layer: UI. React component; its checks are a preview, and convex/admin.ts
 *   applies the same rules on save.
 * Dependencies: src/data/store.ts, src/domain (model, groupAircraft,
 *   groupAccessReview), ./ui.tsx, ./design.tsx, ./GroupAccessReview.tsx.
 */
import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { Group, Permission, Snapshot } from "../domain/model";
import {
  assertGroupAircraftChoice,
  CHOOSE_GROUP_AIRCRAFT,
  listsAllAircraft,
} from "../domain/groupAircraft";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import { AsyncForm, Field, value } from "./ui";
import { NoticeBar } from "./design";
import { accessSummary } from "./GroupAccessReview";

// The limit convex/admin.ts enforces.
const GROUP_NAME_MAX_LENGTH = 100;
// Every group can read its aircraft; these are added to that.
const PERMISSION_CHOICES = [
  ["flight", "Add flights"],
  ["discrepancy", "Report discrepancies"],
  ["resolve", "Resolve discrepancies online"],
  ["maintenance", "Manage inspections and components online"],
] as const;

type AircraftScope = "all" | "selected" | "";
type GroupDraft = ReturnType<typeof useGroupDraft>;

/**
 * The form that creates or edits a permission group. "All aircraft in this
 * program" must be chosen explicitly (#34); owner groups name their aircraft
 * and read only. Saving checks the aircraft choice first, as the server does.
 *
 * @param props.initial - The group to edit; a new group without it.
 * @param props.review - Set when the change log does not show that this
 *   group's all-aircraft access was chosen (groupAccessReview): the form asks
 *   for the choice again.
 * @param props.onDone - Called after the group is saved.
 * @throws From saving, shown in the form: CHOOSE_GROUP_AIRCRAFT without an
 *   aircraft choice, or a refusal from assertGroupAircraftChoice.
 */
export function GroupForm({
  initial,
  review,
  onDone,
}: {
  initial?: Group;
  review?: GroupAccessReport;
  onDone: () => void;
}) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const draft = useGroupDraft(snapshot!, initial, review);
  return (
    <AsyncForm
      disabled={!online || !connected}
      onSubmit={async (data) => {
        await backend!.saveGroup(groupToSave(data, initial, draft));
        onDone();
      }}
    >
      <Field label="Group name">
        <input
          name="name"
          required
          maxLength={GROUP_NAME_MAX_LENGTH}
          defaultValue={initial?.name}
        />
      </Field>
      <ProgramSelect draft={draft} locked={!!initial?.programUuid} />
      <RoleFlags draft={draft} />
      <AircraftAccess draft={draft} review={review} />
      <h3>Permissions</h3>
      <p className="muted">All groups can read their assigned aircraft.</p>
      <PermissionChecks initial={initial} owner={draft.owner} />
    </AsyncForm>
  );
}

function useGroupDraft(
  s: Snapshot,
  initial?: Group,
  review?: GroupAccessReport,
) {
  const [programUuid, setProgramUuid] = useState(
    initial?.programUuid ?? s.activeProgramUuid ?? "",
  );
  const [owner, setOwner] = useState(!!initial?.owner);
  const [programAdmin, setProgramAdmin] = useState(!!initial?.programAdmin);
  const [scope, setScope] = useState(initialScope(initial, review));
  const [selected, setSelected] = useState(initial?.aircraftIds ?? []);
  const access = aircraftAccess(s, initial, programUuid, selected);
  const toggle = (uuid: string, on: boolean) => {
    setSelected((ids) =>
      on ? [...ids, uuid] : ids.filter((id) => id !== uuid),
    );
    // Checking an aircraft is choosing selected aircraft.
    if (on && !owner) setScope("selected");
  };
  const state = { programUuid, owner, programAdmin, scope, selected };
  const setters = { setProgramUuid, setOwner, setProgramAdmin, setScope };
  const all = !owner && scope === "all";
  return { s, ...state, ...setters, ...access, toggle, all };
}

// "All aircraft in this program" is an explicit choice, never the result of
// an empty checklist (#34). A new group starts with neither chosen, and so
// does a group whose all-aircraft access the change log cannot confirm.
function initialScope(
  initial?: Group,
  review?: GroupAccessReport,
): AircraftScope {
  if (!initial || review) return "";
  return listsAllAircraft(initial) ? "all" : "selected";
}

// The snapshot holds the active program's fleet only. For another program
// (an unscoped group being assigned) the group's aircraft cannot be shown, so
// they are kept for the server to check against that program. In the active
// program, ids no longer listed left it and are dropped.
function aircraftAccess(
  s: Snapshot,
  initial: Group | undefined,
  programUuid: string,
  selected: string[],
) {
  const listed = s.aircraft.filter((a) => a.programUuid === programUuid);
  const isListed = (id: string) => listed.some((a) => a.uuid === id);
  const fleetShown = !!programUuid && programUuid === s.activeProgramUuid;
  const kept = fleetShown
    ? []
    : (initial?.aircraftIds ?? []).filter((id) => !isListed(id));
  const checked = listed.filter((a) => selected.includes(a.uuid));
  const departed =
    fleetShown &&
    !!initial?.aircraftIds.length &&
    !initial.aircraftIds.some(isListed);
  const aircraftIds = [...checked.map((a) => a.uuid), ...kept];
  return { listed, fleetShown, kept, checked, departed, aircraftIds };
}

function groupToSave(
  data: FormData,
  initial: Group | undefined,
  draft: GroupDraft,
) {
  const { owner, scope, all } = draft;
  const permissions = data.getAll("permissions").map(String) as Permission[];
  const group = {
    id: initial?.id,
    programUuid: draft.programUuid,
    programAdmin: !owner && draft.programAdmin,
    owner,
    name: value(data, "name"),
    permissions: owner
      ? ["read" as const]
      : [...new Set<Permission>(["read", ...permissions])],
    aircraftIds: all ? [] : draft.aircraftIds,
    // Unset only while no choice was made (owners have none to make).
    allAircraft: owner || !scope ? undefined : all,
  };
  // An ordinary group always needs a choice here, even one the server would
  // still accept unchanged.
  if (!owner && !group.programAdmin && !scope)
    throw new Error(CHOOSE_GROUP_AIRCRAFT);
  // Same rule the server applies, shown before the round trip.
  assertGroupAircraftChoice(initial, group);
  return group;
}

function ProgramSelect({
  draft: { s, programUuid, setProgramUuid },
  locked,
}: {
  draft: GroupDraft;
  locked: boolean;
}) {
  return (
    <Field label="Flight Program">
      <select
        value={programUuid}
        onChange={(e) => setProgramUuid(e.target.value)}
        disabled={locked}
        required
      >
        <option value="">Select Flight Program</option>
        {s.programs
          ?.filter((p) => s.user.isAdmin || p.uuid === s.activeProgramUuid)
          .map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.name}
            </option>
          ))}
      </select>
    </Field>
  );
}

function RoleFlags({ draft }: { draft: GroupDraft }) {
  const { owner, programAdmin } = draft;
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={owner}
          onChange={(e) => draft.setOwner(e.target.checked)}
        />
        Aircraft owner (read-only owner portal)
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={owner}
          checked={!owner && programAdmin}
          onChange={(e) => draft.setProgramAdmin(e.target.checked)}
        />
        Flight Program administrator
      </label>
    </>
  );
}

function AircraftAccess({
  draft,
  review,
}: {
  draft: GroupDraft;
  review?: GroupAccessReport;
}) {
  return (
    <fieldset className="adm-checks">
      <legend>Aircraft access</legend>
      {!draft.owner && draft.programAdmin ? (
        <p className="muted">
          Flight Program administrators can access every aircraft in this
          program.
        </p>
      ) : (
        <>
          <ScopeChoice draft={draft} />
          <AccessNotices draft={draft} review={review} />
          <AircraftChecklist draft={draft} />
        </>
      )}
    </fieldset>
  );
}

function ScopeChoice({ draft }: { draft: GroupDraft }) {
  const { owner, scope, setScope } = draft;
  if (owner)
    return (
      <p className="muted">
        Owners see only the aircraft checked here; none are shown until you
        check them.
      </p>
    );
  return (
    <>
      <p className="muted">
        All aircraft includes aircraft added to the program later.
      </p>
      <label className="checkbox">
        <input
          type="radio"
          name="aircraftScope"
          checked={scope === "all"}
          onChange={() => setScope("all")}
        />
        All aircraft in this program
      </label>
      <label className="checkbox">
        <input
          type="radio"
          name="aircraftScope"
          checked={scope === "selected"}
          onChange={() => setScope("selected")}
        />
        Only selected aircraft
      </label>
    </>
  );
}

function AccessNotices({
  draft: { owner, scope, all, departed, checked, kept },
  review,
}: {
  draft: GroupDraft;
  review?: GroupAccessReport;
}) {
  return (
    <>
      {review && !owner && (
        <NoticeBar tone="warn" icon={Warning}>
          <strong>Confirm aircraft access.</strong> This group covers every
          aircraft in this program, but the change log does not show that this
          was chosen. {accessSummary(review)} Choose selected aircraft or all
          aircraft.
        </NoticeBar>
      )}
      {departed && (owner || scope === "selected") && !checked.length && (
        <NoticeBar tone="warn" icon={Warning} role="status">
          <strong>No aircraft in this program.</strong> The aircraft this group
          was limited to are no longer in this Flight Program.{" "}
          {owner
            ? "Check the owner's aircraft."
            : "Choose aircraft or all aircraft."}
        </NoticeBar>
      )}
      {kept.length > 0 && !all && (
        <p className="muted">
          Keeps {kept.length} aircraft chosen earlier; they must belong to the
          selected Flight Program.
        </p>
      )}
    </>
  );
}

function AircraftChecklist({ draft }: { draft: GroupDraft }) {
  const { listed, all, selected, fleetShown } = draft;
  return (
    <>
      {listed.map((a) => (
        <label className="checkbox" key={a.uuid}>
          <input
            type="checkbox"
            value={a.uuid}
            disabled={all}
            checked={!all && selected.includes(a.uuid)}
            onChange={(e) => draft.toggle(a.uuid, e.target.checked)}
          />
          {a.registration}
        </label>
      ))}
      {!fleetShown && (
        <p className="muted">
          Switch the active program to configure specific aircraft there.
        </p>
      )}
    </>
  );
}

function PermissionChecks({
  initial,
  owner,
}: {
  initial?: Group;
  owner: boolean;
}) {
  return PERMISSION_CHOICES.map(([key, label]) => (
    <label key={key} className="checkbox">
      <input
        type="checkbox"
        name="permissions"
        value={key}
        disabled={owner}
        defaultChecked={initial?.permissions.includes(key)}
      />
      {label}
    </label>
  ));
}

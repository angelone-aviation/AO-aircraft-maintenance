import { useState } from "react";
import { Warning } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { Group, Permission } from "../domain/model";
import {
  assertGroupAircraftChoice,
  CHOOSE_GROUP_AIRCRAFT,
  listsAllAircraft,
} from "../domain/groupAircraft";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import { AsyncForm, Field, value } from "./ui";
import { NoticeBar } from "./design";
import { accessSummary } from "./GroupAccessReview";
type AircraftScope = "all" | "selected" | "";
export function GroupForm({
  initial,
  review,
  onDone,
}: {
  initial?: Group;
  /** The change log does not show that this group's all-aircraft access was
   * chosen (groupAccessReview); the form asks for the choice again. */
  review?: GroupAccessReport;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [programUuid, setProgramUuid] = useState(
    initial?.programUuid ?? s!.activeProgramUuid ?? "",
  );
  const [owner, setOwner] = useState(!!initial?.owner);
  const [programAdmin, setProgramAdmin] = useState(!!initial?.programAdmin);
  // "All aircraft in this program" is an explicit choice, never the result of
  // an empty checklist (#34). A new group starts with neither chosen, and so
  // does a group whose all-aircraft access the change log cannot confirm.
  const [scope, setScope] = useState<AircraftScope>(
    !initial || review ? "" : listsAllAircraft(initial) ? "all" : "selected",
  );
  const [selected, setSelected] = useState(initial?.aircraftIds ?? []);
  const listed = s!.aircraft.filter((a) => a.programUuid === programUuid);
  // The snapshot holds the active program's fleet only. For another program
  // (an unscoped group being assigned) the group's aircraft cannot be shown,
  // so they are kept for the server to check against that program. In the
  // active program, ids no longer listed left it and are dropped.
  const fleetShown = !!programUuid && programUuid === s!.activeProgramUuid;
  const kept = fleetShown
    ? []
    : (initial?.aircraftIds ?? []).filter(
        (id) => !listed.some((a) => a.uuid === id),
      );
  const checked = listed.filter((a) => selected.includes(a.uuid));
  const aircraftIds = [...checked.map((a) => a.uuid), ...kept];
  const departed =
    fleetShown &&
    !!initial?.aircraftIds.length &&
    !initial.aircraftIds.some((id) => listed.some((a) => a.uuid === id));
  const all = !owner && scope === "all";
  return (
    <AsyncForm
      disabled={!online || !connected}
      onSubmit={async (data) => {
        const permissions = data
          .getAll("permissions")
          .map(String) as Permission[];
        const group = {
          id: initial?.id,
          programUuid,
          programAdmin: !owner && programAdmin,
          owner,
          name: value(data, "name"),
          permissions: owner
            ? ["read" as const]
            : [...new Set<Permission>(["read", ...permissions])],
          aircraftIds: all ? [] : aircraftIds,
          // Unset only while no choice was made (owners have none to make).
          allAircraft: owner || !scope ? undefined : all,
        };
        // An ordinary group always needs a choice here, even one the server
        // would still accept unchanged.
        if (!owner && !group.programAdmin && !scope)
          throw new Error(CHOOSE_GROUP_AIRCRAFT);
        // Same rule the server applies, shown before the round trip.
        assertGroupAircraftChoice(initial, group);
        await backend!.saveGroup(group);
        onDone();
      }}
    >
      <Field label="Group name">
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={initial?.name}
        />
      </Field>
      <Field label="Flight Program">
        <select
          value={programUuid}
          onChange={(e) => setProgramUuid(e.target.value)}
          disabled={!!initial?.programUuid}
          required
        >
          <option value="">Select Flight Program</option>
          {s!.programs
            ?.filter((p) => s!.user.isAdmin || p.uuid === s!.activeProgramUuid)
            .map((p) => (
              <option key={p.uuid} value={p.uuid}>
                {p.name}
              </option>
            ))}
        </select>
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={owner}
          onChange={(e) => setOwner(e.target.checked)}
        />
        Aircraft owner (read-only owner portal)
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={owner}
          checked={!owner && programAdmin}
          onChange={(e) => setProgramAdmin(e.target.checked)}
        />
        Flight Program administrator
      </label>
      <fieldset className="adm-checks">
        <legend>Aircraft access</legend>
        {!owner && programAdmin ? (
          <p className="muted">
            Flight Program administrators can access every aircraft in this
            program.
          </p>
        ) : (
          <>
            {owner ? (
              <p className="muted">
                Owners see only the aircraft checked here; none are shown until
                you check them.
              </p>
            ) : (
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
            )}
            {review && !owner && (
              <NoticeBar tone="warn" icon={Warning}>
                <strong>Confirm aircraft access.</strong> This group covers
                every aircraft in this program, but the change log does not show
                that this was chosen. {accessSummary(review)} Choose selected
                aircraft or all aircraft.
              </NoticeBar>
            )}
            {departed && (owner || scope === "selected") && !checked.length && (
              <NoticeBar tone="warn" icon={Warning} role="status">
                <strong>No aircraft in this program.</strong> The aircraft this
                group was limited to are no longer in this Flight Program.{" "}
                {owner
                  ? "Check the owner's aircraft."
                  : "Choose aircraft or all aircraft."}
              </NoticeBar>
            )}
            {kept.length > 0 && !all && (
              <p className="muted">
                Keeps {kept.length} aircraft chosen earlier; they must belong to
                the selected Flight Program.
              </p>
            )}
            {listed.map((a) => (
              <label className="checkbox" key={a.uuid}>
                <input
                  type="checkbox"
                  value={a.uuid}
                  disabled={all}
                  checked={!all && selected.includes(a.uuid)}
                  onChange={(e) => {
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, a.uuid]
                        : ids.filter((id) => id !== a.uuid),
                    );
                    // Checking an aircraft is choosing selected aircraft.
                    if (e.target.checked && !owner) setScope("selected");
                  }}
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
        )}
      </fieldset>
      <h3>Permissions</h3>
      <p className="muted">All groups can read their assigned aircraft.</p>
      {(
        [
          ["flight", "Add flights"],
          ["discrepancy", "Report discrepancies"],
          ["resolve", "Resolve discrepancies online"],
          ["maintenance", "Manage inspections and components online"],
        ] as const
      ).map(([key, label]) => (
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
      ))}
    </AsyncForm>
  );
}

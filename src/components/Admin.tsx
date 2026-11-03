import { DeleteGroupButton } from "./DeleteGroupButton";
import { Link } from "@tanstack/react-router";
import { GroupForm } from "./PermissionGroupForm";
import { GroupAccessNotice, useGroupAccessReview } from "./GroupAccessReview";
import { MemberAvatar, ProgramUsers } from "./ProgramUsers";
import { programPermission } from "../domain/programs";
import { groupAircraftLabel } from "../domain/groupAircraft";
import { UserProfileForm } from "./UserProfile";
import { AircraftForm } from "./Fleet";
import { useState } from "react";
import {
  AirplaneTilt,
  FolderLock,
  GearSix,
  Info,
  Key,
  PencilSimple,
  Plus,
  SignIn,
  Users,
  WifiSlash,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { aircraftMeterLabels, type Group, type Member } from "../domain/model";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import { AsyncForm, Field, Modal } from "./ui";
import { SignInMethodList } from "./SignInMethods";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../domain/accountRules";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  Segmented,
  StatusPill,
} from "./design";
import "../styles/screens/admin.css";

type AdminTab = "users" | "groups" | "aircraft";
const tabs = [
  { value: "users", label: "Users", icon: Users },
  { value: "groups", label: "Permission groups", icon: FolderLock },
  { value: "aircraft", label: "Aircraft", icon: AirplaneTilt },
];
const addLabels: Record<AdminTab, string> = {
  users: "Add user",
  groups: "Add group",
  aircraft: "Add aircraft",
};
/** Administration decides who can do what: users, permission groups and
 * aircraft access. Settings (Settings.tsx) holds how the app behaves. */
export function Administration() {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const [tab, setTab] = useState<AdminTab>("users"),
    [modal, setModal] = useState<
      "user" | "aircraft" | "group" | Member | Group | null
    >(null),
    [reset, setReset] = useState<Member | null>(null),
    [methods, setMethods] = useState<Member | null>(null),
    // Bumped when a group form closes, so the access check runs again even
    // when a save left the group's fields as they were.
    [groupSaves, setGroupSaves] = useState(0);
  const access = useGroupAccessReview(
    s!.user.isAdmin && tab === "groups" && online && connected,
    groupSaves,
  );
  if (!s!.user.isAdmin)
    return programPermission(s!, "admin") ? (
      <ProgramUsers key={s!.activeProgramUuid} />
    ) : (
      <EmptyState title="Administrator access required" />
    );
  const enabled = online && connected;
  const programGroups = s!.groups.filter(
    (g) => g.programUuid === s!.activeProgramUuid,
  );
  // A group in another program is edited with that program active, so its
  // aircraft can be listed.
  const editReviewed = async (report: GroupAccessReport) => {
    try {
      if (report.programUuid !== s!.activeProgramUuid)
        await backend!.selectProgram(report.programUuid);
      const group = useWorkspace
        .getState()
        .snapshot?.groups.find((g) => g.id === report.groupId);
      if (group) setModal(group);
    } catch (error) {
      useWorkspace.setState({
        error:
          error instanceof Error
            ? error.message
            : "Unable to switch Flight Program.",
      });
    }
  };
  return (
    <div className="adm-page">
      <PageHeader
        eyebrow="WORKSPACE MANAGEMENT"
        title="Administration"
        description="Manage your team, aircraft, and the permissions that connect them."
        actions={
          <button
            className="button primary adm-primary"
            disabled={!enabled}
            onClick={() =>
              setModal(
                tab === "users"
                  ? "user"
                  : tab === "groups"
                    ? "group"
                    : "aircraft",
              )
            }
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            {addLabels[tab]}
          </button>
        }
      />
      {!enabled && (
        <NoticeBar tone="neutral" icon={WifiSlash} className="rise">
          Administration requires a connection.
        </NoticeBar>
      )}
      {demo && (
        <NoticeBar tone="warn" icon={Info} className="rise">
          <strong>Local demo.</strong> Changes stay in this browser. Demo users
          cannot sign in and passwords are not stored.
        </NoticeBar>
      )}
      <Segmented
        label="Administration sections"
        className="adm-tabs rise"
        options={tabs}
        value={tab}
        onChange={(t) => setTab(t as AdminTab)}
      />
      {tab === "users" && (
        <section className="adm-list rise" aria-label="Users">
          {s!.members.map((user) => {
            const groups = user.groupIds
              .map((id) => s!.groups.find((g) => g.id === id)?.name)
              .filter(Boolean)
              .join(", ");
            const groupText = groups || "No Flight Program groups assigned";
            return (
              <div className="adm-row list-row" key={user.id}>
                <div className="adm-lead">
                  <MemberAvatar
                    name={user.name}
                    admin={user.active && user.isAdmin}
                  />
                  <div className="adm-text">
                    <strong className="adm-name">{user.name}</strong>
                    <span
                      className="adm-sub"
                      title={`${user.email} · ${groupText}`}
                    >
                      <span>{user.email}</span>
                      <span className="adm-sep" aria-hidden="true">
                        {" · "}
                      </span>
                      <span>{groupText}</span>
                    </span>
                  </div>
                </div>
                <StatusPill
                  dot={false}
                  tone={
                    !user.active ? "neutral" : user.isAdmin ? "blue" : "good"
                  }
                  className="adm-badge"
                >
                  {/* A disabled account is Disabled whatever its role (#53). */}
                  {!user.active
                    ? "Disabled"
                    : user.isAdmin
                      ? "Administrator"
                      : "Active"}
                </StatusPill>
                <div className="adm-actions">
                  <button
                    className="button small adm-button"
                    disabled={!enabled}
                    onClick={() => setModal(user)}
                  >
                    <PencilSimple size={15} aria-hidden="true" />
                    Edit access
                  </button>
                  <button
                    className="button small adm-icon-button"
                    aria-label="Reset password"
                    title="Reset password"
                    disabled={!enabled || demo}
                    onClick={() => setReset(user)}
                  >
                    <Key size={16} aria-hidden="true" />
                  </button>
                  <button
                    className="button small adm-icon-button"
                    aria-label="Sign-in methods"
                    title="Sign-in methods"
                    disabled={!enabled}
                    onClick={() => setMethods(user)}
                  >
                    <SignIn size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {tab === "groups" && (
        <GroupAccessNotice
          {...access}
          activeProgramUuid={s!.activeProgramUuid}
          disabled={!enabled}
          onEdit={(report) => void editReviewed(report)}
        />
      )}
      {tab === "groups" &&
        (programGroups.length ? (
          <section className="adm-groups rise" aria-label="Permission groups">
            {programGroups.map((group) => (
              <article className="adm-group list-row" key={group.id}>
                <div className="adm-group-head">
                  <IconTile icon={FolderLock} size="md" />
                  <strong className="adm-group-name">{group.name}</strong>
                </div>
                <p className="adm-group-meta">
                  {group.permissions.join(", ") || "No permissions"} ·{" "}
                  {s!.programs?.find((p) => p.uuid === group.programUuid)
                    ?.name ?? "Unassigned"}{" "}
                  ·{" "}
                  {group.programAdmin
                    ? "Flight Program administrator"
                    : group.owner && !group.aircraftIds.length
                      ? "Aircraft owner · No aircraft assigned"
                      : groupAircraftLabel(group, s!.aircraft)}
                </p>
                <div className="adm-actions adm-group-actions">
                  <button
                    className="button small adm-button"
                    disabled={!enabled}
                    onClick={() => setModal(group)}
                  >
                    Edit group
                  </button>
                  <DeleteGroupButton group={group} />
                </div>
              </article>
            ))}
          </section>
        ) : (
          <EmptyState title="No permission groups" className="rise">
            Create a group, assign aircraft and permissions, then add users to
            it.
          </EmptyState>
        ))}
      {tab === "aircraft" &&
        (s!.aircraft.length ? (
          <section className="adm-list rise" aria-label="Aircraft">
            {s!.aircraft.map((a) => (
              <div className="adm-row list-row" key={a.uuid}>
                <div className="adm-lead">
                  <IconTile icon={AirplaneTilt} tone="neutral" />
                  <div className="adm-text">
                    <strong className="adm-name">{a.registration}</strong>
                    <span className="adm-sub">
                      {a.make} {a.model} · {a.serial}
                    </span>
                  </div>
                </div>
                <StatusPill dot={false} tone="neutral" className="adm-badge">
                  {aircraftMeterLabels[a.meter]} tracking
                </StatusPill>
              </div>
            ))}
          </section>
        ) : (
          <EmptyState title="Add your first aircraft" className="rise">
            Use verified opening meter readings and counters.
          </EmptyState>
        ))}
      <NoticeBar icon={GearSix} className="adm-moved rise">
        Integration keys and data backups are in Settings → System.{" "}
        <Link to="/settings" hash="system">
          Open System settings
        </Link>
      </NoticeBar>
      {modal && (
        <Modal
          title={
            modal === "user"
              ? "Create user"
              : modal === "aircraft"
                ? "Add aircraft"
                : modal === "group"
                  ? "Create permission group"
                  : "email" in Object(modal)
                    ? "Edit user access"
                    : "Edit permission group"
          }
          onClose={() => setModal(null)}
        >
          {modal === "user" ? (
            <UserProfileForm onDone={() => setModal(null)} />
          ) : modal === "aircraft" ? (
            <AircraftForm onDone={() => setModal(null)} />
          ) : typeof modal === "object" && "email" in modal ? (
            <UserProfileForm initial={modal} onDone={() => setModal(null)} />
          ) : (
            <GroupForm
              initial={
                typeof modal === "object" && "permissions" in modal
                  ? modal
                  : undefined
              }
              review={access.reports.find(
                (r) => typeof modal === "object" && r.groupId === modal.id,
              )}
              onDone={() => {
                setModal(null);
                setGroupSaves((n) => n + 1);
              }}
            />
          )}
        </Modal>
      )}
      {reset && (
        <Modal
          title={`Reset password · ${reset.name}`}
          onClose={() => setReset(null)}
        >
          <AsyncForm
            disabled={!enabled}
            submitLabel="Reset password"
            onSubmit={async (data) => {
              await backend!.resetPassword(
                reset.id,
                String(data.get("password") ?? ""),
              );
              setReset(null);
            }}
          >
            <Field
              label="New password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easier to remember than a jumble; common passwords are refused.`}
            >
              <input
                type="password"
                name="password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                required
                autoComplete="new-password"
              />
            </Field>
            <p className="muted">
              Existing sessions will be revoked when the device reconnects.
            </p>
          </AsyncForm>
        </Modal>
      )}
      {methods && (
        <Modal
          title={`Sign-in methods · ${methods.name}`}
          onClose={() => setMethods(null)}
        >
          <p className="muted">
            Google or Microsoft accounts are linked when the person first signs
            in with one whose verified email is {methods.email}. Every sign-in
            and change is in the change log.
          </p>
          <SignInMethodList member={methods} />
        </Modal>
      )}
    </div>
  );
}

/**
 * Responsibility: The Administration screen: users, permission groups and
 *   aircraft access.
 * Layer: UI. React components; the server enforces every permission shown.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/data/backend.ts (types), src/domain (programs,
 *   groupAircraft, model, groupAccessReview, accountRules, usersByGroup),
 *   ./CertificateApprovals, ./DeleteGroupButton, ./PermissionGroupForm,
 *   ./GroupAccessReview, ./ProgramUsers, ./UserProfile, ./Fleet,
 *   ./charts, ./ui, ./design, src/styles/screens/admin.css.
 */
import { CertificateApprovals } from "./CertificateApprovals";
import { DeleteGroupButton } from "./DeleteGroupButton";
import { Link } from "@tanstack/react-router";
import { GroupForm } from "./PermissionGroupForm";
import { GroupAccessNotice, useGroupAccessReview } from "./GroupAccessReview";
import { ListHead, MemberAvatar, ProgramUsers } from "./ProgramUsers";
import { BarChart } from "./charts";
import { usersByGroup } from "../domain/usersByGroup";
import { programPermission } from "../domain/programs";
import { groupAircraftLabel } from "../domain/groupAircraft";
import { UserProfileForm } from "./UserProfile";
import { AircraftForm } from "./Fleet";
import { useMemo, useState } from "react";
import {
  AirplaneTilt,
  FolderLock,
  GearSix,
  Info,
  Key,
  PencilSimple,
  Plus,
  Users,
  WifiSlash,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import {
  aircraftMeterLabels,
  type Aircraft,
  type Group,
  type Member,
  type Snapshot,
} from "../domain/model";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import { AsyncForm, Field, Modal, errorText } from "./ui";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../domain/accountRules";
import {
  EmptyState,
  IconTile,
  NoticeBar,
  PageHeader,
  SectionHeading,
  Segmented,
  StatusPill,
} from "./design";
import "../styles/screens/admin.css";

type AdminTab = "users" | "groups" | "aircraft";
type NewDialog = "user" | "group" | "aircraft";
type AdminDialog = NewDialog | Member | Group;
type UserActions = {
  enabled: boolean;
  demo: boolean;
  onEdit: (member: Member) => void;
  onReset: (member: Member) => void;
};
type Dialogs = ReturnType<typeof useAdminDialogs>;
type FormProps = {
  dialog: AdminDialog;
  reports: GroupAccessReport[];
  onClose: () => void;
  onGroupDone: () => void;
};

const TABS = [
  { value: "users", label: "Users", icon: Users },
  { value: "groups", label: "Permission groups", icon: FolderLock },
  { value: "aircraft", label: "Aircraft", icon: AirplaneTilt },
];
const USER_SERIES = [{ key: "users", label: "Active users" }];
const CHART_HEIGHT = 180;
// People come in whole numbers: an axis tick between two counts shows no
// label.
const wholeUsers = (count: number) =>
  Number.isInteger(count) ? String(count) : "";
// The header's add button: its label and the dialog it opens, by tab.
const ADD: Record<AdminTab, { label: string; dialog: NewDialog }> = {
  users: { label: "Add user", dialog: "user" },
  groups: { label: "Add group", dialog: "group" },
  aircraft: { label: "Add aircraft", dialog: "aircraft" },
};

/**
 * Administration decides who can do what: users, permission groups and
 * aircraft access; Settings holds how the app behaves. A program
 * administrator who is not an app administrator sees the program's users
 * instead. Every change needs a connection.
 */
export function Administration() {
  const { snapshot, backend, online, connected, demo } = useWorkspace();
  const s = snapshot!;
  const [tab, setTab] = useState<AdminTab>("users");
  const dialogs = useAdminDialogs();
  const enabled = online && connected;
  const access = useGroupAccessReview(
    s.user.isAdmin && tab === "groups" && enabled,
    dialogs.groupSaves,
  );
  if (!s.user.isAdmin) return <ProgramAdministration s={s} />;
  const { setDialog, setReset } = dialogs;
  const actions = { enabled, demo, onReset: setReset };
  return (
    <div className="adm-page">
      <AdminHeader
        tab={tab}
        enabled={enabled}
        demo={demo}
        onTab={setTab}
        onAdd={() => setDialog(ADD[tab].dialog)}
      />
      {tab === "users" && <CertificateApprovals />}
      {tab === "users" && <UserList s={s} {...actions} onEdit={setDialog} />}
      {tab === "users" && <UsersByGroup s={s} />}
      {tab === "groups" && (
        <GroupAccessNotice
          {...access}
          activeProgramUuid={s.activeProgramUuid}
          disabled={!enabled}
          onEdit={(r) => void editReviewed(r, s, backend, setDialog)}
        />
      )}
      {tab === "groups" && (
        <GroupList s={s} enabled={enabled} onEdit={setDialog} />
      )}
      {tab === "aircraft" && <AircraftList aircraft={s.aircraft} />}
      <SettingsMoved />
      <AdminDialogs {...dialogs} reports={access.reports} enabled={enabled} />
    </div>
  );
}

function useAdminDialogs() {
  const [dialog, setDialog] = useState<AdminDialog | null>(null),
    [reset, setReset] = useState<Member | null>(null),
    // Bumped when a group form closes, so the access check runs again even
    // when a save left the group's fields as they were.
    [groupSaves, setGroupSaves] = useState(0);
  const groupDone = () => {
    setDialog(null);
    setGroupSaves((n) => n + 1);
  };
  return {
    dialog,
    setDialog,
    reset,
    setReset,
    groupSaves,
    groupDone,
  };
}

function AdminDialogs({
  reports,
  enabled,
  ...d
}: Dialogs & { reports: GroupAccessReport[]; enabled: boolean }) {
  return (
    <>
      {d.dialog && (
        <AdminForm
          dialog={d.dialog}
          reports={reports}
          onClose={() => d.setDialog(null)}
          onGroupDone={d.groupDone}
        />
      )}
      {d.reset && (
        <ResetPassword
          member={d.reset}
          enabled={enabled}
          onClose={() => d.setReset(null)}
        />
      )}
    </>
  );
}

function ProgramAdministration({ s }: { s: Snapshot }) {
  return programPermission(s, "admin") ? (
    <ProgramUsers key={s.activeProgramUuid} />
  ) : (
    <EmptyState title="Administrator access required" />
  );
}

// A group in another program is edited with that program active, so its
// aircraft can be listed. A failed switch shows as the workspace error.
async function editReviewed(
  report: GroupAccessReport,
  s: Snapshot,
  backend: Backend | null | undefined,
  onGroup: (group: Group) => void,
) {
  try {
    if (report.programUuid !== s.activeProgramUuid)
      await backend!.selectProgram(report.programUuid);
    const group = useWorkspace
      .getState()
      .snapshot?.groups.find((g) => g.id === report.groupId);
    if (group) onGroup(group);
  } catch (error) {
    useWorkspace.setState({
      error: errorText(error, "Unable to switch Flight Program."),
    });
  }
}

function AdminHeader({
  tab,
  enabled,
  demo,
  onTab,
  onAdd,
}: {
  tab: AdminTab;
  enabled: boolean;
  demo: boolean;
  onTab: (tab: AdminTab) => void;
  onAdd: () => void;
}) {
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE MANAGEMENT"
        title="Administration"
        description="Manage your team, aircraft, and the permissions that connect them."
        actions={<AddButton tab={tab} enabled={enabled} onAdd={onAdd} />}
      />
      <AdminNotices enabled={enabled} demo={demo} />
      <Segmented
        label="Administration sections"
        className="adm-tabs rise"
        options={TABS}
        value={tab}
        onChange={(t) => onTab(t as AdminTab)}
      />
    </>
  );
}

function AddButton({
  tab,
  enabled,
  onAdd,
}: {
  tab: AdminTab;
  enabled: boolean;
  onAdd: () => void;
}) {
  return (
    <button
      className="button primary adm-primary"
      disabled={!enabled}
      onClick={onAdd}
    >
      <Plus size={18} weight="bold" aria-hidden="true" />
      {ADD[tab].label}
    </button>
  );
}

function AdminNotices({ enabled, demo }: { enabled: boolean; demo: boolean }) {
  return (
    <>
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
    </>
  );
}

function UserList({ s, ...actions }: UserActions & { s: Snapshot }) {
  return (
    <section className="adm-list rise" aria-label="Users">
      <ListHead lead="User" status="Status" actions="Actions" />
      {s.members.map((user) => (
        <div className="adm-row list-row" key={user.id}>
          <UserIdentity user={user} groups={s.groups} />
          <UserStatus user={user} />
          <UserButtons user={user} {...actions} />
        </div>
      ))}
    </section>
  );
}

// Shown once any group exists. admin.css hides it on a phone, where each
// user's row already names their groups.
function UsersByGroup({ s }: { s: Snapshot }) {
  const rows = useMemo(
    () =>
      usersByGroup(s.members, s.groups, s.programs).map((g) => ({
        label: g.label,
        values: { users: g.users },
      })),
    [s.members, s.groups, s.programs],
  );
  if (!rows.length) return null;
  return (
    <section className="ds-section adm-chart rise">
      <SectionHeading
        title="Users by permission group"
        note="Active accounts; a user in two groups counts in both"
      />
      <div className="ds-card">
        <BarChart
          label="Active users by permission group"
          categoryLabel="Permission group"
          rows={rows}
          series={USER_SERIES}
          format={wholeUsers}
          wholeNumbers
          height={CHART_HEIGHT}
        />
      </div>
    </section>
  );
}

function UserIdentity({ user, groups }: { user: Member; groups: Group[] }) {
  const names = user.groupIds
    .map((id) => groups.find((g) => g.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const groupText = names || "No Flight Program groups assigned";
  return (
    <div className="adm-lead">
      <MemberAvatar name={user.name} admin={user.active && user.isAdmin} />
      <div className="adm-text">
        <strong className="adm-name">{user.name}</strong>
        <span className="adm-sub" title={`${user.email} · ${groupText}`}>
          <span>{user.email}</span>
          <span className="adm-sep" aria-hidden="true">
            {" · "}
          </span>
          <span>{groupText}</span>
        </span>
      </div>
    </div>
  );
}

function UserStatus({ user }: { user: Member }) {
  const [tone, label] = memberStatus(user);
  return (
    <StatusPill dot={false} tone={tone} className="adm-badge">
      {label}
    </StatusPill>
  );
}

// A disabled account is Disabled whatever its role (#53).
function memberStatus(user: Member) {
  if (!user.active) return ["neutral", "Disabled"] as const;
  if (user.isAdmin) return ["blue", "Administrator"] as const;
  return ["good", "Active"] as const;
}

function UserButtons({ user, ...a }: UserActions & { user: Member }) {
  return (
    <div className="adm-actions">
      <button
        className="button small adm-button"
        disabled={!a.enabled}
        onClick={() => a.onEdit(user)}
      >
        <PencilSimple size={15} aria-hidden="true" />
        Edit access
      </button>
      <button
        className="button small adm-icon-button"
        aria-label="Reset password"
        title="Reset password"
        disabled={!a.enabled || a.demo}
        onClick={() => a.onReset(user)}
      >
        <Key size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function GroupList({
  s,
  enabled,
  onEdit,
}: {
  s: Snapshot;
  enabled: boolean;
  onEdit: (group: Group) => void;
}) {
  const groups = s.groups.filter((g) => g.programUuid === s.activeProgramUuid);
  if (!groups.length)
    return (
      <EmptyState title="No permission groups" className="rise">
        Create a group, assign aircraft and permissions, then add users to it.
      </EmptyState>
    );
  return (
    <section className="adm-groups rise" aria-label="Permission groups">
      {groups.map((group) => (
        <article className="adm-group list-row" key={group.id}>
          <div className="adm-group-head">
            <IconTile icon={FolderLock} size="md" />
            <strong className="adm-group-name">{group.name}</strong>
          </div>
          <p className="adm-group-meta">{groupSummary(group, s)}</p>
          <div className="adm-actions adm-group-actions">
            <button
              className="button small adm-button"
              disabled={!enabled}
              onClick={() => onEdit(group)}
            >
              Edit group
            </button>
            <DeleteGroupButton group={group} />
          </div>
        </article>
      ))}
    </section>
  );
}

// Permissions · program · the aircraft the group covers.
function groupSummary(group: Group, s: Snapshot) {
  const program = s.programs?.find((p) => p.uuid === group.programUuid);
  return [
    group.permissions.join(", ") || "No permissions",
    program?.name ?? "Unassigned",
    groupScope(group, s.aircraft),
  ].join(" · ");
}

function groupScope(group: Group, aircraft: Aircraft[]) {
  if (group.programAdmin) return "Flight Program administrator";
  if (group.owner && !group.aircraftIds.length)
    return "Aircraft owner · No aircraft assigned";
  if (group.board)
    return `Board (read-only) · ${groupAircraftLabel(group, aircraft)}`;
  return groupAircraftLabel(group, aircraft);
}

function AircraftList({ aircraft }: { aircraft: Aircraft[] }) {
  if (!aircraft.length)
    return (
      <EmptyState title="Add your first aircraft" className="rise">
        Use verified opening meter readings and counters.
      </EmptyState>
    );
  return (
    <section className="adm-list rise" aria-label="Aircraft">
      <ListHead lead="Aircraft" status="Tracking" />
      {aircraft.map((a) => (
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
  );
}

function SettingsMoved() {
  return (
    <NoticeBar icon={GearSix} className="adm-moved rise">
      FAA and address keys, the deployment&apos;s expiring dates and backups:
      Settings → System.{" "}
      <Link to="/settings" hash="system">
        Open System settings
      </Link>
    </NoticeBar>
  );
}

function AdminForm(props: FormProps) {
  return (
    <Modal title={dialogTitle(props.dialog)} onClose={props.onClose}>
      <DialogForm {...props} />
    </Modal>
  );
}

function dialogTitle(dialog: AdminDialog) {
  if (dialog === "user") return "Create user";
  if (dialog === "aircraft") return "Add aircraft";
  if (dialog === "group") return "Create permission group";
  return "email" in dialog ? "Edit user access" : "Edit permission group";
}

function DialogForm({ dialog, reports, onClose, onGroupDone }: FormProps) {
  if (dialog === "user") return <UserProfileForm onDone={onClose} />;
  if (dialog === "aircraft") return <AircraftForm onDone={onClose} />;
  if (typeof dialog === "object" && "email" in dialog)
    return <UserProfileForm initial={dialog} onDone={onClose} />;
  const group = dialog === "group" ? undefined : dialog;
  return (
    <GroupForm
      initial={group}
      review={group && reports.find((r) => r.groupId === group.id)}
      onDone={onGroupDone}
    />
  );
}

function ResetPassword({
  member,
  enabled,
  onClose,
}: {
  member: Member;
  enabled: boolean;
  onClose: () => void;
}) {
  const { backend } = useWorkspace();
  return (
    <Modal title={`Reset password · ${member.name}`} onClose={onClose}>
      <AsyncForm
        disabled={!enabled}
        submitLabel="Reset password"
        onSubmit={async (data) => {
          await backend!.resetPassword(
            member.id,
            String(data.get("password") ?? ""),
          );
          onClose();
        }}
      >
        <NewPasswordField />
        <p className="muted">
          Existing sessions will be revoked when the device reconnects.
        </p>
      </AsyncForm>
    </Modal>
  );
}

function NewPasswordField() {
  return (
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
  );
}

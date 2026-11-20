/**
 * Responsibility: The Flight Program administration screen (its users,
 *   permission groups and aircraft, and the forms that change them), plus the
 *   member avatar, list column header and CSV export card other screens
 *   reuse.
 * Layer: UI. React components; the server enforces every permission shown.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (model, programs, groupAircraft,
 *   accountRules), ./CertificateApprovals, ./DeleteGroupButton,
 *   ./PermissionGroupForm, ./Fleet, ./ui,
 *   ./design, src/styles/screens/admin.css (and settings.css for the CSV
 *   export card, which only Settings shows).
 */
import { CertificateApprovals } from "./CertificateApprovals";
import { DeleteGroupButton } from "./DeleteGroupButton";
import { Link } from "@tanstack/react-router";
import { GroupForm } from "./PermissionGroupForm";
import { AircraftForm } from "./Fleet";
import type { Group, Member, Aircraft, Snapshot } from "../domain/model";
import { useId, useState, type ReactNode } from "react";
import {
  AirplaneTilt,
  Buildings,
  DownloadSimple,
  FolderLock,
  GearSix,
  Info,
  PencilSimple,
  Plus,
  UserPlus,
  WifiSlash,
} from "@phosphor-icons/react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import { activeProgram } from "../domain/programs";
import { groupAircraftLabel } from "../domain/groupAircraft";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isProgramMember,
} from "../domain/accountRules";
import { AsyncForm, Field, Modal, value } from "./ui";
import { IconTile, NoticeBar, PageHeader, StatusPill } from "./design";
import "../styles/screens/admin.css";

/**
 * A member's initials (at most two) in a circle, filled blue for an
 * administrator. Decorative: the name always renders beside it.
 *
 * @param props.admin - Whether the member is a system administrator.
 */
export function MemberAvatar({
  name,
  admin = false,
}: {
  name: string;
  admin?: boolean;
}) {
  return (
    <span
      className={"adm-avatar" + (admin ? " adm-avatar-admin" : "")}
      aria-hidden="true"
    >
      {name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}

/**
 * The small uppercase column header of a users or aircraft list card, shown
 * on wide screens only. Decorative: each row already says what it holds.
 *
 * @param props.lead - Heads the name column.
 * @param props.status - Heads the status pill column.
 * @param props.actions - Heads the row buttons, at the right.
 */
export function ListHead({
  lead,
  status,
  actions,
}: {
  lead: string;
  status?: string;
  actions?: string;
}) {
  return (
    <div className="adm-row-head" aria-hidden="true">
      <span>{lead}</span>
      {status && <span className="adm-badge">{status}</span>}
      {actions && <span className="adm-head-actions">{actions}</span>}
    </div>
  );
}

/**
 * A card with an h3 title, optional text, and one download button per CSV
 * table, named "Download <file>.csv".
 *
 * @param props.tables - Table names, in button order.
 * @param props.fileNames - The file name shown for a table; the table name
 *   when absent.
 * @param props.onDownload - Called with the table whose button was pressed.
 */
export function CsvExportCard({
  title,
  children,
  tables,
  fileNames = {},
  onDownload,
}: {
  title: string;
  children?: ReactNode;
  tables: readonly string[];
  fileNames?: Partial<Record<string, string>>;
  onDownload: (table: string) => void;
}) {
  const titleId = useId();
  return (
    <section className="set-extract" aria-labelledby={titleId}>
      <div className="set-extract-head">
        <DownloadSimple size={20} aria-hidden="true" />
        <h3 id={titleId}>{title}</h3>
      </div>
      {children && <p className="set-extract-text">{children}</p>}
      <div className="ds-chips wrap">
        {tables.map((table) => {
          const file = `${fileNames[table] ?? table}.csv`;
          return (
            <button
              type="button"
              className="ds-chip"
              key={table}
              aria-label={`Download ${file}`}
              onClick={() => onDownload(table)}
            >
              {file}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The active Flight Program's administration screen: its users, permission
 * groups and aircraft, with forms to add a user, add an existing account,
 * edit a member's program access, and add or edit a group or an aircraft.
 * Every change needs a connection.
 *
 * @returns The screen. Saving calls `backend.createProgramUser`,
 *   `updateProgramAccess` or `addExistingProgramUser`, which the server audits;
 *   the group and aircraft forms save themselves.
 */
export function ProgramUsers() {
  const { snapshot: s, online, connected, demo } = useWorkspace();
  const dialogs = useDialogs();
  const enabled = online && connected;
  const props = { roster: programRoster(s!), enabled, dialogs };
  return (
    <div className="adm-page">
      <AdministrationHeader {...props} />
      <ConnectionNotices enabled={enabled} demo={demo} />
      <CertificateApprovals />
      <UsersSection {...props} />
      <GroupsSection {...props} />
      <AircraftSection {...props} />
      <SettingsMovedNotice />
      <AdministrationDialogs {...props} />
    </div>
  );
}

type Roster = ReturnType<typeof programRoster>;
type ScreenProps = {
  roster: Roster;
  enabled: boolean;
  dialogs: ReturnType<typeof useDialogs>;
};

function useDialogs() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [existing, setExisting] = useState(false);
  const [notice, setNotice] = useState("");
  const [group, setGroup] = useState<Group | "new" | null>(null);
  const [aircraft, setAircraft] = useState<Aircraft | "new" | null>(null);
  return {
    ...{ open, setOpen, editing, setEditing, existing, setExisting },
    ...{ notice, setNotice, group, setGroup, aircraft, setAircraft },
  };
}

function programRoster(s: Snapshot) {
  const programUuid = activeProgram(s)!;
  return {
    programUuid,
    program: s.programs?.find((p) => p.uuid === programUuid),
    groups: s.groups.filter((g) => g.programUuid === programUuid),
    members: s.members.filter((m) =>
      isProgramMember(s.groups, m.groupIds, programUuid),
    ),
    aircraft: s.aircraft.filter((a) => a.programUuid === programUuid),
  };
}

function AdministrationHeader({ roster, enabled, dialogs }: ScreenProps) {
  return (
    <PageHeader
      title="Administration"
      eyebrow={roster.program?.name ?? "Flight Program"}
      description="Manage users, permission groups and aircraft access within this Flight Program."
      actions={
        <>
          <Link className="button adm-secondary" to="/settings" hash="program">
            <Buildings size={18} aria-hidden="true" />
            Flight Program settings
          </Link>
          <button
            className="button primary adm-primary"
            disabled={!enabled}
            onClick={() => dialogs.setOpen(true)}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            Add user
          </button>
        </>
      }
    />
  );
}

function ConnectionNotices({
  enabled,
  demo,
}: {
  enabled: boolean;
  demo: boolean;
}) {
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
          cannot sign in.
        </NoticeBar>
      )}
    </>
  );
}

function UsersSection({ roster, enabled, dialogs }: ScreenProps) {
  const { members, groups } = roster;
  const addExisting = () => {
    dialogs.setNotice("");
    dialogs.setExisting(true);
  };
  const action = (
    <button
      className="button small adm-button"
      disabled={!enabled}
      onClick={addExisting}
    >
      <UserPlus size={16} aria-hidden="true" />
      Add existing user
    </button>
  );
  return (
    <AdminSection title="Users" count={members.length} action={action}>
      {dialogs.notice && (
        <NoticeBar tone="blue" icon={Info} role="status">
          {dialogs.notice}
        </NoticeBar>
      )}
      {members.length > 0 && (
        <div className="adm-list">
          <ListHead lead="User" status="Status" actions="Actions" />
          {members.map((m) => (
            <MemberRow key={m.id} member={m} groups={groups}>
              <EditButton
                enabled={enabled}
                onClick={() => dialogs.setEditing(m)}
              >
                Edit program access
              </EditButton>
            </MemberRow>
          ))}
        </div>
      )}
    </AdminSection>
  );
}

function MemberRow({
  member: m,
  groups,
  children,
}: {
  member: Member;
  groups: Group[];
  children: ReactNode;
}) {
  const memberGroups = groups
    .filter((g) => m.groupIds.includes(g.id))
    .map((g) => g.name)
    .join(", ");
  return (
    <div className="adm-row list-row">
      <div className="adm-lead">
        <MemberAvatar name={m.name} admin={m.isAdmin} />
        <div className="adm-text">
          <strong className="adm-name">{m.name}</strong>
          <span className="adm-sub" title={`${m.email} · ${memberGroups}`}>
            <span>{m.email}</span>
            <span className="adm-sep" aria-hidden="true">
              {" · "}
            </span>
            <span>{memberGroups}</span>
          </span>
        </div>
      </div>
      {/* Disabled accounts can still be listed (historical pilots); never
       * present them as active members (#53). */}
      {!m.active && (
        <StatusPill dot={false} tone="neutral" className="adm-badge">
          Disabled
        </StatusPill>
      )}
      <div className="adm-actions">{children}</div>
    </div>
  );
}

function GroupsSection({ roster, enabled, dialogs }: ScreenProps) {
  const { groups } = roster;
  const action = (
    <AddButton enabled={enabled} onClick={() => dialogs.setGroup("new")}>
      Add group
    </AddButton>
  );
  return (
    <AdminSection
      title="Permission groups"
      count={groups.length}
      action={action}
    >
      {groups.length > 0 && (
        <div className="adm-groups">
          {groups.map((g) => (
            <article className="adm-group list-row" key={g.id}>
              <div className="adm-group-head">
                <IconTile icon={FolderLock} size="md" />
                <strong className="adm-group-name">{g.name}</strong>
              </div>
              <p className="adm-group-meta">
                {groupSummary(g, roster.aircraft)}
              </p>
              <GroupActions group={g} enabled={enabled} dialogs={dialogs} />
            </article>
          ))}
        </div>
      )}
    </AdminSection>
  );
}

function GroupActions({
  group,
  enabled,
  dialogs,
}: Omit<ScreenProps, "roster"> & { group: Group }) {
  return (
    <div className="adm-actions adm-group-actions">
      <button
        className="button small adm-button"
        disabled={!enabled}
        onClick={() => dialogs.setGroup(group)}
      >
        Edit group
      </button>
      <DeleteGroupButton group={group} />
    </div>
  );
}

function groupSummary(g: Group, programAircraft: Aircraft[]) {
  if (g.programAdmin)
    return "Flight Program administrator · All program aircraft";
  const aircraft = groupAircraftLabel(g, programAircraft);
  if (g.owner) return `Aircraft owner (read-only portal) · ${aircraft}`;
  if (g.board) return `Board member (read-only board view) · ${aircraft}`;
  return `${g.permissions.join(", ")} · ${aircraft}`;
}

function AircraftSection({ roster, enabled, dialogs }: ScreenProps) {
  const { aircraft } = roster;
  const action = (
    <AddButton enabled={enabled} onClick={() => dialogs.setAircraft("new")}>
      Add aircraft
    </AddButton>
  );
  return (
    <AdminSection title="Aircraft" count={aircraft.length} action={action}>
      {aircraft.length > 0 && (
        <div className="adm-list">
          <ListHead lead="Aircraft" actions="Actions" />
          {aircraft.map((a) => (
            <div className="adm-row list-row" key={a.uuid}>
              <div className="adm-lead">
                <IconTile icon={AirplaneTilt} tone="neutral" />
                <div className="adm-text">
                  <strong className="adm-name">{a.registration}</strong>
                  <span className="adm-sub">
                    {a.make} {a.model}
                  </span>
                </div>
              </div>
              <div className="adm-actions">
                <EditButton
                  enabled={enabled}
                  onClick={() => dialogs.setAircraft(a)}
                >
                  Edit aircraft
                </EditButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </AdminSection>
  );
}

type ButtonProps = {
  enabled: boolean;
  onClick: () => void;
  children: ReactNode;
};

function AddButton({ enabled, onClick, children }: ButtonProps) {
  return (
    <button
      className="button small adm-button"
      disabled={!enabled}
      onClick={onClick}
    >
      <Plus size={15} aria-hidden="true" />
      {children}
    </button>
  );
}

function EditButton({ enabled, onClick, children }: ButtonProps) {
  return (
    <button
      className="button small adm-button"
      disabled={!enabled}
      onClick={onClick}
    >
      <PencilSimple size={15} aria-hidden="true" />
      {children}
    </button>
  );
}

function SettingsMovedNotice() {
  return (
    <NoticeBar icon={GearSix} className="adm-moved rise">
      Program details, labor rate, expiring dates, Aircraft Spruce account and
      exports: Settings → Flight Program.{" "}
      <Link to="/settings" hash="program">
        Open Flight Program settings
      </Link>
    </NoticeBar>
  );
}

function AdminSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="adm-section rise" aria-labelledby={titleId}>
      <div className="adm-section-head">
        <h2 id={titleId}>{title}</h2>
        <span className="adm-count">{String(count).padStart(2, "0")}</span>
        {action && <div className="adm-section-action">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function AdministrationDialogs(props: ScreenProps) {
  const { group, aircraft, editing, existing, open } = props.dialogs;
  const { setGroup, setAircraft } = props.dialogs;
  return (
    <>
      {group && <GroupDialog group={group} onClose={() => setGroup(null)} />}
      {aircraft && (
        <AircraftDialog aircraft={aircraft} onClose={() => setAircraft(null)} />
      )}
      {(editing || existing) && <ProgramAccessDialog {...props} />}
      {open && <AddUserDialog {...props} />}
    </>
  );
}

function GroupDialog({
  group,
  onClose,
}: {
  group: Group | "new";
  onClose: () => void;
}) {
  const isNew = group === "new";
  return (
    <Modal
      title={isNew ? "Create permission group" : "Edit permission group"}
      onClose={onClose}
    >
      <GroupForm initial={isNew ? undefined : group} onDone={onClose} />
    </Modal>
  );
}

function AircraftDialog({
  aircraft,
  onClose,
}: {
  aircraft: Aircraft | "new";
  onClose: () => void;
}) {
  const isNew = aircraft === "new";
  return (
    <Modal title={isNew ? "Add aircraft" : "Edit aircraft"} onClose={onClose}>
      <AircraftForm initial={isNew ? undefined : aircraft} onDone={onClose} />
    </Modal>
  );
}

// Edits a member's groups in this program, or, with no member, gives an
// existing account the program's groups by email.
function ProgramAccessDialog({ roster, enabled, dialogs }: ScreenProps) {
  const { backend } = useWorkspace();
  const member = dialogs.editing;
  const close = () => {
    dialogs.setEditing(null);
    dialogs.setExisting(false);
  };
  const submit = async (d: FormData) => {
    await saveProgramAccess(backend!, roster, member, d, dialogs.setNotice);
    close();
  };
  const title = member ? "Edit program access" : "Add existing user";
  return (
    <Modal title={title} onClose={close}>
      <AsyncForm
        disabled={!enabled}
        submitLabel="Save program access"
        onSubmit={submit}
      >
        <ProgramLine name={roster.program?.name} />
        <MemberOrEmail member={member} />
        <fieldset className="adm-checks">
          <legend>Permission groups</legend>
          <GroupChoices groups={roster.groups} checked={member?.groupIds} />
        </fieldset>
        {member && (
          <label className="checkbox adm-remove">
            <input type="checkbox" name="remove" />
            Remove access to this Flight Program
          </label>
        )}
        <p className="muted">
          Changes apply only to this Flight Program. Access to other programs
          and account credentials stay unchanged.
        </p>
      </AsyncForm>
    </Modal>
  );
}

async function saveProgramAccess(
  backend: Backend,
  { programUuid }: Roster,
  member: Member | null,
  d: FormData,
  onNotice: (notice: string) => void,
) {
  const ids = d.getAll("group").map(String);
  if (member)
    return backend.updateProgramAccess(
      member.id,
      programUuid,
      ids,
      d.has("remove"),
    );
  // The reply is the same whether or not the account exists, so the notice
  // never reveals which emails have accounts.
  onNotice(
    await backend.addExistingProgramUser(value(d, "email"), programUuid, ids),
  );
}

function MemberOrEmail({ member }: { member: Member | null }) {
  if (member)
    return (
      <p className="adm-form-member">
        {member.name} · {member.email}
      </p>
    );
  return (
    <Field label="Existing account email">
      <input type="email" name="email" required />
    </Field>
  );
}

function AddUserDialog({ roster, enabled, dialogs }: ScreenProps) {
  const { backend } = useWorkspace();
  const onClose = () => dialogs.setOpen(false);
  const submit = async (d: FormData) => {
    await backend!.createProgramUser(
      value(d, "email"),
      value(d, "name"),
      value(d, "password"),
      roster.programUuid,
      d.getAll("group").map(String),
    );
    onClose();
  };
  return (
    <Modal title="Add user" onClose={onClose}>
      <AsyncForm
        key={roster.programUuid}
        disabled={!enabled}
        submitLabel="Create account"
        onSubmit={submit}
      >
        <ProgramLine name={roster.program?.name} />
        <NewAccountFields />
        <fieldset className="adm-checks">
          <legend>Permission groups</legend>
          <p className="muted">
            If you select no groups, Observers provides read-only access. Select
            other groups for additional permissions.
          </p>
          <GroupChoices groups={roster.groups} />
        </fieldset>
      </AsyncForm>
    </Modal>
  );
}

function NewAccountFields() {
  return (
    <>
      <Field label="Full name">
        <input name="name" required maxLength={ACCOUNT_NAME_MAX_LENGTH} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" required autoComplete="off" />
      </Field>
      <Field
        label="Initial password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters; common passwords are refused.`}
      >
        <input
          name="password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete="new-password"
        />
      </Field>
    </>
  );
}

function ProgramLine({ name }: { name: string | undefined }) {
  return (
    <p className="adm-form-program">
      Flight Program: <strong>{name}</strong>
    </p>
  );
}

function GroupChoices({
  groups,
  checked,
}: {
  groups: Group[];
  checked?: string[];
}) {
  return (
    <>
      {groups.map((g) => (
        <label key={g.id} className="checkbox">
          <input
            type="checkbox"
            name="group"
            value={g.id}
            defaultChecked={checked?.includes(g.id)}
          />
          {g.name}
          {g.programAdmin ? " (Flight Program administrator)" : ""}
          {g.owner ? " (Aircraft owner, read-only)" : ""}
          {g.board ? " (Board, read-only)" : ""}
        </label>
      ))}
    </>
  );
}

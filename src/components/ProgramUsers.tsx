import { DeleteGroupButton } from "./DeleteGroupButton";
import { Link } from "@tanstack/react-router";
import { GroupForm } from "./PermissionGroupForm";
import { AircraftForm } from "./Fleet";
import type { Group, Member, Aircraft } from "../domain/model";
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
import { useWorkspace } from "../data/store";
import { activeProgram } from "../domain/programs";
import { groupAircraftLabel } from "../domain/groupAircraft";
import { AsyncForm, Field, Modal, value } from "./ui";
import { IconTile, NoticeBar, PageHeader, StatusPill } from "./design";
import "../styles/screens/admin.css";

/* ── Pieces shared with Administration (Admin.tsx) and Settings
 * (CsvExportCard). Candidates for promotion into design.tsx: MemberAvatar,
 * CsvExportCard, AdminSection. ── */

/** 44px initials circle; administrators get the blue fill. Decorative: the
 * member's name is always rendered beside it. */
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

/** Card with a heading and one pill button per CSV table. Settings nests it
 * under a section heading, so the title is an h3. */
export function CsvExportCard({
  title,
  children,
  tables,
  onDownload,
}: {
  title: string;
  children?: ReactNode;
  tables: readonly string[];
  onDownload: (table: string) => void;
}) {
  const titleId = useId();
  return (
    <section className="adm-card adm-backup rise" aria-labelledby={titleId}>
      <div className="adm-card-head">
        <span className="adm-card-icon">
          <DownloadSimple size={20} aria-hidden="true" />
        </span>
        <h3 id={titleId}>{title}</h3>
      </div>
      {children && <p className="adm-card-text">{children}</p>}
      <div className="adm-chips">
        {tables.map((table) => (
          <button
            type="button"
            className="adm-chip"
            key={table}
            aria-label={`Download ${table}.csv`}
            onClick={() => onDownload(table)}
          >
            {table}.csv
          </button>
        ))}
      </div>
    </section>
  );
}

/** Titled block: h2 with a count, an optional action at the end. */
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

export function ProgramUsers() {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [existing, setExisting] = useState(false);
  const [notice, setNotice] = useState("");
  const [group, setGroup] = useState<Group | "new" | null>(null);
  const [aircraft, setAircraft] = useState<Aircraft | "new" | null>(null);
  const enabled = online && connected;
  const programUuid = activeProgram(s!)!;
  const program = s!.programs?.find((p) => p.uuid === programUuid);
  const groups = s!.groups.filter((g) => g.programUuid === programUuid);
  const members = s!.members.filter((m) =>
    m.groupIds.some((id) => groups.some((g) => g.id === id)),
  );
  const programAircraft = s!.aircraft.filter(
    (a) => a.programUuid === programUuid,
  );
  return (
    <div className="adm-page">
      <PageHeader
        title="Administration"
        eyebrow={program?.name ?? "Flight Program"}
        description="Manage users, permission groups and aircraft access within this Flight Program."
        actions={
          <>
            <Link
              className="button adm-secondary"
              to="/settings"
              hash="program"
            >
              <Buildings size={18} aria-hidden="true" />
              Edit Flight Program settings
            </Link>
            <button
              className="button primary adm-primary"
              disabled={!online || !connected}
              onClick={() => setOpen(true)}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              Add user
            </button>
          </>
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
          cannot sign in.
        </NoticeBar>
      )}
      <AdminSection
        title="Users"
        count={members.length}
        action={
          <button
            className="button small adm-button"
            disabled={!enabled}
            onClick={() => {
              setNotice("");
              setExisting(true);
            }}
          >
            <UserPlus size={16} aria-hidden="true" />
            Add existing user
          </button>
        }
      >
        {notice && (
          <NoticeBar tone="blue" icon={Info} role="status">
            {notice}
          </NoticeBar>
        )}
        {members.length > 0 && (
          <div className="adm-list">
            {members.map((m) => {
              const memberGroups = groups
                .filter((g) => m.groupIds.includes(g.id))
                .map((g) => g.name)
                .join(", ");
              return (
                <div className="adm-row list-row" key={m.id}>
                  <div className="adm-lead">
                    <MemberAvatar name={m.name} admin={m.isAdmin} />
                    <div className="adm-text">
                      <strong className="adm-name">{m.name}</strong>
                      <span
                        className="adm-sub"
                        title={`${m.email} · ${memberGroups}`}
                      >
                        <span>{m.email}</span>
                        <span className="adm-sep" aria-hidden="true">
                          {" · "}
                        </span>
                        <span>{memberGroups}</span>
                      </span>
                    </div>
                  </div>
                  {/* Disabled accounts can still be listed (historical
                   * pilots); never present them as active members (#53). */}
                  {!m.active && (
                    <StatusPill
                      dot={false}
                      tone="neutral"
                      className="adm-badge"
                    >
                      Disabled
                    </StatusPill>
                  )}
                  <div className="adm-actions">
                    <button
                      className="button small adm-button"
                      disabled={!enabled}
                      onClick={() => setEditing(m)}
                    >
                      <PencilSimple size={15} aria-hidden="true" />
                      Edit program access
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AdminSection>
      <AdminSection
        title="Permission groups"
        count={groups.length}
        action={
          <button
            className="button small adm-button"
            disabled={!enabled}
            onClick={() => setGroup("new")}
          >
            <Plus size={15} aria-hidden="true" />
            Add group
          </button>
        }
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
                  {g.programAdmin
                    ? "Flight Program administrator · All program aircraft"
                    : g.owner
                      ? `Aircraft owner (read-only portal) · ${groupAircraftLabel(g, programAircraft)}`
                      : `${g.permissions.join(", ")} · ${groupAircraftLabel(g, programAircraft)}`}
                </p>
                <div className="adm-actions adm-group-actions">
                  <button
                    className="button small adm-button"
                    disabled={!enabled}
                    onClick={() => setGroup(g)}
                  >
                    Edit group
                  </button>
                  <DeleteGroupButton group={g} />
                </div>
              </article>
            ))}
          </div>
        )}
      </AdminSection>
      <AdminSection
        title="Aircraft"
        count={programAircraft.length}
        action={
          <button
            className="button small adm-button"
            disabled={!enabled}
            onClick={() => setAircraft("new")}
          >
            <Plus size={15} aria-hidden="true" />
            Add aircraft
          </button>
        }
      >
        {programAircraft.length > 0 && (
          <div className="adm-list">
            {programAircraft.map((a) => (
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
                  <button
                    className="button small adm-button"
                    disabled={!enabled}
                    onClick={() => setAircraft(a)}
                  >
                    <PencilSimple size={15} aria-hidden="true" />
                    Edit aircraft
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminSection>
      <NoticeBar icon={GearSix} className="adm-moved rise">
        Program details, labor rate and exports are in Settings → Flight
        Program.{" "}
        <Link to="/settings" hash="program">
          Open Flight Program settings
        </Link>
      </NoticeBar>
      {group && (
        <Modal
          title={
            group === "new"
              ? "Create permission group"
              : "Edit permission group"
          }
          onClose={() => setGroup(null)}
        >
          <GroupForm
            initial={group === "new" ? undefined : group}
            onDone={() => setGroup(null)}
          />
        </Modal>
      )}
      {aircraft && (
        <Modal
          title={aircraft === "new" ? "Add aircraft" : "Edit aircraft"}
          onClose={() => setAircraft(null)}
        >
          <AircraftForm
            initial={aircraft === "new" ? undefined : aircraft}
            onDone={() => setAircraft(null)}
          />
        </Modal>
      )}
      {(editing || existing) && (
        <Modal
          title={editing ? "Edit program access" : "Add existing user"}
          onClose={() => {
            setEditing(null);
            setExisting(false);
          }}
        >
          <AsyncForm
            disabled={!enabled}
            submitLabel="Save program access"
            onSubmit={async (d) => {
              const ids = d.getAll("group").map(String);
              if (editing)
                await backend!.updateProgramAccess(
                  editing.id,
                  programUuid,
                  ids,
                  d.has("remove"),
                );
              else
                // The same answer whether or not the account exists.
                setNotice(
                  await backend!.addExistingProgramUser(
                    value(d, "email"),
                    programUuid,
                    ids,
                  ),
                );
              setEditing(null);
              setExisting(false);
            }}
          >
            <p className="adm-form-program">
              Flight Program: <strong>{program?.name}</strong>
            </p>
            {editing ? (
              <p className="adm-form-member">
                {editing.name} · {editing.email}
              </p>
            ) : (
              <Field label="Existing account email">
                <input type="email" name="email" required />
              </Field>
            )}
            <fieldset className="adm-checks">
              <legend>Permission groups</legend>
              {groups.map((g) => (
                <label key={g.id} className="checkbox">
                  <input
                    type="checkbox"
                    name="group"
                    value={g.id}
                    defaultChecked={editing?.groupIds.includes(g.id)}
                  />
                  {g.name}
                  {g.programAdmin ? " (Flight Program administrator)" : ""}
                  {g.owner ? " (Aircraft owner, read-only)" : ""}
                </label>
              ))}
            </fieldset>
            {editing && (
              <label className="checkbox adm-remove">
                <input type="checkbox" name="remove" />
                Remove access to this Flight Program
              </label>
            )}
            <p className="muted">
              Changes apply only to this Flight Program. Access to other
              programs and account credentials stay unchanged.
            </p>
          </AsyncForm>
        </Modal>
      )}
      {open && (
        <Modal title="Add user" onClose={() => setOpen(false)}>
          <AsyncForm
            key={programUuid}
            disabled={!online || !connected}
            submitLabel="Create account"
            onSubmit={async (d) => {
              await backend!.createProgramUser(
                value(d, "email"),
                value(d, "name"),
                value(d, "password"),
                programUuid,
                d.getAll("group").map(String),
              );
              setOpen(false);
            }}
          >
            <p className="adm-form-program">
              Flight Program: <strong>{program?.name}</strong>
            </p>
            <Field label="Full name">
              <input name="name" required maxLength={150} />
            </Field>
            <Field label="Email">
              <input name="email" type="email" required autoComplete="off" />
            </Field>
            <Field label="Initial password">
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <fieldset className="adm-checks">
              <legend>Permission groups</legend>
              <p className="muted">
                If you select no groups, Observers provides read-only access.
                Select other groups for additional permissions.
              </p>
              {groups.map((g) => (
                <label key={g.id} className="checkbox">
                  <input type="checkbox" name="group" value={g.id} />
                  {g.name}
                  {g.programAdmin ? " (Flight Program administrator)" : ""}
                  {g.owner ? " (Aircraft owner, read-only)" : ""}
                </label>
              ))}
            </fieldset>
          </AsyncForm>
        </Modal>
      )}
    </div>
  );
}

/**
 * Responsibility: The Settings page: how the app behaves, in the My account,
 *   This device, Flight Program and System sections.
 * Layer: UI. React components; Administration (Admin.tsx) decides who can do
 *   what.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data (store, deviceManuals), src/domain (alerts, certifications,
 *   costs, csv, model, offsiteBackups, pilotView, programs), the panels it
 *   embeds (./AddressVerificationSettings, ./AircraftSpruce, ./DemoBackup,
 *   ./FaaKeySettings, ./Fleet, ./ProgramUsers, ./SignInMethods,
 *   ./UserProfile), ./design, ./ui, src/styles/screens/settings.css.
 *
 * Every signed-in user except the owner view reaches this page; each section
 * repeats the permission check of the screen its panels came from, so moving
 * a panel here never changes who can use it:
 *   My account, This device — everyone;
 *   Flight Program — Flight Program administrators (and system
 *     administrators, for whom programPermission(…, "admin") is true);
 *   System — system administrators only.
 * Sections are deep-linkable: /settings#account, #device, #program, #system.
 */
import {
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowsClockwise,
  Buildings,
  CloudCheck,
  DeviceMobile,
  HardDrives,
  IdentificationCard,
  Info,
  MapPin,
  Moon,
  PencilSimple,
  Sun,
  UserCircle,
  Users,
  WifiSlash,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { formatBytes } from "../data/deviceManuals";
import { localDate, type Snapshot } from "../domain/model";
import { activeProgram, programPermission } from "../domain/programs";
import { isPilotView } from "../domain/pilotView";
import { wantsAlertEmails } from "../domain/alerts";
import { offsiteFreshness, type OffsiteCopy } from "../domain/offsiteBackups";
import {
  certificationLabels,
  normalizeCertifications,
  type Certification,
} from "../domain/certifications";
import {
  formatCents,
  laborRate,
  MAX_RATE_CENTS,
  parseCents,
} from "../domain/costs";
import { CENTS_PER_DOLLAR } from "../domain/costs/units";
import { toCsv } from "../domain/csv";
import { AsyncForm, Field, download, errorText, safeHref, value } from "./ui";
import {
  IconTile,
  NoticeBar,
  PageHeader,
  Segmented,
  StatusPill,
  Switch,
  useTheme,
  type IconType,
  type Theme,
} from "./design";
import { MyCertifications } from "./UserProfile";
import { SignInMethodList } from "./SignInMethods";
import { ProgramDialog } from "./Fleet";
import { AircraftSpruceAccount } from "./AircraftSpruce";
import { CsvExportCard } from "./ProgramUsers";
import { FaaKeySettings } from "./FaaKeySettings";
import { AddressVerificationSettings } from "./AddressVerificationSettings";
import { DemoBackup } from "./DemoBackup";
import "../styles/screens/settings.css";

type SectionKey = "account" | "device" | "program" | "system";
const SECTION_META: Record<
  SectionKey,
  { label: string; icon: IconType; description: string }
> = {
  account: {
    label: "My account",
    icon: UserCircle,
    description:
      "Who you are signed in as, how you sign in, your certifications and alerts.",
  },
  device: {
    label: "This device",
    icon: DeviceMobile,
    description: "How Angel One looks and what it keeps on this device.",
  },
  program: {
    label: "Flight Program",
    icon: Buildings,
    description:
      "Details, rates, supplier account and exports for the active Flight Program.",
  },
  system: {
    label: "System",
    icon: HardDrives,
    description:
      "Integration keys shared by every Flight Program, and full data backups.",
  },
};

// Same columns and file names as the exports that used to sit on the
// Flight Program administrator's Administration page and on Administration.
const PROGRAM_TABLES = [
  "aircraft",
  "flights",
  "discrepancies",
  "inspections",
  "inspectionTemplates",
  "management",
  "audit",
] as const;
const BACKUP_TABLES = [
  "aircraft",
  "programs",
  "flights",
  "discrepancies",
  "inspections",
  "inspectionTemplates",
  "management",
  "members",
  "groups",
  "audit",
] as const;
const CSV_TYPE = "text/csv;charset=utf-8";

type Program = NonNullable<Snapshot["programs"]>[number];

/**
 * The Settings page: section links, then My account and This device for
 * everyone, Flight Program for its administrators and System for system
 * administrators. Opening /settings#<section> scrolls to that section.
 *
 * @returns The page; it needs a loaded snapshot.
 */
export function Settings() {
  const s = useWorkspace((x) => x.snapshot)!;
  const hash = useRouterState({ select: (r) => r.location.hash });
  const sections = visibleSections(s);
  // The router scrolls to a hash on navigation, but this screen loads on
  // demand, so a deep link (or a link from another screen) can arrive before
  // the section exists. Scroll once the section is rendered.
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, [hash]);
  const current = sections.find((k) => k === hash) ?? sections[0];
  return (
    <div className="set-page">
      <PageHeader
        eyebrow="SETTINGS"
        title="Settings"
        description="Your account, this device and how your Flight Program works."
      />
      <SectionLinks sections={sections} current={current} />
      <div className="set-sections">
        <AccountSection />
        <DeviceSection />
        {sections.includes("program") && <ProgramSection />}
        {sections.includes("system") && <SystemSection />}
      </div>
    </div>
  );
}

// Plain anchors: a router <Link> to /settings marks every one of them
// aria-current="page" while this page is open.
function SectionLinks({
  sections,
  current,
}: {
  sections: SectionKey[];
  current: SectionKey;
}) {
  const navigate = useNavigate();
  return (
    <nav aria-label="Settings sections" className="ds-segmented set-jump rise">
      {sections.map((key) => {
        const Icon = SECTION_META[key].icon;
        return (
          <a
            key={key}
            href={`#${key}`}
            aria-current={key === current ? "location" : undefined}
            onClick={(e) => jumpTo(e, key, navigate)}
          >
            <Icon
              size={17}
              weight={key === current ? "duotone" : "regular"}
              aria-hidden="true"
            />
            {SECTION_META[key].label}
          </a>
        );
      })}
    </nav>
  );
}

/** One settings section: a card whose h2 names it, deep-linkable by id. */
function Section({
  id,
  index,
  children,
}: {
  id: SectionKey;
  index: number;
  children: ReactNode;
}) {
  const { label, icon, description } = SECTION_META[id];
  return (
    <section
      id={id}
      className="set-section rise"
      style={{ "--i": index + 1 } as CSSProperties}
      aria-labelledby={`${id}-title`}
    >
      <header className="set-section-head">
        <IconTile icon={icon} size="md" />
        <div>
          <h2 id={`${id}-title`}>{label}</h2>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

/** A titled group of controls inside a section. */
function Block({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={"set-block" + (className ? " " + className : "")}>
      {title && <h3>{title}</h3>}
      {description && <p className="set-hint">{description}</p>}
      {children}
    </div>
  );
}

/* ─────────────────────────── My account ─────────────────────────── */

function AccountSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  return (
    <Section id="account" index={0}>
      <AccountFacts s={s} />
      <Block
        title="Sign-in methods"
        description="Your password always works. A Google or Microsoft account whose verified email matches yours is linked the first time you sign in with it. For two-step verification, sign in with one that has it turned on."
      >
        <SignInMethodList />
      </Block>
      <CertificationsBlock s={s} />
      <AlertEmailBlock s={s} />
    </Section>
  );
}

function AccountFacts({ s }: { s: Snapshot }) {
  const program = s.programs?.find((p) => p.uuid === s.activeProgramUuid);
  const groups = s.groups
    .filter(
      (g) =>
        s.user.groupIds.includes(g.id) && g.programUuid === s.activeProgramUuid,
    )
    .map((g) => g.name);
  return (
    <Block>
      <dl className="set-facts">
        <div>
          <dt>Name</dt>
          <dd>{s.user.name}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{s.user.email}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>
            {roleOf(s)}
            {groups.length > 0 && (
              <small>
                {groups.join(", ")}
                {program ? ` · ${program.name}` : ""}
              </small>
            )}
          </dd>
        </div>
      </dl>
      <p className="set-hint">
        Your name, email and access are set by an administrator.
      </p>
    </Block>
  );
}

function CertificationsBlock({ s }: { s: Snapshot }) {
  const certifications = normalizeCertifications(s.user.certifications ?? []);
  return (
    <Block
      title="Certifications"
      description="Used on logbook entries you sign. Certifications do not change what you can do in Angel One."
    >
      {certifications.length ? (
        <ul className="set-certs">
          {certifications.map((c) => (
            <li key={c.kind}>
              <IconTile icon={IdentificationCard} size="sm" />
              <span>
                <strong>{certificationLabels[c.kind]}</strong>
                <small>{certificationLine(c)}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-empty">{legacyLicense(s.user)}</p>
      )}
      <div className="set-actions">
        <MyCertifications
          className="button small"
          label={
            <>
              <PencilSimple size={15} aria-hidden="true" />
              Edit my certifications
            </>
          }
        />
      </div>
    </Block>
  );
}

// The same preference, default and backend call as the checkbox in
// My certifications (alerts.setEmailPreference); online only, like there.
function AlertEmailBlock({ s }: { s: Snapshot }) {
  const { backend, online, connected } = useWorkspace();
  const live = online && connected;
  const emailAlerts = wantsAlertEmails(s.user, s.groups, s.activeProgramUuid);
  const choice = useAlertEmailChoice(backend, emailAlerts);
  return (
    <Block
      title="Alert email"
      description="New maintenance alerts for your Flight Program, sent once a day. Alerts always appear under the bell."
    >
      <Switch
        label="Email me a daily alert digest"
        checked={choice.checked}
        disabled={!live || choice.saving}
        onChange={choice.save}
      />
      {!live && (
        <p className="set-hint set-offline">
          <WifiSlash size={16} aria-hidden="true" /> Reconnect to change alert
          email.
        </p>
      )}
      {choice.error && (
        <p role="alert" className="error">
          {choice.error}
        </p>
      )}
    </Block>
  );
}

// Shows the choice until the snapshot catches up with it, and the stored
// preference again if saving fails.
function useAlertEmailChoice(backend: Backend | null, emailAlerts: boolean) {
  const [pending, setPending] = useState<{ value: boolean; was: boolean }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(next: boolean) {
    setError("");
    setSaving(true);
    setPending({ value: next, was: emailAlerts });
    try {
      await backend!.setAlertEmails(next);
    } catch (e) {
      setPending(undefined);
      setError(errorText(e, "Unable to save this setting."));
    } finally {
      setSaving(false);
    }
  }
  const checked =
    pending && pending.was === emailAlerts ? pending.value : emailAlerts;
  return { checked, saving, error, save };
}

/* ─────────────────────────── This device ────────────────────────── */

function DeviceSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  const queue = useWorkspace((x) => x.queue);
  // Only this user's entries count: the outbox keeps other users' entries
  // until they sign in again.
  const pending = queue.filter(
    (q) => q.operation.authorId === s.user.id,
  ).length;
  return (
    <Section id="device" index={1}>
      <ThemeBlock />
      <OfflineDataBlock syncedAt={s.syncedAt} pending={pending} />
      <Block className="set-block-note">
        <p className="set-note">
          <Info size={18} weight="duotone" aria-hidden="true" />
          Your theme, favorites, sidebar layout and print settings are kept on
          this device and do not follow your account.
        </p>
      </Block>
    </Section>
  );
}

function ThemeBlock() {
  const { theme, setTheme } = useTheme();
  return (
    <Block
      title="Theme"
      description="Applies to this device. The sun and moon button in the top bar switches it too."
    >
      <Segmented
        label="Theme"
        className="set-theme"
        options={[
          { value: "light", label: "Light", icon: Sun },
          { value: "dark", label: "Dark", icon: Moon },
        ]}
        value={theme}
        onChange={(t) => setTheme(t as Theme)}
      />
    </Block>
  );
}

function OfflineDataBlock({
  syncedAt,
  pending,
}: {
  syncedAt: number;
  pending: number;
}) {
  return (
    <Block
      title="Offline data"
      description="Flights and discrepancies recorded without a connection wait on this device until they sync."
    >
      <div className="set-offline-row">
        <IconTile
          icon={pending ? ArrowsClockwise : CloudCheck}
          size="sm"
          tone={pending ? "warn" : "good"}
        />
        <p>
          Last snapshot <strong>{dateTime(syncedAt)}</strong>
          <span aria-hidden="true"> · </span>
          <strong>
            {pending} pending {pending === 1 ? "entry" : "entries"}
          </strong>
        </p>
        <Link to="/sync" className="button small">
          Open Sync center
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
    </Block>
  );
}

/* ────────────────────────── Flight Program ───────────────────────── */

function ProgramSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  const [editing, setEditing] = useState(false);
  const programUuid = activeProgram(s);
  const program = s.programs?.find((p) => p.uuid === programUuid);
  return (
    <Section id="program" index={2}>
      {!program ? (
        <Block>
          <NoticeBar icon={Info} tone="neutral" className="set-inline-notice">
            Choose a Flight Program in the program selector to see its details,
            labor rate, Aircraft Spruce account and exports.
          </NoticeBar>
        </Block>
      ) : (
        <>
          <ProgramDetails
            s={s}
            program={program}
            onEdit={() => setEditing(true)}
          />
          <LaborRateSettings s={s} />
          <div className="set-block set-embed">
            <AircraftSpruceAccount />
          </div>
        </>
      )}
      <RelatedPages />
      {program && <ProgramExport s={s} program={program} />}
      {editing && program && (
        <ProgramDialog program={program} onClose={() => setEditing(false)} />
      )}
    </Section>
  );
}

// The same rule as Flight Programs' "Edit Flight Program" button.
function ProgramDetails({
  s,
  program,
  onEdit,
}: {
  s: Snapshot;
  program: Program;
  onEdit: () => void;
}) {
  const { online, connected } = useWorkspace();
  const canEdit =
    s.user.isAdmin ||
    (program.uuid === s.activeProgramUuid && programPermission(s, "admin"));
  return (
    <Block title="Program details">
      <ProgramFacts program={program} />
      {canEdit && (
        <div className="set-actions">
          <button
            type="button"
            className="button small"
            disabled={!online || !connected}
            onClick={onEdit}
          >
            <PencilSimple size={15} aria-hidden="true" />
            Edit program details
          </button>
        </div>
      )}
    </Block>
  );
}

function ProgramFacts({ program }: { program: Program }) {
  const website = safeHref(program.website);
  return (
    <dl className="set-facts">
      <div>
        <dt>Name</dt>
        <dd>{program.name}</dd>
      </div>
      <div>
        <dt>Address</dt>
        <dd>{factLines(postalLines(program), "No address recorded")}</dd>
      </div>
      <div>
        <dt>Contact</dt>
        <dd>{factLines(contactLines(program), "No contact recorded")}</dd>
      </div>
      <div>
        <dt>Website</dt>
        <dd>
          {website ? (
            <a href={website} target="_blank" rel="noreferrer">
              {program.website}
            </a>
          ) : (
            "No website recorded"
          )}
        </dd>
      </div>
    </dl>
  );
}

function RelatedPages() {
  return (
    <Block title="Related pages">
      <nav aria-label="Flight Program pages" className="set-links">
        <SettingsLink
          to="/saved-addresses"
          icon={MapPin}
          title="Saved addresses"
          sub="Shipping and receiving addresses for this Flight Program."
        />
        <SettingsLink
          to="/admin"
          icon={Users}
          title="Users and access"
          sub="People, permission groups and aircraft access, in Administration."
        />
      </nav>
    </Block>
  );
}

function ProgramExport({ s, program }: { s: Snapshot; program: Program }) {
  return (
    <div className="set-block set-embed">
      <CsvExportCard
        title="Export program data"
        tables={PROGRAM_TABLES}
        onDownload={(table) =>
          download(
            `${program.uuid}-${table}.csv`,
            tableCsv(s, table as (typeof PROGRAM_TABLES)[number]),
            CSV_TYPE,
          )
        }
      >
        CSV exports of this Flight Program&apos;s records in this workspace
        snapshot.
      </CsvExportCard>
    </div>
  );
}

function SettingsLink({
  to,
  icon,
  title,
  sub,
}: {
  to: "/saved-addresses" | "/admin";
  icon: IconType;
  title: string;
  sub: string;
}) {
  return (
    <Link to={to} className="set-link">
      <IconTile icon={icon} size="sm" />
      <span className="set-link-text">
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
      <ArrowRight size={18} className="set-link-caret" aria-hidden="true" />
    </Link>
  );
}

/** Moved from Costs: the active program's default labor rate (the backend's
 * settings.laborRate command still requires program-admin permission). */
function LaborRateSettings({ s }: { s: Snapshot }) {
  const { backend, online, connected } = useWorkspace();
  const rate = laborRate(s);
  return (
    <section className="set-block" aria-labelledby="labor-rate-heading">
      <h3 id="labor-rate-heading">Default labor rate</h3>
      <p className="set-hint">
        Applied to labor that maintenance users record. Existing entries keep
        the rate they were recorded with.
      </p>
      <div className="set-form">
        <AsyncForm
          key={rate}
          submitLabel="Save rate"
          disabled={!online || !connected}
          onSubmit={async (data) => {
            await backend!.costs({
              action: "settings.laborRate",
              laborRateCents: parseCents(value(data, "rate"), MAX_RATE_CENTS),
            });
          }}
        >
          <Field label="Rate per hour (USD)" hint={rateHint(rate)}>
            <input
              name="rate"
              required
              inputMode="decimal"
              defaultValue={
                rate === undefined ? "" : (rate / CENTS_PER_DOLLAR).toFixed(2)
              }
            />
          </Field>
        </AsyncForm>
      </div>
    </section>
  );
}

/* ───────────────────────────── System ───────────────────────────── */

function SystemSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  return (
    <Section id="system" index={3}>
      <div className="set-block set-embed">
        <FaaKeySettings level={3} />
      </div>
      <div className="set-block set-embed">
        <AddressVerificationSettings />
      </div>
      <OffsiteBackups />
      <BackupExport s={s} />
      <div className="set-block set-embed">
        <DemoBackup />
      </div>
      <Block title="Set by your deployment">
        <p className="set-hint">
          Some settings are configured by whoever deploys Angel One, not in the
          app: email sending through Resend, the site address used in links
          (SITE_URL) and the credential encryption key. See “Deployment” in the
          README.
        </p>
      </Block>
    </Section>
  );
}

function BackupExport({ s }: { s: Snapshot }) {
  return (
    <div className="set-block set-embed">
      <CsvExportCard
        title="Download data backup"
        tables={BACKUP_TABLES}
        onDownload={(table) =>
          download(
            `angel-one-${table}-${localDate()}.csv`,
            tableCsv(s, table as (typeof BACKUP_TABLES)[number]),
            CSV_TYPE,
          )
        }
      >
        CSV exports of this workspace snapshot, excluding authentication
        secrets. Export pending entries separately in Sync center.
      </CsvExportCard>
    </div>
  );
}

/** The newest nightly off-site backup (ADR-0008), which the backup job
 * records through backups:recordOffsiteCopy. */
function OffsiteBackups() {
  const { snapshot, connected, demo } = useWorkspace();
  const s = snapshot!;
  const { loaded, failed } = useOffsiteCopy();
  const freshness = loaded && offsiteFreshness(loaded.copy, loaded.at);
  return (
    <Block
      title="Off-site backups"
      description="Every night an encrypted copy of all records and files is uploaded to Cloudflare R2. The daily alert email warns system administrators when the newest copy is more than 36 hours old."
    >
      {demo ? (
        <p className="set-empty">
          Off-site backups run only on the production deployment.
        </p>
      ) : freshness ? (
        <BackupStatus s={s} copy={loaded.copy} freshness={freshness} />
      ) : (
        <p className="set-hint">{backupWaitText(failed, connected)}</p>
      )}
      <p className="set-hint">
        Restore steps are in docs/runbooks/backup-restore.md in the Angel One
        repository.
      </p>
    </Block>
  );
}

// The newest copy and when it was loaded, so its age is shown as of then.
// The demo has no backups; a reply after the page closes is dropped.
function useOffsiteCopy() {
  const { backend, connected, demo } = useWorkspace();
  const [loaded, setLoaded] = useState<{
    copy: OffsiteCopy | null;
    at: number;
  }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!demo && backend && connected)
      backend.latestOffsiteCopy().then(
        (copy) => {
          if (!active) return;
          setLoaded({ copy, at: Date.now() });
          setFailed(false);
        },
        () => {
          if (active) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [backend, connected, demo]);
  return { loaded, failed };
}

function BackupStatus({
  s,
  copy,
  freshness,
}: {
  s: Snapshot;
  copy: OffsiteCopy | null;
  freshness: ReturnType<typeof offsiteFreshness>;
}) {
  return (
    <>
      <div className="set-backup-status">
        <StatusPill tone={freshness.status === "ok" ? "good" : "warn"}>
          {freshness.status === "ok" ? "OK" : "Warning"}
        </StatusPill>
        <p>{freshness.message}</p>
      </div>
      {copy && <BackupFacts copy={copy} />}
      {!wantsAlertEmails(s.user, s.groups, s.activeProgramUuid) && (
        <p className="set-hint">
          Your alert email is off, so backup warnings show only here. Turn on
          “Email me a daily alert digest” under My account to get them by email.
        </p>
      )}
    </>
  );
}

function BackupFacts({ copy }: { copy: OffsiteCopy }) {
  return (
    <dl className="set-facts">
      <div>
        <dt>Last copy</dt>
        <dd>{dateTime(copy.completedAt)}</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>{formatBytes(copy.bytes)}</dd>
      </div>
      <div>
        <dt>Last monthly copy</dt>
        <dd>
          {copy.monthlyCompletedAt
            ? dateTime(copy.monthlyCompletedAt)
            : "None yet"}
        </dd>
      </div>
    </dl>
  );
}

function visibleSections(s: Snapshot): SectionKey[] {
  return [
    "account",
    "device",
    ...(programPermission(s, "admin") ? (["program"] as const) : []),
    ...(s.user.isAdmin ? (["system"] as const) : []),
  ];
}

// A modified or middle click keeps the browser's own behaviour (a new tab or
// window). Scrolling here too lets a tap on the current section, after
// scrolling away, still jump to it.
function jumpTo(
  e: MouseEvent<HTMLAnchorElement>,
  key: SectionKey,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  void navigate({ to: "/settings", hash: key, hashScrollIntoView: false });
  document.getElementById(key)?.scrollIntoView();
}

function dateTime(at: number) {
  const day = new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${day} · ${time}`;
}

function roleOf(s: Snapshot) {
  if (s.user.isAdmin) return "System administrator";
  if (programPermission(s, "admin")) return "Flight Program administrator";
  return isPilotView(s) ? "Pilot" : "Team member";
}

function certificationLine(c: Certification) {
  const number = c.number ? `No. ${c.number}` : "Number not recorded";
  if (c.kind === "mechanic") {
    const ratings = [
      c.airframe && "Airframe",
      c.powerplant && "Powerplant",
      c.ia && "IA",
    ].filter(Boolean);
    return [
      number,
      ratings.join(", "),
      c.ia && c.renewalDate && `IA renewal ${c.renewalDate}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return [number, c.expiresOn && `Expires ${c.expiresOn}`]
    .filter(Boolean)
    .join(" · ");
}

// A profile from before certifications were recorded keeps its license.
function legacyLicense(user: Snapshot["user"]) {
  if (!user.licenseNumber) return "No certifications recorded.";
  return `Existing profile license: ${user.certificateType ?? ""} ${user.licenseNumber}`.trim();
}

// A structured address first; a legacy one is its stored lines.
function postalLines(program: Program) {
  const a = program.addressDetails;
  if (!a) return program.address.split("\n").filter(Boolean);
  return [
    a.organization,
    a.street,
    a.street2,
    [a.city, a.region, a.postalCode].filter(Boolean).join(", "),
    a.country,
  ].filter(Boolean);
}

function contactLines(program: Program) {
  const a = program.addressDetails;
  return [
    program.contactName || a?.contactName,
    program.email || a?.email,
    a?.phone,
  ].filter(Boolean);
}

function factLines(lines: (string | undefined)[], empty: string) {
  if (!lines.length) return empty;
  return lines.map((line, i) => (
    <span className="set-line" key={i}>
      {line}
    </span>
  ));
}

function rateHint(rate: number | undefined) {
  return rate === undefined
    ? "No default rate set."
    : `Current rate ${formatCents(rate)} per hour.`;
}

function tableCsv(
  s: Snapshot,
  table: (typeof PROGRAM_TABLES)[number] | (typeof BACKUP_TABLES)[number],
) {
  return toCsv((s[table] ?? []).map((row) => ({ ...row })));
}

function backupWaitText(failed: boolean, connected: boolean) {
  if (failed)
    return "Could not load the off-site backup status. Reconnect and reload.";
  return connected
    ? "Checking off-site backups…"
    : "Reconnect to see the off-site backup status.";
}

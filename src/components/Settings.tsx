/**
 * Responsibility: The Settings page: how the app behaves, in the My account,
 *   Alerts, This device, Flight Program and System sections.
 * Layer: UI. React components; Administration (Admin.tsx) decides who can do
 *   what.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data (store, pendingEntries), src/domain (alerts, certifications,
 *   costs, memberRole, model, programs, taskCards), the panels
 *   it embeds (./AddressVerificationSettings, ./AircraftSpruce, ./DemoBackup,
 *   ./DeviceAlerts, ./ExpiringDates, ./FaaKeySettings, ./Fleet, ./LargeText,
 *   ./SettingsExtracts, ./SettingsSystem, ./UserProfile),
 *   ./SettingsBlock, ./useDeploymentFeatures, ./design, ./ui,
 *   src/styles/screens/settings.css.
 *
 * Every signed-in user except the owner and board views reaches this page;
 * each section repeats the permission check of the screen its panels came
 * from, so moving a panel here never changes who can use it:
 *   My account, Alerts, This device — everyone;
 *   Flight Program — Flight Program administrators (and system
 *     administrators, for whom programPermission(…, "admin") is true);
 *   System — system administrators only.
 * Sections are deep-linkable: /settings#account, #alerts, #device, #program,
 * #system.
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
  Bell,
  Books,
  Buildings,
  CircleHalf,
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
import { ownEntries } from "../data/pendingEntries";
import { OFFLINE_WINDOW, type Snapshot } from "../domain/model";
import { activeProgram, programPermission } from "../domain/programs";
import { memberRoleLabel } from "../domain/memberRole";
import {
  ALERT_DIGEST_HOUR_UTC,
  ALERT_KINDS_SUMMARY,
  IMMEDIATE_EMAILS_PER_DAY,
  wantsAlertEmails,
  wantsUrgentAlertEmails,
} from "../domain/alerts";
import {
  certificateSummary,
  certificationLabels,
  normalizeCertifications,
} from "../domain/certifications";
import {
  formatCents,
  laborRate,
  MAX_RATE_CENTS,
  parseCents,
} from "../domain/costs";
import { CENTS_PER_DOLLAR } from "../domain/costs/units";
import { certificationsEffect } from "../domain/taskCards";
import { AsyncForm, Field, errorText, safeHref, value } from "./ui";
import {
  Facts,
  IconTile,
  NoticeBar,
  PageHeader,
  Segmented,
  Switch,
  useTheme,
  type IconType,
  type ThemeChoice,
} from "./design";
import { MyCertifications } from "./UserProfile";
import { ProgramDialog } from "./Fleet";
import { AircraftSpruceAccount } from "./AircraftSpruce";
import { FaaKeySettings } from "./FaaKeySettings";
import { AddressVerificationSettings } from "./AddressVerificationSettings";
import { DemoBackup } from "./DemoBackup";
import { DeviceAlertsBlock } from "./DeviceAlerts";
import { LargeTextBlock } from "./LargeText";
import { ExpiringDates } from "./ExpiringDates";
import { ProgramExtract, SystemExtract } from "./SettingsExtracts";
import { DeploymentStatus, OffsiteBackups } from "./SettingsSystem";
import { Block, settingsDateTime } from "./SettingsBlock";
import {
  useDeploymentFeatures,
  type DeploymentFeatures,
} from "./useDeploymentFeatures";
import "../styles/screens/settings.css";

type SectionKey = "account" | "alerts" | "device" | "program" | "system";
const SECTION_META: Record<
  SectionKey,
  { label: string; icon: IconType; description: string }
> = {
  account: {
    label: "My account",
    icon: UserCircle,
    description:
      "Who you are signed in as, how you sign in and your certifications.",
  },
  alerts: {
    label: "Alerts",
    icon: Bell,
    description:
      "What reaches you under the bell, by email and on this device.",
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
      "Details, labor rate, expiring dates, Aircraft Spruce account and exports for the active Flight Program.",
  },
  system: {
    label: "System",
    icon: HardDrives,
    description:
      "What the deployment has turned on, integration keys shared by every Flight Program, the deployment's expiring dates and backups.",
  },
};
const MS_PER_DAY = 86_400_000;
const OFFLINE_DAYS = OFFLINE_WINDOW / MS_PER_DAY;

type Program = NonNullable<Snapshot["programs"]>[number];

/**
 * The Settings page: section links, then My account, Alerts and This device
 * for everyone, Flight Program for its administrators and System for system
 * administrators. Opening /settings#<section> scrolls to that section.
 *
 * @returns The page; it needs a loaded snapshot.
 */
export function Settings() {
  const s = useWorkspace((x) => x.snapshot)!;
  const hash = useRouterState({ select: (r) => r.location.hash });
  const features = useDeploymentFeatures();
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
        description="Your account, alerts and this device; for administrators, the Flight Program and the system."
      />
      <SectionLinks sections={sections} current={current} />
      <div className="set-sections">
        <AccountSection />
        <AlertsSection email={features.email} />
        <DeviceSection />
        {sections.includes("program") && <ProgramSection />}
        {sections.includes("system") && <SystemSection features={features} />}
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

/** One settings section: an h2 over one card of blocks, deep-linkable by
 * id. */
function Section({
  id,
  index,
  children,
}: {
  id: SectionKey;
  index: number;
  children: ReactNode;
}) {
  const { label, description } = SECTION_META[id];
  return (
    <section
      id={id}
      className="set-section rise"
      style={{ "--i": index + 1 } as CSSProperties}
      aria-labelledby={`${id}-title`}
    >
      <header className="set-section-head">
        <h2 id={`${id}-title`}>{label}</h2>
        <p>{description}</p>
      </header>
      <div className="set-card">{children}</div>
    </section>
  );
}

/* ─────────────────────────── My account ─────────────────────────── */

function AccountSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  return (
    <Section id="account" index={0}>
      <AccountFacts s={s} />
      <Block
        title="Password"
        description="You sign in with your email and password. A system administrator sets it; ask one to reset it."
      />
      <CertificationsBlock s={s} />
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
      <Facts
        bare
        className="set-facts"
        facts={[
          { label: "Name", value: s.user.name },
          { label: "Email", value: s.user.email },
          {
            label: "Role",
            value: (
              <>
                {memberRoleLabel(s)}
                {groups.length > 0 && (
                  <small>
                    {groups.join(", ")}
                    {program ? ` · ${program.name}` : ""}
                  </small>
                )}
              </>
            ),
          },
        ]}
      />
      <p className="set-hint">
        Your name and email are set by a system administrator; your access by
        your Flight Program administrator.
      </p>
    </Block>
  );
}

function CertificationsBlock({ s }: { s: Snapshot }) {
  const certifications = normalizeCertifications(s.user.certifications ?? []);
  return (
    <Block
      title="Certifications"
      description={`Printed on logbook entries you sign. ${certificationsEffect}`}
      side={
        <MyCertifications
          className="button small"
          label={
            <>
              <PencilSimple size={15} aria-hidden="true" />
              Edit my certifications
            </>
          }
        />
      }
    >
      {certifications.length ? (
        <ul className="set-certs">
          {certifications.map((c) => (
            <li key={c.kind}>
              <IconTile icon={IdentificationCard} size="sm" />
              <span>
                <strong>{certificationLabels[c.kind]}</strong>
                <small>{certificateSummary(c)}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-empty">{legacyLicense(s.user)}</p>
      )}
    </Block>
  );
}

/* ───────────────────────────── Alerts ───────────────────────────── */

function AlertsSection({ email }: { email?: boolean }) {
  return (
    <Section id="alerts" index={1}>
      <Block
        title="Under the bell"
        description={ALERT_KINDS_SUMMARY}
        side={
          <Link to="/alerts" className="button small">
            Open Alerts
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        }
      />
      <AlertEmailBlock email={email} />
      <DeviceAlertsBlock />
    </Section>
  );
}

// The only place alert email is chosen; online only. The urgent switch
// defaults on for administrators and maintenance members
// (wantsUrgentAlertEmails). A deployment without email shows why instead.
function AlertEmailBlock({ email }: { email?: boolean }) {
  return (
    <Block
      title="Alert email"
      description={`Alerts always appear under the bell. Email can bring them to you too: new alerts for your Flight Program once a day at ${ALERT_DIGEST_HOUR_UTC}:00 UTC, and urgent ones (a grounded aircraft, an overdue inspection or AD, a component past its limit, an expired date) as soon as they arise. Urgent emails stop at ${IMMEDIATE_EMAILS_PER_DAY} a day for the whole deployment, shared equally between its Flight Programs; past that they come in the next digest.`}
    >
      {email === false ? (
        <p className="set-empty">
          Email alerts are not turned on for this deployment. Alerts still
          appear under the bell; a system administrator can ask whoever deploys
          Angel One to set up email.
        </p>
      ) : (
        <AlertEmailSwitches />
      )}
    </Block>
  );
}

function AlertEmailSwitches() {
  const s = useWorkspace((x) => x.snapshot)!;
  const { backend, online, connected } = useWorkspace();
  const live = online && connected;
  const digest = useEmailChoice(
    wantsAlertEmails(s.user, s.groups, s.activeProgramUuid),
    (next) => backend!.setAlertEmails(next),
  );
  const urgent = useEmailChoice(
    wantsUrgentAlertEmails(s.user, s.groups, s.activeProgramUuid),
    (next) => backend!.setUrgentAlertEmails(next),
  );
  return (
    <>
      <div className="set-switches">
        <Switch
          name="emailAlerts"
          label="Email me a daily alert digest"
          checked={digest.checked}
          disabled={!live || digest.saving}
          onChange={digest.save}
        />
        <Switch
          name="urgentAlertEmails"
          label="Email me urgent alerts at once"
          checked={urgent.checked}
          disabled={!live || urgent.saving}
          onChange={urgent.save}
        />
      </div>
      {!live && (
        <p className="set-hint set-offline">
          <WifiSlash size={16} aria-hidden="true" /> Reconnect to change alert
          email.
        </p>
      )}
      {[digest.error, urgent.error].filter(Boolean).map((error) => (
        <p role="alert" className="error" key={error}>
          {error}
        </p>
      ))}
    </>
  );
}

// Shows the choice until the snapshot catches up with it, and the stored
// preference again if saving fails.
function useEmailChoice(
  stored: boolean,
  persist: (next: boolean) => Promise<unknown>,
) {
  const [pending, setPending] = useState<{ value: boolean; was: boolean }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(next: boolean) {
    setError("");
    setSaving(true);
    setPending({ value: next, was: stored });
    try {
      await persist(next);
    } catch (e) {
      setPending(undefined);
      setError(errorText(e, "Unable to save this setting."));
    } finally {
      setSaving(false);
    }
  }
  const checked = pending && pending.was === stored ? pending.value : stored;
  return { checked, saving, error, save };
}

/* ─────────────────────────── This device ────────────────────────── */

function DeviceSection() {
  const s = useWorkspace((x) => x.snapshot)!;
  const queue = useWorkspace((x) => x.queue);
  const pending = ownEntries(queue, s.user.id).length;
  return (
    <Section id="device" index={2}>
      <ThemeBlock />
      <LargeTextBlock />
      <OfflineDataBlock s={s} pending={pending} />
      <Block className="set-block-note">
        <p className="set-note">
          <Info size={18} weight="duotone" aria-hidden="true" />
          Your theme, text size, favorites, sidebar layout and print settings
          are kept on this device and do not follow your account.
        </p>
      </Block>
    </Section>
  );
}

function ThemeBlock() {
  const { choice, setTheme } = useTheme();
  return (
    <Block
      title="Theme"
      description="Applies to this device. Match this device follows its light or dark setting as it changes. The sun and moon button in the top bar picks Light or Dark."
      side={
        <Segmented
          label="Theme"
          className="set-theme"
          options={[
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "Match this device", icon: CircleHalf },
          ]}
          value={choice}
          onChange={(t) => setTheme(t as ThemeChoice)}
        />
      }
    />
  );
}

function OfflineDataBlock({ s, pending }: { s: Snapshot; pending: number }) {
  return (
    <Block
      title="Offline data"
      description="Flights and discrepancies recorded without a connection wait on this device until they sync."
    >
      <p className="set-hint">
        Offline access on this device lasts until{" "}
        <strong>{settingsDateTime(s.authenticatedAt + OFFLINE_WINDOW)}</strong>{" "}
        ({OFFLINE_DAYS} days after you signed in). Sign in again online before
        then to keep working offline.
      </p>
      <div className="set-offline-row">
        <IconTile
          icon={pending ? ArrowsClockwise : CloudCheck}
          size="sm"
          tone={pending ? "warn" : "good"}
        />
        <p>
          Last snapshot <strong>{settingsDateTime(s.syncedAt)}</strong>
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
      <nav aria-label="Kept on this device" className="set-links">
        <SettingsLink
          to="/manuals"
          icon={Books}
          title="Manuals kept on this device"
          sub="Reference manuals saved for offline reading, in the Reference library."
        />
      </nav>
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
    <Section id="program" index={3}>
      {!program ? (
        <Block>
          <NoticeBar icon={Info} tone="neutral" className="set-inline-notice">
            Choose a Flight Program in the program selector to see its details,
            labor rate, expiring dates, Aircraft Spruce account and exports.
          </NoticeBar>
        </Block>
      ) : (
        <ProgramBlocks
          s={s}
          program={program}
          onEdit={() => setEditing(true)}
        />
      )}
      <RelatedPages />
      {editing && program && (
        <ProgramDialog program={program} onClose={() => setEditing(false)} />
      )}
    </Section>
  );
}

function ProgramBlocks({
  s,
  program,
  onEdit,
}: {
  s: Snapshot;
  program: Program;
  onEdit: () => void;
}) {
  return (
    <>
      <ProgramDetails s={s} program={program} onEdit={onEdit} />
      <LaborRateSettings s={s} />
      <ExpiringDates scope="program" />
      <div className="set-block set-embed">
        <AircraftSpruceAccount />
      </div>
      <Block title="Saved addresses">
        <nav aria-label="Shipping addresses" className="set-links">
          <SettingsLink
            to="/saved-addresses"
            icon={MapPin}
            title="Saved addresses"
            sub="Shipping and receiving addresses for this Flight Program."
          />
        </nav>
      </Block>
      <ProgramExtract s={s} programUuid={program.uuid} />
    </>
  );
}

// The same rule as Flight Programs' "Edit Flight Program details" button.
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
    <Block
      title="Program details"
      side={
        canEdit && (
          <button
            type="button"
            className="button small"
            disabled={!online || !connected}
            onClick={onEdit}
          >
            <PencilSimple size={15} aria-hidden="true" />
            Edit Flight Program details
          </button>
        )
      }
    >
      <ProgramFacts program={program} />
    </Block>
  );
}

function ProgramFacts({ program }: { program: Program }) {
  const website = safeHref(program.website);
  return (
    <Facts
      bare
      className="set-facts"
      facts={[
        { label: "Name", value: program.name },
        {
          label: "Address",
          value: factLines(postalLines(program), "No address recorded"),
        },
        {
          label: "Contact",
          value: factLines(contactLines(program), "No contact recorded"),
        },
        {
          label: "Website",
          value: website ? (
            <a href={website} target="_blank" rel="noreferrer">
              {program.website}
            </a>
          ) : (
            "No website recorded"
          ),
        },
      ]}
    />
  );
}

function RelatedPages() {
  return (
    <Block title="Related pages">
      <nav aria-label="Flight Program pages" className="set-links">
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

function SettingsLink({
  to,
  icon,
  title,
  sub,
}: {
  to: "/saved-addresses" | "/admin" | "/manuals";
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

/** The active program's default labor rate; the backend's
 * settings.laborRate command requires program-admin permission. */
function LaborRateSettings({ s }: { s: Snapshot }) {
  const { backend, online, connected } = useWorkspace();
  const rate = laborRate(s);
  return (
    <section className="set-block" aria-labelledby="labor-rate-heading">
      <div className="set-block-text">
        <h3 id="labor-rate-heading">Default labor rate</h3>
        <p className="set-hint">
          Applied to labor that maintenance users record. Existing entries keep
          the rate they were recorded with.
        </p>
      </div>
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

function SystemSection({ features }: { features: DeploymentFeatures }) {
  const s = useWorkspace((x) => x.snapshot)!;
  return (
    <Section id="system" index={4}>
      <DeploymentStatus features={features} />
      <div className="set-block set-embed">
        <FaaKeySettings level={3} />
      </div>
      <div className="set-block set-embed">
        <AddressVerificationSettings />
      </div>
      <ExpiringDates scope="system" />
      <OffsiteBackups />
      <SystemExtract s={s} />
      <div className="set-block set-embed">
        <DemoBackup />
      </div>
    </Section>
  );
}

function visibleSections(s: Snapshot): SectionKey[] {
  return [
    "account",
    "alerts",
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

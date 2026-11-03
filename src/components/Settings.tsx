// Settings changes how the app behaves; Administration (Admin.tsx) decides
// who can do what. Every signed-in user except the owner view reaches this
// page; each section below repeats the permission check of the screen its
// panels came from, so moving a panel here never changes who can use it:
//   My account, This device — everyone;
//   Flight Program — Flight Program administrators (and system
//     administrators, for whom programPermission(…, "admin") is true);
//   System — system administrators only.
// Sections are deep-linkable: /settings#account, #device, #program, #system.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
import { localDate, type Snapshot } from "../domain/model";
import { activeProgram, programPermission } from "../domain/programs";
import { isPilotView } from "../domain/pilotView";
import { wantsAlertEmails } from "../domain/alerts";
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
import { toCsv } from "../domain/csv";
import { AsyncForm, Field, download, safeHref, value } from "./ui";
import {
  IconTile,
  NoticeBar,
  PageHeader,
  Segmented,
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
const sectionMeta: Record<
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
const programTables = [
  "aircraft",
  "flights",
  "discrepancies",
  "inspections",
  "inspectionTemplates",
  "management",
  "audit",
] as const;
const backupTables = [
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

const dateTime = (at: number) =>
  `${new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })} · ${new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })}`;

export function Settings() {
  const s = useWorkspace((x) => x.snapshot)!;
  const hash = useRouterState({ select: (r) => r.location.hash });
  const navigate = useNavigate();
  const sections: SectionKey[] = [
    "account",
    "device",
    ...(programPermission(s, "admin") ? (["program"] as const) : []),
    ...(s.user.isAdmin ? (["system"] as const) : []),
  ];
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
      <nav
        aria-label="Settings sections"
        className="ds-segmented set-jump rise"
      >
        {sections.map((key) => {
          const Icon = sectionMeta[key].icon;
          // Plain anchors: a router <Link> to /settings marks every one of
          // them aria-current="page" while this page is open.
          return (
            <a
              key={key}
              href={`#${key}`}
              aria-current={key === current ? "location" : undefined}
              onClick={(e) => {
                if (
                  e.button ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                )
                  return;
                e.preventDefault();
                void navigate({
                  to: "/settings",
                  hash: key,
                  hashScrollIntoView: false,
                });
                // Scroll here too, so tapping the current section again
                // (after scrolling away) still jumps to it.
                document.getElementById(key)?.scrollIntoView();
              }}
            >
              <Icon
                size={17}
                weight={key === current ? "duotone" : "regular"}
                aria-hidden="true"
              />
              {sectionMeta[key].label}
            </a>
          );
        })}
      </nav>
      <div className="set-sections">
        <AccountSection />
        <DeviceSection />
        {sections.includes("program") && <ProgramSection />}
        {sections.includes("system") && <SystemSection />}
      </div>
    </div>
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
  const { label, icon, description } = sectionMeta[id];
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

function AccountSection() {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const live = online && connected;
  const program = s.programs?.find((p) => p.uuid === s.activeProgramUuid);
  const groups = s.groups
    .filter(
      (g) =>
        s.user.groupIds.includes(g.id) && g.programUuid === s.activeProgramUuid,
    )
    .map((g) => g.name);
  const certifications = normalizeCertifications(s.user.certifications ?? []);
  // The same preference, default and backend call as the checkbox in
  // My certifications (alerts.setEmailPreference); online only, like there.
  const emailAlerts = wantsAlertEmails(s.user, s.groups, s.activeProgramUuid);
  const [pending, setPending] = useState<{ value: boolean; was: boolean }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Show the choice until the snapshot catches up with it.
  const checked =
    pending && pending.was === emailAlerts ? pending.value : emailAlerts;
  return (
    <Section id="account" index={0}>
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
      <Block
        title="Sign-in methods"
        description="Your password always works. A Google or Microsoft account whose verified email matches yours is linked the first time you sign in with it. For two-step verification, sign in with one that has it turned on."
      >
        <SignInMethodList />
      </Block>
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
          <p className="set-empty">
            {s.user.licenseNumber
              ? `Existing profile license: ${s.user.certificateType ?? ""} ${s.user.licenseNumber}`.trim()
              : "No certifications recorded."}
          </p>
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
      <Block
        title="Alert email"
        description="New maintenance alerts for your Flight Program, sent once a day. Alerts always appear under the bell."
      >
        <Switch
          label="Email me a daily alert digest"
          checked={checked}
          disabled={!live || saving}
          onChange={async (next) => {
            setError("");
            setSaving(true);
            setPending({ value: next, was: emailAlerts });
            try {
              await backend!.setAlertEmails(next);
            } catch (e) {
              setPending(undefined);
              setError(
                e instanceof Error ? e.message : "Unable to save this setting.",
              );
            } finally {
              setSaving(false);
            }
          }}
        />
        {!live && (
          <p className="set-hint set-offline">
            <WifiSlash size={16} aria-hidden="true" /> Reconnect to change alert
            email.
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </Block>
    </Section>
  );
}

/* ─────────────────────────── This device ────────────────────────── */

function DeviceSection() {
  const { theme, setTheme } = useTheme();
  const s = useWorkspace((x) => x.snapshot)!;
  const queue = useWorkspace((x) => x.queue);
  const pending = queue.filter(
    (q) => q.operation.authorId === s.user.id,
  ).length;
  return (
    <Section id="device" index={1}>
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
            Last snapshot <strong>{dateTime(s.syncedAt)}</strong>
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

/* ────────────────────────── Flight Program ───────────────────────── */

function ProgramSection() {
  const { snapshot, online, connected } = useWorkspace();
  const s = snapshot!;
  const [editing, setEditing] = useState(false);
  const programUuid = activeProgram(s);
  const program = s.programs?.find((p) => p.uuid === programUuid);
  // The same rule as Flight Programs' "Edit Flight Program" button.
  const canEdit =
    !!program &&
    (s.user.isAdmin ||
      (program.uuid === s.activeProgramUuid && programPermission(s, "admin")));
  const a = program?.addressDetails;
  const postal = a
    ? [
        a.organization,
        a.street,
        a.street2,
        [a.city, a.region, a.postalCode].filter(Boolean).join(", "),
        a.country,
      ].filter(Boolean)
    : (program?.address.split("\n").filter(Boolean) ?? []);
  const contact = [
    program?.contactName || a?.contactName,
    program?.email || a?.email,
    a?.phone,
  ].filter(Boolean);
  const website = safeHref(program?.website);
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
          <Block title="Program details">
            <dl className="set-facts">
              <div>
                <dt>Name</dt>
                <dd>{program.name}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>
                  {postal.length
                    ? postal.map((line, i) => (
                        <span className="set-line" key={i}>
                          {line}
                        </span>
                      ))
                    : "No address recorded"}
                </dd>
              </div>
              <div>
                <dt>Contact</dt>
                <dd>
                  {contact.length
                    ? contact.map((line, i) => (
                        <span className="set-line" key={i}>
                          {line}
                        </span>
                      ))
                    : "No contact recorded"}
                </dd>
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
            {canEdit && (
              <div className="set-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={!online || !connected}
                  onClick={() => setEditing(true)}
                >
                  <PencilSimple size={15} aria-hidden="true" />
                  Edit program details
                </button>
              </div>
            )}
          </Block>
          <LaborRateSettings s={s} />
          <div className="set-block set-embed">
            <AircraftSpruceAccount />
          </div>
        </>
      )}
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
      {program && (
        <div className="set-block set-embed">
          <CsvExportCard
            title="Export program data"
            tables={programTables}
            onDownload={(table) =>
              download(
                `${program.uuid}-${table}.csv`,
                toCsv(
                  (s[table as (typeof programTables)[number]] ?? []).map(
                    (row) => ({ ...row }),
                  ),
                ),
                "text/csv;charset=utf-8",
              )
            }
          >
            CSV exports of this Flight Program&apos;s records in this workspace
            snapshot.
          </CsvExportCard>
        </div>
      )}
      {editing && program && (
        <ProgramDialog program={program} onClose={() => setEditing(false)} />
      )}
    </Section>
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
          <Field
            label="Rate per hour (USD)"
            hint={
              rate === undefined
                ? "No default rate set."
                : `Current rate ${formatCents(rate)} per hour.`
            }
          >
            <input
              name="rate"
              required
              inputMode="decimal"
              defaultValue={rate === undefined ? "" : (rate / 100).toFixed(2)}
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
      <div className="set-block set-embed">
        <CsvExportCard
          title="Download data backup"
          tables={backupTables}
          onDownload={(table) =>
            download(
              `angel-one-${table}-${localDate()}.csv`,
              toCsv(
                (s[table as (typeof backupTables)[number]] ?? []).map(
                  (row) => ({ ...row }),
                ),
              ),
              "text/csv;charset=utf-8",
            )
          }
        >
          CSV exports of this workspace snapshot, excluding authentication
          secrets. Export pending entries separately in Sync center.
        </CsvExportCard>
      </div>
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

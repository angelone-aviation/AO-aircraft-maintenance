/**
 * Responsibility: The messages alerts go out as: the daily digest email, the
 *   urgent alert email and push message, and the off-site backup warning
 *   email, as subject, plain text and HTML.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./alerts.
 *
 * Record text is escaped in the HTML and flattened to one line elsewhere, so
 * it cannot add markup or headers; a site URL that is not http(s) is dropped.
 */
import { severityLabels, type Alert } from "./alerts";

/** The most alerts one digest lists; the rest are counted, not listed. */
export const DIGEST_LIMIT = 50;

/** The most alerts one urgent email or push message lists. */
export const URGENT_LIMIT = 10;

/** Where an urgent push message opens the app. */
export const URGENT_ALERTS_PATH = "/alerts";

// Push services cap a payload around 4 KB; the body stays well under it.
const PUSH_BODY_MAX_LENGTH = 400;

type DigestAlert = Pick<
  Alert,
  "key" | "title" | "detail" | "severity" | "link"
>;

interface DigestParts {
  program: string;
  base: string;
  backup: { text: string[]; html: string[] };
  groups: { label: string; rows: DigestAlert[] }[];
  moreText: string;
}

const SEVERITY_ORDER = ["danger", "warning", "info"] as const;
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const FOOTER = "Turn these emails off under My certifications in the app.";
const URGENT_FOOTER =
  "Turn these emails off under Settings → My account in the app.";

/**
 * One plain digest of a program's alerts, grouped by severity.
 *
 * @param alerts - The alerts, in the order to list them.
 * @param options - The program's name; the site URL to link to, used only
 *   when it is http(s); the off-site backup warning to put first, if any.
 * @returns The subject, HTML and text, and the alerts `shown`: the first
 *   {@link DIGEST_LIMIT}; the text and HTML count the rest.
 */
export function digestEmail<T extends DigestAlert>(
  alerts: T[],
  options: { programName: string; siteUrl?: string; backupWarning?: string },
) {
  const shown = alerts.slice(0, DIGEST_LIMIT);
  const more = alerts.length - shown.length;
  const base = siteBase(options.siteUrl);
  const parts: DigestParts = {
    program: oneLine(options.programName),
    base,
    backup: backupLines(options.backupWarning, base),
    groups: SEVERITY_ORDER.map((severity) => ({
      label: severityLabels[severity],
      rows: shown.filter((a) => a.severity === severity),
    })).filter((g) => g.rows.length),
    moreText: more > 0 ? `and ${more} more in the app.` : "",
  };
  const subject = `${parts.program}: ${alerts.length} maintenance alert${alerts.length === 1 ? "" : "s"}`;
  return { subject, html: digestHtml(parts), text: digestText(parts), shown };
}

/**
 * The off-site backup warning on its own, for a system administrator with no
 * maintenance alerts to send that day.
 *
 * @param warning - The warning.
 * @param options - The site URL to link to Settings, used only when http(s).
 * @returns The subject, text and HTML.
 */
export function backupWarningEmail(
  warning: string,
  options: { siteUrl?: string },
) {
  const backup = backupLines(warning, siteBase(options.siteUrl));
  return {
    subject: "Off-site backup warning",
    text: [...backup.text, FOOTER].join("\n"),
    html: [...backup.html, `<p>${FOOTER}</p>`].join(""),
  };
}

/**
 * One urgent alert email: the alerts that need action now, sent as soon as
 * they arise rather than in the next digest.
 *
 * @param alerts - The new urgent alerts, in the order to list them.
 * @param options - The program's name; the site URL to link to, used only
 *   when it is http(s).
 * @returns The subject ("<program>: N urgent alerts"), HTML and text, listing
 *   the first {@link URGENT_LIMIT} and counting the rest.
 */
export function urgentEmail<T extends DigestAlert>(
  alerts: T[],
  options: { programName: string; siteUrl?: string },
) {
  const shown = alerts.slice(0, URGENT_LIMIT);
  const more = alerts.length - shown.length;
  const program = oneLine(options.programName);
  const base = siteBase(options.siteUrl);
  const heading = `${program}: ${countOf(alerts.length, "urgent alert")}`;
  const moreText = more > 0 ? `and ${more} more in the app.` : "";
  const text = [
    heading,
    "",
    ...shown.map(
      (a) =>
        `- ${oneLine(a.title)}\n  ${oneLine(a.detail)}${base ? `\n  ${base}${a.link}` : ""}`,
    ),
    ...(moreText ? ["", moreText] : []),
    "",
    URGENT_FOOTER,
  ].join("\n");
  const html = [
    `<p><strong>${escapeHtml(heading)}</strong></p>`,
    `<ul>${shown.map((a) => alertItemHtml(a, base)).join("")}</ul>`,
    ...(moreText ? [`<p>${escapeHtml(moreText)}</p>`] : []),
    `<p>${URGENT_FOOTER}</p>`,
  ].join("");
  return { subject: heading, html, text, shown };
}

/**
 * The push message for new urgent alerts, shown by the device even while the
 * app is closed.
 *
 * @param alerts - The new urgent alerts, in the order to list them.
 * @param programName - The program's name, for the title.
 * @param scope - The program's uuid (or the system scope), for the tag;
 *   the name when absent.
 * @returns The title ("<program>: N urgent alerts"), a one-line-per-alert
 *   body of at most {@link URGENT_LIMIT} titles cut to 400 characters, the
 *   app path to open, and a tag the same for every message of the program,
 *   so the device keeps one card per program.
 */
export function urgentPushPayload<T extends Pick<DigestAlert, "title">>(
  alerts: T[],
  programName: string,
  scope = programName,
): { title: string; body: string; url: string; tag: string } {
  const shown = alerts.slice(0, URGENT_LIMIT);
  const more = alerts.length - shown.length;
  const lines = shown.map((a) => oneLine(a.title));
  if (more > 0) lines.push(`and ${more} more`);
  return {
    title: `${oneLine(programName)}: ${countOf(alerts.length, "urgent alert")}`,
    body: lines.join("\n").slice(0, PUSH_BODY_MAX_LENGTH),
    url: URGENT_ALERTS_PATH,
    tag: `urgent:${scope}`,
  };
}

const countOf = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
const siteBase = (siteUrl?: string) =>
  /^https?:\/\/[^\s"'<>]+$/i.test(siteUrl ?? "")
    ? siteUrl!.replace(/\/+$/, "")
    : "";

/** The backup warning as an email's first lines; empty without a warning. */
function backupLines(warning: string | undefined, base: string) {
  if (!warning) return { text: [], html: [] };
  const line = `Off-site backups: ${oneLine(warning)}`;
  const link = base && `${base}/settings#system`;
  return {
    text: [line, ...(link ? [link] : []), ""],
    html: [
      `<p><strong>Off-site backups:</strong> ${escapeHtml(oneLine(warning))}${
        link ? ` <a href="${escapeHtml(link)}">Settings → System</a>` : ""
      }</p>`,
    ],
  };
}

function digestText({ program, base, backup, groups, moreText }: DigestParts) {
  return [
    ...backup.text,
    `${program} maintenance alerts`,
    ...groups.flatMap((g) => [
      "",
      g.label.toUpperCase(),
      ...g.rows.map(
        (a) =>
          `- ${oneLine(a.title)}\n  ${oneLine(a.detail)}${base ? `\n  ${base}${a.link}` : ""}`,
      ),
    ]),
    ...(moreText ? ["", moreText] : []),
    "",
    FOOTER,
  ].join("\n");
}

function alertItemHtml(a: DigestAlert, base: string) {
  const title = escapeHtml(a.title);
  const linked = base
    ? `<a href="${escapeHtml(base + a.link)}">${title}</a>`
    : title;
  return `<li>${linked}<br>${escapeHtml(a.detail)}</li>`;
}

function digestHtml({ program, base, backup, groups, moreText }: DigestParts) {
  return [
    ...backup.html,
    `<p>${escapeHtml(program)} maintenance alerts</p>`,
    ...groups.map(
      (g) =>
        `<h3>${escapeHtml(g.label)}</h3><ul>${g.rows
          .map((a) => alertItemHtml(a, base))
          .join("")}</ul>`,
    ),
    ...(moreText ? [`<p>${escapeHtml(moreText)}</p>`] : []),
    `<p>${FOOTER}</p>`,
  ].join("");
}

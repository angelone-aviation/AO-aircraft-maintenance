/**
 * Responsibility: The daily alert digest email and the off-site backup
 *   warning email, as subject, plain text and HTML.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./alerts.
 *
 * Record text is escaped in the HTML and flattened to one line elsewhere, so
 * it cannot add markup or headers; a site URL that is not http(s) is dropped.
 */
import { severityLabels, type Alert } from "./alerts";

/** The most alerts one digest lists; the rest are counted, not listed. */
export const DIGEST_LIMIT = 50;

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

function digestHtml({ program, base, backup, groups, moreText }: DigestParts) {
  const item = (a: DigestAlert) => {
    const title = escapeHtml(a.title);
    const linked = base
      ? `<a href="${escapeHtml(base + a.link)}">${title}</a>`
      : title;
    return `<li>${linked}<br>${escapeHtml(a.detail)}</li>`;
  };
  return [
    ...backup.html,
    `<p>${escapeHtml(program)} maintenance alerts</p>`,
    ...groups.map(
      (g) =>
        `<h3>${escapeHtml(g.label)}</h3><ul>${g.rows.map(item).join("")}</ul>`,
    ),
    ...(moreText ? [`<p>${escapeHtml(moreText)}</p>`] : []),
    `<p>${FOOTER}</p>`,
  ].join("");
}

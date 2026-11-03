import { severityLabels, type Alert } from "./alerts";

export const DIGEST_LIMIT = 50;
type DigestAlert = Pick<
  Alert,
  "key" | "title" | "detail" | "severity" | "link"
>;
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
const siteBase = (siteUrl?: string) =>
  /^https?:\/\/[^\s"'<>]+$/i.test(siteUrl ?? "")
    ? siteUrl!.replace(/\/+$/, "")
    : "";
const FOOTER = "Turn these emails off under My certifications in the app.";

/** The off-site backup warning (system administrators only), as the first
 * lines of an email. Empty when there is no warning. */
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

/** One plain digest listing at most DIGEST_LIMIT alerts. `backupWarning`
 * puts the off-site backup warning above them. */
export function digestEmail<T extends DigestAlert>(
  alerts: T[],
  options: { programName: string; siteUrl?: string; backupWarning?: string },
) {
  const shown = alerts.slice(0, DIGEST_LIMIT);
  const more = alerts.length - shown.length;
  const base = siteBase(options.siteUrl);
  const program = oneLine(options.programName);
  const subject = `${program}: ${alerts.length} maintenance alert${alerts.length === 1 ? "" : "s"}`;
  const backup = backupLines(options.backupWarning, base);
  const groups = (["danger", "warning", "info"] as const)
    .map((severity) => ({
      label: severityLabels[severity],
      rows: shown.filter((a) => a.severity === severity),
    }))
    .filter((g) => g.rows.length);
  const moreText = more > 0 ? `and ${more} more in the app.` : "";
  const text = [
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
  const html = [
    ...backup.html,
    `<p>${escapeHtml(program)} maintenance alerts</p>`,
    ...groups.map(
      (g) =>
        `<h3>${escapeHtml(g.label)}</h3><ul>${g.rows
          .map((a) => {
            const title = escapeHtml(a.title);
            return `<li>${base ? `<a href="${escapeHtml(base + a.link)}">${title}</a>` : title}<br>${escapeHtml(a.detail)}</li>`;
          })
          .join("")}</ul>`,
    ),
    ...(moreText ? [`<p>${escapeHtml(moreText)}</p>`] : []),
    `<p>${FOOTER}</p>`,
  ].join("");
  return { subject, html, text, shown };
}

/** The off-site backup warning on its own, for a system administrator with
 * no maintenance alerts to send that day. */
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

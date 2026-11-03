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

/** One plain digest listing at most DIGEST_LIMIT alerts. */
export function digestEmail<T extends DigestAlert>(
  alerts: T[],
  options: { programName: string; siteUrl?: string },
) {
  const shown = alerts.slice(0, DIGEST_LIMIT);
  const more = alerts.length - shown.length;
  const base = /^https?:\/\/[^\s"'<>]+$/i.test(options.siteUrl ?? "")
    ? options.siteUrl!.replace(/\/+$/, "")
    : "";
  const program = oneLine(options.programName);
  const subject = `${program}: ${alerts.length} maintenance alert${alerts.length === 1 ? "" : "s"}`;
  const groups = (["danger", "warning", "info"] as const)
    .map((severity) => ({
      label: severityLabels[severity],
      rows: shown.filter((a) => a.severity === severity),
    }))
    .filter((g) => g.rows.length);
  const moreText = more > 0 ? `and ${more} more in the app.` : "";
  const text = [
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
    "Turn these emails off under My certifications in the app.",
  ].join("\n");
  const html = [
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
    "<p>Turn these emails off under My certifications in the app.</p>",
  ].join("");
  return { subject, html, text, shown };
}

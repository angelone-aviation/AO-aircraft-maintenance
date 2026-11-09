/**
 * Responsibility: The one email sender: Resend's API, its settings, the
 *   timeout, and counting what was sent and what failed.
 * Layer: Server. Used from actions only; it never reads the database.
 * Dependencies: none beyond the runtime's fetch.
 *
 * A failed email never stops the rest, and the log names the user id, never
 * the address or the content.
 */

const EMAIL_TIMEOUT_MS = 15000;
const RESEND_URL = "https://api.resend.com/emails";

/** An email ready to send. */
export interface Email {
  subject: string;
  html: string;
  text: string;
}

/** What sending needs from the deployment's environment. */
export interface MailerSettings {
  apiKey: string;
  from: string;
  siteUrl: string | undefined;
}

/** A sender bound to the deployment's settings; see {@link createMailer}. */
export type Mailer = ReturnType<typeof createMailer>;

/**
 * The deployment's email settings.
 *
 * @returns RESEND_API_KEY, RESEND_FROM and SITE_URL; undefined until both
 *   Resend variables are set, when in-app alerts work without email.
 */
export function mailerSettings(): MailerSettings | undefined {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) return undefined;
  return { apiKey, from, siteUrl: process.env.SITE_URL };
}

/**
 * A sender that counts its outcomes.
 *
 * @returns `send(to, email, failure, userId)`: true once the provider
 *   accepted the email, false after logging `failure` with the user id and
 *   the error; `counts` of both; and the site URL for links.
 */
export function createMailer({ apiKey, from, siteUrl }: MailerSettings) {
  const counts = { sent: 0, failed: 0 };
  const send = async (
    to: string,
    email: Email,
    failure: string,
    userId: string,
  ) => {
    try {
      await sendEmail(apiKey, from, to, email);
      counts.sent++;
      return true;
    } catch (error) {
      // One failed email must not stop the rest.
      counts.failed++;
      console.error(
        failure,
        userId,
        error instanceof Error ? error.message : "unknown error",
      );
      return false;
    }
  };
  return { counts, send, siteUrl };
}

async function sendEmail(
  apiKey: string,
  from: string,
  to: string,
  email: Email,
) {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `Email provider rejected the request (${response.status}).`,
    );
}

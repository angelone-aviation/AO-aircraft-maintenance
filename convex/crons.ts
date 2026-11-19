/**
 * Responsibility: Schedules the deployment's recurring jobs: the FAA AD check,
 *   the upload clean-up (expired manual-upload tickets and stored files
 *   nothing refers to), the maintenance alert email digest and the urgent
 *   alert check that follows it.
 * Layer: Server. Schedules only; each job is an internal function elsewhere.
 * Dependencies: convex/server (cronJobs), convex/_generated/api,
 *   src/domain (alerts, faa: the hours screens also quote).
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { ALERT_DIGEST_HOUR_UTC } from "../src/domain/alerts";
import { FAA_CHECK_HOUR_UTC } from "../src/domain/faa";

const crons = cronJobs();
crons.daily(
  "FAA AD monitoring",
  { hourUTC: FAA_CHECK_HOUR_UTC, minuteUTC: 0 },
  internal.faa.daily,
  {},
);
crons.hourly(
  "Upload cleanup",
  { minuteUTC: 15 },
  internal.manuals.cleanupUploads,
  {},
);
crons.daily(
  "Maintenance alert email digest",
  { hourUTC: ALERT_DIGEST_HOUR_UTC, minuteUTC: 0 },
  internal.alerts.sendDigests,
  {},
);
// After the digest, so an alert the digest sent is not sent again at once.
crons.daily(
  "Urgent alert check",
  { hourUTC: ALERT_DIGEST_HOUR_UTC, minuteUTC: 10 },
  internal.urgentAlerts.daily,
  {},
);

/** The schedule Convex runs; times are UTC. */
export default crons;

/**
 * Responsibility: Schedules the deployment's recurring jobs: the FAA AD check,
 *   expired manual-upload cleanup, the maintenance alert email digest and the
 *   urgent alert check that follows it.
 * Layer: Server. Schedules only; each job is an internal function elsewhere.
 * Dependencies: convex/server (cronJobs), convex/_generated/api.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily(
  "FAA AD monitoring",
  { hourUTC: 10, minuteUTC: 0 },
  internal.faa.daily,
  {},
);
crons.hourly(
  "Expired manual upload cleanup",
  { minuteUTC: 15 },
  internal.manuals.cleanupUploads,
  {},
);
crons.daily(
  "Maintenance alert email digest",
  { hourUTC: 13, minuteUTC: 0 },
  internal.alerts.sendDigests,
  {},
);
// After the digest, so an alert the digest sent is not sent again at once.
crons.daily(
  "Urgent alert check",
  { hourUTC: 13, minuteUTC: 10 },
  internal.urgentAlerts.daily,
  {},
);

/** The schedule Convex runs; times are UTC. */
export default crons;

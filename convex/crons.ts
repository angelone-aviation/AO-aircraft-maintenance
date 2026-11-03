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
export default crons;

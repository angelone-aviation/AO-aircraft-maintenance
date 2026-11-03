/** Value for a datetime-local input: device-local wall-clock time, not UTC. */
export function localDateTime(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

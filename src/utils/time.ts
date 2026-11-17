const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Parses a timestamp read from SQLite. `CURRENT_TIMESTAMP` yields UTC as
 * `YYYY-MM-DD HH:MM:SS` with no zone, which `new Date` would read as local
 * time, so that form is converted to ISO UTC first. Anything else (e.g. ISO
 * strings from browser preview) goes to `new Date` unchanged.
 */
export function parseDbTimestamp(s: string): Date {
  if (SQLITE_UTC_TIMESTAMP.test(s)) {
    return new Date(`${s.replace(' ', 'T')}Z`);
  }
  return new Date(s);
}

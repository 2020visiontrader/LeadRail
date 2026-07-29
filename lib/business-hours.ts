// Business-hours scheduling (Phase C, item 7).
// Shifts a would-be send time into an account's/sequence's working window so
// follow-ups never fire in the middle of the night. Pure, dependency-free —
// uses Intl to read the wall-clock hour/weekday in the target timezone.

export interface BusinessHours {
  tz: string;        // IANA tz, e.g. "America/Toronto"
  days: number[];    // allowed ISO weekdays, 1=Mon..7=Sun
  start: number;     // window open hour-of-day (0-23), inclusive
  end: number;       // window close hour-of-day (0-23), exclusive
}

const DEFAULTS: BusinessHours = { tz: 'America/Toronto', days: [1, 2, 3, 4, 5], start: 9, end: 17 };

/** Coerce a stored JSON blob into a valid BusinessHours, or null if disabled. */
export function normalizeBusinessHours(raw: any): BusinessHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const tz = typeof raw.tz === 'string' && raw.tz ? raw.tz : DEFAULTS.tz;
  const days = Array.isArray(raw.days) && raw.days.length
    ? raw.days.filter((d: any) => Number.isInteger(d) && d >= 1 && d <= 7)
    : DEFAULTS.days;
  const start = Number.isInteger(raw.start) ? Math.min(Math.max(raw.start, 0), 23) : DEFAULTS.start;
  const end = Number.isInteger(raw.end) ? Math.min(Math.max(raw.end, 1), 24) : DEFAULTS.end;
  if (!days.length || end <= start) return null;
  return { tz, days, start, end };
}

/** ISO weekday (1=Mon..7=Sun) and hour-of-day for `date` in timezone `tz`. */
function partsInTz(date: Date, tz: string): { weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const wdName = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { weekday: map[wdName] ?? 1, hour };
}

/**
 * Return the earliest instant >= `from` that falls inside the business-hours
 * window. If `bh` is null the time is returned unchanged (24/7). Steps forward
 * hour-by-hour (cheap, at most ~a few days of iterations) rather than doing
 * fragile tz-offset math — correctness over micro-optimization.
 */
export function nextBusinessTime(from: Date, bh: BusinessHours | null): Date {
  if (!bh) return from;
  const cursor = new Date(from.getTime());
  // Snap to the top of the hour we're evaluating to avoid drifting seconds.
  for (let i = 0; i < 24 * 14; i++) {
    const { weekday, hour } = partsInTz(cursor, bh.tz);
    if (bh.days.includes(weekday) && hour >= bh.start && hour < bh.end) return cursor;
    cursor.setTime(cursor.getTime() + 3600 * 1000); // advance one hour and re-check
  }
  return from; // pathological config — never trap the send
}

// The stamps of the API as numbers (spec C3, C4). `updated_at` crosses the wire as the exact text "2026-10-15T09:41:12.123456Z": six decimals and a Z.
// The cache compares two stamps as microsecond numbers parsed from that text. It never goes through `new Date(text)`, which keeps milliseconds only
// and would call two stamps a microsecond apart equal (a row changed twice in the same millisecond would then keep the older copy).
//
// A year-2026 stamp is about 1.8e15 microseconds, below 2^53 (9.0e15), so a plain JS number holds it exactly.

export class StampError extends Error {
  constructor(what: string) {
    super(`${what} is not a stamp of the form 2026-10-15T09:41:12.123456Z`);
    this.name = 'StampError';
  }
}

const STAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function parse(text: unknown): number | null {
  const m = typeof text === 'string' ? STAMP_TEXT.exec(text) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const whole = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls an impossible date over (30 February, 25:00): the same fields must come back out
  const back = new Date(whole);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return null;
  }
  return whole * 1000 + Number(m[7]);
}

/** Is this value the exact stamp text? */
export function isStamp(text: unknown): text is string {
  return parse(text) !== null;
}

/** The stamp as whole microseconds since 1970. Throws a StampError (which never repeats the text) for anything else. */
export function stampMicros(text: string): number {
  const micros = parse(text);
  if (micros === null) throw new StampError('A value');
  return micros;
}

/** -1, 0 or 1. */
export function compareStamps(a: string, b: string): -1 | 0 | 1 {
  const x = stampMicros(a);
  const y = stampMicros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Microseconds since 1970 back to the exact text, six decimals kept. */
export function formatStamp(micros: number): string {
  if (!Number.isSafeInteger(micros))
    throw new RangeError('A stamp is a whole number of microseconds');
  const ms = Math.floor(micros / 1000);
  const rest = micros - ms * 1000; // 0 to 999 microseconds
  const iso = new Date(ms).toISOString(); // 2026-10-15T09:41:12.123Z
  return `${iso.slice(0, -1)}${String(rest).padStart(3, '0')}Z`;
}

/** The stamp `seconds` earlier, as the exact text (the 30-second overlap of the first poll, C3). */
export function stampMinusSeconds(text: string, seconds: number): string {
  return formatStamp(stampMicros(text) - Math.round(seconds * 1_000_000));
}

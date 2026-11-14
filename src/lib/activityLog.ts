// FB-D4 (Siddhi #12): the owner's activity log. `GET /v1/audit-log` gives the audit rows newest first, 200 to a page (src/lib/cache/booksServer.ts `readAuditPage`); this file turns a row into the
// words the owner reads and holds the pages the screen has drawn.
//
//   - `describeAudit`: when (India, `14 Nov 2026, 7:05 pm`), who (the user's name, `System` for an actor that is not a known user) and what, in plain words. A login, a logout and a change of
//     password are `event` rows of the table `users`; a new bill is "New estimate <bill_no>", a receipt is "Payment <amount>", an update of a piece or a design is "Stock edited <number>"; anything
//     else is "<Action> <table>". The amount is the receipt's own text, written as the rest of the app writes rupees.
//   - `createAuditFeed`: the pages. It reads ONE page when the screen opens and one more for each press of "Load more", never ahead of the person (a shop that has logged 10,000 rows draws 200 until
//     it is asked for more). A page that fails keeps the rows already drawn and can be asked again.
import { PricingError, parseRupees } from './pricing';
import { paiseShown } from './ledgerView';
import type { AuditPageResponse, AuditRow } from './api/types';

export type { AuditRow } from './api/types';

// ---------------------------------------------------------------------------------------------------------
// the words
// ---------------------------------------------------------------------------------------------------------

export interface AuditLine {
  /** `14 Nov 2026, 7:05 pm`, in India. */
  when: string;
  who: string;
  what: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** India has no daylight saving time; its offset from UTC has been +05:30 since 1945. */
const INDIA_OFFSET_MS = 19_800_000;

/** An instant of the audit log (UTC, up to microseconds) as `14 Nov 2026, 7:05 pm` in India. The computer's own time zone and locale play no part. A text that is no instant is a dash. */
function whenShown(at: string): string {
  // a date is read to the millisecond: the microseconds of the wire form are cut
  const ms = Date.parse(String(at).replace(/(\.\d{3})\d+/, '$1'));
  if (!Number.isFinite(ms)) return '-';
  const india = new Date(ms + INDIA_OFFSET_MS);
  const hour = india.getUTCHours();
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${String(india.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
  return `${india.getUTCDate()} ${MONTHS[india.getUTCMonth()]} ${india.getUTCFullYear()}, ${clock}`;
}

const EVENT_WORDS: Readonly<Record<string, string>> = {
  login: 'Logged in',
  logout: 'Logged out',
  change_password: 'Changed password',
};

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const joined = (words: string, detail: string): string =>
  detail === '' ? words : `${words} ${detail}`;

/** What a payment row says: the amount in rupees as the app writes them, or nothing when the row has none. */
function amountOf(newRow: Record<string, unknown> | null): string {
  const amount = newRow?.amount;
  if (typeof amount !== 'string' && typeof amount !== 'number') return '';
  try {
    return paiseShown(parseRupees(amount));
  } catch (error) {
    if (error instanceof PricingError) return '';
    throw error;
  }
}

function whatShown(row: AuditRow): string {
  const facts = row.new_row;
  if (row.action === 'event' && row.table_name === 'users') {
    const named = EVENT_WORDS[textOf(facts?.event)];
    if (named !== undefined) return named;
  }
  if (row.action === 'insert' && row.table_name === 'bills') {
    return joined('New estimate', textOf(facts?.bill_no));
  }
  if (row.action === 'insert' && row.table_name === 'receipts') {
    return joined('Payment', amountOf(facts));
  }
  if (row.action === 'update' && row.table_name === 'skus') {
    return joined('Stock edited', textOf(facts?.sku_no));
  }
  if (row.action === 'update' && row.table_name === 'designs') {
    return joined('Stock edited', textOf(facts?.design_no));
  }
  return `${capitalised(row.action)} ${row.table_name.replace(/_/g, ' ')}`;
}

/** One row of the audit log in the words of the screen. `users` is the user's name by id (the Settings' users). */
export function describeAudit(row: AuditRow, users: ReadonlyMap<string, string>): AuditLine {
  return {
    when: whenShown(row.at),
    who: (row.actor !== null && users.get(row.actor)) || 'System',
    what: whatShown(row),
  };
}

// ---------------------------------------------------------------------------------------------------------
// the pages
// ---------------------------------------------------------------------------------------------------------

export interface AuditFeedState {
  /** Every row read so far, newest first. A new array whenever a page arrives. */
  rows: readonly AuditRow[];
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** The plain sentence of the last failure; null otherwise. */
  message: string | null;
  /** The server said there may be older rows (its `next`). */
  more: boolean;
}

export interface AuditFeed {
  state(): AuditFeedState;
  /** Reads the first page. Twice is once. */
  open(): Promise<void>;
  /** Reads the page after the rows held (or the first page again, when that one failed). At the end, or while a page is on its way, it asks for nothing. Never rejects: a failure is in the state. */
  loadMore(): Promise<void>;
  /** Called after every change of the state; returns the way to stop. For `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
}

const COULD_NOT_LOAD = 'The activity log could not be loaded. Try again.';
const EMPTY: AuditFeedState = Object.freeze({
  rows: [],
  state: 'idle',
  message: null,
  more: false,
});

export function createAuditFeed(
  read: (beforeId?: number) => Promise<AuditPageResponse>
): AuditFeed {
  let held: AuditFeedState = EMPTY;
  let cursor: number | null = null;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: AuditFeedState) => {
    held = next;
    for (const listener of Array.from(listeners)) listener();
  };

  const page = (beforeId: number | undefined): Promise<void> => {
    if (inflight) return inflight;
    set({ ...held, state: 'loading', message: null });
    const run = (async () => {
      try {
        const answer = await read(beforeId);
        cursor = answer.next === null ? null : answer.next.before_id;
        set({
          rows: beforeId === undefined ? answer.rows : [...held.rows, ...answer.rows],
          state: 'ready',
          message: null,
          more: answer.next !== null,
        });
      } catch {
        // the rows already drawn stay, and the same page can be asked for again
        set({ ...held, state: 'failed', message: COULD_NOT_LOAD });
      } finally {
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  };

  return {
    state: () => held,
    open: () => (held.state === 'idle' ? page(undefined) : (inflight ?? Promise.resolve())),
    loadMore: () => {
      if (inflight) return inflight;
      // a first page that failed is asked for again; at the end of the log nothing is asked
      if (held.rows.length === 0)
        return held.state === 'failed' ? page(undefined) : Promise.resolve();
      return held.more ? page(cursor ?? undefined) : Promise.resolve();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

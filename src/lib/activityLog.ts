// FB-D4 (Siddhi #12): the Activity Log. `GET /v1/audit-log` gives the audit rows newest first, 200 to a page (src/lib/cache/booksServer.ts `readAuditPage`) to a person whose role holds "See the Activity
// Log and health checks" (`activity_log`; among today's roles the owner alone); this file turns a row into the words that person reads and holds the pages the screen has drawn.
//
//   - `describeAudit`: when (India, `14 Nov 2026, 7:05 pm`), who (the user's name, `System` for an actor that is not a known user) and what, in plain words. A login, a logout and a change of
//     password are `event` rows of the table `users`; a new bill is "New estimate <bill_no>" (dues brought forward, `doc_type` opening_balance: "Opening balance <bill_no>"), a receipt is worded by
//     its `kind` ("Payment <amount>", "Money handed back <amount>", "Silver paid in cash <amount>", "Silver received <grams> g": a refund is never read as a payment), an update of a piece or a
//     design is "Stock edited <number>"; the Super Admin's changes in People & Roles are `event` rows of the tables `roles` and `users` whose facts give the words ("New role Sales", "Role Sales:
//     turned on <the ticks in words>", "Asha Verma now has the role Sales", "Password reset for Asha Verma"), and the plain insert and update of a role are "New role <name>" and "Role <name>
//     changed"; anything else is "<Action> <table>". The amount is the receipt's own text, written as the rest of the app writes rupees, the grams the receipt's own text through `formatGrams`.
//     A fact that is missing leaves its words out ("Role changed", "Person edited"): the line never says `undefined`.
//   - `createAuditFeed`: the pages. It reads ONE page when the screen opens and one more for each press of "Load more", never ahead of the person (a shop that has logged 10,000 rows draws 200 until
//     it is asked for more). A page that fails keeps the rows already drawn and can be asked again.
import { TICK_LABELS, type TickKey } from './access';
import { PricingError, formatGrams, parseGrams, parseRupees } from './pricing';
import { paiseShown } from './ledgerView';
import type { AuditPageResponse, AuditRow, OrderStatus } from './api/types';
import { ORDER_STATUS_LABEL } from './orderStatus';

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

/** The silver of a settlement row in grams as the app writes them (`2.500 g`), or nothing when the row has none. Whole milligrams, no float maths. */
function gramsOf(newRow: Record<string, unknown> | null): string {
  const grams = newRow?.fine_grams;
  if (typeof grams !== 'string' && typeof grams !== 'number') return '';
  try {
    return `${formatGrams(parseGrams(grams))} g`;
  } catch (error) {
    if (error instanceof PricingError) return '';
    throw error;
  }
}

/** What a new receipt says, by its kind: money in is a payment, money out is a refund, and a silver settlement is silver (a row with no kind, or one this screen does not know, is a payment). */
function receiptWords(facts: Record<string, unknown> | null): string {
  switch (textOf(facts?.kind)) {
    case 'refund':
      return joined('Money handed back', amountOf(facts));
    case 'fine_cash':
      return joined('Silver paid in cash', amountOf(facts));
    case 'fine_silver':
      return joined('Silver received', gramsOf(facts));
    default:
      return joined('Payment', amountOf(facts));
  }
}

/** An update whose row's `status` became `status` (and was something else before, when the row before is known). */
function changedTo(row: AuditRow, status: string): boolean {
  if (textOf(row.new_row?.status) !== status) return false;
  return row.old_row === null || textOf(row.old_row.status) !== status;
}

/** "New order ORD-2026-0007", "Order ORD-2026-0007 marked Ready", "Order ORD-2026-0007 edited". */
function orderWords(row: AuditRow): string {
  const number = textOf(row.new_row?.order_no);
  if (row.action === 'insert') return joined('New order', number);
  const status = textOf(row.new_row?.status);
  const before = textOf(row.old_row?.status);
  const label = ORDER_STATUS_LABEL[status as OrderStatus];
  if (row.old_row !== null && status !== before && label !== undefined)
    return `${joined('Order', number)} marked ${label}`;
  return `${joined('Order', number)} edited`;
}

/** A tick key in the words of the screen. A key with no words (one a later release dropped, or a hand edit) is shown as it is. */
function tickWords(key: string): string {
  return Object.hasOwn(TICK_LABELS, key) ? TICK_LABELS[key as TickKey] : key;
}

/** The ticks of a `turned_on` or `turned_off` fact in words, with commas between. Nothing when the fact is no list or holds no key. */
function ticksWords(list: unknown): string {
  if (!Array.isArray(list)) return '';
  return list
    .map(textOf)
    .filter((key) => key !== '')
    .map(tickWords)
    .join(', ');
}

/** "Role Sales: turned on <ticks>; turned off <ticks>", a part with nothing left out. An event that names no tick at all is "Role Sales changed". */
function ticksChangedWords(role: string, turnedOn: unknown, turnedOff: unknown): string {
  const on = ticksWords(turnedOn);
  const off = ticksWords(turnedOff);
  const parts: string[] = [];
  if (on !== '') parts.push(`turned on ${on}`);
  if (off !== '') parts.push(`turned off ${off}`);
  return parts.length === 0 ? `${role} changed` : `${role}: ${parts.join('; ')}`;
}

/** What the Super Admin's change of a role says, by the `event` of its row. A role the row does not name is just "Role". Null for an event this screen has no words for. */
function roleEventWords(facts: Record<string, unknown> | null): string | null {
  const name = textOf(facts?.name);
  const role = joined('Role', name);
  switch (textOf(facts?.event)) {
    case 'role_created':
      return joined('New role', name);
    case 'role_renamed': {
      const from = textOf(facts?.from);
      const to = textOf(facts?.to);
      return from !== '' && to !== '' ? `Role renamed ${from} to ${to}` : `${role} renamed`;
    }
    case 'role_described':
      return `${role}: description changed`;
    case 'role_ticks_changed':
      return ticksChangedWords(role, facts?.turned_on, facts?.turned_off);
    case 'role_switched_off':
      return `${role} switched off`;
    case 'role_switched_on':
      return `${role} switched on`;
    default:
      return null;
  }
}

/** A row of the table `roles`: the plain insert and update that its trigger writes, and the Super Admin's events. Null for an event this screen has no words for. */
function roleWords(row: AuditRow): string | null {
  if (row.action === 'insert') return joined('New role', textOf(row.new_row?.name));
  if (row.action === 'update') return `${joined('Role', textOf(row.new_row?.name))} changed`;
  return row.action === 'event' ? roleEventWords(row.new_row) : null;
}

/** What the Super Admin's change of a person says, by the `event` of its row (a login, a logout and a change of password are worded by `EVENT_WORDS`). A person the row does not name is just "Person". Null for an event this screen has no words for. */
function personEventWords(facts: Record<string, unknown> | null): string | null {
  const name = textOf(facts?.name);
  const person = name === '' ? 'Person' : name;
  switch (textOf(facts?.event)) {
    case 'person_added':
      return joined('Person added', name);
    case 'person_edited':
      return `${joined('Person', name)} edited`;
    case 'person_role_changed': {
      const role = textOf(facts?.to_name);
      return `${person} now has ${role === '' ? 'a new role' : `the role ${role}`}`;
    }
    case 'person_switched_off':
      return `${person} switched off`;
    case 'person_switched_on':
      return `${person} switched on`;
    case 'person_password_reset':
      return name === '' ? 'Password reset' : `Password reset for ${name}`;
    default:
      return null;
  }
}

function whatShown(row: AuditRow): string {
  const facts = row.new_row;
  if (row.action === 'event' && row.table_name === 'users') {
    const named = EVENT_WORDS[textOf(facts?.event)];
    if (named !== undefined) return named;
    const person = personEventWords(facts);
    if (person !== null) return person;
  }
  if (row.table_name === 'roles') {
    const role = roleWords(row);
    if (role !== null) return role;
  }
  if (row.action === 'insert' && row.table_name === 'bills') {
    return joined(
      textOf(facts?.doc_type) === 'opening_balance' ? 'Opening balance' : 'New estimate',
      textOf(facts?.bill_no)
    );
  }
  if (row.action === 'insert' && row.table_name === 'receipts') {
    return receiptWords(facts);
  }
  if (row.action === 'update' && row.table_name === 'skus') {
    return joined('Stock edited', textOf(facts?.sku_no));
  }
  if (row.action === 'update' && row.table_name === 'designs') {
    return joined('Stock edited', textOf(facts?.design_no));
  }
  // FB-F1 (F-extra-4): the Order Book, a void, a cancel and the removal of a photo
  if (row.table_name === 'orders' && (row.action === 'insert' || row.action === 'update')) {
    return orderWords(row);
  }
  if (row.action === 'update' && row.table_name === 'receipts' && changedTo(row, 'voided')) {
    return 'Payment voided';
  }
  if (row.action === 'update' && row.table_name === 'bills' && changedTo(row, 'cancelled')) {
    return 'Bill cancelled';
  }
  if (
    row.action === 'event' &&
    row.table_name === 'design_photos' &&
    textOf(facts?.event) === 'photo_removed'
  ) {
    return 'Photo removed';
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

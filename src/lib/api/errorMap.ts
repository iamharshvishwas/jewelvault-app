// The error map of the website (spec C13, S8; tasks WEB01 and WEB11): the plain message for every code the API can answer, and for the codes the client makes up itself.
//
//   - a refusal that happens before any write says that nothing was changed (JV_OVERPAYMENT, JV_PIECE_UNAVAILABLE, JV_INVALID_INPUT, ...); for the two codes whose own sentence names the
//     input or the reason (JV_INVALID_INPUT, JV_NOT_ALLOWED) the API's sentence is kept, because it never repeats a value;
//   - an unknown error (JV_INTERNAL), a JV_BUSY that failed again after its one automatic retry, a lost connection, a gateway that stays down and an answer that cannot be read say
//     "Could not confirm that this was saved." (S8: a connection lost during COMMIT leaves it unknown), and the screen reads the customer's books again at once (C17);
//   - a code this build does not know is treated like JV_INTERNAL: the generic message. The detail (the code, the status, the request id) goes to the console only, never to the person.
//
// This file is pure: it makes no call and keeps nothing. `client.ts` builds every ApiError message from it, and the pure helpers of the screens (billing.ts, payments.ts,
// ownerActions.ts) take their general sentences from here. tests/unit/error-map.test.ts (PT-U11) asserts that every code of S8 is mapped on purpose.

/** The generic message of an outcome nobody can vouch for (C13). */
export const UNCONFIRMED_MESSAGE = 'Could not confirm that this was saved.';
/** The sentence a refusal before any write ends with, on a call that saves. */
export const NOTHING_CHANGED = 'Nothing was changed.';

/** Refusals that happen before any write: the message adds that nothing was changed (on a write). */
const REFUSED_BEFORE_ANY_WRITE: Readonly<Record<string, string>> = {
  JV_INVALID_INPUT: 'Something you entered is not accepted.',
  JV_FORBIDDEN: 'You are not allowed to do this.',
  JV_NOT_FOUND: 'That record was not found.',
  JV_PIECE_UNAVAILABLE: 'One of the pieces is no longer available.',
  JV_CUSTOMER_ARCHIVED: 'This customer is archived.',
  JV_OVERPAYMENT: 'That payment is more than the amount owed.',
  JV_CASH_LIMIT: 'That cash payment is above the cash limit.',
  JV_FINE_EXCEEDS: 'That is more fine weight than is owed.',
  JV_BILL_CANCELLED: 'This bill is cancelled.',
  JV_ALREADY_VOID: 'This receipt is already void.',
  JV_NOT_ALLOWED: 'This is not allowed.',
  JV_STALE: 'This was changed by someone else. The latest version has been loaded.',
};

/** For these two the API's own sentence says what is wrong (it names the input, and never repeats a value), so it is shown instead of the general one. */
const SERVER_SENTENCE = new Set(['JV_INVALID_INPUT', 'JV_NOT_ALLOWED']);

/** Refused at the door, before any work (nothing was changed), with a message that already says what to do. */
const OTHER_REFUSALS: Readonly<Record<string, string>> = {
  JV_UNAUTHENTICATED: 'Sign in to continue.',
  JV_SESSION_EXPIRED: 'Your session has ended. Sign in again.',
  JV_BAD_LOGIN: 'Wrong email or password.',
  JV_PASSWORD_CHANGE_REQUIRED: 'You must choose a new password before you continue.',
  JV_CSRF: 'Reload the page and try again.',
  JV_RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  JV_PAYLOAD_TOO_LARGE: 'That file is too large.',
  JV_UNSUPPORTED_MEDIA_TYPE: 'That file type is not supported.',
};

export const NOT_ACTIVE_MESSAGE = 'Your account is not active. Ask the owner to activate it.';

const UNAVAILABLE = 'Cannot reach the server. Try again in a minute.';

/** The messages of a call that saves nothing (a read, a poll, the session calls), for the codes that mean "something went wrong". */
const READ_MESSAGES: Readonly<Record<string, string>> = {
  JV_BUSY: 'The server is busy. Try again in a moment.',
  JV_INTERNAL: 'Something went wrong on the server. Try again in a moment.',
  NETWORK: 'No connection to the server. Check your internet connection.',
  GATEWAY: 'The server is not answering yet. Try again in a minute.',
  BAD_RESPONSE: 'The server sent a reply that cannot be read safely. Reload the page.',
};

export interface MessageOptions {
  /** The call saves business data (default). A refusal then adds "Nothing was changed."; an unknown outcome says it could not be confirmed. */
  write?: boolean;
  /** The sentence the API sent in the body: used for JV_INVALID_INPUT and JV_NOT_ALLOWED only, never for anything else. */
  serverMessage?: string;
  details?: Record<string, unknown>;
}

const has = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** The plain message for a code (C13). Never the code, never a detail of the server. */
export function plainMessage(code: string, options: MessageOptions = {}): string {
  const write = options.write ?? true;
  if (code === 'JV_FORBIDDEN' && options.details?.reason === 'inactive') return NOT_ACTIVE_MESSAGE;
  if (has(REFUSED_BEFORE_ANY_WRITE, code)) {
    const own =
      SERVER_SENTENCE.has(code) && options.serverMessage?.trim()
        ? sentence(options.serverMessage)
        : REFUSED_BEFORE_ANY_WRITE[code];
    return write ? `${own} ${NOTHING_CHANGED}` : own;
  }
  if (has(OTHER_REFUSALS, code)) return OTHER_REFUSALS[code];
  if (code === 'JV_UNAVAILABLE') return UNAVAILABLE;
  // JV_BUSY (after its one retry), JV_INTERNAL, an unknown code, no answer, a gateway that stays down, an answer that cannot be read
  if (write) return UNCONFIRMED_MESSAGE;
  return READ_MESSAGES[code] ?? READ_MESSAGES.JV_INTERNAL;
}

/** Codes after which nothing was written because the call was refused at the door or before any step (so a retry by hand cannot double anything). */
export const NOTHING_WRITTEN: ReadonlySet<string> = new Set([
  ...Object.keys(REFUSED_BEFORE_ANY_WRITE),
  ...Object.keys(OTHER_REFUSALS),
]);

/**
 * Every code that has a message of its own on purpose (not the generic one it would get anyway): the twelve refusals before a write, the eight refusals at the door, JV_UNAVAILABLE,
 * and the codes that mean "could not confirm" on a write (JV_BUSY, JV_INTERNAL, NETWORK, GATEWAY, BAD_RESPONSE), which have a read-side message of their own.
 */
export const MAPPED_CODES: readonly string[] = [
  ...Object.keys(REFUSED_BEFORE_ANY_WRITE),
  ...Object.keys(OTHER_REFUSALS),
  'JV_UNAVAILABLE',
  ...Object.keys(READ_MESSAGES),
];

/** Is this code one the map names on purpose? A code of S8 that is not must be added (tests/unit/error-map.test.ts fails until it is). */
export function isMapped(code: string): boolean {
  return MAPPED_CODES.includes(code);
}

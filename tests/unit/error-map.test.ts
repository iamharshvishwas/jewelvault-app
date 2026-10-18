// WEB11 (PT-U11; spec C13, S8; T-E04 clause "every error code of S8 has a plain message and an unknown error shows the generic one"): the error map of the website.
//
//   - every code of S8 (and the codes the client makes up) is mapped ON PURPOSE (`isMapped`), not by falling into the generic message;
//   - a refusal before any write says that nothing was changed; JV_INTERNAL, a JV_BUSY that failed again and everything else that leaves the outcome unknown say
//     "Could not confirm that this was saved."; an unknown code gets that same generic message and never its own name;
//   - the same holds on the owner's screens: for each of the five owner actions and each code, the sentence the person reads is plain (no JV_, no request id, no detail of the
//     server), keeps the rule "nothing was changed / could not confirm", and the actions that name a reason (void the refund first, more than the advance, a walk-in advance, an
//     opening bill that cannot be re-issued) say it in words with the figure the API sent;
//   - the detail goes to the console only: a failed save writes the code, the status and the request id to the console and nothing else (no body, no password-like value).
//
// The checker is shown to see a hole (negative control): a map without a message for one code is reported.
//
// Run: npm test -- tests/unit/error-map.test.ts      (or: npm test -- -t PT-U11)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import {
  MAPPED_CODES,
  NOTHING_CHANGED,
  NOTHING_WRITTEN,
  UNCONFIRMED_MESSAGE,
  isMapped,
  plainMessage,
} from '@/lib/api/errorMap';
import { ApiError } from '@/lib/api/client';
import { ERROR_CODES } from '@/lib/api/types';
import { OWNER_ACTIONS, ownerActionFailure, reissueFailure } from '@/lib/ownerActions';

afterEach(() => vi.restoreAllMocks());

/** The codes the client itself makes up when no S8 body arrived. */
const CLIENT_CODES = ['NETWORK', 'GATEWAY', 'BAD_RESPONSE'] as const;

/** Codes in the sentence of S8, copied by hand from the spec (draft 5.2.2): the test fails if types.ts forgets one of them. */
const S8_CODES = [
  'JV_INVALID_INPUT',
  'JV_FORBIDDEN',
  'JV_NOT_FOUND',
  'JV_PIECE_UNAVAILABLE',
  'JV_CUSTOMER_ARCHIVED',
  'JV_OVERPAYMENT',
  'JV_CASH_LIMIT',
  'JV_FINE_EXCEEDS',
  'JV_BILL_CANCELLED',
  'JV_ALREADY_VOID',
  'JV_NOT_ALLOWED',
  'JV_BUSY',
  'JV_STALE',
  'JV_UNAUTHENTICATED',
  'JV_SESSION_EXPIRED',
  'JV_BAD_LOGIN',
  'JV_PASSWORD_CHANGE_REQUIRED',
  'JV_CSRF',
  'JV_RATE_LIMITED',
  'JV_PAYLOAD_TOO_LARGE',
  'JV_UNSUPPORTED_MEDIA_TYPE',
  'JV_UNAVAILABLE',
  'JV_INTERNAL',
];

/** An error the way the client makes it for a call that saves. */
function failed(code: string, details: Record<string, unknown> = {}, serverMessage = ''): ApiError {
  return new ApiError({
    code,
    status: code === 'NETWORK' ? 0 : 409,
    message: plainMessage(code, { write: true, serverMessage, details }),
    details,
    requestId: 'req-secret-id',
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    write: true,
  });
}

const PLAIN = /^[A-Z][^]*[.]$/;
const NO_LEAK = /JV_|req-secret|NETWORK|GATEWAY|BAD_RESPONSE|SELECT |stack/;

describe('PT-U11 / T-E04: the error map covers every code of S8 (C13)', () => {
  it('knows every code of S8, and no code that S8 does not name', () => {
    expect([...ERROR_CODES].sort()).toEqual([...S8_CODES].sort());
  });

  it('maps every code of S8 and every code of the client on purpose (not by falling into the generic message)', () => {
    for (const code of [...S8_CODES, ...CLIENT_CODES]) expect(isMapped(code), code).toBe(true);
    expect(MAPPED_CODES.length).toBeGreaterThanOrEqual(S8_CODES.length + CLIENT_CODES.length);
  });

  it('gives each code a plain sentence: a capital, a full stop, never the code itself', () => {
    for (const code of [...S8_CODES, ...CLIENT_CODES]) {
      for (const write of [true, false]) {
        const message = plainMessage(code, { write });
        expect(message, `${code} write=${write}`).toMatch(PLAIN);
        expect(message, `${code} write=${write}`).not.toMatch(NO_LEAK);
      }
    }
  });

  it('a refusal before any write says that nothing was changed, and a read does not', () => {
    for (const code of [
      'JV_INVALID_INPUT',
      'JV_FORBIDDEN',
      'JV_NOT_FOUND',
      'JV_PIECE_UNAVAILABLE',
      'JV_CUSTOMER_ARCHIVED',
      'JV_OVERPAYMENT',
      'JV_CASH_LIMIT',
      'JV_FINE_EXCEEDS',
      'JV_BILL_CANCELLED',
      'JV_ALREADY_VOID',
      'JV_NOT_ALLOWED',
      'JV_STALE',
    ]) {
      expect(plainMessage(code, { write: true }), code).toContain(NOTHING_CHANGED);
      expect(plainMessage(code, { write: false }), code).not.toContain(NOTHING_CHANGED);
      expect(NOTHING_WRITTEN.has(code), code).toBe(true);
    }
  });

  it('JV_INTERNAL, JV_BUSY (after its retry) and every lost outcome of a write say "Could not confirm that this was saved."', () => {
    expect(UNCONFIRMED_MESSAGE).toBe('Could not confirm that this was saved.');
    for (const code of ['JV_INTERNAL', 'JV_BUSY', ...CLIENT_CODES]) {
      expect(plainMessage(code, { write: true }), code).toBe(UNCONFIRMED_MESSAGE);
      expect(NOTHING_WRITTEN.has(code), code).toBe(false);
    }
    // a read cannot "lose a save": it says the server is busy or went wrong
    expect(plainMessage('JV_BUSY', { write: false })).toBe(
      'The server is busy. Try again in a moment.'
    );
  });

  it('an unknown code gets the generic message of a write, and the read-side message of a read, and never its own name', () => {
    for (const code of ['JV_SOMETHING_NEW', 'JV_', '', 'not-a-code', '500']) {
      expect(plainMessage(code, { write: true }), code).toBe(UNCONFIRMED_MESSAGE);
      expect(plainMessage(code, { write: false }), code).toBe(
        'Something went wrong on the server. Try again in a moment.'
      );
      expect(isMapped(code), code).toBe(false);
    }
  });

  it("the API's own sentence is used for JV_INVALID_INPUT and JV_NOT_ALLOWED only, and never for any other code", () => {
    expect(plainMessage('JV_INVALID_INPUT', { serverMessage: 'amount must be above 0' })).toBe(
      'amount must be above 0. Nothing was changed.'
    );
    expect(plainMessage('JV_NOT_ALLOWED', { serverMessage: 'Void the refund first' })).toBe(
      'Void the refund first. Nothing was changed.'
    );
    for (const code of ['JV_OVERPAYMENT', 'JV_BILL_CANCELLED', 'JV_INTERNAL', 'JV_BUSY']) {
      expect(
        plainMessage(code, { serverMessage: 'raw detail from the server' }),
        code
      ).not.toContain('raw detail');
    }
  });

  it('the checker sees a hole: a map that forgot a code is reported (negative control)', () => {
    const forgotten = S8_CODES.filter((code) => code !== 'JV_STALE');
    const holes = (mapped: readonly string[]) => S8_CODES.filter((code) => !mapped.includes(code));
    expect(holes(MAPPED_CODES)).toEqual([]);
    expect(holes(forgotten)).toEqual(['JV_STALE']);
    expect(isMapped('JV_STALE')).toBe(true);
    expect(isMapped('JV_STALE_TYPO')).toBe(false);
  });
});

describe('PT-U11: the sentence on the owner screens, for every action and every code (C13)', () => {
  const CODES = [...S8_CODES, ...CLIENT_CODES, 'JV_SOMETHING_NEW'];
  /** Refused at the door or before any step: nothing was written. JV_UNAVAILABLE is the start-up check that failed (S11): no request is served. */
  const DOOR = new Set([...NOTHING_WRITTEN, 'JV_UNAVAILABLE']);

  it('there are five owner actions', () => {
    expect([...OWNER_ACTIONS].sort()).toEqual(['cancel', 'opening', 'refund', 'reissue', 'void']);
  });

  for (const action of OWNER_ACTIONS) {
    it(`${action}: every code gives a plain sentence that keeps the rule of C13, with no code, id or detail in it`, () => {
      for (const code of CODES) {
        const details = { field: 'reason', sql: 'SELECT secret FROM users' };
        const error = failed(code, details);
        const found =
          action === 'reissue'
            ? reissueFailure(error, { role: 'owner', walkIn: false })
            : ownerActionFailure(error, { action, walkIn: false });
        expect(found.message, `${action} ${code}`).toMatch(PLAIN);
        expect(found.message, `${action} ${code}`).not.toMatch(NO_LEAK);
        if (DOOR.has(code)) {
          // refused before any work: nothing to confirm, nothing to read again
          expect(found.unconfirmed, `${action} ${code}`).toBe(false);
          expect(found.message, `${action} ${code}`).toMatch(
            /nothing was changed|sign in|session|password|reload|wait a minute|too large|file type/i
          );
        } else {
          // the outcome is not known: the screen says so, and says the books are being read again
          expect(found.unconfirmed, `${action} ${code}`).toBe(true);
          expect(found.message, `${action} ${code}`).toContain(UNCONFIRMED_MESSAGE);
        }
      }
    });
  }

  it('a failure that is not an ApiError at all (a bug in the page) is still a plain sentence, not a stack', () => {
    for (const action of OWNER_ACTIONS.filter((a) => a !== 'reissue')) {
      const found = ownerActionFailure(new TypeError('Cannot read properties of undefined'), {
        action,
        walkIn: false,
      });
      expect(found.message, action).toMatch(PLAIN);
      expect(found.message, action).not.toMatch(/Cannot read|TypeError/);
    }
    expect(reissueFailure('boom', { role: 'owner', walkIn: false }).message).toMatch(PLAIN);
  });

  it('X4: voiding a payment whose money was handed back says to void the refund first, with how much was handed back', () => {
    const found = ownerActionFailure(
      failed('JV_NOT_ALLOWED', { reason: 'void_the_refund_first', short_by: '300.00' }),
      { action: 'void', walkIn: false }
    );
    expect(found.message).toContain('Void the refund first');
    expect(found.message).toContain('₹300');
    expect(found.message).toContain(NOTHING_CHANGED);
    expect(found.unconfirmed).toBe(false);
  });

  it('X5: a bill of the walk-in with money received is refused until its receipts are voided', () => {
    const found = ownerActionFailure(
      failed('JV_NOT_ALLOWED', { reason: 'void_its_receipts_first' }),
      {
        action: 'cancel',
        walkIn: true,
      }
    );
    expect(found.message).toMatch(/void (those|the) receipts first/i);
    expect(found.message).toContain(NOTHING_CHANGED);
  });

  it('X5 and X4: an archived customer, a bill already cancelled and a receipt already void are said in words', () => {
    expect(ownerActionFailure(failed('JV_BILL_CANCELLED'), { action: 'cancel' }).message).toBe(
      'This bill is already cancelled. Nothing was changed.'
    );
    expect(ownerActionFailure(failed('JV_ALREADY_VOID'), { action: 'void' }).message).toBe(
      'This receipt is already void. Nothing was changed.'
    );
    expect(
      ownerActionFailure(failed('JV_CUSTOMER_ARCHIVED'), { action: 'cancel' }).message
    ).toMatch(/archived/);
  });

  it('X10: a bill that was cancelled or re-issued already, an opening bill, and the walk-in surplus each have their own sentence', () => {
    const cancelled = reissueFailure(failed('JV_BILL_CANCELLED'), { role: 'owner', walkIn: false });
    expect(cancelled.message).toMatch(/already cancelled or re-issued/);
    const opening = reissueFailure(failed('JV_NOT_ALLOWED', { reason: 'not_an_estimate' }), {
      role: 'owner',
      walkIn: false,
    });
    expect(opening.message).toMatch(/opening balance/i);
    expect(opening.message).toMatch(/cancel it and add a new/i);
    const surplus = reissueFailure(
      failed('JV_NOT_ALLOWED', { reason: 'void_its_receipts_first', surplus: '400.00' }),
      { role: 'owner', walkIn: true }
    );
    expect(surplus.message).toMatch(/void (those|the) receipts first/i);
    expect(surplus.message).toContain('₹400');
  });

  it('X10 keeps the words of the billing screen for a piece that is no longer available, an overpayment and the cash limit, and marks the pieces', () => {
    const piece = reissueFailure(
      failed('JV_PIECE_UNAVAILABLE', {
        pieces: [{ sku_no: 'A-001', status: 'Sold' }],
        sku_ids: ['00000000-0000-4000-8000-0000000000aa'],
      }),
      { role: 'owner', walkIn: false }
    );
    expect(piece.message).toContain('A-001 (Sold)');
    expect(piece.pieceIds).toEqual(['00000000-0000-4000-8000-0000000000aa']);
    expect(piece.message).toContain(NOTHING_CHANGED);
    const cash = reissueFailure(
      failed('JV_CASH_LIMIT', {
        limit: '200000.00',
        cash_today: '150000.00',
        this_call: '60000.00',
      }),
      { role: 'owner', walkIn: false }
    );
    expect(cash.cashLimit).toEqual({ ownerMayGiveReason: true });
    const over = reissueFailure(
      failed('JV_OVERPAYMENT', { payments_total: '1200.00', grand_total: '1000.00' }),
      { role: 'owner', walkIn: false }
    );
    expect(over.message).toMatch(/more than the bill/);
  });

  it('X11: more than the advance says what the customer holds and by how much the refund is too much; a customer with no advance has nothing to hand back', () => {
    const more = ownerActionFailure(
      failed('JV_NOT_ALLOWED', {
        field: 'amount',
        reason: 'more_than_advance',
        advance: '200.00',
        short_by: '50.00',
      }),
      { action: 'refund', walkIn: false }
    );
    expect(more.message).toContain('₹200');
    expect(more.message).toContain('₹50');
    expect(more.message).toContain(NOTHING_CHANGED);
    const none = ownerActionFailure(
      failed('JV_NOT_ALLOWED', {
        field: 'amount',
        reason: 'more_than_advance',
        advance: '0.00',
        short_by: '50.00',
      }),
      { action: 'refund', walkIn: false }
    );
    expect(none.message).toMatch(/no advance/i);
    const walkin = ownerActionFailure(
      failed('JV_NOT_ALLOWED', {
        field: 'amount',
        reason: 'more_than_advance',
        advance: '0.00',
        short_by: '50.00',
      }),
      { action: 'refund', walkIn: true }
    );
    expect(walkin.message).toMatch(/walk-in customer never holds an advance/i);
  });

  it('X12: the walk-in cannot hold an advance, an empty form and a bad date are said in words', () => {
    const walkin = ownerActionFailure(
      failed('JV_NOT_ALLOWED', { field: 'advance', reason: 'walkin_holds_no_advance' }),
      { action: 'opening', walkIn: true }
    );
    expect(walkin.message).toMatch(/walk-in/i);
    expect(walkin.message).toMatch(/advance/i);
    expect(walkin.message).toContain(NOTHING_CHANGED);
    const empty = ownerActionFailure(failed('JV_INVALID_INPUT', { field: 'dues' }), {
      action: 'opening',
      walkIn: false,
    });
    expect(empty.message).toMatch(/at least one/i);
    const date = ownerActionFailure(failed('JV_INVALID_INPUT', { field: 'as_of' }), {
      action: 'opening',
      walkIn: false,
    });
    expect(date.message).toMatch(/date/i);
  });

  it('the reason of a cancel or a void is named when the API refuses it', () => {
    for (const action of ['cancel', 'void'] as const) {
      const found = ownerActionFailure(failed('JV_INVALID_INPUT', { field: 'reason' }), { action });
      expect(found.message, action).toMatch(/reason of 3 to 500 characters/);
      expect(found.message, action).toContain(NOTHING_CHANGED);
    }
  });

  it('an unconfirmed outcome tells the person that the books are read again and that pressing the button again never does it twice', () => {
    const found = ownerActionFailure(failed('JV_INTERNAL'), { action: 'cancel' });
    expect(found.message).toContain(UNCONFIRMED_MESSAGE);
    expect(found.message).toMatch(/never done twice|never made twice|not done twice/i);
    expect(found.unconfirmed).toBe(true);
  });
});

describe('PT-U11 / C13: the detail goes to the console only', () => {
  it('a JV_INTERNAL answer writes the code, the status and the request id to the console, and the person reads only the generic sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'JV_INTERNAL',
              message: 'ER_DUP_ENTRY at uq_bills_no (stack: x.js:12)',
              details: { sql: 'INSERT INTO bills' },
            },
            request_id: 'req-from-server',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const error = await client
      .post('/v1/bills/b/cancel', { reason: 'wrong rate' }, { idempotent: true })
      .catch((caught: ApiError) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const shown = (error as ApiError).message;
    expect(shown).toBe(UNCONFIRMED_MESSAGE);
    expect(shown).not.toMatch(/ER_DUP|stack|INSERT|req-from-server/);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('req-from-server');
    expect(logged).toContain('JV_INTERNAL');
    expect(logged).not.toContain('wrong rate'); // the body of the call is never logged
    expect(logged).not.toContain('INSERT');
    const found = ownerActionFailure(error, { action: 'cancel' });
    expect(found.message).not.toMatch(/ER_DUP|stack|INSERT|req-from-server/);
  });
});

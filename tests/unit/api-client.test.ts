import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ApiError,
  CONNECTION_BANNER,
  POLL_BACKOFF_MS,
  WAKING_BACKOFF_MS,
  createApiClient,
  newIdempotencyKey,
  nextPollDelayMs,
  plainMessage,
  type ApiClient,
} from '@/lib/api/client';
import { BUILD_PRICING_SHA256 } from '@/lib/api/pricingHash';
import { ERROR_CODES } from '@/lib/api/types';
import { HASH_FILE, PRICING_FILE, syncPricingHash } from '../../scripts/pricing-hash.mjs';

// PT-W1 (task WEB01): the API client of the website, with a stubbed `fetch`. Every rule of the task is one case below:
// credentials and headers (C7, S8), the Idempotency-Key (L5, C5, C6), money and weight as strings both ways (S3), the plain
// message of every code (C13), the one retry of JV_BUSY (S8), "Waking up" and the back-off (C7), the pricing hash (C12),
// the 401 hook (U6). The contract test against a real API is tests/e2e/api-client.spec.ts.

const BASE = 'https://api.example.test';
const root = path.resolve(__dirname, '../..');

// ------------------------------------------------------------------------------------------------ the stub

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  init: RequestInit;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
/** The S8 body of the API's own refusals. */
const refusal = (
  code: string,
  status: number,
  message = 'The server says no.',
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) => json(status, { error: { code, message, details }, request_id: 'req-123' }, headers);
/** What a proxy answers while the app is being started: no JV_ body, not JSON. */
const html = (status: number) =>
  new Response('<html><body>Service Unavailable</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });

function stub(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      init,
    };
    calls.push(call);
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next === undefined) throw new Error('the stub has no reply');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next.clone();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function make(...replies: Reply[]) {
  const stubbed = stub(...replies);
  const waits: number[] = [];
  const client = createApiClient({
    baseUrl: BASE,
    fetch: stubbed.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { client, calls: stubbed.calls, waits };
}

/** The outcome of a call that should be refused: the ApiError, or a failed test. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WRITE = { idempotent: true } as const;

/** The console of the test: the client writes the code, status and request id of an unexpected failure there (C13), which is read back below. */
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

// ------------------------------------------------------------------------------------------------ the address

describe('PT-W1 api client: the address comes from NEXT_PUBLIC_API_URL only', () => {
  it('reads the address from the variable when none is given, and drops a trailing slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://billing-api.example.test/');
    const { fetch, calls } = stub(json(200, { ok: true }));
    const client = createApiClient({ fetch });
    await client.get('/v1/auth/me');
    expect(calls[0].url).toBe('https://billing-api.example.test/v1/auth/me');
  });

  it('says plainly that the address is missing, and calls nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    const { fetch, calls } = stub(json(200, {}));
    const client = createApiClient({ fetch });
    await expect(client.get('/v1/auth/me')).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an address that is not an origin (a path, a query, a made-up scheme)', () => {
    for (const bad of [
      'billing-api.example.test',
      'ftp://x.test',
      'https://x.test/v1',
      'https://x.test/?a=1',
    ]) {
      expect(() => createApiClient({ baseUrl: bad, fetch: stub(json(200, {})).fetch })).toThrow(
        /NEXT_PUBLIC_API_URL|origin/
      );
    }
  });

  it('allows plain http on this computer only (the lane), https everywhere else', () => {
    for (const ok of [
      'http://localhost:4229',
      'http://127.0.0.1:4229',
      'https://api.example.test',
    ]) {
      expect(() =>
        createApiClient({ baseUrl: ok, fetch: stub(json(200, {})).fetch })
      ).not.toThrow();
    }
    for (const bad of ['http://api.example.test', 'http://localhost.evil.test']) {
      expect(() => createApiClient({ baseUrl: bad, fetch: stub(json(200, {})).fetch })).toThrow(
        /https/
      );
    }
  });

  it('only ever calls its own origin: a full URL, a protocol-relative one or a path without a slash is refused', async () => {
    const { client, calls } = make(json(200, {}));
    for (const bad of [
      'https://evil.test/v1/x',
      '//evil.test/v1/x',
      'v1/auth/me',
      '/v1/../x',
      '',
    ]) {
      await expect(client.get(bad)).rejects.toThrow(/path/i);
    }
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ credentials and headers

describe('PT-W1 api client: credentials and headers (C7, S8, A12)', () => {
  it('sends the cookie on every call (credentials include) and never reads a cached copy', async () => {
    const { client, calls } = make(json(200, { ok: true }));
    await client.get('/v1/auth/me');
    await client.post('/v1/auth/activity');
    for (const call of calls) {
      expect(call.init.credentials).toBe('include');
      expect(call.init.cache).toBe('no-store');
    }
  });

  it('puts X-JV-Client: web on every state-changing call, a read-only POST too, and on no GET', async () => {
    const { client, calls } = make(json(200, { ok: true }));
    await client.get('/v1/auth/me');
    await client.post('/v1/sync/poll', { cursors: {} }, { readOnly: true });
    await client.post('/v1/auth/logout');
    await client.put('/v1/settings/business', { value: {} });
    await client.patch('/v1/customers/1', { changes: {} });
    await client.request('DELETE', '/v1/x/1');
    expect(calls.map((c) => c.headers.get('x-jv-client'))).toEqual([
      null,
      'web',
      'web',
      'web',
      'web',
      'web',
    ]);
  });

  it('sends Content-Type only when there is a body: logout and activity send none (an empty JSON body is a 422)', async () => {
    const { client, calls } = make(json(200, { ok: true }));
    await client.logout();
    await client.activity();
    await client.get('/v1/auth/me');
    await client.post('/v1/sync/poll', { cursors: {} }, { readOnly: true });
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers.get('content-type')).toBeNull();
    expect(calls[1].body).toBeUndefined();
    expect(calls[1].headers.get('content-type')).toBeNull();
    expect(calls[2].headers.get('content-type')).toBeNull();
    expect(calls[3].headers.get('content-type')).toBe('application/json');
    expect(calls[3].body).toBe('{"cursors":{}}');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'POST']);
  });

  it('puts the session calls on their addresses', async () => {
    const { client, calls } = make(json(200, { ok: true }));
    await client.login('a@b.test', 'pw');
    await client.changePassword('old', 'new');
    expect(calls[0].url).toBe(`${BASE}/v1/auth/login`);
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ email: 'a@b.test', password: 'pw' });
    expect(calls[1].url).toBe(`${BASE}/v1/auth/change-password`);
    expect(JSON.parse(calls[1].body ?? '')).toEqual({
      current_password: 'old',
      new_password: 'new',
    });
  });

  it('asks the sync reads with a query and no custom header, and the poll as a read-only POST with no key', async () => {
    const { client, calls } = make(json(200, { rows: [], next: null, server_time: 't' }));
    await client.syncPage('daily-rates', {
      updatedAfter: '2026-10-15T09:41:12.123456Z',
      afterKey: 'abc',
      limit: 500,
    });
    await client.poll({ customers: null }, 1000);
    expect(calls[0].url).toBe(
      `${BASE}/v1/sync/daily-rates?updated_after=2026-10-15T09%3A41%3A12.123456Z&after_key=abc&limit=500`
    );
    expect(calls[0].headers.get('x-jv-client')).toBeNull();
    expect(calls[1].url).toBe(`${BASE}/v1/sync/poll`);
    expect(JSON.parse(calls[1].body ?? '')).toEqual({ limit: 1000, cursors: { customers: null } });
    expect(calls[1].headers.get('idempotency-key')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ Idempotency-Key

describe('PT-W1 api client: the Idempotency-Key (L5, C5, C6)', () => {
  it('makes one key per call, a UUID v4, and sends none on a call that is not a function', async () => {
    const { client, calls } = make(json(201, { customer: {} }));
    await client.post('/v1/customers', { name: 'A' }, WRITE);
    await client.post('/v1/customers', { name: 'B' }, WRITE);
    await client.post('/v1/bills/quote', { items: [] }, { readOnly: true });
    await client.patch('/v1/customers/1', { changes: {} });
    const keys = calls.map((c) => c.headers.get('idempotency-key'));
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]); // the next user action gets a new key
    expect(keys[2]).toBeNull();
    expect(keys[3]).toBeNull();
    expect(newIdempotencyKey()).toMatch(UUID_V4);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it('reuses the same key when the call is retried inside the client (JV_BUSY, then a gateway error)', async () => {
    const { client, calls } = make(
      refusal('JV_BUSY', 503, 'Busy.', {}, { 'retry-after': '1' }),
      html(502),
      json(201, { customer: { id: 'c1' } })
    );
    await client.post('/v1/customers', { name: 'A' }, WRITE);
    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map((c) => c.headers.get('idempotency-key')));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(UUID_V4);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1); // the same bytes, too
  });

  it('puts the key on the error, and sends it again when the person retries the same action', async () => {
    const { client, calls } = make(refusal('JV_INTERNAL', 500), json(201, { customer: {} }));
    const error = await failure(client.post('/v1/customers', { name: 'A' }, WRITE));
    expect(error.idempotencyKey).toMatch(UUID_V4);
    await client.post(
      '/v1/customers',
      { name: 'A' },
      { idempotencyKey: error.idempotencyKey ?? '' }
    );
    expect(calls[1].headers.get('idempotency-key')).toBe(error.idempotencyKey);
  });

  it('refuses a key that is not a UUID, and calls nothing', async () => {
    const { client, calls } = make(json(201, {}));
    await expect(
      client.post('/v1/customers', {}, { idempotencyKey: 'not-a-uuid' })
    ).rejects.toThrow(/Idempotency-Key/);
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ money and weight

describe('PT-W1 api client: money and weight are strings both ways (S3)', () => {
  it('sends the exact text, a trailing zero included, and the counts as integers', async () => {
    const { client, calls } = make(json(201, { bill: {} }));
    await client.post(
      '/v1/bills',
      {
        customer_id: 'c1',
        items: [{ sku_id: 's1', metal_rate: '6920.00', piroi: '2.15', quantity: 2 }],
        payments: [{ mode: 'UPI', amount: '100000.00' }],
        gross: { grams: '35.420' },
      },
      WRITE
    );
    expect(calls[0].body).toBe(
      '{"customer_id":"c1","items":[{"sku_id":"s1","metal_rate":"6920.00","piroi":"2.15","quantity":2}],"payments":[{"mode":"UPI","amount":"100000.00"}],"gross":{"grams":"35.420"}}'
    );
  });

  it('refuses a JS number in a money or weight field, at any depth, before any call is made', async () => {
    const { client, calls } = make(json(201, {}));
    const bodies: unknown[] = [
      { amount: 100000 },
      { amount: 100000.5 },
      { items: [{ metal_rate: 6920 }] },
      { payments: [{ mode: 'UPI', amount: 1 }] },
      { discount: 0 },
      { grams: 35.42 },
      { customer_net_weight: 12 },
      { fine_advance: 0 },
      { dues: 5 },
    ];
    for (const body of bodies) {
      await expect(client.post('/v1/x', body, WRITE)).rejects.toThrow(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses any number with a fraction, NaN or Infinity anywhere in a body, but lets whole counts through', async () => {
    const { client, calls } = make(json(201, {}));
    for (const body of [{ quantity: 1.5 }, { limit: Number.NaN }, { line_no: Infinity }]) {
      await expect(client.post('/v1/x', body, WRITE)).rejects.toThrow(TypeError);
    }
    await client.post('/v1/x', { quantity: 3, line_no: 1, pricing_version: 1 }, WRITE);
    expect(calls).toHaveLength(1);
  });

  it("does not look inside a settings value, which holds the owner's own JSON (0.72 is fine there)", async () => {
    const { client, calls } = make(json(200, {}));
    await client.put('/v1/settings/photos', {
      expected_updated_at: 't',
      value: { jpegQuality: 0.72, discount: 5 },
    });
    expect(calls).toHaveLength(1);
  });

  it('turns a money or weight number in an answer into an error: the API never sends one', async () => {
    const { client } = make(
      json(200, {
        rows: [{ id: 'b1', grand_total: 257612, item_count: 2 }],
        next: null,
        server_time: 't',
      })
    );
    const error = await failure(client.syncPage('bills'));
    expect(error.code).toBe('BAD_RESPONSE');
    expect(error.message).not.toMatch(/257612/); // no figure in the message
  });

  it('lets counts, strings and a settings value through in an answer', async () => {
    const page = {
      rows: [
        { id: 'b1', grand_total: '257612.00', fine_pending: '0.000', item_count: 2, quantity: 1 },
        { setting_key: 'taxes', value: { gstPercent: 0, discount: 0 } },
      ],
      next: null,
      server_time: 't',
    };
    const { client } = make(json(200, page));
    expect(await client.syncPage('bills')).toEqual(page);
  });
});

// ------------------------------------------------------------------------------------------------ errors and their messages

describe('PT-W1 api client: ApiError and the plain message of every code (C13, S8)', () => {
  it('carries the code, status, details and request id of the S8 body', async () => {
    const { client } = make(
      refusal('JV_OVERPAYMENT', 409, 'Too much.', { max: '10.00' }, { 'x-request-id': 'hdr-1' })
    );
    const error = await failure(
      client.post('/v1/customers/1/payments', { amount: '99.00' }, WRITE)
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('JV_OVERPAYMENT');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ max: '10.00' });
    expect(error.requestId).toBe('req-123');
    expect(error.nothingChanged).toBe(true);
    expect(error.unconfirmed).toBe(false);
  });

  it('has a plain message for every code of S8, none of them the code itself', () => {
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(23);
    for (const code of ERROR_CODES) {
      for (const write of [true, false]) {
        const message = plainMessage(code, { write });
        expect(message, code).toMatch(/^[A-Z].*[.]$/);
        expect(message, code).not.toMatch(/JV_/);
      }
    }
  });

  it('says that nothing was changed for a refusal before any write (a write only)', () => {
    for (const code of [
      'JV_OVERPAYMENT',
      'JV_PIECE_UNAVAILABLE',
      'JV_INVALID_INPUT',
      'JV_CASH_LIMIT',
      'JV_FINE_EXCEEDS',
      'JV_CUSTOMER_ARCHIVED',
      'JV_BILL_CANCELLED',
      'JV_ALREADY_VOID',
      'JV_NOT_ALLOWED',
      'JV_STALE',
    ]) {
      expect(plainMessage(code, { write: true }), code).toMatch(/nothing was changed/i);
      expect(plainMessage(code, { write: false }), code).not.toMatch(/nothing was changed/i);
    }
  });

  it("keeps the server's own sentence for JV_INVALID_INPUT, which names the input, and adds that nothing was changed", async () => {
    const { client } = make(
      refusal('JV_INVALID_INPUT', 422, 'Amount must have at most 2 decimals.', {
        field: 'items[0].piroi',
      })
    );
    const error = await failure(client.post('/v1/bills', { items: [] }, WRITE));
    expect(error.message).toBe('Amount must have at most 2 decimals. Nothing was changed.');
    expect(error.details).toEqual({ field: 'items[0].piroi' });
  });

  it('shows "Could not confirm that this was saved." for JV_INTERNAL and re-reads that customer\'s bills and receipts', async () => {
    const { client } = make(refusal('JV_INTERNAL', 500, 'internal detail that must not be shown'));
    const reread = vi.fn();
    client.onUnconfirmedSave(reread);
    const error = await failure(
      client.post('/v1/bills', { customer_id: 'c1' }, { ...WRITE, context: { customerId: 'c1' } })
    );
    expect(error.message).toBe('Could not confirm that this was saved.');
    expect(error.unconfirmed).toBe(true);
    expect(error.nothingChanged).toBe(false);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread.mock.calls[0][0]).toMatchObject({ customerId: 'c1', error });
  });

  it('treats a code it does not know like JV_INTERNAL', async () => {
    const { client } = make(refusal('JV_SOMETHING_NEW', 418));
    const error = await failure(client.post('/v1/x', {}, WRITE));
    expect(error.message).toBe('Could not confirm that this was saved.');
    expect(error.unconfirmed).toBe(true);
  });

  it('does not say "saved" for a read, and does not trigger the re-read', async () => {
    const { client } = make(refusal('JV_INTERNAL', 500));
    const reread = vi.fn();
    client.onUnconfirmedSave(reread);
    const error = await failure(client.syncPage('customers'));
    expect(error.message).not.toMatch(/saved/i);
    expect(error.unconfirmed).toBe(false);
    expect(reread).not.toHaveBeenCalled();
  });

  it('keeps the detail out of the message and writes only code, status and request id to the console', async () => {
    const { client } = make(refusal('JV_INTERNAL', 500, 'secret detail 9876543210'));
    const error = await failure(client.post('/v1/bills', { notes: 'private note' }, WRITE));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('JV_INTERNAL');
    expect(logged).toContain('req-123');
    expect(logged).not.toContain('private note');
    expect(logged).not.toContain('9876543210');
    expect(error.message).not.toContain('9876543210');
  });

  it('knows how long to wait after a JV_RATE_LIMITED', async () => {
    const { client } = make(
      refusal('JV_RATE_LIMITED', 429, 'Slow down.', {}, { 'retry-after': '37' })
    );
    const error = await failure(client.login('a@b.test', 'x'));
    expect(error.retryAfterS).toBe(37);
    expect(error.message).toMatch(/too many attempts/i);
  });
});

// ------------------------------------------------------------------------------------------------ JV_BUSY

describe('PT-W1 api client: a JV_BUSY is retried once with the same key (S8)', () => {
  it('retries once after Retry-After and returns the stored result when the retry works', async () => {
    const { client, calls, waits } = make(
      refusal('JV_BUSY', 503, 'Busy.', {}, { 'retry-after': '1' }),
      json(201, { customer: { id: 'c1' } })
    );
    const reread = vi.fn();
    client.onUnconfirmedSave(reread);
    await expect(client.post('/v1/customers', { name: 'A' }, WRITE)).resolves.toEqual({
      customer: { id: 'c1' },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
    expect(reread).not.toHaveBeenCalled();
  });

  it('gives up after the second JV_BUSY: unconfirmed, re-read, and no third try', async () => {
    const { client, calls } = make(refusal('JV_BUSY', 503, 'Busy.', {}, { 'retry-after': '1' }));
    const reread = vi.fn();
    client.onUnconfirmedSave(reread);
    const error = await failure(
      client.post('/v1/bills', {}, { ...WRITE, context: { customerId: 'c9' } })
    );
    expect(calls).toHaveLength(2);
    expect(error.code).toBe('JV_BUSY');
    expect(error.message).toBe('Could not confirm that this was saved.');
    expect(error.unconfirmed).toBe(true);
    expect(reread).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c9' }));
  });

  it('retries a read-only call once too, without any key, and says "busy" instead of "saved"', async () => {
    const { client, calls } = make(refusal('JV_BUSY', 503));
    const error = await failure(client.poll({ customers: null }));
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('idempotency-key')).toBeNull();
    expect(error.message).toMatch(/busy/i);
    expect(error.unconfirmed).toBe(false);
  });

  it('keeps the wait between 1 and 5 seconds whatever the header says', async () => {
    for (const [header, expected] of [
      [undefined, 1000],
      ['0', 1000],
      ['3', 3000],
      ['600', 5000],
      ['soon', 1000],
    ] as const) {
      const { client, waits } = make(
        refusal('JV_BUSY', 503, 'Busy.', {}, header === undefined ? {} : { 'retry-after': header }),
        json(200, {})
      );
      await client.get('/v1/x');
      expect(waits, String(header)).toEqual([expected]);
    }
  });
});

// ------------------------------------------------------------------------------------------------ Waking up and offline

describe('PT-W1 api client: "Waking up" and the back-off (C7)', () => {
  it('backs off 1, 2, 4, 8 and 15 seconds: 30 seconds in all', () => {
    expect([...WAKING_BACKOFF_MS]).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(WAKING_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(30_000);
  });

  it('says "Waking up…" for the one banner and "Offline: changes cannot be saved" for the other, in the words of C7', () => {
    expect(CONNECTION_BANNER).toEqual({
      ok: null,
      waking: 'Waking up…',
      offline: 'Offline: changes cannot be saved',
    });
  });

  it('a gateway error or a reply that is not JSON shows "Waking up", retries, and a success clears the banner', async () => {
    const { client, calls, waits } = make(
      html(502),
      html(503),
      new Response('Welcome', { status: 200, headers: { 'content-type': 'text/plain' } }),
      json(200, { user: { id: 'u1' } })
    );
    const seen: string[] = [];
    client.subscribeConnection(() => seen.push(client.getConnectionStatus()));
    await expect(client.get('/v1/auth/me')).resolves.toEqual({ user: { id: 'u1' } });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(seen).toEqual(['waking', 'ok']); // listeners hear a change once, not once per retry
    expect(client.getConnectionStatus()).toBe('ok');
  });

  it('treats 504 and a JSON body that is not an S8 body from a gateway the same way', async () => {
    const { client, calls } = make(
      html(504),
      json(502, { message: 'Bad gateway' }),
      json(200, { ok: true })
    );
    await client.get('/v1/x');
    expect(calls).toHaveLength(3);
  });

  it('keeps the key of a money call through every retry, then gives up after 30 seconds and does not confirm the save', async () => {
    const { client, calls, waits } = make(html(502));
    const reread = vi.fn();
    client.onUnconfirmedSave(reread);
    const error = await failure(
      client.post('/v1/bills', { customer_id: 'c1' }, { ...WRITE, context: { customerId: 'c1' } })
    );
    expect(calls).toHaveLength(6); // the first try and five retries
    expect(waits).toEqual([1000, 2000, 4000, 8000, 15000]);
    expect(new Set(calls.map((c) => c.headers.get('idempotency-key'))).size).toBe(1);
    expect(error.code).toBe('GATEWAY');
    expect(error.status).toBe(502);
    expect(error.message).toBe('Could not confirm that this was saved.');
    expect(error.unconfirmed).toBe(true);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(client.getConnectionStatus()).toBe('waking'); // stays until one call works
  });

  it('a read that cannot get through says the server is not answering, not "saved"', async () => {
    const { client } = make(html(503));
    const error = await failure(client.get('/v1/x'));
    expect(error.code).toBe('GATEWAY');
    expect(error.message).not.toMatch(/saved/i);
    expect(error.message).toMatch(/server/i);
  });

  it('a 503 with a JV_ body is the API talking, not a gateway: JV_UNAVAILABLE is shown, not retried', async () => {
    const { client, calls } = make(refusal('JV_UNAVAILABLE', 503));
    const error = await failure(client.get('/v1/x'));
    expect(calls).toHaveLength(1);
    expect(error.code).toBe('JV_UNAVAILABLE');
    expect(error.message).toBe('Cannot reach the server. Try again in a minute.');
  });

  it('an empty 204 is a success, not a sleeping server', async () => {
    const { client, calls } = make(new Response(null, { status: 204 }));
    await expect(client.post('/v1/x', undefined, { readOnly: true })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('PT-W1 api client: offline (C7)', () => {
  it('a network failure says offline at once (no retry inside the client) and the next good answer clears it', async () => {
    const { client, calls } = make(new TypeError('Failed to fetch'), json(200, { ok: true }));
    const error = await failure(client.get('/v1/x'));
    expect(calls).toHaveLength(1);
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
    expect(client.getConnectionStatus()).toBe('offline');
    await client.get('/v1/x');
    expect(client.getConnectionStatus()).toBe('ok');
  });

  it('a write that dies on the network is unconfirmed, with its key on the error', async () => {
    const { client } = make(new TypeError('Failed to fetch'));
    const error = await failure(client.post('/v1/bills', {}, WRITE));
    expect(error.unconfirmed).toBe(true);
    expect(error.message).toMatch(/could not confirm that this was saved/i);
    expect(error.idempotencyKey).toMatch(UUID_V4);
  });

  it('a call that hangs is cut after the time limit and counts as the network', async () => {
    vi.useFakeTimers();
    const hang = (call: Call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    const stubbed = stub(hang);
    const client = createApiClient({ baseUrl: BASE, fetch: stubbed.fetch, timeoutMs: 5_000 });
    const outcome = failure(client.get('/v1/x'));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await outcome;
    expect(error.code).toBe('NETWORK');
    expect(error.details).toMatchObject({ reason: 'timeout' });
  });

  it('a call the caller aborts is not an error of the server: the abort goes through and the banner is left alone', async () => {
    const controller = new AbortController();
    const hang = (call: Call) =>
      new Promise<Response>((_resolve, reject) => {
        call.init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    const stubbed = stub(hang);
    const client = createApiClient({ baseUrl: BASE, fetch: stubbed.fetch });
    const outcome = client.get('/v1/x', { signal: controller.signal });
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.getConnectionStatus()).toBe('ok');
  });
});

describe('PT-W1 api client: polling back-off (C7)', () => {
  it('waits 8 seconds between polls, then 8, 16 and 30 seconds after failures, and stays at 30', () => {
    expect([...POLL_BACKOFF_MS]).toEqual([8000, 16000, 30000]);
    expect([0, 1, 2, 3, 4, 50].map(nextPollDelayMs)).toEqual([
      8000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ pricing hash

describe("PT-W1 api client: the pricing hash of `me` against the build's own (C12)", () => {
  const me = (hash: string | null) =>
    json(200, {
      user: {
        id: 'u1',
        email: 'a@b.test',
        full_name: 'A',
        role: 'owner',
        must_change_password: false,
      },
      idle_timeout_s: 43200,
      absolute_expires_at: '2026-10-16T00:00:00.000000Z',
      pricing_sha256: hash,
    });

  it("the build's hash is the SHA-256 of src/lib/pricing.ts as it is in this repository", () => {
    const bytes = readFileSync(path.join(root, 'src/lib/pricing.ts'));
    expect(BUILD_PRICING_SHA256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('the committed file is exactly what scripts/pricing-hash.mjs writes (npm run pricing:hash)', () => {
    expect(syncPricingHash({ check: true })).toEqual({
      sha256: BUILD_PRICING_SHA256,
      upToDate: true,
      written: false,
    });
  });

  it('a changed pricing.ts makes the committed hash stale, and the script (which `npm run build` runs first) writes the new one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'jv-pricing-hash-'));
    try {
      mkdirSync(path.join(root, 'src/lib/api'), { recursive: true });
      writeFileSync(path.join(root, PRICING_FILE), 'export const A = 1;\n');
      expect(syncPricingHash({ root, check: true }).upToDate).toBe(false); // no file yet
      const first = syncPricingHash({ root });
      expect(first).toMatchObject({ upToDate: false, written: true });
      expect(syncPricingHash({ root, check: true }).upToDate).toBe(true);
      expect(readFileSync(path.join(root, HASH_FILE), 'utf8')).toContain(first.sha256);

      writeFileSync(path.join(root, PRICING_FILE), 'export const A = 2;\n'); // one byte of pricing changed
      expect(syncPricingHash({ root, check: true }).upToDate).toBe(false);
      const second = syncPricingHash({ root });
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.written).toBe(true);
      expect(syncPricingHash({ root, check: true }).upToDate).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is unknown before `me`, a match when the API's hash is the build's, and Save stays allowed", async () => {
    const { client } = make(me(BUILD_PRICING_SHA256));
    expect(client.getPricingCheck().state).toBe('unknown');
    await client.me();
    expect(client.getPricingCheck()).toEqual({ state: 'match' });
  });

  it('is a mismatch when the hashes differ, when the API sends none, and says so (Save on bills is disabled)', async () => {
    for (const hash of ['0'.repeat(64), null]) {
      const { client } = make(me(hash));
      const heard = vi.fn();
      client.subscribePricing(heard);
      await client.me();
      const check = client.getPricingCheck();
      expect(check.state).toBe('mismatch');
      expect(client.savingBillsAllowed()).toBe(false);
      expect(heard).toHaveBeenCalledTimes(1);
    }
  });

  it('saving bills is allowed only after a match', async () => {
    const { client } = make(me(BUILD_PRICING_SHA256.toUpperCase()));
    expect(client.savingBillsAllowed()).toBe(false); // not yet known: not allowed
    await client.me();
    expect(client.savingBillsAllowed()).toBe(true); // a hash in capitals is still the same hash
  });
});

// ------------------------------------------------------------------------------------------------ the 401 hook

describe('PT-W1 api client: the 401 hook (U6)', () => {
  it('runs the hook for JV_UNAUTHENTICATED and JV_SESSION_EXPIRED, once per call, and still throws', async () => {
    for (const code of ['JV_UNAUTHENTICATED', 'JV_SESSION_EXPIRED']) {
      const { client } = make(refusal(code, 401));
      const hook = vi.fn();
      client.onUnauthorized(hook);
      const error = await failure(client.get('/v1/auth/me'));
      expect(error.status).toBe(401);
      expect(error.code).toBe(code);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toBe(error);
    }
  });

  it("does not run it for a wrong password (JV_BAD_LOGIN is the login screen's own answer) or for a 403", async () => {
    const hook = vi.fn();
    for (const reply of [refusal('JV_BAD_LOGIN', 401), refusal('JV_FORBIDDEN', 403)]) {
      const { client } = make(reply);
      client.onUnauthorized(hook);
      await failure(client.login('a@b.test', 'x'));
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('an unregistered hook is not called, and a hook that throws neither hides the error nor stops the next hook', async () => {
    const { client } = make(refusal('JV_UNAUTHENTICATED', 401));
    const gone = vi.fn();
    client.onUnauthorized(gone)();
    client.onUnauthorized(() => {
      throw new Error('hook bug');
    });
    const next = vi.fn();
    client.onUnauthorized(next);
    const error = await failure(client.get('/v1/x'));
    expect(error.code).toBe('JV_UNAUTHENTICATED');
    expect(next).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
  });

  it('a 401 is not retried', async () => {
    const { client, calls } = make(refusal('JV_SESSION_EXPIRED', 401), json(200, {}));
    await failure(client.post('/v1/auth/activity'));
    expect(calls).toHaveLength(1);
  });

  it('the account that is not active comes through as JV_FORBIDDEN with its reason, in plain words', async () => {
    const { client } = make(
      refusal('JV_FORBIDDEN', 403, 'Your account is not active.', { reason: 'inactive' })
    );
    const error = await failure(client.login('a@b.test', 'x'));
    expect(error.details).toEqual({ reason: 'inactive' });
    expect(error.message).toBe('Your account is not active. Ask the owner to activate it.');
  });
});

// ------------------------------------------------------------------------------------------------ nothing stored (C8)

describe('PT-W1 api client: no business data is stored in the browser (C8)', () => {
  it('the client never names localStorage, sessionStorage, IndexedDB or document.cookie', () => {
    for (const file of ['client.ts', 'types.ts', 'pricingHash.ts']) {
      const text = readFileSync(path.join(root, 'src/lib/api', file), 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) names.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'caches']) {
        expect(names, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('is only built from what the build allows: NEXT_PUBLIC_API_URL is the one variable read', () => {
    const text = readFileSync(path.join(root, 'src/lib/api/client.ts'), 'utf8');
    const reads = [...text.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(reads)]).toEqual(['NEXT_PUBLIC_API_URL']);
  });
});

// A type-level guard that the client object has the shape the next tasks lean on.
const _shape = (client: ApiClient) => [
  client.get,
  client.post,
  client.put,
  client.patch,
  client.request,
];
void _shape;

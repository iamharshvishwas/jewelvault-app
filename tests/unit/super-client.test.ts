// Access and roles (Task 22): the website's calls to the Super Admin's API, `/v1/super/...` (plan: Tasks 12 to 14 for the API, Task 22 for this side), with a stubbed `fetch`.
//   - the twelve calls: the address and the method of each, `X-JV-Client: web` on every write, a JSON body that is exactly what the screen gave, and none on a read;
//   - the Super Admin's own password is asked again for every write (R9): it travels in the body and nowhere else (never in the address, never in a header), and it is in
//     no message, no log line and no error of a call that failed;
//   - the words of a refusal of such a write: a wrong password, the pause after five wrong ones, a role changed by someone else, and the API's own sentence for the rest.
//     They belong to the writes that carry the password: the same refusal on any other call keeps the words it always had.
//
// The passwords of these tests are made up as the tests start and never printed.
//
// Run: npm test -- tests/unit/super-client.test.ts
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError, createApiClient, type ApiClient } from '@/lib/api/client';
import { plainMessage } from '@/lib/api/errorMap';

const BASE = 'https://api.example.test';

// ------------------------------------------------------------------------------------------------ the stub

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
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) => json(status, { error: { code, message, details }, request_id: 'req-super-1' }, headers);

function make(...replies: Array<Response | Error>) {
  const calls: Call[] = [];
  const stubbed = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      init,
    });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next === undefined) throw new Error('the stub has no reply');
    if (next instanceof Error) throw next;
    return next.clone();
  });
  const client = createApiClient({
    baseUrl: BASE,
    fetch: stubbed as unknown as typeof globalThis.fetch,
    sleep: async () => undefined,
  });
  return { client, calls };
}

/** The ApiError of a call that should be refused, or a failed test. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

/** The console of the test: nothing a call prints may hold the password, so every line it prints is kept and read back. */
let printed: MockInstance[];
beforeEach(() => {
  printed = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  ];
});
afterEach(() => {
  for (const spy of printed) spy.mockRestore();
});
const everythingPrinted = () => JSON.stringify(printed.flatMap((spy) => spy.mock.calls));

/** A made-up password: unique to the test, so that finding it anywhere is a leak and not a coincidence. */
const madeUpPassword = () => `pw-${randomUUID()}`;

// ------------------------------------------------------------------------------------------------ what the screens send

const PERSON_ID = '3f1c2a54-9b1e-4c58-8a77-0d5e2f6b7c11';
const STAMP = '2026-11-19T07:41:12.123456Z';

const person = {
  id: PERSON_ID,
  full_name: 'Anita Sharma',
  email: 'anita@example.com',
  role: 'cashier',
  role_name: 'Cashier',
  active: true,
  is_super_admin: false,
  last_login_at: null,
  updated_at: STAMP,
};
const role = {
  key: 'cashier',
  name: 'Cashier',
  description: 'Makes bills and takes payments',
  active: true,
  fixed: false,
  ticks: ['customer_view', 'bill_view', 'bill_make'],
  people: 3,
  updated_at: STAMP,
};

function write<B>(
  name: string,
  method: string,
  path: string,
  body: (password: string) => B,
  call: (client: ApiClient, body: B) => Promise<unknown>,
  answer: unknown
) {
  return {
    name,
    method,
    path,
    answer,
    body: body as (password: string) => unknown,
    run: (client: ApiClient, password: string) => call(client, body(password)),
  };
}

/** The nine writes, each with the body its screen builds (the contract of the plan, Tasks 13 and 14, as the brief of Task 22 lists them). */
const WRITES = [
  write(
    'superAddPerson',
    'POST',
    '/v1/super/people',
    (password) => ({
      full_name: 'Anita Sharma',
      email: 'anita@example.com',
      role: 'cashier',
      password,
    }),
    (client, body) => client.superAddPerson(body),
    { person, temporary_password: 'Temp-Word-1234' }
  ),
  write(
    'superEditPerson',
    'PATCH',
    `/v1/super/people/${PERSON_ID}`,
    (password) => ({ changes: { full_name: 'Anita S', email: 'anita.s@example.com' }, password }),
    (client, body) => client.superEditPerson(PERSON_ID, body),
    { person }
  ),
  write(
    'superSetPersonRole',
    'POST',
    `/v1/super/people/${PERSON_ID}/role`,
    (password) => ({ role: 'staff', password }),
    (client, body) => client.superSetPersonRole(PERSON_ID, body),
    { person }
  ),
  write(
    'superSetPersonActive',
    'POST',
    `/v1/super/people/${PERSON_ID}/active`,
    (password) => ({ active: false, password }),
    (client, body) => client.superSetPersonActive(PERSON_ID, body),
    { person }
  ),
  write(
    'superResetPassword',
    'POST',
    `/v1/super/people/${PERSON_ID}/reset-password`,
    (password) => ({ password }),
    (client, body) => client.superResetPassword(PERSON_ID, body),
    { person, temporary_password: 'Temp-Word-5678', sessions_ended: 2 }
  ),
  write(
    'superCreateRole',
    'POST',
    '/v1/super/roles',
    (password) => ({ copy_of: 'biller', name: 'Cashier', description: 'Takes payments', password }),
    (client, body) => client.superCreateRole(body),
    { role }
  ),
  write(
    'superEditRole',
    'PATCH',
    '/v1/super/roles/cashier',
    (password) => ({
      expected_updated_at: STAMP,
      changes: { name: 'Till', description: 'At the till' },
      password,
    }),
    (client, body) => client.superEditRole('cashier', body),
    { role }
  ),
  write(
    'superSetRoleTicks',
    'PUT',
    '/v1/super/roles/cashier/ticks',
    (password) => ({
      expected_updated_at: STAMP,
      ticks: ['customer_view', 'bill_view', 'cashbook_recent', 'cashbook_all'] as const,
      password,
    }),
    (client, body) => client.superSetRoleTicks('cashier', { ...body, ticks: [...body.ticks] }),
    { role }
  ),
  write(
    'superSetRoleActive',
    'POST',
    '/v1/super/roles/cashier/active',
    (password) => ({ expected_updated_at: STAMP, active: false, password }),
    (client, body) => client.superSetRoleActive('cashier', body),
    { role }
  ),
];

const TICKS = {
  groups: ['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop'],
  ticks: [
    {
      key: 'customer_edit',
      group: 'Money',
      label: 'Add and edit customers',
      help: null,
      sensitive: false,
      needs: ['customer_view'],
    },
  ],
};

describe('the reads: GET, nothing sent, the answer as the API gave it', () => {
  it.each([
    ['superTicks', '/v1/super/ticks', TICKS],
    ['superPeople', '/v1/super/people', { people: [person] }],
    ['superRoles', '/v1/super/roles', { roles: [role] }],
  ] as const)('%s is GET %s', async (name, path, answer) => {
    const { client, calls } = make(json(200, answer));
    const got = await client[name]();
    expect(got).toEqual(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`${BASE}${path}`);
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers.has('x-jv-client')).toBe(false);
    expect(calls[0].headers.has('content-type')).toBe(false);
    expect(calls[0].init.credentials).toBe('include');
  });
});

describe('the nine writes: the address, X-JV-Client: web and the JSON body of the screen', () => {
  it.each(WRITES)('$name sends $method $path', async (one) => {
    const { client, calls } = make(json(200, one.answer));
    const password = madeUpPassword();
    const got = await one.run(client, password);
    expect(got).toEqual(one.answer);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(one.method);
    expect(calls[0].url).toBe(`${BASE}${one.path}`);
    expect(calls[0].headers.get('x-jv-client')).toBe('web');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? 'null')).toEqual(one.body(password));
  });

  it('superSetRoleTicks sends PUT /v1/super/roles/<key>/ticks with the JSON body and X-JV-Client: web', async () => {
    const { client, calls } = make(json(200, { role }));
    const password = madeUpPassword();
    await client.superSetRoleTicks('night-shift', {
      expected_updated_at: STAMP,
      ticks: ['customer_view', 'bill_view'],
      password,
    });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`${BASE}/v1/super/roles/night-shift/ticks`);
    expect(calls[0].headers.get('x-jv-client')).toBe('web');
    expect(JSON.parse(calls[0].body ?? 'null')).toEqual({
      expected_updated_at: STAMP,
      ticks: ['customer_view', 'bill_view'],
      password,
    });
  });

  it('every write carries `password` in the body and never in the address or in a header', async () => {
    expect(WRITES).toHaveLength(9);
    for (const one of WRITES) {
      const { client, calls } = make(json(200, one.answer));
      const password = madeUpPassword();
      await one.run(client, password);
      const body = JSON.parse(calls[0].body ?? 'null') as { password?: string };
      expect(body.password, one.name).toBe(password);
      expect(calls[0].url, one.name).not.toContain(password);
      expect(decodeURIComponent(calls[0].url), one.name).not.toContain(password);
      expect([...calls[0].headers.entries()].join('|'), one.name).not.toContain(password);
      expect(calls[0].url, one.name).not.toContain('?');
      // the one body is the one place: it holds the password once
      expect(calls[0].body?.split(password).length, one.name).toBe(2);
    }
  });

  it('puts an id or a key in the address as ONE path part, so that it cannot lead to another route', async () => {
    const { client, calls } = make(json(200, { person }), json(200, { role }));
    await client.superSetPersonRole('a/../b?x=1', { role: 'staff', password: madeUpPassword() });
    await client.superSetRoleActive('x/ticks', {
      expected_updated_at: STAMP,
      active: true,
      password: madeUpPassword(),
    });
    expect(calls[0].url).toBe(`${BASE}/v1/super/people/a%2F..%2Fb%3Fx%3D1/role`);
    expect(calls[1].url).toBe(`${BASE}/v1/super/roles/x%2Fticks/active`);
  });

  it('sends no Idempotency-Key (these are not functions of section 10) and sends the cookie', async () => {
    const { client, calls } = make(json(200, { role }));
    await client.superSetRoleActive('cashier', {
      expected_updated_at: STAMP,
      active: true,
      password: madeUpPassword(),
    });
    expect(calls[0].headers.has('idempotency-key')).toBe(false);
    expect(calls[0].init.credentials).toBe('include');
  });

  it('a write that was made is followed by the poll at once (a role change moves the access text); a read is not', async () => {
    const { client } = make(json(200, { people: [] }), json(200, { role }));
    const done = vi.fn();
    client.onWriteFinished(done);
    await client.superPeople();
    expect(done).not.toHaveBeenCalled();
    await client.superSetRoleActive('cashier', {
      expected_updated_at: STAMP,
      active: true,
      password: madeUpPassword(),
    });
    expect(done).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------------ the words of a refusal

const STALE_WORDS = 'This was changed by someone else. Reload and try again.';

describe('a write that carries the password is refused: the words', () => {
  const password = madeUpPassword();
  const attempt = (client: ApiClient) =>
    client.superSetRoleTicks('cashier', {
      expected_updated_at: STAMP,
      ticks: ['customer_view'],
      password,
    });

  it('a 422 on `password` reads "Your password is not correct."', async () => {
    const { client } = make(
      refusal(422, 'JV_INVALID_INPUT', 'password is not correct', { field: 'password' })
    );
    const error = await failure(attempt(client));
    expect(error.message).toBe('Your password is not correct.');
    expect(error.code).toBe('JV_INVALID_INPUT');
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ field: 'password' });
    // nothing was written, so the screen need not read again
    expect(error.nothingChanged).toBe(true);
    expect(error.unconfirmed).toBe(false);
  });

  it('a wrong password is never taken for the end of the session: the hook of the session gate does not run', async () => {
    const { client } = make(
      refusal(422, 'JV_INVALID_INPUT', 'password is not correct', { field: 'password' })
    );
    const gate = vi.fn();
    client.onUnauthorized(gate);
    await failure(attempt(client));
    expect(gate).not.toHaveBeenCalled();
  });

  it('a 401 (the session really ended) still runs the hook of the session gate', async () => {
    const { client } = make(refusal(401, 'JV_UNAUTHENTICATED', 'Sign in'));
    const gate = vi.fn();
    client.onUnauthorized(gate);
    await failure(attempt(client));
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('a 429 with `Retry-After: 900` reads "Too many wrong passwords. Try again in 15 minutes."', async () => {
    const { client } = make(
      refusal(429, 'JV_RATE_LIMITED', 'Too many tries', {}, { 'Retry-After': '900' })
    );
    const error = await failure(attempt(client));
    expect(error.message).toBe('Too many wrong passwords. Try again in 15 minutes.');
    expect(error.retryAfterS).toBe(900);
    expect(error.nothingChanged).toBe(true);
  });

  it('the wait is in whole minutes, rounded up, and "1 minute" is not "1 minutes"', async () => {
    const minutes = async (seconds: string) => {
      const { client } = make(refusal(429, 'JV_RATE_LIMITED', 'x', {}, { 'Retry-After': seconds }));
      return (await failure(attempt(client))).message;
    };
    expect(await minutes('61')).toBe('Too many wrong passwords. Try again in 2 minutes.');
    expect(await minutes('60')).toBe('Too many wrong passwords. Try again in 1 minute.');
    expect(await minutes('1')).toBe('Too many wrong passwords. Try again in 1 minute.');
    expect(await minutes('840')).toBe('Too many wrong passwords. Try again in 14 minutes.');
  });

  it('a 429 that names no wait says "a few minutes"', async () => {
    const unusable: Array<Record<string, string>> = [
      {},
      { 'Retry-After': 'soon' },
      { 'Retry-After': '0' },
    ];
    for (const headers of unusable) {
      const { client } = make(refusal(429, 'JV_RATE_LIMITED', 'x', {}, headers));
      expect((await failure(attempt(client))).message, JSON.stringify(headers)).toBe(
        'Too many wrong passwords. Try again in a few minutes.'
      );
    }
  });

  it('each of the nine writes has these words: each of them carries the password', async () => {
    for (const one of WRITES) {
      const wrong = make(
        refusal(422, 'JV_INVALID_INPUT', 'password is not correct', { field: 'password' })
      );
      expect((await failure(one.run(wrong.client, password))).message, one.name).toBe(
        'Your password is not correct.'
      );
      const paused = make(refusal(429, 'JV_RATE_LIMITED', 'x', {}, { 'Retry-After': '900' }));
      expect((await failure(one.run(paused.client, password))).message, one.name).toBe(
        'Too many wrong passwords. Try again in 15 minutes.'
      );
      const stale = make(refusal(409, 'JV_STALE', 'x'));
      expect((await failure(one.run(stale.client, password))).message, one.name).toBe(STALE_WORDS);
    }
  });

  it('JV_STALE reads "This was changed by someone else. Reload and try again." and keeps what the API sent of the role', async () => {
    const { client } = make(refusal(409, 'JV_STALE', 'The role was changed', { current: role }));
    const error = await failure(attempt(client));
    expect(error.message).toBe(STALE_WORDS);
    expect(error.details).toEqual({ current: role });
    expect(error.nothingChanged).toBe(true);
  });

  it("every other refusal shows the API's own sentence", async () => {
    const sentences: Array<[Response, string]> = [
      [
        refusal(409, 'JV_NOT_ALLOWED', 'The Owner role is fixed and cannot be changed.'),
        'The Owner role is fixed and cannot be changed.',
      ],
      [
        refusal(409, 'JV_NOT_ALLOWED', 'A Super Admin login is managed in the terminal.'),
        'A Super Admin login is managed in the terminal.',
      ],
      [
        refusal(422, 'JV_INVALID_INPUT', 'name is already used by another role', {
          field: 'name',
        }),
        'name is already used by another role.',
      ],
      [
        refusal(
          422,
          'JV_INVALID_INPUT',
          '“Cancel a bill” also needs “See customers (name, phone, address, GST)”.',
          { field: 'ticks' }
        ),
        '“Cancel a bill” also needs “See customers (name, phone, address, GST)”.',
      ],
    ];
    for (const [reply, sentence] of sentences) {
      const { client } = make(reply);
      const error = await failure(attempt(client));
      expect(error.message).toContain(sentence);
      expect(error.message).not.toContain('JV_');
    }
  });

  it('a refusal of the door and a lost answer keep the words they have everywhere else', async () => {
    const forbidden = make(refusal(403, 'JV_FORBIDDEN', 'no'));
    expect((await failure(attempt(forbidden.client))).message).toBe(
      'You are not allowed to do this. Nothing was changed.'
    );
    const broken = make(refusal(500, 'JV_INTERNAL', 'boom'));
    const lost = await failure(attempt(broken.client));
    expect(lost.message).toBe('Could not confirm that this was saved.');
    expect(lost.unconfirmed).toBe(true);
  });
});

describe('the same refusals on a call that does not carry the password keep their old words', () => {
  it("a 422 on a field called `password` of another call is that call's sentence, not the Super Admin's", async () => {
    const { client } = make(
      refusal(422, 'JV_INVALID_INPUT', 'password must be at most 200 characters', {
        field: 'password',
      })
    );
    const error = await failure(client.post('/v1/anything', { password: 'x' }));
    expect(error.message).toBe('password must be at most 200 characters. Nothing was changed.');
  });

  it('JV_STALE of an ordinary edit still says the latest version has been loaded', async () => {
    const { client } = make(refusal(409, 'JV_STALE', 'stale'));
    const error = await failure(client.patch('/v1/designs/x', { changes: {} }));
    expect(error.message).toBe(
      'This was changed by someone else. The latest version has been loaded. Nothing was changed.'
    );
  });

  it('a 429 on a read of People & Roles is the general one: no password was asked for', async () => {
    const { client } = make(
      refusal(429, 'JV_RATE_LIMITED', 'slow down', {}, { 'Retry-After': '900' })
    );
    const error = await failure(client.superPeople());
    expect(error.message).toBe('Too many attempts. Wait a minute and try again.');
  });

  it('plainMessage: the words of a password write are chosen by the option, not by the code alone', () => {
    const asked = { write: true, confirmsPassword: true } as const;
    expect(plainMessage('JV_INVALID_INPUT', { ...asked, details: { field: 'password' } })).toBe(
      'Your password is not correct.'
    );
    expect(plainMessage('JV_INVALID_INPUT', { write: true, details: { field: 'password' } })).toBe(
      'Something you entered is not accepted. Nothing was changed.'
    );
    expect(plainMessage('JV_STALE', asked)).toBe(STALE_WORDS);
    expect(plainMessage('JV_RATE_LIMITED', { ...asked, retryAfterS: 900 })).toBe(
      'Too many wrong passwords. Try again in 15 minutes.'
    );
    for (const retryAfterS of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(plainMessage('JV_RATE_LIMITED', { ...asked, retryAfterS }), String(retryAfterS)).toBe(
        'Too many wrong passwords. Try again in a few minutes.'
      );
    }
  });
});

// ------------------------------------------------------------------------------------------------ the password goes nowhere else

describe('the password is in no message, no log line and no error of a call that failed', () => {
  const outcomes: Array<[string, Array<Response | Error>]> = [
    [
      'a wrong password',
      [refusal(422, 'JV_INVALID_INPUT', 'password is not correct', { field: 'password' })],
    ],
    ['the pause', [refusal(429, 'JV_RATE_LIMITED', 'paused', {}, { 'Retry-After': '900' })]],
    ['a stale role', [refusal(409, 'JV_STALE', 'stale', { current: role })]],
    ['a refusal of a rule', [refusal(409, 'JV_NOT_ALLOWED', 'The Owner role is fixed.')]],
    ['a server error', [refusal(500, 'JV_INTERNAL', 'boom')]],
    ['a code nobody knows', [refusal(500, 'JV_FROM_THE_FUTURE', 'new')]],
    ['no answer at all', [new TypeError('fetch failed')]],
    [
      'a page that is not JSON, again and again',
      [new Response('<html>down</html>', { status: 503 })],
    ],
  ];

  it.each(outcomes)('%s', async (_name, replies) => {
    const { client } = make(...replies);
    const password = madeUpPassword();
    const error = await failure(
      client.superSetRoleTicks('cashier', { expected_updated_at: STAMP, ticks: [], password })
    );
    expect(error.message).not.toContain(password);
    expect(String(error)).not.toContain(password);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(password);
    expect(everythingPrinted()).not.toContain(password);
  });
});

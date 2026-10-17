// WEB02: the session gate on the API. U5 (the role that `me` returns decides which routes and menu items exist), U6 (any 401 empties
// memory, stops the pollers and shows the login screen once; a 403 from the poll calls `me` once), U7 (one gate, `useSession`), U8
// (logout runs every cache-emptying and poller-stopping hook), C16 (the idle logout) and C18, as the unit halves of T-E01 and T-E08.
// The screens-by-role table of spec section 1.3 is written out here, one row per route, so a change to the table in
// src/lib/authStore.ts has to change this file too. The database is the real wall (section 3); this table only decides what the screen
// offers. The browser halves are tests/e2e/login.spec.ts.
//
// The store is built the way the site builds it, over the REAL API client (src/lib/api/client.ts) with a stubbed `fetch`, so the 401 hook,
// the plain messages ("Your account is not active") and the rule that a call without a body sends none are the real ones. Time is faked.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import {
  IDLE_LIMIT_MS,
  IDLE_NOTICE,
  canAccessPath,
  createSessionStore,
  getSessionState,
  initialsOf,
  isIdle,
  registerLogoutHook,
  signOut,
  type AuthRole,
  type SessionHost,
} from '@/lib/authStore';

const ALL: AuthRole[] = ['owner', 'biller', 'staff'];

// [route, roles that may open it]
const SCREENS: Array<[string, AuthRole[]]> = [
  ['/', ALL],
  ['/billing-pos', ['owner', 'biller']],
  ['/estimate', ['owner', 'biller']],
  ['/customer-ledger', ['owner', 'biller']],
  ['/inventory-management', ALL],
  ['/design-detail', ALL],
  ['/print-tags', ALL],
  ['/add-design', ['owner', 'staff']],
  ['/edit-stock', ['owner', 'staff']],
  ['/reports', ['owner']],
  ['/settings', ['owner']],
  // "hidden in M1" for every role (section 1.3, C15)
  ['/order-book', []],
  ['/catalogue', []],
  ['/customer-catalogue', []],
  // not in the table of 1.3: kept as the prototype had it (the owner only)
  ['/scan-detail', ['owner']],
];

describe('the screens by role (spec 1.3)', () => {
  for (const [route, allowed] of SCREENS) {
    for (const role of ALL) {
      const expected = allowed.includes(role);
      it(`${role} ${expected ? 'may' : 'may not'} open ${route}`, () => {
        expect(canAccessPath(role, route)).toBe(expected);
      });
    }
  }

  it('a person with no role opens nothing, not even the dashboard', () => {
    expect(canAccessPath(null, '/')).toBe(false);
    expect(canAccessPath(null, '/inventory-management')).toBe(false);
  });

  it('a route that is not in the table is closed to everybody', () => {
    for (const role of ALL) expect(canAccessPath(role, '/no-such-screen')).toBe(false);
  });

  it('a route that only starts with a listed name is not that route', () => {
    expect(canAccessPath('staff', '/edit-stock-everything')).toBe(false);
    expect(canAccessPath('biller', '/billing-pos-admin')).toBe(false);
    expect(canAccessPath('owner', '/settingsx')).toBe(false);
  });

  it('a trailing slash and a query do not change the answer', () => {
    expect(canAccessPath('biller', '/billing-pos/')).toBe(true);
    expect(canAccessPath('staff', '/reports/')).toBe(false);
    expect(canAccessPath('owner', '/settings?tab=users')).toBe(true);
    expect(canAccessPath('biller', '/settings?tab=users')).toBe(false);
  });

  it('a sub-path of a listed route follows the listed route', () => {
    expect(canAccessPath('staff', '/inventory-management/anything')).toBe(true);
    expect(canAccessPath('staff', '/customer-ledger/anything')).toBe(false);
  });
});

describe('the idle logout (U4, C16): the rule', () => {
  const START = Date.UTC(2026, 9, 15, 8, 0, 0);
  const HOUR = 60 * 60 * 1000;

  it('is 12 hours', () => {
    expect(IDLE_LIMIT_MS).toBe(12 * HOUR);
  });

  it('does not end a session before 12 hours', () => {
    expect(isIdle(START + 11 * HOUR + 59 * 60 * 1000 + 59_000, START)).toBe(false);
    expect(isIdle(START, START)).toBe(false);
  });

  it('ends a session at 12 hours and after', () => {
    expect(isIdle(START + 12 * HOUR, START)).toBe(true);
    expect(isIdle(START + 30 * HOUR, START)).toBe(true);
  });

  it('measures from the last click or key press, not from the login', () => {
    const lastClick = START + 10 * HOUR;
    expect(isIdle(START + 12 * HOUR, lastClick)).toBe(false);
    expect(isIdle(lastClick + 12 * HOUR, lastClick)).toBe(true);
  });
});

describe('the initials on the avatar', () => {
  it('are the first letters of the first and the last word', () => {
    expect(initialsOf('Siddhi Jaishri Gold')).toBe('SG');
    expect(initialsOf('Test owner')).toBe('TO');
    expect(initialsOf('  mira ')).toBe('M');
    expect(initialsOf('')).toBe('?');
  });
});

// ------------------------------------------------------------------------------------------------ the world of the store tests

const BASE = 'https://api.example.test';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const refusal = (code: string, status: number, message = 'no.', details = {}) =>
  json(status, { error: { code, message, details }, request_id: 'req-1' });

interface TestUser {
  id: string;
  email: string;
  full_name: string;
  role: AuthRole;
  must_change_password: boolean;
}
const userOf = (role: AuthRole, extra: Partial<TestUser> = {}): TestUser => ({
  id: `00000000-0000-4000-8000-00000000000${ALL.indexOf(role) + 1}`,
  email: `${role}@jv.test`,
  full_name: `Test ${role}`,
  role,
  must_change_password: false,
  ...extra,
});
const LIFE = { idle_timeout_s: 43200, absolute_expires_at: '2026-10-30T00:00:00.000000Z' };
const loginOk = (user: TestUser) => json(200, { user, ...LIFE });
const meOk = (user: TestUser) => json(200, { user, ...LIFE, pricing_sha256: null });

interface Sent {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}
type Responder = (sent: Sent) => Response | Promise<Response>;

/** An EventTarget that counts its listeners, so a test can see that nothing is left listening after a logout. */
class CountingTarget extends EventTarget {
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.listeners += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
}

function fakeHost() {
  const input = new CountingTarget();
  const visibility = Object.assign(new CountingTarget(), { visibilityState: 'visible' });
  const host: SessionHost = { input, visibility };
  return {
    host,
    visibility,
    click: () => input.dispatchEvent(new Event('click')),
    key: () => input.dispatchEvent(new Event('keydown')),
    listeners: () => input.listeners + visibility.listeners,
  };
}

/**
 * A store over the real client and a fake server: `routes` holds one responder per "METHOD /path"; every call that reaches the server is
 * logged in `sent`. A route without a responder is a network failure (the stub throws, as `fetch` does when the server is down).
 */
function world() {
  const routes = new Map<string, Responder>();
  const sent: Sent[] = [];
  const stubFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Sent = {
      method: init.method ?? 'GET',
      path: url.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    };
    sent.push(call);
    const responder = routes.get(`${call.method} ${call.path}`);
    if (!responder) throw new TypeError('fetch failed');
    return responder(call);
  });
  const api = createApiClient({
    baseUrl: BASE,
    fetch: stubFetch as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  const h = fakeHost();
  const store = createSessionStore({ api, host: h.host, preview: false });
  const calls = (method: string, p: string) =>
    sent.filter((s) => s.method === method && s.path === p).length;
  /** A call that does not answer until the test lets it. */
  const hold = (key: string, answer: () => Response) => {
    let release: () => void = () => undefined;
    routes.set(
      key,
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(answer());
        })
    );
    return () => release();
  };
  return {
    api,
    store,
    h,
    routes,
    sent,
    calls,
    hold,
    /** The server knows this person: login, me, logout and activity answer for them. */
    knows(user: TestUser) {
      routes.set('POST /v1/auth/login', () => loginOk(user));
      routes.set('GET /v1/auth/me', () => meOk(user));
      routes.set('POST /v1/auth/logout', () => json(200, { ok: true }));
      routes.set('POST /v1/auth/activity', () => json(200, { ok: true }));
    },
    route(key: string, responder: Responder) {
      routes.set(key, responder);
    },
    async signInAs(user: TestUser) {
      this.knows(user);
      const result = await store.signIn(user.email, 'a-password-for-the-test');
      expect(result).toEqual({ error: null });
      expect(store.getState().status).toBe('signedIn');
    },
  };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 15, 8, 0, 0) });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

// ------------------------------------------------------------------------------------------------ T-E01: start-up, login, roles

describe('T-E01 the gate at start-up: loading, then the login screen or the app (U5, U7)', () => {
  it('starts on the loading screen, asks `me` once, and opens the app with the role it returns', async () => {
    const w = world();
    w.knows(userOf('biller'));
    expect(w.store.getState().status).toBe('loading');

    w.store.start();
    expect(w.store.getState().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);

    const state = w.store.getState();
    expect(state.status).toBe('signedIn');
    expect(state.role).toBe('biller');
    expect(state.session).toMatchObject({
      userId: userOf('biller').id,
      email: 'biller@jv.test',
      displayName: 'Test biller',
      role: 'biller',
    });
    expect(w.calls('GET', '/v1/auth/me')).toBe(1);
    expect(w.sent).toHaveLength(1);
  });

  it('starting twice (a second mount) asks `me` once', async () => {
    const w = world();
    w.knows(userOf('owner'));
    w.store.start();
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('GET', '/v1/auth/me')).toBe(1);
  });

  it('subscribing starts the store (this is how a page that reads useSession starts it)', async () => {
    const w = world();
    w.knows(userOf('staff'));
    const listener = vi.fn();
    const off = w.store.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalled();
    expect(w.store.getState().role).toBe('staff');
    off();
    expect(w.store.getState().status, 'a page that goes away does not sign anybody out').toBe(
      'signedIn'
    );
  });

  it('with no session (401) shows the login screen once, with no notice and no second call', async () => {
    const w = world();
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401, 'Sign in to continue.'));
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(w.store.getState()).toMatchObject({ status: 'signedOut', session: null, role: null });
    expect(w.store.getState().notice).toBeNull();
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(w.sent).toHaveLength(1);
    expect(w.calls('POST', '/v1/auth/logout')).toBe(0);
  });

  it('with a session that has ended (JV_SESSION_EXPIRED) says so on the login screen', async () => {
    const w = world();
    w.route('GET /v1/auth/me', () => refusal('JV_SESSION_EXPIRED', 401, 'Your session has ended.'));
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedOut');
    expect(w.store.getState().notice).toBe('Your session has ended. Sign in again.');
  });

  it('with the server unreachable shows an error and a retry, never the login screen or the app', async () => {
    const w = world();
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('error');
    expect(w.store.getState().error).toMatch(/connection|server/i);
    expect(w.store.getState().session).toBeNull();

    w.knows(userOf('owner'));
    w.store.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedIn');
    expect(w.calls('GET', '/v1/auth/me')).toBe(2);
  });

  it('a build with no API address shows the error screen instead of crashing', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    const api = createApiClient({ fetch: vi.fn() as unknown as typeof fetch });
    const store = createSessionStore({ api, host: fakeHost().host, preview: false });
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toMatch(/not connected|does not know where the server is/i);
  });
});

describe('T-E01 login per role (U1, U5)', () => {
  for (const role of ALL) {
    it(`the ${role} signs in: POST login, then GET me, and the screen follows the role of me`, async () => {
      const w = world();
      w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401));
      w.store.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.store.getState().status).toBe('signedOut');

      w.knows(userOf(role));
      const result = await w.store.signIn(`  ${role}@jv.test `, 'a-password-for-the-test');
      expect(result).toEqual({ error: null });

      const calls = w.sent.slice(1).map((s) => `${s.method} ${s.path}`);
      expect(calls).toEqual(['POST /v1/auth/login', 'GET /v1/auth/me']);
      const login = w.sent[1];
      expect(login.body).toEqual({ email: `${role}@jv.test`, password: 'a-password-for-the-test' });
      expect(login.headers.get('x-jv-client')).toBe('web');
      expect(w.store.getState()).toMatchObject({ status: 'signedIn', role, notice: null });
      expect(w.store.getState().session?.displayName).toBe(`Test ${role}`);
    });
  }

  it('takes the role from `me`, not from the answer of the login', async () => {
    const w = world();
    w.knows(userOf('biller'));
    w.route('POST /v1/auth/login', () => loginOk(userOf('owner', { id: userOf('biller').id })));
    expect(await w.store.signIn('biller@jv.test', 'x-password-123')).toEqual({ error: null });
    expect(w.store.getState().role).toBe('biller');
  });

  it('a wrong password: one plain message, still on the login screen, memory not touched, `me` not asked', async () => {
    const w = world();
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('POST /v1/auth/login', () => refusal('JV_BAD_LOGIN', 401, 'Wrong email or password.'));
    const unknownEmail = await w.store.signIn('nobody@jv.test', 'not-the-password-1');
    expect(unknownEmail).toEqual({ error: 'Wrong email or password.' });
    const wrongPassword = await w.store.signIn('owner@jv.test', 'not-the-password-2');
    expect(
      wrongPassword,
      'the same words, so the screen does not say which part was wrong'
    ).toEqual(unknownEmail);
    expect(w.calls('GET', '/v1/auth/me')).toBe(0);
    expect(
      wiped,
      'a wrong password is not a 401 of the session: nothing is emptied'
    ).not.toHaveBeenCalled();
  });

  it('an inactive login sees "Your account is not active" and holds no session (JV_FORBIDDEN, reason inactive)', async () => {
    const w = world();
    w.route('POST /v1/auth/login', () =>
      refusal('JV_FORBIDDEN', 403, 'Your account is not active.', { reason: 'inactive' })
    );
    const result = await w.store.signIn('gone@jv.test', 'a-password-for-the-test');
    expect(result.error).toMatch(/^Your account is not active/);
    expect(w.calls('GET', '/v1/auth/me')).toBe(0);
    expect(w.store.getState().session).toBeNull();
  });

  it('too many attempts: the plain message of the client', async () => {
    const w = world();
    w.route('POST /v1/auth/login', () => refusal('JV_RATE_LIMITED', 429));
    const result = await w.store.signIn('owner@jv.test', 'x-password-123');
    expect(result.error).toMatch(/too many attempts/i);
  });

  it('when `me` fails right after a good login the person is told, and the screen does not open', async () => {
    const w = world();
    w.knows(userOf('owner'));
    w.route('GET /v1/auth/me', () => refusal('JV_INTERNAL', 500));
    const result = await w.store.signIn('owner@jv.test', 'x-password-123');
    expect(result.error).toBeTruthy();
    expect(w.store.getState().status).not.toBe('signedIn');
  });

  it('when the browser does not keep the cookie (`me` says 401 straight after login) it says so and stays on the login screen', async () => {
    const w = world();
    w.knows(userOf('owner'));
    w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401));
    const result = await w.store.signIn('owner@jv.test', 'x-password-123');
    expect(result.error).toMatch(/cookies/i);
    expect(w.store.getState().status).toBe('signedOut');
  });

  it('two presses of Sign in at once make one login', async () => {
    const w = world();
    w.knows(userOf('owner'));
    const [a, b] = await Promise.all([
      w.store.signIn('owner@jv.test', 'x-password-123'),
      w.store.signIn('owner@jv.test', 'x-password-123'),
    ]);
    expect(a).toEqual(b);
    expect(w.calls('POST', '/v1/auth/login')).toBe(1);
  });

  it("another person signing in on top of a signed-in one empties the first person's data first", async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.knows(userOf('staff'));
    await w.store.signIn('staff@jv.test', 'x-password-123');
    expect(w.store.getState().role).toBe('staff');
    expect(wiped).toHaveBeenCalledTimes(1);
  });
});

describe('T-E01 a user who must change the password sees only the change-password screen (U11)', () => {
  const mustChange = (role: AuthRole = 'biller') => userOf(role, { must_change_password: true });

  it('after login the state is the change-password screen: a person, no role, no app', async () => {
    const w = world();
    w.knows(mustChange());
    expect(await w.store.signIn('biller@jv.test', 'temporary-pass-1')).toEqual({ error: null });
    const state = w.store.getState();
    expect(state.status).toBe('mustChangePassword');
    expect(state.role, 'no route opens').toBeNull();
    expect(state.session?.displayName).toBe('Test biller');
    expect(canAccessPath(state.role, '/')).toBe(false);
  });

  it('at start-up too (the temporary password was typed in an earlier visit)', async () => {
    const w = world();
    w.knows(mustChange());
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('mustChangePassword');
  });

  it('sends no activity call while the password must be changed (the API refuses all but three calls)', async () => {
    const w = world();
    w.knows(mustChange());
    await w.store.signIn('biller@jv.test', 'temporary-pass-1');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    w.h.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('POST', '/v1/auth/activity')).toBe(0);
  });

  it('changing the password sends the two passwords, asks `me` and opens the app', async () => {
    const w = world();
    w.knows(mustChange());
    await w.store.signIn('biller@jv.test', 'temporary-pass-1');
    w.route('POST /v1/auth/change-password', () => loginOk(userOf('biller')));
    w.route('GET /v1/auth/me', () => meOk(userOf('biller')));

    const result = await w.store.changePassword('temporary-pass-1', 'a-new-long-password-9');
    expect(result).toEqual({ error: null });
    const change = w.sent.find((s) => s.path === '/v1/auth/change-password');
    expect(change?.body).toEqual({
      current_password: 'temporary-pass-1',
      new_password: 'a-new-long-password-9',
    });
    expect(w.store.getState()).toMatchObject({ status: 'signedIn', role: 'biller' });
    expect(w.calls('GET', '/v1/auth/me')).toBe(2); // after the login and after the change
  });

  it('a wrong current password is told as such and does NOT sign the person out (a 422, never a 401)', async () => {
    const w = world();
    w.knows(mustChange());
    await w.store.signIn('biller@jv.test', 'temporary-pass-1');
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('POST /v1/auth/change-password', () =>
      refusal('JV_INVALID_INPUT', 422, 'current_password is not correct', {
        field: 'current_password',
      })
    );
    const result = await w.store.changePassword('mistyped', 'a-new-long-password-9');
    expect(result.error).toMatch(/current password is not correct/i);
    expect(w.store.getState().status).toBe('mustChangePassword');
    expect(wiped).not.toHaveBeenCalled();
  });

  it('a new password the API refuses shows its reason, without the name of the field', async () => {
    const w = world();
    w.knows(mustChange());
    await w.store.signIn('biller@jv.test', 'temporary-pass-1');
    w.route('POST /v1/auth/change-password', () =>
      refusal('JV_INVALID_INPUT', 422, 'new_password must be at least 10 characters', {
        field: 'new_password',
      })
    );
    const result = await w.store.changePassword('temporary-pass-1', 'short');
    expect(result.error).toMatch(/must be at least 10 characters/i);
    expect(result.error).not.toMatch(/new_password/);
    expect(result.error).not.toMatch(/nothing was changed/i);
  });
});

// ------------------------------------------------------------------------------------------------ T-E01: 401 and logout

describe('T-E01 any 401 empties memory, stops the pollers and shows the login screen once, with no loop (U6, C18)', () => {
  it('a 401 of any call (a read, a poll) ends the session on this screen at once', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const cache = vi.fn();
    const poller = vi.fn();
    w.store.registerLogoutHook(cache);
    w.store.registerLogoutHook(poller);

    w.route('POST /v1/sync/poll', () => refusal('JV_UNAUTHENTICATED', 401, 'Sign in to continue.'));
    await expect(w.api.poll({})).rejects.toMatchObject({ status: 401 });

    expect(w.store.getState()).toMatchObject({ status: 'signedOut', session: null, role: null });
    expect(w.store.getState().notice).toBe('Sign in to continue.');
    expect(cache).toHaveBeenCalledTimes(1);
    expect(poller).toHaveBeenCalledTimes(1);
  });

  it('the cause is told: a session that has ended (idle 12 hours, 14 days) says so', async () => {
    const w = world();
    await w.signInAs(userOf('biller'));
    w.route('GET /v1/sync/settings', () => refusal('JV_SESSION_EXPIRED', 401));
    await expect(w.api.syncPage('settings')).rejects.toMatchObject({ status: 401 });
    expect(w.store.getState().notice).toBe('Your session has ended. Sign in again.');
  });

  it('once: ten more 401s of calls already on their way run nothing again and send no logout (no loop)', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('GET /v1/sync/customers', () => refusal('JV_UNAUTHENTICATED', 401));

    await Promise.all(
      Array.from({ length: 10 }, () => w.api.syncPage('customers').catch(() => undefined))
    );
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(w.store.getState().status).toBe('signedOut');
    expect(
      w.calls('POST', '/v1/auth/logout'),
      'the session is over already: nothing to log out'
    ).toBe(0);
    expect(w.calls('GET', '/v1/auth/me'), 'a 401 does not ask `me` again').toBe(1);
  });

  it('after a new login the next 401 works again', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    w.route('GET /v1/sync/customers', () => refusal('JV_UNAUTHENTICATED', 401));
    await w.api.syncPage('customers').catch(() => undefined);
    expect(w.store.getState().status).toBe('signedOut');

    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    await w.api.syncPage('customers').catch(() => undefined);
    expect(w.store.getState().status).toBe('signedOut');
    expect(wiped).toHaveBeenCalledTimes(1);
  });

  it('a user deactivated in the middle of a shift: the next call answers 401 and the screen is emptied (T-D06, C18)', async () => {
    const w = world();
    await w.signInAs(userOf('staff'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('POST /v1/auth/activity', () => refusal('JV_UNAUTHENTICATED', 401));
    await vi.advanceTimersByTimeAsync(61 * 1000);
    w.h.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedOut');
    expect(wiped).toHaveBeenCalledTimes(1);
    // the idle watch went with the session: another click sends nothing
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    w.h.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('POST', '/v1/auth/activity')).toBe(1);
  });
});

describe('T-E01 logout (U8)', () => {
  it('sends POST logout, runs every hook once whatever one of them does, and leaves the login screen', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const cache = vi.fn();
    const broken = vi.fn(() => {
      throw new Error('a hook that fails');
    });
    const poller = vi.fn();
    const later = vi.fn();
    w.store.registerLogoutHook(cache);
    w.store.registerLogoutHook(broken);
    w.store.registerLogoutHook(poller);
    w.store.registerLogoutHook(later)(); // unregistered at once

    await w.store.signOut();

    expect(w.calls('POST', '/v1/auth/logout')).toBe(1);
    expect(cache).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(poller, 'a hook after a failing one still runs').toHaveBeenCalledTimes(1);
    expect(later, 'a hook that was unregistered does not run').not.toHaveBeenCalled();
    expect(w.store.getState()).toMatchObject({ status: 'signedOut', session: null, role: null });
    expect(w.store.getState().notice).toBeNull();

    await w.store.signOut();
    expect(cache, 'signing out twice does not run them twice').toHaveBeenCalledTimes(1);
    expect(w.calls('POST', '/v1/auth/logout')).toBe(1);
  });

  it('logout sends no body and no content type (an empty JSON body is a 422), with the header of the site', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    await w.store.signOut();
    const call = w.sent.find((s) => s.path === '/v1/auth/logout');
    expect(call?.body).toBeUndefined();
    expect(call?.headers.get('content-type')).toBeNull();
    expect(call?.headers.get('x-jv-client')).toBe('web');
  });

  it('memory is emptied BEFORE the server has answered, and the screen goes to the login at once', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const release = w.hold('POST /v1/auth/logout', () => json(200, { ok: true }));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    const done = w.store.signOut();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedOut');
    expect(wiped).toHaveBeenCalledTimes(1);
    release();
    await done;
  });

  it('a server that cannot be reached does not keep the person on the screen', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    w.routes.delete('POST /v1/auth/logout');
    await w.store.signOut();
    expect(w.store.getState().status).toBe('signedOut');
  });

  it('a login made while the logout is still on its way waits for it (its cookie must not clear the new one)', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const release = w.hold('POST /v1/auth/logout', () => json(200, { ok: true }));
    void w.store.signOut();
    await vi.advanceTimersByTimeAsync(0); // the logout is on its way
    w.route('POST /v1/auth/login', () => loginOk(userOf('biller')));
    w.route('GET /v1/auth/me', () => meOk(userOf('biller')));

    const login = w.store.signIn('biller@jv.test', 'x-password-123');
    await vi.advanceTimersByTimeAsync(0);
    expect(
      w.calls('POST', '/v1/auth/login'),
      "no second login before the logout has answered (the first one is the owner's)"
    ).toBe(1);
    release();
    await login;
    expect(w.calls('POST', '/v1/auth/login')).toBe(2);
    expect(w.store.getState().role).toBe('biller');
  });

  it('20 login and logout cycles never hang, and leave no timer and no listener behind', async () => {
    const w = world();
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    for (let cycle = 0; cycle < 20; cycle++) {
      const role = ALL[cycle % ALL.length];
      await w.signInAs(userOf(role));
      expect(w.store.getState().role, `cycle ${cycle + 1}`).toBe(role);
      await w.store.signOut();
      expect(w.store.getState().status, `cycle ${cycle + 1}`).toBe('signedOut');
    }
    expect(wiped).toHaveBeenCalledTimes(20);
    expect(w.calls('POST', '/v1/auth/login')).toBe(20);
    expect(w.calls('GET', '/v1/auth/me')).toBe(20);
    expect(w.calls('POST', '/v1/auth/logout')).toBe(20);
    expect(w.h.listeners(), 'no listener left on the window or the document').toBe(0);
    expect(vi.getTimerCount(), 'no timer left').toBe(0);
  });
});

describe('the module-level store (what the pages use)', () => {
  it('logout empties the registered caches whatever happens to the network, and leaves the screen signed out', async () => {
    const cache = vi.fn();
    const off = registerLogoutHook(cache);
    await signOut();
    expect(cache).toHaveBeenCalledTimes(1);
    expect(getSessionState()).toMatchObject({ status: 'signedOut', session: null, role: null });
    await signOut();
    expect(cache).toHaveBeenCalledTimes(1);
    off();
  });
});

// ------------------------------------------------------------------------------------------------ T-E01: a 403 from the poll

describe('T-E01 a 403 from the poll calls `me` once (U6, C18)', () => {
  /** What the owner's screen holds in memory: a store registers one function that empties it. */
  const ownerData = () => {
    const held = { sku_private: ['row'], audit: ['row'], customers: ['row'] };
    const empty = () => {
      held.sku_private = [];
      held.audit = [];
      held.customers = [];
    };
    return { held, empty };
  };

  it('an owner demoted to biller: the owner-only data is emptied, the pollers stop, and the gate opens again with the new role', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const { held, empty } = ownerData();
    w.store.registerLogoutHook(empty);
    const epoch = w.store.getState().epoch;
    w.knows(userOf('biller', { id: userOf('owner').id }));

    const outcome = await w.store.reviewRole();

    expect(outcome).toBe('changed');
    expect(held.sku_private, 'sku_private is gone from memory').toEqual([]);
    expect(held.audit, 'the audit data is gone from memory').toEqual([]);
    expect(w.store.getState()).toMatchObject({ status: 'signedIn', role: 'biller' });
    expect(w.store.getState().epoch, 'the gate is opened again').toBe(epoch + 1);
    expect(canAccessPath(w.store.getState().role, '/reports')).toBe(false);
    expect(w.calls('GET', '/v1/auth/me')).toBe(2); // after the login, and ONCE for the 403
  });

  it('a promotion opens the gate again too (the new role may read more)', async () => {
    const w = world();
    await w.signInAs(userOf('staff'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.knows(userOf('owner', { id: userOf('staff').id }));
    expect(await w.store.reviewRole()).toBe('changed');
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(w.store.getState().role).toBe('owner');
  });

  it('the same role: nothing is emptied, the gate stays as it is, and the caller shows the error once', async () => {
    const w = world();
    await w.signInAs(userOf('biller'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    const before = w.store.getState();

    expect(await w.store.reviewRole()).toBe('same');
    expect(wiped).not.toHaveBeenCalled();
    expect(w.store.getState()).toBe(before);
    expect(w.calls('GET', '/v1/auth/me')).toBe(2);
  });

  it('two 403s at the same moment make one `me` call; a later 403 makes one more (one for each 403, no loop)', async () => {
    const w = world();
    await w.signInAs(userOf('biller'));
    const meBefore = w.calls('GET', '/v1/auth/me');
    const [a, b] = await Promise.all([w.store.reviewRole(), w.store.reviewRole()]);
    expect([a, b]).toEqual(['same', 'same']);
    expect(w.calls('GET', '/v1/auth/me') - meBefore).toBe(1);
    await w.store.reviewRole();
    expect(w.calls('GET', '/v1/auth/me') - meBefore).toBe(2);
    // a review never starts another review by itself
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(w.calls('GET', '/v1/auth/me') - meBefore).toBe(2);
  });

  it('when `me` says 401 (the person was deactivated) the login screen opens, once', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401));
    expect(await w.store.reviewRole()).toBe('ended');
    expect(w.store.getState().status).toBe('signedOut');
    expect(wiped).toHaveBeenCalledTimes(1);
  });

  it('when `me` cannot be reached nothing is emptied and the caller is told it does not know', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);
    w.routes.delete('GET /v1/auth/me');
    expect(await w.store.reviewRole()).toBe('unknown');
    expect(wiped).not.toHaveBeenCalled();
    expect(w.store.getState().status).toBe('signedIn');
  });

  it('a review that finds nobody signed in does nothing and calls nothing', async () => {
    const w = world();
    w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401));
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = w.sent.length;
    expect(await w.store.reviewRole()).toBe('ended');
    expect(w.sent).toHaveLength(calls);
  });

  it('a review that races a logout is dropped: the person who left is not signed in again', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const release = w.hold('GET /v1/auth/me', () =>
      meOk(userOf('biller', { id: userOf('owner').id }))
    );
    const review = w.store.reviewRole();
    await vi.advanceTimersByTimeAsync(0);
    await w.store.signOut();
    release();
    expect(await review).toBe('ended');
    expect(w.store.getState().status).toBe('signedOut');
  });
});

// ------------------------------------------------------------------------------------------------ T-E08: the idle logout, and the activity call

describe('T-E08 the screen logs out by itself after 12 hours without a click or key press (U4, C16)', () => {
  it('stays in just under 12 hours, and is out at 12 hours, with the notice, a logout call and nothing left', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    const wiped = vi.fn();
    w.store.registerLogoutHook(wiped);

    await vi.advanceTimersByTimeAsync(12 * HOUR - 60_000);
    expect(w.store.getState().status).toBe('signedIn');
    expect(wiped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(w.store.getState().status).toBe('signedOut');
    expect(w.store.getState().notice).toBe(IDLE_NOTICE);
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(w.calls('POST', '/v1/auth/logout')).toBe(1);
    expect(w.h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the notice says why, in words', () => {
    expect(IDLE_NOTICE).toMatch(/signed out .*12 hours/i);
  });

  it('a click starts the 12 hours again', async () => {
    const w = world();
    await w.signInAs(userOf('biller'));
    await vi.advanceTimersByTimeAsync(11.5 * HOUR);
    w.h.click();
    await vi.advanceTimersByTimeAsync(11.5 * HOUR);
    expect(w.store.getState().status, '23 h after login, 11 h 30 min after the click').toBe(
      'signedIn'
    );
    await vi.advanceTimersByTimeAsync(1 * HOUR);
    expect(w.store.getState().status, '12 h 30 min after the click').toBe('signedOut');
  });

  it('a key press starts the 12 hours again', async () => {
    const w = world();
    await w.signInAs(userOf('staff'));
    await vi.advanceTimersByTimeAsync(11.5 * HOUR);
    w.h.key();
    await vi.advanceTimersByTimeAsync(11.5 * HOUR);
    expect(w.store.getState().status).toBe('signedIn');
    await vi.advanceTimersByTimeAsync(1 * HOUR);
    expect(w.store.getState().status).toBe('signedOut');
  });

  it('a laptop that slept all night is logged out at the first look on waking (the clock is compared, not counted)', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    vi.setSystemTime(Date.now() + 13 * HOUR); // asleep: no timer ran
    expect(w.store.getState().status).toBe('signedIn');
    w.h.visibility.visibilityState = 'visible';
    w.h.visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedOut');
    expect(w.store.getState().notice).toBe(IDLE_NOTICE);
  });

  it('a tab that comes back to the foreground inside the 12 hours stays signed in', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    w.h.visibility.dispatchEvent(new Event('visibilitychange'));
    expect(w.store.getState().status).toBe('signedIn');
  });

  it('the person can sign in again after the idle logout, and gets a new 12 hours', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    await vi.advanceTimersByTimeAsync(12 * HOUR + 2 * MINUTE);
    expect(w.store.getState().status).toBe('signedOut');
    await w.signInAs(userOf('owner'));
    expect(w.store.getState().notice).toBeNull();
    await vi.advanceTimersByTimeAsync(11 * HOUR);
    expect(w.store.getState().status).toBe('signedIn');
  });

  it('a person who must change the password is logged out after 12 hours too', async () => {
    const w = world();
    w.knows(userOf('staff', { must_change_password: true }));
    await w.store.signIn('staff@jv.test', 'temporary-pass-1');
    expect(w.store.getState().status).toBe('mustChangePassword');
    await vi.advanceTimersByTimeAsync(12 * HOUR + MINUTE);
    expect(w.store.getState().status).toBe('signedOut');
    expect(w.store.getState().notice).toBe(IDLE_NOTICE);
  });
});

describe('the activity call (U4): at most once a minute, on a click or a key press', () => {
  it('the login itself counts: ten clicks in the first minute send nothing', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    for (let i = 0; i < 10; i++) {
      w.h.click();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(w.calls('POST', '/v1/auth/activity')).toBe(0);
  });

  it('a click after a minute sends one, and the clicks of the next minute send none', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    await vi.advanceTimersByTimeAsync(61_000);
    for (let i = 0; i < 20; i++) {
      w.h.click();
      w.h.key();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('POST', '/v1/auth/activity')).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    w.h.click();
    expect(w.calls('POST', '/v1/auth/activity'), '30 seconds later').toBe(1);

    await vi.advanceTimersByTimeAsync(31_000);
    w.h.key();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('POST', '/v1/auth/activity'), 'a key press a minute after the first').toBe(2);
  });

  it('is sent with no body and no content type (an empty JSON body is a 422), with the header of the site', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    await vi.advanceTimersByTimeAsync(61_000);
    w.h.click();
    await vi.advanceTimersByTimeAsync(0);
    const call = w.sent.find((s) => s.path === '/v1/auth/activity');
    expect(call?.body).toBeUndefined();
    expect(call?.headers.get('content-type')).toBeNull();
    expect(call?.headers.get('x-jv-client')).toBe('web');
  });

  it('a failed call is not repeated by itself and does not end the session (only a 401 does)', async () => {
    const w = world();
    await w.signInAs(userOf('owner'));
    w.route('POST /v1/auth/activity', () => refusal('JV_INTERNAL', 500));
    await vi.advanceTimersByTimeAsync(61_000);
    w.h.click();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.calls('POST', '/v1/auth/activity')).toBe(1);
    expect(w.store.getState().status).toBe('signedIn');
  });

  it('clicks on the login screen send nothing, and nothing listens there', async () => {
    const w = world();
    w.route('GET /v1/auth/me', () => refusal('JV_UNAUTHENTICATED', 401));
    w.store.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    w.h.click();
    w.h.key();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.calls('POST', '/v1/auth/activity')).toBe(0);
    expect(w.h.listeners()).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ U1, SEC-01: no credentials in the code

describe('the login screen and the code hold no credentials and no hints (U1, U10)', () => {
  const root = path.resolve(__dirname, '../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : [file];
    });

  it("src/ has no trace of the prototype's two passwords", () => {
    // written in two pieces, so that a search of the repository for them finds nothing in this file
    const old = ['admin' + '123', 'staff' + '123'];
    for (const file of walk(path.join(root, 'src'))) {
      if (!/\.(ts|tsx|css|json)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const word of old) expect(text, `${file} holds ${word}`).not.toContain(word);
    }
  });

  it('the login screen starts empty: no placeholder, no default value, no address written in it', () => {
    const text = readFileSync(path.join(root, 'src/components/LoginScreen.tsx'), 'utf8');
    expect(text).not.toMatch(/placeholder\s*=/i);
    expect(text).not.toMatch(/defaultValue/);
    expect(text).not.toMatch(/['"`][^'"`\s]+@[^'"`\s]+['"`]/);
    expect(text.match(/useState\(''\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the session store does not use the Supabase client any more', () => {
    const text = readFileSync(path.join(root, 'src/lib/authStore.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"]@supabase/);
    expect(text).not.toMatch(/from ['"]@\/lib\/supabase/);
  });
});

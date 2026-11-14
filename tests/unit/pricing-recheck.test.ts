// FB-D5 (Wave 1 review): a tab left open re-checks the pricing hash when it comes back.
//   After a deploy that changes pricing.ts, a tab that was open before it keeps its old "pricing matches" answer until a full reload, so it could save a bill priced by the old rule. `me` carries the
//   hash of the API's pricing.ts (C12) and the client compares it with the build's own every time it is asked; the session store now asks `me` again when the document becomes visible:
//   - hidden, then visible: one `GET /v1/auth/me`; two visibility events inside 60 seconds: one call in all; 60 seconds later another
//   - the new answer is the same compare as at start: a hash that differs flips the pricing state to `mismatch` (Save on bills off), the right hash flips it back
//   - a request that fails (offline) changes nothing; nothing is asked while the tab is hidden, while nobody is signed in or while the password must be changed; no timer polls in the background
//
// The store is built the way the site builds it, over the REAL client with a stubbed `fetch` and a fake host (as tests/unit/auth-routes.test.ts does); time is faked.
//
// Run: npm test -- tests/unit/pricing-recheck.test.ts      (or: npm test -- -t FB-D5)
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { createSessionStore, type SessionHost } from '@/lib/authStore';

const BASE = 'https://api.example.test';
const MINUTE = 60 * 1000;
const BUILD = 'a'.repeat(64);
const OLD_RULE = 'b'.repeat(64);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const user = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  email: 'owner@jv.test',
  full_name: 'Test owner',
  role: 'owner',
  must_change_password: false,
  ...over,
});
const LIFE = { idle_timeout_s: 43200, absolute_expires_at: '2026-10-30T00:00:00.000000Z' };

class Target extends EventTarget {}

function world() {
  /** What `me` answers now: a hash, or null for a server that cannot be reached. */
  const server = {
    hash: BUILD as string,
    down: false,
    mustChange: false,
    mePaths: 0,
    ended: false,
  };
  const stubFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    if (key === 'GET /v1/auth/me') {
      server.mePaths += 1;
      if (server.down) throw new TypeError('fetch failed');
      if (server.ended)
        return json(401, {
          error: { code: 'JV_SESSION_EXPIRED', message: 'Signed out.', details: {} },
          request_id: 'r',
        });
      return json(200, {
        user: user({ must_change_password: server.mustChange }),
        ...LIFE,
        pricing_sha256: server.hash,
      });
    }
    if (key === 'POST /v1/auth/login')
      return json(200, { user: user({ must_change_password: server.mustChange }), ...LIFE });
    if (key === 'POST /v1/auth/logout' || key === 'POST /v1/auth/activity')
      return json(200, { ok: true });
    throw new TypeError('fetch failed');
  });
  const api = createApiClient({
    baseUrl: BASE,
    fetch: stubFetch as unknown as typeof fetch,
    sleep: async () => undefined,
    buildPricingSha256: BUILD,
  });
  const input = new Target();
  const visibility = Object.assign(new Target(), { visibilityState: 'visible' });
  const host: SessionHost = { input, visibility };
  const store = createSessionStore({ api, host, preview: false });
  const comeBack = async () => {
    visibility.visibilityState = 'hidden';
    visibility.dispatchEvent(new Event('visibilitychange'));
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  };
  const mes = () => stubFetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/auth/me')).length;
  return {
    api,
    store,
    server,
    visibility,
    comeBack,
    mes,
    async signIn() {
      expect(await store.signIn('owner@jv.test', 'a-password-for-the-test')).toEqual({
        error: null,
      });
      expect(store.getState().status).toBe('signedIn');
    },
  };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 14, 8, 0, 0) });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

describe('FB-D5 a tab that comes back asks `me` again', () => {
  it('hidden, then visible: one more GET /v1/auth/me', async () => {
    const w = world();
    await w.signIn();
    expect(w.mes()).toBe(1); // the sign-in's own
    await w.comeBack();
    expect(w.mes()).toBe(2);
  });

  it('two comings back inside 60 seconds make one call; a third 60 seconds after the first makes another', async () => {
    const w = world();
    await w.signIn();
    await w.comeBack();
    await vi.advanceTimersByTimeAsync(20 * 1000);
    await w.comeBack();
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await w.comeBack();
    expect(w.mes(), 'sign-in + one call in the first minute').toBe(2);
    await vi.advanceTimersByTimeAsync(11 * 1000); // 61 s after the first one
    await w.comeBack();
    expect(w.mes()).toBe(3);
  });

  it('nothing is asked while the tab is hidden: a hidden event, and a long time with no event, make no call', async () => {
    const w = world();
    await w.signIn();
    w.visibility.visibilityState = 'hidden';
    w.visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(w.mes()).toBe(1);
    // and while it is visible and nothing happens, no timer asks either (no polling loop)
    w.visibility.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(w.mes()).toBe(1);
  });

  it('nobody signed in, nothing asked: before the sign-in, after a sign-out, and for a person who must change the password', async () => {
    const w = world();
    w.server.ended = true; // start-up `me`: nobody
    w.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.getState().status).toBe('signedOut');
    const afterStart = w.mes();
    await w.comeBack();
    expect(w.mes()).toBe(afterStart);

    const signedOut = world();
    await signedOut.signIn();
    await signedOut.store.signOut();
    const before = signedOut.mes();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await signedOut.comeBack();
    expect(signedOut.mes()).toBe(before);

    const must = world();
    must.server.mustChange = true;
    await must.store.signIn('owner@jv.test', 'temporary-pass-1');
    expect(must.store.getState().status).toBe('mustChangePassword');
    const asked = must.mes();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await must.comeBack();
    expect(must.mes()).toBe(asked);
  });

  it('listens once: the idle check and the pricing check share the one visibilitychange listener', async () => {
    const w = world();
    const added: string[] = [];
    const original = w.visibility.addEventListener.bind(w.visibility);
    w.visibility.addEventListener = ((type: string, ...rest: never[]) => {
      added.push(type);
      return original(type, ...(rest as [never]));
    }) as typeof w.visibility.addEventListener;
    await w.signIn();
    expect(added.filter((type) => type === 'visibilitychange')).toHaveLength(1);
  });
});

describe('FB-D5 the new answer is the same compare as at start', () => {
  it("a hash that differs from the build's flips the pricing state to mismatch; the right hash flips it back", async () => {
    const w = world();
    await w.signIn();
    expect(w.api.getPricingCheck()).toEqual({ state: 'match' });
    expect(w.api.savingBillsAllowed()).toBe(true);
    const heard = vi.fn();
    w.api.subscribePricing(heard);

    // a deploy changes pricing.ts: the API answers another hash, the tab comes back
    w.server.hash = OLD_RULE;
    await w.comeBack();
    expect(w.api.getPricingCheck()).toEqual({
      state: 'mismatch',
      apiHash: OLD_RULE,
      buildHash: BUILD,
    });
    expect(w.api.savingBillsAllowed(), 'Save on bills is off, as at start').toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);

    // and the API's hash is the build's again (the website was deployed too)
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    w.server.hash = BUILD;
    await w.comeBack();
    expect(w.api.getPricingCheck()).toEqual({ state: 'match' });
    expect(w.api.savingBillsAllowed()).toBe(true);
  });

  it('an answer with no hash at all is a mismatch, as at start', async () => {
    const w = world();
    await w.signIn();
    w.server.hash = null as unknown as string;
    await w.comeBack();
    expect(w.api.getPricingCheck()).toMatchObject({ state: 'mismatch', apiHash: null });
  });

  it('a request that fails (offline) changes nothing: the state, the person and the screen stay as they were', async () => {
    const w = world();
    await w.signIn();
    const stateBefore = w.store.getState();
    const heard = vi.fn();
    w.api.subscribePricing(heard);
    w.server.down = true;
    w.server.hash = OLD_RULE; // would be a mismatch if it could be read
    await w.comeBack();
    expect(w.mes()).toBe(2); // it was asked
    expect(w.api.getPricingCheck()).toEqual({ state: 'match' });
    expect(heard).not.toHaveBeenCalled();
    expect(w.store.getState()).toBe(stateBefore);
  });

  it('a session that has ended meanwhile is the one 401 of any call: the login screen, once', async () => {
    const w = world();
    await w.signIn();
    w.server.ended = true;
    await w.comeBack();
    expect(w.store.getState().status).toBe('signedOut');
  });
});

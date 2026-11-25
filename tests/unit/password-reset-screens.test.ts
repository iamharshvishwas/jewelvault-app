// Forgot password by e-mail, the website side (Completion-Plan/password-help-2026-11-26/DESIGN.md, part 2, "Website"; PLAN.md Task 4):
//   - the two pages open whatever the session state: the layout decides on the path, before its loading / sign-in / role checks (Review Focus 3);
//   - the reset page never shows a blank or broken form: no token, a short or a damaged one is the bad-link sentence with a link to ask again (Review Focus 2),
//     and the token is read from `#t=` once, kept in state and never drawn on the page;
//   - the two calls map the API's answers to the words of the screens, with a stubbed `fetch`;
//   - after the password is saved the session store looks at the session at once (Review Focus 3): a browser signed in as the login that was reset shows sign-in, one signed in as
//     another login keeps its session. That part runs the real client and the real session store over a stubbed `fetch`.
//
// The screens are drawn with renderToStaticMarkup (a node test: no effects run, no browser). What happens after a click (the success sentence, the error under
// the fields) is the e2e lane's job (tests/e2e/forgot-password.spec.ts).
//
// Run: npx vitest run tests/unit/password-reset-screens.test.ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from '@/components/AppLayout';
import ForgotPasswordScreen from '@/components/ForgotPasswordScreen';
import LoginScreen from '@/components/LoginScreen';
import ResetPasswordScreen from '@/components/ResetPasswordScreen';
import { SCREENS, canAccessPath } from '@/lib/access';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import { plainMessage } from '@/lib/api/errorMap';
import { createSessionStore } from '@/lib/authStore';
import {
  BAD_LINK_MESSAGE,
  LINK_SENT_MESSAGE,
  MAIL_NOT_SET_UP_MESSAGE,
  PASSWORD_CHANGED_MESSAGE,
  requestResetLink,
  resetPassword,
  standalonePathScreen,
  tokenFromHash,
} from '@/lib/passwordReset';
import { accessFor } from './support/access';

// ------------------------------------------------------------------------------------------------ what the layout reads (its path and its session)

const layoutInput = vi.hoisted(() => ({
  pathname: '/',
  state: { status: 'signedOut' } as Record<string, unknown>,
}));
/** The store's own `reviewRole` (the re-check after a reset) is replaced by a spy, to see that `resetPassword` calls it by default. */
const sessionCheck = vi.hoisted(() => ({ reviewRole: vi.fn(async () => 'same' as const) }));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => layoutInput.pathname,
}));

vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useSession: () => layoutInput.state,
  reviewRole: sessionCheck.reviewRole,
}));

// ------------------------------------------------------------------------------------------------ helpers

/** A token as the API makes it: 32 random bytes in base64url are 43 characters. */
const TOKEN = 'Zm9vYmFyLWJhei1xdXV4LTEyMzQ1Njc4OTBfQUJDREVG';
const toggles = (html: string) => html.match(/data-testid="password-reveal"/g)?.length ?? 0;

const BASE = 'https://api.example.test';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** The S8 body of the API's own refusals. */
const refusal = (
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
) => json(status, { error: { code, message, details }, request_id: 'req-reset-1' });

function make(reply: Response | Error): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const stubbed = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if (reply instanceof Error) throw reply;
    return reply.clone();
  });
  const client = createApiClient({
    baseUrl: BASE,
    fetch: stubbed as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { client, calls };
}

// ------------------------------------------------------------------------------------------------ the token in the address

describe('tokenFromHash', () => {
  it('reads #t=, refuses empty, short, long and non-base64url', () => {
    expect(tokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    // the edges of 20 to 100 characters
    expect(tokenFromHash(`#t=${'a'.repeat(20)}`)).toBe('a'.repeat(20));
    expect(tokenFromHash(`#t=${'a'.repeat(100)}`)).toBe('a'.repeat(100));
    expect(tokenFromHash(`#t=${'a'.repeat(19)}`)).toBeNull();
    expect(tokenFromHash(`#t=${'a'.repeat(101)}`)).toBeNull();
    // empty, no token, no #, another name
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#')).toBeNull();
    expect(tokenFromHash('#t=')).toBeNull();
    expect(tokenFromHash(`t=${TOKEN}`)).toBeNull();
    expect(tokenFromHash(`#token=${TOKEN}`)).toBeNull();
    // base64url only: no padding, no plus, no slash, no space, nothing after the token
    for (const bad of ['=', '+', '/', ' ', '.', '&x=1', '%41', '<']) {
      expect(tokenFromHash(`#t=${TOKEN}${bad}`), JSON.stringify(bad)).toBeNull();
      expect(tokenFromHash(`#t=${TOKEN.slice(0, 20)}${bad}${TOKEN.slice(20)}`)).toBeNull();
    }
  });
});

// ------------------------------------------------------------------------------------------------ the screens

describe('the sign-in screen', () => {
  it('links to /forgot-password, under the Password field, right-aligned and small', () => {
    const html = renderToStaticMarkup(createElement(LoginScreen, { notice: null }));
    const link = /<a[^>]*href="\/forgot-password"[^>]*>Forgot password\?<\/a>/.exec(html)?.[0];
    expect(link).toBeTruthy();
    expect(link).toContain('text-xs');
    // the link is under the field, in a right-aligned line, and the label of the field is still exactly "Password"
    const afterPassword = html.slice(html.indexOf('type="password"'));
    expect(afterPassword).toContain(link!);
    expect(html).toMatch(/<[^>]*class="[^"]*text-right[^"]*"[^>]*><a[^>]*href="\/forgot-password"/);
    expect(html).toContain('>Password</label>');
    const labels = [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) => m[1]!);
    expect(labels.some((text) => text.includes('Forgot'))).toBe(false);
    // the eye button is still the only button besides Sign In
    expect(toggles(html)).toBe(1);
  });
});

describe('the forgot screen', () => {
  const html = renderToStaticMarkup(createElement(ForgotPasswordScreen));

  it('starts with an empty e-mail field and a Send link button', () => {
    const input = /<input[^>]*type="email"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toBeTruthy();
    expect(input).toContain('value=""');
    expect(input).toContain('required');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Send link<\/button>/);
    // nothing has been sent yet: no answer on the screen
    expect(html).not.toContain(LINK_SENT_MESSAGE);
    expect(html).not.toContain('role="alert"');
  });

  it('has the way back to sign in', () => {
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to sign in<\/a>/);
  });
});

describe('the reset screen', () => {
  const withToken = renderToStaticMarkup(
    createElement(ResetPasswordScreen, { hash: `#t=${TOKEN}` })
  );

  it('has two eye-button fields', () => {
    expect(toggles(withToken)).toBe(2);
    const inputs = [...withToken.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toMatch(/type="password"/);
      expect(input).toMatch(/autoComplete="new-password"|autocomplete="new-password"/);
      expect(input).toContain('required');
    }
    expect(withToken).toContain('>New password</label>');
    expect(withToken).toContain('>Repeat the new password</label>');
    expect(withToken).toMatch(/<button[^>]*type="submit"[^>]*>Save new password<\/button>/);
    expect(withToken).not.toContain(BAD_LINK_MESSAGE);
  });

  it('never draws the token on the page', () => {
    expect(withToken).not.toContain(TOKEN);
  });

  it.each([
    ['no hash at all', ''],
    ['a hash with no token', '#t='],
    ['a hash of another kind', '#section'],
    ['a token that is too short', '#t=abc'],
    ['a token with a character that is not base64url', `#t=${TOKEN}+`],
  ])('no token shows the bad-link sentence and a link to /forgot-password (%s)', (_name, hash) => {
    const html = renderToStaticMarkup(createElement(ResetPasswordScreen, { hash }));
    expect(html).toContain(BAD_LINK_MESSAGE);
    expect(html).toMatch(/<a[^>]*href="\/forgot-password"[^>]*>[^<]+<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Back to sign in<\/a>/);
    // never a blank or a broken form
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
  });

  it('draws the same thing on the server and in the browser before it has read the address: no form, no sentence', () => {
    // the static page is made with no address to read, so the first render of the browser must be the same: the sentence or the form appear once the address is read
    const html = renderToStaticMarkup(createElement(ResetPasswordScreen));
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
    expect(html).not.toContain(BAD_LINK_MESSAGE);
    expect(html).not.toContain('role="alert"');
  });
});

describe('the words of the screens', () => {
  it('are the ones the plan fixes', () => {
    expect(LINK_SENT_MESSAGE).toBe(
      'If this e-mail has a login, a link is on its way. It works once, within 30 minutes. No mail in 5 minutes (look in Spam too)? Ask the Super Admin to reset your password from People & Roles.'
    );
    expect(BAD_LINK_MESSAGE).toBe('This link has expired or was already used. Ask for a new one.');
    expect(PASSWORD_CHANGED_MESSAGE).toBe('Your password is changed. Sign in with it.');
    expect(MAIL_NOT_SET_UP_MESSAGE).toBe(
      'E-mail is not set up here. Ask the Super Admin to reset your password.'
    );
  });
});

// ------------------------------------------------------------------------------------------------ the layout

describe('the layout', () => {
  const MARKER = 'the-page-of-the-path';
  const draw = (pathname: string, state: Record<string, unknown>) => {
    layoutInput.pathname = pathname;
    layoutInput.state = state;
    return renderToStaticMarkup(createElement(AppLayout, null, createElement('p', null, MARKER)));
  };
  const SIGNED_IN = {
    status: 'signedIn',
    session: { displayName: 'Test Person', reads: [] },
    access: 'an-access',
    notice: null,
    error: null,
    epoch: 1,
  };
  const STATES: Array<[string, Record<string, unknown>]> = [
    ['signed out', { status: 'signedOut', session: null, notice: null, error: null, epoch: 0 }],
    ['loading', { status: 'loading', session: null, notice: null, error: null, epoch: 0 }],
    ['signed in', SIGNED_IN],
    ['must change the password', { ...SIGNED_IN, status: 'mustChangePassword' }],
    ['not asked yet (error)', { status: 'error', session: null, error: 'down', epoch: 0 }],
  ];

  it('decides on the path: the two pages and nothing else, with or without a trailing slash, a query or a hash', () => {
    expect(standalonePathScreen('/forgot-password')).toBe('forgot');
    expect(standalonePathScreen('/forgot-password/')).toBe('forgot');
    expect(standalonePathScreen('/forgot-password?x=1')).toBe('forgot');
    expect(standalonePathScreen('/reset-password')).toBe('reset');
    expect(standalonePathScreen('/reset-password/')).toBe('reset');
    expect(standalonePathScreen('/reset-password#t=abc')).toBe('reset');
    for (const other of [
      '/',
      '',
      '/people-roles',
      '/forgot',
      '/forgot-password-2',
      '/forgot-password/more',
      '/reset-password/more',
      '/x/reset-password',
      '/Reset-Password',
    ])
      expect(standalonePathScreen(other), other).toBeNull();
  });

  it('shows the forgot and reset screens for a signed-out, a loading and a signed-in state', () => {
    for (const path of ['/forgot-password', '/reset-password'])
      for (const [name, state] of STATES) {
        const html = draw(path, state);
        // the page of the path is all there is: no sign-in screen, no loading screen, no retry screen, no change-password screen, no shell
        expect(html, `${path} ${name}`).toContain(MARKER);
        expect(html, `${path} ${name}`).not.toMatch(/Sign In|Loading|Try again|Choose a new/);
        expect(html, `${path} ${name}`).not.toContain('app-shell');
      }
  });

  it('still gates every other path: signed out is the sign-in screen, loading is the loading screen', () => {
    const signedOut = draw('/', STATES[0]![1]);
    expect(signedOut).toContain('Sign In');
    expect(signedOut).not.toContain(MARKER);
    const loading = draw('/', STATES[1]![1]);
    expect(loading).toContain('Loading...');
    expect(loading).not.toContain(MARKER);
    // a page that is not one of the two is not let through by a look-alike path
    expect(draw('/forgot-password-2', STATES[0]![1])).toContain('Sign In');
  });

  it('keeps the two paths out of the role check: they are not a screen of the access table', () => {
    for (const path of ['/forgot-password', '/reset-password']) {
      expect(SCREENS.some((screen) => screen.path === path)).toBe(false);
      expect(canAccessPath({ permissions: new Set(), isSuperAdmin: true }, path)).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the two calls

/** The client writes a line to the console for a failure it does not know (the code, the status, the request id: never the body). The tests of failures keep it out of the output. */
function quietConsole() {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

describe('requestResetLink', () => {
  quietConsole();
  it('sends the e-mail, trimmed, to the public route and says ok on the 202', async () => {
    const { client, calls } = make(json(202, { ok: true }));
    await expect(requestResetLink('  Siddhi@Example.com ', client)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/forgot-password`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('x-jv-client')).toBe('web');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: 'Siddhi@Example.com' });
  });

  it("maps 503 reason mail_not_set_up to the API's sentence, and every other failure to a plain message", async () => {
    const notSetUp = make(
      refusal(
        503,
        'JV_UNAVAILABLE',
        'E-mail is not set up here. Ask the Super Admin to reset your password.',
        { reason: 'mail_not_set_up' }
      )
    );
    await expect(requestResetLink('a@b.example', notSetUp.client)).resolves.toEqual({
      error: 'E-mail is not set up here. Ask the Super Admin to reset your password.',
    });

    // any other 503 is the plain "cannot reach the server", not the mail sentence
    const other503 = make(refusal(503, 'JV_UNAVAILABLE', 'The database is down.', {}));
    await expect(requestResetLink('a@b.example', other503.client)).resolves.toEqual({
      error: plainMessage('JV_UNAVAILABLE', { write: false }),
    });

    const failures: Array<[string, Response | Error, string]> = [
      [
        'a lost connection',
        new TypeError('Failed to fetch'),
        plainMessage('NETWORK', { write: false }),
      ],
      [
        'a server error',
        refusal(500, 'JV_INTERNAL', 'boom: the stack of the server'),
        plainMessage('JV_INTERNAL', { write: false }),
      ],
      [
        'too many attempts',
        refusal(429, 'JV_RATE_LIMITED', 'slow down'),
        plainMessage('JV_RATE_LIMITED', { write: false }),
      ],
    ];
    for (const [name, reply, expected] of failures) {
      const { client } = make(reply);
      const answer = await requestResetLink('a@b.example', client);
      expect(answer, name).toEqual({ error: expected });
      // a sentence for a person: no code, no detail of the server, not the mail sentence
      expect(expected, name).not.toMatch(/JV_|stack|boom/);
      expect(expected, name).not.toBe(MAIL_NOT_SET_UP_MESSAGE);
    }
  });
});

describe('resetPassword', () => {
  quietConsole();
  it('sends the token and the new password in the body only, and says ok on the 200', async () => {
    const { client, calls } = make(json(200, { ok: true }));
    await expect(resetPassword(TOKEN, 'a long new phrase 77', client)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/reset-password`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('x-jv-client')).toBe('web');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      token: TOKEN,
      new_password: 'a long new phrase 77',
    });
    // never in the address, never in a header
    const rest = JSON.stringify([calls[0]!.url, [...calls[0]!.headers.entries()]]);
    expect(rest).not.toContain(TOKEN);
    expect(rest).not.toContain('a long new phrase 77');
  });

  it('maps 422 token to "This link has expired or was already used. Ask for a new one."', async () => {
    const { client } = make(
      refusal(422, 'JV_INVALID_INPUT', 'token is not valid', { field: 'token' })
    );
    await expect(resetPassword(TOKEN, 'a long new phrase 77', client)).resolves.toEqual({
      error: 'This link has expired or was already used. Ask for a new one.',
      field: 'token',
    });
  });

  it("shows the API's reason for a refused new password the way the change-password screen does", async () => {
    const { client } = make(
      refusal(422, 'JV_INVALID_INPUT', 'new_password must be at least 10 characters', {
        field: 'new_password',
      })
    );
    await expect(resetPassword(TOKEN, 'short', client)).resolves.toEqual({
      error: 'The new password must be at least 10 characters.',
      field: 'new_password',
    });
  });

  it('maps every other failure to a plain message with no field, and never repeats the token or the password', async () => {
    for (const reply of [
      new TypeError('Failed to fetch'),
      refusal(500, 'JV_INTERNAL', `the token ${TOKEN} and a long new phrase 77 failed`),
      refusal(422, 'JV_INVALID_INPUT', 'something else', { field: 'other' }),
    ]) {
      const { client } = make(reply);
      const answer = await resetPassword(TOKEN, 'a long new phrase 77', client);
      expect('error' in answer && typeof answer.error === 'string' && answer.error !== '').toBe(
        true
      );
      expect('field' in answer).toBe(false);
      const text = JSON.stringify(answer);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('a long new phrase 77');
      expect(text).not.toMatch(/JV_/);
    }
  });
});

describe('after the password is saved the session store looks at the session again (Review Focus 3)', () => {
  const MINE = accessFor('biller');
  const LIFE = { idle_timeout_s: 43200, absolute_expires_at: '2026-10-30T00:00:00.000000Z' };
  const LOGIN_ID = '00000000-0000-4000-8000-000000000001';
  const person = {
    id: LOGIN_ID,
    email: 'biller@jv.test',
    full_name: 'Test biller',
    role: 'biller',
    must_change_password: false,
    role_name: MINE.roleName,
    permissions: MINE.permissions,
    is_super_admin: MINE.isSuperAdmin,
    access: MINE.access,
    reads: MINE.reads,
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 26, 9, 0, 0) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** One browser: the real client and the real session store over a fake server. `me` and the reset route answer as the test says. */
  function browser() {
    const sent: string[] = [];
    const answers = {
      me: () => json(200, { user: person, ...LIFE, pricing_sha256: null }) as Response,
      reset: () => json(200, { ok: true }) as Response,
    };
    const stubbed = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      sent.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/v1/auth/login') {
        const { id, email, full_name, role, must_change_password } = person;
        return json(200, { user: { id, email, full_name, role, must_change_password }, ...LIFE });
      }
      if (path === '/v1/auth/me') return answers.me();
      if (path === '/v1/auth/reset-password') return answers.reset();
      if (path === '/v1/auth/logout' || path === '/v1/auth/activity')
        return json(200, { ok: true });
      throw new TypeError('fetch failed');
    });
    const api = createApiClient({
      baseUrl: BASE,
      fetch: stubbed as unknown as typeof globalThis.fetch,
      sleep: async () => undefined,
    });
    const host = {
      input: new EventTarget(),
      visibility: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
    };
    const store = createSessionStore({ api, host, preview: false });
    const asked = () => sent.filter((call) => call === 'GET /v1/auth/me').length;
    return { api, store, answers, sent, asked };
  }
  const NEW_PASSWORD = 'a long new phrase 77';
  /** The API's answer once every session of the login is ended. */
  const sessionGone = () => refusal(401, 'JV_SESSION_EXPIRED', 'Your session has ended.');

  it('a browser signed in as the login that was reset shows sign-in as soon as the password is saved', async () => {
    const t = browser();
    await expect(t.store.signIn(person.email, 'the-old-one-for-the-test')).resolves.toEqual({
      error: null,
    });
    expect(t.store.getState().status).toBe('signedIn');
    expect(t.asked()).toBe(1);

    // the API ends every session of the login when the new password is saved
    t.answers.me = sessionGone;
    await expect(resetPassword(TOKEN, NEW_PASSWORD, t.api, t.store.reviewRole)).resolves.toEqual({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(t.asked()).toBe(2); // asked at once, not at the next poll
    expect(t.store.getState().status).toBe('signedOut');
    expect(t.store.getState().session).toBeNull();
  });

  it('a browser signed in as another login keeps its session (the reset ended only the sessions of the login of the link)', async () => {
    const t = browser();
    await t.store.signIn(person.email, 'the-old-one-for-the-test');
    const before = t.store.getState();

    await expect(resetPassword(TOKEN, NEW_PASSWORD, t.api, t.store.reviewRole)).resolves.toEqual({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(t.asked()).toBe(2); // it did look
    expect(t.store.getState()).toBe(before); // and nothing changed
    expect(t.store.getState().status).toBe('signedIn');
  });

  it('a refused link or password looks at nothing: the session is as it was', async () => {
    const t = browser();
    await t.store.signIn(person.email, 'the-old-one-for-the-test');
    t.answers.me = sessionGone; // had it looked, sign-in would show
    for (const field of ['token', 'new_password']) {
      t.answers.reset = () =>
        refusal(422, 'JV_INVALID_INPUT', `${field} is refused`, { field }) as Response;
      await expect(
        resetPassword(TOKEN, NEW_PASSWORD, t.api, t.store.reviewRole)
      ).resolves.toMatchObject({
        field,
      });
    }
    t.answers.reset = () => refusal(500, 'JV_INTERNAL', 'boom') as Response;
    await resetPassword(TOKEN, NEW_PASSWORD, t.api, t.store.reviewRole);
    await vi.advanceTimersByTimeAsync(0);

    expect(t.asked()).toBe(1);
    expect(t.store.getState().status).toBe('signedIn');
  });

  it('a browser with nobody signed in makes no extra call', async () => {
    const t = browser();
    t.answers.me = sessionGone;
    t.store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.getState().status).toBe('signedOut');
    const before = t.sent.length;

    await resetPassword(TOKEN, NEW_PASSWORD, t.api, t.store.reviewRole);
    await vi.advanceTimersByTimeAsync(0);

    expect(t.sent.slice(before)).toEqual(['POST /v1/auth/reset-password']);
  });

  it("by default it is the site's own store that is asked, once, after the 200 and not after a refusal", async () => {
    sessionCheck.reviewRole.mockClear();
    await resetPassword(
      TOKEN,
      NEW_PASSWORD,
      make(refusal(422, 'JV_INVALID_INPUT', 'x', { field: 'token' })).client
    );
    await resetPassword(TOKEN, NEW_PASSWORD, make(new TypeError('Failed to fetch')).client);
    expect(sessionCheck.reviewRole).not.toHaveBeenCalled();

    const { client, calls } = make(json(200, { ok: true }));
    await resetPassword(TOKEN, NEW_PASSWORD, client);
    expect(calls).toHaveLength(1);
    expect(sessionCheck.reviewRole).toHaveBeenCalledTimes(1);
  });
});

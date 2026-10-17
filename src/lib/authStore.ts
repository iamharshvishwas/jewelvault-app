'use client';

// The session of the screen on the API: login, `me`, the role, the idle logout, and what a 401 or a 403 does (spec U1, U4 to U8, U11, C16,
// C18). Task WEB02.
//
// There is no login library (U6). A person signs in with an e-mail address and a password at `POST /v1/auth/login`; the API puts the
// session in the cookie `__Host-jv_session`, which JavaScript cannot read, and the role of the person is what `GET /v1/auth/me` says (U5, A2):
// never what the login answered, and never anything kept in the browser. Nothing is written to localStorage, sessionStorage or IndexedDB
// here (C8).
//
// ONE state lives at module level, so it does not depend on which page is open: every page wraps itself in AppLayout, and AppLayout (the
// gate: loading screen, login screen, then the app, U7) and every page read it through `useSession`. No page reads the session on its own.
// The state changes only on login, logout, `me` and a 401 (U6):
//
//   loading             the screen is asking `me` (start-up)
//   signedOut           the login screen; `notice` says why the person is back, when it is not their own doing
//   mustChangePassword  a signed-in person whose password is a temporary one (U11): the change-password screen is the only screen
//   signedIn            the app; `role` is the role of `me`
//   error               `me` could not be asked (no connection, a server that is down): a retry button, never the login screen
//
// What empties memory: the stores that hold business data (WEB03) and the pollers (WEB04) register one function each with
// `registerLogoutHook`. Every end of a session runs all of them: a logout, the idle logout, any 401, another person signing in on top, and
// a change of role (the gate then opens again with the new role: `epoch` counts the openings, so a store can hydrate again and the layout
// can start the page afresh).
//
// A poller that gets `403 JV_FORBIDDEN`, or an answer whose `role` is not the one of the session, pauses and calls `reviewRole()` once: it
// asks `me`, and gets 'changed' (memory emptied, gate open again with the new role), 'same' (show the error once), 'ended' (the login
// screen is up) or 'unknown' (`me` could not be asked: nothing was changed).

import { useSyncExternalStore } from 'react';
import { api as siteApi, isApiError, type ApiClient, type ApiError } from '@/lib/api/client';
import type { LoginResponse } from '@/lib/api/types';
import { PREVIEW_MODE } from '@/lib/previewMode';

export type AuthRole = 'owner' | 'biller' | 'staff';

export const ROLE_LABEL: Record<AuthRole, string> = {
  owner: 'Owner',
  biller: 'Biller',
  staff: 'Staff',
};

export interface AuthSession {
  userId: string;
  email: string;
  /** The real name of the person, as the owner gave it to the admin door. */
  displayName: string;
  role: AuthRole;
  /** The password is a temporary one and must be changed before anything else (U11). */
  mustChangePassword: boolean;
}

/** Two letters for the round avatar: the first letters of the first and the last word of the name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

function isRole(value: unknown): value is AuthRole {
  return value === 'owner' || value === 'biller' || value === 'staff';
}

// ------------------------------------------------------------------------------------------------ screens by role

// Spec 1.3, "Screens by role": a front-end rule that mirrors the rules of the API (the API is the real wall, section 3). A route that is
// not in this list is closed to everybody, which is how the screens that are "hidden in M1" (/order-book, /catalogue,
// /customer-catalogue) stay hidden. /scan-detail is not in the table of 1.3; it stays as the prototype had it, for the owner only.
const SCREENS: ReadonlyArray<{ path: string; roles: readonly AuthRole[] }> = [
  { path: '/', roles: ['owner', 'biller', 'staff'] },
  { path: '/billing-pos', roles: ['owner', 'biller'] },
  { path: '/estimate', roles: ['owner', 'biller'] },
  { path: '/customer-ledger', roles: ['owner', 'biller'] },
  { path: '/inventory-management', roles: ['owner', 'biller', 'staff'] },
  { path: '/design-detail', roles: ['owner', 'biller', 'staff'] },
  { path: '/print-tags', roles: ['owner', 'biller', 'staff'] },
  { path: '/add-design', roles: ['owner', 'staff'] },
  { path: '/edit-stock', roles: ['owner', 'staff'] },
  { path: '/reports', roles: ['owner'] },
  { path: '/settings', roles: ['owner'] },
  { path: '/scan-detail', roles: ['owner'] },
];

function normalisePath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed || '/';
}

/** May this role open this route (or follow this link, which may carry a query)? A person with no role opens nothing. */
export function canAccessPath(role: AuthRole | null, pathname: string): boolean {
  if (!role) return false;
  const path = normalisePath(pathname);
  const screen = SCREENS.find((s) =>
    s.path === '/' ? path === '/' : path === s.path || path.startsWith(`${s.path}/`)
  );
  return Boolean(screen && screen.roles.includes(role));
}

// ------------------------------------------------------------------------------------------------ idle logout and the activity call

/** C16, U4: the screen logs out by itself after 12 hours without a click or key press. A choice for Siddhi (O42). */
export const IDLE_LIMIT_MS = 12 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 1000;
/** U4: the activity call goes out on a click or key press, at most once a minute. */
const ACTIVITY_MIN_GAP_MS = 60 * 1000;
/** How long a login waits for a logout that is still on its way: its `Set-Cookie` must not clear the cookie of the new session. */
const LOGOUT_WAIT_MS = 3000;

export function isIdle(now: number, lastActivity: number): boolean {
  return now - lastActivity >= IDLE_LIMIT_MS;
}

export const IDLE_NOTICE =
  'You were signed out after 12 hours without a click or key press. Sign in again to continue.';

// ------------------------------------------------------------------------------------------------ the state

export type SessionStatus = 'loading' | 'signedOut' | 'mustChangePassword' | 'signedIn' | 'error';

export interface SessionState {
  status: SessionStatus;
  session: AuthSession | null;
  /** The role of the session while the app is open (status "signedIn"); null in every other state, so that no route opens. */
  role: AuthRole | null;
  /** Why the person is looking at the login screen (the session ended, 12 hours idle), or null. */
  notice: string | null;
  /** Why `me` could not be asked (status "error"), or null. */
  error: string | null;
  /** How many times the gate has been opened for a person and a role: it goes up on a login, at start-up and on a change of role. */
  epoch: number;
}

const LOADING: SessionState = {
  status: 'loading',
  session: null,
  role: null,
  notice: null,
  error: null,
  epoch: 0,
};

/** The answer of `reviewRole`: see the top of this file. */
export type RoleReview = 'changed' | 'same' | 'ended' | 'unknown';

export interface SignInResult {
  /** A plain message for the screen, or null when it worked. */
  error: string | null;
}

/** Where the store listens for clicks, key presses and the tab coming back: the window and the document of the page. */
export interface SessionHost {
  input: EventTarget;
  visibility: EventTarget & { visibilityState?: string };
}

/** What the store needs of the API client. */
export type SessionApi = Pick<
  ApiClient,
  'login' | 'me' | 'logout' | 'activity' | 'changePassword' | 'onUnauthorized'
>;

export interface SessionDeps {
  api: SessionApi;
  /** Default: the window and the document of the page, or none on the server. `null` is none. */
  host?: SessionHost | null;
  /** Preview mode: open as the owner and call nothing (see PREVIEW_MODE). */
  preview?: boolean;
}

export interface SessionStore {
  getState(): SessionState;
  /** For useSyncExternalStore. The first listener starts the store: the 401 hook is registered and `me` is asked. */
  subscribe(listener: () => void): () => void;
  /** Registers the 401 hook and asks `me`, once. Does nothing on the server. */
  start(): void;
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(notice?: string | null): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<SignInResult>;
  /** The "Try again" of the error screen. */
  retry(): void;
  reviewRole(): Promise<RoleReview>;
  registerLogoutHook(hook: () => void): () => void;
}

const PREVIEW_STATE: SessionState = {
  status: 'signedIn',
  session: {
    userId: 'preview',
    email: 'preview@example.invalid',
    displayName: 'Preview',
    role: 'owner',
    mustChangePassword: false,
  },
  role: 'owner',
  notice: null,
  error: null,
  epoch: 0,
};

const NOT_CONNECTED = 'This copy of the application is not connected to its server.';
const TRY_AGAIN = 'Could not sign in. Try again.';
const COOKIE_REFUSED =
  'Could not sign in: the browser did not keep the session. Check that cookies are allowed for this site.';
const PASSWORD_CHANGED_SIGN_IN = 'Your password was changed. Sign in with the new one.';

function browserHost(): SessionHost | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return { input: window, visibility: document };
}

const messageOf = (error: unknown, fallback: string) =>
  isApiError(error) ? error.message : fallback;

/** The reason the API gave for a refused new password, as a sentence of its own ("new_password must be at least 10 characters"). */
function newPasswordReason(message: string): string {
  const match = /^new_password (.+?)\.?(?: Nothing was changed\.)?$/.exec(message.trim());
  return match ? `The new password ${match[1]}.` : 'The new password is not accepted.';
}

function changePasswordMessage(error: unknown): string {
  if (!isApiError(error)) return 'Could not change the password. Try again.';
  if (error.code === 'JV_INVALID_INPUT') {
    if (error.details.field === 'current_password') return 'The current password is not correct.';
    if (error.details.field === 'new_password') return newPasswordReason(error.message);
  }
  return error.message;
}

// ------------------------------------------------------------------------------------------------ the store

/**
 * One store. The site makes exactly one, below, over its API client; the tests make their own over a stubbed `fetch` and a fake window.
 * Every function is safe to call twice, and none of them loops: a 401 or a 403 is answered once.
 */
export function createSessionStore(deps: SessionDeps): SessionStore {
  const { api } = deps;
  const preview = deps.preview ?? false;
  const listeners = new Set<() => void>();
  const logoutHooks = new Set<() => void>();

  let state: SessionState = preview ? PREVIEW_STATE : LOADING;
  let started = false;
  let unauthorizedOff: (() => void) | null = null;
  /** Bumped by every end of a session and every new sign-in, so that a slow answer never lands on a newer state. */
  let generation = 0;
  /** The logout that was started last; a login waits for it (for at most 3 seconds). */
  let signingOut: Promise<void> = Promise.resolve();
  let signInFlight: Promise<SignInResult> | null = null;
  let reviewing: Promise<RoleReview> | null = null;
  // the idle watch
  let watchHost: SessionHost | null = null;
  let lastActivity = 0;
  let lastActivitySent = 0;
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  const watching = (s: SessionState) =>
    s.status === 'signedIn' || s.status === 'mustChangePassword';
  const hostOf = () => (deps.host === undefined ? browserHost() : deps.host);

  function setState(next: SessionState): void {
    const was = watching(state);
    state = next;
    if (watching(next) && !was) startIdleWatch();
    if (!watching(next) && was) stopIdleWatch();
    for (const listener of Array.from(listeners)) listener();
  }

  // ---- U8: what empties memory
  function runHooks(): void {
    for (const hook of Array.from(logoutHooks)) {
      try {
        hook();
      } catch (error) {
        console.warn('A logout hook failed', error);
      }
    }
  }

  /** Everything that happens on this screen when the session ends, whatever the cause. Safe to call twice. */
  function endSession(notice: string | null): void {
    if (state.status === 'signedOut') return;
    generation += 1;
    runHooks(); // U8: caches emptied, pollers stopped
    setState({ ...LOADING, status: 'signedOut', notice, epoch: state.epoch });
  }

  // ---- U6: any 401 except the wrong password of the login screen (the client does not call this for JV_BAD_LOGIN)
  function onUnauthorized(error: ApiError): void {
    if (state.status === 'signedOut') return; // once: later 401s of calls already on their way change nothing
    // At start-up a 401 only means that nobody is signed in: no notice. A session that has ended is told.
    const quiet = state.status === 'loading' && error.code !== 'JV_SESSION_EXPIRED';
    endSession(quiet ? null : error.message);
  }

  function listen(): void {
    if (preview || unauthorizedOff) return;
    unauthorizedOff = api.onUnauthorized(onUnauthorized);
  }

  // ---- a person arrives: the state of `me`
  /** Opens the gate for the person `me` describes (U5, U11). Pass hooksRun when memory has been emptied already. */
  function settle(me: LoginResponse, { hooksRun = false }: { hooksRun?: boolean } = {}): void {
    const user = me.user;
    if (!isRole(user.role)) {
      console.warn('The API sent a role this screen does not know');
      setState({ ...LOADING, status: 'error', error: NOT_CONNECTED, epoch: state.epoch });
      return;
    }
    const mustChange = user.must_change_password === true;
    const previous = state;
    const wasIn = watching(previous) && previous.session !== null;
    const sameUser = wasIn && previous.session?.userId === user.id;
    // Another person signing in on top of a signed-in one (another tab): the first person's data goes first.
    if (wasIn && !sameUser && !hooksRun) runHooks();
    const unchanged =
      sameUser && !mustChange && previous.status === 'signedIn' && previous.role === user.role;
    lastActivitySent = Date.now(); // the login and `me` count as activity on the server (U4)
    setState({
      status: mustChange ? 'mustChangePassword' : 'signedIn',
      session: {
        userId: user.id,
        email: user.email,
        displayName: user.full_name || user.email,
        role: user.role,
        mustChangePassword: mustChange,
      },
      role: mustChange ? null : user.role,
      notice: null,
      error: null,
      epoch: unchanged ? previous.epoch : previous.epoch + 1,
    });
  }

  /** U5: at start-up the screen asks `me`; the role it returns decides what exists. */
  async function bootstrap(): Promise<void> {
    const mine = ++generation;
    if (state.status !== 'loading') setState({ ...LOADING, epoch: state.epoch });
    try {
      const me = await api.me();
      if (mine !== generation) return;
      settle(me);
    } catch (error) {
      if (mine !== generation) return; // the 401 hook, a sign-in or a sign-out took over
      if (isApiError(error) && error.status === 401) {
        endSession(null);
        return;
      }
      console.warn('The session could not be read', isApiError(error) ? error.code : error);
      setState({
        ...LOADING,
        status: 'error',
        error: isApiError(error) ? error.message : NOT_CONNECTED,
        epoch: state.epoch,
      });
    }
  }

  function start(): void {
    if (started) return;
    if (hostOf() === null) return; // the server, building the static pages: nobody to ask
    started = true;
    if (preview) return;
    try {
      listen();
      void bootstrap();
    } catch (error) {
      console.warn('The session store could not start', error);
      // not inside the subscription that started it: a state change there would update a component that is still mounting
      void Promise.resolve().then(() =>
        setState({ ...LOADING, status: 'error', error: NOT_CONNECTED, epoch: state.epoch })
      );
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
    };
  }

  // ---- sign in
  async function waitForLogout(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOGOUT_WAIT_MS);
    });
    try {
      await Promise.race([signingOut, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function doSignIn(email: string, password: string): Promise<SignInResult> {
    listen();
    if (state.status === 'signedOut' && state.notice) setState({ ...state, notice: null });
    await waitForLogout();
    const mine = ++generation;
    try {
      await api.login(email.trim(), password);
    } catch (error) {
      // JV_BAD_LOGIN is one message for a wrong password and an unknown address (U1); a user who is not active is told so.
      return { error: messageOf(error, TRY_AGAIN) };
    }
    try {
      const me = await api.me(); // U5: after login the screen asks `me`; its role is the role
      if (mine !== generation) return { error: TRY_AGAIN };
      settle(me);
      return { error: null };
    } catch (error) {
      if (isApiError(error) && error.status === 401) return { error: COOKIE_REFUSED };
      return { error: messageOf(error, TRY_AGAIN) };
    }
  }

  function signIn(email: string, password: string): Promise<SignInResult> {
    if (preview) return Promise.resolve({ error: 'Signing in is switched off in the preview.' });
    if (signInFlight) return signInFlight; // two presses of the button are one login
    const run = doSignIn(email, password).finally(() => {
      signInFlight = null;
    });
    signInFlight = run;
    return run;
  }

  // ---- U11: the temporary password
  async function changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<SignInResult> {
    if (preview || !watching(state)) return { error: 'Sign in first.' };
    listen();
    const mine = generation;
    let changed: LoginResponse;
    try {
      changed = await api.changePassword(currentPassword, newPassword);
    } catch (error) {
      return { error: changePasswordMessage(error) };
    }
    if (mine !== generation) return { error: PASSWORD_CHANGED_SIGN_IN };
    let me: LoginResponse = changed;
    try {
      me = await api.me(); // also fills the pricing check of C12
    } catch (error) {
      if (isApiError(error) && error.status === 401) return { error: PASSWORD_CHANGED_SIGN_IN };
      // `me` could not be asked: the answer of the change is as good (the person is in); the pricing check waits for the next `me`
    }
    if (mine !== generation) return { error: PASSWORD_CHANGED_SIGN_IN };
    settle(me);
    return { error: null };
  }

  // ---- sign out
  /**
   * U8: empties every in-memory cache and stops every poller at once, shows the login screen, then calls `POST /v1/auth/logout` (the
   * session is ended and the cookie cleared; a server that cannot be reached changes nothing on this screen). A session that a 401 has
   * ended is not logged out again: it is over already.
   */
  function signOut(notice: string | null = null): Promise<void> {
    if (preview) {
      // There is no login to leave: empty the caches and stay on the preview.
      runHooks();
      return Promise.resolve();
    }
    if (state.status === 'signedOut') return signingOut;
    listen();
    endSession(notice);
    // One after the other, and the next login waits for the last: a login made while an older logout is still on its way to the server
    // would otherwise have its new cookie cleared when that logout's answer arrives.
    const done = signingOut.then(async () => {
      try {
        await api.logout();
      } catch {
        // the screen is signed out whatever the server says; a 401 means the session was over already
      }
    });
    signingOut = done;
    return done;
  }

  // ---- U6, C18: a 403 from the poll, or a poll answer with another role
  function reviewRole(): Promise<RoleReview> {
    if (preview) return Promise.resolve('same');
    if (reviewing) return reviewing; // two 403s at the same moment are one `me`
    if (!watching(state)) return Promise.resolve('ended');
    listen();
    const mine = generation;
    const run = (async (): Promise<RoleReview> => {
      let me: LoginResponse;
      try {
        me = await api.me();
      } catch (error) {
        if (isApiError(error) && error.status === 401) return 'ended'; // the hook has shown the login screen
        return 'unknown';
      }
      if (mine !== generation) return 'ended'; // the person left while `me` was on its way
      const previous = state;
      const mustChange = me.user.must_change_password === true;
      const same =
        previous.session?.userId === me.user.id &&
        previous.status === (mustChange ? 'mustChangePassword' : 'signedIn') &&
        previous.role === (mustChange ? null : me.user.role);
      if (same) return 'same';
      runHooks(); // the owner-only data, sku_private and the audit data included; the pollers stop
      settle(me, { hooksRun: true });
      return 'changed';
    })().finally(() => {
      reviewing = null;
    });
    reviewing = run;
    return run;
  }

  function retry(): void {
    if (preview || state.status !== 'error') return;
    listen();
    void bootstrap();
  }

  function registerLogoutHook(hook: () => void): () => void {
    logoutHooks.add(hook);
    return () => {
      logoutHooks.delete(hook);
    };
  }

  // ---- the idle watch (C16) and the activity call (U4)
  function onInput(): void {
    const now = Date.now();
    lastActivity = now;
    // The password screen sends nothing: the API answers only three calls to a person who must change the password.
    if (state.status !== 'signedIn' || now - lastActivitySent < ACTIVITY_MIN_GAP_MS) return;
    lastActivitySent = now;
    // A failure is not repeated by itself (the next click after a minute tries again); a 401 reaches the gate through the client's hook.
    api.activity().catch(() => undefined);
  }

  function checkIdle(): void {
    if (watching(state) && isIdle(Date.now(), lastActivity)) void signOut(IDLE_NOTICE);
  }

  function checkIdleWhenVisible(): void {
    if (watchHost?.visibility.visibilityState === 'visible') checkIdle();
  }

  function startIdleWatch(): void {
    if (preview) return;
    const host = hostOf();
    if (host === null) return;
    stopIdleWatch();
    watchHost = host;
    lastActivity = lastActivitySent = Date.now();
    // Capture, so a screen that stops the event on its way down still counts. A tap on a phone is a click.
    host.input.addEventListener('click', onInput, true);
    host.input.addEventListener('keydown', onInput, true);
    host.visibility.addEventListener('visibilitychange', checkIdleWhenVisible);
    // Compared with the clock, not counted: a laptop that slept for the night is logged out at the first check on waking.
    idleTimer = setInterval(checkIdle, IDLE_CHECK_MS);
  }

  function stopIdleWatch(): void {
    if (watchHost) {
      watchHost.input.removeEventListener('click', onInput, true);
      watchHost.input.removeEventListener('keydown', onInput, true);
      watchHost.visibility.removeEventListener('visibilitychange', checkIdleWhenVisible);
      watchHost = null;
    }
    if (idleTimer !== undefined) clearInterval(idleTimer);
    idleTimer = undefined;
  }

  return {
    getState: () => state,
    subscribe,
    start,
    signIn,
    signOut,
    changePassword,
    retry,
    reviewRole,
    registerLogoutHook,
  };
}

// ------------------------------------------------------------------------------------------------ the store of the site

/** Preview mode (see src/lib/previewMode.ts): the front end opens as the owner with no login and no server, on sample data. Off unless the build says so. WEB15 removes it. */
export { PREVIEW_MODE };

const store = createSessionStore({ api: siteApi, preview: PREVIEW_MODE });

/** The state for code that is not a component (the stores, the pollers). Components use useSession. */
export const getSessionState = store.getState;
export const subscribeSession = store.subscribe;
export const signIn = store.signIn;
export const signOut = store.signOut;
export const changePassword = store.changePassword;
export const retrySession = store.retry;
/** A poller calls this once for each 403 JV_FORBIDDEN, and when a poll answer names another role than the session's (U6, C18). */
export const reviewRole = store.reviewRole;
/**
 * U8: logout empties every in-memory cache and stops every poller. The stores that hold business data (WEB03) and the pollers (WEB04)
 * register one function each here; every end of a session, whatever its cause, runs all of them, and so does a change of role. Returns the
 * way to unregister.
 */
export const registerLogoutHook = store.registerLogoutHook;

/** U7: pages read the role from here. The server and the first client render say "loading", so the HTML matches. */
export function useSession(): SessionState {
  return useSyncExternalStore(store.subscribe, store.getState, () => LOADING);
}

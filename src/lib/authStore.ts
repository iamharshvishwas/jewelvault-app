'use client';

// Login, the session, the role and the idle logout (spec U1, U4 to U8, C16). Task FE02.
//
// There are no logins in this file any more (U1): the prototype's two hard-coded logins are gone from the code and from the build.
// A person signs in with an e-mail address and a password through Supabase Auth, and the role comes from their own row in
// `profiles` and nowhere else (R-role-1, A2): never from the token or from the login's metadata, which the person can edit.
//
// ONE state lives at module level, so it does not depend on which page is open: every page wraps itself in AppLayout, and
// AppLayout (the gate: loading screen, login screen, then the app, U7) and every page read it through `useSession`. No
// page reads the session on its own.

import { useSyncExternalStore } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase/client';

export type AuthRole = 'owner' | 'biller' | 'staff';

export const ROLE_LABEL: Record<AuthRole, string> = {
  owner: 'Owner',
  biller: 'Biller',
  staff: 'Staff',
};

export interface AuthSession {
  userId: string;
  email: string;
  /** The real name on the person's profile (private.activate_user sets it). */
  displayName: string;
  role: AuthRole;
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

// Spec 1.3, "Screens by role": a front-end rule that mirrors the database rules (the database is the real wall). A route
// that is not in this list is closed to everybody, which is how the screens that are "hidden in M1" (/order-book,
// /catalogue, /customer-catalogue) stay hidden. /scan-detail is not in the table of 1.3; it stays as the prototype had it,
// for the owner only.
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

// ------------------------------------------------------------------------------------------------ idle logout

/** C16, U4: the screen logs out by itself after 12 hours without a click or key press. A choice for Siddhi (O10b). */
export const IDLE_LIMIT_MS = 12 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 1000;

export function isIdle(now: number, lastActivity: number): boolean {
  return now - lastActivity >= IDLE_LIMIT_MS;
}

// ------------------------------------------------------------------------------------------------ the state

export type SessionStatus = 'loading' | 'signedOut' | 'signedIn' | 'error';

export interface SessionState {
  status: SessionStatus;
  session: AuthSession | null;
  /** Shorthand for session?.role; null unless the person is signed in with an active profile. */
  role: AuthRole | null;
  /** Why the person is looking at the login screen (not active, idle for 12 hours), or null. */
  notice: string | null;
  /** Why the session could not be loaded (status "error"), or null. */
  error: string | null;
}

const LOADING: SessionState = {
  status: 'loading',
  session: null,
  role: null,
  notice: null,
  error: null,
};

export const NOT_ACTIVE_NOTICE = 'Your account is not active. Ask the owner to activate it.';
export const IDLE_NOTICE =
  'You were signed out after 12 hours without a click or key press. Sign in again to continue.';

/**
 * Preview mode: a build made with NEXT_PUBLIC_PREVIEW_MODE=1 opens every screen as the owner, with no login and no call to
 * Supabase or any server, so the front end can be looked at before a back end exists. The data on the screens is the
 * prototype's own sample data, kept in this browser only, and a banner says so (AppLayout). The variable is written out in
 * full because Next.js replaces exactly that text at build time. It is off unless set: a real build never opens like this.
 */
export const PREVIEW_MODE = process.env.NEXT_PUBLIC_PREVIEW_MODE === '1';

const PREVIEW_STATE: SessionState = {
  status: 'signedIn',
  session: {
    userId: 'preview',
    email: 'preview@example.invalid',
    displayName: 'Preview',
    role: 'owner',
  },
  role: 'owner',
  notice: null,
  error: null,
};

let state: SessionState = PREVIEW_MODE ? PREVIEW_STATE : LOADING;
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  const wasSignedIn = state.status === 'signedIn';
  state = next;
  if (next.status === 'signedIn' && !wasSignedIn) startIdleWatch();
  if (next.status !== 'signedIn' && wasSignedIn) stopIdleWatch();
  listeners.forEach((listener) => listener());
}

/** The state for code that is not a component (the stores, the pollers). Components use useSession. */
export function getSessionState(): SessionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureStarted();
  return () => {
    listeners.delete(listener);
  };
}

/** U7: pages read the role from here. The server and the first client render say "loading", so the HTML matches. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, getSessionState, () => LOADING);
}

// ------------------------------------------------------------------------------------------------ logout hooks

const logoutHooks = new Set<() => void>();

/**
 * U8: logout empties every in-memory cache and stops every poller. The stores that hold business data (FE03) and the
 * pollers (FE04) register one function each here; every sign-out, whatever its cause, runs all of them. Returns the way
 * to unregister.
 */
export function registerLogoutHook(hook: () => void): () => void {
  logoutHooks.add(hook);
  return () => {
    logoutHooks.delete(hook);
  };
}

function runLogoutHooks(): void {
  for (const hook of Array.from(logoutHooks)) {
    try {
      hook();
    } catch (error) {
      console.warn('A logout hook failed', error);
    }
  }
}

// ------------------------------------------------------------------------------------------------ the auth events

let started = false;
/** Bumped by every sign-in of another person and every sign-out, so a slow profile read never lands on a newer state. */
let generation = 0;
let loadingFor: { userId: string; email: string } | null = null;

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (PREVIEW_MODE) return; // no Supabase client in preview mode
  try {
    getSupabase().auth.onAuthStateChange(onAuthEvent);
  } catch (error) {
    console.warn('The Supabase client could not start', error);
    window.setTimeout(
      () =>
        setState({
          ...LOADING,
          status: 'error',
          error: 'This copy of the application is not connected to its database.',
        }),
      0
    );
  }
}

/**
 * U6, docs #13: no Supabase call is awaited in here and none is made in here. The handler only sets state, and defers
 * every call (the profile read, the sign-out) with setTimeout(0), because a call made inside it can deadlock the client.
 */
function onAuthEvent(event: AuthChangeEvent, authSession: Session | null): void {
  // The hourly refresh and a changed profile of the login change nothing the screen shows.
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY')
    return;

  if (!authSession) {
    // The first look found no session, or SIGNED_OUT: this tab, another tab, or a refresh that the server refused.
    window.setTimeout(() => endSession(null), 0);
    return;
  }

  const userId = authSession.user.id;
  // The library repeats SIGNED_IN with the same session when a hidden tab becomes visible again: not a new sign-in.
  if (state.status === 'signedIn' && state.session?.userId === userId) return;
  if (loadingFor?.userId === userId) return;

  // Another person signing in on top of a signed-in one (another tab): the first person's data goes first.
  if (state.status === 'signedIn') runLogoutHooks();
  const target = { userId, email: authSession.user.email ?? '' };
  loadingFor = target;
  const mine = ++generation;
  setState(LOADING);
  window.setTimeout(() => void loadProfile(target, mine), 0);
}

/** U5: after login the screen reads its own profile row; the role is what that row says. */
async function loadProfile(target: { userId: string; email: string }, mine: number): Promise<void> {
  let profile: { full_name: unknown; role: unknown; active: unknown } | null = null;
  let failure: unknown = null;
  try {
    const { data, error } = await getSupabase()
      .from('profiles')
      .select('id, full_name, role, active')
      .eq('id', target.userId)
      .maybeSingle();
    profile = data;
    failure = error;
  } catch (error) {
    failure = error;
  }
  if (mine !== generation) return; // somebody signed out or in while the row was on its way

  if (failure) {
    console.warn('The profile could not be read', failure);
    setState({
      ...LOADING,
      status: 'error',
      error: 'Could not load your account. Check your internet connection and try again.',
    });
    return;
  }
  // An inactive login, or one with no profile, reads nothing (A10): the answer is no row. Either way it is not active.
  if (!profile || profile.active !== true || !isRole(profile.role)) {
    loadingFor = null;
    await signOut(NOT_ACTIVE_NOTICE);
    return;
  }
  loadingFor = null;
  setState({
    status: 'signedIn',
    session: {
      userId: target.userId,
      email: target.email,
      displayName: typeof profile.full_name === 'string' ? profile.full_name : target.email,
      role: profile.role,
    },
    role: profile.role,
    notice: null,
    error: null,
  });
}

/** The "Try again" of the error screen. */
export function retryProfile(): void {
  if (state.status !== 'error' || !loadingFor) return;
  const target = loadingFor;
  const mine = ++generation;
  setState(LOADING);
  window.setTimeout(() => void loadProfile(target, mine), 0);
}

/** Everything that happens on this screen when the session ends, whatever the cause. Safe to call twice. */
function endSession(notice: string | null): void {
  if (state.status === 'signedOut') return;
  generation++;
  loadingFor = null;
  runLogoutHooks(); // U8: caches emptied, pollers stopped
  setState({ status: 'signedOut', session: null, role: null, notice, error: null });
}

// ------------------------------------------------------------------------------------------------ sign in and out

/** The sign-out that was started last; signIn waits for it (for at most 3 seconds). */
let signingOut: Promise<void> = Promise.resolve();

export interface SignInResult {
  /** A plain message for the login screen, or null when the sign-in worked. */
  error: string | null;
}

/** Signs in with e-mail and password. The screen then fills itself through the auth event (the state above). */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (state.status === 'signedOut' && state.notice) setState({ ...state, notice: null });
  // Wait for an older sign-out, but not for ever: a server that does not answer must not keep the screen from signing in.
  await Promise.race([
    signingOut,
    new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
  ]);
  try {
    const { error } = await getSupabase().auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (!error) return { error: null };
    // One message for a wrong password and an unknown address, so the screen does not say which one was wrong (U1).
    if (error.code === 'invalid_credentials') return { error: 'Wrong email or password.' };
    if (error.code === 'user_banned') return { error: NOT_ACTIVE_NOTICE };
    if (error.status === 429 || error.code === 'over_request_rate_limit') {
      return { error: 'Too many attempts. Wait a minute and try again.' };
    }
    if (error.name === 'AuthRetryableFetchError') {
      return { error: 'Could not reach the server. Check your internet connection and try again.' };
    }
    console.warn('Sign-in failed', error);
    return { error: 'Could not sign in. Try again.' };
  } catch (error) {
    console.warn('Sign-in failed', error);
    return { error: 'Could not sign in. Try again.' };
  }
}

/**
 * U8: signs out of Supabase, empties every in-memory cache and stops every poller. The screen goes to the login screen at
 * once; the library then ends the session on the server and removes it from the browser, also when the network is down.
 * Only this browser's session ends ("local"): the same person's other devices stay signed in.
 */
export function signOut(notice: string | null = null): Promise<void> {
  if (PREVIEW_MODE) {
    // There is no login to leave: empty the caches and stay on the preview.
    runLogoutHooks();
    return Promise.resolve();
  }
  endSession(notice);
  // One after the other, and signIn waits for the last: a sign-in made while an older sign-out is still on its way to the
  // server would otherwise have its new session removed when that sign-out finishes.
  const done = signingOut.then(async () => {
    try {
      const { error } = await getSupabase().auth.signOut({ scope: 'local' });
      if (error) console.warn('Sign-out reached the library with an error', error);
    } catch (error) {
      console.warn('Sign-out failed', error);
    }
  });
  signingOut = done;
  return done;
}

// ------------------------------------------------------------------------------------------------ idle watch

let lastActivity = 0;
let idleTimer: number | undefined;

function markActivity(): void {
  lastActivity = Date.now();
}

function checkIdle(): void {
  if (state.status === 'signedIn' && isIdle(Date.now(), lastActivity)) void signOut(IDLE_NOTICE);
}

function checkIdleWhenVisible(): void {
  if (document.visibilityState === 'visible') checkIdle();
}

function startIdleWatch(): void {
  if (typeof window === 'undefined') return;
  stopIdleWatch();
  lastActivity = Date.now();
  // Capture, so a screen that stops the event on its way down still counts. A tap on a phone is a click.
  window.addEventListener('click', markActivity, true);
  window.addEventListener('keydown', markActivity, true);
  document.addEventListener('visibilitychange', checkIdleWhenVisible);
  // Compared with the clock, not counted: a laptop that slept for the night is logged out at the first check on waking.
  idleTimer = window.setInterval(checkIdle, IDLE_CHECK_MS);
}

function stopIdleWatch(): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('click', markActivity, true);
  window.removeEventListener('keydown', markActivity, true);
  document.removeEventListener('visibilitychange', checkIdleWhenVisible);
  if (idleTimer !== undefined) window.clearInterval(idleTimer);
  idleTimer = undefined;
}

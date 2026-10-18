// Preview mode (NEXT_PUBLIC_PREVIEW_MODE=1): the front end opens as the owner with no login and no server call, so it can be
// looked at before a back end exists (it stays until WEB15). It must be off unless the variable is exactly "1": a real build never
// opens like this. authStore reads the variable once, when the module loads, so each case imports a fresh copy of it.
// WEB02: the API client replaces the Supabase client here; in preview mode not one call may reach it, on start-up, sign-out or a click.
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Any use of the API client in preview mode is a failure: every member of it throws when it is touched. */
const touched: string[] = [];
const fakeApi = new Proxy(
  {},
  {
    get(_target, name) {
      touched.push(String(name));
      throw new Error(`The API client must not be used in preview mode (${String(name)})`);
    },
  }
);
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  api: fakeApi,
}));

async function loadAuthStore(previewValue: string | undefined) {
  vi.resetModules();
  touched.length = 0;
  if (previewValue === undefined) vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  else vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', previewValue);
  return import('@/lib/authStore');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('preview mode', () => {
  it('is off when the variable is not set, and the gate starts on the loading screen', async () => {
    const auth = await loadAuthStore(undefined);
    expect(auth.PREVIEW_MODE).toBe(false);
    expect(auth.getSessionState().status).toBe('loading');
    expect(auth.getSessionState().session).toBeNull();
  });

  it.each(['0', 'true', 'yes', ' 1', '1 '])(
    'is off for the value %j: only exactly "1" turns it on',
    async (value) => {
      const auth = await loadAuthStore(value);
      expect(auth.PREVIEW_MODE).toBe(false);
      expect(auth.getSessionState().status).toBe('loading');
    }
  );

  it('is on for "1": signed in as the owner, so every owner screen opens', async () => {
    const auth = await loadAuthStore('1');
    expect(auth.PREVIEW_MODE).toBe(true);
    const state = auth.getSessionState();
    expect(state.status).toBe('signedIn');
    expect(state.role).toBe('owner');
    expect(state.session?.displayName).toBe('Preview');
    expect(state.session?.mustChangePassword).toBe(false);
    for (const route of ['/', '/billing-pos', '/reports', '/settings', '/inventory-management']) {
      expect(auth.canAccessPath(state.role, route)).toBe(true);
    }
  });

  it('never calls the API: not on start-up (a page subscribing), not on sign-out, and a sign-out empties the caches but stays on the preview', async () => {
    // a browser: a window to listen on, so that a store that would start itself has every chance to
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const auth = await loadAuthStore('1');
    const listener = vi.fn();
    const off = auth.subscribeSession(listener);
    const hook = vi.fn();
    auth.registerLogoutHook(hook);
    await auth.signOut();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(auth.getSessionState().status).toBe('signedIn');
    off();
    expect(touched).toEqual([]);
  });

  it('a real build in a browser does start itself: the same subscription asks the API (the negative control)', async () => {
    // the stand-in refuses every use, so the store reports that it could not start: the console line is expected
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const auth = await loadAuthStore(undefined);
    const off = auth.subscribeSession(() => undefined);
    await Promise.resolve();
    expect(touched).toContain('onUnauthorized');
    off();
    warn.mockRestore();
  });
});

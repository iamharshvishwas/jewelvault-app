// Preview mode (NEXT_PUBLIC_PREVIEW_MODE=1): the front end opens as the owner with no login and no server call, so it can be
// looked at before a back end exists. It must be off unless the variable is exactly "1": a real build never opens like this.
// authStore reads the variable once, when the module loads, so each case imports a fresh copy of it.
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSupabase = vi.fn(() => {
  throw new Error('Supabase must not be used in preview mode');
});
vi.mock('@/lib/supabase/client', () => ({ getSupabase }));

async function loadAuthStore(previewValue: string | undefined) {
  vi.resetModules();
  getSupabase.mockClear();
  if (previewValue === undefined) vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  else vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', previewValue);
  return import('@/lib/authStore');
}

afterEach(() => {
  vi.unstubAllEnvs();
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
    for (const route of ['/', '/billing-pos', '/reports', '/settings', '/inventory-management']) {
      expect(auth.canAccessPath(state.role, route)).toBe(true);
    }
  });

  it('never calls Supabase, also on sign-out, and a sign-out empties the caches but stays on the preview', async () => {
    const auth = await loadAuthStore('1');
    const hook = vi.fn();
    auth.registerLogoutHook(hook);
    await auth.signOut();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(auth.getSessionState().status).toBe('signedIn');
    expect(getSupabase).not.toHaveBeenCalled();
  });
});

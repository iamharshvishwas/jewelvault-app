// U5 (the role decides which routes and menu items exist), U8 (logout runs every cache-emptying and poller-stopping
// hook), C16 and the helpers behind T-E01 and T-E08. FE02.
// The screens-by-role table of spec section 1.3 is written out here, one row per route, so a change to the table in
// src/lib/authStore.ts has to change this file too. The database is the real wall (section 3); this table only decides
// what the screen offers. The browser halves are tests/e2e/login.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  canAccessPath,
  getSessionState,
  IDLE_LIMIT_MS,
  initialsOf,
  isIdle,
  registerLogoutHook,
  signOut,
  type AuthRole,
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
  // not in the table of 1.3: kept as the prototype had it (the owner only); raised with the orchestrator
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

describe('the idle logout (U4, C16)', () => {
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

describe('logout empties memory and stops the pollers (U8)', () => {
  it('runs every registered hook once, whatever one of them does, and leaves the screen signed out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = vi.fn();
    const poller = vi.fn();
    const broken = vi.fn(() => {
      throw new Error('a hook that fails');
    });
    const later = vi.fn();
    const unregister = [
      registerLogoutHook(cache),
      registerLogoutHook(broken),
      registerLogoutHook(poller),
    ];
    const gone = registerLogoutHook(later);
    gone();

    await signOut();

    expect(cache).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(poller, 'a hook after a failing one still runs').toHaveBeenCalledTimes(1);
    expect(later, 'a hook that was unregistered does not run').not.toHaveBeenCalled();
    expect(getSessionState()).toMatchObject({ status: 'signedOut', session: null, role: null });

    await signOut();
    expect(cache, 'signing out twice does not run them twice').toHaveBeenCalledTimes(1);

    unregister.forEach((off) => off());
    warn.mockRestore();
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

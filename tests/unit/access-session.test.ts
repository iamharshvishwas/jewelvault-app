// The session, the cache gate and the poll run on `access` (plan: access and roles, Task 17; rulings R5, R6, R15). `me` says the person's ticks, the resources they read
// and an opaque access text; the session keeps them, the hydrate loads exactly those resources and opens the gate only for that access text, and a poll answer whose
// access text is another asks `me` once. The role key stays for display only: a role this screen has never heard of is accepted.
//
// Everything is the real code except the server and the clock, as in poll.test.ts: the real client, session store, hydrate, cache and poller over the fake server of
// tests/unit/support/server.ts, whose person is a `RoleSpec` of tests/unit/support/access.ts.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SyncResource } from '@/lib/api/types';
import { createPoller } from '@/lib/cache/poll';
import { isGateOpen, resourcesFor } from '@/lib/cache/hydrate';
import { holderOf } from '@/lib/useAccess';
import { accessFor, type RoleSpec } from './support/access';
import { FakeServer, jsonResponse, makeWorld, seedShop, settle, stampAt } from './support/server';

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  vi.useFakeTimers({
    now: Date.UTC(2026, 9, 15, 9, 0, 0),
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

/** A shop and a person; with `poll`, a poller too. Nothing has run: `await settle()` lets the person in and the hydrate finish. */
function boot(role: RoleSpec, { poll = false }: { poll?: boolean } = {}) {
  const server = new FakeServer();
  server.role = role;
  seedShop(server);
  const w = makeWorld(server);
  const poller = poll
    ? createPoller({
        api: w.api,
        cache: w.cache,
        hydrator: w.hydrator,
        session: w.session,
        page: w.page,
      })
    : null;
  return { ...w, poller };
}

const BILLER_TICKS = accessFor('biller').permissions;
/** The Biller's role key and name, one tick fewer: what the Super Admin's tick change makes of the role (P6). */
const BILLER_WITHOUT_BILLS: RoleSpec = {
  key: 'biller',
  name: 'Biller',
  ticks: BILLER_TICKS.filter((tick) => tick !== 'bill_make'),
  reads: accessFor('biller').reads,
};

/** The resources the hydrate asked for, each once, in the order it first asked. */
const syncedResources = (server: FakeServer) => [
  ...new Set(server.seen.filter((s) => s.kind === 'sync').map((s) => s.resource as SyncResource)),
];

describe('the session keeps what `me` says (R6, R15)', () => {
  it('me opens the gate with permissions, reads, access and roleName; an unknown role key is accepted (no isRole)', async () => {
    const counter: RoleSpec = {
      key: 'counter',
      name: 'Counter',
      ticks: ['order_view', 'bill_view'],
      reads: ['users', 'settings', 'orders', 'bills'],
    };
    const t = boot(counter);
    await settle();
    const fields = accessFor(counter);
    const state = t.session.getState();
    expect(state.status).toBe('signedIn');
    expect(state.access).toBe(fields.access);
    expect(state.session).toMatchObject({
      role: 'counter',
      roleName: 'Counter',
      isSuperAdmin: false,
      access: fields.access,
      reads: ['users', 'settings', 'orders', 'bills'],
    });
    expect([...(state.session?.permissions ?? [])]).toEqual(['bill_view', 'order_view']);
    // the gate opened for this access text, and the Holder of the screen is these ticks
    expect(t.hydrator.getState()).toMatchObject({ status: 'ready', access: fields.access });
    expect(isGateOpen(t.hydrator.getState(), state.access, state.epoch)).toBe(true);
    const holder = holderOf(state);
    expect(holder?.isSuperAdmin).toBe(false);
    expect([...(holder?.permissions ?? [])].sort()).toEqual(['bill_view', 'order_view']);
  });

  it('a tick key or a resource this screen does not know is ignored: nothing breaks and the others still count', async () => {
    const t = boot('staff');
    const staff = accessFor('staff');
    t.server.onRequest = (seen) =>
      seen.kind === 'me'
        ? jsonResponse(200, {
            user: {
              id: '00000000-0000-4000-8000-000000000001',
              email: 'person@jv.test',
              full_name: 'Test person',
              role: 'staff',
              must_change_password: false,
              role_name: 'Staff',
              permissions: ['made_up_tick', ...staff.permissions, 42],
              is_super_admin: false,
              access: staff.access,
              reads: [...staff.reads, 'made-up-resource'],
            },
            idle_timeout_s: 43200,
            absolute_expires_at: '2026-10-30T00:00:00.000000Z',
            pricing_sha256: null,
          })
        : undefined;
    await settle();
    const session = t.session.getState().session;
    expect(t.session.getState().status).toBe('signedIn');
    expect([...(session?.permissions ?? [])]).toEqual(staff.permissions);
    expect(session?.reads).toEqual(staff.reads);
    expect(t.hydrator.getState().status).toBe('ready');
    expect(syncedResources(t.server)).not.toContain('made-up-resource');
  });

  it('a Super Admin: the flag and every tick, the role key of the Owner', async () => {
    const t = boot({
      ticks: accessFor('owner').permissions,
      superAdmin: true,
      reads: accessFor('owner').reads,
    });
    await settle();
    const holder = holderOf(t.session.getState());
    expect(holder?.isSuperAdmin).toBe(true);
    expect(holder?.permissions.size).toBe(32);
    expect(t.session.getState().session?.role).toBe('owner');
  });

  it('holderOf is null while nobody is signed in, and the gate key is null', () => {
    const t = boot('owner');
    expect(holderOf(t.session.getState())).toBeNull(); // loading
    expect(t.session.getState().access).toBeNull();
  });
});

describe('reviewRole keys on access (P6, website half)', () => {
  it('reviewRole: the same role key with another access (a tick changed) runs the hooks, opens the gate with the new permissions and answers "changed" (P6, website half)', async () => {
    const t = boot('biller');
    await settle();
    let hooks = 0;
    t.session.registerLogoutHook(() => {
      hooks += 1;
    });
    const before = t.session.getState();
    expect(before.session?.permissions.has('bill_make')).toBe(true);
    t.server.role = BILLER_WITHOUT_BILLS;
    await expect(t.session.reviewRole()).resolves.toBe('changed');
    expect(hooks).toBe(1);
    const after = t.session.getState();
    expect(after.session?.role).toBe('biller');
    expect(after.access).toBe(accessFor(BILLER_WITHOUT_BILLS).access);
    expect(after.access).not.toBe(before.access);
    expect(after.session?.permissions.has('bill_make')).toBe(false);
    expect(after.epoch).toBe(before.epoch + 1);
    await settle();
    expect(isGateOpen(t.hydrator.getState(), after.access, after.epoch)).toBe(true);
    expect(holderOf(after)?.permissions.has('bill_make')).toBe(false);
  });

  it('reviewRole: an unchanged access answers "same" and runs no hook', async () => {
    const t = boot('biller');
    await settle();
    let hooks = 0;
    t.session.registerLogoutHook(() => {
      hooks += 1;
    });
    const before = t.session.getState();
    await expect(t.session.reviewRole()).resolves.toBe('same');
    expect(hooks).toBe(0);
    expect(t.session.getState()).toBe(before);
  });
});

describe('the poll compares access (R15)', () => {
  it("a poll answer whose access differs from the session's asks reviewRole once and not again until a poll works", async () => {
    const t = boot('owner', { poll: true });
    await settle();
    expect(t.poller?.getState().polls).toBe(1);
    const mes = t.server.count('me');
    // a poll answer that names another access text than the one `me` gives (the server's `me` is unchanged: the review answers "same")
    let odd = true;
    t.server.onRequest = (seen) =>
      seen.kind === 'poll' && odd
        ? jsonResponse(200, {
            results: {},
            server_time: stampAt(t.server.now()),
            role: 'owner',
            access: '0000000000000000',
          })
        : undefined;
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.session.getState().status).toBe('signedIn');
    await settle(120); // more answers with the other access text: `me` is not asked again
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.poller?.getState().failures).toBeGreaterThanOrEqual(3);
    // a poll that works clears it: the next odd answer is looked at again
    odd = false;
    await settle(31);
    expect(t.poller?.getState()).toMatchObject({ failures: 0, notice: null });
    odd = true;
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 2);
  });

  it('a poll answer with the access of a changed role: `me` is asked once and the screen hydrates again with the new access', async () => {
    const t = boot('biller', { poll: true });
    await settle();
    const mes = t.server.count('me');
    t.server.role = BILLER_WITHOUT_BILLS; // same key, same reads, one tick fewer
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 1);
    await settle();
    const access = accessFor(BILLER_WITHOUT_BILLS).access;
    expect(t.session.getState().access).toBe(access);
    expect(t.hydrator.getState()).toMatchObject({ status: 'ready', access });
    await settle(120);
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.poller?.getState().failures).toBe(0);
  });
});

describe('the hydrate loads the reads of `me` and the gate keys on access (C2, R15)', () => {
  it('hydrate loads exactly the resources of reads in HYDRATE_ORDER: a person without sku_private is never asked for it', async () => {
    const t = boot({ ticks: ['order_view'], reads: ['orders', 'users', 'skus', 'settings'] });
    await settle();
    expect(t.hydrator.getState()).toMatchObject({ status: 'ready', tablesTotal: 4 });
    expect(syncedResources(t.server)).toEqual(['settings', 'skus', 'users', 'orders']);
    expect(resourcesFor(['orders', 'users', 'skus', 'settings'])).toEqual([
      'settings',
      'skus',
      'users',
      'orders',
    ]);
    const biller = boot('biller');
    await settle();
    expect(syncedResources(biller.server)).not.toContain('sku-private');
    expect(syncedResources(biller.server).sort()).toEqual([...accessFor('biller').reads].sort());
  });

  it("the gate stays closed while the loaded access is not the session's access", async () => {
    const t = boot('owner');
    await settle();
    const { access, epoch } = t.session.getState();
    const loaded = t.hydrator.getState();
    expect(isGateOpen(loaded, access, epoch)).toBe(true);
    expect(isGateOpen(loaded, accessFor('biller').access, epoch)).toBe(false);
    expect(isGateOpen(loaded, null, epoch)).toBe(false);
    expect(isGateOpen(loaded, access, epoch + 1)).toBe(false);
    // another access text in the same epoch is another load: the gate closes until it is whole
    t.hydrator.start({ access: 'another-access', reads: accessFor('biller').reads }, epoch);
    expect(t.hydrator.getState()).toMatchObject({ status: 'loading', access: 'another-access' });
    expect(isGateOpen(t.hydrator.getState(), access, epoch)).toBe(false);
  });
});

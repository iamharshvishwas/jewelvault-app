// The access module of the website (plan: access and roles, Task 16; DESIGN 6.2 and 6.4): the 32 ticks, `can` and `canAny`, and which screen opens
// for which tick. Pure functions, so the tests run in plain Node. What the three built-in roles open is checked against the recorded fixture in
// access-golden.test.ts; here the module is tested on its own, with the holders of tests/unit/support/access.ts.
import { describe, expect, it } from 'vitest';
import { SCREENS, TICK_KEYS, can, canAccessPath, canAny, type TickKey } from '@/lib/access';
import { accessFor, holderFor } from './support/access';

/** The 32 ticks of the table of the plan, typed in here: the module's own list must equal it, key for key and in this order. */
const PLAN_TICKS: readonly TickKey[] = [
  'stock_add',
  'stock_edit',
  'stock_status',
  'category_add',
  'category_edit',
  'design_material',
  'secret_weight',
  'photo_rewrite',
  'customer_view',
  'bill_view',
  'cashbook_recent',
  'cashbook_all',
  'customer_edit',
  'customer_archive',
  'bill_make',
  'payment_receive',
  'rate_enter',
  'rate_correct',
  'back_date',
  'bill_cancel',
  'bill_reissue',
  'payment_void',
  'refund_give',
  'opening_balance',
  'cash_over_limit',
  'order_view',
  'order_edit',
  'order_closed_change',
  'reports_open',
  'activity_log',
  'download_all',
  'settings_change',
];

/** The 15 screens of today's table, in its order, then the new one. */
const PATHS = [
  '/',
  '/billing-pos',
  '/estimate',
  '/customer-ledger',
  '/inventory-management',
  '/design-detail',
  '/print-tags',
  '/stock-catalogue',
  '/order-book',
  '/add-design',
  '/edit-stock',
  '/reports',
  '/settings',
  '/activity-log',
  '/scan-detail',
  '/people-roles',
];

/** Each screen that needs a tick, and the tick (typed from the brief of the task, not read from the module). */
const SCREEN_TICKS: ReadonlyArray<readonly [string, TickKey]> = [
  ['/billing-pos', 'bill_make'],
  ['/estimate', 'bill_make'],
  ['/customer-ledger', 'customer_view'],
  ['/order-book', 'order_view'],
  ['/add-design', 'stock_add'],
  ['/edit-stock', 'stock_edit'],
  ['/reports', 'reports_open'],
  ['/settings', 'settings_change'],
  ['/activity-log', 'activity_log'],
  ['/scan-detail', 'secret_weight'],
];

const everyTickExcept = (tick: TickKey): TickKey[] => PLAN_TICKS.filter((t) => t !== tick);

describe('the ticks', () => {
  it('TICK_KEYS has 32 unique keys equal to the table of the plan', () => {
    expect(TICK_KEYS).toHaveLength(32);
    expect(new Set(TICK_KEYS).size).toBe(32);
    expect(PLAN_TICKS).toHaveLength(32);
    expect([...TICK_KEYS]).toEqual([...PLAN_TICKS]);
  });
});

describe('can and canAny', () => {
  it('can is true for the ticks a holder was given and false for the others', () => {
    const holder = holderFor({ ticks: ['bill_make', 'order_view'] });
    expect(can(holder, 'bill_make')).toBe(true);
    expect(can(holder, 'order_view')).toBe(true);
    expect(can(holder, 'bill_view')).toBe(false);
    expect(can(holder, 'settings_change')).toBe(false);
  });

  it('canAny is true when one of the ticks is held, and false when none is, or the list is empty', () => {
    const holder = holderFor({ ticks: ['bill_make'] });
    expect(canAny(holder, ['bill_view', 'bill_make'])).toBe(true);
    expect(canAny(holder, ['bill_make'])).toBe(true);
    expect(canAny(holder, ['bill_view', 'payment_receive'])).toBe(false);
    expect(canAny(holder, [])).toBe(false);
  });

  it('canAccessPath(null, ...) is false everywhere; can(null, tick) is false', () => {
    for (const path of [...PATHS, '/billing-pos/x', '/billing-pos?a=1', '/nope'])
      expect(canAccessPath(null, path), path).toBe(false);
    for (const tick of PLAN_TICKS) expect(can(null, tick), tick).toBe(false);
    expect(canAny(null, PLAN_TICKS)).toBe(false);
  });
});

describe('the screens', () => {
  it('SCREENS lists the 15 screens of today and /people-roles, each path once', () => {
    const listed = SCREENS.map((screen) => screen.path);
    expect(listed).toHaveLength(16);
    expect(new Set(listed).size).toBe(16);
    expect([...listed].sort()).toEqual([...PATHS].sort());
  });

  it('a person with no ticks opens only /, /inventory-management, /design-detail, /print-tags, /stock-catalogue', () => {
    const nobody = holderFor({ ticks: [] });
    expect(PATHS.filter((path) => canAccessPath(nobody, path))).toEqual([
      '/',
      '/inventory-management',
      '/design-detail',
      '/print-tags',
      '/stock-catalogue',
    ]);
  });

  it.each(SCREEN_TICKS)(
    '%s opens for a person who holds only %s, and not for a person who holds the other 31 ticks',
    (screen, tick) => {
      expect(canAccessPath(holderFor({ ticks: [tick] }), screen)).toBe(true);
      expect(canAccessPath(holderFor({ ticks: everyTickExcept(tick) }), screen)).toBe(false);
    }
  );

  it('/people-roles opens for a Super Admin and for nobody else, the Owner with all 32 ticks included', () => {
    const superAdmin = holderFor({ ticks: PLAN_TICKS, superAdmin: true });
    const owner = holderFor('owner');
    expect(owner.permissions.size).toBe(32); // the premise: the Owner holds every tick
    expect(canAccessPath(superAdmin, '/people-roles')).toBe(true);
    expect(canAccessPath(holderFor({ ticks: [], superAdmin: true }), '/people-roles')).toBe(true);
    expect(canAccessPath(superAdmin, '/people-roles?tab=roles')).toBe(true);
    expect(canAccessPath(owner, '/people-roles')).toBe(false);
    expect(canAccessPath(owner, '/people-roles?tab=roles')).toBe(false);
    expect(canAccessPath(holderFor({ ticks: PLAN_TICKS }), '/people-roles')).toBe(false);
    expect(canAccessPath(holderFor({ ticks: [] }), '/people-roles')).toBe(false);
    for (const role of ['biller', 'staff'] as const)
      expect(canAccessPath(holderFor(role), '/people-roles'), role).toBe(false);
  });

  it('a query or a hash is cut and a trailing slash is trimmed, as today', () => {
    const biller = holderFor('biller');
    expect(canAccessPath(biller, '/billing-pos/')).toBe(true);
    expect(canAccessPath(biller, '/billing-pos?a=1')).toBe(true);
    expect(canAccessPath(biller, '/billing-pos#top')).toBe(true);
    expect(canAccessPath(biller, '/billing-pos/?a=1#top')).toBe(true);
    expect(canAccessPath(holderFor('staff'), '/reports/')).toBe(false);
    expect(canAccessPath(holderFor('owner'), '/settings?tab=users')).toBe(true);
    expect(canAccessPath(biller, '/settings?tab=users')).toBe(false);
  });

  it('a sub-path follows its screen, "/" is exact, and a longer name is another path', () => {
    const staff = holderFor('staff');
    expect(canAccessPath(staff, '/inventory-management/anything')).toBe(true);
    expect(canAccessPath(staff, '/customer-ledger/anything')).toBe(false);
    expect(canAccessPath(holderFor('owner'), '/anything-at-all')).toBe(false);
    expect(canAccessPath(staff, '/edit-stock-everything')).toBe(false);
    expect(canAccessPath(holderFor('biller'), '/billing-pos-admin')).toBe(false);
    expect(canAccessPath(holderFor('owner'), '/settingsx')).toBe(false);
  });

  it('a path that is in no table opens for nobody, a Super Admin with every tick included', () => {
    const everything = holderFor({ ticks: PLAN_TICKS, superAdmin: true });
    for (const path of ['/catalogue', '/customer-catalogue', '/nope', '/people-roles-x', '/people'])
      expect(canAccessPath(everything, path), path).toBe(false);
  });
});

describe('the test support', () => {
  it("holds today's three roles typed from DESIGN: the Owner every tick, the Biller nine, Staff five", () => {
    const biller: TickKey[] = [
      'customer_view',
      'bill_view',
      'cashbook_recent',
      'customer_edit',
      'bill_make',
      'payment_receive',
      'rate_enter',
      'order_view',
      'order_edit',
    ];
    const staff: TickKey[] = [
      'stock_add',
      'stock_edit',
      'stock_status',
      'category_add',
      'order_view',
    ];
    expect([...holderFor('owner').permissions].sort()).toEqual([...PLAN_TICKS].sort());
    expect([...holderFor('biller').permissions].sort()).toEqual([...biller].sort());
    expect([...holderFor('staff').permissions].sort()).toEqual([...staff].sort());
    for (const role of ['owner', 'biller', 'staff'] as const)
      expect(holderFor(role).isSuperAdmin, role).toBe(false);
  });

  it('accessFor gives the fields of `me`: the key, the name, the ticks in catalogue order, the flag, an access text and the resources', () => {
    expect(accessFor('biller')).toMatchObject({
      role: 'biller',
      roleName: 'Biller',
      isSuperAdmin: false,
      permissions: [
        'customer_view',
        'bill_view',
        'cashbook_recent',
        'customer_edit',
        'bill_make',
        'payment_receive',
        'rate_enter',
        'order_view',
        'order_edit',
      ],
    });
    expect(accessFor('owner').permissions).toEqual([...PLAN_TICKS]);
    expect(accessFor('staff').roleName).toBe('Staff');
    expect(accessFor('owner').access).toMatch(/^[0-9a-f]{16}$/);
    // a custom set is put in catalogue order, once each
    expect(accessFor({ ticks: ['order_view', 'stock_add', 'stock_add'] }).permissions).toEqual([
      'stock_add',
      'order_view',
    ]);
  });

  it('the built-in roles read the resources of the recording: 16, 15 without sku-private, and 8', () => {
    expect(accessFor('owner').reads).toHaveLength(16);
    expect(accessFor('biller').reads).toHaveLength(15);
    expect(accessFor('biller').reads).not.toContain('sku-private');
    expect(accessFor('biller').reads).toContain('orders');
    expect(accessFor('staff').reads).toHaveLength(8);
    expect(accessFor('staff').reads).not.toContain('customers');
  });

  it('a custom set passes its resources through and reads none when it names none', () => {
    expect(accessFor({ ticks: ['order_view'], reads: ['orders', 'users'] }).reads).toEqual([
      'orders',
      'users',
    ]);
    expect(accessFor({ ticks: [] }).reads).toEqual([]);
  });

  it('the access text is the same for the same holder and differs when the role, a tick or the flag differs', () => {
    const one = accessFor({ ticks: ['bill_make', 'bill_view'] }).access;
    expect(accessFor({ ticks: ['bill_view', 'bill_make'] }).access).toBe(one);
    expect(accessFor({ ticks: ['bill_make'] }).access).not.toBe(one);
    expect(accessFor({ ticks: ['bill_make', 'bill_view'], superAdmin: true }).access).not.toBe(one);
    expect(accessFor('owner').access).not.toBe(accessFor('biller').access);
    expect(accessFor('biller').access).not.toBe(accessFor('staff').access);
  });
});

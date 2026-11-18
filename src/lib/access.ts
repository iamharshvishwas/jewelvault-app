// Who may open what on the website (plan: access and roles, Task 16; DESIGN 6.2 and 6.4). What a person may do is the ticks of their role: 32 of them, the table of
// DESIGN 6.2, with the same keys the API sends in `permissions` of `GET /v1/auth/me`. A screen opens when the person holds a tick for its data or its action, so the
// table of screens below lists ticks and not role names. Like the old role table it is a front-end rule that mirrors the API, which is the real wall: it only decides
// what the screen offers.
//
// Plain functions with no state, so they run in plain Node and the unit tests need no browser. They take a `Holder` (the ticks and the Super Admin flag of the person,
// as `me` says them), or null for a person who is not signed in.

/** The 32 ticks, in catalogue order: the order of the table in DESIGN 6.2 (Stock, Photos, Money, Orders, Records, Shop). */
export const TICK_KEYS = [
  // Stock
  'stock_add',
  'stock_edit',
  'stock_status',
  'category_add',
  'category_edit',
  'design_material',
  'secret_weight',
  // Photos
  'photo_rewrite',
  // Money
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
  // Orders
  'order_view',
  'order_edit',
  'order_closed_change',
  // Records
  'reports_open',
  'activity_log',
  'download_all',
  // Shop
  'settings_change',
] as const;

export type TickKey = (typeof TICK_KEYS)[number];

/** The person the website is deciding about: the ticks of their role and the Super Admin flag, both as `me` says them. */
export interface Holder {
  readonly permissions: ReadonlySet<TickKey>;
  readonly isSuperAdmin: boolean;
}

/**
 * Who may open a screen: everybody who is signed in (`open`), a person who holds any one of the listed ticks (`anyOf`), or the Super Admin alone (`superAdmin`: no tick
 * grants that screen, not even all 32 of them, DESIGN guardrail 5).
 */
export type ScreenRule =
  | { open: true }
  | { anyOf: readonly [TickKey, ...TickKey[]] }
  | { superAdmin: true };

// The screens by tick (spec 1.3, DESIGN 6.2 and 6.4). A route that is not in this list is closed to everybody, which is how the screens that are "hidden in M1"
// (/catalogue, /customer-catalogue) stay hidden. For the three roles of today the answers are the old ones (tests/unit/access-golden.test.ts holds them).
export const SCREENS: ReadonlyArray<{ path: string; rule: ScreenRule }> = [
  { path: '/', rule: { open: true } },
  { path: '/billing-pos', rule: { anyOf: ['bill_make'] } },
  { path: '/estimate', rule: { anyOf: ['bill_make'] } },
  { path: '/customer-ledger', rule: { anyOf: ['customer_view'] } },
  { path: '/inventory-management', rule: { open: true } },
  { path: '/design-detail', rule: { open: true } },
  { path: '/print-tags', rule: { open: true } },
  { path: '/stock-catalogue', rule: { open: true } },
  { path: '/order-book', rule: { anyOf: ['order_view'] } },
  { path: '/add-design', rule: { anyOf: ['stock_add'] } },
  { path: '/edit-stock', rule: { anyOf: ['stock_edit'] } },
  { path: '/reports', rule: { anyOf: ['reports_open'] } },
  { path: '/settings', rule: { anyOf: ['settings_change'] } },
  { path: '/activity-log', rule: { anyOf: ['activity_log'] } },
  // Scan Article looks a piece up by its number or barcode and shows the piece's own card (the weights the customer sees, stones, labour, status, location): it shows no
  // original weight. DESIGN names it for `secret_weight`; only the Owner holds that tick among today's roles, so the screen stays the Owner's, as the prototype had it.
  { path: '/scan-detail', rule: { anyOf: ['secret_weight'] } },
  { path: '/people-roles', rule: { superAdmin: true } },
];

/** Does this person hold this tick? Nobody holds a tick when nobody is signed in. */
export function can(who: Holder | null, tick: TickKey): boolean {
  return who !== null && who.permissions.has(tick);
}

/** Does this person hold at least one of these ticks? */
export function canAny(who: Holder | null, ticks: readonly TickKey[]): boolean {
  return ticks.some((tick) => can(who, tick));
}

function normalisePath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed || '/';
}

function opensFor(who: Holder, rule: ScreenRule): boolean {
  if ('open' in rule) return true;
  if ('superAdmin' in rule) return who.isSuperAdmin;
  return canAny(who, rule.anyOf);
}

/** May this person open this route (or follow this link, which may carry a query or a hash)? A person who is not signed in opens nothing. */
export function canAccessPath(who: Holder | null, pathname: string): boolean {
  if (!who) return false;
  const path = normalisePath(pathname);
  const screen = SCREENS.find((s) =>
    s.path === '/' ? path === '/' : path === s.path || path.startsWith(`${s.path}/`)
  );
  return screen !== undefined && opensFor(who, screen.rule);
}

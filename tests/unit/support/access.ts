// Test support for the access module (plan: access and roles, Task 16): who holds which ticks, and the fields of `me` that a session carries. A role is one of today's
// three by its key, or a custom set of ticks:
//
//   holderFor('biller')                                       the Holder of the Biller
//   holderFor({ ticks: ['order_view'] })                      a role that holds one tick
//   holderFor({ ticks: PLAN_TICKS, superAdmin: true })        a Super Admin
//   accessFor('staff')                                        role, roleName, permissions, isSuperAdmin, access and reads, as a session and a `me` answer carry them
//   accessFor({ ticks: ['order_view'], reads: ['orders'] })   the same for a custom set, which names the resources it reads (none, when it names none)
//   accessFor({ key: 'biller', ticks: [...] })                a built-in role key whose ticks were changed (another access text, the same key)
//   sessionFor('owner')                                       the session state of a signed-in person of that role, for a test that stands in for `useSession`
//   sessionFor(null)                                          the session state before anybody is known (loading)
//
// The tick sets of today's roles are typed in below from DESIGN.md 6.2 ("Today's roles as tick sets"), NOT imported from the app: the tests keep their own copy of what each
// role could do the day before the change. The Owner is "all 32", the list of the plan typed in below. What each role READS is the recording of access-golden.test.ts.
import { createHash } from 'node:crypto';
import type { Holder, TickKey } from '@/lib/access';
import type { SyncResource } from '@/lib/api/types';
import type { SessionState } from '@/lib/authStore';
import golden from '../fixtures/access-golden.json';

/** The 32 ticks of the table of the plan, typed in here: the app's own list (`TICK_KEYS`) must equal it, key for key and in this order (tests/unit/access.test.ts). */
export const PLAN_TICKS: readonly TickKey[] = [
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

export type BuiltInRole = 'owner' | 'biller' | 'staff';

export interface CustomRole {
  readonly ticks: readonly TickKey[];
  readonly superAdmin?: boolean;
  /** For `accessFor`: the role key and its name. Default `custom` / `Custom`, or `owner` / `Owner` for a Super Admin (a Super Admin login has the Owner's role). */
  readonly key?: string;
  readonly name?: string;
  /** For `accessFor`: the resources the role reads, named as the poll names them. None when left out. */
  readonly reads?: readonly SyncResource[];
}

export type RoleSpec = BuiltInRole | CustomRole;

const BUILT_IN: Record<BuiltInRole, { name: string; ticks: readonly TickKey[] }> = {
  owner: { name: 'Owner', ticks: PLAN_TICKS },
  biller: {
    name: 'Biller',
    // M1, M2, M3, M5, M7, M8, M9, O1, O2
    ticks: [
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
  },
  staff: {
    name: 'Staff',
    // S1, S2, S3, S4, O1
    ticks: ['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view'],
  },
};

/** The ticks and the flag of a role. Nobody but a custom set made with `superAdmin: true` is a Super Admin. */
export function holderFor(spec: RoleSpec): Holder {
  if (typeof spec === 'string') {
    return { permissions: new Set(BUILT_IN[spec].ticks), isSuperAdmin: false };
  }
  return { permissions: new Set(spec.ticks), isSuperAdmin: spec.superAdmin ?? false };
}

export interface AccessFields {
  role: string;
  roleName: string;
  permissions: TickKey[];
  isSuperAdmin: boolean;
  access: string;
  reads: SyncResource[];
}

/** The API's recipe for the access text: the first 16 hex characters of the SHA-256 of [role key, sorted ticks, flag]. The website only compares the text. */
function fingerprint(role: string, ticks: readonly TickKey[], isSuperAdmin: boolean): string {
  const text = JSON.stringify([role, [...ticks].sort(), isSuperAdmin]);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** What the role loaded the day before the change: the list the fixture recorded from the old `resourcesFor` (JSON gives plain strings back). */
function recordedReads(role: BuiltInRole): SyncResource[] {
  return [...golden.roles[role].resources] as SyncResource[];
}

/** The key and the name of a role: a built-in one's own, a custom set's given ones, else `owner` / `Owner` for a Super Admin and `custom` / `Custom` for the rest. */
function keyAndName(spec: RoleSpec): { role: string; roleName: string } {
  if (typeof spec === 'string') return { role: spec, roleName: BUILT_IN[spec].name };
  const fallback = spec.superAdmin
    ? { role: 'owner', roleName: 'Owner' }
    : { role: 'custom', roleName: 'Custom' };
  return { role: spec.key ?? fallback.role, roleName: spec.name ?? fallback.roleName };
}

/** The fields a session state and a `me` answer carry for a role: the permissions are in catalogue order, each once. */
export function accessFor(spec: RoleSpec): AccessFields {
  const holder = holderFor(spec);
  const permissions = PLAN_TICKS.filter((tick) => holder.permissions.has(tick));
  const { role, roleName } = keyAndName(spec);
  return {
    role,
    roleName,
    permissions,
    isSuperAdmin: holder.isSuperAdmin,
    access: fingerprint(role, permissions, holder.isSuperAdmin),
    reads: typeof spec === 'string' ? recordedReads(spec) : [...(spec.reads ?? [])],
  };
}

/** The session state of a signed-in person of this role (status "signedIn", the gate key set), or of nobody yet (status "loading") for null. */
export function sessionFor(spec: RoleSpec | null): SessionState {
  const base = { notice: null, error: null, epoch: 1 };
  if (spec === null) return { ...base, status: 'loading', session: null, access: null };
  const fields = accessFor(spec);
  return {
    ...base,
    status: 'signedIn',
    access: fields.access,
    session: {
      userId: '00000000-0000-4000-8000-000000000001',
      email: `${fields.role}@jv.test`,
      displayName: `Test ${fields.role}`,
      role: fields.role,
      roleName: fields.roleName,
      isSuperAdmin: fields.isSuperAdmin,
      permissions: new Set(fields.permissions),
      access: fields.access,
      reads: fields.reads,
      mustChangePassword: false,
    },
  };
}

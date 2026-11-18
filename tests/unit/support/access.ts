// Test support for the access module (plan: access and roles, Task 16): who holds which ticks, and the fields of `me` that a session carries. A role is one of today's
// three by its key, or a custom set of ticks:
//
//   holderFor('biller')                                       the Holder of the Biller
//   holderFor({ ticks: ['order_view'] })                      a role that holds one tick
//   holderFor({ ticks: TICK_KEYS, superAdmin: true })         a Super Admin
//   accessFor('staff')                                        role, roleName, permissions, isSuperAdmin, access and reads, as a session and a `me` answer carry them
//   accessFor({ ticks: ['order_view'], reads: ['orders'] })   the same for a custom set, which names the resources it reads (none, when it names none)
//
// The tick sets of today's roles are typed in below from DESIGN.md 6.2 ("Today's roles as tick sets"), NOT imported from the app: the tests keep their own copy of what each
// role could do the day before the change. Only the Owner is the catalogue itself, "all 32". What each role READS is the recording of access-golden.test.ts.
import { createHash } from 'node:crypto';
import { TICK_KEYS, type Holder, type TickKey } from '@/lib/access';
import type { SyncResource } from '@/lib/api/types';
import golden from '../fixtures/access-golden.json';

export type BuiltInRole = 'owner' | 'biller' | 'staff';

export interface CustomRole {
  readonly ticks: readonly TickKey[];
  readonly superAdmin?: boolean;
  /** For `accessFor`: the resources the role reads, named as the poll names them. None when left out. */
  readonly reads?: readonly SyncResource[];
}

export type RoleSpec = BuiltInRole | CustomRole;

const BUILT_IN: Record<BuiltInRole, { name: string; ticks: readonly TickKey[] }> = {
  owner: { name: 'Owner', ticks: TICK_KEYS },
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

/** The fields a session state and a `me` answer carry for a role: the permissions are in catalogue order, each once. A custom set has the role key `custom`. */
export function accessFor(spec: RoleSpec): AccessFields {
  const holder = holderFor(spec);
  const permissions = TICK_KEYS.filter((tick) => holder.permissions.has(tick));
  const role = typeof spec === 'string' ? spec : 'custom';
  return {
    role,
    roleName: typeof spec === 'string' ? BUILT_IN[spec].name : 'Custom',
    permissions,
    isSuperAdmin: holder.isSuperAdmin,
    access: fingerprint(role, permissions, holder.isSuperAdmin),
    reads: typeof spec === 'string' ? recordedReads(spec) : [...(spec.reads ?? [])],
  };
}

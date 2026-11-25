// The golden fixture of the website (plan: access and roles, Task 16; DESIGN section 8, P1; goal G3): what each of the three built-in roles opens and
// loads TODAY, recorded from the code that is in place before the change to ticks: `canAccessPath` of src/lib/authStore.ts (the screens by role) and
// `resourcesFor` of src/lib/cache/hydrate.ts (what the role loads). After the change the same three roles must get the same answers from the new
// functions, so the fixture was written ONCE (commit b7f9c2e) and is never edited afterwards.
//
// The file holds, for each role key (`owner`, `biller`, `staff`), the verdict for each path and the resources the role loads, in the order the old
// `resourcesFor` gives them (the stock side first).
//
// The test had two halves. The OLD half compared the old functions with the fixture and was the only one that could write it; Task 17 removed it with the
// functions it called. What stays compares the new functions with the same fixture: the screens of src/lib/access.ts over the holders of
// tests/unit/support/access.ts, and the loads of `resourcesFor` over the `reads` that `me` gives each built-in role (tests/e2e/hydrate.spec.ts checks that the
// real API's `me.reads` equals the recording).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canAccessPath } from '@/lib/access';
import type { SyncResource } from '@/lib/api/types';
import { resourcesFor } from '@/lib/cache/hydrate';
import { holderFor } from './support/access';

const FIXTURE = path.resolve(__dirname, 'fixtures/access-golden.json');

const ROLES = ['owner', 'biller', 'staff'] as const;
type BuiltInRole = (typeof ROLES)[number];

/** The 15 paths of today's table, then a sub-path, a path with a query, a path that is in no table, and the screen that does not exist yet. */
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
  '/billing-pos/x',
  '/billing-pos?a=1',
  '/nope',
  '/people-roles',
] as const;

interface Golden {
  note: string;
  roles: Record<BuiltInRole, { screens: Record<string, boolean>; resources: string[] }>;
}

function readFixture(): Golden {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
}

// ------------------------------------------------------------------------------------------------ the new functions (this half stays)

describe('the access module gives the three built-in roles what the fixture holds (P1)', () => {
  it('the built-in tick sets open exactly the screens the fixture says (P1)', () => {
    const golden = readFixture();
    for (const role of ROLES) {
      for (const [pathname, opens] of Object.entries(golden.roles[role].screens)) {
        expect(canAccessPath(holderFor(role), pathname), `${role} ${pathname}`).toBe(opens);
      }
    }
  });

  it('the hydrate loads, for the recorded reads of each role, exactly the recorded resources in the recorded order (P1)', () => {
    const golden = readFixture();
    for (const role of ROLES) {
      const recorded = golden.roles[role].resources as SyncResource[];
      // `me` names the resources in its own order (users first): the hydrate puts them in its own, which is the recorded one
      const reads = [...recorded].reverse();
      expect(resourcesFor(reads), role).toEqual(recorded);
    }
  });

  it("the fixture holds the 15 paths of today's table and four more, for each of the three roles", () => {
    const golden = readFixture();
    for (const role of ROLES) {
      expect(Object.keys(golden.roles[role].screens), role).toEqual([...PATHS]);
    }
  });

  it('the fixture holds what the spec says of the three roles (the spot checks made when it was recorded)', () => {
    const { roles } = readFixture();
    expect(roles.staff.screens['/billing-pos']).toBe(false);
    expect(roles.biller.screens['/reports']).toBe(false);
    expect(roles.owner.screens['/scan-detail']).toBe(true);
    for (const role of ROLES) expect(roles[role].screens['/people-roles'], role).toBe(false);
    expect(roles.owner.resources).toContain('sku-private');
    expect(roles.biller.resources).not.toContain('sku-private');
    expect(roles.biller.resources).toContain('customers');
    expect(roles.staff.resources).not.toContain('customers');
  });
});

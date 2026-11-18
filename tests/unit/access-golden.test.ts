// The golden fixture of the website (plan: access and roles, Task 16; DESIGN section 8, P1; goal G3): what each of the three built-in roles opens and
// loads TODAY, recorded from the code that is in place before the change to ticks: `canAccessPath` of src/lib/authStore.ts (the screens by role) and
// `resourcesFor` of src/lib/cache/hydrate.ts (what the role loads). After the change the same three roles must get the same answers from the new
// functions, so the fixture is written ONCE and never edited afterwards:
//
//   JV_RECORD_GOLDEN=1 npx vitest run tests/unit/access-golden.test.ts    writes tests/unit/fixtures/access-golden.json from the old functions
//   npx vitest run tests/unit/access-golden.test.ts                       compares the old functions with that file
//
// The file holds, for each role key (`owner`, `biller`, `staff`), the verdict for each path and the resources the role loads, in the order the old
// `resourcesFor` gives them (the stock side first).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canAccessPath as oldCanAccessPath } from '@/lib/authStore';
import { resourcesFor as oldResourcesFor } from '@/lib/cache/hydrate';

const RECORD = process.env.JV_RECORD_GOLDEN === '1';
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

const NOTE =
  'What each built-in role opens and loads, recorded on 19 Nov 2026 from the old canAccessPath (src/lib/authStore.ts) and resourcesFor (src/lib/cache/hydrate.ts) at 4f9c1b3, before the change to ticks. Never edited afterwards (plan rule P1).';

interface Golden {
  note: string;
  roles: Record<BuiltInRole, { screens: Record<string, boolean>; resources: string[] }>;
}

function readFixture(): Golden {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Golden;
}

// ------------------------------------------------------------------------------------------------ the old functions (removed with them by Task 17)

/** The verdicts of the code as it is today. */
function fromOldCode(): Golden {
  const roles = {} as Golden['roles'];
  for (const role of ROLES) {
    roles[role] = {
      screens: Object.fromEntries(PATHS.map((p) => [p, oldCanAccessPath(role, p)])),
      resources: oldResourcesFor(role),
    };
  }
  return { note: NOTE, roles };
}

describe("today's code is what the fixture holds", () => {
  it.runIf(RECORD)('records tests/unit/fixtures/access-golden.json from the old functions', () => {
    mkdirSync(path.dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(fromOldCode(), null, 2)}\n`);
  });

  it.skipIf(RECORD)('the old canAccessPath and resourcesFor give exactly the fixture', () => {
    expect(fromOldCode().roles).toEqual(readFixture().roles);
  });
});

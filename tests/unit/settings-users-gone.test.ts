// Access and roles (Task 22; DESIGN 6.4, ruling F): Settings no longer lists the people. The read-only "Users & Permissions" list showed a made-up label and two guesses per login
// ("Sees original weight", "Edits stock") worked out from the old role names, which is wrong for a role the Super Admin makes. The people are managed in People & Roles, so
//   - the list, its tab and its menu item are gone for everybody;
//   - one line, "People and roles are managed in People & Roles.", with a link to /people-roles, is drawn for the person who may open that screen (the Super Admin) and for nobody else;
//   - the guesses and the marker that waited for this task (`TODO(task-22)`) are gone from the settings store, which keeps what the Activity Log still needs: who a login is by id and name.
//
// Run: npm test -- tests/unit/settings-users-gone.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_TICKS, sessionFor, type RoleSpec } from './support/access';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const SRC = path.resolve(__dirname, '../../src');
const SUPER_ADMIN: RoleSpec = { ticks: PLAN_TICKS, superAdmin: true };

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
});

/** A screen drawn with this person stood in for the session (the way tests/unit/money-access.test.ts does it). */
async function stoodIn(who: RoleSpec | null): Promise<void> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => sessionFor(who),
  }));
}

async function drawSettings(who: RoleSpec | null): Promise<string> {
  await stoodIn(who);
  const { default: Settings } = await import('@/app/settings/components/SettingsClient');
  return renderToStaticMarkup(createElement(Settings));
}

const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
const POINTER = 'People and roles are managed in People & Roles.';
const WHO: Array<[string, RoleSpec | null]> = [
  ['the Owner', 'owner'],
  ['the Biller', 'biller'],
  ['Staff', 'staff'],
  ['a role with all 32 ticks that is not the Super Admin', { ticks: PLAN_TICKS }],
  ['a person who is not known', null],
];

describe('Task 22 Settings: the people are not listed here', () => {
  it.each([['the Super Admin', SUPER_ADMIN] as [string, RoleSpec | null], ...WHO])(
    'for %s: no Users & Permissions tab, no list of logins, no guess about what a login may do',
    async (_name, who) => {
      const html = await drawSettings(who);
      expect(html).not.toContain('Users &amp; Permissions');
      for (const guess of [
        'Sees original weight',
        'No original weight',
        'Edits stock',
        'Cannot edit stock',
      ])
        expect(html).not.toContain(guess);
      // the other tabs are all still there
      for (const tab of [
        'Materials &amp; Purities',
        'Categories',
        'Custom Fields',
        'Tag Templates',
        'Estimate Settings',
        'Taxes',
        'Numbering',
        'Business Settings',
      ])
        expect(html, tab).toContain(tab);
    }
  );

  it('the Super Admin gets one line with a link to People & Roles', async () => {
    const html = await drawSettings(SUPER_ADMIN);
    expect(text(html)).toContain(POINTER);
    expect(html).toMatch(/<a[^>]*href="\/people-roles"[^>]*>People &amp; Roles<\/a>/);
    expect(html.match(/href="\/people-roles"/g)).toHaveLength(1);
  });

  it.each(WHO)('%s gets no such line and no link', async (_name, who) => {
    const html = await drawSettings(who);
    expect(text(html)).not.toContain('People and roles are managed');
    expect(html).not.toContain('/people-roles');
  });
});

describe('Task 22 the menu: no Users & Permissions item under Settings', () => {
  it('the phone menu has every group open, and the Settings group has no such item for the Owner', async () => {
    await stoodIn('owner');
    const { default: Sidebar } = await import('@/components/Sidebar');
    const session = sessionFor('owner').session!;
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        variant: 'drawer',
        collapsed: false,
        onToggle: () => undefined,
        session,
      })
    );
    expect(html).toContain('Business Settings');
    expect(html).toContain('Activity Log');
    expect(html).not.toContain('Users &amp; Permissions');
    expect(html).not.toContain('tab=users');
  });
});

describe('Task 22 the settings store: what the guesses left behind is gone', () => {
  function sourcesUnder(folder: string): string[] {
    return readdirSync(folder).flatMap((name) => {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) return sourcesUnder(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('no ROLE_LABEL, no canSeeOriginalWeight, no canEditStock in src', () => {
    const offenders = sourcesUnder(SRC).filter((file) =>
      /ROLE_LABEL|canSeeOriginalWeight|canEditStock/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('no marker that waits for this task is left in src', () => {
    const offenders = sourcesUnder(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('TODO(task-22)')
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});

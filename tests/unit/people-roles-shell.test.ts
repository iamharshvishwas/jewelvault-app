// Access and roles (Task 22): the shell of the People & Roles screen, the store behind it and the shared password dialog (plan: Task 22; the tabs are Tasks 23 to 25).
//   - `createSuperStore`: what the screen loads when it opens (the ticks once, the people and the roles), what "Try again" and `reload()` read again, and what a failed load leaves
//     on screen (the data that is already there stays: a one-time view of a temporary password must not vanish because a list could not be read again);
//   - `passwordDialogReducer`: the life of the Super Admin's password in the dialog. It is in the state while she types, and gone when the answer comes, whatever the answer is,
//     and when the dialog is closed;
//   - the markup of the dialog and of the shell (drawn on the server side of React, the way the other screens are checked: there is no DOM here);
//   - a guard over every file of the screen: none logs, stores, fetches, or puts a password in an address, a message or an error.
//
// The Super Admin's real password is never used here: the tests type "made up" text.
//
// Run: npm test -- tests/unit/people-roles-shell.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmPasswordDialog from '@/app/people-roles/components/ConfirmPasswordDialog';
import {
  PeopleRolesView,
  nextTab,
  type PeopleRolesTab,
} from '@/app/people-roles/components/PeopleRolesClient';
import {
  EMPTY_PASSWORD_DIALOG,
  passwordDialogReducer,
  type PasswordDialogAction,
  type PasswordDialogState,
} from '@/app/people-roles/lib/passwordDialog';
import { COULD_NOT_LOAD, createSuperStore } from '@/app/people-roles/lib/superStore';
import type { SuperView } from '@/app/people-roles/lib/useSuper';
import { ApiError } from '@/lib/api/client';
import type {
  SuperPeopleResponse,
  SuperPerson,
  SuperRole,
  SuperRolesResponse,
  SuperTicksResponse,
} from '@/lib/api/types';
import { PLAN_TICKS, sessionFor, type RoleSpec } from './support/access';
import { leaksOf, sourcesUnder } from './support/leaks';
import { callsOf, declarationsOf, effectsCalling, elementsOf } from './support/screen';

const STAMP = '2026-11-19T07:41:12.123456Z';

const TICKS: SuperTicksResponse = {
  groups: ['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop'],
  ticks: [
    {
      key: 'customer_edit',
      group: 'Money',
      label: 'Add and edit customers',
      help: null,
      sensitive: false,
      needs: ['customer_view'],
    },
  ],
};
const person = (n: number): SuperPerson => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  full_name: `Person ${n}`,
  email: `person${n}@example.test`,
  role: 'cashier',
  role_name: 'Cashier',
  active: true,
  is_super_admin: false,
  last_login_at: null,
  updated_at: STAMP,
});
const role = (key: string): SuperRole => ({
  key,
  name: key,
  description: '',
  active: true,
  fixed: false,
  ticks: ['customer_view'],
  people: 1,
  updated_at: STAMP,
});

const refused = (message: string) =>
  new ApiError({ code: 'JV_FORBIDDEN', status: 403, message, write: false });

// ================================================================================================ the store

/** The three reads of the screen, as the client answers them, with the data held in variables the test can change. */
function fakeReads() {
  const held = { people: [person(1)], roles: [role('biller')] };
  const reads = {
    superTicks: vi.fn(async (): Promise<SuperTicksResponse> => TICKS),
    superPeople: vi.fn(async (): Promise<SuperPeopleResponse> => ({ people: held.people })),
    superRoles: vi.fn(async (): Promise<SuperRolesResponse> => ({ roles: held.roles })),
  };
  return { reads, held };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Task 22 createSuperStore: what the screen loads', () => {
  it('starts as "loading" with nothing in it', () => {
    const store = createSuperStore(fakeReads().reads);
    expect(store.state()).toEqual({
      status: 'loading',
      error: null,
      ticks: null,
      people: [],
      roles: [],
    });
  });

  it('opens by reading the ticks, the people and the roles, once each', async () => {
    const { reads } = fakeReads();
    const store = createSuperStore(reads);
    await store.open();
    expect(store.state()).toEqual({
      status: 'ready',
      error: null,
      ticks: TICKS,
      people: [person(1)],
      roles: [role('biller')],
    });
    expect(
      [reads.superTicks, reads.superPeople, reads.superRoles].map((r) => r.mock.calls.length)
    ).toEqual([1, 1, 1]);
  });

  it('opening twice (React draws an effect twice in development) loads once', async () => {
    const { reads } = fakeReads();
    const store = createSuperStore(reads);
    await Promise.all([store.open(), store.open()]);
    await store.open();
    expect(reads.superTicks).toHaveBeenCalledTimes(1);
    expect(reads.superPeople).toHaveBeenCalledTimes(1);
    expect(reads.superRoles).toHaveBeenCalledTimes(1);
  });

  it('tells its listeners when it changes, and not after they have left', async () => {
    const store = createSuperStore(fakeReads().reads);
    const seen: string[] = [];
    const leave = store.subscribe(() => seen.push(store.state().status));
    await store.open();
    expect(seen).toEqual(['ready']);
    leave();
    await store.reload();
    expect(seen).toEqual(['ready']);
  });
});

describe('Task 22 createSuperStore: reload() after a write', () => {
  it('reads the people and the roles again and not the ticks (they are fixed for this version)', async () => {
    const { reads, held } = fakeReads();
    const store = createSuperStore(reads);
    await store.open();
    held.people = [person(1), person(2)];
    held.roles = [role('biller'), role('cashier')];
    await store.reload();
    expect(store.state().people).toEqual([person(1), person(2)]);
    expect(store.state().roles.map((r) => r.key)).toEqual(['biller', 'cashier']);
    expect(store.state().ticks).toEqual(TICKS);
    expect(reads.superTicks).toHaveBeenCalledTimes(1);
    expect(reads.superPeople).toHaveBeenCalledTimes(2);
    expect(reads.superRoles).toHaveBeenCalledTimes(2);
  });

  it('never goes back to "loading" while it has something to show', async () => {
    const store = createSuperStore(fakeReads().reads);
    await store.open();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.state().status));
    await store.reload();
    expect(seen).toEqual(['ready']);
    expect(store.state().status).toBe('ready');
  });

  it('a late answer of an older reload does not undo a newer one', async () => {
    const { reads } = fakeReads();
    const store = createSuperStore(reads);
    await store.open();
    const older = deferred<SuperPeopleResponse>();
    const newer = deferred<SuperPeopleResponse>();
    reads.superPeople.mockImplementationOnce(() => older.promise);
    reads.superPeople.mockImplementationOnce(() => newer.promise);
    const first = store.reload();
    const second = store.reload();
    newer.resolve({ people: [person(3)] });
    await second;
    expect(store.state().people).toEqual([person(3)]);
    older.resolve({ people: [person(2)] });
    await first;
    expect(store.state().people).toEqual([person(3)]);
  });

  it('a reload that fails keeps the lists on screen, says why, and a later one clears it', async () => {
    const { reads } = fakeReads();
    const store = createSuperStore(reads);
    await store.open();
    reads.superPeople.mockRejectedValueOnce(refused('You are not allowed to do this.'));
    await store.reload();
    expect(store.state()).toEqual({
      status: 'error',
      error: 'You are not allowed to do this.',
      ticks: TICKS,
      people: [person(1)],
      roles: [role('biller')],
    });
    await store.reload();
    expect(store.state()).toMatchObject({ status: 'ready', error: null });
  });
});

describe('Task 22 createSuperStore: a load that fails', () => {
  it("is status 'error' with the API's sentence", async () => {
    const { reads } = fakeReads();
    reads.superPeople.mockRejectedValueOnce(refused('You are not allowed to do this.'));
    const store = createSuperStore(reads);
    await store.open();
    expect(store.state()).toEqual({
      status: 'error',
      error: 'You are not allowed to do this.',
      ticks: null,
      people: [],
      roles: [],
    });
  });

  it("is the plain sentence when there is none: an error that is not the client's, or one with no words", async () => {
    expect(COULD_NOT_LOAD).toBe('Could not load People & Roles. Try again.');
    for (const cause of [
      new TypeError('x is not a function'),
      'boom',
      new ApiError({ code: 'JV_INTERNAL', status: 500, message: '  ', write: false }),
    ]) {
      const { reads } = fakeReads();
      reads.superRoles.mockRejectedValueOnce(cause);
      const store = createSuperStore(reads);
      await store.open();
      expect(store.state().error).toBe(COULD_NOT_LOAD);
      expect(store.state().status).toBe('error');
    }
  });

  it('"Try again" is reload(): it asks for the ticks as well when they never arrived, and shows "loading" meanwhile', async () => {
    const { reads } = fakeReads();
    reads.superTicks.mockRejectedValueOnce(refused('No connection to the server.'));
    const store = createSuperStore(reads);
    await store.open();
    expect(store.state().ticks).toBeNull();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.state().status));
    await store.reload();
    expect(reads.superTicks).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['loading', 'ready']);
    expect(store.state()).toMatchObject({ status: 'ready', error: null, ticks: TICKS });
  });

  it('an answer that is not in the agreed shape is a failed load, never an empty list passing for the truth', async () => {
    for (const bad of [
      () => ({ people: 'nobody' }) as unknown as SuperPeopleResponse,
      () => ({}) as unknown as SuperPeopleResponse,
    ]) {
      const { reads } = fakeReads();
      reads.superPeople.mockImplementationOnce(async () => bad());
      const store = createSuperStore(reads);
      await store.open();
      expect(store.state()).toMatchObject({ status: 'error', error: COULD_NOT_LOAD, people: [] });
    }
    const { reads } = fakeReads();
    reads.superTicks.mockImplementationOnce(
      async () => ({ groups: [], ticks: null }) as unknown as SuperTicksResponse
    );
    const store = createSuperStore(reads);
    await store.open();
    expect(store.state()).toMatchObject({ status: 'error', ticks: null });
  });
});

// ================================================================================================ the life of the password in the dialog

describe('Task 22 the password of the dialog lives in its state only while she types', () => {
  const run = (...actions: PasswordDialogAction[]): PasswordDialogState =>
    actions.reduce(passwordDialogReducer, EMPTY_PASSWORD_DIALOG);

  it('starts empty, and typing fills it', () => {
    expect(EMPTY_PASSWORD_DIALOG).toEqual({ password: '', saving: false, error: null });
    expect(run({ type: 'typed', password: 'made up' }).password).toBe('made up');
  });

  it('typing again takes an old error away', () => {
    const wrong = run(
      { type: 'typed', password: 'a' },
      { type: 'submitted' },
      { type: 'answered', error: 'Your password is not correct.' }
    );
    expect(wrong.error).toBe('Your password is not correct.');
    expect(passwordDialogReducer(wrong, { type: 'typed', password: 'b' }).error).toBeNull();
  });

  it('nothing is sent for an empty password', () => {
    expect(run({ type: 'submitted' })).toEqual(EMPTY_PASSWORD_DIALOG);
  });

  it('a submit marks it saving, and a second submit or more typing while it is saving changes nothing', () => {
    const saving = run({ type: 'typed', password: 'made up' }, { type: 'submitted' });
    expect(saving).toEqual({ password: 'made up', saving: true, error: null });
    expect(passwordDialogReducer(saving, { type: 'submitted' })).toBe(saving);
    expect(passwordDialogReducer(saving, { type: 'typed', password: 'other' })).toBe(saving);
  });

  it('the password is gone when the answer comes, a refusal or not: success, a wrong password, a pause, a stale role', () => {
    for (const error of [
      null,
      'Your password is not correct.',
      'Too many wrong passwords. Try again in 15 minutes.',
      'This was changed by someone else. Reload and try again.',
    ]) {
      const answered = run(
        { type: 'typed', password: 'made up' },
        { type: 'submitted' },
        { type: 'answered', error }
      );
      expect(answered, String(error)).toEqual({ password: '', saving: false, error });
    }
  });

  it('closing empties everything, also while she is only typing', () => {
    expect(run({ type: 'typed', password: 'made up' }, { type: 'closed' })).toEqual(
      EMPTY_PASSWORD_DIALOG
    );
  });
});

// ================================================================================================ the markup

describe('Task 22 ConfirmPasswordDialog: what is drawn', () => {
  const draw = () =>
    renderToStaticMarkup(
      createElement(ConfirmPasswordDialog, {
        title: 'Save changes to “Cashier”?',
        summary: createElement('p', null, '3 people have this role.'),
        confirmLabel: 'Confirm and save',
        onConfirm: async () => ({ error: null }),
        onClose: () => undefined,
      })
    );

  it('is a dialog with its title, what is about to happen, and the buttons', () => {
    const html = draw();
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('Save changes to “Cashier”?');
    expect(html).toContain('3 people have this role.');
    expect(html).toContain('Confirm and save');
    expect(html).toContain('Cancel');
  });

  it('asks for "Your password" in a password field that is empty, and says why', () => {
    const html = draw();
    expect(html).toContain('Your password');
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<input[^>]*autoComplete="current-password"/i);
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toContain('We ask for your password every time you change who can do what.');
  });

  it('cannot be confirmed until a password has been typed, and shows no error yet', () => {
    const html = draw();
    expect(html).toMatch(/<button[^>]*data-testid="confirm-password-confirm"[^>]*disabled/);
    expect(html).not.toMatch(/role="alert"/);
  });
});

const view = (over: Partial<SuperView> = {}): SuperView => ({
  status: 'ready',
  error: null,
  ticks: TICKS,
  people: [person(1)],
  roles: [role('biller')],
  reload: async () => undefined,
  ...over,
});
const drawView = (v: SuperView, tab: PeopleRolesTab = 'people') =>
  renderToStaticMarkup(createElement(PeopleRolesView, { view: v, tab, onTab: () => undefined }));
const tabButtons = (html: string) =>
  [...html.matchAll(/<button[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

describe('Task 22 the shell: People & Roles', () => {
  it('has the heading and the two tabs, People first, with the People panel under it', () => {
    const html = drawView(view());
    expect(html).toMatch(/<h1[^>]*>People &amp; Roles<\/h1>/);
    const tabs = tabButtons(html);
    expect(tabs.map((t) => t.replace(/<[^>]*>/g, ''))).toEqual(['People', 'Roles']);
    expect(tabs[0]).toMatch(/aria-selected="true"/);
    expect(tabs[1]).toMatch(/aria-selected="false"/);
    expect(html).toContain('data-testid="people-tab"');
    expect(html).not.toContain('data-testid="roles-tab"');
  });

  it('shows the Roles panel when the Roles tab is the one chosen', () => {
    const html = drawView(view(), 'roles');
    const tabs = tabButtons(html);
    expect(tabs[0]).toMatch(/aria-selected="false"/);
    expect(tabs[1]).toMatch(/aria-selected="true"/);
    expect(html).toContain('data-testid="roles-tab"');
    expect(html).not.toContain('data-testid="people-tab"');
  });

  it('says it is loading while it loads, and draws no tab yet', () => {
    const html = drawView(view({ status: 'loading', ticks: null, people: [], roles: [] }));
    expect(html).toContain('data-testid="people-roles-loading"');
    expect(html).toContain('Loading People &amp; Roles');
    expect(tabButtons(html)).toEqual([]);
    expect(html).not.toContain('data-testid="people-tab"');
  });

  it('a load that failed shows the sentence and a Try again button, and no tab', () => {
    const html = drawView(
      view({
        status: 'error',
        error: 'You are not allowed to do this.',
        ticks: null,
        people: [],
        roles: [],
      })
    );
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('You are not allowed to do this.');
    expect(html).toMatch(/<button[^>]*data-testid="people-roles-retry"[^>]*>Try again<\/button>/);
    expect(tabButtons(html)).toEqual([]);
    expect(html).not.toContain('Loading People');
  });

  it('a reload that failed keeps the tab on screen (what was there stays) and adds the sentence and Try again', () => {
    const html = drawView(view({ status: 'error', error: COULD_NOT_LOAD }));
    expect(html).toContain('Could not load People &amp; Roles. Try again.');
    expect(html).toContain('Try again</button>');
    expect(tabButtons(html)).toHaveLength(2);
    expect(html).toContain('data-testid="people-tab"');
  });

  it('a screen that is ready shows no loading line and no error', () => {
    const html = drawView(view());
    expect(html).not.toContain('people-roles-loading');
    expect(html).not.toMatch(/role="alert"/);
    expect(html).not.toContain('Try again');
  });
});

// ================================================================================================ the tab strip is locked while a body is busy (Task 24 review, Task 25 Part A)

// The shell draws one tab body only. A keyboard user can Shift+Tab from behind a dialog to the tab buttons and press Enter: the body that holds the dialog would unmount, and what it held
// (a temporary password that is shown once, a form that was filled, edits that are not saved) would be gone. So a body says when it is busy (`onBusy`) and the shell locks the strip.
describe('Task 25 review: nextTab decides where a press on a tab goes', () => {
  it('a screen that is free goes to the tab that was asked for, the same one too', () => {
    expect(nextTab('people', 'roles', false)).toBe('roles');
    expect(nextTab('roles', 'people', false)).toBe('people');
    expect(nextTab('people', 'people', false)).toBe('people');
  });

  it('a screen that is busy stays where it is, whatever was asked for', () => {
    expect(nextTab('people', 'roles', true)).toBe('people');
    expect(nextTab('roles', 'people', true)).toBe('roles');
    expect(nextTab('roles', 'roles', true)).toBe('roles');
  });
});

describe('Task 25 review: the tab buttons while a body is busy', () => {
  const drawBusy = (busy: boolean, tab: PeopleRolesTab = 'people') =>
    renderToStaticMarkup(
      createElement(PeopleRolesView, {
        view: view(),
        tab,
        onTab: () => undefined,
        busy,
        onBusy: () => undefined,
      })
    );

  it('are disabled, and say so to a screen reader, while a body is busy', () => {
    for (const tab of ['people', 'roles'] as const)
      for (const button of tabButtons(drawBusy(true, tab))) {
        expect(button).toMatch(/\sdisabled=""/);
        expect(button).toMatch(/aria-disabled="true"/);
      }
  });

  it('are not disabled when nothing is busy, and say nothing about it', () => {
    const buttons = tabButtons(drawBusy(false));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).not.toMatch(/\sdisabled=""/);
      expect(button).not.toContain('aria-disabled');
    }
  });

  it('the screen is not busy until a body says so (the old way to draw it)', () => {
    for (const button of tabButtons(drawView(view()))) {
      expect(button).not.toMatch(/\sdisabled=""/);
      expect(button).not.toContain('aria-disabled');
    }
  });

  it('busy changes nothing else: the same tab is chosen and the same panel is drawn', () => {
    const free = drawBusy(false, 'roles');
    const busy = drawBusy(true, 'roles');
    expect(busy).toContain('data-testid="roles-tab"');
    expect(tabButtons(busy)[1]).toMatch(/aria-selected="true"/);
    expect(tabButtons(busy)[0]).toMatch(/aria-selected="false"/);
    // the same markup but for the attributes of the buttons and the dimming of the tab that is not the one open (the rest of the page has buttons that are disabled for their own reasons)
    const plainer = (html: string) =>
      html
        .replace(/\sdisabled=""/g, '')
        .replace(/\saria-disabled="true"/g, '')
        .replace(/\sopacity-50/g, '');
    expect(plainer(busy)).toBe(plainer(free));
  });
});

describe('Task 25 review: the bodies tell the shell when they are busy', () => {
  it.each(['PeopleTab.tsx', 'RolesTab.tsx'])(
    '%s calls onBusy from one effect, with the state of the dialog, and says "not busy" when it goes away',
    (file) => {
      const effects = effectsCalling(file, 'onBusy');
      expect(effects, file).toHaveLength(1);
      expect(effects[0].calls, file).toEqual([['busy']]);
      expect(effects[0].cleanup, file).toEqual([['false']]);
      expect(effects[0].deps, file).toBe('[busy, onBusy]');
    }
  );

  it.each(['PeopleTab.tsx', 'RolesTab.tsx'])(
    '%s is busy exactly while a dialog is open (open !== null)',
    (file) => {
      expect(declarationsOf(file, 'busy'), file).toEqual(['open !== null']);
    }
  );

  it('no other call of onBusy hides in either body: the effect is the only way it speaks', () => {
    expect(callsOf('PeopleTab.tsx', 'onBusy')).toHaveLength(2);
    expect(callsOf('RolesTab.tsx', 'onBusy')).toHaveLength(2);
  });

  it('the shell keeps busy in state, gives onBusy to both bodies, and takes every press on a tab through nextTab', () => {
    for (const body of ['PeopleTab', 'RolesTab']) {
      const used = elementsOf('PeopleRolesClient.tsx', body);
      expect(used, body).toHaveLength(1);
      expect(used[0].onBusy, body).toBe('onBusy');
    }
    expect(callsOf('PeopleRolesClient.tsx', 'nextTab')).toEqual([['current', 'requested', 'busy']]);
    const screen = elementsOf('PeopleRolesClient.tsx', 'PeopleRolesView');
    expect(screen).toHaveLength(1);
    expect(screen[0].busy).toBe('busy');
    expect(screen[0].onBusy).toBe('setBusy');
  });

  it('the strip is the only thing the shell locks: the tab buttons carry disabled and aria-disabled from busy', () => {
    const buttons = elementsOf('PeopleRolesClient.tsx', 'button').filter((attributes) =>
      attributes.id?.startsWith('`people-roles-tab-')
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0].disabled).toBe('busy');
    expect(buttons[0]['aria-disabled']).toBe('busy ? true : undefined');
  });
});

describe("Task 22 the shell is the Super Admin's own", () => {
  afterEach(() => {
    vi.doUnmock('@/lib/authStore');
  });

  async function drawScreen(who: RoleSpec | null): Promise<string> {
    vi.resetModules();
    vi.doMock('@/lib/authStore', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/authStore')>()),
      useSession: () => sessionFor(who),
    }));
    const { default: Screen } = await import('@/app/people-roles/components/PeopleRolesClient');
    return renderToStaticMarkup(createElement(Screen));
  }

  it('is drawn for the Super Admin: the heading, and the loading line until her three reads are in', async () => {
    const html = await drawScreen({ ticks: PLAN_TICKS, superAdmin: true });
    expect(html).toContain('People &amp; Roles');
    expect(html).toContain('data-testid="people-roles-loading"');
  });

  it('is drawn for nobody else: not the Owner with all 32 ticks, not the Biller, not Staff, not a person who is not known', async () => {
    const others: Array<RoleSpec | null> = [
      'owner',
      'biller',
      'staff',
      { ticks: PLAN_TICKS },
      null,
    ];
    for (const who of others) expect(await drawScreen(who), JSON.stringify(who)).toBe('');
  });
});

// ================================================================================================ no password can leak

describe('Task 22 no password can leak from the files of the screen', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const files = sourcesUnder(path.join(SRC, 'app/people-roles'));

  it('looks at every file of the screen, among them the dialog, the shell, the store and the hook', () => {
    const names = files.map((file) => path.relative(SRC, file)).sort();
    for (const wanted of [
      'app/people-roles/page.tsx',
      'app/people-roles/components/ConfirmPasswordDialog.tsx',
      'app/people-roles/components/PeopleRolesClient.tsx',
      'app/people-roles/lib/passwordDialog.ts',
      'app/people-roles/lib/superStore.ts',
      'app/people-roles/lib/useSuper.ts',
    ])
      expect(names, wanted).toContain(wanted);
  });

  it.each(files.map((file) => [path.relative(SRC, file), file] as const))('%s', (_name, file) => {
    expect(leaksOf(readFileSync(file, 'utf8'), file)).toEqual([]);
  });

  it('the checker sees each kind of leak when there is one (negative control)', () => {
    const bad = [
      'console.log(password);',
      'const url = `/v1/x?p=${password}`;',
      "const url = '/v1/x?p=' + password;",
      "throw new Error('wrong: ' + typedPassword);",
      'localStorage.setItem("p", password);',
      "fetch('/v1/x');",
    ].join('\n');
    const kinds = leaksOf(bad, 'bad.ts').map((line) => line.split(':')[0]);
    for (const kind of ['console', 'template', 'sum', 'throw', 'error', 'storage', 'fetch'])
      expect(kinds, kind).toContain(kind);
  });

  it('the checker leaves alone what is harmless: the word in a label or an attribute, and a password passed on to the one call', () => {
    const fine = [
      'const label = "Your password";',
      'const next = async (password: string) => onConfirm(password);',
      'dispatch({ type: "typed", password: event.target.value });',
    ].join('\n');
    expect(leaksOf(fine, 'fine.ts')).toEqual([]);
  });
});

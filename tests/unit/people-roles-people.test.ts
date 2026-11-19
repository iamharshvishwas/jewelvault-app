// Access and roles (Task 23): the People tab of People & Roles (plan: Task 23; DESIGN 6.5 and 6.6; rulings R11 and R12; the pictures are mockups/1-people.png, 4-password-confirm.png and
// 5-phone.png).
//   - lib/people.ts: which buttons a row has, the words of a row, what the add, edit and change-role forms check;
//   - lib/personChange.ts: what is about to happen, in words (the title, the sentences and the button of the password step);
//   - lib/personWrite.ts: the five writes with the Super Admin's password in the body, the lists read again after each, and the temporary password that comes back;
//   - lib/personFlow.ts: the steps after the password (the temporary password is shown once and is gone when the dialog closes), and lib/copyText.ts;
//   - the markup of the list, the dialogs and the temporary password (drawn on the server side of React: there is no DOM here);
//   - a guard over every file of the screen: nothing logs, stores, sends or puts a password or a temporary password in an address, a message or an error.
//
// The Super Admin's real password is never used here, and no password or temporary password is written in a title: the tests make them up and never print them.
//
// Run: npx vitest run tests/unit/people-roles-people.test.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddPersonDialog from '@/app/people-roles/components/AddPersonDialog';
import ChangeRoleDialog from '@/app/people-roles/components/ChangeRoleDialog';
import EditPersonDialog from '@/app/people-roles/components/EditPersonDialog';
import { PeopleRolesView } from '@/app/people-roles/components/PeopleRolesClient';
import { PeopleTabView } from '@/app/people-roles/components/PeopleTab';
import ResetPasswordDialog from '@/app/people-roles/components/ResetPasswordDialog';
import SwitchPersonDialog from '@/app/people-roles/components/SwitchPersonDialog';
import TemporaryPasswordDialog from '@/app/people-roles/components/TemporaryPasswordDialog';
import { copyText } from '@/app/people-roles/lib/copyText';
import {
  actionLabel,
  activeRoleChoices,
  editChanges,
  lockLine,
  personActions,
  sessionsEndedLine,
  statusLabel,
  validateEditPerson,
  validateNewPerson,
  validateRoleChoice,
} from '@/app/people-roles/lib/people';
import {
  changeConfirmLabel,
  changeSummary,
  changeTitle,
  editPersonChange,
  newPersonChange,
  resetPersonChange,
  rolePersonChange,
  switchPersonChange,
} from '@/app/people-roles/lib/personChange';
import { CONFIRMING, flowReducer } from '@/app/people-roles/lib/personFlow';
import {
  runChange,
  type PeopleWrites,
  type TemporaryPassword,
} from '@/app/people-roles/lib/personWrite';
import type { SuperView } from '@/app/people-roles/lib/useSuper';
import { ApiError } from '@/lib/api/client';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import type {
  SuperAddPersonBody,
  SuperNewPersonAnswer,
  SuperPerson,
  SuperResetAnswer,
  SuperRole,
} from '@/lib/api/types';
import { PLAN_TICKS, sessionFor, type RoleSpec } from './support/access';
import { PASSWORD_NAMES, leaksOf, sourcesUnder } from './support/leaks';

const STAMP = '2026-11-19T07:41:12.123456Z';
/** The id `sessionFor()` gives to the person who is signed in: the caller's own row has this id. */
const ME_ID = '00000000-0000-4000-8000-000000000001';

// The passwords of the tests are made up for each run and are never printed: a check that compares one answers true or false.
const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;
const TEMPORARY = `Tp${randomBytes(6).toString('hex')}-${randomBytes(4).toString('hex')}`;

const person = (over: Partial<SuperPerson> = {}): SuperPerson => ({
  id: '5a1d7c52-3b0e-4c8e-9d2f-0a6b7c8d9e01',
  full_name: 'Meena Shah',
  email: 'meena@example.test',
  role: 'zk-keeper',
  role_name: 'Stock Keeper',
  active: true,
  is_super_admin: false,
  last_login_at: null,
  updated_at: STAMP,
  ...over,
});
// role keys that differ from the role names, on purpose: a key on screen would show
const SIDDHI = person({
  id: ME_ID,
  full_name: 'Siddhi',
  email: 'siddhi@example.test',
  role: 'owner',
  role_name: 'Owner',
  is_super_admin: true,
});
const ANITA = person({
  id: '11111111-aaaa-4aaa-8aaa-111111111111',
  full_name: 'Anita Sharma',
  email: 'anita@example.test',
  role: 'zk-cashier',
  role_name: 'Cashier',
});
const OLD_LOGIN = person({
  id: '22222222-bbbb-4bbb-8bbb-222222222222',
  full_name: 'Old test login',
  email: 'test@example.test',
  role: 'zk-biller',
  role_name: 'Biller',
  active: false,
});
const OTHER_SUPER = person({
  id: '33333333-cccc-4ccc-8ccc-333333333333',
  full_name: 'Harsh Rehearsal',
  email: 'harsh@example.test',
  role: 'owner',
  role_name: 'Owner',
  is_super_admin: true,
  active: false,
});
const MEENA = person();

const role = (over: Partial<SuperRole> = {}): SuperRole => ({
  key: 'zk-keeper',
  name: 'Stock Keeper',
  description: '',
  active: true,
  fixed: false,
  ticks: [],
  people: 1,
  updated_at: STAMP,
  ...over,
});
const R_OWNER = role({ key: 'owner', name: 'Owner', fixed: true });
const R_CASHIER = role({ key: 'zk-cashier', name: 'Cashier' });
const R_KEEPER = role({ key: 'zk-keeper', name: 'Stock Keeper' });
const R_OLD = role({ key: 'zk-old', name: 'Old Role', active: false });
const ROLES = [R_OWNER, R_CASHIER, R_OLD, R_KEEPER];

/** What a screen shows of a piece of markup: the words, with the entities of React's output turned back. */
const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const draw = (component: unknown, props: object) =>
  renderToStaticMarkup(createElement(component as never, props as never));

// ================================================================================================ the rules of the tab

describe('Task 23 personActions: the buttons of a row', () => {
  it('personActions: a Super Admin row gives ["edit"] for the caller and [] for any other; others get edit, role, reset, switch', () => {
    expect(personActions(SIDDHI, ME_ID)).toEqual(['edit']);
    expect(personActions(OTHER_SUPER, ME_ID)).toEqual([]);
    expect(personActions(SIDDHI, 'someone-else')).toEqual([]);
    expect(personActions(ANITA, ME_ID)).toEqual(['edit', 'role', 'reset', 'switch']);
  });

  it('a switched-off person has the same four buttons (Change role must stay: the API says "Change the role first"), and the last one reads Switch on', () => {
    expect(personActions(OLD_LOGIN, ME_ID)).toEqual(['edit', 'role', 'reset', 'switch']);
    expect(actionLabel('switch', OLD_LOGIN)).toBe('Switch on');
    expect(actionLabel('switch', ANITA)).toBe('Switch off');
  });

  it('the words of the buttons are those of the picture', () => {
    expect(
      (['edit', 'role', 'reset', 'switch'] as const).map((action) => actionLabel(action, ANITA))
    ).toEqual(['Edit', 'Change role', 'Reset password', 'Switch off']);
  });
});

describe('Task 23 the words of a row', () => {
  it('statusLabel is Active or Switched off', () => {
    expect(statusLabel(ANITA)).toBe('Active');
    expect(statusLabel(OLD_LOGIN)).toBe('Switched off');
  });

  it('the lock line: her own row says so and what she may change, another Super Admin row says it cannot be changed here, everybody else has none', () => {
    expect(lockLine(SIDDHI, ME_ID)).toBe(
      'This is you. Only your name and e-mail can be changed here.'
    );
    expect(lockLine(OTHER_SUPER, ME_ID)).toBe('This login cannot be changed here.');
    expect(lockLine(ANITA, ME_ID)).toBeNull();
    expect(lockLine(OLD_LOGIN, ME_ID)).toBeNull();
  });

  it('sessionsEndedLine says how many sessions were ended, in plain words, and nothing for none or for what is not a count', () => {
    expect(sessionsEndedLine(1)).toBe('Signed out of 1 device.');
    expect(sessionsEndedLine(2)).toBe('Signed out of 2 devices.');
    expect(sessionsEndedLine(14)).toBe('Signed out of 14 devices.');
    for (const none of [0, -1, 1.5, Number.NaN, '2', null, undefined, {}])
      expect(sessionsEndedLine(none), String(none)).toBeNull();
  });
});

describe('Task 23 validateNewPerson', () => {
  it('validateNewPerson names every missing field and accepts a complete one', () => {
    expect(validateNewPerson({ full_name: '', email: '', role: '' })).toEqual({
      full_name: 'Name is required.',
      email: 'Enter an e-mail address such as name@example.com.',
      role: 'Choose a role.',
    });
    expect(validateNewPerson({ full_name: '   ', email: 'a@b.co', role: 'zk-keeper' })).toEqual({
      full_name: 'Name is required.',
    });
    expect(validateNewPerson({ full_name: 'Meena', email: '', role: 'zk-keeper' })).toEqual({
      email: 'Enter an e-mail address such as name@example.com.',
    });
    expect(validateNewPerson({ full_name: 'Meena', email: 'a@b.co', role: '' })).toEqual({
      role: 'Choose a role.',
    });
    expect(
      validateNewPerson({ full_name: 'Meena Shah', email: 'meena@example.test', role: 'zk-keeper' })
    ).toEqual({});
  });

  it('an e-mail is something@something.something with no spaces and one @ (the shape the API takes), and may have spaces around it', () => {
    const errorFor = (email: string) =>
      validateNewPerson({ full_name: 'M', email, role: 'r' }).email;
    for (const bad of [
      'meena',
      'meena@',
      '@example.test',
      'meena@example',
      'me na@x.co',
      'a@@b.co',
      'a@b@c.co',
    ])
      expect(errorFor(bad), bad).toBe('Enter an e-mail address such as name@example.com.');
    for (const good of ['meena@example.test', ' meena@example.test ', 'Meena.S+x@Example.CO.in'])
      expect(errorFor(good), good).toBeUndefined();
    expect(errorFor(`${'a'.repeat(250)}@b.co`)).toBe(
      'Enter an e-mail address such as name@example.com.'
    );
  });

  it('a name of 121 characters is refused (the API takes 120), and 120 is accepted', () => {
    const errorFor = (full_name: string) =>
      validateNewPerson({ full_name, email: 'a@b.co', role: 'r' }).full_name;
    expect(errorFor('a'.repeat(120))).toBeUndefined();
    expect(errorFor('a'.repeat(121))).toBe('Name is 120 characters at most.');
  });
});

describe('Task 23 activeRoleChoices', () => {
  it('activeRoleChoices drops switched-off roles and keeps the Owner', () => {
    const choices = activeRoleChoices(ROLES);
    expect(choices.map((r) => r.name)).toEqual(['Owner', 'Cashier', 'Stock Keeper']);
    expect(choices).toContain(R_OWNER);
    expect(choices).not.toContain(R_OLD);
  });

  it('keeps the order it is given and does not change the list it is given', () => {
    const given = [R_KEEPER, R_OLD, R_OWNER];
    const before = [...given];
    expect(activeRoleChoices(given).map((r) => r.key)).toEqual(['zk-keeper', 'owner']);
    expect(given).toEqual(before);
  });
});

describe('Task 23 the edit and change-role forms', () => {
  it('Edit needs a name and an e-mail address, like Add', () => {
    expect(validateEditPerson({ full_name: ' ', email: 'x' })).toEqual({
      full_name: 'Name is required.',
      email: 'Enter an e-mail address such as name@example.com.',
    });
    expect(validateEditPerson({ full_name: 'Meena Joshi', email: 'meena@example.test' })).toEqual(
      {}
    );
  });

  it('editChanges lists only what changed: the name as typed without the spaces around it, the e-mail in lower case', () => {
    expect(editChanges(MEENA, { full_name: 'Meena Shah', email: 'meena@example.test' })).toEqual(
      {}
    );
    expect(editChanges(MEENA, { full_name: ' Meena Joshi ', email: 'meena@example.test' })).toEqual(
      { full_name: 'Meena Joshi' }
    );
    expect(
      editChanges(MEENA, { full_name: 'Meena Shah', email: ' Meena.J@Example.Test ' })
    ).toEqual({ email: 'meena.j@example.test' });
    expect(editChanges(MEENA, { full_name: 'Meena Joshi', email: 'meena.j@example.test' })).toEqual(
      { full_name: 'Meena Joshi', email: 'meena.j@example.test' }
    );
  });

  it('the same e-mail in other letters is no change (the API keeps e-mails in lower case), a name in other letters is one', () => {
    expect(editChanges(MEENA, { full_name: 'Meena Shah', email: 'MEENA@example.test' })).toEqual(
      {}
    );
    expect(editChanges(MEENA, { full_name: 'meena shah', email: 'meena@example.test' })).toEqual({
      full_name: 'meena shah',
    });
  });

  it('an e-mail that was stored in other letters (older data) is still the same e-mail', () => {
    const legacy = person({ email: 'Meena@Example.Test' });
    expect(editChanges(legacy, { full_name: 'Meena Shah', email: 'meena@example.test' })).toEqual(
      {}
    );
  });

  it('Change role needs a role, and a different one from the one the person has', () => {
    expect(validateRoleChoice(MEENA, '')).toEqual({ role: 'Choose a role.' });
    expect(validateRoleChoice(MEENA, 'zk-keeper')).toEqual({
      role: 'This person already has that role. Choose a different one.',
    });
    expect(validateRoleChoice(MEENA, 'zk-cashier')).toEqual({});
  });
});

// ================================================================================================ what is about to happen, in words

describe('Task 23 the password step says exactly what will happen', () => {
  const add = newPersonChange(
    { full_name: ' Meena Shah ', email: ' Meena@Example.Test ', role: 'zk-cashier' },
    ROLES
  );

  it('a new person: the name and the e-mail as they will be saved, the role by its name', () => {
    expect(add).toEqual({
      kind: 'add',
      full_name: 'Meena Shah',
      email: 'meena@example.test',
      role: 'zk-cashier',
      roleName: 'Cashier',
    });
    expect(changeSummary(add)).toEqual([
      'Add Meena Shah as Cashier',
      'A temporary password is shown once. They must change it the first time they sign in.',
    ]);
    expect(changeTitle(add)).toBe('Add this person?');
    expect(changeConfirmLabel(add)).toBe('Confirm and add');
  });

  it('a change of role', () => {
    const change = rolePersonChange(MEENA, 'zk-cashier', ROLES);
    expect(change).toEqual({
      kind: 'role',
      person: MEENA,
      role: 'zk-cashier',
      roleName: 'Cashier',
    });
    expect(changeSummary(change)).toEqual([
      'Change the role of Meena Shah to Cashier',
      'The change works on their very next click.',
    ]);
    expect(changeTitle(change)).toBe("Change this person's role?");
    expect(changeConfirmLabel(change)).toBe('Confirm and change role');
  });

  it('switching off and on', () => {
    const off = switchPersonChange(MEENA);
    expect(off).toEqual({ kind: 'switch', person: MEENA, active: false });
    expect(changeSummary(off)).toEqual([
      'Switch off Meena Shah',
      'They are signed out at once and cannot sign in until you switch them on again.',
    ]);
    expect(changeTitle(off)).toBe('Switch off this person?');
    expect(changeConfirmLabel(off)).toBe('Confirm and switch off');
    const on = switchPersonChange(OLD_LOGIN);
    expect(on).toEqual({ kind: 'switch', person: OLD_LOGIN, active: true });
    expect(changeSummary(on)).toEqual(['Switch on Old test login', 'They can sign in again.']);
    expect(changeTitle(on)).toBe('Switch on this person?');
    expect(changeConfirmLabel(on)).toBe('Confirm and switch on');
  });

  it('a reset of the password', () => {
    const change = resetPersonChange(MEENA);
    expect(change).toEqual({ kind: 'reset', person: MEENA });
    expect(changeSummary(change)).toEqual([
      'Reset the password of Meena Shah',
      'A new temporary password is shown once. They are signed out everywhere and must choose a new password when they sign in.',
    ]);
    expect(changeTitle(change)).toBe("Reset this person's password?");
    expect(changeConfirmLabel(change)).toBe('Confirm and reset');
  });

  it('an edit: the name, the e-mail, or both, and what a new e-mail does to the sessions (R11)', () => {
    const name = editPersonChange(
      MEENA,
      { full_name: 'Meena Joshi', email: 'meena@example.test' },
      ME_ID
    );
    expect(changeSummary(name)).toEqual(['Change the name of Meena Shah to Meena Joshi']);
    const mail = editPersonChange(
      MEENA,
      { full_name: 'Meena Shah', email: 'meena.j@example.test' },
      ME_ID
    );
    expect(changeSummary(mail)).toEqual([
      'Change the e-mail of Meena Shah to meena.j@example.test',
      'They are signed out everywhere and must sign in with the new e-mail.',
    ]);
    const both = editPersonChange(
      MEENA,
      { full_name: 'Meena Joshi', email: 'meena.j@example.test' },
      ME_ID
    );
    expect(changeSummary(both)).toEqual([
      'Change the name of Meena Shah to Meena Joshi and the e-mail to meena.j@example.test',
      'They are signed out everywhere and must sign in with the new e-mail.',
    ]);
    expect(changeTitle(both)).toBe('Save these changes?');
    expect(changeConfirmLabel(both)).toBe('Confirm and save');
  });

  it('her own e-mail: her other sessions end and this one stays (R11)', () => {
    const own = editPersonChange(
      SIDDHI,
      { full_name: 'Siddhi', email: 'siddhi.new@example.test' },
      ME_ID
    );
    expect(own).toMatchObject({
      kind: 'edit',
      self: true,
      changes: { email: 'siddhi.new@example.test' },
    });
    expect(changeSummary(own)).toEqual([
      'Change the e-mail of Siddhi to siddhi.new@example.test',
      'Your other sessions are signed out. This one stays.',
    ]);
  });
});

// ================================================================================================ the writes

/** The five writes of the client, answering as the plan says, and a log of the order in which things happened. */
function fakeWrites() {
  const log: string[] = [];
  const answer = (over: Partial<SuperPerson> = {}) => person(over);
  const writes = {
    superAddPerson: vi.fn(async (body: SuperAddPersonBody): Promise<SuperNewPersonAnswer> => {
      log.push('write');
      return {
        person: answer({ full_name: body.full_name, email: body.email, role: body.role }),
        temporary_password: TEMPORARY,
      };
    }),
    superEditPerson: vi.fn(async () => {
      log.push('write');
      return { person: answer() };
    }),
    superSetPersonRole: vi.fn(async () => {
      log.push('write');
      return { person: answer() };
    }),
    superSetPersonActive: vi.fn(async () => {
      log.push('write');
      return { person: answer() };
    }),
    superResetPassword: vi.fn(async (): Promise<SuperResetAnswer> => {
      log.push('write');
      return { person: answer(), temporary_password: TEMPORARY, sessions_ended: 2 };
    }),
  };
  const reload = vi.fn(async () => {
    log.push('reload');
  });
  return { writes, reload, log };
}

/** A body as it was sent, with the Super Admin's password turned into words: a failing check never prints it. */
const masked = (body: unknown) => {
  const { password, ...rest } = body as { password?: string };
  return {
    ...rest,
    password: password === PASSWORD ? 'the typed password' : 'NOT THE TYPED PASSWORD',
  };
};
/** A temporary password as it came back, with the password turned into words: a failing check never prints it. */
const maskedTemporary = (temporary: TemporaryPassword | null) =>
  temporary === null
    ? null
    : {
        ...temporary,
        password: temporary.password === TEMPORARY ? 'the temporary password' : 'NOT IT',
      };
const refusal = (code: string, status: number, message: string, details = {}) =>
  new ApiError({ code, status, message, details, write: true });

describe('Task 23 runChange: each write sends the right call with the password in its body', () => {
  it('add: the new person, by the role key, with the password', async () => {
    const { writes, reload } = fakeWrites();
    const change = newPersonChange(
      { full_name: 'Meena Shah', email: 'meena@example.test', role: 'zk-cashier' },
      ROLES
    );
    const outcome = await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
    expect(writes.superAddPerson).toHaveBeenCalledTimes(1);
    expect(masked(writes.superAddPerson.mock.calls[0][0])).toEqual({
      full_name: 'Meena Shah',
      email: 'meena@example.test',
      role: 'zk-cashier',
      password: 'the typed password',
    });
    expect(outcome.error).toBeNull();
    expect(maskedTemporary(outcome.temporary)).toEqual({
      kind: 'add',
      name: 'Meena Shah',
      email: 'meena@example.test',
      password: 'the temporary password',
      sessionsEnded: null,
    });
  });

  it('edit: only the fields that changed, to the person by id', async () => {
    const { writes, reload } = fakeWrites();
    const change = editPersonChange(
      MEENA,
      { full_name: 'Meena Joshi', email: 'meena@example.test' },
      ME_ID
    );
    const outcome = await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
    const [id, body] = writes.superEditPerson.mock.calls[0] as unknown as [string, unknown];
    expect(id).toBe(MEENA.id);
    expect(masked(body)).toEqual({
      changes: { full_name: 'Meena Joshi' },
      password: 'the typed password',
    });
    expect(outcome).toEqual({ error: null, temporary: null });
  });

  it('edit: the e-mail alone is sent alone, and nothing else', async () => {
    const { writes, reload } = fakeWrites();
    const change = editPersonChange(
      MEENA,
      { full_name: 'Meena Shah', email: 'Meena.J@example.test' },
      ME_ID
    );
    await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
    const [, body] = writes.superEditPerson.mock.calls[0] as unknown as [string, unknown];
    expect(masked(body)).toEqual({
      changes: { email: 'meena.j@example.test' },
      password: 'the typed password',
    });
  });

  it('role: the role key', async () => {
    const { writes, reload } = fakeWrites();
    const change = rolePersonChange(MEENA, 'zk-cashier', ROLES);
    await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
    const [id, body] = writes.superSetPersonRole.mock.calls[0] as unknown as [string, unknown];
    expect(id).toBe(MEENA.id);
    expect(masked(body)).toEqual({ role: 'zk-cashier', password: 'the typed password' });
  });

  it('switch: off sends active false, on sends active true', async () => {
    const { writes, reload } = fakeWrites();
    await runChange(writes as unknown as PeopleWrites, reload, switchPersonChange(MEENA), PASSWORD);
    await runChange(
      writes as unknown as PeopleWrites,
      reload,
      switchPersonChange(OLD_LOGIN),
      PASSWORD
    );
    const calls = writes.superSetPersonActive.mock.calls as unknown as Array<[string, unknown]>;
    expect(calls.map(([id]) => id)).toEqual([MEENA.id, OLD_LOGIN.id]);
    expect(calls.map(([, body]) => masked(body))).toEqual([
      { active: false, password: 'the typed password' },
      { active: true, password: 'the typed password' },
    ]);
  });

  it('reset: the person by id, the password only, and the temporary password and the sessions it ended come back', async () => {
    const { writes, reload } = fakeWrites();
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      reload,
      resetPersonChange(MEENA),
      PASSWORD
    );
    const [id, body] = writes.superResetPassword.mock.calls[0] as unknown as [string, unknown];
    expect(id).toBe(MEENA.id);
    expect(masked(body)).toEqual({ password: 'the typed password' });
    expect(outcome.error).toBeNull();
    expect(maskedTemporary(outcome.temporary)).toEqual({
      kind: 'reset',
      name: 'Meena Shah',
      email: 'meena@example.test',
      password: 'the temporary password',
      sessionsEnded: 2,
    });
  });

  it("the Super Admin's password is in the body of the write only: not in the id, not in what comes back", async () => {
    const { writes, reload } = fakeWrites();
    const changes = [
      newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
      editPersonChange(MEENA, { full_name: 'N', email: 'meena@example.test' }, ME_ID),
      rolePersonChange(MEENA, 'zk-cashier', ROLES),
      switchPersonChange(MEENA),
      resetPersonChange(MEENA),
    ];
    for (const change of changes) {
      const outcome = await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
      expect(JSON.stringify(outcome).includes(PASSWORD), change.kind).toBe(false);
    }
    for (const call of [
      ...writes.superEditPerson.mock.calls,
      ...writes.superSetPersonRole.mock.calls,
      ...writes.superSetPersonActive.mock.calls,
      ...writes.superResetPassword.mock.calls,
    ]) {
      const [first] = call as unknown as [unknown];
      if (typeof first === 'string') expect(first.includes(PASSWORD)).toBe(false);
    }
    expect(reload.mock.calls.every((args) => args.length === 0)).toBe(true);
  });
});

describe('Task 23 runChange: the lists are read again after a write', () => {
  const kinds = [
    ['add', () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES)],
    ['edit', () => editPersonChange(MEENA, { full_name: 'N', email: 'meena@example.test' }, ME_ID)],
    ['role', () => rolePersonChange(MEENA, 'zk-cashier', ROLES)],
    ['switch', () => switchPersonChange(MEENA)],
    ['reset', () => resetPersonChange(MEENA)],
  ] as const;

  it.each(kinds)('%s: the lists are read again once, after the write', async (_kind, build) => {
    const { writes, reload, log } = fakeWrites();
    await runChange(writes as unknown as PeopleWrites, reload, build(), PASSWORD);
    expect(log).toEqual(['write', 'reload']);
  });

  it("a refusal that says nothing was written (a taken e-mail, a wrong password, a pause, a stale change) shows the API's sentence and reads nothing again", async () => {
    for (const refused of [
      refusal(
        'JV_INVALID_INPUT',
        422,
        'email is already used by another user. Nothing was changed.',
        { field: 'email' }
      ),
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' }),
      refusal('JV_RATE_LIMITED', 429, 'Too many wrong passwords. Try again in 15 minutes.'),
      refusal(
        'JV_NOT_ALLOWED',
        409,
        'Its role is switched off. Change the role first. Nothing was changed.'
      ),
    ]) {
      const { writes, reload } = fakeWrites();
      writes.superSetPersonActive.mockRejectedValueOnce(refused);
      const outcome = await runChange(
        writes as unknown as PeopleWrites,
        reload,
        switchPersonChange(OLD_LOGIN),
        PASSWORD
      );
      expect(outcome).toEqual({ error: refused.message, temporary: null });
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it('an outcome nobody can vouch for is read again, and says it could not be confirmed', async () => {
    for (const cause of [
      refusal('JV_INTERNAL', 500, UNCONFIRMED_MESSAGE),
      new TypeError('Failed to fetch'),
      'boom',
    ]) {
      const { writes, reload } = fakeWrites();
      writes.superResetPassword.mockRejectedValueOnce(cause);
      const outcome = await runChange(
        writes as unknown as PeopleWrites,
        reload,
        resetPersonChange(MEENA),
        PASSWORD
      );
      expect(outcome).toEqual({ error: UNCONFIRMED_MESSAGE, temporary: null });
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it('an answer with no temporary password (the person was made, but nothing can be shown) says so in words, and the lists are read again', async () => {
    for (const [build, call] of [
      [
        () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
        'superAddPerson',
      ],
      [() => resetPersonChange(MEENA), 'superResetPassword'],
    ] as const) {
      const { writes, reload } = fakeWrites();
      (writes[call] as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ person: MEENA });
      const outcome = await runChange(writes as unknown as PeopleWrites, reload, build(), PASSWORD);
      expect(outcome.temporary).toBeNull();
      expect(outcome.error, call).toMatch(/temporary password could not be read/);
      expect(outcome.error, call).toMatch(/Reset password/);
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it('a reset that does not say how many sessions it ended leaves the number out', async () => {
    const { writes, reload } = fakeWrites();
    writes.superResetPassword.mockResolvedValueOnce({
      person: MEENA,
      temporary_password: TEMPORARY,
    } as unknown as SuperResetAnswer);
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      reload,
      resetPersonChange(MEENA),
      PASSWORD
    );
    expect(outcome.temporary?.sessionsEnded).toBeNull();
  });
});

// ================================================================================================ the steps after the password, and the copy button

describe('Task 23 the temporary password is shown once and cleared when the dialog closes', () => {
  const shown: TemporaryPassword = {
    kind: 'add',
    name: 'Meena Shah',
    email: 'meena@example.test',
    password: TEMPORARY,
    sessionsEnded: null,
  };

  it('starts at the password step', () => {
    expect(CONFIRMING).toEqual({ step: 'confirm' });
  });

  it('a write that came back with a temporary password goes to the step that shows it, and holds it', () => {
    const next = flowReducer(CONFIRMING, { type: 'written', temporary: shown });
    expect(next.step).toBe('temporary');
    expect(next.step === 'temporary' && next.temporary === shown).toBe(true);
  });

  it('a write with nothing to show (an edit, a role, a switch) is the end', () => {
    expect(flowReducer(CONFIRMING, { type: 'written', temporary: null })).toEqual({
      step: 'closed',
    });
  });

  it('closing the dialog empties it: nothing of the temporary password is left in what the dialog holds', () => {
    const open = flowReducer(CONFIRMING, { type: 'written', temporary: shown });
    expect(JSON.stringify(open).includes(TEMPORARY)).toBe(true);
    const closed = flowReducer(open, { type: 'closed' });
    expect(closed).toEqual({ step: 'closed' });
    expect(JSON.stringify(closed).includes(TEMPORARY)).toBe(false);
  });

  it('it can be closed at the password step as well, and a late answer cannot bring it back', () => {
    expect(flowReducer(CONFIRMING, { type: 'closed' })).toEqual({ step: 'closed' });
    const closed = flowReducer(CONFIRMING, { type: 'closed' });
    expect(Object.is(flowReducer(closed, { type: 'written', temporary: shown }), closed)).toBe(
      true
    );
    const open = flowReducer(CONFIRMING, { type: 'written', temporary: shown });
    expect(Object.is(flowReducer(open, { type: 'written', temporary: shown }), open)).toBe(true);
  });
});

describe('Task 23 copyText', () => {
  it('copies through the clipboard of the browser and says so', async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyText('some text', { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('some text');
  });

  it('says it could not when there is no clipboard (an old browser, a page that is not secure)', async () => {
    expect(await copyText('some text', null)).toBe(false);
    expect(await copyText('some text', {} as never)).toBe(false);
  });

  it('says it could not, and never throws, when the clipboard refuses or breaks', async () => {
    expect(await copyText('x', { writeText: async () => Promise.reject(new Error('no')) })).toBe(
      false
    );
    expect(
      await copyText('x', {
        writeText: () => {
          throw new Error('no');
        },
      })
    ).toBe(false);
  });

  it('asks the clipboard of the page when it is not given one, and says it could not where there is none (this test runs in plain Node)', async () => {
    expect(await copyText('some text')).toBe(false);
  });
});

// ================================================================================================ the list

const noop = () => undefined;
const ROSTER = [SIDDHI, ANITA, OLD_LOGIN, OTHER_SUPER];
const drawList = (people: SuperPerson[] = ROSTER) =>
  draw(PeopleTabView, { people, meId: ME_ID, onAdd: noop, onAction: noop });
const rowsOf = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-testid="person-row"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
const buttonsOf = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
/** The words of the options of the drop-down lists, and of those of them that are chosen. */
const optionsOf = (html: string) =>
  [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
const chosenOf = (html: string) =>
  [...html.matchAll(/<option[^>]*selected[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);

describe('Task 23 the People list', () => {
  it('has the table of the picture: Person, Role, Status, Actions, one row for each person, and the note under it', () => {
    const html = drawList();
    expect(
      [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]),
      'the headings'
    ).toEqual(['Person', 'Role', 'Status', 'Actions']);
    expect(rowsOf(html)).toHaveLength(4);
    expect(plain(html)).toContain(
      'Nothing is ever deleted. A switched-off person cannot sign in; you can switch them on again.'
    );
  });

  it('has the + Add person button', () => {
    const html = drawList();
    expect(html).toMatch(/<button[^>]*data-testid="add-person"[^>]*>\+ Add person<\/button>/);
  });

  it('a person: the name and the e-mail, the role by its NAME, Active, and the four buttons', () => {
    const row = plain(rowsOf(drawList())[1]);
    expect(row).toContain('Anita Sharma');
    expect(row).toContain('anita@example.test');
    expect(row).toContain('Cashier');
    expect(row).toContain('Active');
    expect(buttonsOf(rowsOf(drawList())[1])).toEqual([
      'Edit',
      'Change role',
      'Reset password',
      'Switch off',
    ]);
  });

  it('a switched-off person: Switched off, and Switch on in place of Switch off', () => {
    const row = rowsOf(drawList())[2];
    expect(plain(row)).toContain('Old test login');
    expect(plain(row)).toContain('Switched off');
    expect(plain(row)).toContain('Biller');
    expect(buttonsOf(row)).toEqual(['Edit', 'Change role', 'Reset password', 'Switch on']);
    expect(row).not.toContain('Switch off');
  });

  it('her own row: the gold Super Admin pill, Active, the lock line, and Edit only', () => {
    const row = rowsOf(drawList())[0];
    expect(row).toMatch(/<span[^>]*bg-primary[^>]*>Super Admin<\/span>/);
    expect(plain(row)).toContain('Siddhi');
    expect(plain(row)).toContain('siddhi@example.test');
    expect(plain(row)).toContain('Active');
    expect(plain(row)).toContain('This is you. Only your name and e-mail can be changed here.');
    expect(buttonsOf(row)).toEqual(['Edit']);
    expect(plain(row)).not.toContain('Owner');
  });

  it('another Super Admin row: the pill and the lock line, and no button at all', () => {
    const row = rowsOf(drawList())[3];
    expect(row).toMatch(/<span[^>]*bg-primary[^>]*>Super Admin<\/span>/);
    expect(plain(row)).toContain('Harsh Rehearsal');
    expect(plain(row)).toContain('Switched off');
    expect(plain(row)).toContain('This login cannot be changed here.');
    expect(buttonsOf(row)).toEqual([]);
  });

  it('a person is a Super Admin only by the pill: the other rows have no pill and no lock line', () => {
    for (const row of [rowsOf(drawList())[1], rowsOf(drawList())[2]]) {
      expect(row).not.toContain('Super Admin');
      expect(row).not.toContain('data-testid="person-lock-line"');
    }
  });

  it('the buttons say whom they are for, to a screen reader, and keep their words on screen', () => {
    const row = rowsOf(drawList())[1];
    expect(row).toContain('aria-label="Edit Anita Sharma"');
    expect(row).toContain('aria-label="Switch off Anita Sharma"');
    expect(buttonsOf(row)).toEqual(['Edit', 'Change role', 'Reset password', 'Switch off']);
  });

  it('shows no role key and no id anywhere: the keys differ from the names on purpose, and so do the ids', () => {
    const html = drawList();
    for (const hidden of [
      ...ROSTER.map((p) => p.id),
      'zk-cashier',
      'zk-biller',
      'zk-keeper',
      STAMP,
      'last_login',
    ])
      expect(html.includes(hidden), hidden).toBe(false);
    expect(html).not.toMatch(/\bowner\b/);
  });

  it('the table turns into cards on a phone: the headings are hidden and each row is a block below the tablet width', () => {
    const html = drawList();
    expect(html).toMatch(/<thead[^>]*class="[^"]*\bhidden\b[^"]*\bmd:table-header-group\b/);
    for (const row of rowsOf(html))
      expect(row).toMatch(/class="[^"]*\bblock\b[^"]*\bmd:table-row\b/);
    expect(html).toMatch(/<table[^>]*class="[^"]*\bblock\b[^"]*\bmd:table\b/);
  });

  it('says so when nobody is listed, rather than drawing an empty table', () => {
    const html = drawList([]);
    expect(plain(html)).toContain('Nobody has a login yet.');
    expect(html).not.toContain('<table');
    expect(html).toContain('data-testid="add-person"');
  });

  it('draws no dialog and no alert until a button has been pressed', () => {
    const html = drawList();
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alert"');
  });
});

describe('Task 23 the tab inside the screen', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/authStore');
  });

  const view = (over: Partial<SuperView> = {}): SuperView => ({
    status: 'ready',
    error: null,
    ticks: { groups: ['Stock'], ticks: [] },
    people: [ANITA],
    roles: ROLES,
    reload: async () => undefined,
    ...over,
  });

  it('the shell draws this tab in the People panel, and not in the Roles panel', () => {
    const people = renderToStaticMarkup(
      createElement(PeopleRolesView, { view: view(), tab: 'people', onTab: noop })
    );
    expect(people).toContain('data-testid="people-tab"');
    expect(plain(people)).toContain('Anita Sharma');
    expect(plain(people)).toContain('+ Add person');
    const roles = renderToStaticMarkup(
      createElement(PeopleRolesView, { view: view(), tab: 'roles', onTab: noop })
    );
    expect(roles).not.toContain('data-testid="people-tab"');
    expect(roles).not.toContain('data-testid="add-person"');
  });

  async function drawTab(who: RoleSpec | null, people: SuperPerson[]): Promise<string> {
    vi.resetModules();
    vi.doMock('@/lib/authStore', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/authStore')>()),
      useSession: () => sessionFor(who),
    }));
    const { default: PeopleTab } = await import('@/app/people-roles/components/PeopleTab');
    return renderToStaticMarkup(
      createElement(PeopleTab, {
        ticks: { groups: [], ticks: [] },
        people,
        roles: ROLES,
        reload: async () => undefined,
      })
    );
  }

  it('knows which row is hers from the signed-in session: her own row has Edit, another Super Admin row has no button', async () => {
    const html = await drawTab({ ticks: PLAN_TICKS, superAdmin: true }, ROSTER);
    const rows = rowsOf(html);
    expect(buttonsOf(rows[0])).toEqual(['Edit']);
    expect(plain(rows[0])).toContain('This is you.');
    expect(buttonsOf(rows[3])).toEqual([]);
    expect(plain(rows[3])).toContain('This login cannot be changed here.');
    expect(buttonsOf(rows[1])).toHaveLength(4);
  });

  it('with nobody signed in no row is hers: a Super Admin row has no button at all', async () => {
    const html = await drawTab(null, [SIDDHI, ANITA]);
    const rows = rowsOf(html);
    expect(buttonsOf(rows[0])).toEqual([]);
    expect(plain(rows[0])).toContain('This login cannot be changed here.');
    expect(buttonsOf(rows[1])).toHaveLength(4);
  });
});

// ================================================================================================ the dialogs

const reload = async () => undefined;

describe('Task 23 the forms before the password step', () => {
  it('Add person: the three fields, the roles by name (the Owner too, a switched-off role not), and the way on', () => {
    const html = draw(AddPersonDialog, { roles: ROLES, reload, onClose: noop });
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('data-testid="add-person-dialog"');
    const words = plain(html);
    expect(words).toContain('Add person');
    for (const label of ['Name', 'E-mail', 'Role']) expect(words, label).toContain(label);
    expect(optionsOf(html)).toEqual(['Choose a role', 'Owner', 'Cashier', 'Stock Keeper']);
    expect(words).toContain('Next, you will be asked for your password.');
    expect(buttonsOf(html)).toContain('Cancel');
    expect(buttonsOf(html)).toContain('Continue');
  });

  it('Add person: nothing is chosen, nothing is wrong yet, and no role key or id is in the markup', () => {
    const html = draw(AddPersonDialog, { roles: ROLES, reload, onClose: noop });
    expect(html).not.toContain('role="alert"');
    expect(chosenOf(html)).toEqual(['Choose a role']);
    expect(html).not.toMatch(/<input[^>]*value="[^"]+"/);
    for (const hidden of ['zk-cashier', 'zk-keeper', 'zk-old', 'value="owner"'])
      expect(html.includes(hidden), hidden).toBe(false);
  });

  it('Edit: the name and the e-mail of the person are in the fields, and the title says whom', () => {
    const html = draw(EditPersonDialog, { person: MEENA, meId: ME_ID, reload, onClose: noop });
    expect(html).toContain('data-testid="edit-person-dialog"');
    expect(plain(html)).toContain('Edit Meena Shah');
    expect(html).toMatch(/<input[^>]*value="Meena Shah"/);
    expect(html).toMatch(/<input[^>]*value="meena@example.test"/);
    expect(buttonsOf(html)).toContain('Continue');
    expect(html).not.toContain(MEENA.id);
  });

  it('Change role: says what the role is now, and has that role chosen when it is one of the choices', () => {
    const html = draw(ChangeRoleDialog, { person: ANITA, roles: ROLES, reload, onClose: noop });
    expect(html).toContain('data-testid="change-role-dialog"');
    const words = plain(html);
    expect(words).toContain('Change role of Anita Sharma');
    expect(words).toContain('Current role: Cashier');
    expect(chosenOf(html)).toEqual(['Cashier']);
    expect(optionsOf(html)).toEqual(['Choose a role', 'Owner', 'Cashier', 'Stock Keeper']);
    for (const hidden of ['zk-cashier', 'zk-keeper', ANITA.id])
      expect(html.includes(hidden), hidden).toBe(false);
  });

  it('Change role: a person whose role is switched off has nothing chosen yet', () => {
    const html = draw(ChangeRoleDialog, {
      person: person({ role: 'zk-old', role_name: 'Old Role' }),
      roles: ROLES,
      reload,
      onClose: noop,
    });
    expect(plain(html)).toContain('Current role: Old Role');
    expect(chosenOf(html)).toEqual(['Choose a role']);
  });
});

describe('Task 23 the password step of the buttons that have no form', () => {
  it('Reset password goes straight to the password step, and says what will happen', () => {
    const html = draw(ResetPasswordDialog, { person: MEENA, reload, onClose: noop });
    expect(html).toContain('data-testid="confirm-password-dialog"');
    const words = plain(html);
    expect(words).toContain("Reset this person's password?");
    expect(words).toContain('Reset the password of Meena Shah');
    expect(words).toContain('Confirm and reset');
    expect(words).toContain('Your password');
    expect(html).toMatch(/<input[^>]*type="password"/);
  });

  it('Switch off and Switch on go straight to the password step, each with its own words', () => {
    const off = plain(draw(SwitchPersonDialog, { person: MEENA, reload, onClose: noop }));
    expect(off).toContain('Switch off this person?');
    expect(off).toContain('Switch off Meena Shah');
    expect(off).toContain('Confirm and switch off');
    const on = plain(draw(SwitchPersonDialog, { person: OLD_LOGIN, reload, onClose: noop }));
    expect(on).toContain('Switch on this person?');
    expect(on).toContain('Switch on Old test login');
    expect(on).toContain('Confirm and switch on');
  });

  it('the password field is empty and nothing is wrong yet', () => {
    const html = draw(ResetPasswordDialog, { person: MEENA, reload, onClose: noop });
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(MEENA.id);
  });
});

describe('Task 23 the temporary password dialog', () => {
  const added: TemporaryPassword = {
    kind: 'add',
    name: 'Meena Shah',
    email: 'meena@example.test',
    password: TEMPORARY,
    sessionsEnded: null,
  };
  const reset: TemporaryPassword = { ...added, kind: 'reset', sessionsEnded: 2 };
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  it('shows the temporary password once, with a Copy button and an "I have copied it" button', () => {
    const html = draw(TemporaryPasswordDialog, { temporary: added, onDone: noop });
    expect(html).toMatch(/role="dialog"/);
    expect(count(html, TEMPORARY)).toBe(1);
    expect(buttonsOf(html)).toEqual(['Copy', 'I have copied it']);
    expect(html).toContain('data-testid="temporary-password"');
  });

  it('says in one plain line that it is shown only once and that the person must change it at the first sign-in', () => {
    const words = plain(draw(TemporaryPasswordDialog, { temporary: added, onDone: noop }));
    expect(words).toContain(
      'It is shown only once. Meena Shah must change it the first time they sign in.'
    );
  });

  it('a new person: the title, and whom the password is for and how they sign in', () => {
    const words = plain(draw(TemporaryPasswordDialog, { temporary: added, onDone: noop }));
    expect(words).toContain('Person added');
    expect(words).toContain(
      'Meena Shah can now sign in with meena@example.test and this temporary password.'
    );
  });

  it('a reset: the title, whom the new password is for, and how many sessions were signed out', () => {
    const words = plain(draw(TemporaryPasswordDialog, { temporary: reset, onDone: noop }));
    expect(words).toContain('Password reset');
    expect(words).toContain('This is the new temporary password for Meena Shah.');
    expect(words).toContain('Signed out of 2 devices.');
  });

  it('says nothing of sessions for a new person, for none, and when the answer did not say', () => {
    for (const temporary of [
      added,
      { ...reset, sessionsEnded: 0 },
      { ...reset, sessionsEnded: null },
    ])
      expect(plain(draw(TemporaryPasswordDialog, { temporary, onDone: noop }))).not.toContain(
        'Signed out of'
      );
    expect(
      plain(
        draw(TemporaryPasswordDialog, { temporary: { ...reset, sessionsEnded: 1 }, onDone: noop })
      )
    ).toContain('Signed out of 1 device.');
  });

  it('has only one way out, the "I have copied it" button: no close cross, so that it is not lost by a slip', () => {
    const html = draw(TemporaryPasswordDialog, { temporary: added, onDone: noop });
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain('Cancel');
  });

  it('is a box that can be selected by hand, not a field that a password manager would offer to save', () => {
    const html = draw(TemporaryPasswordDialog, { temporary: added, onDone: noop });
    expect(html).toMatch(/<code[^>]*data-testid="temporary-password"[^>]*>/);
    expect(html).not.toMatch(/<input/);
  });

  it('the temporary password is not in any attribute, a title or a label: it is in the box and nowhere else', () => {
    const html = draw(TemporaryPasswordDialog, { temporary: added, onDone: noop });
    const attributes = [...html.matchAll(/\s[\w-]+="([^"]*)"/g)].map((m) => m[1]);
    expect(attributes.some((value) => value.includes(TEMPORARY))).toBe(false);
  });
});

// ================================================================================================ the glue the other tests cannot reach

// There is no DOM here, so the hand-over of `reload` from the shell down to the write is read from the syntax tree (the way the screens of Task 20b pin a seam): a dialog that handed on a
// reload of its own, or none, would show the old list after a write.
const SRC_DIR = path.resolve(__dirname, '../../src/app/people-roles/components');
const treeOf = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(path.join(SRC_DIR, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

/** The attributes (name -> the text of the value) of every JSX element with this tag in a file. */
function elementsOf(file: string, tag: string): Array<Record<string, string>> {
  const source = treeOf(file);
  const found: Array<Record<string, string>> = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(source) === tag
    ) {
      const attributes: Record<string, string> = {};
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const value = attribute.initializer;
        attributes[attribute.name.getText(source)] =
          value && ts.isJsxExpression(value) ? (value.expression?.getText(source) ?? '') : '';
      }
      found.push(attributes);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The text of the arguments of every call of a function with this name in a file. */
function callsOf(file: string, callee: string): string[][] {
  const source = treeOf(file);
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === callee)
      found.push(node.arguments.map((argument) => argument.getText(source)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Task 23 the shell's reload reaches every write", () => {
  it('the password step does the write with the reload it is given, and nothing else tells the dialog it is done but the flow', () => {
    expect(callsOf('ChangeSteps.tsx', 'runChange')).toEqual([
      ['api', 'reload', 'change', 'password'],
    ]);
    expect(callsOf('ChangeSteps.tsx', 'onClose')).toHaveLength(1);
  });

  it.each([
    'AddPersonDialog.tsx',
    'EditPersonDialog.tsx',
    'ChangeRoleDialog.tsx',
    'ResetPasswordDialog.tsx',
    'SwitchPersonDialog.tsx',
  ])('%s hands its reload and its way out on to the password step', (file) => {
    const steps = elementsOf(file, 'ChangeSteps');
    expect(steps.length, file).toBeGreaterThan(0);
    for (const attributes of steps) {
      expect(attributes.reload, file).toBe('reload');
      expect(attributes.onClose, file).toBe('onClose');
    }
  });

  it('the tab gives each dialog the reload it was given by the shell, and the shell gives the tab its own', () => {
    for (const dialog of [
      'AddPersonDialog',
      'EditPersonDialog',
      'ChangeRoleDialog',
      'ResetPasswordDialog',
      'SwitchPersonDialog',
    ]) {
      const used = elementsOf('PeopleTab.tsx', dialog);
      expect(used, dialog).toHaveLength(1);
      expect(used[0].reload, dialog).toBe('reload');
      expect(used[0].onClose, dialog).toBe('onClose');
    }
    const tab = elementsOf('PeopleRolesClient.tsx', 'PeopleTab');
    expect(tab).toHaveLength(1);
    expect(tab[0].reload).toBe('reload');
  });
});

// ================================================================================================ no password can leak

describe('Task 23 no password and no temporary password can leak from the files of the screen', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const files = sourcesUnder(path.join(SRC, 'app/people-roles'));

  it('looks at every file of the screen, among them the ones of this task', () => {
    const names = files.map((file) => path.relative(SRC, file)).sort();
    for (const wanted of [
      'app/people-roles/components/PeopleTab.tsx',
      'app/people-roles/components/AddPersonDialog.tsx',
      'app/people-roles/components/EditPersonDialog.tsx',
      'app/people-roles/components/ChangeRoleDialog.tsx',
      'app/people-roles/components/ResetPasswordDialog.tsx',
      'app/people-roles/components/SwitchPersonDialog.tsx',
      'app/people-roles/components/TemporaryPasswordDialog.tsx',
      'app/people-roles/lib/people.ts',
      'app/people-roles/lib/personWrite.ts',
      'app/people-roles/lib/copyText.ts',
    ])
      expect(names, wanted).toContain(wanted);
  });

  it.each(files.map((file) => [path.relative(SRC, file), file] as const))('%s', (_name, file) => {
    expect(leaksOf(readFileSync(file, 'utf8'), file)).toEqual([]);
  });

  it('the checker sees each kind of leak when there is one (negative control), also through a new name and through the ways out of the page', () => {
    const bad = [
      'console.log(temporary.password);',
      'const log = console.info;',
      'const shown = temporary.password; const url = `/v1/x?p=${shown}`;',
      'const { password: kept } = state; const text = "x" + kept;',
      'const typed = event.target.value; throw new Error(`no ${typed}`);',
      'localStorage.setItem("p", temporary.password);',
      'globalThis.fetch("/v1/x");',
      'window.history.pushState({}, "", url);',
      'navigator.sendBeacon("/x", temporary.password);',
      'document.cookie = value;',
      'const link = <a href={`/x?p=${typed}`}>x</a>;',
    ].join('\n');
    const kinds = leaksOf(bad, 'bad.tsx', PASSWORD_NAMES).map((line) => line.split(':')[0]);
    for (const kind of [
      'console',
      'template',
      'sum',
      'throw',
      'error',
      'storage',
      'fetch',
      'channel',
    ])
      expect(kinds, kind).toContain(kind);
    // each line is caught on its own
    for (const line of bad.split('\n'))
      expect(leaksOf(line, 'one.tsx', PASSWORD_NAMES), line).not.toEqual([]);
  });

  it('the checker leaves alone what is harmless: the password in a label or an attribute, in the box, passed on to the copy and to the one call, and an address made from nothing secret', () => {
    const fine = [
      'const label = "Temporary password";',
      'const box = <code data-testid="temporary-password">{temporary.password}</code>;',
      'const copy = async () => copyText(temporary.password);',
      'const next = async (password: string) => runChange(api, reload, change, password);',
      'dispatch({ type: "typed", password: event.target.value });',
      'const { name, email } = temporary; const line = `${name} can sign in with ${email}.`;',
      'const a = <a href={`/people/${slug}`}>x</a>;',
    ].join('\n');
    expect(leaksOf(fine, 'fine.tsx', PASSWORD_NAMES)).toEqual([]);
  });
});

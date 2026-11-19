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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
  EMAIL_TAKEN,
  ROLE_SWITCHED_OFF,
  SCREEN_RELOADS,
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
import { CONFIRMING, flowReducer, openIfFree } from '@/app/people-roles/lib/personFlow';
import {
  IF_LISTED_LINE,
  personRefusalWords,
  runChange,
  type PeopleWrites,
  type TemporaryPassword,
} from '@/app/people-roles/lib/personWrite';
import { createSuperStore } from '@/app/people-roles/lib/superStore';
import type { SuperView } from '@/app/people-roles/lib/useSuper';
import { ApiError, createApiClient } from '@/lib/api/client';
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
import {
  buttonsOf,
  callsOf,
  chosenOf,
  draw,
  effectsCalling,
  elementsOf,
  optionsOf,
  plain,
} from './support/screen';

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
      'Add Meena Shah (meena@example.test) as Cashier',
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
    // final review I1: a change of access reloads the screen of everybody who has the role, and what they had not saved is gone (one sentence added after the old words)
    expect(changeSummary(change)).toEqual([
      'Change the role of Meena Shah to Cashier',
      'The change works on their very next click. Their screen reloads at once: anything they have not saved is lost.',
    ]);
    expect(changeTitle(change)).toBe("Change this person's role?");
    expect(changeConfirmLabel(change)).toBe('Confirm and change role');
  });

  it('the step of a change of role says what it does to the screen of the person: the sentence is exactly the ruled one, once, after the old words, and no other step of the tab says it', () => {
    expect(SCREEN_RELOADS).toBe(
      'Their screen reloads at once: anything they have not saved is lost.'
    );
    const role = changeSummary(rolePersonChange(MEENA, 'zk-cashier', ROLES));
    expect(role).toHaveLength(2);
    expect(role[1].startsWith('The change works on their very next click. ')).toBe(true);
    expect(role[1].endsWith(SCREEN_RELOADS)).toBe(true);
    expect(role.join(' ').split(SCREEN_RELOADS)).toHaveLength(2);
    // the other four say what they say, and nothing about a screen that reloads (a person who is switched off or reset is signed out, which they already say)
    for (const other of [
      newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
      editPersonChange(MEENA, { full_name: 'Meena Joshi', email: 'new@example.test' }, ME_ID),
      switchPersonChange(MEENA),
      switchPersonChange(OLD_LOGIN),
      resetPersonChange(MEENA),
    ])
      expect(changeSummary(other).join(' '), other.kind).not.toMatch(/reloads|have not saved/);
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

  it('her own e-mail: her other devices are signed out and this one stays (R11)', () => {
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
      'Your other devices are signed out. This one stays.',
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

  // Final review of the website (important finding I2, Ruling AB (b)): the old rule here was "a refusal that says nothing was written reads nothing again". It was wrong for this tab: the
  // refusal is often the PROOF that the list on screen is old (a role that another browser switched off is still offered, and refused again at every try; a person made by an answer that was
  // lost is not in the list, and the e-mail is "already used"). Every refusal but the two about her own password reads the lists again, before the step answers.
  const CALL = {
    add: 'superAddPerson',
    edit: 'superEditPerson',
    role: 'superSetPersonRole',
    switch: 'superSetPersonActive',
    reset: 'superResetPassword',
  } as const;

  it("a wrong password and the pause are the step's to show: nothing was written, no list can be the reason, so the lists are not read again (all five writes)", async () => {
    for (const refused of [
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' }),
      refusal('JV_RATE_LIMITED', 429, 'Too many wrong passwords. Try again in 15 minutes.'),
    ]) {
      for (const [kind, build] of kinds) {
        const { writes, reload } = fakeWrites();
        (writes[CALL[kind]] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refused);
        const outcome = await runChange(
          writes as unknown as PeopleWrites,
          reload,
          build(),
          PASSWORD
        );
        expect(outcome, `${kind}: ${refused.message}`).toEqual({
          error: refused.message,
          temporary: null,
        });
        expect(reload, `${kind}: ${refused.message}`).not.toHaveBeenCalled();
      }
    }
  });

  it('every other refusal reads the lists again BEFORE the step answers, and shows the sentence as it was, or in plain words where `personRefusalWords` has them (all five writes)', async () => {
    for (const [refused, shown] of [
      [
        refusal(
          'JV_INVALID_INPUT',
          422,
          'email is already used by another user. Nothing was changed.',
          { field: 'email' }
        ),
        EMAIL_TAKEN,
      ],
      [
        refusal('JV_INVALID_INPUT', 422, 'role is not an active role. Nothing was changed.', {
          field: 'role',
        }),
        ROLE_SWITCHED_OFF,
      ],
      [
        refusal('JV_INVALID_INPUT', 422, 'full_name is required. Nothing was changed.', {
          field: 'full_name',
        }),
        'full_name is required. Nothing was changed.',
      ],
      [
        refusal(
          'JV_NOT_ALLOWED',
          409,
          'Its role is switched off. Change the role first. Nothing was changed.'
        ),
        'Its role is switched off. Change the role first. Nothing was changed.',
      ],
      [
        refusal('JV_STALE', 409, 'This was changed by someone else. Reload and try again.'),
        'This was changed by someone else. Reload and try again.',
      ],
      [
        refusal('JV_FORBIDDEN', 403, 'You are not allowed to do this. Nothing was changed.'),
        'You are not allowed to do this. Nothing was changed.',
      ],
      [
        refusal('JV_NOT_FOUND', 404, 'That record was not found. Nothing was changed.'),
        'That record was not found. Nothing was changed.',
      ],
    ] as const) {
      for (const [kind, build] of kinds) {
        const { writes, reload } = fakeWrites();
        let listsRead = false;
        reload.mockImplementation(async () => {
          await Promise.resolve();
          listsRead = true;
        });
        (writes[CALL[kind]] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refused);
        const outcome = await runChange(
          writes as unknown as PeopleWrites,
          reload,
          build(),
          PASSWORD
        );
        expect(outcome, `${kind}: ${refused.message}`).toEqual({ error: shown, temporary: null });
        expect(reload, `${kind}: ${refused.message}`).toHaveBeenCalledTimes(1);
        expect(listsRead, `${kind}: the answer waited for the lists`).toBe(true);
      }
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
      // a Reset whose answer was lost says the way on too (final review M2: its own tests are below)
      expect(outcome).toEqual({
        error: `${UNCONFIRMED_MESSAGE} ${IF_LISTED_LINE}`,
        temporary: null,
      });
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

  it('a reload that rejects after a write that went through does not lose the temporary password (add and reset)', async () => {
    for (const [build, kind] of [
      [
        () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
        'add',
      ],
      [() => resetPersonChange(MEENA), 'reset'],
    ] as const) {
      const { writes, reload } = fakeWrites();
      reload.mockRejectedValueOnce(new Error('the lists could not be read'));
      const outcome = await runChange(writes as unknown as PeopleWrites, reload, build(), PASSWORD);
      expect(reload, kind).toHaveBeenCalledTimes(1);
      expect(outcome.error, kind).toBeNull();
      expect(maskedTemporary(outcome.temporary), kind).toMatchObject({
        kind,
        password: 'the temporary password',
      });
    }
  });

  it('a reload that rejects after an edit, a role change or a switch is still a write that went through', async () => {
    for (const change of [
      editPersonChange(MEENA, { full_name: 'N', email: 'meena@example.test' }, ME_ID),
      rolePersonChange(MEENA, 'zk-cashier', ROLES),
      switchPersonChange(MEENA),
    ]) {
      const { writes, reload } = fakeWrites();
      reload.mockRejectedValueOnce(new Error('the lists could not be read'));
      const outcome = await runChange(writes as unknown as PeopleWrites, reload, change, PASSWORD);
      expect(outcome, change.kind).toEqual({ error: null, temporary: null });
    }
  });

  it('a write nobody can vouch for, and a reload that rejects as well, still says it could not be confirmed and does not throw', async () => {
    const { writes, reload } = fakeWrites();
    writes.superResetPassword.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    reload.mockRejectedValueOnce(new Error('the lists could not be read'));
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      reload,
      resetPersonChange(MEENA),
      PASSWORD
    );
    expect(outcome).toEqual({
      error: `${UNCONFIRMED_MESSAGE} ${IF_LISTED_LINE}`,
      temporary: null,
    });
  });
});

// ================================================================================================ plain words for the two sentences the form cannot catch

// Task 26 part 2 met them in the real browser (final review of the website, Ruling AB (c)): "email is already used by another user. Nothing was changed." and "role is not an active role.
// Nothing was changed." begin with the API's own lower-case field word ("email": the screen's own label is "E-mail") and read like a log line. They are said as the rest of the screen speaks,
// as `roleRefusalWords` does for a name that another role has. Only these two sentences, only on their own field: every other refusal keeps the API's words.
describe('Final review: personRefusalWords, the two API sentences of the people writes in plain words', () => {
  const EMAIL_WORDS = 'email is already used by another user';
  const ROLE_WORDS = 'role is not an active role';
  const on = (field: string | null, message: string, code = 'JV_INVALID_INPUT') =>
    refusal(code, code === 'JV_FORBIDDEN' ? 403 : 422, message, field === null ? {} : { field });
  const words = (cause: ApiError) => personRefusalWords(cause, cause.message);

  it('the exact sentence of the API for a taken e-mail, as the client words it (a 422 on `email`), reads "Another person already has this e-mail." with nothing after it', () => {
    expect(words(on('email', `${EMAIL_WORDS}. Nothing was changed.`))).toBe(
      'Another person already has this e-mail.'
    );
  });

  it('the exact sentence of the API for a role that is not active (a 422 on `role`) reads "That role is switched off. Choose another role."', () => {
    expect(words(on('role', `${ROLE_WORDS}. Nothing was changed.`))).toBe(
      'That role is switched off. Choose another role.'
    );
  });

  it('the words are the constants of the screen, one sentence each wherever it is said', () => {
    expect(EMAIL_TAKEN).toBe('Another person already has this e-mail.');
    expect(ROLE_SWITCHED_OFF).toBe('That role is switched off. Choose another role.');
  });

  it('it is the end of the sentence that counts: the closing words of the client, the full stop, the capital of the first word and spaces around make no difference', () => {
    for (const message of [
      EMAIL_WORDS,
      `${EMAIL_WORDS}.`,
      `${EMAIL_WORDS}. Nothing was changed.`,
      `Email is already used by another user. Nothing was changed.`,
      `  ${EMAIL_WORDS}. Nothing was changed.  `,
    ])
      expect(words(on('email', message)), message).toBe(EMAIL_TAKEN);
    for (const message of [
      ROLE_WORDS,
      `${ROLE_WORDS}.`,
      `${ROLE_WORDS}. Nothing was changed.`,
      `Role is not an active role. Nothing was changed.`,
      `  ${ROLE_WORDS}. Nothing was changed.  `,
    ])
      expect(words(on('role', message)), message).toBe(ROLE_SWITCHED_OFF);
  });

  it('a sentence that only contains the words, or goes on after them, is not the clash: it has to END with them', () => {
    for (const message of [
      `${EMAIL_WORDS}. Use another one. Nothing was changed.`,
      `${EMAIL_WORDS} account. Nothing was changed.`,
      'another user is already used by email. Nothing was changed.',
      'email is already used. Nothing was changed.',
      'email must be at most 254 characters. Nothing was changed.',
    ])
      expect(words(on('email', message)), message).toBe(message);
    for (const message of [
      `${ROLE_WORDS} yet. Nothing was changed.`,
      `${ROLE_WORDS}s. Nothing was changed.`,
      'an active role is not role. Nothing was changed.',
      'role is not a role. Nothing was changed.',
      'role is required. Nothing was changed.',
    ])
      expect(words(on('role', message)), message).toBe(message);
  });

  it("each sentence is mapped on its own field only: the e-mail's words on `role`, and the role's on `email`, on another field or on none, stay the API's", () => {
    const email = `${EMAIL_WORDS}. Nothing was changed.`;
    const role = `${ROLE_WORDS}. Nothing was changed.`;
    for (const [field, message] of [
      ['role', email],
      ['email', role],
      ['full_name', email],
      ['full_name', role],
      ['name', email],
      ['copy_of', role],
      [null, email],
      [null, role],
    ] as const)
      expect(words(on(field, message)), `${field}: ${message}`).toBe(message);
  });

  it("only a 422 (JV_INVALID_INPUT) is mapped: the same words under another code stay the API's", () => {
    for (const code of [
      'JV_NOT_ALLOWED',
      'JV_FORBIDDEN',
      'JV_STALE',
      'JV_NOT_FOUND',
      'JV_INTERNAL',
    ]) {
      const email = `${EMAIL_WORDS}. Nothing was changed.`;
      const role = `${ROLE_WORDS}. Nothing was changed.`;
      expect(words(on('email', email, code)), code).toBe(email);
      expect(words(on('role', role, code)), code).toBe(role);
    }
  });

  it('every other sentence of a 422 is left as it is, and so is a wrong password', () => {
    for (const [field, message] of [
      ['password', 'Your password is not correct.'],
      ['email', 'email must be at most 254 characters. Nothing was changed.'],
      ['full_name', 'full_name is required. Nothing was changed.'],
      ['changes', 'changes needs at least one change. Nothing was changed.'],
    ] as const)
      expect(words(on(field, message)), message).toBe(message);
  });

  it('whatever did not come from the API is left as it is', () => {
    expect(personRefusalWords(new TypeError('Failed to fetch'), UNCONFIRMED_MESSAGE)).toBe(
      UNCONFIRMED_MESSAGE
    );
    expect(personRefusalWords('boom', UNCONFIRMED_MESSAGE)).toBe(UNCONFIRMED_MESSAGE);
    expect(personRefusalWords(undefined, `${EMAIL_WORDS}. Nothing was changed.`)).toBe(
      `${EMAIL_WORDS}. Nothing was changed.`
    );
  });

  it('the writer shows the words: a taken e-mail on Add and on Edit, a role that is not active on Add and on Change role; the lists are read again each time', async () => {
    const taken = () =>
      refusal('JV_INVALID_INPUT', 422, `${EMAIL_WORDS}. Nothing was changed.`, { field: 'email' });
    const off = () =>
      refusal('JV_INVALID_INPUT', 422, `${ROLE_WORDS}. Nothing was changed.`, { field: 'role' });
    for (const [call, build, cause, shown] of [
      [
        'superAddPerson',
        () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
        taken(),
        EMAIL_TAKEN,
      ],
      [
        'superEditPerson',
        () => editPersonChange(MEENA, { full_name: 'Meena Shah', email: 'x@example.test' }, ME_ID),
        taken(),
        EMAIL_TAKEN,
      ],
      [
        'superAddPerson',
        () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
        off(),
        ROLE_SWITCHED_OFF,
      ],
      [
        'superSetPersonRole',
        () => rolePersonChange(MEENA, 'zk-cashier', ROLES),
        off(),
        ROLE_SWITCHED_OFF,
      ],
    ] as const) {
      const { writes, reload } = fakeWrites();
      (writes[call] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(cause);
      const outcome = await runChange(writes as unknown as PeopleWrites, reload, build(), PASSWORD);
      expect(outcome, `${call}: ${shown}`).toEqual({ error: shown, temporary: null });
      expect(reload, `${call}: ${shown}`).toHaveBeenCalledTimes(1);
    }
  });

  it("errorMap.ts and the client are untouched by the words: the same refusal of another call keeps the API's sentence", async () => {
    // the generic words of a 422 on another call (errorMap.ts) are not these: the mapping is the writer's alone
    const { plainMessage } = await import('@/lib/api/errorMap');
    expect(
      plainMessage('JV_INVALID_INPUT', {
        write: true,
        serverMessage: 'email is already used by another user',
        details: { field: 'email' },
        confirmsPassword: true,
      })
    ).toBe('email is already used by another user. Nothing was changed.');
  });
});

// ================================================================================================ after a refusal the lists say what the API says now

describe('Final review I2: what the lists show after a refusal (the real store, a stub of the API)', () => {
  /** The API as it is NOW (the arrays change under the screen, as another browser or a lost answer would change them) and the store that reads it, as the screen does. */
  async function screenOver(
    people: SuperPerson[],
    roles: SuperRole[]
  ): Promise<{
    server: { people: SuperPerson[]; roles: SuperRole[] };
    store: ReturnType<typeof createSuperStore>;
  }> {
    const server = { people: [...people], roles: [...roles] };
    const store = createSuperStore({
      superTicks: async () => ({ groups: [], ticks: [] }),
      superPeople: async () => ({ people: [...server.people] }),
      superRoles: async () => ({ roles: [...server.roles] }),
    });
    await store.open();
    return { server, store };
  }
  const keysOf = (roles: SuperRole[]) => activeRoleChoices(roles).map((one) => one.key);

  it('a role that another browser switched off is offered by the Add person form until the refusal: after it the form no longer offers it', async () => {
    const { server, store } = await screenOver([SIDDHI], [R_OWNER, R_CASHIER, R_KEEPER]);
    const values = { full_name: 'Meena Shah', email: 'meena@example.test', role: 'zk-cashier' };
    const asked = newPersonChange(values, activeRoleChoices(store.state().roles));
    expect(keysOf(store.state().roles)).toContain('zk-cashier');

    // the other browser switches the role off; the form here still offers it, and the write is refused
    server.roles = server.roles.map((one) =>
      one.key === 'zk-cashier' ? { ...one, active: false } : one
    );
    const { writes } = fakeWrites();
    writes.superAddPerson.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, 'role is not an active role. Nothing was changed.', {
        field: 'role',
      })
    );
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      store.reload,
      asked,
      PASSWORD
    );
    expect(outcome.error).toBe(ROLE_SWITCHED_OFF);
    // what the form is given now: the role is gone, the others stay, and nobody was added
    expect(keysOf(store.state().roles)).toEqual(['owner', 'zk-keeper']);
    expect(store.state().people.map((one) => one.email)).toEqual([SIDDHI.email]);
  });

  it('the same for Change role: the role switched off is no choice any more once the refusal has been answered', async () => {
    const { server, store } = await screenOver([ANITA], [R_OWNER, R_CASHIER, R_KEEPER]);
    const asked = rolePersonChange(ANITA, 'zk-keeper', activeRoleChoices(store.state().roles));
    server.roles = server.roles.map((one) =>
      one.key === 'zk-keeper' ? { ...one, active: false } : one
    );
    const { writes } = fakeWrites();
    writes.superSetPersonRole.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, 'role is not an active role. Nothing was changed.', {
        field: 'role',
      })
    );
    await runChange(writes as unknown as PeopleWrites, store.reload, asked, PASSWORD);
    expect(keysOf(store.state().roles)).toEqual(['owner', 'zk-cashier']);
  });

  it('a person made by an answer that was lost is in the list after it: the screen shows who is there, and the sentence says it could not be confirmed', async () => {
    const { server, store } = await screenOver([SIDDHI], [R_OWNER, R_CASHIER]);
    const lost = new ApiError({
      code: 'GATEWAY',
      status: 502,
      message: UNCONFIRMED_MESSAGE,
      write: true,
    });
    const { writes } = fakeWrites();
    // the API commits, and the answer never arrives
    writes.superAddPerson.mockImplementationOnce(async (body: SuperAddPersonBody) => {
      server.people.push(
        person({ full_name: body.full_name, email: body.email, role: 'zk-cashier' })
      );
      throw lost;
    });
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      store.reload,
      newPersonChange(
        { full_name: 'Meena Shah', email: 'meena@example.test', role: 'zk-cashier' },
        activeRoleChoices(store.state().roles)
      ),
      PASSWORD
    );
    expect(outcome).toEqual({
      error: `${UNCONFIRMED_MESSAGE} ${IF_LISTED_LINE}`,
      temporary: null,
    });
    expect(writes.superAddPerson).toHaveBeenCalledTimes(1);
    expect(store.state().people.map((one) => one.email)).toEqual([
      SIDDHI.email,
      'meena@example.test',
    ]);
  });

  it('a wrong password does not read the lists: nothing about them can have changed the answer', async () => {
    const { store } = await screenOver([SIDDHI], [R_OWNER, R_CASHIER]);
    const reads = vi.fn(store.reload);
    const { writes } = fakeWrites();
    writes.superSetPersonActive.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' })
    );
    await runChange(writes as unknown as PeopleWrites, reads, switchPersonChange(ANITA), PASSWORD);
    expect(reads).not.toHaveBeenCalled();
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

  it('never throws when the page refuses to hand over its clipboard: a getter that throws is "could not copy"', async () => {
    vi.stubGlobal('navigator', {
      get clipboard(): never {
        throw new Error('the browser refuses');
      },
    });
    try {
      await expect(copyText('some text')).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('asks the clipboard of the page only when it is not given one (null is "none", and is not replaced by the browser)', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      expect(await copyText('from the page')).toBe(true);
      expect(writeText).toHaveBeenCalledWith('from the page');
      expect(await copyText('not copied', null)).toBe(false);
      expect(writeText).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Task 23 review: openIfFree keeps the one dialog that is open', () => {
  it('gives back what is open when something is open, and the new one when nothing is', () => {
    const open = { kind: 'reset', person: MEENA };
    const next = { kind: 'add' };
    expect(Object.is(openIfFree<object>(open, next), open)).toBe(true);
    expect(Object.is(openIfFree<object>(null, next), next)).toBe(true);
  });

  it('a second opener cannot take the place of the first (the slot as React keeps it: each opener hands its choice to the one before it)', () => {
    let slot: { kind: string } | null = null;
    const open = (next: { kind: string }) => {
      slot = openIfFree(slot, next);
    };
    open({ kind: 'reset' });
    open({ kind: 'add' });
    open({ kind: 'switch' });
    expect(slot).toEqual({ kind: 'reset' });
    slot = null; // closing empties the slot, and then the next opener works
    open({ kind: 'add' });
    expect(slot).toEqual({ kind: 'add' });
  });

  it('treats an opener whose value looks empty (0, an empty text) as open: only null is free', () => {
    expect(openIfFree<number | null>(0, 5)).toBe(0);
    expect(openIfFree<string | null>('', 'x')).toBe('');
  });
});

// ================================================================================================ the list

const noop = () => undefined;
const ROSTER = [SIDDHI, ANITA, OLD_LOGIN, OTHER_SUPER];
const drawList = (people: SuperPerson[] = ROSTER) =>
  draw(PeopleTabView, { people, meId: ME_ID, onAdd: noop, onAction: noop });
const rowsOf = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-testid="person-row"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);

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
        onBusy: noop,
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

  /** The opening tag of the input with this test id, as drawn. */
  const inputTag = (html: string, testId: string) =>
    html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

  it('Task 23 review: a name starts with a capital letter on a phone, an e-mail does not (Add and Edit): the capitals are set for each field, not for all of them', () => {
    const add = draw(AddPersonDialog, { roles: ROLES, reload, onClose: noop });
    expect(inputTag(add, 'add-person-name')).toContain('autoCapitalize="words"');
    expect(inputTag(add, 'add-person-email')).toContain('autoCapitalize="none"');
    const edit = draw(EditPersonDialog, { person: MEENA, meId: ME_ID, reload, onClose: noop });
    expect(inputTag(edit, 'edit-person-name')).toContain('autoCapitalize="words"');
    expect(inputTag(edit, 'edit-person-email')).toContain('autoCapitalize="none"');
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

// ================================================================================================ the riders of the final review (M1, M2, M3)

describe('Final review M1: a reload or closing the tab asks first while the temporary password is on screen', () => {
  // The password is shown once and made by the API (hashed, never kept): a reload or closing the tab loses it for good, and the only way back is another reset. The Edit role screen asks the
  // browser the same question for its edits (`unloadGuard.ts`); the dialog that shows the password registers the same listener while it is on screen and takes it away when it goes. The
  // sidebar and Back are moves inside the page, which `beforeunload` never sees (accepted, as for the editor).
  it('one effect adds the listener of the editor and its cleanup removes the same listener: on when the dialog is drawn, off when it goes away, with no dependency that could swap it', () => {
    const adding = effectsCalling('TemporaryPasswordDialog.tsx', 'window.addEventListener');
    expect(adding).toHaveLength(1);
    expect(adding[0].calls).toEqual([["'beforeunload'", 'warnBeforeUnload']]);
    expect(adding[0].deps).toBe('[]');
    const removing = effectsCalling('TemporaryPasswordDialog.tsx', 'window.removeEventListener');
    expect(removing).toHaveLength(1);
    expect(removing[0].calls).toEqual([]);
    expect(removing[0].cleanup).toEqual([["'beforeunload'", 'warnBeforeUnload']]);
    expect(removing[0].deps).toBe('[]');
    expect(callsOf('TemporaryPasswordDialog.tsx', 'window.addEventListener')).toHaveLength(1);
    expect(callsOf('TemporaryPasswordDialog.tsx', 'window.removeEventListener')).toHaveLength(1);
    // one effect holds both lines, so a listener that is added is a listener that is removed
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/TemporaryPasswordDialog.tsx'),
      'utf8'
    );
    const effect =
      /useEffect\(\(\) => \{\s*window\.addEventListener[\s\S]*?\}, \[\]\);/.exec(source)?.[0] ?? '';
    expect(effect).toContain("window.addEventListener('beforeunload', warnBeforeUnload)");
    expect(effect).toContain(
      "return () => window.removeEventListener('beforeunload', warnBeforeUnload)"
    );
    expect(effect.indexOf('removeEventListener')).toBeGreaterThan(
      effect.indexOf('addEventListener')
    );
  });

  it('it is the very function of the Edit role screen (imported from unloadGuard.ts, written nowhere else), and the only listener of the dialog: no key, so Escape still does nothing', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/TemporaryPasswordDialog.tsx'),
      'utf8'
    );
    expect(source).toMatch(
      /import \{[^}]*\bwarnBeforeUnload\b[^}]*\} from '\.\.\/lib\/unloadGuard'/
    );
    expect(source).not.toMatch(/(?:function|const)\s+warnBeforeUnload/);
    expect(callsOf('TemporaryPasswordDialog.tsx', 'document.addEventListener')).toEqual([]);
    expect(callsOf('TemporaryPasswordDialog.tsx', 'window.addEventListener')).toEqual([
      ["'beforeunload'", 'warnBeforeUnload'],
    ]);
  });

  it('no other dialog or form of the People tab asks (a form that is filled can be filled again; only what cannot be shown again is guarded): the one listener of the folder, besides the editor, is the dialog that shows the password', () => {
    const folder = path.resolve(__dirname, '../../src/app/people-roles/components');
    const holders = readdirSync(folder)
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) => callsOf(file, 'window.addEventListener').length > 0)
      .sort();
    expect(holders).toEqual(['EditRole.tsx', 'TemporaryPasswordDialog.tsx']);
  });
});

describe('Final review M2: an Add person or a Reset whose outcome nobody can vouch for says what to do', () => {
  // "Could not confirm that this was saved." is all a lost answer used to say. For an Add person or a Reset the answer carried the one-time password, so the person may exist now (or the
  // password may be reset) with the password gone: one more sentence tells her the way on. The lists are read again as before, so the person is in the list if they were made.
  const IF_LISTED =
    'If the person is now in the list, use Reset password to get a new temporary password.';
  const lost = [
    new TypeError('Failed to fetch'),
    'boom',
    refusal('JV_INTERNAL', 500, UNCONFIRMED_MESSAGE),
    refusal('GATEWAY', 502, UNCONFIRMED_MESSAGE),
    refusal('JV_BUSY', 503, UNCONFIRMED_MESSAGE),
    refusal('NETWORK', 0, UNCONFIRMED_MESSAGE),
  ];

  it('the sentence is the ruled one, in one place', () => {
    expect(IF_LISTED_LINE).toBe(IF_LISTED);
  });

  it('an Add person and a Reset whose outcome is unknown say "Could not confirm that this was saved." and then the way on; the lists are read again, once', async () => {
    for (const [call, build] of [
      [
        'superAddPerson',
        () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
      ],
      ['superResetPassword', () => resetPersonChange(MEENA)],
    ] as const) {
      for (const cause of lost) {
        const { writes, reload } = fakeWrites();
        (writes[call] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(cause);
        const outcome = await runChange(
          writes as unknown as PeopleWrites,
          reload,
          build(),
          PASSWORD
        );
        expect(outcome, `${call}: ${String(cause)}`).toEqual({
          error: `${UNCONFIRMED_MESSAGE} ${IF_LISTED}`,
          temporary: null,
        });
        expect(reload, `${call}: ${String(cause)}`).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('the other three writes (an edit, a role, a switch) say only "Could not confirm that this was saved.": there is no password to lose', async () => {
    for (const [call, build] of [
      [
        'superEditPerson',
        () => editPersonChange(MEENA, { full_name: 'N', email: 'meena@example.test' }, ME_ID),
      ],
      ['superSetPersonRole', () => rolePersonChange(MEENA, 'zk-cashier', ROLES)],
      ['superSetPersonActive', () => switchPersonChange(MEENA)],
    ] as const) {
      for (const cause of lost) {
        const { writes, reload } = fakeWrites();
        (writes[call] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(cause);
        const outcome = await runChange(
          writes as unknown as PeopleWrites,
          reload,
          build(),
          PASSWORD
        );
        expect(outcome, `${call}: ${String(cause)}`).toEqual({
          error: UNCONFIRMED_MESSAGE,
          temporary: null,
        });
      }
    }
  });

  it('a refusal that says what is wrong, and a server that says it did nothing, keep their own words for an Add person and a Reset: nothing about the list is added', async () => {
    for (const refused of [
      refusal(
        'JV_NOT_ALLOWED',
        409,
        'A Super Admin login is managed in the terminal. Nothing was changed.'
      ),
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' }),
      refusal('JV_RATE_LIMITED', 429, 'Too many wrong passwords. Try again in 15 minutes.'),
      refusal('JV_FORBIDDEN', 403, 'You are not allowed to do this. Nothing was changed.'),
      refusal('JV_UNAVAILABLE', 503, 'Cannot reach the server. Try again in a minute.'),
    ]) {
      for (const [call, build] of [
        [
          'superAddPerson',
          () => newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
        ],
        ['superResetPassword', () => resetPersonChange(MEENA)],
      ] as const) {
        const { writes, reload } = fakeWrites();
        (writes[call] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(refused);
        const outcome = await runChange(
          writes as unknown as PeopleWrites,
          reload,
          build(),
          PASSWORD
        );
        expect(outcome, `${call}: ${refused.message}`).toEqual({
          error: refused.message,
          temporary: null,
        });
      }
    }
  });

  it('an answer that has no temporary password keeps its own sentence (the person WAS made, and the way on is spelled out there): no second sentence', async () => {
    const { writes, reload } = fakeWrites();
    writes.superAddPerson.mockResolvedValueOnce({
      person: MEENA,
    } as unknown as SuperNewPersonAnswer);
    const outcome = await runChange(
      writes as unknown as PeopleWrites,
      reload,
      newPersonChange({ full_name: 'M', email: 'm@x.co', role: 'zk-cashier' }, ROLES),
      PASSWORD
    );
    expect(outcome.error).toMatch(/temporary password could not be read/);
    expect(outcome.error).not.toContain(IF_LISTED);
  });

  it('through the real client, an Add person whose answer is a gateway page is sent ONCE, says it could not be confirmed with the way on, and reads the lists (the person made by the lost answer is there)', async () => {
    const fetched: string[] = [];
    const server = { people: [SIDDHI] };
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      sleep: async () => undefined,
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        fetched.push(`${init.method ?? 'GET'} ${url.pathname}`);
        if (init.method === 'POST') {
          // the API commits, and a gateway answers instead of it, again and again
          server.people.push(person({ full_name: 'Meena Shah', email: 'meena@example.test' }));
          return new Response('<html>Bad gateway</html>', { status: 502 });
        }
        const body = url.pathname.endsWith('/people')
          ? { people: server.people }
          : { roles: [R_OWNER, R_CASHIER] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    const store = createSuperStore({
      superTicks: async () => ({ groups: [], ticks: [] }),
      superPeople: () => client.superPeople(),
      superRoles: () => client.superRoles(),
    });
    await store.open();
    fetched.length = 0;
    const outcome = await runChange(
      client,
      store.reload,
      newPersonChange(
        { full_name: 'Meena Shah', email: 'meena@example.test', role: 'zk-cashier' },
        ROLES
      ),
      PASSWORD
    );
    expect(fetched.filter((call) => call.startsWith('POST'))).toEqual(['POST /v1/super/people']);
    expect(outcome).toEqual({ error: `${UNCONFIRMED_MESSAGE} ${IF_LISTED}`, temporary: null });
    expect(store.state().people.map((one) => one.email)).toEqual([
      SIDDHI.email,
      'meena@example.test',
    ]);
  });
});

describe('Final review M3: a long name or e-mail wraps in a row of the People list (375 px)', () => {
  // Found by the final review: a name of 120 characters or an e-mail of 254 (the API's limits) with no space in it was cut off at the edge of the card (`overflow-hidden`), and in the table
  // (768 px and up) pushed the Actions column out of it. `break-words` is what wraps a block on a phone; `overflow-wrap: anywhere` is what also lets a table column shrink below the length of
  // its longest word (`break-word` does not), so both are on the text. Measured in a real browser at 375, 768 and 1280 px.
  const LONG_NAME = `Abcdefghij${'k'.repeat(110)}`;
  const LONG_EMAIL = `${'a'.repeat(64)}@${'b'.repeat(60)}.example.test`;
  const classesOf = (html: string, text: string) =>
    (new RegExp(`<span class="([^"]*)">${text}</span>`).exec(html)?.[1] ?? '').split(/\s+/);

  it('the name and the e-mail of a person can break anywhere', () => {
    const html = rowsOf(drawList([person({ full_name: LONG_NAME, email: LONG_EMAIL })]))[0];
    for (const text of [LONG_NAME, LONG_EMAIL]) {
      const classes = classesOf(html, text);
      expect(classes, text.slice(0, 12)).toContain('break-words');
      expect(classes, text.slice(0, 12)).toContain('[overflow-wrap:anywhere]');
    }
  });

  it('the name is still the bold block and the e-mail the small grey one: only the wrapping was added', () => {
    const html = rowsOf(drawList([ANITA]))[0];
    expect(classesOf(html, 'Anita Sharma')).toEqual(
      expect.arrayContaining(['block', 'font-semibold'])
    );
    expect(classesOf(html, 'anita@example.test')).toEqual(
      expect.arrayContaining(['block', 'text-[13px]', 'text-muted-foreground'])
    );
  });
});

// ================================================================================================ the glue the other tests cannot reach

// There is no DOM here, so the hand-over of `reload` from the shell down to the write is read from the syntax tree (the way the screens of Task 20b pin a seam): a dialog that handed on a
// reload of its own, or none, would show the old list after a write.
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

describe('Task 23 review: no opener can replace the dialog that is open', () => {
  // Focus is not trapped behind the overlay: a button of the list can be reached with the keyboard while a dialog is up (the temporary password, or a write on its way). So both openers
  // hand their choice to `openIfFree`, which keeps what is open. There is no DOM here, so the glue is read from the code.
  it('every call of setOpen in the People tab either closes (null) or hands its choice to openIfFree with what is open now', () => {
    const calls = callsOf('PeopleTab.tsx', 'setOpen').map(([argument]) => argument);
    expect(calls).toHaveLength(3);
    expect(calls.filter((argument) => argument === 'null')).toHaveLength(1);
    for (const argument of calls.filter((a) => a !== 'null'))
      expect(argument).toMatch(/^\(now\) => openIfFree\(now, \{/);
  });

  it('the two openers are the add button and the buttons of a row', () => {
    const calls = callsOf('PeopleTab.tsx', 'openIfFree');
    expect(calls).toHaveLength(2);
    expect(calls.map(([, choice]) => choice).sort()).toEqual([
      "{ kind: 'add' }",
      '{ kind: action, person }',
    ]);
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

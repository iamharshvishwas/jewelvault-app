// Access and roles (Task 24): the Roles tab of People & Roles (plan: Task 24; DESIGN 6.5 and 6.6; API Task 13; the pictures are mockups/2-roles.png, 4-password-confirm.png and 5-phone.png).
//   - lib/roles.ts: which buttons a role has, when it can be switched off and why not, the tick summary, what the New role form checks;
//   - lib/roleChange.ts: what is about to happen, in words (the title, the sentences and the button of the password step) for a new role and for a switch;
//   - lib/roleWrite.ts and lib/afterWrite.ts: the two writes with the Super Admin's password in the body, the lists read again after a write (and after a stale answer), the API's sentence;
//   - the markup of the list, the New role dialog and the switch dialog (drawn on the server side of React: there is no DOM here), and the glue a drawing cannot reach (read from the code);
//   - a guard over every file of the screen (the tripwire of tests/unit/support/leaks.ts also walks the files of this task, from the Task 22 and 23 tests).
//
// The Super Admin's real password is never used here, and no password is written in a title: the tests make them up and never print them.
//
// Run: npx vitest run tests/unit/people-roles-roles.test.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AddPersonDialog from '@/app/people-roles/components/AddPersonDialog';
import ChangeRoleDialog from '@/app/people-roles/components/ChangeRoleDialog';
import EditPersonDialog from '@/app/people-roles/components/EditPersonDialog';
import { firstToFill } from '@/app/people-roles/components/FormDialog';
import NewRoleDialog from '@/app/people-roles/components/NewRoleDialog';
import { PeopleRolesView } from '@/app/people-roles/components/PeopleRolesClient';
import RolesTab, { RolesTabView } from '@/app/people-roles/components/RolesTab';
import SwitchRoleDialog from '@/app/people-roles/components/SwitchRoleDialog';
import { failureOf, readAgain } from '@/app/people-roles/lib/afterWrite';
import {
  newRoleChange,
  roleChangeConfirmLabel,
  roleChangeSummary,
  roleChangeTitle,
  switchRoleChange,
} from '@/app/people-roles/lib/roleChange';
import {
  actionLabel,
  canSwitchOff,
  cleanRoleName,
  dialogFor,
  lockLine,
  peopleLine,
  roleActions,
  roleSummary,
  startFromChoices,
  switchOffReason,
  validateNewRole,
} from '@/app/people-roles/lib/roles';
import { runRoleChange, type RoleWrites } from '@/app/people-roles/lib/roleWrite';
import type { SuperView } from '@/app/people-roles/lib/useSuper';
import { ApiError } from '@/lib/api/client';
import { ROLE_CHANGED_MESSAGE, UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import type {
  SuperCreateRoleBody,
  SuperPerson,
  SuperRole,
  SuperRoleActiveBody,
  SuperRoleAnswer,
} from '@/lib/api/types';
import { PLAN_TICKS } from './support/access';
import { PASSWORD_NAMES, leaksOf, sourcesUnder } from './support/leaks';
import {
  buttonsOf,
  callsOf,
  chosenOf,
  conditionsAround,
  draw,
  elementsOf,
  optionsOf,
  plain,
} from './support/screen';

const STAMP = '2026-11-19T07:41:12.123456Z';
const NEWER = '2026-11-19T08:02:55.654321Z';
const TOTAL = PLAN_TICKS.length; // the 32 ticks of the catalogue

// The passwords of the tests are made up for each run and are never printed: a check that compares one answers true or false.
const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

// role keys that differ from the role names, on purpose: a key on screen would show
const role = (over: Partial<SuperRole> = {}): SuperRole => ({
  key: 'zk-keeper',
  name: 'Stock Keeper',
  description: '',
  active: true,
  fixed: false,
  ticks: ['stock_add', 'stock_edit', 'stock_status', 'category_add', 'order_view', 'reports_open'],
  people: 1,
  updated_at: STAMP,
  ...over,
});
const R_OWNER = role({
  key: 'owner',
  name: 'Owner',
  description: 'Everything. This role cannot be changed.',
  fixed: true,
  ticks: [...PLAN_TICKS],
  people: 1,
});
const R_CASHIER = role({
  key: 'zk-cashier',
  name: 'Cashier',
  description: 'Makes bills and takes payments',
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
  people: 3,
});
const R_KEEPER = role({ key: 'zk-keeper', name: 'Stock Keeper', people: 1 });
const R_BILLER = role({
  key: 'zk-biller',
  name: 'Biller',
  description: 'The original Biller role',
  ticks: R_CASHIER.ticks,
  people: 0,
});
const R_OLD = role({
  key: 'zk-old',
  name: 'Old Role',
  description: 'Not used any more',
  active: false,
  ticks: ['order_view'],
  people: 0,
});
const R_NONE = role({ key: 'zk-none', name: 'No ticks', ticks: [], people: 0 });
const ROLES = [R_OWNER, R_CASHIER, R_KEEPER, R_BILLER, R_OLD];

const noop = () => undefined;
const reload = async () => undefined;
const refusal = (code: string, status: number, message: string, details = {}) =>
  new ApiError({ code, status, message, details, write: true });

// ================================================================================================ the rules of the tab

describe('Task 24 roleActions: the buttons of a row', () => {
  it('roleActions: the Owner row (fixed) offers no action; every other row offers edit, copy and switch', () => {
    expect(roleActions(R_OWNER)).toEqual([]);
    expect(roleActions(R_CASHIER)).toEqual(['edit', 'copy', 'switch']);
    expect(roleActions(R_BILLER)).toEqual(['edit', 'copy', 'switch']);
    expect(roleActions(R_NONE)).toEqual(['edit', 'copy', 'switch']);
  });

  it('a switched-off role has the same three buttons, and the last one reads Switch on', () => {
    expect(roleActions(R_OLD)).toEqual(['edit', 'copy', 'switch']);
    expect(actionLabel('switch', R_OLD)).toBe('Switch on');
    expect(actionLabel('switch', R_CASHIER)).toBe('Switch off');
  });

  it('the words of the buttons are those of the picture', () => {
    expect(
      (['edit', 'copy', 'switch'] as const).map((action) => actionLabel(action, R_BILLER))
    ).toEqual(['Edit', 'Copy', 'Switch off']);
  });

  it('the Owner row says why it has no button (the picture: the lock line), the others have none', () => {
    expect(lockLine(R_OWNER)).toBe('Cannot be changed or switched off');
    for (const other of [R_CASHIER, R_BILLER, R_OLD]) expect(lockLine(other)).toBeNull();
  });
});

describe('Task 24 canSwitchOff', () => {
  it('a role that people hold cannot be switched off', () => {
    expect(canSwitchOff(R_CASHIER)).toBe(false);
    expect(canSwitchOff(role({ people: 1 }))).toBe(false);
  });

  it('a role that nobody holds can be switched off', () => {
    expect(canSwitchOff(R_BILLER)).toBe(true);
    expect(canSwitchOff(R_NONE)).toBe(true);
  });

  it('the Owner can never be switched off, not even with nobody on it; a role that is already off is not switched off again', () => {
    expect(canSwitchOff(role({ ...R_OWNER, people: 0 }))).toBe(false);
    expect(canSwitchOff(R_OWNER)).toBe(false);
    expect(canSwitchOff(R_OLD)).toBe(false);
  });

  it('switchOffReason says in plain words how many people hold the role, and says nothing when the role can be switched off', () => {
    expect(switchOffReason(R_CASHIER)).toBe(
      '3 people have this role. Give them another role first.'
    );
    expect(switchOffReason(role({ people: 1 }))).toBe(
      '1 person has this role. Give them another role first.'
    );
    expect(switchOffReason(R_BILLER)).toBeNull();
  });

  it('switchOffReason has nothing to say for the Owner (the lock line does) and for a role that is switched off (Switch on is always allowed)', () => {
    expect(switchOffReason(R_OWNER)).toBeNull();
    expect(switchOffReason(role({ ...R_OLD, people: 2 }))).toBeNull();
  });

  it('the reason and the permission always agree: a reason exists exactly when an active, non-fixed role cannot be switched off', () => {
    for (const r of [R_OWNER, R_CASHIER, R_BILLER, R_OLD, R_NONE, role({ people: 1 })])
      expect(switchOffReason(r) !== null, r.name).toBe(r.active && !r.fixed && !canSwitchOff(r));
  });
});

describe('Task 24 the words of a row', () => {
  it('roleSummary: "3 of 32 ticks" for the ticks that are on, out of the ticks there are', () => {
    expect(roleSummary(R_CASHIER, TOTAL)).toBe('9 of 32 ticks');
    expect(roleSummary(R_KEEPER, TOTAL)).toBe('6 of 32 ticks');
    expect(roleSummary(R_NONE, TOTAL)).toBe('0 of 32 ticks');
    expect(roleSummary(role({ ticks: ['order_view'] }), TOTAL)).toBe('1 of 32 ticks');
  });

  it('roleSummary: the Owner has all of them', () => {
    expect(roleSummary(R_OWNER, TOTAL)).toBe('32 of 32 ticks');
  });

  it('roleSummary: when the catalogue has not arrived (no total) it says how many ticks the role has, and nothing it cannot know', () => {
    expect(roleSummary(R_CASHIER, 0)).toBe('9 ticks');
    expect(roleSummary(role({ ticks: ['order_view'] }), 0)).toBe('1 tick');
    expect(roleSummary(R_NONE, 0)).toBe('0 ticks');
  });

  it('peopleLine: n people, 1 person, 0 people', () => {
    expect(peopleLine(0)).toBe('0 people');
    expect(peopleLine(1)).toBe('1 person');
    expect(peopleLine(2)).toBe('2 people');
    expect(peopleLine(14)).toBe('14 people');
  });
});

// ================================================================================================ the New role form

describe('Task 24 validateNewRole', () => {
  it('validateNewRole names every missing field with the words of the plan and accepts a complete one', () => {
    expect(validateNewRole({ copy_of: '', name: '' })).toEqual({
      copy_of: 'Choose a role to start from.',
      name: 'Name is required.',
    });
    expect(validateNewRole({ copy_of: 'zk-biller', name: '   ' })).toEqual({
      name: 'Name is required.',
    });
    expect(validateNewRole({ copy_of: '', name: 'Cashier' })).toEqual({
      copy_of: 'Choose a role to start from.',
    });
    expect(validateNewRole({ copy_of: 'zk-biller', name: 'Cashier' })).toEqual({});
  });

  it('a name of 41 characters is refused (the API takes 40), and 40 is accepted, with or without spaces around it', () => {
    const errorFor = (name: string) => validateNewRole({ copy_of: 'zk-biller', name }).name;
    expect(errorFor('a'.repeat(40))).toBeUndefined();
    expect(errorFor(`  ${'a'.repeat(40)}  `)).toBeUndefined();
    expect(errorFor('a'.repeat(41))).toBe('Name is 40 characters at most.');
  });

  it('spaces inside a name count once, as the API keeps it (it folds them): 41 characters of which some are repeated spaces can still fit', () => {
    expect(
      validateNewRole({ copy_of: 'k', name: `${'a'.repeat(19)}${' '.repeat(9)}${'b'.repeat(20)}` })
    ).toEqual({});
    expect(cleanRoleName('  Stock    Keeper \t ')).toBe('Stock Keeper');
    expect(cleanRoleName('Cashier')).toBe('Cashier');
    expect(cleanRoleName('   ')).toBe('');
  });

  it('the description is optional and 200 characters at most', () => {
    const errorFor = (description: string) =>
      validateNewRole({ copy_of: 'k', name: 'Cashier', description }).description;
    expect(errorFor('')).toBeUndefined();
    expect(errorFor('a'.repeat(200))).toBeUndefined();
    expect(errorFor('a'.repeat(201))).toBe('Description is 200 characters at most.');
    expect(validateNewRole({ copy_of: 'k', name: 'Cashier' })).toEqual({});
  });
});

describe('Task 24 startFromChoices: the chooser of "Start from"', () => {
  it('lists every role, the Owner and the switched-off ones too, in the order given, a switched-off one marked in words', () => {
    const choices = startFromChoices(ROLES);
    expect(choices.map((r) => r.name)).toEqual([
      'Owner',
      'Cashier',
      'Stock Keeper',
      'Biller',
      'Old Role (switched off)',
    ]);
    expect(choices.map((r) => r.key)).toEqual(ROLES.map((r) => r.key));
  });

  it('does not change the roles it is given', () => {
    const before = JSON.stringify(ROLES);
    startFromChoices(ROLES);
    expect(JSON.stringify(ROLES)).toBe(before);
    expect(R_OLD.name).toBe('Old Role');
  });
});

describe('Task 24 dialogFor: what a button of a row opens', () => {
  it('Copy opens the New role dialog with that role to start from; Switch opens the switch dialog for that role', () => {
    expect(dialogFor('copy', R_CASHIER)).toEqual({ kind: 'new', copyOf: 'zk-cashier' });
    expect(dialogFor('switch', R_BILLER)).toEqual({ kind: 'switch', role: R_BILLER });
  });

  it('Edit opens no dialog (it goes to the screen of the role)', () => {
    expect(dialogFor('edit', R_CASHIER)).toBeNull();
  });
});

// ================================================================================================ what is about to happen, in words

describe('Task 24 the password step says exactly what will happen', () => {
  const create = newRoleChange(
    { copy_of: 'zk-biller', name: '  Cashier  ', description: ' Makes bills ' },
    ROLES
  );

  it('a new role: the name as it will be saved, the role it starts from by its name, and where its ticks are changed', () => {
    expect(create).toEqual({
      kind: 'create',
      copy_of: 'zk-biller',
      copyName: 'Biller',
      name: 'Cashier',
      description: 'Makes bills',
    });
    expect(roleChangeSummary(create)).toEqual([
      'Create the role Cashier, starting from Biller',
      'You can then change its ticks with Edit.',
    ]);
    expect(roleChangeTitle(create)).toBe('Create this role?');
    expect(roleChangeConfirmLabel(create)).toBe('Confirm and create');
  });

  it('a switched-off role to start from is named without the mark, and the Owner by its name', () => {
    const fromOld = newRoleChange({ copy_of: 'zk-old', name: 'Next', description: '' }, ROLES);
    expect(roleChangeSummary(fromOld)[0]).toBe('Create the role Next, starting from Old Role');
    const fromOwner = newRoleChange({ copy_of: 'owner', name: 'Next', description: '' }, ROLES);
    expect(roleChangeSummary(fromOwner)[0]).toBe('Create the role Next, starting from Owner');
  });

  it('inner spaces of the name are folded in the words too: the words say what is saved', () => {
    const change = newRoleChange(
      { copy_of: 'zk-biller', name: 'Stock   Keeper', description: '' },
      ROLES
    );
    expect(roleChangeSummary(change)[0]).toBe('Create the role Stock Keeper, starting from Biller');
  });

  it('switching off, and on: the first line says what happens, a second what follows from it', () => {
    const off = switchRoleChange(R_BILLER);
    expect(off).toEqual({ kind: 'switch', role: R_BILLER, active: false });
    expect(roleChangeSummary(off)).toEqual([
      'Switch off the role Biller',
      'Nobody can be given this role while it is switched off.',
    ]);
    expect(roleChangeTitle(off)).toBe('Switch off this role?');
    expect(roleChangeConfirmLabel(off)).toBe('Confirm and switch off');
    const on = switchRoleChange(R_OLD);
    expect(on).toEqual({ kind: 'switch', role: R_OLD, active: true });
    expect(roleChangeSummary(on)).toEqual([
      'Switch on the role Old Role',
      'People can be given this role again.',
    ]);
    expect(roleChangeTitle(on)).toBe('Switch on this role?');
    expect(roleChangeConfirmLabel(on)).toBe('Confirm and switch on');
  });

  it('no sentence names a role key, an id or a stamp', () => {
    for (const change of [create, switchRoleChange(R_BILLER), switchRoleChange(R_OLD)]) {
      const words = [
        roleChangeTitle(change),
        roleChangeConfirmLabel(change),
        ...roleChangeSummary(change),
      ].join(' ');
      for (const hidden of ['zk-', STAMP, 'owner'])
        expect(words.includes(hidden), hidden).toBe(false);
    }
  });
});

// ================================================================================================ the writes

/** The two role writes of the client, answering as the plan says, and a log of the order in which things happened. */
function fakeWrites() {
  const log: string[] = [];
  const writes = {
    superCreateRole: vi.fn(async (body: SuperCreateRoleBody): Promise<SuperRoleAnswer> => {
      log.push('write');
      return {
        role: role({
          key: 'zk-new',
          name: body.name,
          description: body.description ?? '',
          people: 0,
        }),
      };
    }),
    superSetRoleActive: vi.fn(
      async (key: string, body: SuperRoleActiveBody): Promise<SuperRoleAnswer> => {
        log.push('write');
        return { role: role({ key, active: body.active, updated_at: NEWER }) };
      }
    ),
  };
  const read = vi.fn(async () => {
    log.push('reload');
  });
  return { writes: writes as unknown as RoleWrites & typeof writes, reload: read, log };
}

/** A body as it was sent, with the Super Admin's password turned into words: a failing check never prints it. */
const masked = (body: unknown) => {
  const { password, ...rest } = body as { password?: string };
  return {
    ...rest,
    password: password === PASSWORD ? 'the typed password' : 'NOT THE TYPED PASSWORD',
  };
};

describe('Task 24 runRoleChange: each write sends the right call with the password in its body', () => {
  it('create with a description: the key to start from, the name, the description, the password', async () => {
    const { writes, reload: read } = fakeWrites();
    const change = newRoleChange(
      { copy_of: 'zk-biller', name: ' Cashier ', description: ' Makes bills ' },
      ROLES
    );
    const outcome = await runRoleChange(writes, read, change, PASSWORD);
    expect(writes.superCreateRole).toHaveBeenCalledTimes(1);
    expect(masked(writes.superCreateRole.mock.calls[0][0])).toStrictEqual({
      copy_of: 'zk-biller',
      name: 'Cashier',
      description: 'Makes bills',
      password: 'the typed password',
    });
    expect(outcome).toEqual({ error: null });
  });

  it('create without a description sends none at all (an empty one is not sent)', async () => {
    for (const description of ['', '   ']) {
      const { writes, reload: read } = fakeWrites();
      const change = newRoleChange({ copy_of: 'zk-biller', name: 'Cashier', description }, ROLES);
      await runRoleChange(writes, read, change, PASSWORD);
      const body = writes.superCreateRole.mock.calls[0][0];
      expect('description' in body, JSON.stringify(description)).toBe(false);
      expect(masked(body)).toStrictEqual({
        copy_of: 'zk-biller',
        name: 'Cashier',
        password: 'the typed password',
      });
    }
  });

  it('switch off: the role by its key, with the stamp it was listed with, active false and the password', async () => {
    const { writes, reload: read } = fakeWrites();
    const outcome = await runRoleChange(writes, read, switchRoleChange(R_BILLER), PASSWORD);
    expect(writes.superSetRoleActive).toHaveBeenCalledTimes(1);
    const [key, body] = writes.superSetRoleActive.mock.calls[0];
    expect(key).toBe('zk-biller');
    expect(masked(body)).toStrictEqual({
      expected_updated_at: STAMP,
      active: false,
      password: 'the typed password',
    });
    expect(outcome).toEqual({ error: null });
  });

  it('switch on: active true, with the stamp of that role', async () => {
    const { writes, reload: read } = fakeWrites();
    await runRoleChange(
      writes,
      read,
      switchRoleChange(role({ ...R_OLD, updated_at: NEWER })),
      PASSWORD
    );
    const [key, body] = writes.superSetRoleActive.mock.calls[0];
    expect(key).toBe('zk-old');
    expect(masked(body)).toStrictEqual({
      expected_updated_at: NEWER,
      active: true,
      password: 'the typed password',
    });
  });

  it("the Super Admin's password is in the body of the write only: not in the key, not in what comes back", async () => {
    const { writes, reload: read } = fakeWrites();
    for (const change of [
      newRoleChange({ copy_of: 'zk-biller', name: 'Cashier', description: 'x' }, ROLES),
      switchRoleChange(R_BILLER),
      switchRoleChange(R_OLD),
    ]) {
      const outcome = await runRoleChange(writes, read, change, PASSWORD);
      expect(JSON.stringify(outcome).includes(PASSWORD), change.kind).toBe(false);
    }
    for (const [key] of writes.superSetRoleActive.mock.calls)
      expect(key.includes(PASSWORD)).toBe(false);
    expect(read.mock.calls.every((args) => args.length === 0)).toBe(true);
  });
});

describe('Task 24 runRoleChange: the lists are read again after a write', () => {
  const kinds = [
    ['create', () => newRoleChange({ copy_of: 'zk-biller', name: 'C', description: '' }, ROLES)],
    ['switch off', () => switchRoleChange(R_BILLER)],
    ['switch on', () => switchRoleChange(R_OLD)],
  ] as const;

  it.each(kinds)('%s: the lists are read again once, after the write', async (_kind, build) => {
    const { writes, reload: read, log } = fakeWrites();
    await runRoleChange(writes, read, build(), PASSWORD);
    expect(log).toEqual(['write', 'reload']);
  });

  it("a refusal that says nothing was written and has nothing to do with an old list (a wrong password, the pause, a taken name) shows the API's sentence untouched and reads nothing again", async () => {
    for (const refused of [
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' }),
      refusal('JV_RATE_LIMITED', 429, 'Too many wrong passwords. Try again in 15 minutes.'),
      refusal(
        'JV_INVALID_INPUT',
        422,
        'name is already used by another role. Nothing was changed.',
        {
          field: 'name',
        }
      ),
      refusal('JV_FORBIDDEN', 403, 'You are not allowed to do this. Nothing was changed.'),
    ]) {
      const { writes, reload: read } = fakeWrites();
      writes.superCreateRole.mockRejectedValueOnce(refused);
      const change = newRoleChange({ copy_of: 'owner', name: 'Copy', description: '' }, ROLES);
      const outcome = await runRoleChange(writes, read, change, PASSWORD);
      expect(outcome, refused.message).toEqual({ error: refused.message });
      expect(read, refused.message).not.toHaveBeenCalled();
    }
  });

  it("a stale answer (someone else changed the role) shows the client's words and reads the lists again, so the row shows the state it has now", async () => {
    const { writes, reload: read } = fakeWrites();
    writes.superSetRoleActive.mockRejectedValueOnce(refusal('JV_STALE', 409, ROLE_CHANGED_MESSAGE));
    const outcome = await runRoleChange(writes, read, switchRoleChange(R_BILLER), PASSWORD);
    expect(outcome).toEqual({ error: 'This was changed by someone else. Reload and try again.' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a refusal by a rule shows the API's sentence untouched and reads the lists again too: the people count of the row may be old (a person was given the role in another tab, which does not change the role's own stamp)", async () => {
    for (const sentence of [
      '3 people still have this role. Move them to another role first.',
      'The Owner role is fixed and cannot be changed.',
    ]) {
      const { writes, reload: read } = fakeWrites();
      writes.superSetRoleActive.mockRejectedValueOnce(refusal('JV_NOT_ALLOWED', 409, sentence));
      const outcome = await runRoleChange(writes, read, switchRoleChange(R_BILLER), PASSWORD);
      expect(outcome).toEqual({ error: sentence });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('an outcome nobody can vouch for is read again, and says it could not be confirmed', async () => {
    for (const cause of [
      refusal('JV_INTERNAL', 500, UNCONFIRMED_MESSAGE),
      new TypeError('Failed to fetch'),
      'boom',
    ]) {
      const { writes, reload: read } = fakeWrites();
      writes.superSetRoleActive.mockRejectedValueOnce(cause);
      const outcome = await runRoleChange(writes, read, switchRoleChange(R_BILLER), PASSWORD);
      expect(outcome).toEqual({ error: UNCONFIRMED_MESSAGE });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('a reload that rejects after a write that went through is still a write that went through', async () => {
    for (const change of [
      newRoleChange({ copy_of: 'zk-biller', name: 'C', description: '' }, ROLES),
      switchRoleChange(R_BILLER),
    ]) {
      const { writes, reload: read } = fakeWrites();
      read.mockRejectedValueOnce(new Error('the lists could not be read'));
      const outcome = await runRoleChange(writes, read, change, PASSWORD);
      expect(outcome, change.kind).toEqual({ error: null });
    }
  });
});

describe('Task 24 what a failed write says (shared with the People tab)', () => {
  it('the API\'s own sentence is kept as it is; an unknown failure, or a refusal with no sentence, is "Could not confirm that this was saved."', () => {
    expect(failureOf(refusal('JV_NOT_ALLOWED', 409, ' This is not allowed. ')).error).toBe(
      'This is not allowed.'
    );
    expect(failureOf(refusal('JV_INTERNAL', 500, '')).error).toBe(UNCONFIRMED_MESSAGE);
    expect(failureOf(new Error('a bug')).error).toBe(UNCONFIRMED_MESSAGE);
    expect(failureOf('boom').error).toBe(UNCONFIRMED_MESSAGE);
  });

  it('the lists are read again after everything but a refusal that wrote nothing; the codes given are read again as well', () => {
    expect(failureOf(refusal('JV_INVALID_INPUT', 422, 'x')).reread).toBe(false);
    expect(failureOf(refusal('JV_STALE', 409, 'x')).reread).toBe(false);
    expect(failureOf(refusal('JV_STALE', 409, 'x'), ['JV_STALE']).reread).toBe(true);
    expect(failureOf(refusal('JV_INVALID_INPUT', 422, 'x'), ['JV_STALE']).reread).toBe(false);
    expect(failureOf(refusal('JV_INTERNAL', 500, 'x')).reread).toBe(true);
    expect(failureOf(new TypeError('Failed to fetch')).reread).toBe(true);
  });

  it('readAgain never throws, whatever the read does', async () => {
    const reads = vi.fn(async () => undefined);
    await readAgain(reads);
    expect(reads).toHaveBeenCalledTimes(1);
    await expect(readAgain(async () => Promise.reject(new Error('no')))).resolves.toBeUndefined();
    await expect(
      readAgain(() => {
        throw new Error('no');
      })
    ).resolves.toBeUndefined();
  });
});

// ================================================================================================ the list

const drawList = (roles: SuperRole[] = ROLES, tickTotal = TOTAL) =>
  draw(RolesTabView, { roles, tickTotal, onNew: noop, onAction: noop });
const rowsOf = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-testid="role-row"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
const buttonTag = (row: string, action: string) =>
  row.match(new RegExp(`<button[^>]*data-testid="role-${action}"[^>]*>`))?.[0] ?? '';

describe('Task 24 the Roles list', () => {
  it('has the table of the picture: Role, People, Ticks on, Actions, one row for each role, and the note under it', () => {
    const html = drawList();
    expect(
      [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]),
      'the headings'
    ).toEqual(['Role', 'People', 'Ticks on', 'Actions']);
    expect(rowsOf(html)).toHaveLength(5);
    expect(plain(html)).toContain(
      'A role can be switched off only when nobody has it. Nothing is ever deleted.'
    );
  });

  it('has the + New role button, at the top of the panel', () => {
    const html = drawList();
    expect(html).toMatch(/<button[^>]*data-testid="new-role"[^>]*>\+ New role<\/button>/);
    expect(html.indexOf('data-testid="new-role"')).toBeLessThan(html.indexOf('<table'));
  });

  it('a role: the name and what it is for, how many people have it, the ticks on, and the three buttons', () => {
    const row = rowsOf(drawList())[1];
    const words = plain(row);
    expect(words).toContain('Cashier');
    expect(words).toContain('Makes bills and takes payments');
    expect(words).toContain('3 people');
    expect(words).toContain('9 of 32 ticks');
    expect(buttonsOf(row)).toEqual(['Edit', 'Copy', 'Switch off']);
  });

  it('the people are counted in words: "1 person", "0 people"', () => {
    const rows = rowsOf(drawList());
    expect(plain(rows[2])).toContain('1 person');
    expect(plain(rows[3])).toContain('0 people');
    expect(plain(rows[3])).not.toContain('0 person ');
  });

  it('the Owner row: Fixed, every tick, the lock line, and no button at all', () => {
    const row = rowsOf(drawList())[0];
    const words = plain(row);
    expect(words).toContain('Owner');
    expect(words).toContain('Fixed');
    expect(words).toContain('Everything. This role cannot be changed.');
    expect(words).toContain('1 person');
    expect(words).toContain('32 of 32 ticks');
    expect(words).toContain('Cannot be changed or switched off');
    expect(row).toContain('data-testid="role-lock-line"');
    expect(buttonsOf(row)).toEqual([]);
  });

  it('Fixed marks the Owner and nobody else', () => {
    for (const row of rowsOf(drawList()).slice(1)) {
      expect(plain(row)).not.toContain('Fixed');
      expect(row).not.toContain('data-testid="role-lock-line"');
    }
  });

  it('a role that people have: Switch off is DISABLED and the reason is in the row, next to it, tied to the button for a screen reader', () => {
    const row = rowsOf(drawList())[1];
    const off = buttonTag(row, 'switch');
    expect(off).toMatch(/\sdisabled=""/);
    expect(plain(row)).toContain('3 people have this role. Give them another role first.');
    const describedBy = /aria-describedby="([^"]+)"/.exec(off)?.[1] ?? '';
    expect(describedBy).not.toBe('');
    expect(row).toMatch(
      new RegExp(
        `id="${describedBy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[^<]*3 people have this role`
      )
    );
    // the other two buttons work
    expect(buttonTag(row, 'edit')).not.toMatch(/\sdisabled=""/);
    expect(buttonTag(row, 'copy')).not.toMatch(/\sdisabled=""/);
  });

  it('one person is enough to block it, and the reason says so in the singular', () => {
    const row = rowsOf(drawList())[2];
    expect(buttonTag(row, 'switch')).toMatch(/\sdisabled=""/);
    expect(plain(row)).toContain('1 person has this role. Give them another role first.');
  });

  it('a role that nobody has: Switch off works, and there is no reason shown', () => {
    const row = rowsOf(drawList())[3];
    expect(buttonTag(row, 'switch')).not.toMatch(/\sdisabled=""/);
    expect(plain(row)).not.toContain('have this role');
    expect(plain(row)).not.toContain('has this role');
    expect(row).not.toContain('aria-describedby');
    expect(buttonsOf(row)).toEqual(['Edit', 'Copy', 'Switch off']);
  });

  it('a switched-off role: greyed, marked Switched off, and Switch on in place of Switch off (always allowed)', () => {
    const row = rowsOf(drawList())[4];
    expect(plain(row)).toContain('Old Role');
    expect(plain(row)).toContain('Switched off');
    expect(row).toMatch(/<tr[^>]*bg-\[#faf7f1\]/);
    expect(buttonsOf(row)).toEqual(['Edit', 'Copy', 'Switch on']);
    expect(buttonTag(row, 'switch')).not.toMatch(/\sdisabled=""/);
    expect(row).not.toContain('Switch off');
  });

  it('Switch on never depends on the people count (a switched-off role should have no active people, and the button must not rely on it)', () => {
    const row = rowsOf(drawList([role({ ...R_OLD, people: 4 })]))[0];
    expect(buttonTag(row, 'switch')).not.toMatch(/\sdisabled=""/);
    expect(plain(row)).not.toContain('have this role');
  });

  it('an active role is not greyed, and has no Switched off mark', () => {
    for (const row of rowsOf(drawList()).slice(0, 4)) {
      expect(plain(row)).not.toContain('Switched off');
      expect(row).not.toMatch(/<tr[^>]*bg-\[#faf7f1\]/);
    }
  });

  it('the buttons say which role they are for, to a screen reader, and keep their words on screen', () => {
    const rows = rowsOf(drawList());
    expect(rows[1]).toContain('aria-label="Edit Cashier"');
    expect(rows[1]).toContain('aria-label="Copy Cashier"');
    expect(rows[1]).toContain('aria-label="Switch off Cashier"');
    expect(rows[4]).toContain('aria-label="Switch on Old Role"');
  });

  it('shows no role key and no stamp anywhere: the keys differ from the names on purpose', () => {
    const html = drawList();
    for (const hidden of ['zk-cashier', 'zk-biller', 'zk-keeper', 'zk-old', STAMP, 'updated_at'])
      expect(html.includes(hidden), hidden).toBe(false);
    expect(html).not.toMatch(/\bowner\b/);
  });

  it('without the catalogue the summary says how many ticks, and no total', () => {
    const rows = rowsOf(drawList(ROLES, 0));
    expect(plain(rows[1])).toContain('9 ticks');
    expect(plain(rows[1])).not.toContain(' of ');
  });

  it('the table turns into cards on a phone: the headings are hidden and each row is a block below the tablet width', () => {
    const html = drawList();
    expect(html).toMatch(/<thead[^>]*class="[^"]*\bhidden\b[^"]*\bmd:table-header-group\b/);
    for (const row of rowsOf(html))
      expect(row).toMatch(/class="[^"]*\bblock\b[^"]*\bmd:table-row\b/);
    expect(html).toMatch(/<table[^>]*class="[^"]*\bblock\b[^"]*\bmd:table\b/);
  });

  it('on a card the people and the ticks sit side by side on one line, and on a table each has its own column, without wrapping', () => {
    const cells = [...rowsOf(drawList())[1].matchAll(/<td[^>]*class="([^"]*)"[^>]*>/g)].map(
      (m) => m[1]
    );
    expect(cells).toHaveLength(4);
    for (const short of [cells[1], cells[2]]) {
      expect(short).toMatch(/\binline-block\b/);
      expect(short).toMatch(/\bmd:table-cell\b/);
      expect(short).toMatch(/\bmd:whitespace-nowrap\b/);
    }
  });

  it('draws no dialog and no alert until a button has been pressed', () => {
    const html = drawList();
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alert"');
  });
});

describe('Task 24 the tab inside the screen', () => {
  const catalogue = {
    groups: ['Stock'],
    ticks: PLAN_TICKS.map((key) => ({
      key,
      group: 'Stock',
      label: key,
      help: null,
      sensitive: false,
      needs: [],
    })),
  };
  const view = (over: Partial<SuperView> = {}): SuperView => ({
    status: 'ready',
    error: null,
    ticks: catalogue,
    people: [],
    roles: ROLES,
    reload,
    ...over,
  });

  it('the shell draws this tab in the Roles panel, and not in the People panel', () => {
    const roles = renderToStaticMarkup(
      createElement(PeopleRolesView, { view: view(), tab: 'roles', onTab: noop })
    );
    expect(roles).toContain('data-testid="roles-tab"');
    expect(plain(roles)).toContain('Cashier');
    expect(plain(roles)).toContain('+ New role');
    expect(roles).not.toContain('data-testid="people-tab"');
    expect(roles).not.toContain('data-testid="add-person"');
    const people = renderToStaticMarkup(
      createElement(PeopleRolesView, { view: view(), tab: 'people', onTab: noop })
    );
    expect(people).not.toContain('data-testid="roles-tab"');
    expect(people).not.toContain('data-testid="new-role"');
  });

  it('counts the ticks out of the catalogue the screen has loaded (32 here)', () => {
    const html = draw(RolesTab, {
      ticks: catalogue,
      people: [],
      roles: ROLES,
      reload,
      onEdit: noop,
    });
    expect(plain(html)).toContain('9 of 32 ticks');
    expect(plain(html)).toContain('32 of 32 ticks');
  });

  it('an empty catalogue gives "n ticks" and no total', () => {
    const html = draw(RolesTab, {
      ticks: { groups: [], ticks: [] },
      people: [],
      roles: ROLES,
      reload,
      onEdit: noop,
    });
    expect(plain(html)).toContain('9 ticks');
    expect(plain(html)).not.toContain('of 32');
  });

  it('draws no dialog at rest', () => {
    const html = draw(RolesTab, {
      ticks: catalogue,
      people: [],
      roles: ROLES,
      reload,
      onEdit: noop,
    });
    expect(html).not.toContain('role="dialog"');
  });
});

// ================================================================================================ the dialogs

describe('Task 24 the New role dialog', () => {
  const drawNew = (copyOf = '', roles: SuperRole[] = ROLES) =>
    draw(NewRoleDialog, { roles, copyOf, reload, onClose: noop });
  const inputTag = (html: string, testId: string) =>
    html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  const textareaTag = (html: string, testId: string) =>
    html.match(new RegExp(`<textarea[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

  it('has the three fields, the roles by name (the Owner too, a switched-off role marked), and the way on', () => {
    const html = drawNew();
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toContain('data-testid="new-role-dialog"');
    const words = plain(html);
    expect(words).toContain('New role');
    for (const label of ['Start from', 'Name', 'Description'])
      expect(words, label).toContain(label);
    expect(optionsOf(html)).toEqual([
      'Choose a role',
      'Owner',
      'Cashier',
      'Stock Keeper',
      'Biller',
      'Old Role (switched off)',
    ]);
    expect(words).toContain('Next, you will be asked for your password.');
    expect(buttonsOf(html)).toContain('Cancel');
    expect(buttonsOf(html)).toContain('Continue');
  });

  it('+ New role: nothing is chosen, nothing is typed, nothing is wrong yet', () => {
    const html = drawNew();
    expect(chosenOf(html)).toEqual(['Choose a role']);
    expect(inputTag(html, 'new-role-name')).toContain('value=""');
    expect(html).toMatch(/<textarea[^>]*data-testid="new-role-description"[^>]*><\/textarea>/);
    expect(html).not.toContain('role="alert"');
  });

  it('Copy: the role to start from is chosen, and the name is still empty (nothing is suggested)', () => {
    const html = drawNew('zk-cashier');
    expect(chosenOf(html)).toEqual(['Cashier']);
    expect(inputTag(html, 'new-role-name')).toContain('value=""');
    expect(html).toMatch(/<textarea[^>]*data-testid="new-role-description"[^>]*><\/textarea>/);
  });

  it('Copy of the Owner and of a switched-off role work too', () => {
    expect(chosenOf(drawNew('owner'))).toEqual(['Owner']);
    expect(chosenOf(drawNew('zk-old'))).toEqual(['Old Role (switched off)']);
  });

  it('a role to start from that is not in the list (any more) is no choice', () => {
    expect(chosenOf(drawNew('zk-gone'))).toEqual(['Choose a role']);
  });

  it('the name is at most 40 characters and the description 200, and a name starts with a capital letter on a phone', () => {
    const html = drawNew();
    const name = inputTag(html, 'new-role-name');
    expect(name).toContain('maxLength="40"');
    expect(name).toContain('autoCapitalize="words"');
    expect(textareaTag(html, 'new-role-description')).toContain('maxLength="200"');
  });

  it('the description is a plain text box, and says it is optional', () => {
    const html = drawNew();
    expect(html).toMatch(/<textarea/);
    expect(plain(html)).toContain('Description (optional)');
  });

  it('says what the new role starts with', () => {
    expect(plain(drawNew())).toContain('starts with the same ticks as the role you start from');
  });

  it('no role key and no stamp is in the markup: the options are positions in the list', () => {
    const html = drawNew('zk-cashier');
    for (const hidden of ['zk-cashier', 'zk-keeper', 'zk-biller', 'zk-old', 'value="owner"', STAMP])
      expect(html.includes(hidden), hidden).toBe(false);
  });
});

describe('Task 24 where the cursor goes when a form opens', () => {
  it('firstToFill: the first control that is empty, or the first control when none is', () => {
    expect(firstToFill(['', '', ''])).toBe(0); // + New role: nothing is chosen yet
    expect(firstToFill(['1', '', ''])).toBe(1); // Copy: the role to start from is chosen, the name is next
    expect(firstToFill(['1', 'Cashier', ''])).toBe(2);
    expect(firstToFill(['Meena Shah', 'meena@example.test'])).toBe(0); // Edit: everything is filled
    expect(firstToFill(['2'])).toBe(0); // Change role: the present role is chosen
    expect(firstToFill([])).toBe(0);
  });

  it('the frame of the forms uses it to place the cursor when a form opens', () => {
    expect(callsOf('FormDialog.tsx', 'firstToFill')).toHaveLength(1);
  });
});

describe('Task 24 the password step of the switch', () => {
  it('Switch off goes straight to the password step, and says what will happen', () => {
    const html = draw(SwitchRoleDialog, { role: R_BILLER, reload, onClose: noop });
    expect(html).toContain('data-testid="confirm-password-dialog"');
    const words = plain(html);
    expect(words).toContain('Switch off this role?');
    expect(words).toContain('Switch off the role Biller');
    expect(words).toContain('Nobody can be given this role while it is switched off.');
    expect(words).toContain('Confirm and switch off');
    expect(words).toContain('Your password');
    expect(html).toMatch(/<input[^>]*type="password"/);
  });

  it('Switch on has its own words', () => {
    const words = plain(draw(SwitchRoleDialog, { role: R_OLD, reload, onClose: noop }));
    expect(words).toContain('Switch on this role?');
    expect(words).toContain('Switch on the role Old Role');
    expect(words).toContain('Confirm and switch on');
  });

  it('the password field is empty, nothing is wrong yet, and no role key is in the markup', () => {
    const html = draw(SwitchRoleDialog, { role: R_BILLER, reload, onClose: noop });
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).not.toContain('role="alert"');
    for (const hidden of ['zk-biller', STAMP]) expect(html.includes(hidden), hidden).toBe(false);
  });
});

// ================================================================================================ the glue the other tests cannot reach

// There is no DOM here, so the hand-over of `reload` from the shell down to the write, and the checks that keep one dialog on screen, are read from the syntax tree (the way the People tab
// pins them): a dialog that handed on a reload of its own, or none, would show the old list after a write; an opener that took the place of an open dialog would lose a write's answer.
describe("Task 24 the shell's reload reaches every write", () => {
  it('the password step does the write with the reload it is given, and tells the dialog it is done once', () => {
    expect(callsOf('RoleSteps.tsx', 'runRoleChange')).toEqual([
      ['api', 'reload', 'change', 'password'],
    ]);
    expect(callsOf('RoleSteps.tsx', 'onClose')).toHaveLength(1);
  });

  it.each(['NewRoleDialog.tsx', 'SwitchRoleDialog.tsx'])(
    '%s hands its reload and its way out on to the password step',
    (file) => {
      const steps = elementsOf(file, 'RoleSteps');
      expect(steps.length, file).toBeGreaterThan(0);
      for (const attributes of steps) {
        expect(attributes.reload, file).toBe('reload');
        expect(attributes.onClose, file).toBe('onClose');
      }
    }
  );

  it('the tab gives each dialog the reload it was given by the shell, and the shell gives the tab its own', () => {
    for (const dialog of ['NewRoleDialog', 'SwitchRoleDialog']) {
      const used = elementsOf('RolesTab.tsx', dialog);
      expect(used.length, dialog).toBeGreaterThan(0);
      for (const attributes of used) {
        expect(attributes.reload, dialog).toBe('reload');
        expect(attributes.onClose, dialog).toBe('onClose');
      }
    }
    const tab = elementsOf('PeopleRolesClient.tsx', 'RolesTab');
    expect(tab).toHaveLength(1);
    expect(tab[0].reload).toBe('reload');
    expect(tab[0].onEdit, 'the shell gives the tab a way to open the editor').toBeDefined();
  });
});

describe('Task 24 the buttons and the steps are wired', () => {
  it('+ New role asks the tab to open the form, and each button of a row gives its action and its role to the tab', () => {
    expect(elementsOf('RolesTab.tsx', 'button').map((b) => b.onClick)).toEqual(['onNew']);
    expect(elementsOf('RolesList.tsx', 'button').map((b) => b.onClick)).toEqual([
      '() => onAction(action, role)',
    ]);
    expect(elementsOf('RolesTab.tsx', 'RolesList').map((l) => l.onAction)).toEqual(['onAction']);
  });

  it('the password step: Cancel goes back to the form with what was typed, or closes when there is no form; the write is done once, and only a written answer ends the dialog', () => {
    expect(elementsOf('NewRoleDialog.tsx', 'RoleSteps').map((s) => s.onBack)).toEqual([
      '() => setChange(null)',
    ]);
    expect(elementsOf('SwitchRoleDialog.tsx', 'RoleSteps').map((s) => s.onBack)).toEqual([
      'onClose',
    ]);
    const confirm = elementsOf('RoleSteps.tsx', 'ConfirmPasswordDialog');
    expect(confirm).toHaveLength(1);
    expect(confirm[0].onConfirm).toBe('confirm');
    expect(confirm[0].onClose).toBe('onBack');
    expect(callsOf('RoleSteps.tsx', 'dispatch')).toEqual([
      ["{ type: 'written', temporary: null }"],
    ]);
  });
});

describe('Task 24 no opener can replace the dialog that is open', () => {
  it('every call of setOpen in the Roles tab either closes (null) or hands its choice to openIfFree with what is open now', () => {
    const calls = callsOf('RolesTab.tsx', 'setOpen').map(([argument]) => argument);
    expect(calls).toHaveLength(3);
    expect(calls.filter((argument) => argument === 'null')).toHaveLength(1);
    for (const argument of calls.filter((a) => a !== 'null'))
      expect(argument).toMatch(/^\(now\) => openIfFree\(now, /);
  });

  it('the two openers are the + New role button and the Copy and Switch buttons of a row', () => {
    const calls = callsOf('RolesTab.tsx', 'openIfFree');
    expect(calls).toHaveLength(2);
    expect(calls.map(([, choice]) => choice).sort()).toEqual([
      'next',
      "{ kind: 'new', copyOf: '' }",
    ]);
  });

  it('Edit does not go to the editor while a dialog is open: the call sits under a check that nothing is open', () => {
    expect(conditionsAround('RolesTab.tsx', 'onEdit')).toEqual([['open === null']]);
  });
});

// ================================================================================================ the Task 24 review (Task 25, Part A)

describe('Task 25 review: validateNewRole checks the name as far as the screen can know', () => {
  const errorFor = (name: string, roles?: readonly SuperRole[]) =>
    validateNewRole({ copy_of: 'zk-biller', name }, roles).name;

  it('a name needs a letter or a number: dashes, dots and other marks alone are refused in plain words, before any password is asked', () => {
    for (const name of ['---', '···', '- . -', '()', '_ _', '***', '—'])
      expect(errorFor(name), name).toBe('Name needs a letter or a number.');
    expect(validateNewRole({ copy_of: 'zk-biller', name: '---' })).toEqual({
      name: 'Name needs a letter or a number.',
    });
  });

  it('one letter or number is enough, in any script, with marks around it', () => {
    for (const name of ['A', '7', 'A-1', '--a--', 'Ñandú', 'रोकड़िया', '日本語', '٣'])
      expect(errorFor(name), name).toBeUndefined();
  });

  it('an empty name is "required", a long one is "too long": the letter rule does not add a second message', () => {
    expect(errorFor('   ')).toBe('Name is required.');
    expect(errorFor('-'.repeat(41))).toBe('Name is 40 characters at most.');
    expect(errorFor('-'.repeat(40))).toBe('Name needs a letter or a number.');
  });

  it('a name that another role already has is refused: capitals, and spaces around and inside it, make no other name', () => {
    for (const name of [
      'Cashier',
      'cashier',
      'CASHIER',
      '  Cashier  ',
      'Stock   keeper',
      'stock keeper',
      ' sTOCK \t keeper ',
    ])
      expect(errorFor(name, ROLES), name).toBe('Another role already has this name.');
  });

  it('both sides are compared the same way: a role whose name was kept with extra spaces or capitals is the name it reads as', () => {
    const odd = [role({ key: 'zk-odd', name: '  Night   SHIFT ' })];
    expect(errorFor('night shift', odd)).toBe('Another role already has this name.');
    expect(errorFor('Night Shift 2', odd)).toBeUndefined();
  });

  it('the Owner and the roles that are switched off count too: the API keeps one name for every row it has', () => {
    expect(errorFor('owner', ROLES)).toBe('Another role already has this name.');
    expect(errorFor('Old Role', ROLES)).toBe('Another role already has this name.');
  });

  it('a name that only looks like another is not refused here: the API (which also ignores accents) is the one that decides', () => {
    expect(errorFor('Cashiers', ROLES)).toBeUndefined();
    expect(errorFor('Cáshier', ROLES)).toBeUndefined();
    expect(errorFor('Stock Keeper 2', ROLES)).toBeUndefined();
  });

  it('without the roles (no second argument, or none held) nothing is compared', () => {
    expect(errorFor('Cashier')).toBeUndefined();
    expect(errorFor('Cashier', [])).toBeUndefined();
  });

  it('the roles are not changed by the check', () => {
    const before = JSON.stringify(ROLES);
    validateNewRole({ copy_of: 'zk-biller', name: 'Cashier' }, ROLES);
    expect(JSON.stringify(ROLES)).toBe(before);
  });

  it('the other fields are checked as before when the roles are given', () => {
    expect(validateNewRole({ copy_of: '', name: 'Fresh' }, ROLES)).toEqual({
      copy_of: 'Choose a role to start from.',
    });
    expect(
      validateNewRole({ copy_of: 'zk-biller', name: 'Fresh', description: 'a'.repeat(201) }, ROLES)
    ).toEqual({ description: 'Description is 200 characters at most.' });
  });

  it('the New role form hands the roles it holds to the check', () => {
    expect(callsOf('NewRoleDialog.tsx', 'validateNewRole')).toEqual([
      ['{ ...values, copy_of: from }', 'roles'],
    ]);
  });
});

describe('Task 25 review: the cursor goes to the first empty REQUIRED field', () => {
  it('firstToFill: an empty optional field does not take the cursor from the required ones', () => {
    // New role after Cancel on the password step: the role to start from and the name are filled, the description is empty
    expect(firstToFill(['1', 'Cashier', ''], [true, true, false])).toBe(0);
    expect(firstToFill(['1', '', ''], [true, true, false])).toBe(1); // Copy: the name is next
    expect(firstToFill(['', '', ''], [true, true, false])).toBe(0); // + New role
    expect(firstToFill(['1', 'Cashier', 'Makes bills'], [true, true, false])).toBe(0);
    expect(firstToFill(['1', '', ''], [true, false, true])).toBe(2);
    expect(firstToFill(['', 'x'], [false, true])).toBe(0); // nothing required is empty: the first control
  });

  it('with no marks given every control counts as required, as before', () => {
    expect(firstToFill(['1', '', ''])).toBe(1);
    expect(firstToFill(['1', 'Cashier', ''])).toBe(2);
    expect(firstToFill(['1', 'Cashier'])).toBe(0);
  });

  const SOMEONE: SuperPerson = {
    id: '00000000-0000-4000-8000-000000000001',
    full_name: 'Meena Shah',
    email: 'meena@example.test',
    role: 'zk-cashier',
    role_name: 'Cashier',
    active: true,
    is_super_admin: false,
    last_login_at: null,
    updated_at: STAMP,
  };
  const required = (html: string, testId: string) =>
    /aria-required="true"/.test(
      html.match(new RegExp(`<(?:input|select|textarea)[^>]*data-testid="${testId}"[^>]*>`))?.[0] ??
        ''
    );

  it('the New role form marks the role to start from and the name as required, and the description as not', () => {
    const html = draw(NewRoleDialog, { roles: ROLES, copyOf: '', reload, onClose: noop });
    expect(required(html, 'new-role-from')).toBe(true);
    expect(required(html, 'new-role-name')).toBe(true);
    expect(required(html, 'new-role-description')).toBe(false);
  });

  it('the forms of the People tab mark all their fields as required', () => {
    const add = draw(AddPersonDialog, { roles: ROLES, reload, onClose: noop });
    for (const id of ['add-person-name', 'add-person-email', 'add-person-role'])
      expect(required(add, id), id).toBe(true);
    const edit = draw(EditPersonDialog, {
      person: SOMEONE,
      meId: 'someone-else',
      reload,
      onClose: noop,
    });
    for (const id of ['edit-person-name', 'edit-person-email'])
      expect(required(edit, id), id).toBe(true);
    const change = draw(ChangeRoleDialog, { person: SOMEONE, roles: ROLES, reload, onClose: noop });
    expect(required(change, 'change-role-role')).toBe(true);
  });

  it('the frame of the forms gives firstToFill the values and the marks of its controls', () => {
    const calls = callsOf('FormDialog.tsx', 'firstToFill');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0][0]).toContain('control.value');
    expect(calls[0][1]).toContain('aria-required');
  });
});

// ================================================================================================ no password can leak

describe('Task 24 no password can leak from the files of the screen', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const walked = sourcesUnder(path.join(SRC, 'app/people-roles')).map((file) =>
    path.relative(SRC, file)
  );
  const mine = [
    'app/people-roles/components/RolesTab.tsx',
    'app/people-roles/components/RolesList.tsx',
    'app/people-roles/components/NewRoleDialog.tsx',
    'app/people-roles/components/SwitchRoleDialog.tsx',
    'app/people-roles/components/RoleSteps.tsx',
    'app/people-roles/lib/roles.ts',
    'app/people-roles/lib/roleChange.ts',
    'app/people-roles/lib/roleWrite.ts',
    'app/people-roles/lib/afterWrite.ts',
  ];

  it('the files of this task are among the ones the tripwire walks (the Task 22 and 23 tests walk the whole folder)', () => {
    for (const wanted of mine) expect(walked, wanted).toContain(wanted);
  });

  it.each(mine)('%s', (name) => {
    expect(leaksOf(readFileSync(path.join(SRC, name), 'utf8'), name, PASSWORD_NAMES)).toEqual([]);
  });
});

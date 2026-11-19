// Access and roles (Task 25): what stands behind the Edit role screen of People & Roles (plan: Task 25; DESIGN 6.2 and 6.5; API Task 13). The tick rules themselves are
// tests/unit/tick-edit.test.ts; what the screen draws is tests/unit/people-roles-editor-screen.test.ts. This file is:
//   - lib/editorDraft.ts: what the person has changed so far (the draft), what that adds up to (the count of the banner, the mistakes, the sensitive ticks to confirm, whether Save works),
//     what a save would write (`roleEditOf`), and what the screen does with the outcome of a save (`settle`);
//   - lib/editWords.ts: the sentences of the screen and of the password step;
//   - lib/roleEdit.ts: the two writes with the Super Admin's password in their bodies (the name and the description, then the ticks with the new stamp), the lists read again, a role changed
//     by someone else, the case where the first write went through and the second did not.
//
// The Super Admin's real password is never used here, and no password is written in a title: the tests make them up and never print them.
//
// Run: npx vitest run tests/unit/people-roles-editor.test.ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  infoOf,
  roleEditOf,
  saveOf,
  seedOf,
  settle,
  type Draft,
  type DraftAction,
} from '@/app/people-roles/lib/editorDraft';
import {
  ALSO_NEEDS,
  LEAVE_QUESTION,
  NEEDED_BY,
  OWNER_FIXED_LINE,
  PASSWORD_HINT,
  SAVED_LINE,
  STALE_LINE,
  UNDERSTAND_FIRST,
  alsoNeedsLine,
  bannerWords,
  changedWords,
  groupCount,
  holdersLine,
  namesInWords,
  neededByLine,
  roleEditConfirmLabel,
  roleEditIntro,
  roleEditSummary,
  roleEditTitle,
} from '@/app/people-roles/lib/editWords';
import {
  partlySaved,
  runRoleEdit,
  savedLine,
  type RoleEditWrites,
} from '@/app/people-roles/lib/roleEdit';
import { TICK_KEYS, type TickKey } from '@/lib/access';
import { ApiError } from '@/lib/api/client';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import type { SuperEditRoleBody, SuperRoleAnswer, SuperRoleTicksBody } from '@/lib/api/types';
import {
  AFTER_FIRST,
  AFTER_SECOND,
  BILLER_TICKS,
  CASHIER,
  ROLES,
  STAMP,
  role,
  run,
  tick,
} from './support/editorFixtures';
import { CATALOGUE, keysOf } from './support/tickCatalogue';

// The passwords of the tests are made up for each run and are never printed: a check that compares one answers true or false.
const PASSWORD = `pw-${randomBytes(9).toString('hex')}`;

const refusal = (code: string, status: number, message: string, details = {}) =>
  new ApiError({ code, status, message, details, write: true });

// ================================================================================================ the draft

describe('Task 25 editorDraft: seeding and editing', () => {
  it('starts as the saved role: its name, description and ticks, nothing changed, nothing understood', () => {
    const draft = seedOf(CASHIER);
    expect(draft.name).toBe('Cashier');
    expect(draft.description).toBe('Makes bills and takes payments');
    expect(keysOf(draft.ticks)).toEqual(keysOf(new Set(BILLER_TICKS)));
    expect(draft.understood).toBe('');
    const info = infoOf(draft, CATALOGUE, ROLES);
    expect(info).toMatchObject({ count: 0, dirty: false, canSave: false, errors: {} });
    expect(info.changes).toEqual({ turnedOn: [], turnedOff: [] });
  });

  it('typing a name or a description changes that and nothing else', () => {
    const draft = run(
      seedOf(CASHIER),
      { type: 'name', value: 'Till' },
      { type: 'description', value: 'At the till' }
    );
    expect(draft).toMatchObject({ name: 'Till', description: 'At the till' });
    expect(keysOf(draft.ticks)).toEqual(keysOf(new Set(BILLER_TICKS)));
  });

  it('a tick action follows the rules of tickEdit: needs come with it, a locked one stays', () => {
    const turnedOn = run(seedOf(CASHIER), tick('cashbook_all', true));
    expect(turnedOn.ticks.has('cashbook_all')).toBe(true);
    // cashbook_recent is needed by cashbook_all now
    const refused = run(turnedOn, tick('cashbook_recent', false));
    expect(refused.ticks).toBe(turnedOn.ticks);
    const activityLog = run(seedOf(role({ ticks: [] })), tick('activity_log', true));
    expect(keysOf(activityLog.ticks)).toEqual([
      'secret_weight',
      'customer_view',
      'bill_view',
      'order_view',
      'activity_log',
    ]);
  });

  it('never changes the draft it is given', () => {
    const before = seedOf(CASHIER);
    const ticksBefore = [...before.ticks];
    run(
      before,
      { type: 'name', value: 'x' },
      tick('stock_add', true),
      tick('payment_receive', false)
    );
    expect(before.name).toBe('Cashier');
    expect([...before.ticks]).toEqual(ticksBefore);
  });

  it('seed starts again from a saved role: the edits are gone and so is the box', () => {
    const edited = run(
      seedOf(CASHIER),
      { type: 'name', value: 'Till' },
      tick('refund_give', true),
      { type: 'understood', confirm: ['refund_give'], on: true }
    );
    const fresh = role({ name: 'Cashier 2', ticks: ['stock_add'], updated_at: AFTER_FIRST });
    const again = run(edited, { type: 'seed', role: fresh });
    expect(again).toEqual(seedOf(fresh));
    expect(again.base.updated_at).toBe(AFTER_FIRST);
  });

  it('rebase takes a newer saved copy for the name and description and keeps the ticks the person ticked (the first write of a save went through, the second did not)', () => {
    const edited = run(
      seedOf(CASHIER),
      { type: 'name', value: '  Night   Till ' },
      { type: 'description', value: ' At the till ' },
      tick('refund_give', true)
    );
    // the copy the API answered with has the name as it keeps it
    const saved = role({ name: 'Night Till', description: 'At the till', updated_at: AFTER_FIRST });
    const after = run(edited, { type: 'rebase', role: saved });
    expect(after.base).toBe(saved);
    expect(after.name).toBe('Night Till');
    expect(after.description).toBe('At the till');
    expect(after.ticks).toBe(edited.ticks);
    // the name and description are not changes any more, the ticks still are
    const info = infoOf(after, CATALOGUE, ROLES);
    expect(info.nameChanged).toBe(false);
    expect(info.descriptionChanged).toBe(false);
    expect(info.changes).toEqual({ turnedOn: ['refund_give'], turnedOff: [] });
    expect(info.count).toBe(1);
  });

  it('after a rebase the ticks are measured against the ticks of the new saved copy', () => {
    const edited = run(seedOf(CASHIER), tick('refund_give', true));
    const saved = role({ ticks: [...BILLER_TICKS, 'rate_correct'], updated_at: AFTER_FIRST });
    const after = run(edited, { type: 'rebase', role: saved });
    expect(infoOf(after, CATALOGUE, ROLES).changes).toEqual({
      turnedOn: ['refund_give'],
      turnedOff: ['rate_correct'],
    });
  });
});

describe('Task 25 editorDraft: what the draft adds up to', () => {
  it('the count is the changed ticks, plus one for the name, plus one for the description', () => {
    const base = seedOf(CASHIER);
    const count = (...actions: DraftAction[]) =>
      infoOf(run(base, ...actions), CATALOGUE, ROLES).count;
    expect(count(tick('cashbook_all', true))).toBe(1);
    // payment_receive is on, and no tick that is on needs it: it can go
    expect(count(tick('cashbook_all', true), tick('payment_receive', false))).toBe(2);
    expect(count({ type: 'name', value: 'Till' })).toBe(1);
    expect(count({ type: 'description', value: 'x' })).toBe(1);
    // refund_give and cashbook_all find their needs on already: two ticks, plus the name and the description
    expect(
      count(
        { type: 'name', value: 'Till' },
        { type: 'description', value: 'x' },
        tick('cashbook_all', true),
        tick('refund_give', true)
      )
    ).toBe(4);
  });

  it('a tick turned on and off again is no change; so are the spaces around a name and in the middle of it, and around a description', () => {
    const base = seedOf(CASHIER);
    const same = run(
      base,
      tick('back_date', true),
      tick('back_date', false),
      { type: 'name', value: '  Cashier  ' },
      { type: 'description', value: ' Makes bills and takes payments ' }
    );
    expect(infoOf(same, CATALOGUE, ROLES)).toMatchObject({ count: 0, dirty: false });
    const spaced = seedOf(role({ name: 'Stock Keeper' }));
    expect(
      infoOf(run(spaced, { type: 'name', value: 'Stock   Keeper' }), CATALOGUE, ROLES).count
    ).toBe(0);
    // capitals are a rename
    expect(
      infoOf(run(base, { type: 'name', value: 'cashier' }), CATALOGUE, ROLES).nameChanged
    ).toBe(true);
  });

  it('the mistakes are those of a new role: a name is needed, 40 at most, with a letter or a number; the description 200 at most; and no other role has the name', () => {
    const base = seedOf(CASHIER);
    const errors = (name: string, description = 'ok') =>
      infoOf(
        run(base, { type: 'name', value: name }, { type: 'description', value: description }),
        CATALOGUE,
        ROLES
      ).errors;
    expect(errors('')).toEqual({ name: 'Name is required.' });
    expect(errors('a'.repeat(41))).toEqual({ name: 'Name is 40 characters at most.' });
    expect(errors('---')).toEqual({ name: 'Name needs a letter or a number.' });
    expect(errors('stock keeper')).toEqual({ name: 'Another role already has this name.' });
    expect(errors('Cashier', 'a'.repeat(201))).toEqual({
      description: 'Description is 200 characters at most.',
    });
    expect(errors('Cashier')).toEqual({});
  });

  it('the role itself is not "another role": its own name (also in other letters) is fine', () => {
    const base = seedOf(CASHIER);
    expect(infoOf(run(base, { type: 'name', value: 'CASHIER' }), CATALOGUE, ROLES).errors).toEqual(
      {}
    );
  });

  it('the sensitive ticks that are newly on are the ones to confirm, and only until the box is ticked for exactly those', () => {
    const base = seedOf(CASHIER);
    const on = run(base, tick('refund_give', true));
    let info = infoOf(on, CATALOGUE, ROLES);
    expect(info.confirm).toEqual(['refund_give']);
    expect(info.understood).toBe(false);
    expect(info.canSave).toBe(false); // changed, but not understood

    const ticked = run(on, { type: 'understood', confirm: info.confirm, on: true });
    info = infoOf(ticked, CATALOGUE, ROLES);
    expect(info.understood).toBe(true);
    expect(info.canSave).toBe(true);

    // another sensitive tick turned on: the box was ticked for the other set, so it is empty again
    const more = run(ticked, tick('bill_cancel', true));
    info = infoOf(more, CATALOGUE, ROLES);
    expect(info.confirm).toEqual(['bill_cancel', 'refund_give']);
    expect(info.understood).toBe(false);
    expect(info.canSave).toBe(false);

    // unticking, and turning the sensitive tick off again, ask for nothing
    expect(
      infoOf(
        run(ticked, { type: 'understood', confirm: ['refund_give'], on: false }),
        CATALOGUE,
        ROLES
      ).understood
    ).toBe(false);
    const gone = run(ticked, tick('refund_give', false));
    info = infoOf(gone, CATALOGUE, ROLES);
    expect(info.confirm).toEqual([]);
    expect(info.canSave).toBe(false); // nothing changed any more
  });

  it('a sensitive tick that was saved as on needs no box: other changes save at once', () => {
    const base = seedOf(role({ ticks: ['customer_view', 'bill_view', 'bill_cancel'] }));
    const info = infoOf(run(base, { type: 'name', value: 'Cancels bills' }), CATALOGUE, ROLES);
    expect(info.confirm).toEqual([]);
    expect(info.canSave).toBe(true);
  });

  it('Save works exactly when something changed, the name and description are fine, and the box (when it is needed) is ticked', () => {
    const base = seedOf(CASHIER);
    const info = (draft: Draft) => infoOf(draft, CATALOGUE, ROLES);
    expect(info(base).canSave).toBe(false); // nothing changed
    expect(info(run(base, tick('cashbook_all', true))).canSave).toBe(true);
    expect(info(run(base, { type: 'name', value: 'Till' })).canSave).toBe(true);
    expect(info(run(base, { type: 'name', value: '' })).canSave).toBe(false); // changed but invalid
    expect(info(run(base, { type: 'name', value: 'Stock Keeper' })).canSave).toBe(false); // taken
    expect(
      info(run(base, tick('cashbook_all', true), { type: 'description', value: 'a'.repeat(201) }))
        .canSave
    ).toBe(false);
  });

  it('dirty is true exactly when something is not saved yet', () => {
    const base = seedOf(CASHIER);
    expect(infoOf(base, CATALOGUE, ROLES).dirty).toBe(false);
    expect(infoOf(run(base, tick('cashbook_all', true)), CATALOGUE, ROLES).dirty).toBe(true);
    expect(infoOf(run(base, { type: 'name', value: '' }), CATALOGUE, ROLES).dirty).toBe(true);
  });
});

describe('Task 25 roleEditOf: what a save would write', () => {
  const edit = (...actions: DraftAction[]) =>
    roleEditOf(run(seedOf(CASHIER), ...actions), CATALOGUE);

  it('only what changed: the ticks alone, the name alone, the description alone', () => {
    const ticksOnly = edit(tick('cashbook_all', true));
    expect(ticksOnly.role).toBe(CASHIER);
    expect('name' in ticksOnly).toBe(false);
    expect('description' in ticksOnly).toBe(false);
    expect(ticksOnly.ticks).toBeDefined();
    const nameOnly = edit({ type: 'name', value: 'Till' });
    expect(nameOnly.name).toBe('Till');
    expect('description' in nameOnly).toBe(false);
    expect('ticks' in nameOnly).toBe(false);
    const descriptionOnly = edit({ type: 'description', value: 'At the till' });
    expect(descriptionOnly.description).toBe('At the till');
    expect('name' in descriptionOnly).toBe(false);
    expect('ticks' in descriptionOnly).toBe(false);
  });

  it('the name as the API keeps it (spaces around it gone, white space inside folded) and the description trimmed', () => {
    const both = edit(
      { type: 'name', value: '  Night    Till ' },
      { type: 'description', value: '  At night  ' }
    );
    expect(both.name).toBe('Night Till');
    expect(both.description).toBe('At night');
  });

  it('the description may be emptied: it is then sent as an empty text', () => {
    expect(edit({ type: 'description', value: '   ' }).description).toBe('');
  });

  it('the ticks are the whole new set as a list in catalogue order, whatever order they were ticked in', () => {
    const wanted = edit(
      tick('refund_give', true),
      tick('cashbook_all', true),
      tick('stock_add', true)
    );
    expect(wanted.ticks).toEqual(
      TICK_KEYS.filter((key) =>
        new Set([...BILLER_TICKS, 'refund_give', 'cashbook_all', 'stock_add']).has(key)
      )
    );
  });

  it('a tick key the catalogue does not know is not sent', () => {
    const odd = roleEditOf(
      run(seedOf(role({ ticks: ['zz_old' as TickKey, 'stock_add'] })), tick('stock_edit', true)),
      CATALOGUE
    );
    expect(odd.ticks).toEqual(['stock_add', 'stock_edit']);
  });

  it('nothing changed is an edit with nothing in it', () => {
    const none = edit();
    expect(none).toEqual({ role: CASHIER });
  });
});

// ================================================================================================ the words

describe('Task 25 saveOf: what Save writes, or nothing when Save does not work', () => {
  const save = (...actions: DraftAction[]) =>
    saveOf(run(seedOf(CASHIER), ...actions), CATALOGUE, ROLES);

  it('is what roleEditOf says when Save works', () => {
    const actions = [tick('cashbook_all', true), { type: 'name', value: 'Till' } as const];
    expect(save(...actions)).toEqual(roleEditOf(run(seedOf(CASHIER), ...actions), CATALOGUE));
    expect(save(...actions)).toMatchObject({ name: 'Till' });
  });

  it('is nothing when nothing changed', () => {
    expect(save()).toBeNull();
    expect(save(tick('back_date', true), tick('back_date', false))).toBeNull();
  });

  it('is nothing while the name is not fine: empty, taken by another role, without a letter', () => {
    expect(save(tick('cashbook_all', true), { type: 'name', value: '' })).toBeNull();
    expect(save(tick('cashbook_all', true), { type: 'name', value: 'stock keeper' })).toBeNull();
    expect(save({ type: 'name', value: '---' })).toBeNull();
  });

  it('is nothing while a sensitive tick is newly on and the box is not ticked, and the edit once it is', () => {
    expect(save(tick('refund_give', true))).toBeNull();
    const confirm = infoOf(
      run(seedOf(CASHIER), tick('refund_give', true)),
      CATALOGUE,
      ROLES
    ).confirm;
    expect(
      save(tick('refund_give', true), { type: 'understood', confirm, on: true })?.ticks
    ).toContain('refund_give');
  });
});

describe('Task 25 editWords: the banner, the lines under a tick, the password step', () => {
  it('the banner counts the changes, in the singular for one', () => {
    expect(bannerWords(1)).toBe('1 change not saved yet');
    expect(bannerWords(2)).toBe('2 changes not saved yet');
    expect(bannerWords(11)).toBe('11 changes not saved yet');
  });

  it('the banner names what changed, in the order of the screen: the name, the description, then the ticks in catalogue order', () => {
    const info = infoOf(
      run(
        seedOf(CASHIER),
        tick('refund_give', true),
        tick('cashbook_all', true),
        { type: 'description', value: 'x' },
        { type: 'name', value: 'Till' },
        tick('payment_receive', false)
      ),
      CATALOGUE,
      ROLES
    );
    expect(changedWords(info, CATALOGUE)).toEqual([
      'Role name',
      'What this role is for',
      'See the cash book for all days',
      'Receive payments and settle fine',
      'Give a refund',
    ]);
    expect(changedWords(infoOf(seedOf(CASHIER), CATALOGUE, ROLES), CATALOGUE)).toEqual([]);
  });

  it('names are told in a sentence, in curly quotes: one, two, three or more', () => {
    expect(namesInWords(['A'])).toBe('“A”');
    expect(namesInWords(['A', 'B'])).toBe('“A” and “B”');
    expect(namesInWords(['A', 'B', 'C'])).toBe('“A”, “B” and “C”');
    expect(namesInWords(['A', 'B', 'C', 'D'])).toBe('“A”, “B”, “C” and “D”');
  });

  const labels = new Map(CATALOGUE.map((one) => [one.key, one.label] as const));
  const info = (key: TickKey) => CATALOGUE.find((one) => one.key === key)!;

  it('"Also needs ..." names the direct needs by their words, and says nothing for a tick that needs nothing', () => {
    expect(ALSO_NEEDS).toBe('Also needs');
    expect(alsoNeedsLine(info('stock_add'), labels)).toBeNull();
    expect(alsoNeedsLine(info('customer_edit'), labels)).toBe(
      'Also needs “See customers (name, phone, address, GST)”'
    );
    expect(alsoNeedsLine(info('bill_cancel'), labels)).toBe(
      'Also needs “See customers (name, phone, address, GST)” and “See bills, payments and customer ledgers”'
    );
    // the direct needs only: activity_log lists its four, not what those need
    expect(alsoNeedsLine(info('bill_reissue'), labels)).toBe(
      'Also needs “See customers (name, phone, address, GST)”, “See bills, payments and customer ledgers” and “Make bills and estimates”'
    );
  });

  it('a need that has no words (a key the catalogue lacks) is left out, never shown as a key', () => {
    const odd = {
      ...info('customer_edit'),
      needs: ['zz_gone' as TickKey, 'customer_view' as TickKey],
    };
    expect(alsoNeedsLine(odd, labels)).toBe(
      'Also needs “See customers (name, phone, address, GST)”'
    );
    expect(alsoNeedsLine({ ...odd, needs: ['zz_gone' as TickKey] }, labels)).toBeNull();
  });

  it('"Needed by ..." names the ticks that need a locked one, by their words', () => {
    expect(NEEDED_BY).toBe('Needed by');
    expect(neededByLine([info('customer_edit')])).toBe('Needed by “Add and edit customers”');
    expect(neededByLine([info('customer_edit'), info('order_edit')])).toBe(
      'Needed by “Add and edit customers” and “Make and change orders, add order photos”'
    );
  });

  it('a group says how many of its ticks are on', () => {
    expect(groupCount(0, 7)).toBe('0 of 7 on');
    expect(groupCount(9, 17)).toBe('9 of 17 on');
  });

  it('the line about who has the role counts the people in words, and says their names follow when they do', () => {
    expect(holdersLine(0, false)).toBe('Nobody has this role yet.');
    expect(holdersLine(1, true)).toBe('1 person has this role:');
    expect(holdersLine(3, true)).toBe('3 people have this role:');
    expect(holdersLine(3, false)).toBe('3 people have this role.');
    expect(holdersLine(1, false)).toBe('1 person has this role.');
  });

  it('the hint under Save says that it asks for the password, or that the box has to be ticked first', () => {
    expect(PASSWORD_HINT).toBe('Asks for your password');
    expect(UNDERSTAND_FIRST).toBe('Tick “I understand” first.');
  });

  it('the fixed sentences are the ones of the brief', () => {
    expect(SAVED_LINE).toBe('Saved.');
    expect(STALE_LINE).toBe('This role was changed by someone else. Reload it and try again.');
    expect(OWNER_FIXED_LINE).toBe('The Owner role is fixed.');
    expect(LEAVE_QUESTION).toBe('Leave without saving? Your changes will be lost.');
    expect(roleEditConfirmLabel).toBe('Confirm and save');
  });
});

describe('Task 25 editWords: the password step says exactly what will be saved', () => {
  const edit = (...actions: DraftAction[]) =>
    roleEditOf(run(seedOf(CASHIER), ...actions), CATALOGUE);

  it('the title names the role by its name (the saved one), never by its key', () => {
    expect(roleEditTitle(edit(tick('cashbook_all', true)))).toBe('Save changes to “Cashier”?');
    expect(roleEditTitle(edit({ type: 'name', value: 'Till' }))).toBe('Save changes to “Cashier”?');
  });

  it('says how many people have the role, and that a tick change works on their very next click', () => {
    expect(roleEditIntro(edit(tick('cashbook_all', true)))).toBe(
      '3 people have this role. The change works on their very next click.'
    );
    expect(
      roleEditIntro(
        roleEditOf(run(seedOf(role({ people: 1 })), tick('cashbook_all', true)), CATALOGUE)
      )
    ).toBe('1 person has this role. The change works on their very next click.');
    expect(
      roleEditIntro(
        roleEditOf(run(seedOf(role({ people: 0 })), tick('cashbook_all', true)), CATALOGUE)
      )
    ).toBe('Nobody has this role yet.');
  });

  it('a change of the name or the description alone does not say that access changes', () => {
    expect(roleEditIntro(edit({ type: 'name', value: 'Till' }))).toBe('3 people have this role.');
    expect(roleEditIntro(edit({ type: 'description', value: 'x' }))).toBe(
      '3 people have this role.'
    );
  });

  it('turning on and turning off list the ticks by their words in catalogue order, the sensitive ones marked', () => {
    const parts = roleEditSummary(
      edit(tick('refund_give', true), tick('cashbook_all', true), tick('payment_receive', false)),
      CATALOGUE
    );
    expect(parts).toEqual([
      {
        kind: 'ticks',
        heading: 'Turning on',
        ticks: [
          { label: 'See the cash book for all days', sensitive: false },
          { label: 'Give a refund', sensitive: true },
        ],
      },
      {
        kind: 'ticks',
        heading: 'Turning off',
        ticks: [{ label: 'Receive payments and settle fine', sensitive: false }],
      },
    ]);
  });

  it('when ticks change, both lists are there: the empty one is an empty list (drawn as "Nothing")', () => {
    const parts = roleEditSummary(edit(tick('cashbook_all', true)), CATALOGUE);
    expect(
      parts.map((part) => (part.kind === 'ticks' ? [part.heading, part.ticks.length] : null))
    ).toEqual([
      ['Turning on', 1],
      ['Turning off', 0],
    ]);
  });

  it('the new name and a changed description follow, as lines, and only when they changed', () => {
    const parts = roleEditSummary(
      edit({ type: 'name', value: '  Night   Till ' }, { type: 'description', value: 'x' }),
      CATALOGUE
    );
    expect(parts).toEqual([
      { kind: 'line', text: 'New name: Night Till' },
      { kind: 'line', text: 'Description changed' },
    ]);
    expect(roleEditSummary(edit({ type: 'description', value: 'x' }), CATALOGUE)).toEqual([
      { kind: 'line', text: 'Description changed' },
    ]);
    expect(roleEditSummary(edit({ type: 'name', value: 'Till' }), CATALOGUE)).toEqual([
      { kind: 'line', text: 'New name: Till' },
    ]);
  });

  it('all four together: the ticks first, then the name, then the description', () => {
    const parts = roleEditSummary(
      edit(
        { type: 'description', value: 'x' },
        { type: 'name', value: 'Till' },
        tick('refund_give', true)
      ),
      CATALOGUE
    );
    expect(parts.map((part) => (part.kind === 'ticks' ? part.heading : part.text))).toEqual([
      'Turning on',
      'Turning off',
      'New name: Till',
      'Description changed',
    ]);
  });

  it('no sentence names a role key, a tick key or a stamp', () => {
    const everything = edit(
      { type: 'description', value: 'x' },
      { type: 'name', value: 'Till' },
      tick('activity_log', true),
      tick('payment_receive', false)
    );
    const words = [
      roleEditTitle(everything),
      roleEditIntro(everything),
      roleEditConfirmLabel,
      JSON.stringify(roleEditSummary(everything, CATALOGUE)),
    ].join(' ');
    for (const hidden of ['zk-', STAMP, ...TICK_KEYS])
      expect(words.includes(hidden), hidden).toBe(false);
  });
});

// ================================================================================================ the writes

describe('Task 25 partlySaved: the words when the first write went through and the second did not', () => {
  const edit = (...actions: DraftAction[]) =>
    roleEditOf(run(seedOf(CASHIER), ...actions), CATALOGUE);
  const sentence = '“Cancel a bill” also needs “See bills, payments and customer ledgers”.';

  it("says plainly what was saved and what was not, then the API's sentence", () => {
    expect(
      partlySaved(
        edit(
          { type: 'name', value: 'Till' },
          { type: 'description', value: 'x' },
          tick('refund_give', true)
        ),
        sentence
      )
    ).toBe(`The name and description were saved, but the ticks were not. ${sentence}`);
    expect(
      partlySaved(edit({ type: 'name', value: 'Till' }, tick('refund_give', true)), sentence)
    ).toBe(`The name was saved, but the ticks were not. ${sentence}`);
    expect(
      partlySaved(edit({ type: 'description', value: 'x' }, tick('refund_give', true)), sentence)
    ).toBe(`The description was saved, but the ticks were not. ${sentence}`);
  });

  it('the sentence of the client ends with "Nothing was changed." for a refusal of one write: that would contradict "was saved", so it is left off here, and only that', () => {
    expect(
      partlySaved(
        edit({ type: 'name', value: 'Till' }, tick('refund_give', true)),
        `${sentence} Nothing was changed.`
      )
    ).toBe(`The name was saved, but the ticks were not. ${sentence}`);
    // the API's own words are never touched, and a sentence that is only that suffix leaves just the first part
    expect(
      partlySaved(
        edit({ type: 'name', value: 'Till' }, tick('refund_give', true)),
        'Nothing was changed.'
      )
    ).toBe('The name was saved, but the ticks were not.');
    expect(
      partlySaved(
        edit({ type: 'name', value: 'Till' }, tick('refund_give', true)),
        'Nothing was changed by this.'
      )
    ).toBe('The name was saved, but the ticks were not. Nothing was changed by this.');
  });

  it('does not claim that the ticks were not saved when nobody can say (the outcome of that write is not known)', () => {
    expect(
      partlySaved(
        edit({ type: 'name', value: 'Till' }, tick('refund_give', true)),
        UNCONFIRMED_MESSAGE,
        false
      )
    ).toBe('The name was saved. Could not confirm that the ticks were saved.');
  });
});

/** The two role writes of the client, answering as the plan says, and a log of the order in which things happened. */
function fakeWrites() {
  const log: string[] = [];
  const writes = {
    superEditRole: vi.fn(async (key: string, body: SuperEditRoleBody): Promise<SuperRoleAnswer> => {
      log.push('edit');
      return {
        role: role({
          key,
          name: body.changes.name ?? CASHIER.name,
          description: body.changes.description ?? CASHIER.description,
          updated_at: AFTER_FIRST,
        }),
      };
    }),
    superSetRoleTicks: vi.fn(
      async (key: string, body: SuperRoleTicksBody): Promise<SuperRoleAnswer> => {
        log.push('ticks');
        return { role: role({ key, ticks: body.ticks, updated_at: AFTER_SECOND }) };
      }
    ),
  };
  const read = vi.fn(async () => {
    log.push('reload');
  });
  return { writes: writes as unknown as RoleEditWrites & typeof writes, reload: read, log };
}

/** A body as it was sent, with the Super Admin's password turned into words: a failing check never prints it. */
const masked = (body: unknown) => {
  const { password, ...rest } = body as { password?: string };
  return {
    ...rest,
    password: password === PASSWORD ? 'the typed password' : 'NOT THE TYPED PASSWORD',
  };
};

const editOf = (...actions: DraftAction[]) =>
  roleEditOf(run(seedOf(CASHIER), ...actions), CATALOGUE);
const NAME: DraftAction = { type: 'name', value: '  Night   Till ' };
const DESCRIPTION: DraftAction = { type: 'description', value: 'At night' };
const TICKS = [tick('cashbook_all', true), tick('refund_give', true)];

describe('Task 25 runRoleEdit: the calls, their order and their bodies', () => {
  it('ticks only: one call to set the ticks, with the stamp the role was listed with, the whole set in catalogue order and the password', async () => {
    const { writes, reload, log } = fakeWrites();
    const outcome = await runRoleEdit(writes, reload, editOf(...TICKS), PASSWORD);
    expect(writes.superEditRole).not.toHaveBeenCalled();
    expect(writes.superSetRoleTicks).toHaveBeenCalledTimes(1);
    const [key, body] = writes.superSetRoleTicks.mock.calls[0];
    expect(key).toBe('zk-cashier');
    expect(masked(body)).toStrictEqual({
      expected_updated_at: STAMP,
      ticks: TICK_KEYS.filter((one) =>
        new Set([...BILLER_TICKS, 'cashbook_all', 'refund_give']).has(one)
      ),
      password: 'the typed password',
    });
    expect(log).toEqual(['ticks', 'reload']);
    expect(outcome).toEqual({
      kind: 'saved',
      role: expect.objectContaining({ updated_at: AFTER_SECOND }),
    });
  });

  it('the name alone: one call to edit the role, with only the name in changes, the cleaned name, the stamp as listed and the password', async () => {
    const { writes, reload, log } = fakeWrites();
    const outcome = await runRoleEdit(writes, reload, editOf(NAME), PASSWORD);
    expect(writes.superSetRoleTicks).not.toHaveBeenCalled();
    expect(writes.superEditRole).toHaveBeenCalledTimes(1);
    const [key, body] = writes.superEditRole.mock.calls[0];
    expect(key).toBe('zk-cashier');
    expect(masked(body)).toStrictEqual({
      expected_updated_at: STAMP,
      changes: { name: 'Night Till' },
      password: 'the typed password',
    });
    expect(log).toEqual(['edit', 'reload']);
    expect(outcome).toMatchObject({
      kind: 'saved',
      role: { name: 'Night Till', updated_at: AFTER_FIRST },
    });
  });

  it('the description alone, and an emptied description, go in changes without the name', async () => {
    for (const [value, wanted] of [
      ['At night', 'At night'],
      ['   ', ''],
    ]) {
      const { writes, reload } = fakeWrites();
      await runRoleEdit(writes, reload, editOf({ type: 'description', value }), PASSWORD);
      const body = writes.superEditRole.mock.calls[0][1];
      expect(Object.keys(body.changes), value).toEqual(['description']);
      expect(body.changes.description).toBe(wanted);
    }
  });

  it('the name and the description together are one call', async () => {
    const { writes, reload } = fakeWrites();
    await runRoleEdit(writes, reload, editOf(NAME, DESCRIPTION), PASSWORD);
    expect(writes.superEditRole).toHaveBeenCalledTimes(1);
    expect(writes.superEditRole.mock.calls[0][1].changes).toStrictEqual({
      name: 'Night Till',
      description: 'At night',
    });
  });

  it('the name and the ticks are two calls, in that order; the second names the stamp the first one answered with, not the stamp the role was listed with', async () => {
    const { writes, reload, log } = fakeWrites();
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(log).toEqual(['edit', 'ticks', 'reload']);
    expect(writes.superEditRole.mock.calls[0][1].expected_updated_at).toBe(STAMP);
    expect(writes.superSetRoleTicks.mock.calls[0][1].expected_updated_at).toBe(AFTER_FIRST);
    // the role that comes back is the one the last write answered with
    expect(outcome).toMatchObject({ kind: 'saved', role: { updated_at: AFTER_SECOND } });
  });

  it('the same typed password goes in both bodies', async () => {
    const { writes, reload } = fakeWrites();
    await runRoleEdit(writes, reload, editOf(NAME, DESCRIPTION, ...TICKS), PASSWORD);
    expect(masked(writes.superEditRole.mock.calls[0][1]).password).toBe('the typed password');
    expect(masked(writes.superSetRoleTicks.mock.calls[0][1]).password).toBe('the typed password');
  });

  it('the password is in the bodies only: not in a key, not in what comes back, not in the call that reads the lists again', async () => {
    const { writes, reload } = fakeWrites();
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(JSON.stringify(outcome).includes(PASSWORD)).toBe(false);
    for (const [key] of [
      ...writes.superEditRole.mock.calls,
      ...writes.superSetRoleTicks.mock.calls,
    ])
      expect(key.includes(PASSWORD)).toBe(false);
    expect(reload.mock.calls.every((args) => args.length === 0)).toBe(true);
    // and in each body it is the one field `password`: nothing else holds it
    for (const body of [
      writes.superEditRole.mock.calls[0][1],
      writes.superSetRoleTicks.mock.calls[0][1],
    ]) {
      const holders = Object.entries(body).filter(([, value]) =>
        JSON.stringify(value).includes(PASSWORD)
      );
      expect(holders.map(([name]) => name)).toEqual(['password']);
    }
  });

  it('an edit with nothing in it writes nothing and reads nothing', async () => {
    const { writes, reload, log } = fakeWrites();
    const outcome = await runRoleEdit(writes, reload, editOf(), PASSWORD);
    expect(log).toEqual([]);
    expect(outcome).toEqual({ kind: 'saved', role: CASHIER });
  });
});

describe('Task 25 runRoleEdit: what goes wrong', () => {
  it("a refusal of the first write (a name another role has) shows the API's sentence, writes nothing else, saves nothing and reads nothing again", async () => {
    const { writes, reload } = fakeWrites();
    const sentence = 'name is already used by another role. Nothing was changed.';
    writes.superEditRole.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, sentence, { field: 'name' })
    );
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toEqual({ kind: 'refused', error: sentence, saved: null });
    expect(writes.superSetRoleTicks).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("a wrong password is the step's to show: it stays on the password step, nothing is written, nothing is read again", async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' })
    );
    const outcome = await runRoleEdit(writes, reload, editOf(...TICKS), PASSWORD);
    expect(outcome).toEqual({ kind: 'password', error: 'Your password is not correct.' });
    expect(reload).not.toHaveBeenCalled();
  });

  it("the pause after wrong passwords is the step's to show too", async () => {
    const { writes, reload } = fakeWrites();
    const pause = 'Too many wrong passwords. Try again in 15 minutes.';
    writes.superEditRole.mockRejectedValueOnce(refusal('JV_RATE_LIMITED', 429, pause));
    const outcome = await runRoleEdit(writes, reload, editOf(NAME), PASSWORD);
    expect(outcome).toEqual({ kind: 'password', error: pause });
    expect(reload).not.toHaveBeenCalled();
  });

  it("a problem with another field is not a password problem: the API's sentence goes to the screen, the step closes", async () => {
    const { writes, reload } = fakeWrites();
    const sentence =
      '“Cancel a bill” also needs “See bills, payments and customer ledgers”. Nothing was changed.';
    writes.superSetRoleTicks.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, sentence, {
        field: 'ticks',
        broken: [{ tick: 'bill_cancel', missing: 'bill_view' }],
      })
    );
    const outcome = await runRoleEdit(writes, reload, editOf(...TICKS), PASSWORD);
    expect(outcome).toEqual({ kind: 'refused', error: sentence, saved: null });
  });

  it('the Owner refusal and any other rule are shown as the API says them', async () => {
    const { writes, reload } = fakeWrites();
    const sentence = 'The Owner role is fixed and cannot be changed. Nothing was changed.';
    writes.superEditRole.mockRejectedValueOnce(refusal('JV_NOT_ALLOWED', 409, sentence));
    expect(await runRoleEdit(writes, reload, editOf(NAME), PASSWORD)).toEqual({
      kind: 'refused',
      error: sentence,
      saved: null,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('a stale answer to the first write: the role was changed by someone else, nothing was saved, nothing is read again (the Reload button does that)', async () => {
    const { writes, reload } = fakeWrites();
    writes.superEditRole.mockRejectedValueOnce(
      refusal('JV_STALE', 409, 'This was changed by someone else. Reload and try again.')
    );
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toEqual({ kind: 'stale', saved: null });
    expect(writes.superSetRoleTicks).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a stale answer to the only write is the same', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(refusal('JV_STALE', 409, 'x'));
    expect(await runRoleEdit(writes, reload, editOf(...TICKS), PASSWORD)).toEqual({
      kind: 'stale',
      saved: null,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('the first write went through and the second was refused: it says plainly what was saved and what was not, hands back the role as saved, and reads the lists again', async () => {
    const { writes, reload } = fakeWrites();
    const reason = '“Cancel a bill” also needs “See bills, payments and customer ledgers”.';
    // as the client words a refusal of one write: the API's sentence, then "Nothing was changed."
    writes.superSetRoleTicks.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, `${reason} Nothing was changed.`, { field: 'ticks' })
    );
    const outcome = await runRoleEdit(
      writes,
      reload,
      editOf(NAME, DESCRIPTION, ...TICKS),
      PASSWORD
    );
    // the closing "Nothing was changed." is left off: something was
    expect(outcome).toEqual({
      kind: 'refused',
      error: `The name and description were saved, but the ticks were not. ${reason}`,
      saved: expect.objectContaining({ name: 'Night Till', updated_at: AFTER_FIRST }),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('only the name saved: the words say only the name', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(refusal('JV_NOT_ALLOWED', 409, 'Not now.'));
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toMatchObject({
      kind: 'refused',
      error: 'The name was saved, but the ticks were not. Not now.',
    });
  });

  it('an outcome nobody can vouch for on the second write, after the first went through, does not claim the ticks were not saved', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toMatchObject({
      kind: 'refused',
      error: 'The name was saved. Could not confirm that the ticks were saved.',
      saved: { updated_at: AFTER_FIRST },
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a password problem on the second write (after the first went through) is not "password": nothing can be tried again on the step, so it closes with what was saved', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(
      refusal('JV_INVALID_INPUT', 422, 'Your password is not correct.', { field: 'password' })
    );
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toMatchObject({
      kind: 'refused',
      error: 'The name was saved, but the ticks were not. Your password is not correct.',
      saved: { updated_at: AFTER_FIRST },
    });
  });

  it('a stale answer to the second write (someone changed the role between the two): it is stale, the first part is saved, and the lists are read again', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(refusal('JV_STALE', 409, 'x'));
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toEqual({
      kind: 'stale',
      saved: expect.objectContaining({ updated_at: AFTER_FIRST }),
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('an outcome nobody can vouch for says it could not be confirmed and reads the lists again: the write may have gone through', async () => {
    for (const cause of [
      refusal('JV_INTERNAL', 500, UNCONFIRMED_MESSAGE),
      new TypeError('Failed to fetch'),
      'boom',
    ]) {
      const { writes, reload } = fakeWrites();
      writes.superSetRoleTicks.mockRejectedValueOnce(cause);
      const outcome = await runRoleEdit(writes, reload, editOf(...TICKS), PASSWORD);
      expect(outcome).toEqual({ kind: 'refused', error: UNCONFIRMED_MESSAGE, saved: null });
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it('a reload that rejects after a write that went through is still a write that went through', async () => {
    const { writes, reload } = fakeWrites();
    reload.mockRejectedValueOnce(new Error('the lists could not be read'));
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome.kind).toBe('saved');
  });

  it('an answer that has no role (the contract drifted) is an outcome nobody can vouch for, and never a crash', async () => {
    const { writes, reload } = fakeWrites();
    writes.superEditRole.mockResolvedValueOnce({} as SuperRoleAnswer);
    const outcome = await runRoleEdit(writes, reload, editOf(NAME, ...TICKS), PASSWORD);
    expect(outcome).toMatchObject({ kind: 'refused', error: UNCONFIRMED_MESSAGE });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// ================================================================================================ what is done with the outcome of a save

describe('Task 25 settle: what the screen does with the outcome of a save', () => {
  const saved = role({ name: 'Till', updated_at: AFTER_FIRST });

  it('saved: the draft starts again from the role the API answered with, and the line says "Saved."; the step closes', () => {
    const outcome = settle({ kind: 'saved', role: saved }, editOf(...TICKS));
    expect(outcome).toEqual({
      action: { type: 'seed', role: saved },
      notice: { kind: 'saved' },
      stepError: null,
    });
    // the marks of changes go away: nothing differs from the new saved copy
    const edited = run(seedOf(CASHIER), tick('refund_give', true), { type: 'name', value: 'Till' });
    expect(infoOf(edited, CATALOGUE, ROLES).count).toBe(2);
    const after = run(edited, outcome.action as DraftAction);
    expect(infoOf(after, CATALOGUE, ROLES)).toMatchObject({ count: 0, dirty: false });
    expect(after.base).toBe(saved);
  });

  it('a password that was refused stays on the step with its sentence; nothing else changes', () => {
    expect(
      settle({ kind: 'password', error: 'Your password is not correct.' }, editOf(...TICKS))
    ).toEqual({
      action: null,
      notice: null,
      stepError: 'Your password is not correct.',
    });
  });

  it('a role changed by someone else closes the step and keeps her edits, with the stale line', () => {
    expect(settle({ kind: 'stale', saved: null }, editOf(...TICKS))).toEqual({
      action: null,
      notice: { kind: 'stale', savedLine: null },
      stepError: null,
    });
  });

  it("any other refusal closes the step and says the API's sentence on the page", () => {
    expect(settle({ kind: 'refused', error: 'Not now.', saved: null }, editOf(...TICKS))).toEqual({
      action: null,
      notice: { kind: 'problem', text: 'Not now.' },
      stepError: null,
    });
  });

  it('when the first write went through, the draft takes that role as its saved copy, in a stale and in any other refusal alike', () => {
    for (const outcome of [
      { kind: 'stale', saved } as const,
      { kind: 'refused', error: 'x', saved } as const,
    ])
      expect(settle(outcome, editOf(NAME, ...TICKS)).action, outcome.kind).toEqual({
        type: 'rebase',
        role: saved,
      });
  });
});

describe('Task 25 review: a stale answer to the second write still says what the first write saved', () => {
  /** The whole way a save goes, up to the notice: the writes (the second one answers `JV_STALE`), then what the screen does with the outcome. */
  async function staleSecondWrite(edit: ReturnType<typeof editOf>) {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(refusal('JV_STALE', 409, 'This was changed.'));
    const outcome = await runRoleEdit(writes, reload, edit, PASSWORD);
    return { outcome, settled: settle(outcome, edit), writes };
  }

  it('the name was saved and the ticks are stale: the notice carries "The name was saved, but the ticks were not."', async () => {
    const { settled } = await staleSecondWrite(editOf(NAME, ...TICKS));
    expect(settled.notice).toEqual({
      kind: 'stale',
      savedLine: 'The name was saved, but the ticks were not.',
    });
    expect(settled.stepError).toBeNull();
  });

  it('the description was saved: "The description was saved, but the ticks were not."', async () => {
    const { settled } = await staleSecondWrite(editOf(DESCRIPTION, ...TICKS));
    expect(settled.notice).toEqual({
      kind: 'stale',
      savedLine: 'The description was saved, but the ticks were not.',
    });
  });

  it('the name and the description were saved: "The name and description were saved, but the ticks were not."', async () => {
    const { settled } = await staleSecondWrite(editOf(NAME, DESCRIPTION, ...TICKS));
    expect(settled.notice).toEqual({
      kind: 'stale',
      savedLine: 'The name and description were saved, but the ticks were not.',
    });
  });

  it('the draft still takes the role of the first write as its saved copy (the name is not an unsaved change any more)', async () => {
    const { outcome, settled } = await staleSecondWrite(editOf(NAME, ...TICKS));
    expect(outcome).toEqual({
      kind: 'stale',
      saved: expect.objectContaining({ name: 'Night Till', updated_at: AFTER_FIRST }),
    });
    expect(settled.action).toEqual({
      type: 'rebase',
      role: expect.objectContaining({ updated_at: AFTER_FIRST }),
    });
  });

  it('a stale answer to the FIRST write saved nothing: the notice is the stale sentence alone', async () => {
    const { writes, reload } = fakeWrites();
    writes.superEditRole.mockRejectedValueOnce(refusal('JV_STALE', 409, 'This was changed.'));
    const edit = editOf(NAME, ...TICKS);
    const outcome = await runRoleEdit(writes, reload, edit, PASSWORD);
    expect(writes.superSetRoleTicks).not.toHaveBeenCalled();
    expect(settle(outcome, edit)).toEqual({
      action: null,
      notice: { kind: 'stale', savedLine: null },
      stepError: null,
    });
  });

  it('a stale answer when only the ticks changed (one write, nothing saved before it) is the stale sentence alone', async () => {
    const { writes, reload } = fakeWrites();
    writes.superSetRoleTicks.mockRejectedValueOnce(refusal('JV_STALE', 409, 'This was changed.'));
    const edit = editOf(...TICKS);
    const outcome = await runRoleEdit(writes, reload, edit, PASSWORD);
    expect(settle(outcome, edit).notice).toEqual({ kind: 'stale', savedLine: null });
  });

  it('the line is the words partlySaved uses for the same case, up to its reason', () => {
    for (const actions of [[NAME], [DESCRIPTION], [NAME, DESCRIPTION]]) {
      const edit = editOf(...actions, ...TICKS);
      expect(partlySaved(edit, 'Because of this.')).toBe(`${savedLine(edit)} Because of this.`);
    }
  });

  it('the notice names no tick key, role key, id or stamp', async () => {
    for (const edit of [editOf(NAME, ...TICKS), editOf(NAME, DESCRIPTION, ...TICKS)]) {
      const text = JSON.stringify((await staleSecondWrite(edit)).settled.notice);
      for (const hidden of [...TICK_KEYS, 'zk-cashier', STAMP, AFTER_FIRST, 'updated_at'])
        expect(text.includes(hidden), hidden).toBe(false);
    }
  });

  it('the writer says what it said before: a stale answer of the second write is stale, with the first write saved and the lists read again', async () => {
    const { outcome, writes } = await staleSecondWrite(editOf(NAME, ...TICKS));
    expect(outcome.kind).toBe('stale');
    expect(writes.superEditRole).toHaveBeenCalledTimes(1);
    expect(writes.superSetRoleTicks).toHaveBeenCalledTimes(1);
  });
});

// Access and roles (Task 25): the Edit role screen of People & Roles as it is drawn (plan: Task 25; DESIGN 6.2 and 6.5; the pictures are mockups/3-edit-role.png, 4-password-confirm.png and
// 5-phone.png). The rules behind it are tests/unit/tick-edit.test.ts and tests/unit/people-roles-editor.test.ts. This file is:
//   - the markup of the screen (drawn on the server side of React: there is no DOM here): the groups, the rows with their lines and marks, the banner, the box "I understand", Save, the
//     bars, the Owner's read-only page, the lines under the heading, no key or id on screen;
//   - the container and the shell (the screen of a role in place of the list), and the password step as it is drawn;
//   - the glue a drawing cannot reach (which handler is under which control, when the shell is told it is busy), read from the code;
//   - a guard over every file of the screen (the tripwire of tests/unit/support/leaks.ts also walks the files of this task).
//
// Run: npx vitest run tests/unit/people-roles-editor-screen.test.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import colors from 'tailwindcss/colors';
import { describe, expect, it } from 'vitest';
import ConfirmPasswordDialog from '@/app/people-roles/components/ConfirmPasswordDialog';
import EditRole from '@/app/people-roles/components/EditRole';
import EditRoleView, {
  type EditRoleViewProps,
  type EditorActions,
} from '@/app/people-roles/components/EditRoleView';
import {
  PeopleRolesScreen,
  PeopleRolesView,
} from '@/app/people-roles/components/PeopleRolesClient';
import RoleEditSummary from '@/app/people-roles/components/RoleEditSummary';
import { SensitiveTag } from '@/app/people-roles/components/TickGroup';
import { infoOf, roleEditOf, seedOf, settle, type Draft } from '@/app/people-roles/lib/editorDraft';
import {
  REREAD_FAILED_LINE,
  STALE_LINE,
  roleEditConfirmLabel,
  roleEditTitle,
} from '@/app/people-roles/lib/editWords';
import { runRoleEdit, type RoleEditWrites } from '@/app/people-roles/lib/roleEdit';
import { TICK_KEYS } from '@/lib/access';
import { ApiError } from '@/lib/api/client';
import type { SuperPerson } from '@/lib/api/types';
import {
  AFTER_FIRST,
  CASHIER,
  OTHER,
  ROLES,
  STAMP,
  role,
  run,
  tick,
} from './support/editorFixtures';
import { PASSWORD_NAMES, leaksOf, sourcesUnder } from './support/leaks';
import {
  buttonsOf,
  callsOf,
  conditionsAround,
  declarationsOf,
  draw,
  effectsCalling,
  elementsOf,
  plain,
} from './support/screen';
import { CATALOGUE, TICKS_RESPONSE } from './support/tickCatalogue';

// ================================================================================================ the screen

const noop = () => undefined;
const ACTIONS: EditorActions = {
  name: noop,
  description: noop,
  toggle: noop,
  understood: noop,
  save: noop,
  leave: noop,
  leaveForGood: noop,
  keepEditing: noop,
  reload: noop,
};
const person = (n: number, name: string, roleKey: string, active = true): SuperPerson => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  full_name: name,
  email: `person${n}@example.test`,
  role: roleKey,
  role_name: 'x',
  active,
  is_super_admin: false,
  last_login_at: null,
  updated_at: STAMP,
});
const PEOPLE = [
  person(1, 'Anita Sharma', 'zk-cashier'),
  person(2, 'Imran Shaikh', 'zk-cashier'),
  person(3, 'Pooja Nair', 'zk-cashier'),
  person(4, 'Ravi Kumar', 'zk-keeper'),
  person(5, 'Switched Off Sam', 'zk-cashier', false),
];

const drawEditor = (draft: Draft, over: Partial<EditRoleViewProps> = {}) =>
  draw(EditRoleView, {
    catalogue: TICKS_RESPONSE,
    role: draft.base,
    people: PEOPLE,
    draft,
    info: infoOf(draft, CATALOGUE, ROLES),
    notice: null,
    leaving: false,
    frozen: false,
    on: ACTIONS,
    ...over,
  } satisfies EditRoleViewProps);
const CLEAN = seedOf(CASHIER);
const rowsOf = (html: string) =>
  [...html.matchAll(/<li data-testid="tick"[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);
const rowFor = (html: string, label: string) => {
  const row = rowsOf(html).find((one) => plain(one).startsWith(label));
  if (row === undefined) throw new Error(`no row for ${label}`);
  return row;
};
const isChecked = (row: string) => /<input[^>]*\schecked=""/.test(row);
const isDisabled = (row: string) => /<input[^>]*\sdisabled=""/.test(row);
/** The whole element (a button, a paragraph, a bar) that has this test id, from its opening tag to the closing tag that matches it. */
const tagOfBlock = (html: string, testId: string) => {
  const open = html.match(new RegExp(`<([a-z0-9]+)[^>]*data-testid="${testId}"[^>]*>`));
  if (open?.index === undefined) return '';
  const scan = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'g');
  scan.lastIndex = open.index;
  let depth = 0;
  for (let found = scan.exec(html); found; found = scan.exec(html)) {
    depth += found[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open.index, found.index + found[0].length);
  }
  return '';
};
const tagOf = (html: string, testId: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

describe('Task 25 the screen of a role: what is drawn', () => {
  it('has the heading and the line under it, "Back to roles", the name and what the role is for, and who has it', () => {
    const html = drawEditor(CLEAN);
    const words = plain(html);
    expect(html).toMatch(/<h2[^>]*>Edit role<\/h2>/);
    expect(words).toContain('Tick what people with this role can do and see.');
    expect(plain(tagOfBlock(html, 'edit-role-back'))).toBe('Back to roles');
    // the labels are the small capital ones of the picture, and are not part of the text of the field
    expect(html).toMatch(/<span class="[^"]*\buppercase\b[^"]*">Role name<\/span><input/);
    expect(html).toMatch(
      /<span class="[^"]*\buppercase\b[^"]*">What this role is for<\/span><textarea/
    );
    expect(words).toContain('Role name');
    expect(words).toContain('What this role is for');
    expect(tagOf(html, 'edit-role-name')).toContain('value="Cashier"');
    expect(html).toMatch(
      /<textarea[^>]*data-testid="edit-role-description"[^>]*>Makes bills and takes payments<\/textarea>/
    );
    // the people who have it, by name; a person who is switched off, and a person of another role, are not named
    expect(words).toContain('3 people have this role: Anita Sharma Imran Shaikh Pooja Nair');
    expect(words).not.toContain('Ravi Kumar');
    expect(words).not.toContain('Switched Off Sam');
  });

  it('says so when nobody has the role, and counts one person in the singular', () => {
    expect(plain(drawEditor(seedOf(role({ people: 0 }))))).toContain('Nobody has this role yet.');
    expect(plain(drawEditor(seedOf(role({ key: 'zk-keeper', people: 1 }))))).toContain(
      '1 person has this role: Ravi Kumar'
    );
  });

  it('draws the six groups in the order of the catalogue, each with how many of its ticks are on', () => {
    const html = drawEditor(CLEAN);
    const groups = [
      ...html.matchAll(/<h3[^>]*><span>([^<]*)<\/span><span[^>]*>([^<]*)<\/span><\/h3>/g),
    ].map((m) => [m[1], m[2]]);
    expect(groups).toEqual([
      ['Stock', '0 of 7 on'],
      ['Photos', '0 of 1 on'],
      ['Money', '7 of 17 on'],
      ['Orders', '2 of 3 on'],
      ['Records', '0 of 3 on'],
      ['Shop', '0 of 1 on'],
    ]);
  });

  it('every tick is a check box with its words; the ones the role has are checked; the ticks come in catalogue order', () => {
    const html = drawEditor(CLEAN);
    const rows = rowsOf(html);
    expect(rows).toHaveLength(32);
    expect(rows.filter(isChecked)).toHaveLength(9);
    expect(rows.every((row) => /<input[^>]*type="checkbox"/.test(row) && /<label/.test(row))).toBe(
      true
    );
    const words = rows.map((row) => plain(row));
    for (const [place, one] of CATALOGUE.entries())
      expect(words[place].startsWith(one.label)).toBe(true);
    expect(isChecked(rowFor(html, 'Make bills and estimates'))).toBe(true);
    expect(isChecked(rowFor(html, 'Cancel a bill'))).toBe(false);
  });

  it("the check box of a row is hidden from the eye but stays inside its row: the label is positioned, or the box would sit outside the screen's scrolling area and focusing it would scroll the whole page", () => {
    const rows = rowsOf(drawEditor(CLEAN));
    for (const row of rows) {
      expect(row).toMatch(/<input[^>]*class="[^"]*\bsr-only\b/);
      expect(row).toMatch(/<label[^>]*class="[^"]*\brelative\b/);
    }
  });

  it('the name of a check box is the title of its tick (the words and the marks), not the lines under it, which are its description', () => {
    const html = drawEditor(run(CLEAN, tick('bill_cancel', true)));
    const row = rowFor(html, 'Cancel a bill');
    const nameId = /<input[^>]*aria-labelledby="([^"]+)"/.exec(row)?.[1] ?? '';
    const describedBy = /<input[^>]*aria-describedby="([^"]+)"/.exec(row)?.[1] ?? '';
    expect(nameId).not.toBe('');
    const title = new RegExp(
      `<span id="${nameId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</span></span>`
    ).exec(row);
    expect(plain(title?.[0] ?? '')).toBe('Cancel a bill Sensitive Changed');
    // the lines are in the description, and not in the name
    expect(describedBy.split(' ').length).toBe(1);
    expect(row).toContain(`id="${describedBy}"`);
    expect(describedBy).not.toBe(nameId);
  });

  it('the help text of the catalogue is under its tick, and only there', () => {
    const html = drawEditor(CLEAN);
    for (const one of CATALOGUE.filter((tickInfo) => tickInfo.help !== null))
      expect(plain(rowFor(html, one.label)), one.label).toContain(one.help as string);
    expect(plain(rowFor(html, 'Add designs and photos'))).toBe('Add designs and photos');
    expect(plain(rowFor(html, 'Edit design and piece details'))).toContain(
      'Weights and labour rates are the price inputs.'
    );
  });

  it('the twelve sensitive ticks have the red "Sensitive" mark, the others none', () => {
    const rows = rowsOf(drawEditor(CLEAN));
    const marked = rows.filter((row) => />Sensitive</.test(row)).map((row) => plain(row));
    expect(marked).toHaveLength(12);
    for (const one of CATALOGUE)
      expect(
        marked.some((words) => words.startsWith(one.label)),
        one.label
      ).toBe(one.sensitive);
  });

  it('a tick that needs others says "Also needs ..." with their words, the direct needs only', () => {
    const html = drawEditor(CLEAN);
    expect(plain(rowFor(html, 'Add and edit customers'))).toContain(
      'Also needs “See customers (name, phone, address, GST)”'
    );
    expect(plain(rowFor(html, 'Cancel a bill'))).toContain(
      'Also needs “See customers (name, phone, address, GST)” and “See bills, payments and customer ledgers”'
    );
    expect(plain(rowFor(html, 'Re-issue a bill'))).toContain(
      'Also needs “See customers (name, phone, address, GST)”, “See bills, payments and customer ledgers” and “Make bills and estimates”'
    );
    expect(plain(rowFor(html, 'Add designs and photos'))).not.toContain('Also needs');
    expect(plain(html).match(/Also needs/g)).toHaveLength(15);
  });

  it('a tick that another ticked tick needs is locked: a disabled box with a lock, and "Needed by ..." names the ticks that need it', () => {
    const html = drawEditor(CLEAN);
    const row = rowFor(html, 'See customers (name, phone, address, GST)');
    expect(isDisabled(row)).toBe(true);
    expect(isChecked(row)).toBe(true);
    expect(row).toMatch(/lucide-lock/);
    expect(plain(row)).toContain(
      'Needed by “Add and edit customers”, “Make bills and estimates”, “Receive payments and settle fine” and “Make and change orders, add order photos”'
    );
    // a tick nothing needs can be changed, and says nothing of the kind
    const free = rowFor(html, 'Make bills and estimates');
    expect(isDisabled(free)).toBe(false);
    expect(plain(free)).not.toContain('Needed by');
    expect(free).not.toMatch(/lucide-lock/);
    // no other box is locked than the ones another ticked tick needs
    const locked = rowsOf(html)
      .filter(isDisabled)
      .map((one) => plain(one).split(' Needed by')[0]);
    expect(locked).toEqual([
      'See customers (name, phone, address, GST)',
      'See bills, payments and customer ledgers',
      'See the Order Book',
    ]);
  });
});

describe('Task 25 the screen of a role: what has changed', () => {
  const changed = run(
    CLEAN,
    tick('cashbook_all', true), // its need cashbook_recent is on already
    tick('bill_cancel', true), // sensitive; its needs are on already
    tick('payment_receive', false)
  );

  it('every tick that differs from the saved set has the yellow row and the "Changed" mark, and no other has', () => {
    const html = drawEditor(changed);
    const marked = rowsOf(html).filter((row) => />Changed</.test(row));
    expect(marked.map((row) => plain(row).split(' Changed')[0].split(' Sensitive')[0])).toEqual(
      ['See the cash book for all days', 'Receive payments and settle fine', 'Cancel a bill'].sort(
        (a, b) => keysOrder(a) - keysOrder(b)
      )
    );
    for (const row of marked) expect(row).toMatch(/^<li[^>]*class="[^"]*bg-\[#fff8e6\]/);
    expect(
      rowsOf(html)
        .filter((row) => !/>Changed</.test(row))
        .every((row) => !/bg-\[#fff8e6\]/.test(row))
    ).toBe(true);
  });

  it('a tick turned on and off again has no mark; a fresh screen has none at all', () => {
    expect(drawEditor(run(CLEAN, tick('back_date', true), tick('back_date', false)))).not.toContain(
      'Changed'
    );
    expect(drawEditor(CLEAN)).not.toContain('Changed');
  });

  it('turning a tick on marks the ticks it needs too, when they were off', () => {
    const html = drawEditor(run(seedOf(role({ ticks: [] })), tick('customer_edit', true)));
    const marked = rowsOf(html)
      .filter((row) => />Changed</.test(row))
      .map((row) => plain(row).split(' Changed')[0]);
    expect(marked).toEqual(['See customers (name, phone, address, GST)', 'Add and edit customers']);
  });

  it('the banner counts the changes and names them: the ticks in catalogue order', () => {
    const html = drawEditor(changed);
    expect(plain(tagOfBlock(html, 'edit-role-banner'))).toBe(
      '3 changes not saved yet: See the cash book for all days, Receive payments and settle fine, Cancel a bill'
    );
    expect(tagOf(html, 'edit-role-banner')).toContain('role="status"');
  });

  it('one change is "1 change not saved yet", and the name and the description count like a tick', () => {
    expect(
      plain(tagOfBlock(drawEditor(run(CLEAN, tick('cashbook_all', true))), 'edit-role-banner'))
    ).toBe('1 change not saved yet: See the cash book for all days');
    expect(
      plain(
        tagOfBlock(
          drawEditor(
            run(
              CLEAN,
              { type: 'name', value: 'Till' },
              { type: 'description', value: 'x' },
              tick('cashbook_all', true)
            )
          ),
          'edit-role-banner'
        )
      )
    ).toBe(
      '3 changes not saved yet: Role name, What this role is for, See the cash book for all days'
    );
  });

  it('no banner when nothing changed', () => {
    expect(drawEditor(CLEAN)).not.toContain('data-testid="edit-role-banner"');
  });

  it('a group counts the ticks that are on now, not the saved ones', () => {
    const html = drawEditor(run(CLEAN, tick('cashbook_all', true), tick('stock_add', true)));
    const counts = [
      ...html.matchAll(/<h3[^>]*><span>([^<]*)<\/span><span[^>]*>([^<]*)<\/span>/g),
    ].map((m) => m[2]);
    expect(counts).toEqual([
      '1 of 7 on',
      '0 of 1 on',
      '8 of 17 on',
      '2 of 3 on',
      '0 of 3 on',
      '0 of 1 on',
    ]);
  });
});

/** The place of a tick's words in the catalogue (to put a list of words in catalogue order). */
const keysOrder = (label: string) => CATALOGUE.findIndex((one) => one.label === label);

describe('Task 25 the screen of a role: the box "I understand" and Save', () => {
  const bar = (html: string, which: 'head' | 'phone') => ({
    save: tagOf(html, `edit-role-${which}-save`),
    cancel: tagOf(html, `edit-role-${which}-cancel`),
  });
  const disabled = (tag: string) => /\sdisabled=""/.test(tag);

  it('a sensitive tick turned on shows one box that lists those ticks in words; Save waits for it', () => {
    const on = run(CLEAN, tick('bill_cancel', true), tick('refund_give', true));
    const html = drawEditor(on);
    expect(html.match(/data-testid="edit-role-understand"/g)).toHaveLength(1);
    const box = tagOfBlock(html, 'edit-role-understand');
    expect(plain(box)).toBe(
      'Sensitive. I understand: people with this role will be able to: Cancel a bill Give a refund'
    );
    expect(box).not.toMatch(/<input[^>]*\schecked=""/);
    for (const which of ['head', 'phone'] as const)
      expect(disabled(bar(html, which).save), which).toBe(true);
    expect(plain(html)).toContain('Tick “I understand” first.');
  });

  it('the box is a check box with its sentence as its label, and the ticks it is about as its description, for a screen reader', () => {
    const html = drawEditor(run(CLEAN, tick('bill_cancel', true)));
    const box = tagOfBlock(html, 'edit-role-understand');
    const boxId = /<input id="([^"]+)"/.exec(box)?.[1] ?? '';
    const listId = /<ul id="([^"]+)"/.exec(box)?.[1] ?? '';
    expect(boxId).not.toBe('');
    expect(listId).not.toBe('');
    expect(box).toContain(`<label for="${boxId}"`);
    expect(box).toContain(`aria-describedby="${listId}"`);
  });

  it('once the box is ticked for those ticks Save works, and the line under it is about the password', () => {
    const confirm = infoOf(run(CLEAN, tick('bill_cancel', true)), CATALOGUE, ROLES).confirm;
    const html = drawEditor(
      run(CLEAN, tick('bill_cancel', true), { type: 'understood', confirm, on: true })
    );
    expect(tagOfBlock(html, 'edit-role-understand')).toMatch(/<input[^>]*\schecked=""/);
    for (const which of ['head', 'phone'] as const)
      expect(disabled(bar(html, which).save), which).toBe(false);
    expect(plain(html)).toContain('Asks for your password');
    expect(plain(html)).not.toContain('Tick “I understand” first.');
  });

  it('no box when no sensitive tick is newly on: not for a plain change, not for a sensitive tick that was saved as on', () => {
    expect(drawEditor(run(CLEAN, tick('cashbook_all', true)))).not.toContain(
      'edit-role-understand'
    );
    const saved = seedOf(role({ ticks: ['customer_view', 'bill_view', 'bill_cancel'] }));
    expect(drawEditor(run(saved, { type: 'name', value: 'Cancels' }))).not.toContain(
      'edit-role-understand'
    );
  });

  it('Save is off when nothing changed, on for a change that is fine, and off while the name is not', () => {
    const state = (draft: Draft) => disabled(bar(drawEditor(draft), 'head').save);
    expect(state(CLEAN)).toBe(true);
    expect(state(run(CLEAN, tick('cashbook_all', true)))).toBe(false);
    expect(state(run(CLEAN, { type: 'name', value: 'Till' }))).toBe(false);
    expect(state(run(CLEAN, tick('cashbook_all', true), { type: 'name', value: '' }))).toBe(true);
    expect(
      state(run(CLEAN, tick('cashbook_all', true), { type: 'name', value: 'Stock Keeper' }))
    ).toBe(true);
  });

  it('Cancel is always there, and works', () => {
    for (const draft of [CLEAN, run(CLEAN, tick('cashbook_all', true))]) {
      const html = drawEditor(draft);
      for (const which of ['head', 'phone'] as const)
        expect(disabled(bar(html, which).cancel)).toBe(false);
    }
  });

  it('the mistakes of the name are under its field, in plain words', () => {
    const html = drawEditor(run(CLEAN, { type: 'name', value: '---' }));
    expect(plain(html)).toContain('Name needs a letter or a number.');
    expect(tagOf(html, 'edit-role-name')).toContain('aria-invalid="true"');
    expect(plain(drawEditor(run(CLEAN, { type: 'name', value: '' })))).toContain(
      'Name is required.'
    );
    expect(plain(drawEditor(run(CLEAN, { type: 'name', value: 'stock keeper' })))).toContain(
      'Another role already has this name.'
    );
    expect(
      plain(drawEditor(run(CLEAN, { type: 'description', value: 'a'.repeat(201) })))
    ).toContain('Description is 200 characters at most.');
    expect(plain(drawEditor(CLEAN))).not.toContain('Name is required');
  });

  it('the name is 40 characters at most and starts with a capital on a phone, and is required; the description is 200 at most and is not', () => {
    const html = drawEditor(CLEAN);
    const name = tagOf(html, 'edit-role-name');
    expect(name).toContain('maxLength="40"');
    expect(name).toContain('autoCapitalize="words"');
    expect(name).toContain('aria-required="true"');
    const description = tagOf(html, 'edit-role-description');
    expect(description).toContain('maxLength="200"');
    expect(description).not.toContain('aria-required');
  });
});

describe('Task 25 the screen of a role: the bar on a phone and the buttons in the heading', () => {
  it('Cancel and Save changes are in the heading from the tablet width up, and in a bar that sticks to the bottom below it', () => {
    const html = drawEditor(CLEAN);
    const head = tagOfBlock(html, 'edit-role-phone-bar');
    expect(head).toContain('Save changes');
    expect(tagOf(html, 'edit-role-phone-bar')).toMatch(/class="[^"]*\bsticky\b[^"]*\bbottom-\[/);
    expect(tagOf(html, 'edit-role-phone-bar')).toMatch(/class="[^"]*\bmd:hidden\b/);
    // the heading's pair is hidden below md
    expect(html).toMatch(
      /<div class="hidden md:block"><div><div class="flex gap-2\.5"><button[^>]*edit-role-head-cancel/
    );
    expect(buttonsOf(head)).toEqual(['Cancel', 'Save changes']);
  });

  it('the bar says that Save asks for the password, as the picture does', () => {
    expect(plain(tagOfBlock(drawEditor(CLEAN), 'edit-role-phone-bar'))).toContain(
      'Asks for your password'
    );
  });

  it('the bar sits just above the phone menu: its offset from the bottom is the height of that menu (69 px, 4.3rem, measured in the browser), not a gap of more', () => {
    const tagClass = tagOf(drawEditor(CLEAN), 'edit-role-phone-bar');
    const offset = Number(/bottom-\[([\d.]+)rem\]/.exec(tagClass)?.[1]);
    expect(offset).toBeGreaterThanOrEqual(4.25);
    expect(offset).toBeLessThanOrEqual(4.5);
  });

  it('the ticks are one column on a phone and two from 1280 px, in the order of the catalogue', () => {
    expect(tagOf(drawEditor(CLEAN), 'tick-groups')).toMatch(/class="[^"]*\bxl:columns-2\b/);
  });
});

describe('Task 25 the screen of a role: a switched-off role, the Owner, and what is behind the password step', () => {
  it('a switched-off role is edited like any other and says "Switched off" by the heading', () => {
    const off = seedOf(role({ active: false }));
    const html = drawEditor(off);
    expect(plain(html)).toContain('Edit role');
    expect(plain(html)).toContain('Switched off');
    expect(tagOf(html, 'edit-role-name')).toBeTruthy();
    expect(plain(drawEditor(CLEAN))).not.toContain('Switched off');
  });

  const OWNER = role({
    key: 'owner',
    name: 'Owner',
    description: 'Everything. This role cannot be changed.',
    fixed: true,
    ticks: [...TICK_KEYS],
    people: 1,
  });
  const drawOwner = () => drawEditor(seedOf(OWNER), { people: [person(9, 'Siddhi', 'owner')] });

  it('the Owner is read-only: its name and description as plain text, "The Owner role is fixed.", no field, no Save, no Cancel', () => {
    const html = drawOwner();
    const words = plain(html);
    expect(words).toContain('The Owner role is fixed.');
    expect(words).toContain('Owner');
    expect(words).toContain('Everything. This role cannot be changed.');
    expect(html).not.toMatch(/<(input type="text"|textarea)/);
    expect(html).not.toContain('edit-role-head');
    expect(html).not.toContain('edit-role-phone');
    expect(html).not.toContain('Save changes');
    expect(html).not.toMatch(/>Cancel<\/button>/);
    expect(html).not.toContain('edit-role-banner');
    expect(html).not.toContain('edit-role-understand');
    expect(buttonsOf(html.replace(/<svg[\s\S]*?<\/svg>/g, ''))).toEqual(['Back to roles']);
  });

  it('every tick of the Owner is on and locked (a disabled box with a lock), and no line about needs is drawn', () => {
    const html = drawOwner();
    const rows = rowsOf(html);
    expect(rows).toHaveLength(32);
    expect(rows.every((row) => isChecked(row) && isDisabled(row) && /lucide-lock/.test(row))).toBe(
      true
    );
    expect(html).not.toContain('Also needs');
    expect(html).not.toContain('Needed by');
    expect(html).not.toContain('Changed');
    expect(
      [...html.matchAll(/<h3[^>]*><span>[^<]*<\/span><span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1])
    ).toEqual(['7 of 7 on', '1 of 1 on', '17 of 17 on', '3 of 3 on', '3 of 3 on', '1 of 1 on']);
  });

  it('the Owner is all on whatever the list says (a tick missing from its list is still on)', () => {
    const html = drawEditor(seedOf({ ...OWNER, ticks: ['stock_add'] }));
    expect(rowsOf(html).every((row) => isChecked(row))).toBe(true);
  });

  it('while the password step is up (frozen) everything behind it is off: one disabled fieldset around the page', () => {
    expect(drawEditor(CLEAN, { frozen: true })).toMatch(
      /<fieldset[^>]*data-testid="edit-role"[^>]*\sdisabled=""/
    );
    expect(drawEditor(CLEAN)).not.toMatch(/<fieldset[^>]*\sdisabled=""/);
  });
});

// ================================================================================================ Task 24b: the red "Sensitive" mark

// The mark is 11 px of text, so WCAG AA asks 4.5:1 (normal text). The colours are those of Tailwind's default palette, which this site extends and does not replace (tailwind.config.js).
describe('Task 24b the red "Sensitive" mark reaches the contrast of AA', () => {
  const palette = colors as unknown as Record<string, Record<string, string>>;
  const channel = (value: number) => {
    const share = value / 255;
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => channel(parseInt(hex.slice(at, at + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  /** The colours the mark is drawn with: its text and its background, from the classes of its markup. */
  const coloursOf = (html: string) => {
    const classes = (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
    const pick = (prefix: string) => {
      const found = classes.filter((one) => new RegExp(`^${prefix}-red-\\d+$`).test(one));
      expect(found, `the ${prefix} classes of the mark`).toHaveLength(1);
      return { name: found[0], hex: palette.red[found[0].split('-')[2]] };
    };
    return { text: pick('text'), back: pick('bg') };
  };

  it('the checker sees what the old class was: red-600 on red-50 is under 4.5:1 and red-700 is over it', () => {
    expect(contrast(palette.red['600'], palette.red['50'])).toBeGreaterThan(4.4);
    expect(contrast(palette.red['600'], palette.red['50'])).toBeLessThan(4.5);
    expect(contrast(palette.red['700'], palette.red['50'])).toBeGreaterThan(4.5);
  });

  it('the text of the mark on its background is at least 4.5:1', () => {
    const html = draw(SensitiveTag, {});
    expect(plain(html)).toBe('Sensitive');
    const { text, back } = coloursOf(html);
    expect(back.name).toBe('bg-red-50');
    expect(contrast(text.hex, back.hex), `${text.name} on ${back.name}`).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it('the mark is text-red-700 on bg-red-50, still 11 px and bold, and the same one in the rows and in the summary of the password step', () => {
    const html = draw(SensitiveTag, {});
    expect(html).toContain('text-red-700');
    expect(html).not.toContain('text-red-600');
    expect(html).toContain('text-[11px]');
    expect(html).toContain('font-bold');
    const row = rowFor(drawEditor(CLEAN), 'Cancel a bill');
    expect(row).toContain('text-red-700');
    expect(row).not.toContain('text-red-600');
    const summary = draw(RoleEditSummary, {
      edit: roleEditOf(run(CLEAN, tick('bill_cancel', true)), CATALOGUE),
      catalogue: CATALOGUE,
    });
    expect(summary).toContain('text-red-700');
    expect(summary).not.toContain('text-red-600');
  });
});

describe('Task 25 the screen of a role: the lines under the heading', () => {
  it('nothing is said until there is something to say', () => {
    const html = drawEditor(CLEAN);
    for (const id of ['edit-role-saved', 'edit-role-stale', 'edit-role-problem', 'edit-role-leave'])
      expect(html, id).not.toContain(id);
    expect(html).not.toContain('role="alert"');
  });

  it('"Saved." is a status line', () => {
    const html = drawEditor(CLEAN, { notice: { kind: 'saved' } });
    expect(plain(tagOfBlock(html, 'edit-role-saved'))).toBe('Saved.');
    expect(tagOf(html, 'edit-role-saved')).toContain('role="status"');
  });

  it('a role changed by someone else is an alert with exactly the words of the brief, and a Reload button', () => {
    const html = drawEditor(run(CLEAN, tick('cashbook_all', true)), {
      notice: { kind: 'stale', savedLine: null },
    });
    const alert = tagOfBlock(html, 'edit-role-stale');
    expect(plain(alert)).toBe(
      'This role was changed by someone else. Reload it and try again. Reload'
    );
    expect(tagOf(html, 'edit-role-stale')).toContain('role="alert"');
    expect(tagOf(html, 'edit-role-reload')).toContain('type="button"');
    // her edits are still on screen
    expect(plain(html)).toContain('1 change not saved yet');
  });

  const STALE_SENTENCE = 'This role was changed by someone else. Reload it and try again.';
  const SAVED_LINES = [
    'The name was saved, but the ticks were not.',
    'The description was saved, but the ticks were not.',
    'The name and description were saved, but the ticks were not.',
  ];

  it('when the name or the description was already saved, the same alert says so first: that line, then the stale sentence, then Reload, in that order', () => {
    for (const line of SAVED_LINES) {
      const html = drawEditor(run(CLEAN, tick('cashbook_all', true)), {
        notice: { kind: 'stale', savedLine: line },
      });
      const alert = tagOfBlock(html, 'edit-role-stale');
      expect(plain(alert), line).toBe(`${line} ${STALE_SENTENCE} Reload`);
      expect(alert.indexOf(line), line).toBeGreaterThan(-1);
      expect(alert.indexOf(STALE_SENTENCE), line).toBeGreaterThan(alert.indexOf(line));
      expect(alert.indexOf('>Reload</button>'), line).toBeGreaterThan(
        alert.indexOf(STALE_SENTENCE)
      );
      // one alert, with the button of Reload in it, as before
      expect(html.match(/role="alert"/g), line).toHaveLength(1);
      expect(tagOf(html, 'edit-role-reload')).toContain('type="button"');
    }
  });

  it('the stale sentence is byte for byte the same with and without the line before it, in a paragraph of its own', () => {
    expect(STALE_LINE).toBe(STALE_SENTENCE);
    for (const savedLine of [null, ...SAVED_LINES]) {
      const html = drawEditor(CLEAN, { notice: { kind: 'stale', savedLine } });
      expect(html, String(savedLine)).toMatch(new RegExp(`<p[^>]*>${STALE_SENTENCE}</p>`));
    }
  });

  it('with nothing saved before (the first write was stale, or only ticks changed) the alert is the stale sentence alone, as before', () => {
    const html = drawEditor(run(CLEAN, tick('cashbook_all', true)), {
      notice: { kind: 'stale', savedLine: null },
    });
    expect(plain(tagOfBlock(html, 'edit-role-stale'))).toBe(`${STALE_SENTENCE} Reload`);
    expect(plain(html)).not.toMatch(/saved, but the ticks were not/);
  });

  // Task 24b (F5): a Reload that could not read the role again changes nothing but the alert
  const REREAD_FAILED =
    'Could not read the role again. Check your connection and try Reload again.';

  it('a Reload that could not read the role again keeps the stale alert and its Reload button, says so in a plain line, and leaves her edits on screen', () => {
    expect(REREAD_FAILED_LINE).toBe(REREAD_FAILED);
    const html = drawEditor(run(CLEAN, tick('cashbook_all', true)), {
      notice: { kind: 'stale', savedLine: null, readFailed: true },
    });
    const alert = tagOfBlock(html, 'edit-role-stale');
    expect(plain(alert)).toBe(`${STALE_SENTENCE} ${REREAD_FAILED} Reload`);
    // one alert, with the button of Reload in it, after both lines
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(alert.indexOf('>Reload</button>')).toBeGreaterThan(alert.indexOf(REREAD_FAILED));
    expect(tagOf(html, 'edit-role-reload')).toContain('type="button"');
    expect(html).toMatch(new RegExp(`<p[^>]*>${REREAD_FAILED}</p>`));
    // her edits are still on screen: nothing was restarted
    expect(plain(html)).toContain('1 change not saved yet');
    expect(rowsOf(html).filter(isChecked)).toHaveLength(10);
  });

  it('with the name saved first, the order is: what was saved, the stale sentence, the line about the read, Reload', () => {
    const line = SAVED_LINES[0];
    const html = drawEditor(CLEAN, {
      notice: { kind: 'stale', savedLine: line, readFailed: true },
    });
    expect(plain(tagOfBlock(html, 'edit-role-stale'))).toBe(
      `${line} ${STALE_SENTENCE} ${REREAD_FAILED} Reload`
    );
  });

  it('the line about the read is drawn only when the read failed: with `readFailed` false, or not given, the alert is the stale one as before', () => {
    for (const notice of [
      { kind: 'stale', savedLine: null },
      { kind: 'stale', savedLine: null, readFailed: false },
    ] as const) {
      const html = drawEditor(CLEAN, { notice });
      expect(plain(tagOfBlock(html, 'edit-role-stale'))).toBe(`${STALE_SENTENCE} Reload`);
      expect(html).not.toContain('Could not read the role again');
    }
    // and no other alert has it: a refusal is the API's sentence alone
    expect(drawEditor(CLEAN, { notice: { kind: 'problem', text: 'Not now.' } })).not.toContain(
      'Could not read the role again'
    );
  });

  it('the alert with the line before it names no tick key, role key, id or stamp', () => {
    for (const line of SAVED_LINES) {
      const html = drawEditor(CLEAN, { notice: { kind: 'stale', savedLine: line } });
      for (const hidden of [...TICK_KEYS, 'zk-cashier', STAMP, AFTER_FIRST, 'updated_at'])
        expect(html.includes(hidden), hidden).toBe(false);
    }
  });

  it('a whole stale second save, from the writes to the page: the name is saved and live, so it is not counted as unsaved, the ticks are, and the alert says what was saved first', async () => {
    const writes = {
      superEditRole: async (key: string, body: { changes: { name?: string } }) => ({
        role: role({ key, name: body.changes.name ?? 'Cashier', updated_at: AFTER_FIRST }),
      }),
      superSetRoleTicks: async () => {
        throw new ApiError({
          code: 'JV_STALE',
          status: 409,
          message: 'This was changed by someone else. Reload and try again.',
          details: {},
          write: true,
        });
      },
    } as unknown as RoleEditWrites;
    const draft = run(CLEAN, { type: 'name', value: '  Till ' }, tick('cashbook_all', true));
    const edit = roleEditOf(draft, CATALOGUE);
    const typed = `pw-${randomBytes(9).toString('hex')}`;
    const settled = settle(await runRoleEdit(writes, async () => undefined, edit, typed), edit);
    const after = settled.action === null ? draft : run(draft, settled.action);
    const html = drawEditor(after, { notice: settled.notice });
    expect(plain(tagOfBlock(html, 'edit-role-stale'))).toBe(
      `The name was saved, but the ticks were not. ${STALE_SENTENCE} Reload`
    );
    expect(plain(tagOfBlock(html, 'edit-role-banner'))).toBe(
      '1 change not saved yet: See the cash book for all days'
    );
    expect(tagOf(html, 'edit-role-name')).toContain('value="Till"');
    expect(html.includes(typed)).toBe(false);
  });

  it("any other refusal is an alert with the API's sentence, untouched, and no Reload button", () => {
    const sentence =
      '“Cancel a bill” also needs “See bills, payments and customer ledgers”. Nothing was changed.';
    const html = drawEditor(CLEAN, { notice: { kind: 'problem', text: sentence } });
    expect(plain(tagOfBlock(html, 'edit-role-problem'))).toBe(sentence);
    expect(tagOf(html, 'edit-role-problem')).toContain('role="alert"');
    expect(html).not.toContain('edit-role-reload');
  });

  it('"Leave without saving?" is one plain line with two buttons, drawn only when she has edits; it is not a dialog', () => {
    const edited = run(CLEAN, tick('cashbook_all', true));
    const html = drawEditor(edited, { leaving: true });
    const line = tagOfBlock(html, 'edit-role-leave');
    expect(plain(line)).toBe('Leave without saving? Your changes will be lost. Leave Keep editing');
    expect(tagOf(html, 'edit-role-leave')).toContain('role="alert"');
    expect(buttonsOf(line)).toEqual(['Leave', 'Keep editing']);
    expect(html).not.toContain('role="dialog"');
    // nothing to lose: the question is not asked
    expect(drawEditor(CLEAN, { leaving: true })).not.toContain('edit-role-leave');
    expect(drawEditor(edited, { leaving: false })).not.toContain('edit-role-leave');
  });
});

describe('Task 25 the screen of a role: no key, no id, no stamp', () => {
  it('shows no tick key, role key, person id or stamp, in any state', () => {
    const edited = run(CLEAN, tick('bill_cancel', true), tick('cashbook_all', true), {
      type: 'name',
      value: 'Till',
    });
    const confirm = infoOf(edited, CATALOGUE, ROLES).confirm;
    const states = [
      drawEditor(CLEAN),
      drawEditor(edited),
      drawEditor(run(edited, { type: 'understood', confirm, on: true }), {
        notice: { kind: 'stale', savedLine: null },
        leaving: true,
      }),
      drawEditor(seedOf(role({ key: 'owner', name: 'Owner', fixed: true, ticks: [...TICK_KEYS] }))),
    ];
    for (const html of states) {
      for (const hidden of [
        ...TICK_KEYS,
        'zk-cashier',
        'zk-keeper',
        STAMP,
        AFTER_FIRST,
        'updated_at',
        '00000000-0000-4000',
      ])
        expect(html.includes(hidden), hidden).toBe(false);
    }
  });
});

// ================================================================================================ the container and the shell

describe('Task 25 EditRole: the screen of the role it is asked for', () => {
  const props = (over: object = {}) => ({
    ticks: TICKS_RESPONSE,
    people: PEOPLE,
    roles: ROLES,
    reload: async () => undefined,
    onBusy: noop,
    roleKey: 'zk-cashier',
    onBack: noop,
    ...over,
  });

  it('draws the editor of the role with that key, as the list holds it, with nothing changed and no dialog', () => {
    const html = draw(EditRole, props());
    expect(tagOf(html, 'edit-role-name')).toContain('value="Cashier"');
    expect(html).toContain('data-testid="edit-role"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('edit-role-banner');
    expect(html).not.toContain('role="alert"');
    expect(rowsOf(html).filter(isChecked)).toHaveLength(9);
  });

  it('another key is another role, found by its key and not by its place in the list', () => {
    const html = draw(EditRole, props({ roleKey: 'zk-keeper', roles: [OTHER, CASHIER] }));
    expect(tagOf(html, 'edit-role-name')).toContain('value="Stock Keeper"');
    expect(rowsOf(html).filter(isChecked)).toHaveLength(1);
  });

  it('a role that is not in the list draws nothing: it takes her back to the list', () => {
    expect(draw(EditRole, props({ roleKey: 'zk-gone' }))).toBe('');
  });

  it('draws the Owner as the read-only page', () => {
    const owner = role({
      key: 'owner',
      name: 'Owner',
      fixed: true,
      ticks: [...TICK_KEYS],
      people: 1,
    });
    const html = draw(EditRole, props({ roleKey: 'owner', roles: [owner, CASHIER] }));
    expect(plain(html)).toContain('The Owner role is fixed.');
    expect(html).not.toContain('Save changes');
  });
});

describe('Task 25 the shell opens the screen of a role', () => {
  it("draws, for anybody it is given, the heading and the loading line until the reads are in (the gate is the default export's)", () => {
    const html = draw(PeopleRolesScreen, {});
    expect(html).toContain('People &amp; Roles');
    expect(html).toContain('data-testid="people-roles-loading"');
    expect(html).not.toContain('role="tablist"');
  });

  it('the Roles tab with a role open shows its screen in place of the list, and keeps the heading and the tab strip', () => {
    const view = {
      status: 'ready' as const,
      error: null,
      ticks: TICKS_RESPONSE,
      people: PEOPLE,
      roles: ROLES,
      reload: async () => undefined,
    };
    const open = draw(PeopleRolesView, {
      view,
      tab: 'roles',
      onTab: noop,
      editing: 'zk-cashier',
    });
    expect(open).toContain('data-testid="edit-role"');
    expect(open).not.toContain('data-testid="roles-tab"');
    expect(open).toContain('role="tablist"');
    expect(plain(open)).toContain('People & Roles');
    const list = draw(PeopleRolesView, { view, tab: 'roles', onTab: noop, editing: null });
    expect(list).toContain('data-testid="roles-tab"');
    expect(list).not.toContain('data-testid="edit-role"');
    // the People tab does not show a role that is open
    const people = draw(PeopleRolesView, {
      view,
      tab: 'people',
      onTab: noop,
      editing: 'zk-cashier',
    });
    expect(people).toContain('data-testid="people-tab"');
    expect(people).not.toContain('data-testid="edit-role"');
  });

  it('a role that was asked for and is not in the list shows nothing of the editor (and goes back to the list)', () => {
    const view = {
      status: 'ready' as const,
      error: null,
      ticks: TICKS_RESPONSE,
      people: PEOPLE,
      roles: ROLES,
      reload: async () => undefined,
    };
    const html = draw(PeopleRolesView, {
      view,
      tab: 'roles',
      onTab: noop,
      editing: 'zk-gone',
    });
    expect(html).not.toContain('data-testid="edit-role"');
    expect(html).not.toContain('data-testid="roles-tab"');
  });
});

describe('Final review M5 the screen: the hint under Save is a button that goes to the box', () => {
  const sensitive = () => drawEditor(run(CLEAN, tick('bill_cancel', true)));
  const hintId = (html: string, which: 'head' | 'phone') =>
    /\sid="([^"]+)"/.exec(tagOf(html, `edit-role-${which}-hint`))?.[1] ?? '';

  it('while the box is what stops Save, each bar says "Tick “I understand” first." in a button, which is also the description of its Save', () => {
    const html = sensitive();
    for (const which of ['head', 'phone'] as const) {
      const hint = tagOfBlock(html, `edit-role-${which}-hint`);
      expect(hint, which).toMatch(/^<button[^>]*\stype="button"/);
      expect(plain(hint), which).toBe('Tick “I understand” first.');
      expect(hintId(html, which), which).not.toBe('');
      expect(tagOf(html, `edit-role-${which}-save`), which).toContain(
        `aria-describedby="${hintId(html, which)}"`
      );
    }
  });

  it('the two hints have ids of their own, and the page has ONE box for them to go to', () => {
    const html = sensitive();
    expect(hintId(html, 'head')).not.toBe(hintId(html, 'phone'));
    expect(html.match(/data-testid="edit-role-understand-box"/g)).toHaveLength(1);
  });

  it('when the box is not what stops Save (no sensitive tick, or the box is ticked) the hint is the plain line about the password: no button, nothing to press', () => {
    const confirm = infoOf(run(CLEAN, tick('bill_cancel', true)), CATALOGUE, ROLES).confirm;
    for (const html of [
      drawEditor(CLEAN),
      drawEditor(run(CLEAN, tick('cashbook_all', true))),
      drawEditor(run(CLEAN, tick('bill_cancel', true), { type: 'understood', confirm, on: true })),
    ])
      for (const which of ['head', 'phone'] as const) {
        const hint = tagOfBlock(html, `edit-role-${which}-hint`);
        expect(hint, which).toMatch(/^<p[^>]*>/);
        expect(hint, which).not.toContain('<button');
        expect(plain(hint), which).toBe('Asks for your password');
        expect(tagOf(html, `edit-role-${which}-save`), which).toContain(
          `aria-describedby="${hintId(html, which)}"`
        );
      }
  });

  it('the hint button does not save and is no key of the page: the buttons of a bar are Cancel, Save and the hint, and the box keeps its label', () => {
    const html = sensitive();
    expect(buttonsOf(tagOfBlock(html, 'edit-role-phone-bar'))).toEqual([
      'Cancel',
      'Save changes',
      'Tick “I understand” first.',
    ]);
    expect(tagOfBlock(html, 'edit-role-understand')).toContain('Sensitive.');
  });

  it('the box is the target: the check box of `Understand` carries the ref that EditRoleView holds, and the handler of both bars asks goToBox for exactly that element', () => {
    expect(elementsOf('SaveBar.tsx', 'button').map((button) => button.onClick)).toEqual([
      'onCancel',
      'onShowBox',
    ]);
    expect(declarationsOf('EditRoleView.tsx', 'understandBox')).toEqual([
      'useRef<HTMLInputElement>(null)',
    ]);
    expect(declarationsOf('EditRoleView.tsx', 'showBox')).toEqual([
      '() => goToBox(understandBox.current)',
    ]);
    expect(callsOf('EditRoleView.tsx', 'goToBox')).toEqual([['understandBox.current']]);
    const understand = elementsOf('EditRoleView.tsx', 'Understand');
    expect(understand).toHaveLength(1);
    expect(understand[0].boxRef).toBe('understandBox');
    const boxes = elementsOf('EditRoleParts.tsx', 'input');
    expect(boxes).toHaveLength(1);
    expect(boxes[0].ref).toBe('boxRef');
    // both bars are given the same handler: through the one `bar` they share
    expect(elementsOf('EditRoleView.tsx', 'SaveBar')).toHaveLength(2);
  });

  it('the hint reads its words from saveHint, and a plain hint is no button: the button is drawn under the decision of the pure function only', () => {
    expect(callsOf('SaveBar.tsx', 'saveHint')).toEqual([['needsBox']]);
    expect(declarationsOf('SaveBar.tsx', 'hint')).toEqual(['saveHint(needsBox)']);
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/SaveBar.tsx'),
      'utf8'
    );
    expect(source).toMatch(/hint\.kind === 'go-to-box'/);
  });
});

describe('Final review M3 the screen of a role: the names of the people who have the role wrap', () => {
  // Found while looking at M3 in the real browser (375 px): a person with a name of 78 letters and no space, listed under the name of the role, ran past the card and made the page scroll
  // sideways (`main` is 515 px wide in a 375 px window). The chip may not be wider than its line, and its text can break anywhere (the same two classes as the lists).
  const LONG = `Abcdefghij${'k'.repeat(110)}`;
  const chips = (html: string) =>
    [...tagOfBlock(html, 'edit-role-people').matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)]
      .map((m) => ({ classes: m[1].split(/\s+/), text: m[2] }))
      .filter((chip) => chip.classes.includes('rounded-full'));

  it('a chip is as wide as its line at the most, and its text can break anywhere', () => {
    const html = drawEditor(CLEAN, { people: [person(1, LONG, 'zk-cashier')] });
    const found = chips(html);
    expect(found.map((chip) => chip.text)).toEqual([LONG]);
    expect(found[0].classes).toEqual(
      expect.arrayContaining(['max-w-full', 'break-words', '[overflow-wrap:anywhere]'])
    );
  });

  it('the chips of ordinary names are as they were: a rounded chip each, in the order of the list', () => {
    const found = chips(drawEditor(CLEAN));
    expect(found.map((chip) => chip.text)).toEqual(['Anita Sharma', 'Imran Shaikh', 'Pooja Nair']);
    for (const chip of found)
      expect(chip.classes).toEqual(expect.arrayContaining(['rounded-full', 'border', 'text-xs']));
  });
});

// ================================================================================================ the password step

describe('Task 25 the password step as it is drawn', () => {
  const edit = roleEditOf(
    run(
      CLEAN,
      tick('cashbook_all', true),
      tick('bill_cancel', true),
      tick('payment_receive', false)
    ),
    CATALOGUE
  );

  it('the summary says who has the role, then Turning on (the sensitive ones marked) and Turning off', () => {
    const html = draw(RoleEditSummary, { edit, catalogue: CATALOGUE });
    expect(plain(html)).toBe(
      '3 people have this role. The change works on their very next click. Their screen reloads at once: anything they have not saved is lost. Turning on See the cash book for all days Cancel a bill Sensitive Turning off Receive payments and settle fine'
    );
    expect(html.match(/>Sensitive</g)).toHaveLength(1);
    expect(html).toMatch(/Turning on<\/b>/);
  });

  it('"Nothing" when no tick goes, and the new name and the changed description as lines', () => {
    const only = roleEditOf(
      run(
        CLEAN,
        tick('cashbook_all', true),
        { type: 'name', value: 'Till' },
        { type: 'description', value: 'x' }
      ),
      CATALOGUE
    );
    expect(plain(draw(RoleEditSummary, { edit: only, catalogue: CATALOGUE }))).toBe(
      '3 people have this role. The change works on their very next click. Their screen reloads at once: anything they have not saved is lost. Turning on See the cash book for all days Turning off Nothing New name: Till Description changed'
    );
  });

  it('a change of the name alone is only that line, and says nothing about access', () => {
    const nameOnly = roleEditOf(run(CLEAN, { type: 'name', value: 'Till' }), CATALOGUE);
    expect(plain(draw(RoleEditSummary, { edit: nameOnly, catalogue: CATALOGUE }))).toBe(
      '3 people have this role. New name: Till'
    );
  });

  it('in the dialog it is the password step of the pictures: the title, the summary, "Your password", "Confirm and save"', () => {
    const html = draw(ConfirmPasswordDialog, {
      title: roleEditTitle(edit),
      summary: createElement(RoleEditSummary, { edit, catalogue: CATALOGUE }),
      confirmLabel: roleEditConfirmLabel,
      onConfirm: async () => ({ error: null }),
      onClose: noop,
    });
    const words = plain(html);
    expect(words).toContain('Save changes to “Cashier”?');
    expect(words).toContain(
      '3 people have this role. The change works on their very next click. Their screen reloads at once: anything they have not saved is lost.'
    );
    expect(words).toContain('Turning on See the cash book for all days Cancel a bill Sensitive');
    expect(words).toContain('Turning off Receive payments and settle fine');
    expect(words).toContain('Your password');
    expect(words).toContain('Confirm and save');
    expect(words).toContain('We ask for your password every time you change who can do what.');
    expect(html).toMatch(/<input[^>]*type="password"/);
  });

  it('no sentence of the summary names a role key, a tick key or a stamp', () => {
    const html = draw(RoleEditSummary, { edit, catalogue: CATALOGUE });
    for (const hidden of [...TICK_KEYS, 'zk-cashier', STAMP])
      expect(html.includes(hidden), hidden).toBe(false);
  });
});

// ================================================================================================ the glue the other tests cannot reach

// There is no DOM here, so what a drawing cannot show (which handler is under which control, what is handed on to what, when the shell is told it is busy) is read from the syntax tree, as
// the Roles and People tests do.
const flat = (texts: string[][]) =>
  texts.map((args) => args.map((text) => text.replace(/\s+/g, ' ')));

describe('Task 25 the editor is wired', () => {
  it('each control of the page calls the action of its own', () => {
    const one = (tag: string) => elementsOf('EditRoleView.tsx', tag)[0];
    expect(one('TextField').onChange).toBe('on.name');
    expect(one('TextAreaField').onChange).toBe('on.description');
    expect(one('Understand').onChange).toBe('on.understood');
    expect(one('TickGroup').onToggle).toBe('on.toggle');
    expect(one('Notices').onReload).toBe('on.reload');
    expect(one('LeavePrompt')).toMatchObject({
      onLeave: 'on.leaveForGood',
      onKeep: 'on.keepEditing',
    });
    // the buttons: Back to roles is the page's, the others are the small parts' (Leave, Keep editing, Reload)
    expect(elementsOf('EditRoleView.tsx', 'button').map((button) => button.onClick)).toEqual([
      'on.leave',
    ]);
    expect(elementsOf('EditRoleParts.tsx', 'button').map((button) => button.onClick)).toEqual([
      'onLeave',
      'onKeep',
      'onReload',
    ]);
  });

  it('Save and Cancel of the bars call the actions, Save is off unless the screen says it works, and both bars get the same', () => {
    // Final review M5: the hint under Save is a button too, and goes to the box "I understand"
    expect(elementsOf('SaveBar.tsx', 'button').map((button) => button.onClick)).toEqual([
      'onCancel',
      'onShowBox',
    ]);
    const save = elementsOf('SaveBar.tsx', 'SaveButton');
    expect(save).toHaveLength(1);
    expect(save[0].onClick).toBe('onSave');
    expect(save[0].disabled).toBe('!canSave');
    // (the layout of the object is Prettier's: its text is compared with the white space folded)
    expect(
      declarationsOf('EditRoleView.tsx', 'bar').map((text) => text.replace(/\s+/g, ' '))
    ).toEqual([
      '{ canSave: info.canSave, needsBox, onCancel: on.leave, onSave: on.save, onShowBox: showBox, }',
    ]);
    expect(declarationsOf('EditRoleView.tsx', 'needsBox')).toEqual([
      'info.confirm.length > 0 && !info.understood',
    ]);
    expect(elementsOf('EditRoleView.tsx', 'SaveBar')).toHaveLength(2);
  });

  it('the password step is given the words of the edit and does the write with the reload the shell gave; the write is done once and its outcome decides', () => {
    expect(callsOf('EditRole.tsx', 'runRoleEdit')).toEqual([
      ['api', 'reload', 'confirming', 'password'],
    ]);
    expect(flat(callsOf('EditRole.tsx', 'settle'))).toEqual([
      ['await runRoleEdit(api, reload, confirming, password)', 'confirming'],
    ]);
    const dialog = elementsOf('EditRole.tsx', 'ConfirmPasswordDialog');
    expect(dialog).toHaveLength(1);
    expect(dialog[0]).toMatchObject({
      title: 'roleEditTitle(confirming)',
      confirmLabel: 'roleEditConfirmLabel',
      onConfirm: 'confirm',
      onClose: 'closeStep',
    });
    expect(dialog[0].summary.replace(/\s+/g, ' ')).toBe(
      '<RoleEditSummary edit={confirming} catalogue={ticks.ticks} />'
    );
  });

  it('what a save writes is made when Save is pressed, from the draft, and nothing is done when Save does not work', () => {
    expect(callsOf('EditRole.tsx', 'saveOf')).toEqual([['draft', 'ticks.ticks', 'roles']]);
    // the step is closed by its own Cancel and Escape (`closeStep`) and by an outcome that is not a refused password, and opened here with the edit
    expect(callsOf('EditRole.tsx', 'setConfirming')).toEqual([['null'], ['null'], ['edit']]);
    expect(conditionsAround('EditRole.tsx', 'setConfirming')).toEqual([[], [], []]);
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/EditRole.tsx'),
      'utf8'
    );
    const save = source.slice(source.indexOf('save: () => {'), source.indexOf('leave: () =>'));
    expect(save.indexOf('if (edit === null) return;')).toBeGreaterThan(save.indexOf('saveOf('));
    expect(save.indexOf('setConfirming(edit)')).toBeGreaterThan(save.indexOf('if (edit === null)'));
  });

  it('the editor tells the shell it is busy from one effect: with edits that are not saved or the password step open, and not busy when it goes away', () => {
    const effects = effectsCalling('EditRole.tsx', 'onBusy');
    expect(effects).toHaveLength(1);
    expect(effects[0].calls).toEqual([['busy']]);
    expect(effects[0].cleanup).toEqual([['false']]);
    expect(effects[0].deps).toBe('[busy, onBusy]');
    expect(declarationsOf('EditRole.tsx', 'busy')).toEqual([
      '!live.fixed && (info.dirty || confirming !== null)',
    ]);
    expect(callsOf('EditRole.tsx', 'onBusy')).toHaveLength(2);
  });

  it('reload and closing the tab ask first while there are edits that are not saved: one effect adds the listener under `shouldWarnOnUnload(info.dirty)`, and its cleanup removes the same listener (Task 24b)', () => {
    const adding = effectsCalling('EditRole.tsx', 'window.addEventListener');
    expect(adding).toHaveLength(1);
    expect(adding[0].calls).toEqual([["'beforeunload'", 'warnBeforeUnload']]);
    expect(adding[0].deps).toBe('[info.dirty]');
    const removing = effectsCalling('EditRole.tsx', 'window.removeEventListener');
    expect(removing).toHaveLength(1);
    expect(removing[0].calls).toEqual([]);
    expect(removing[0].cleanup).toEqual([["'beforeunload'", 'warnBeforeUnload']]);
    expect(removing[0].deps).toBe('[info.dirty]');
    // the decision is the pure function's, asked of what the screen counts as unsaved; the listener is added once, under it
    expect(callsOf('EditRole.tsx', 'shouldWarnOnUnload')).toEqual([['info.dirty']]);
    expect(callsOf('EditRole.tsx', 'window.addEventListener')).toHaveLength(1);
    expect(conditionsAround('EditRole.tsx', 'window.addEventListener')).toEqual([
      ['shouldWarnOnUnload(info.dirty)'],
    ]);
    // one effect holds both lines, so a listener that is added is a listener that is removed (on a change of `dirty` and when the editor goes away)
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/EditRole.tsx'),
      'utf8'
    );
    const effect =
      /useEffect\(\(\) => \{(?:(?!useEffect)[\s\S])*?\}, \[info\.dirty\]\);/.exec(source)?.[0] ??
      '';
    expect(effect).toContain("window.addEventListener('beforeunload', warnBeforeUnload)");
    expect(effect).toContain(
      "return () => window.removeEventListener('beforeunload', warnBeforeUnload)"
    );
    expect(effect.indexOf('removeEventListener')).toBeGreaterThan(
      effect.indexOf('addEventListener')
    );
  });

  it('a role that is not in the list takes her back from an effect', () => {
    const effects = effectsCalling('EditRole.tsx', 'onBack');
    expect(effects).toHaveLength(1);
    expect(effects[0].deps).toBe('[live, onBack]');
  });

  it('Reload reads the role itself and starts the draft again from what it read (not from a drawing of the lists), reads the lists for the rest of the screen, and a read that fails changes nothing but the alert (Task 24b)', () => {
    expect(callsOf('EditRole.tsx', 'readRoleAgain')).toEqual([['api', 'live.key']]);
    expect(callsOf('EditRole.tsx', 'readAgain')).toEqual([['reload']]);
    // the old way is gone: no round to count, no new Editor to wait for
    expect(callsOf('EditRole.tsx', 'onReloaded')).toEqual([]);
    expect(callsOf('EditRole.tsx', 'setRound')).toEqual([]);
    const editor = elementsOf('EditRole.tsx', 'Editor');
    expect(editor).toHaveLength(1);
    expect(editor[0].key).toBeUndefined();
    expect(editor[0].onReloaded).toBeUndefined();

    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/EditRole.tsx'),
      'utf8'
    );
    const start = source.indexOf('reload: async () => {');
    const handler = source.slice(start, source.indexOf('\n    },', start));
    expect(start).toBeGreaterThan(-1);
    const at = (text: string) => handler.indexOf(text);
    // read first: nothing of the screen is touched before the role has been read, and the draft is restarted exactly once
    expect(at('readRoleAgain(api, live.key)')).toBeGreaterThan(-1);
    expect(handler.slice(0, at('readRoleAgain('))).not.toMatch(
      /dispatch\(|setNotice\(|setLeaving\(/
    );
    expect(handler.match(/dispatch\(/g)).toHaveLength(1);
    // a failed read is the only thing that ends the handler early, and it touches the notice alone
    expect(at('if (fresh === null)')).toBeGreaterThan(at('readRoleAgain('));
    const failed = handler.slice(at('if (fresh === null)'), at('await readAgain(reload)'));
    expect(failed).toContain('readFailed: true');
    expect(failed).toContain('return;');
    for (const touched of ['dispatch(', 'setLeaving(', 'setConfirming(', 'readAgain('])
      expect(failed.includes(touched), touched).toBe(false);
    // then the lists, then the restart from what was read, and the question and the alert are put away
    expect(at('await readAgain(reload)')).toBeGreaterThan(at('return;'));
    expect(at("dispatch({ type: 'seed', role: fresh })")).toBeGreaterThan(
      at('await readAgain(reload)')
    );
    expect(at('setNotice(null)')).toBeGreaterThan(at("dispatch({ type: 'seed'"));
    expect(at('setLeaving(false)')).toBeGreaterThan(at("dispatch({ type: 'seed'"));
  });

  it('Leave goes back to the list at once when nothing is unsaved, and asks first when something is', () => {
    expect(declarationsOf('EditRole.tsx', 'on')).toHaveLength(1);
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/EditRole.tsx'),
      'utf8'
    );
    expect(source).toContain('leave: () => (info.dirty ? setLeaving(true) : onBack())');
    expect(source).toContain('leaveForGood: onBack');
  });

  it('the question "Leave without saving?" is asked by leaving with edits, and put away by any change, by Save, and by "Keep editing"', () => {
    expect(callsOf('EditRole.tsx', 'setLeaving')).toEqual([
      ['false'], // a change of the draft
      ['false'], // Save
      ['true'], // leave, when there are edits
      ['false'], // keep editing
      ['false'], // Reload starts again from the saved role
    ]);
  });

  it('a password that was refused stays on the step: the answer to the dialog is its sentence, and nothing else is done then', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/people-roles/components/EditRole.tsx'),
      'utf8'
    );
    const confirmBody = source.slice(
      source.indexOf('const confirm = async'),
      source.indexOf('const on: EditorActions')
    );
    expect(confirmBody).toContain('if (stepError !== null) return { error: stepError };');
    // everything that changes the page comes after that line
    for (const later of ['dispatch(action)', 'setNotice(next)', 'setConfirming(null)'])
      expect(confirmBody.indexOf(later), later).toBeGreaterThan(
        confirmBody.indexOf('if (stepError !== null)')
      );
  });

  it('every call of setNotice either keeps a refusal and clears "Saved." (a change), or sets the outcome, or clears it for a new save or a new start, or marks a Reload that could not read', () => {
    expect(flat(callsOf('EditRole.tsx', 'setNotice'))).toEqual([
      ["(now) => (now?.kind === 'saved' ? null : now)"],
      ['next'],
      ['null'],
      // Reload: a read that failed keeps the stale alert and adds the line about it; one that worked starts again with no alert
      ["(now) => (now?.kind === 'stale' ? { ...now, readFailed: true } : now)"],
      ['null'],
    ]);
  });

  it('the editor listens for no key of its own: only the password step does, so no second dialog closes with it; the one listener it adds is for the page being left', () => {
    for (const file of [
      'EditRole.tsx',
      'EditRoleView.tsx',
      'EditRoleParts.tsx',
      'TickGroup.tsx',
      'SaveBar.tsx',
      'RoleEditSummary.tsx',
    ]) {
      expect(callsOf(file, 'document.addEventListener'), file).toEqual([]);
      // Task 24b: `beforeunload` (a reload, closing the tab) is the only event the editor listens for, and it is not a key
      for (const [event] of callsOf(file, 'window.addEventListener'))
        expect(event, file).toBe("'beforeunload'");
    }
    expect(callsOf('EditRole.tsx', 'window.addEventListener')).toHaveLength(1);
    for (const file of ['EditRoleView.tsx', 'EditRoleParts.tsx', 'TickGroup.tsx', 'SaveBar.tsx'])
      expect(callsOf(file, 'window.addEventListener'), file).toEqual([]);
    // and the question "Leave without saving?" is a line, not a dialog
    expect(
      readFileSync(
        path.resolve(__dirname, '../../src/app/people-roles/components/EditRoleView.tsx'),
        'utf8'
      )
    ).not.toContain('role="dialog"');
  });

  it('the shell gives the editor the key it holds, the reload, its own way back, and the way to say it is busy; the Edit button gives the key of its role', () => {
    const editor = elementsOf('PeopleRolesClient.tsx', 'EditRole');
    expect(editor).toHaveLength(1);
    expect(editor[0]).toMatchObject({
      key: 'editing',
      roleKey: 'editing',
      reload: 'reload',
      onBusy: 'onBusy',
      onBack: 'onLeave',
    });
    expect(elementsOf('PeopleRolesClient.tsx', 'RolesTab')[0].onEdit).toBe(
      '(role) => onEdit(role.key)'
    );
    const view = elementsOf('PeopleRolesClient.tsx', 'PeopleRolesView')[0];
    expect(view).toMatchObject({
      editing: 'editing',
      onEdit: 'setEditing',
      onLeave: 'leave',
      onBusy: 'setBusy',
    });
  });

  it('the editor closes when a tab is chosen while the strip is free, and not while it is locked', () => {
    expect(callsOf('PeopleRolesClient.tsx', 'setEditing')).toEqual([['null'], ['null']]);
    // the first is "Back to roles"; the second is a press on a tab, and only when no body is busy
    expect(conditionsAround('PeopleRolesClient.tsx', 'setEditing')).toEqual([[], ['!busy']]);
  });

  it('the placeholder of Task 24 is gone: no TODO(task-...) marker is left in src', () => {
    const SRC = path.resolve(__dirname, '../../src');
    const left = sourcesUnder(SRC).filter((file) => /TODO\(task-/.test(readFileSync(file, 'utf8')));
    expect(left.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});

// ================================================================================================ no password can leak

describe('Task 25 no password can leak from the files of the screen', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const walked = sourcesUnder(path.join(SRC, 'app/people-roles')).map((file) =>
    path.relative(SRC, file)
  );
  const mine = [
    'app/people-roles/components/EditRole.tsx',
    'app/people-roles/components/EditRoleView.tsx',
    'app/people-roles/components/EditRoleParts.tsx',
    'app/people-roles/components/TickGroup.tsx',
    'app/people-roles/components/SaveBar.tsx',
    'app/people-roles/components/RoleEditSummary.tsx',
    'app/people-roles/lib/tickEdit.ts',
    'app/people-roles/lib/editorDraft.ts',
    'app/people-roles/lib/editWords.ts',
    'app/people-roles/lib/roleEdit.ts',
    'app/people-roles/lib/unloadGuard.ts',
  ];

  it('the files of this task are among the ones the tripwire walks (the Task 22 and 23 tests walk the whole folder)', () => {
    for (const wanted of mine) expect(walked, wanted).toContain(wanted);
  });

  it.each(mine)('%s', (name) => {
    expect(leaksOf(readFileSync(path.join(SRC, name), 'utf8'), name, PASSWORD_NAMES)).toEqual([]);
  });

  it('the password reaches the one call and nowhere else: the editor hands it to the writer, which puts it in the two bodies', () => {
    expect(callsOf('EditRole.tsx', 'runRoleEdit')[0][3]).toBe('password');
    const writer = readFileSync(path.join(SRC, 'app/people-roles/lib/roleEdit.ts'), 'utf8');
    expect(writer.match(/\bpassword,/g)).toHaveLength(2);
  });
});

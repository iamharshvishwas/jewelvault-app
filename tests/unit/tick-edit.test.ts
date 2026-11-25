// Access and roles (Task 25): the pure rules of the Edit role screen (plan: Task 25; DESIGN 6.2 "Needs" and 6.5), `src/app/people-roles/lib/tickEdit.ts`.
//   - toggleTick: turning a tick on turns on everything it needs (through the needs of those, too); turning one off is refused while another ticked tick needs it;
//   - lockedTicks: the ticks that cannot be turned off now, and the ticks that need them (the "Needed by ..." of the screen);
//   - changesOf: what differs from the saved set, in catalogue order; sensitiveToConfirm: the sensitive ticks that are newly on (the "I understand" box);
//   - groupedTicks: the ticks in the groups of the screen.
// The catalogue is the real one: the 32 ticks with the needs of the plan (tests/unit/support/tickCatalogue.ts). Nothing here draws anything.
//
// Run: npx vitest run tests/unit/tick-edit.test.ts
import { describe, expect, it } from 'vitest';
import {
  changesOf,
  groupedTicks,
  lockedTicks,
  sensitiveToConfirm,
  toggleTick,
} from '@/app/people-roles/lib/tickEdit';
import { TICK_KEYS, type TickKey } from '@/lib/access';
import type { SuperTicksResponse, TickInfo } from '@/lib/api/types';
import { PLAN_TICKS } from './support/access';
import { CATALOGUE, GROUPS, TICKS_RESPONSE, keysOf } from './support/tickCatalogue';

const NONE: ReadonlySet<TickKey> = new Set();
const setOf = (...keys: TickKey[]): ReadonlySet<TickKey> => new Set(keys);
const turnOn = (from: ReadonlySet<TickKey>, ...keys: TickKey[]) =>
  keys.reduce((now, key) => toggleTick(CATALOGUE, now, key, true), from);

// ================================================================================================ the fixture is the plan's table

describe('Task 25 the catalogue of the tests is the table of the plan', () => {
  it('has the 32 keys of the plan, in the order of the plan, in the six groups in screen order', () => {
    expect(CATALOGUE.map((tick) => tick.key)).toEqual([...PLAN_TICKS]);
    expect(CATALOGUE.map((tick) => tick.key)).toEqual([...TICK_KEYS]);
    expect(TICKS_RESPONSE.groups).toEqual([
      'Stock',
      'Photos',
      'Money',
      'Orders',
      'Records',
      'Shop',
    ]);
    // the ticks of a group are next to each other, groups in the order of the list
    expect([...new Set(CATALOGUE.map((tick) => tick.group))]).toEqual(GROUPS);
  });

  it('marks the twelve sensitive ticks of the plan, and no other', () => {
    expect(CATALOGUE.filter((tick) => tick.sensitive).map((tick) => tick.key)).toEqual([
      'secret_weight',
      'back_date',
      'bill_cancel',
      'bill_reissue',
      'payment_void',
      'refund_give',
      'opening_balance',
      'cash_over_limit',
      'order_closed_change',
      'activity_log',
      'download_all',
      'settings_change',
    ]);
  });

  it('gives the direct needs of the plan to the ticks the tests use (bill_reissue needs making bills too, ruling R21)', () => {
    const needs = (key: TickKey) => CATALOGUE.find((tick) => tick.key === key)?.needs;
    expect(needs('customer_edit')).toEqual(['customer_view']);
    expect(needs('cashbook_all')).toEqual(['cashbook_recent']);
    expect(needs('rate_correct')).toEqual(['rate_enter']);
    expect(needs('bill_make')).toEqual(['customer_view', 'bill_view']);
    expect(needs('bill_reissue')).toEqual(['customer_view', 'bill_view', 'bill_make']);
    expect(needs('cash_over_limit')).toEqual(['payment_receive']);
    expect(needs('order_edit')).toEqual(['order_view', 'customer_view']);
    expect(needs('activity_log')).toEqual([
      'secret_weight',
      'customer_view',
      'bill_view',
      'order_view',
    ]);
    // the other ticks need nothing: these fifteen are the ones of the table that name a need
    expect(CATALOGUE.filter((tick) => tick.needs.length > 0).map((tick) => tick.key)).toEqual([
      'cashbook_all',
      'customer_edit',
      'customer_archive',
      'bill_make',
      'payment_receive',
      'rate_correct',
      'bill_cancel',
      'bill_reissue',
      'payment_void',
      'refund_give',
      'opening_balance',
      'cash_over_limit',
      'order_edit',
      'activity_log',
      'download_all',
    ]);
  });
});

// ================================================================================================ the five rules of the brief

describe('Task 25 tickEdit: the rules of the screen', () => {
  it('turning on customer_edit also turns on customer_view; turning on activity_log also turns on secret_weight, customer_view, bill_view and order_view', () => {
    expect(keysOf(toggleTick(CATALOGUE, NONE, 'customer_edit', true))).toEqual([
      'customer_view',
      'customer_edit',
    ]);
    expect(keysOf(toggleTick(CATALOGUE, NONE, 'activity_log', true))).toEqual([
      'secret_weight',
      'customer_view',
      'bill_view',
      'order_view',
      'activity_log',
    ]);
  });

  it('customer_view is locked, and the lock names customer_edit, while customer_edit is on; turning customer_edit off frees it', () => {
    const on = toggleTick(CATALOGUE, NONE, 'customer_edit', true);
    const locked = lockedTicks(CATALOGUE, on);
    expect([...locked.keys()]).toEqual(['customer_view']);
    expect(locked.get('customer_view')?.map((tick) => tick.key)).toEqual(['customer_edit']);
    expect(locked.get('customer_view')?.map((tick) => tick.label)).toEqual([
      'Add and edit customers',
    ]);
    const off = toggleTick(CATALOGUE, on, 'customer_edit', false);
    expect(keysOf(off)).toEqual(['customer_view']);
    expect(lockedTicks(CATALOGUE, off).size).toBe(0);
    expect(keysOf(toggleTick(CATALOGUE, off, 'customer_view', false))).toEqual([]);
  });

  it('turning off a tick another ticked tick needs changes nothing', () => {
    const on = toggleTick(CATALOGUE, NONE, 'customer_edit', true);
    expect(toggleTick(CATALOGUE, on, 'customer_view', false)).toBe(on); // the very same set
    const log = toggleTick(CATALOGUE, NONE, 'activity_log', true);
    for (const needed of ['secret_weight', 'customer_view', 'bill_view', 'order_view'] as const)
      expect(toggleTick(CATALOGUE, log, needed, false), needed).toBe(log);
    // the tick that needs them can go, and then they are free one by one
    const freed = toggleTick(CATALOGUE, log, 'activity_log', false);
    expect(keysOf(freed)).toEqual(['secret_weight', 'customer_view', 'bill_view', 'order_view']);
    expect(keysOf(toggleTick(CATALOGUE, freed, 'secret_weight', false))).toEqual([
      'customer_view',
      'bill_view',
      'order_view',
    ]);
  });

  it('changesOf lists turnedOn and turnedOff in catalogue order; no difference gives two empty lists', () => {
    // sets are built in the opposite order of the catalogue on purpose
    const saved = setOf('order_view', 'customer_view', 'stock_add', 'bill_view');
    const now = setOf('settings_change', 'customer_view', 'bill_cancel', 'order_view', 'bill_view');
    expect(changesOf(saved, now)).toEqual({
      turnedOn: ['bill_cancel', 'settings_change'],
      turnedOff: ['stock_add'],
    });
    expect(changesOf(saved, saved)).toEqual({ turnedOn: [], turnedOff: [] });
    expect(changesOf(NONE, NONE)).toEqual({ turnedOn: [], turnedOff: [] });
    expect(changesOf(setOf('stock_add'), setOf('stock_add'))).toEqual({
      turnedOn: [],
      turnedOff: [],
    });
  });

  it('sensitiveToConfirm lists only sensitive ticks newly on; a sensitive tick already saved as on needs none; turning one on and off again needs none', () => {
    const saved = setOf('customer_view', 'bill_view', 'bill_cancel');
    // bill_cancel was saved as on; refund_give (sensitive) and order_view (not) are new
    const now = turnOn(saved, 'refund_give', 'order_view');
    const { turnedOn } = changesOf(saved, now);
    expect(turnedOn).toEqual(['refund_give', 'order_view']);
    expect(sensitiveToConfirm(CATALOGUE, turnedOn)).toEqual(['refund_give']);
    // bill_cancel is on both before and after: nothing to confirm
    expect(sensitiveToConfirm(CATALOGUE, changesOf(saved, saved).turnedOn)).toEqual([]);
    // turned on and off again: it is not different from the saved set any more
    const back = toggleTick(CATALOGUE, now, 'refund_give', false);
    expect(sensitiveToConfirm(CATALOGUE, changesOf(saved, back).turnedOn)).toEqual([]);
    // a non-sensitive tick alone needs none
    expect(sensitiveToConfirm(CATALOGUE, ['order_view', 'customer_edit'])).toEqual([]);
  });
});

// ================================================================================================ toggleTick in more detail

describe('Task 25 toggleTick', () => {
  it('turning a tick on pulls in its needs through the needs of those: cash_over_limit needs payment_receive, which needs customer_view and bill_view', () => {
    expect(keysOf(toggleTick(CATALOGUE, NONE, 'cash_over_limit', true))).toEqual([
      'customer_view',
      'bill_view',
      'payment_receive',
      'cash_over_limit',
    ]);
  });

  it('the catalogue as the API sends it: bill_reissue needs customer_view, bill_view and bill_make', () => {
    expect(keysOf(toggleTick(CATALOGUE, NONE, 'bill_reissue', true))).toEqual([
      'customer_view',
      'bill_view',
      'bill_make',
      'bill_reissue',
    ]);
    // and bill_make is locked by it, and so are customer_view and bill_view (by bill_make as well)
    const locked = lockedTicks(CATALOGUE, toggleTick(CATALOGUE, NONE, 'bill_reissue', true));
    expect(locked.get('bill_make')?.map((tick) => tick.key)).toEqual(['bill_reissue']);
    expect(locked.get('customer_view')?.map((tick) => tick.key)).toEqual([
      'bill_make',
      'bill_reissue',
    ]);
  });

  it('a need that two ticks share (a diamond) is turned on once and stays locked until both are off', () => {
    // top needs left and right; both need bottom
    const diamond: TickInfo[] = [
      {
        key: 'customer_view',
        group: 'G',
        label: 'Bottom',
        help: null,
        sensitive: false,
        needs: [],
      },
      {
        key: 'customer_edit',
        group: 'G',
        label: 'Left',
        help: null,
        sensitive: false,
        needs: ['customer_view'],
      },
      {
        key: 'customer_archive',
        group: 'G',
        label: 'Right',
        help: null,
        sensitive: false,
        needs: ['customer_view'],
      },
      {
        key: 'bill_make',
        group: 'G',
        label: 'Top',
        help: null,
        sensitive: false,
        needs: ['customer_edit', 'customer_archive'],
      },
    ];
    const all = toggleTick(diamond, NONE, 'bill_make', true);
    expect([...all].sort()).toEqual(
      ['bill_make', 'customer_archive', 'customer_edit', 'customer_view'].sort()
    );
    expect(all.size).toBe(4);
    const locked = lockedTicks(diamond, all);
    expect(locked.get('customer_view')?.map((tick) => tick.label)).toEqual(['Left', 'Right']);
    // nothing in the middle can go while the top is on
    expect(toggleTick(diamond, all, 'customer_edit', false)).toBe(all);
    // the top goes: left and right are free, the bottom is still needed by both
    const noTop = toggleTick(diamond, all, 'bill_make', false);
    expect(toggleTick(diamond, noTop, 'customer_view', false)).toBe(noTop);
    const noLeft = toggleTick(diamond, noTop, 'customer_edit', false);
    expect(toggleTick(diamond, noLeft, 'customer_view', false)).toBe(noLeft); // right still needs it
    const noRight = toggleTick(diamond, noLeft, 'customer_archive', false);
    expect([...toggleTick(diamond, noRight, 'customer_view', false)]).toEqual([]);
  });

  it('turning on something that is on (with its needs) changes nothing and gives the same set back', () => {
    const on = toggleTick(CATALOGUE, NONE, 'customer_edit', true);
    expect(toggleTick(CATALOGUE, on, 'customer_edit', true)).toBe(on);
    expect(toggleTick(CATALOGUE, on, 'customer_view', true)).toBe(on);
  });

  it('turning on a tick whose needs are not all on adds only what is missing, and keeps what was on', () => {
    const before = setOf('customer_view', 'stock_add');
    const after = toggleTick(CATALOGUE, before, 'customer_archive', true);
    expect(keysOf(after)).toEqual(['stock_add', 'customer_view', 'bill_view', 'customer_archive']);
  });

  it('turning off a tick that is already off changes nothing and gives the same set back', () => {
    const before = setOf('stock_add');
    expect(toggleTick(CATALOGUE, before, 'stock_edit', false)).toBe(before);
    expect(toggleTick(CATALOGUE, NONE, 'stock_edit', false)).toBe(NONE);
  });

  it('turning off a tick nothing needs removes just that one', () => {
    const before = setOf('stock_add', 'stock_edit', 'customer_view');
    expect(keysOf(toggleTick(CATALOGUE, before, 'stock_edit', false))).toEqual([
      'stock_add',
      'customer_view',
    ]);
  });

  it('never changes the set it is given', () => {
    const before = setOf('customer_view', 'stock_add');
    const copy = [...before];
    toggleTick(CATALOGUE, before, 'activity_log', true);
    toggleTick(CATALOGUE, before, 'stock_add', false);
    toggleTick(CATALOGUE, before, 'customer_view', false);
    expect([...before]).toEqual(copy);
  });

  it('a key the catalogue does not know is ignored, in either direction, and never a crash', () => {
    const before = setOf('customer_view');
    const unknown = 'zz_unknown' as TickKey;
    expect(toggleTick(CATALOGUE, before, unknown, true)).toBe(before);
    expect(toggleTick(CATALOGUE, before, unknown, false)).toBe(before);
  });

  it('an unknown key that a set already holds is left alone when it is turned off: the screen never touches what it cannot name', () => {
    const before = setOf('zz_old' as TickKey, 'customer_view');
    expect(toggleTick(CATALOGUE, before, 'zz_old' as TickKey, false)).toBe(before);
  });

  it('a need that the catalogue does not list is not added to the set', () => {
    const odd: TickInfo[] = [
      {
        key: 'customer_edit',
        group: 'G',
        label: 'Edit',
        help: null,
        sensitive: false,
        needs: ['zz_gone' as TickKey],
      },
    ];
    expect([...toggleTick(odd, NONE, 'customer_edit', true)]).toEqual(['customer_edit']);
  });

  it('a set that already holds a key nobody knows keeps it out of the way: the known ticks still work', () => {
    const before = setOf('zz_old' as TickKey, 'customer_view');
    const after = toggleTick(CATALOGUE, before, 'customer_edit', true);
    expect(keysOf(after)).toEqual(['customer_view', 'customer_edit']);
    expect(toggleTick(CATALOGUE, after, 'customer_view', false)).toBe(after);
  });

  it('a catalogue whose needs go round in a circle does not hang', () => {
    const circle: TickInfo[] = [
      {
        key: 'stock_add',
        group: 'G',
        label: 'A',
        help: null,
        sensitive: false,
        needs: ['stock_edit'],
      },
      {
        key: 'stock_edit',
        group: 'G',
        label: 'B',
        help: null,
        sensitive: false,
        needs: ['stock_add'],
      },
    ];
    expect([...toggleTick(circle, NONE, 'stock_add', true)].sort()).toEqual([
      'stock_add',
      'stock_edit',
    ]);
  });
});

// ================================================================================================ lockedTicks

describe('Task 25 lockedTicks', () => {
  it('nothing is locked when nothing needs anything', () => {
    expect(lockedTicks(CATALOGUE, NONE).size).toBe(0);
    expect(lockedTicks(CATALOGUE, setOf('stock_add', 'customer_view', 'bill_view')).size).toBe(0);
  });

  it('names every tick that needs the locked one, in catalogue order, with its words', () => {
    const on = turnOn(NONE, 'order_edit', 'customer_edit', 'activity_log');
    const locked = lockedTicks(CATALOGUE, on);
    expect(locked.get('customer_view')?.map((tick) => tick.key)).toEqual([
      'customer_edit',
      'order_edit',
      'activity_log',
    ]);
    expect(locked.get('order_view')?.map((tick) => tick.key)).toEqual([
      'order_edit',
      'activity_log',
    ]);
    expect(locked.get('bill_view')?.map((tick) => tick.key)).toEqual(['activity_log']);
    expect(locked.get('secret_weight')?.map((tick) => tick.label)).toEqual([
      CATALOGUE.find((tick) => tick.key === 'activity_log')?.label,
    ]);
    // the ticks that need others are not locked unless something needs them
    expect(locked.has('activity_log')).toBe(false);
    expect(locked.has('order_edit')).toBe(false);
  });

  it('locks only a tick that is on: a need that is off (a set that breaks a need) is not in the map', () => {
    const broken = setOf('customer_edit'); // customer_view is missing
    expect(lockedTicks(CATALOGUE, broken).size).toBe(0);
  });

  it('the Owner (every tick on) has every needed tick locked, and no other', () => {
    const everything = new Set<TickKey>(TICK_KEYS);
    const needed = new Set(CATALOGUE.flatMap((tick) => tick.needs));
    expect([...lockedTicks(CATALOGUE, everything).keys()].sort()).toEqual([...needed].sort());
  });

  it('the lock goes when the tick that needs it goes (agrees with toggleTick, for every tick)', () => {
    const everything = new Set<TickKey>(TICK_KEYS);
    for (const tick of CATALOGUE) {
      const locked = lockedTicks(CATALOGUE, everything).has(tick.key);
      const turnedOff = toggleTick(CATALOGUE, everything, tick.key, false);
      expect(turnedOff !== everything, tick.key).toBe(!locked);
    }
  });

  it('a key nobody knows in the set is ignored', () => {
    const on = setOf('zz_old' as TickKey, 'customer_edit', 'customer_view');
    expect([...lockedTicks(CATALOGUE, on).keys()]).toEqual(['customer_view']);
  });
});

// ================================================================================================ changesOf and sensitiveToConfirm

describe('Task 25 changesOf and sensitiveToConfirm in more detail', () => {
  it('a tick that is on in both is no change, a tick that is off in both is no change', () => {
    const both = setOf('stock_add', 'customer_view');
    expect(changesOf(both, both)).toEqual({ turnedOn: [], turnedOff: [] });
  });

  it('everything on to nothing on turns off all 32, in catalogue order', () => {
    const everything = new Set<TickKey>(TICK_KEYS);
    expect(changesOf(everything, NONE)).toEqual({ turnedOn: [], turnedOff: [...TICK_KEYS] });
    expect(changesOf(NONE, everything)).toEqual({ turnedOn: [...TICK_KEYS], turnedOff: [] });
  });

  it('keys nobody knows are ignored, whichever set holds them', () => {
    const old = 'zz_old' as TickKey;
    expect(changesOf(setOf(old, 'stock_add'), setOf('stock_add'))).toEqual({
      turnedOn: [],
      turnedOff: [],
    });
    expect(changesOf(setOf('stock_add'), setOf(old, 'stock_add'))).toEqual({
      turnedOn: [],
      turnedOff: [],
    });
  });

  it('does not change the sets it is given', () => {
    const saved = setOf('stock_add');
    const now = setOf('stock_edit');
    changesOf(saved, now);
    expect([...saved]).toEqual(['stock_add']);
    expect([...now]).toEqual(['stock_edit']);
  });

  it('sensitiveToConfirm answers in catalogue order whatever order it is given, and ignores unknown keys and an empty list', () => {
    expect(
      sensitiveToConfirm(CATALOGUE, ['settings_change', 'order_view', 'back_date', 'secret_weight'])
    ).toEqual(['secret_weight', 'back_date', 'settings_change']);
    expect(sensitiveToConfirm(CATALOGUE, ['zz_old' as TickKey])).toEqual([]);
    expect(sensitiveToConfirm(CATALOGUE, [])).toEqual([]);
  });

  it('turning on a tick that pulls in a sensitive need (activity_log needs secret_weight) lists both', () => {
    const now = toggleTick(CATALOGUE, NONE, 'activity_log', true);
    expect(sensitiveToConfirm(CATALOGUE, changesOf(NONE, now).turnedOn)).toEqual([
      'secret_weight',
      'activity_log',
    ]);
  });
});

// ================================================================================================ groupedTicks

describe('Task 25 groupedTicks: the ticks in the groups of the screen', () => {
  it('the six groups in the order of the list, the ticks of each in catalogue order', () => {
    const groups = groupedTicks(TICKS_RESPONSE);
    expect(groups.map((group) => group.name)).toEqual(GROUPS);
    expect(groups.map((group) => group.ticks.length)).toEqual([7, 1, 17, 3, 3, 1]);
    expect(groups.flatMap((group) => group.ticks.map((tick) => tick.key))).toEqual([...TICK_KEYS]);
  });

  it('follows the order of the list of groups, not the order of the ticks', () => {
    const shuffled: SuperTicksResponse = {
      groups: ['Shop', 'Stock'],
      ticks: CATALOGUE.filter((tick) => tick.group === 'Stock' || tick.group === 'Shop'),
    };
    expect(groupedTicks(shuffled).map((group) => group.name)).toEqual(['Shop', 'Stock']);
  });

  it('a tick whose group is not in the list is not lost: its group comes after the listed ones', () => {
    const extra: SuperTicksResponse = {
      groups: ['Stock'],
      ticks: [
        ...CATALOGUE.filter((tick) => tick.group === 'Stock'),
        { ...CATALOGUE[8], group: 'Later' },
      ],
    };
    const groups = groupedTicks(extra);
    expect(groups.map((group) => group.name)).toEqual(['Stock', 'Later']);
    expect(groups[1].ticks.map((tick) => tick.key)).toEqual(['customer_view']);
  });

  it('a group with no ticks is not drawn, a group named twice is drawn once', () => {
    const odd: SuperTicksResponse = {
      groups: ['Empty', 'Shop', 'Shop'],
      ticks: CATALOGUE.filter((tick) => tick.group === 'Shop'),
    };
    expect(groupedTicks(odd).map((group) => group.name)).toEqual(['Shop']);
    expect(groupedTicks({ groups: [], ticks: [] })).toEqual([]);
  });
});

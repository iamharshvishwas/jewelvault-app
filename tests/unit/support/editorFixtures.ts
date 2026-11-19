// Fixtures shared by the tests of the Edit role screen (plan: access and roles, Task 25): a role as the API lists it, the Cashier and a second role, three stamps in order, the nine ticks
// of today's Biller, and the two helpers that edit a draft the way the screen does. The role key is not the role name, on purpose: a key on screen would show.
//
//   role({ ... })        a role as listed (default: the Cashier, with the Biller's nine ticks, three people, the stamp STAMP)
//   run(draft, ...acts)  a draft after those actions;  tick(key, on)  the action of a tick box
import type { TickKey } from '@/lib/access';
import { draftReducer, type Draft, type DraftAction } from '@/app/people-roles/lib/editorDraft';
import type { SuperRole } from '@/lib/api/types';
import { CATALOGUE } from './tickCatalogue';

export const STAMP = '2026-11-19T07:41:12.123456Z';
export const AFTER_FIRST = '2026-11-19T08:02:55.654321Z';
export const AFTER_SECOND = '2026-11-19T08:03:10.000001Z';

export const BILLER_TICKS: TickKey[] = [
  'customer_view',
  'bill_view',
  'cashbook_recent',
  'customer_edit',
  'bill_make',
  'payment_receive',
  'rate_enter',
  'order_view',
  'order_edit',
];

export const role = (over: Partial<SuperRole> = {}): SuperRole => ({
  key: 'zk-cashier',
  name: 'Cashier',
  description: 'Makes bills and takes payments',
  active: true,
  fixed: false,
  ticks: BILLER_TICKS,
  people: 3,
  updated_at: STAMP,
  ...over,
});
export const CASHIER = role();
export const OTHER = role({
  key: 'zk-keeper',
  name: 'Stock Keeper',
  ticks: ['stock_add'],
  people: 1,
});
export const ROLES = [CASHIER, OTHER];

/** Applies actions to a draft, the way the screen does. */
export const run = (start: Draft, ...actions: DraftAction[]): Draft =>
  actions.reduce(draftReducer, start);
export const tick = (key: TickKey, on: boolean): DraftAction => ({
  type: 'tick',
  catalogue: CATALOGUE,
  key,
  on,
});

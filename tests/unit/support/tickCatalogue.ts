// The catalogue of ticks as `GET /v1/super/ticks` sends it (plan: access and roles, the table "The 32 ticks"; API Tasks 5, 12), typed in for the tests of the Edit role screen: the 32 keys in
// catalogue order, their group, which are sensitive and what each needs DIRECTLY (including the needs that rulings R16 to R21 added), and the four help texts of the plan. The words of a tick
// are `TICK_LABELS` of src/lib/access.ts, which tests/unit/activity-log.test.ts already holds to the table of the plan, verbatim.
//
//   CATALOGUE        the 32 ticks (TickInfo)
//   TICKS_RESPONSE   the answer of the call: the six groups in screen order, and the ticks
//   keysOf(set)      the keys of a set of ticks in catalogue order, as a list a test can compare
import { TICK_LABELS, type TickKey } from '@/lib/access';
import type { SuperTicksResponse, TickInfo } from '@/lib/api/types';

export const GROUPS = ['Stock', 'Photos', 'Money', 'Orders', 'Records', 'Shop'];

type Row = [key: TickKey, group: string, sensitive: boolean, needs: TickKey[], help?: string];

const ROWS: Row[] = [
  ['stock_add', 'Stock', false, []],
  ['stock_edit', 'Stock', false, [], 'Weights and labour rates are the price inputs.'],
  ['stock_status', 'Stock', false, []],
  ['category_add', 'Stock', false, []],
  ['category_edit', 'Stock', false, []],
  ['design_material', 'Stock', false, []],
  ['secret_weight', 'Stock', true, []],
  ['photo_rewrite', 'Photos', false, []],
  ['customer_view', 'Money', false, []],
  ['bill_view', 'Money', false, []],
  ['cashbook_recent', 'Money', false, []],
  ['cashbook_all', 'Money', false, ['cashbook_recent']],
  ['customer_edit', 'Money', false, ['customer_view']],
  ['customer_archive', 'Money', false, ['customer_view', 'bill_view']],
  [
    'bill_make',
    'Money',
    false,
    ['customer_view', 'bill_view'],
    'A bill that takes payment also needs "Receive payments and settle fine". Without that, the role can still save a bill that takes no payment.',
  ],
  ['payment_receive', 'Money', false, ['customer_view', 'bill_view']],
  [
    'rate_enter',
    'Money',
    false,
    [],
    'Today\'s rate only. Any other date also needs "Use a date other than today".',
  ],
  ['rate_correct', 'Money', false, ['rate_enter']],
  ['back_date', 'Money', true, []],
  ['bill_cancel', 'Money', true, ['customer_view', 'bill_view']],
  [
    'bill_reissue',
    'Money',
    true,
    ['customer_view', 'bill_view', 'bill_make'],
    'Without "Use a date other than today", only bills dated today can be re-issued (the new bill keeps the old date). Without "Receive payments and settle fine", the re-issue takes no new payment.',
  ],
  ['payment_void', 'Money', true, ['customer_view', 'bill_view']],
  ['refund_give', 'Money', true, ['customer_view', 'bill_view']],
  ['opening_balance', 'Money', true, ['customer_view', 'bill_view']],
  ['cash_over_limit', 'Money', true, ['payment_receive']],
  ['order_view', 'Orders', false, []],
  ['order_edit', 'Orders', false, ['order_view', 'customer_view']],
  ['order_closed_change', 'Orders', true, []],
  ['reports_open', 'Records', false, []],
  ['activity_log', 'Records', true, ['secret_weight', 'customer_view', 'bill_view', 'order_view']],
  ['download_all', 'Records', true, ['customer_view', 'bill_view']],
  ['settings_change', 'Shop', true, []],
];

export const CATALOGUE: TickInfo[] = ROWS.map(([key, group, sensitive, needs, help]) => ({
  key,
  group,
  label: TICK_LABELS[key],
  help: help ?? null,
  sensitive,
  needs,
}));

export const TICKS_RESPONSE: SuperTicksResponse = { groups: GROUPS, ticks: CATALOGUE };

/** The keys of a set in catalogue order (a set keeps the order things were added in; a test must not depend on that). */
export const keysOf = (set: ReadonlySet<TickKey>): TickKey[] =>
  CATALOGUE.map((tick) => tick.key).filter((key) => set.has(key));

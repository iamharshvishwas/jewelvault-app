// FB-F1 (FB-D8, Siddhi #13): the statuses of an order, their words, and which buttons the Order Book offers. Pure: no memory, no network, so the activity log and the screens share it.
//
// THE CHAIN (F-extra-2). The plan's chain is open -> in_progress -> ready -> delivered, and `cancelled` from any state that is not delivered; delivered -> cancelled is for the person who may change
// a closed order. The API of FB-E1 is looser: among open, in_progress and ready it allows any change, backward steps included, and a person who may change a closed order may reopen one. Whether
// the screen should offer a step back is an open question for Siddhi, so the screen offers only the forward step and Cancel, and the whole rule is the one table below: offering a step back is one
// line of it.
//
// WHO. What a person is offered follows their ticks (plan: access and roles, Task 20; DESIGN 6.2, O1 to O3). A change of an order is "Make and change orders" (`order_edit`), and any move out of a
// delivered or cancelled order is also "Change a delivered or cancelled order" (`order_closed_change`, the API's field right `change_closed_order`). The customer on an order is "See customers"
// (`customer_view`). The three roles of today are unchanged: the owner has all of it, the biller everything but the closed orders, staff the list only (tests/unit/money-access.test.ts).
import { can, type Holder } from './access';
import type { OrderStatus } from './api/types';

export type { OrderStatus } from './api/types';

/** The five statuses, in the order of the chain (the API's CHECK has the same five words). */
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'open',
  'in_progress',
  'ready',
  'delivered',
  'cancelled',
];

/** The words of the screen (and of the activity log) for each status. */
export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  ready: 'Ready',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** A delivered or cancelled order is closed: no new photo (F-extra-5), and only a person who may change a closed order (`order_closed_change`) may change its status on the API. */
export function isClosedOrder(status: OrderStatus): boolean {
  return status === 'delivered' || status === 'cancelled';
}

/** THE table of F-extra-2: from each status, the one forward step the screen offers, and whether Cancel is offered (to a person who may make that move: see `orderActions`). */
export const ORDER_CHAIN: Readonly<
  Record<OrderStatus, { next: OrderStatus | null; cancel: boolean }>
> = {
  open: { next: 'in_progress', cancel: true },
  in_progress: { next: 'ready', cancel: true },
  ready: { next: 'delivered', cancel: true },
  delivered: { next: null, cancel: true },
  cancelled: { next: null, cancel: false },
};

export interface OrderAction {
  to: OrderStatus;
  /** The button's words: `Mark Ready`, `Cancel order`. */
  label: string;
}

/**
 * The status buttons for an order: the forward step, then Cancel. A person who may not make and change orders (`order_edit`) gets none: they read the list only. Any move out of a delivered or
 * cancelled order needs the tick for a closed order as well (`order_closed_change`), so the biller has no button on one and the owner has Cancel on a delivered one.
 */
export function orderActions(status: OrderStatus, who: Holder | null): OrderAction[] {
  if (!can(who, 'order_edit')) return [];
  if (isClosedOrder(status) && !can(who, 'order_closed_change')) return [];
  const step = ORDER_CHAIN[status];
  const actions: OrderAction[] = [];
  if (step.next !== null)
    actions.push({ to: step.next, label: `Mark ${ORDER_STATUS_LABEL[step.next]}` });
  if (step.cancel) actions.push({ to: 'cancelled', label: 'Cancel order' });
  return actions;
}

/** What the Order Book gives a person besides the list (which every role reads, ruling A4). */
export interface OrderBookAccess {
  /** The New order button and form, the photo control of a card and the status buttons: "Make and change orders, add order photos" (`order_edit`). */
  edit: boolean;
  /** The customer's name and mobile on a card and in the search: "See customers" (`customer_view`). Without it the customer is not even looked up (F-extra-1). */
  customers: boolean;
}

export function orderBookAccess(who: Holder | null): OrderBookAccess {
  return { edit: can(who, 'order_edit'), customers: can(who, 'customer_view') };
}

// ------------------------------------------------------------------------------------------------ the days

/** The dashboard card lists an order due within this many days (today, tomorrow, the day after) or overdue (FB-D8). */
export const DUE_WITHIN_DAYS = 2;

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days since 1 January 1970 of a business date `YYYY-MM-DD`; null for anything else. Calendar arithmetic only: no clock and no time zone of the computer. */
function dayNumber(date: string): number | null {
  const m = BUSINESS_DATE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Days from `today` to `date` (both business dates): 0 today, 1 tomorrow, -3 three days late; null when either is not a date. */
export function daysUntil(today: string, date: string): number | null {
  const a = dayNumber(today);
  const b = dayNumber(date);
  return a === null || b === null ? null : b - a;
}

/** `Due today`, `Due tomorrow`, `Due in 2 days`, `Overdue by 3 days`. */
export function dueLabel(daysLeft: number): string {
  if (daysLeft === 0) return 'Due today';
  if (daysLeft === 1) return 'Due tomorrow';
  if (daysLeft > 1) return `Due in ${daysLeft} days`;
  const late = -daysLeft;
  return `Overdue by ${late} ${late === 1 ? 'day' : 'days'}`;
}

// What the Reports screen shows a person (plan: access and roles, Task 20; DESIGN 6.2: "Open Reports ... shows only what the person's data ticks allow"). The screen itself opens with the tick
// "Open Reports" (`reports_open`, SCREENS of src/lib/access.ts); each of its four tabs is shown for the data it is made from, so a person never meets a tab that would draw a figure they cannot
// read (a made-up zero) or ask the API for a book it refuses.
//
//   Inventory         the stock (designs and pieces): always on for everybody who is signed in.
//   Sales             the bills and their lines (V1, V5): "See bills, payments and customer ledgers" (`bill_view`).
//   Payments          the cash book of the month so far (V4: the whole cash book, `cashbook_all`: the cash book of two days, `cashbook_recent`, is not the month's), what is owed (V2) and the bills it
//                     is owed on (V1: `bill_view`), with the customer's name and mobile (`customer_view`).
//   Jewellery Metrics the weights, labour and piroi of the pieces sold: made from the lines of the bills (`bill_view`).
//
// Today only the owner opens the Reports (the biller and staff do not hold `reports_open`) and the owner holds every tick, so the owner has the four tabs, as before
// (tests/unit/money-access.test.ts).
//
// Plain functions with no state, so they run in plain Node. The screen calls it with a `Holder`, or null for a person who is not known (nobody gets a tab).
import { can, type Holder } from '@/lib/access';

/** Which tabs of the Reports a person gets. */
export interface ReportsAccess {
  inventory: boolean;
  sales: boolean;
  payments: boolean;
  jewellery: boolean;
}

export function reportsAccess(who: Holder | null): ReportsAccess {
  const bills = can(who, 'bill_view');
  return {
    inventory: who !== null,
    sales: bills,
    payments: bills && can(who, 'customer_view') && can(who, 'cashbook_all'),
    jewellery: bills,
  };
}

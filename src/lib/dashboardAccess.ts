// What the dashboard shows a person (plan: access and roles, Task 18; DESIGN 6.4: "Dashboard cards show only when their data tick is on"). Each block is shown for the tick or ticks of
// the data it reads and of the action it offers, so a person never meets a block that would draw a figure they cannot read (a made-up zero) or a button the API would refuse.
//
// The day-one rule rules over the data ticks. Today's Biller reads the bills, the customers and the cash book of two days, and yet sees none of the owner's blocks (tests/e2e/dashboard.spec.ts,
// login.spec.ts: no takings, no evening check, no health line, no rate card); so where the data tick alone would show an owner block to the Biller, one more tick that only the Owner holds is
// asked for: the analytics tick `reports_open` for the takings, the whole cash book (`cashbook_all`) for the evening check, the Correct tick (`rate_correct`) for the rate board. The three
// roles of today get exactly the blocks they got when the page tested the role key (tests/unit/dashboard-access.test.ts types that table in).
//
// A tile or a card that is a link is shown only to a person who may open where it goes (the Outstanding tile opens the customers' ledger, On Approval the billing screen), so no block leads a
// person to "Not available for your role".
//
// Plain functions with no state, so they run in plain Node. The page, the KPI grid and the tests call them with a `Holder`, or null for a person who is not known (nobody gets a block).
import { can, type Holder } from '@/lib/access';

/** Which blocks of the dashboard a person gets. The quick actions, the recent designs and the five stock tiles of the KPI grid are for everybody and are not in the list. */
export interface DashboardAccess {
  /** The owner's health line (the nightly check, the backups): reads the dashboard health, which is `activity_log`. */
  healthLine: boolean;
  /** The "Download everything" card: its button makes the download and records it, which is `download_all`. */
  downloadCard: boolean;
  /** The Daily Metal Rates card on the dashboard: the rate board of the person who enters and corrects rates. */
  rateCard: boolean;
  /** "Orders due": reads the orders (`order_view`). The customer's name on it is a second tick, `customer_view`, which the card asks for itself. */
  ordersPanel: boolean;
  /** "Payment pending over 60 days": the bills and the customers' names. */
  overduePanel: boolean;
  /** The evening check: today's Cash and UPI from the cash book, and the total outstanding. */
  eveningCheck: boolean;
  /** The two charts: the daily sales (bills) and the stock by category. */
  charts: boolean;
  /** The four panels at the foot: recent sales and pending payments (bills, with the customers' names), approvals and old stock. */
  activityPanels: boolean;
  /** The tiles of the KPI grid that show the takings: Today's Sales and Month Sales (bills). They open Reports. */
  salesTiles: boolean;
  /** The Outstanding tile of the KPI grid (the customers' balances, which are the bills). It opens the customers' ledger. */
  outstandingTile: boolean;
  /** The On Approval tile of the KPI grid: a stock figure that is in the owner's group of tiles. It opens the billing screen. */
  onApprovalTile: boolean;
}

export function dashboardAccess(who: Holder | null): DashboardAccess {
  const bills = can(who, 'bill_view');
  const customers = can(who, 'customer_view');
  const analytics = can(who, 'reports_open');
  // the takings need the bills (else every figure is a made-up zero) and the analytics tick (else the Biller would get them)
  const takings = bills && analytics;
  return {
    healthLine: can(who, 'activity_log'),
    downloadCard: can(who, 'download_all'),
    // the Biller holds `rate_enter` and enters today's rate on the billing screen (rates.spec.ts), never on the dashboard: the card is for the person who also corrects rates
    rateCard: can(who, 'rate_enter') && can(who, 'rate_correct'),
    ordersPanel: can(who, 'order_view'),
    overduePanel: bills && customers,
    // today's cash is within the cash book of two days the Biller reads; the whole cash book is what only the Owner holds. The outstanding on it is read from the bills
    eveningCheck: can(who, 'cashbook_all') && bills,
    charts: takings,
    activityPanels: takings && customers,
    salesTiles: takings,
    outstandingTile: takings && customers,
    onApprovalTile: analytics && can(who, 'bill_make'),
  };
}

// What the Customer Ledger shows a person (plan: access and roles, Task 20b, controller ruling T; DESIGN 6.2: "Customer Ledger opens with M1 (`customer_view`), its ledger part needs M2 (`bill_view`)").
//
//   list   the screen and the customers on it. A customer's name, mobile, address and GST number are the customer's own row ("See customers", `customer_view`, which is also the rule of the route in
//          SCREENS of src/lib/access.ts).
//   money  the money part: the figures of a card, its Ledger, Invoices and Payments tabs, the buttons that take or give money (Receive Payment, Hand Money Back, Opening Balance) and the one that prints the
//          ledger, the total outstanding in the header, the balance beside each name in the list, and the call that reads a customer's ledger when a card opens. All of it is made from the bills and the
//          balances ("See bills, payments and customer ledgers", `bill_view`), and the API refuses those reads to a role without it.
//
// A role with the customers and without the bills (a data-entry role: "Add and edit customers" needs only `customer_view`) opens the screen, sees the customers and the Add Customer button that
// `customer_edit` allows, and reads one sentence where the money would be. Nothing of the money part is drawn for it: not a zero (a made-up figure) and not a banner about a call that was never going to be
// allowed; and that call is not made. A role with the bills and without the customers cannot open the screen at all, as before.
//
// Plain functions with no state, so they run in plain Node. They take a `Holder`, or null for a person who is not signed in (nobody has either part).
import { can, type Holder } from './access';

export interface LedgerAccess {
  /** The screen and the customers' names: `customer_view`. */
  list: boolean;
  /** The money part: `bill_view`. */
  money: boolean;
}

export function ledgerAccess(who: Holder | null): LedgerAccess {
  return { list: can(who, 'customer_view'), money: can(who, 'bill_view') };
}

/** The one sentence a person without the money part reads where it would be. */
export const NO_MONEY = 'Your role cannot see the money part of the ledger.';

/**
 * Starts the reading of a customer's ledger (V3, `GET /v1/customers/{id}/ledger`) when its card opens, for a person who may read the bills, and gives the way to stop it. For anybody else nothing is
 * asked of the server and there is nothing to stop. `watch` is the store's `watchCustomerLedger`: the page hands it over and never calls it itself, so that this is the one place that decides.
 */
export function startLedgerWatch(
  who: Holder | null,
  customerId: string,
  watch: (customerId: string) => () => void
): (() => void) | undefined {
  return ledgerAccess(who).money ? watch(customerId) : undefined;
}

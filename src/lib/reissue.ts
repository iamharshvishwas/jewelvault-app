// The billing screen in re-issue mode (spec K1, K6, X10, A4; task WEB11). A bill is never edited: the owner corrects a wrong bill by RE-ISSUING it, which cancels it and saves the corrected one
// in one step, the money already received moving to the new bill. The corrected bill is built on the billing screen, which starts from the bill it replaces:
//
//   - the lines come over exactly as they were saved, on the same pieces: the rate, the labour, the piroi, the other charges and the quantity as the TEXT the bill holds (nothing is worked
//     out again, so a line the owner does not touch is sent as it was), with the bill's own sale type, date, discount, additional charges and notes;
//   - the pieces of the old bill are Sold; the cancel in the same transaction frees them, so the screen lets them be scanned again (`freedByCancel`); no other Sold piece can be;
//   - the customer is the old bill's and cannot change (K6), so the screen shows it and sends none (buildReissueBody leaves it out);
//   - only the owner re-issues, and only a live estimate: for anything else the screen says why, in a sentence, and shows no form.
//
// This file reads memory (the stores) and makes no network call.
import { getBillFacts, getBillSource, getCustomers } from './appStore';
import {
  WALK_IN_ID,
  newBillingItem,
  type BillingItem,
  type LineContext,
  type SaleType,
} from './billing';
import { findSkuByCode } from './designStore';
import type { Customer } from './mockData';
import { PREVIEW_MODE } from './previewMode';
import { getDailyRates } from './settingsStore';

export interface ReissueReady {
  ok: true;
  billId: string;
  billNo: string;
  customerId: string;
  customerName: string;
  /** The customer to show; null is the walk-in. */
  customer: Customer | null;
  walkIn: boolean;
  saleType: SaleType;
  billDate: string;
  discount: string;
  additionalCharges: string;
  notes: string;
  items: BillingItem[];
  /** The pieces the old bill sold: the cancel frees them in the same transaction. */
  oldPieceIds: string[];
}

export interface ReissueRefused {
  ok: false;
  message: string;
  /** A bill the person can be taken to (the bill that replaced this one). */
  link: string | null;
}

export type ReissueSetup = ReissueReady | ReissueRefused;

const refused = (message: string, link: string | null = null): ReissueRefused => ({
  ok: false,
  message,
  link,
});

/** A blank for 0.00, the way a new bill's fields start. */
const blankIfZero = (text: string): string => (/[1-9]/.test(text) ? text : '');

/** What the billing screen starts from to correct `billId`, or the sentence that says why it cannot. `role` is the signed-in role. */
export function prepareReissue(billId: string, role: string | null): ReissueSetup {
  if (PREVIEW_MODE)
    return refused('Re-issuing needs the server, which this preview does not have.');
  if (role !== 'owner') return refused('Only the owner can re-issue an estimate.');
  const facts = getBillFacts(billId);
  const source = getBillSource(billId);
  if (!facts || !source) return refused('That estimate was not found.');
  if (facts.status === 'cancelled') {
    return facts.reissuedAs
      ? refused(
          `${facts.billNo} was already cancelled and re-issued as ${facts.reissuedAs.billNo}. A bill can be re-issued once; correct the new one if it is wrong.`,
          facts.reissuedAs.id
        )
      : refused(`${facts.billNo} was already cancelled, so it cannot be re-issued.`);
  }
  if (facts.docType !== 'estimate') {
    return refused(
      `${facts.billNo} is dues brought forward (an opening balance), not an estimate, so it cannot be re-issued. Cancel it and add a new opening balance.`
    );
  }

  const walkIn = source.bill.customer_id === WALK_IN_ID;
  let customer: Customer | null = null;
  let customerName = 'Walk-in Customer';
  if (!walkIn) {
    customer = getCustomers().find((c) => c.id === source.bill.customer_id) ?? null;
    if (!customer)
      return refused(
        'The customer of this estimate is archived or not available, so it cannot be re-issued.'
      );
    customerName = customer.name;
  }

  const saleType = source.bill.sale_type;
  const context: LineContext = {
    saleType,
    billDate: source.bill.bill_date,
    rates: getDailyRates(),
  };
  const items: BillingItem[] = [];
  for (const line of source.lines) {
    const found = findSkuByCode(line.sku_no);
    if (!found || found.sku.id !== line.sku_id)
      return refused(
        `The piece ${line.sku_no} of this estimate is not available on this screen, so it cannot be re-issued from here.`
      );
    const item = newBillingItem(found.sku, context, null);
    items.push({
      ...item,
      metalRate: line.metal_rate,
      // a Per Piece line has no labour of its own (R3): its rate field is the piece price and nothing is sent for labour
      labour: found.sku.sellingMethod === 'By Weight' ? line.labour_rate : item.labour,
      piroi: line.piroi,
      otherCharges: line.other_charges,
      quantity: String(line.quantity),
    });
  }

  return {
    ok: true,
    billId: source.bill.id,
    billNo: source.bill.bill_no,
    customerId: source.bill.customer_id,
    customerName,
    customer,
    walkIn,
    saleType,
    billDate: source.bill.bill_date,
    discount: blankIfZero(source.bill.discount),
    additionalCharges: blankIfZero(source.bill.additional_charges),
    notes: source.bill.notes ?? '',
    items,
    oldPieceIds: source.lines.map((line) => line.sku_id),
  };
}

/** May this piece be put on the corrected bill although it is Sold? Only when the bill being corrected sold it: the cancel frees it in the same transaction (X10). */
export function freedByCancel(
  setup: Pick<ReissueReady, 'oldPieceIds'>,
  piece: { id: string; status: string }
): boolean {
  return piece.status === 'Sold' && setup.oldPieceIds.includes(piece.id);
}

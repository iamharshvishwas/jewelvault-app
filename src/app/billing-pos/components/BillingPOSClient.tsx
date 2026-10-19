'use client';
import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import CustomerSearchPanel from './CustomerSearchPanel';
import ScanItemPanel, { type ScanResult } from './ScanItemPanel';
import BillingItemsTable from './BillingItemsTable';
import BillingSummaryPanel from './BillingSummaryPanel';
import RateGuardPanel from './RateGuardPanel';
import { addCustomer, forgetBillTry, getCustomers, getNextInvoiceNumber } from '@/lib/appStore';
import { usePricingCheck } from '@/lib/api/connection';
import { useSession } from '@/lib/authStore';
import {
  HELD_STATUSES,
  newBillingItem,
  previewBill,
  saleTypeAfterChoosing,
  withBillDate,
  withRates,
  withSaleType,
  type BillingItem,
  type HeldStatus,
  type LineContext,
  type SaleType,
  type SavedBill,
} from '@/lib/billing';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { findSkuByCode } from '@/lib/designStore';
import { REASON_MAX, REASON_MIN } from '@/lib/ownerActions';
import { PREVIEW_MODE } from '@/lib/previewMode';
import { isFirstBillOfTheDay, rateConfirmationNeeded } from '@/lib/rateGuard';
import { freedByCancel, prepareReissue, type ReissueReady, type ReissueSetup } from '@/lib/reissue';
import { businessToday, getDailyRates, getSettings } from '@/lib/settingsStore';
import type { Customer, Sku } from '@/lib/mockData';

export type { BillingItem };

/** The figures of a line the person can change; each is kept as the text that was typed (S3: no floating point on the way to the server). */
export type EditableField = 'metalRate' | 'labour' | 'piroi' | 'otherCharges' | 'quantity';

const SALE_TYPES: SaleType[] = ['Retail', 'Semi-Wholesale', 'Wholesale'];

const isHeld = (status: string): status is HeldStatus =>
  (HELD_STATUSES as readonly string[]).includes(status);

// The billing screen, and the same screen in RE-ISSUE mode (X10, WEB11): `/billing-pos?reissue=<bill id>` opens it with the lines of that bill in it, for the owner to correct. The
// customer is the old bill's and cannot change (K6); the pieces the old bill sold may be scanned again (the cancel frees them in the same transaction); the person gives a reason; Save
// sends the corrected bill to the old bill's re-issue instead of making a new bill, and the old bill is cancelled in the same step. For anyone but the owner, and for a bill that cannot
// be re-issued, the screen says why and shows no form.
export default function BillingPOSClient() {
  return (
    <Suspense
      fallback={<div className="jewel-card p-6 text-sm text-muted-foreground">Loading…</div>}
    >
      <BillingRoute />
    </Suspense>
  );
}

function BillingRoute() {
  const reissueId = useSearchParams().get('reissue');
  // a new key for each bill asked for: leaving re-issue mode (or choosing another bill) starts the screen afresh
  return <BillingEntry key={reissueId ?? 'new'} reissueId={reissueId} />;
}

function BillingEntry({ reissueId }: { reissueId: string | null }) {
  const session = useSession();
  // decided once, when the screen opens: after the re-issue is saved the old bill is cancelled, and the screen must stay on the saved bill
  const [setup] = useState<ReissueSetup | null>(() =>
    reissueId ? prepareReissue(reissueId, session.role) : null
  );
  if (setup && !setup.ok) {
    return (
      <div className="jewel-card p-8 text-center space-y-3">
        <h1 className="text-xl font-bold text-foreground">This estimate cannot be re-issued</h1>
        <p data-testid="reissue-refused" className="text-sm text-muted-foreground">
          {setup.message}
        </p>
        <div className="flex justify-center gap-2">
          {setup.link && (
            <Link href={`/estimate?id=${setup.link}`} className="btn-primary py-2 text-xs">
              View the new estimate
            </Link>
          )}
          <Link href="/estimate" className="btn-secondary py-2 text-xs">
            Back to Saved Estimates
          </Link>
        </div>
      </div>
    );
  }
  return <BillingScreen reissue={setup && setup.ok ? setup : null} />;
}

function BillingScreen({ reissue }: { reissue: ReissueReady | null }) {
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(reissue ? reissue.customer : null);
  const [items, setItems] = useState<BillingItem[]>(reissue ? reissue.items : []);
  const [discount, setDiscount] = useState(reissue ? reissue.discount : '');
  const [additionalCharges, setAdditionalCharges] = useState(
    reissue ? reissue.additionalCharges : ''
  );
  const [notes, setNotes] = useState(reissue ? reissue.notes : '');
  const [reissueReason, setReissueReason] = useState('');
  const [customers, setCustomers] = useState<Customer[]>(() => getCustomers());
  const [invoiceNumber, setInvoiceNumber] = useState(() => getNextInvoiceNumber());
  const [invoiceDate, setInvoiceDate] = useState(() =>
    reissue ? reissue.billDate : businessToday()
  );
  const [saleType, setSaleType] = useState<SaleType>(reissue ? reissue.saleType : 'Retail');
  // C5 (b), C6: a save is on its way (everything on the left is locked), and what the API answered (the bill is shown as saved only from then on)
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedBill | null>(null);
  const [problemSkuIds, setProblemSkuIds] = useState<string[]>([]);
  // each new sale starts the scan and summary panels afresh (their own messages, payments and prompts): they are keyed by this
  const [saleNo, setSaleNo] = useState(0);
  // WEB16: the day the person answered "are today's rates right?" for (confirmed them, or billed with them as they are); kept through New Sale, in memory only (C8)
  const [rateAnswer, setRateAnswer] = useState<string | null>(null);
  // the question depends on the daily rates and on whether a bill dated today exists: draw again when a poll or a save changes either
  useRowCacheVersion('daily-rates', 'bills');
  const session = useSession();
  const pricing = usePricingCheck();
  const billsAllowed = PREVIEW_MODE || pricing.state === 'match';

  useEffect(() => {
    const interval = setInterval(() => setCustomers(getCustomers()), 1000);
    return () => clearInterval(interval);
  }, []);

  const contextFor = (type: SaleType, date: string): LineContext => ({
    saleType: type,
    billDate: date,
    rates: getDailyRates(),
  });

  // WEB17 (R2): a rate that arrives or changes after a piece was scanned (the owner typed it on the rate card in another browser and a poll brought it) reaches the lines that are still on
  // their default: the line that waited for a rate has it, a stale rate gives way to the rate of today. A rate the person typed is left alone. Without this the question of WEB16 would
  // go away (a rate dated today exists) and the line would still carry the old rate. A bill that is being saved or has been saved keeps the figures it was sent with, and a re-issue keeps
  // the rates of the bill it corrects (they catch up when a failed save frees the screen). It is done while drawing, from the rates as text (React's way to answer a change of what the screen
  // reads, without a frame that shows the old rate; and a preview build, which makes a new array on every read, does not run this again and again).
  const ratesKey = getDailyRates()
    .map((r) => `${r.material}|${r.purity}|${r.rateDate}|${r.ratePerGram}`)
    .join(';');
  const [followedRates, setFollowedRates] = useState(ratesKey);
  if (followedRates !== ratesKey && !reissue && !busy && saved === null) {
    setFollowedRates(ratesKey);
    setItems((prev) => withRates(prev, contextFor(saleType, invoiceDate)) as BillingItem[]);
  }

  const addPiece = (sku: Sku, held: HeldStatus | null) => {
    setItems((prev) =>
      prev.some((item) => item.sku.id === sku.id)
        ? prev
        : [...prev, newBillingItem(sku, contextFor(saleType, invoiceDate), held)]
    );
  };

  const handleScanSku = (code: string): ScanResult => {
    const foundSku = findSkuByCode(code)?.sku;
    if (!foundSku) return { kind: 'refused', message: `SKU "${code}" not found.` };
    if (items.some((i) => i.sku.id === foundSku.id))
      return { kind: 'refused', message: 'This SKU is already on this bill.' };
    // R10: In Stock is billed; Reserved and On Approval only after the person has said so; nothing else ever. The API decides again when the bill is saved.
    // A re-issue (X10): a piece the bill being corrected sold is Sold now and is freed by the cancel in the same transaction, so it may be put on the corrected bill.
    if (foundSku.status === 'In Stock' || (reissue && freedByCancel(reissue, foundSku))) {
      addPiece(foundSku, null);
      return { kind: 'added' };
    }
    if (foundSku.status === 'Sold') {
      return {
        kind: 'refused',
        message: `This SKU is already sold: ${foundSku.skuNumber}. Please check the bill records.`,
      };
    }
    if (isHeld(foundSku.status)) {
      return {
        kind: 'confirm',
        message: `${foundSku.skuNumber} is ${foundSku.status}. Bill it anyway?`,
      };
    }
    return {
      kind: 'refused',
      message: `${foundSku.skuNumber} is ${foundSku.status} and cannot be billed.`,
    };
  };

  const handleAddHeld = (code: string) => {
    const foundSku = findSkuByCode(code)?.sku;
    if (foundSku && isHeld(foundSku.status)) addPiece(foundSku, foundSku.status);
  };

  const handleUpdateItem = (itemId: string, field: EditableField, value: string) => {
    setItems((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, [field]: value } : item))
    );
  };

  const handleRemoveItem = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    setProblemSkuIds([]);
  };

  const handleSaleTypeChange = (nextType: SaleType) => {
    if (nextType === saleType) return;
    setSaleType(nextType);
    setItems((prev) => withSaleType(prev, contextFor(nextType, invoiceDate)));
  };

  const handleDateChange = (date: string) => {
    setInvoiceDate(date);
    setItems((prev) => withBillDate(prev, contextFor(saleType, date)));
  };

  // R9: choosing a customer sets the sale type to the customer's, and the labour rate of every line follows it (T-A03, UNIT half)
  const handleSelectCustomer = (nextCustomer: Customer | null) => {
    setCustomer(nextCustomer);
    handleSaleTypeChange(saleTypeAfterChoosing(nextCustomer, saleType));
  };

  const handleNewSale = () => {
    if (reissue) {
      // leaving re-issue mode: a plain new sale (the route starts the screen afresh); before the bill is saved this is Discard and takes the owner back to the estimate
      router.push(saved ? '/billing-pos' : `/estimate?id=${reissue.billId}`);
      return;
    }
    forgetBillTry(); // the next bill is another action: a key of its own
    setSaleNo((n) => n + 1);
    setCustomer(null);
    setItems([]);
    setDiscount('');
    setAdditionalCharges('');
    setNotes('');
    setSaved(null);
    setProblemSkuIds([]);
    setInvoiceNumber(getNextInvoiceNumber());
    setInvoiceDate(businessToday());
  };

  // WEB16: "Confirm today's rates" wrote a rate dated today: the lines that still follow the default take it (a rate the person typed on a line is left alone)
  const handleRatesConfirmed = () => {
    setItems((prev) => withBillDate(prev, contextFor(saleType, invoiceDate)));
  };

  const handleCreateCustomer = async (data: Parameters<typeof addCustomer>[0]) => {
    const created = await addCustomer(data);
    setCustomers(getCustomers());
    return created;
  };

  const roundOffSetting = getSettings().estimate.roundOff;
  // C12: the live total is the same pricing.ts the API runs
  const preview = previewBill({ items, saleType, discount, additionalCharges, roundOffSetting });
  const locked = busy || saved !== null;
  const today = businessToday();
  // WEB16 (PLAN.md P3-T2): a rate not confirmed today asks for confirmation before the first bill of the day; Save waits for the answer, the lines stay editable
  const rateQuestions = locked
    ? []
    : rateConfirmationNeeded({
        items,
        rates: getDailyRates(),
        billDate: invoiceDate,
        today,
        firstBill: isFirstBillOfTheDay(today),
        answeredFor: rateAnswer,
      });
  const askingForRates = rateQuestions.length > 0;

  return (
    <div className="space-y-4">
      {!billsAllowed && (
        <div
          role="alert"
          data-testid="pricing-banner"
          data-state={pricing.state}
          className="rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
        >
          {pricing.state === 'unknown'
            ? 'Checking that this page and the server work out bills the same way. Saving bills is off until then.'
            : 'This page and the server do not work out bills the same way, so saving bills is switched off. Reload the page; if this stays, tell the owner.'}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {reissue ? `Re-issue ${reissue.billNo}` : 'New Estimate'}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {reissue ? 'Corrected estimate' : 'Estimate'} ·{' '}
            {invoiceDate
              ? new Date(`${invoiceDate}T00:00:00`).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-muted-foreground">
            Date
            <input
              type="date"
              value={invoiceDate}
              max={today}
              disabled={locked}
              onChange={(event) => handleDateChange(event.target.value)}
              className="input-field ml-2 w-36 py-1.5 text-xs"
            />
          </label>
          <div className="flex items-center bg-muted rounded-sm p-1">
            {SALE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                disabled={locked}
                onClick={() => handleSaleTypeChange(type)}
                aria-pressed={saleType === type}
                className={`px-3 py-1.5 rounded-sm text-xs font-semibold transition-colors ${
                  saleType === type
                    ? 'bg-card text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
          <span
            data-testid="bill-number"
            className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-full"
          >
            {saved ? `Saved · ${saved.billNo}` : `Draft · ${invoiceNumber}`}
          </span>
          <button
            onClick={handleNewSale}
            disabled={busy || (reissue !== null && saved !== null)}
            className="btn-ghost py-2 text-xs"
          >
            Discard
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
        {/* Left: Customer + Items. While a save runs, and once it has been saved, nothing here can be changed. */}
        <fieldset disabled={locked} className="xl:col-span-2 space-y-4 min-w-0">
          {reissue && (
            <div data-testid="reissue-banner" className="jewel-card p-4 space-y-2 border-amber-200">
              <p className="text-sm font-semibold text-foreground">
                You are correcting {reissue.billNo}
              </p>
              <p className="text-xs text-muted-foreground">
                Change what was wrong and save. {reissue.billNo} is cancelled and the corrected
                estimate replaces it; money already received moves to the new estimate and its
                pieces are put back and billed again. Nothing is edited in place.
              </p>
              <label className="text-xs font-semibold text-foreground block">
                Reason for the correction (required)
                <textarea
                  data-testid="reissue-reason"
                  value={reissueReason}
                  onChange={(event) => setReissueReason(event.target.value)}
                  placeholder={`${REASON_MIN} to ${REASON_MAX} characters`}
                  rows={2}
                  className="input-field resize-none text-sm mt-1.5 font-normal"
                />
              </label>
            </div>
          )}
          <CustomerSearchPanel
            customers={customers}
            selectedCustomer={customer}
            onSelectCustomer={handleSelectCustomer}
            locked={
              reissue
                ? { name: reissue.customerName, mobile: reissue.customer?.mobile ?? '' }
                : null
            }
            onCreateCustomer={handleCreateCustomer}
          />
          <ScanItemPanel key={saleNo} onScan={handleScanSku} onAddHeld={handleAddHeld} />
          {askingForRates && (
            <RateGuardPanel
              entries={rateQuestions}
              today={today}
              onConfirmed={handleRatesConfirmed}
              onAcknowledged={() => setRateAnswer(today)}
            />
          )}
          <BillingItemsTable
            items={items}
            preview={preview}
            saved={saved}
            problemSkuIds={problemSkuIds}
            onUpdateItem={handleUpdateItem}
            onRemoveItem={handleRemoveItem}
          />
        </fieldset>

        {/* Right: Summary */}
        <div className="xl:col-span-1">
          <BillingSummaryPanel
            key={saleNo}
            preview={preview}
            discount={discount}
            onDiscountChange={setDiscount}
            additionalCharges={additionalCharges}
            onAdditionalChargesChange={setAdditionalCharges}
            customer={customer}
            notes={notes}
            onNotesChange={setNotes}
            items={items}
            invoiceNumber={invoiceNumber}
            saleType={saleType}
            invoiceDate={invoiceDate}
            role={session.role}
            billsAllowed={billsAllowed}
            locked={locked || askingForRates}
            saved={saved}
            onBusyChange={setBusy}
            onSaved={setSaved}
            onProblemPieces={setProblemSkuIds}
            onNewSale={handleNewSale}
            reissue={
              reissue
                ? {
                    billId: reissue.billId,
                    billNo: reissue.billNo,
                    customerId: reissue.customerId,
                    walkIn: reissue.walkIn,
                    reason: reissueReason,
                  }
                : null
            }
          />
        </div>
      </div>
    </div>
  );
}

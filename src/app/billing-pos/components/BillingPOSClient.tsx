'use client';
import React, { useEffect, useState } from 'react';
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
  withSaleType,
  type BillingItem,
  type HeldStatus,
  type LineContext,
  type SaleType,
  type SavedBill,
} from '@/lib/billing';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { findSkuByCode } from '@/lib/designStore';
import { PREVIEW_MODE } from '@/lib/previewMode';
import { isFirstBillOfTheDay, rateConfirmationNeeded } from '@/lib/rateGuard';
import { businessToday, getDailyRates, getSettings } from '@/lib/settingsStore';
import type { Customer, Sku } from '@/lib/mockData';

export type { BillingItem };

/** The figures of a line the person can change; each is kept as the text that was typed (S3: no floating point on the way to the server). */
export type EditableField = 'metalRate' | 'labour' | 'piroi' | 'otherCharges' | 'quantity';

const SALE_TYPES: SaleType[] = ['Retail', 'Semi-Wholesale', 'Wholesale'];

const isHeld = (status: string): status is HeldStatus =>
  (HELD_STATUSES as readonly string[]).includes(status);

export default function BillingPOSClient() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [items, setItems] = useState<BillingItem[]>([]);
  const [discount, setDiscount] = useState('');
  const [additionalCharges, setAdditionalCharges] = useState('');
  const [notes, setNotes] = useState('');
  const [customers, setCustomers] = useState<Customer[]>(() => getCustomers());
  const [invoiceNumber, setInvoiceNumber] = useState(() => getNextInvoiceNumber());
  const [invoiceDate, setInvoiceDate] = useState(() => businessToday());
  const [saleType, setSaleType] = useState<SaleType>('Retail');
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
    if (foundSku.status === 'In Stock') {
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
          <h1 className="text-2xl font-bold text-foreground">New Estimate</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate ·{' '}
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
          <button onClick={handleNewSale} disabled={busy} className="btn-ghost py-2 text-xs">
            Discard
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
        {/* Left: Customer + Items. While a save runs, and once it has been saved, nothing here can be changed. */}
        <fieldset disabled={locked} className="xl:col-span-2 space-y-4 min-w-0">
          <CustomerSearchPanel
            customers={customers}
            selectedCustomer={customer}
            onSelectCustomer={handleSelectCustomer}
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
          />
        </div>
      </div>
    </div>
  );
}

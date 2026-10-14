'use client';
import React, { useState, useEffect } from 'react';
import CustomerSearchPanel from './CustomerSearchPanel';
import ScanItemPanel from './ScanItemPanel';
import BillingItemsTable from './BillingItemsTable';
import BillingSummaryPanel from './BillingSummaryPanel';
import { addCustomer, getCustomers, getNextInvoiceNumber } from '@/lib/appStore';
import { findSkuByCode } from '@/lib/designStore';
import { getSettings } from '@/lib/settingsStore';
import type { Customer, CustomerType, Sku } from '@/lib/mockData';

export interface BillingItem {
  id: string;
  sku: Sku;
  metalRate: number;
  labourAmount: number;
  labour: number;
  piroi: number;
  otherCharges: number;
  metalAmount: number;
  fineWeightDue: number;
  itemTotal: number;
  quantity: number;
}

type SaleType = CustomerType;

function labourRateForSaleType(sku: Sku, saleType: SaleType) {
  if (saleType === 'Wholesale') return sku.wholesaleLabour ?? sku.semiWholesaleLabour ?? sku.retailLabour ?? sku.labour;
  if (saleType === 'Semi-Wholesale') return sku.semiWholesaleLabour ?? sku.wholesaleLabour ?? sku.retailLabour ?? sku.labour;
  return sku.retailLabour ?? sku.labour;
}

function calculateLabourAmount(sku: Sku, labourRate: number, quantity: number) {
  if (sku.sellingMethod === 'Per Piece') return 0;
  return sku.sellingMethod === 'By Weight'
    ? sku.customerNetWeight * labourRate
    : quantity * labourRate;
}

function calculateFineWeightDue(sku: Sku, quantity: number, saleType: SaleType) {
  if (saleType !== 'Wholesale' || sku.material !== 'Silver') return 0;
  return sku.customerNetWeight * quantity;
}

function calculateMetalAmount(sku: Sku, metalRate: number, quantity: number, saleType: SaleType) {
  if (calculateFineWeightDue(sku, quantity, saleType) > 0) return 0;
  return sku.sellingMethod === 'By Weight'
    ? sku.customerNetWeight * metalRate
    : metalRate * quantity;
}

function calculateItemTotal(item: Omit<BillingItem, 'itemTotal'>) {
  return item.metalAmount + item.labourAmount + item.piroi + item.otherCharges;
}

export default function BillingPOSClient() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [items, setItems] = useState<BillingItem[]>([]);
  const [discount, setDiscount] = useState(0);
  const [additionalCharges, setAdditionalCharges] = useState(0);
  const [notes, setNotes] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [saleType, setSaleType] = useState<SaleType>('Retail');

  useEffect(() => {
    setCustomers(getCustomers());
    setInvoiceNumber(getNextInvoiceNumber());
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    const interval = setInterval(() => setCustomers(getCustomers()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleScanSku = (skuNumber: string) => {
    const found = findSkuByCode(skuNumber);
    const foundSku: Sku | undefined = found?.sku;

    if (!foundSku) {
      alert(`SKU "${skuNumber}" not found`);
      return;
    }

    if (foundSku.status === 'Sold') {
      alert(`⚠️ THIS SKU IS ALREADY SOLD\n\nSKU: ${foundSku.skuNumber}\nPlease check the invoice records.`);
      return;
    }

    const exists = items.find((i) => i.sku.id === foundSku!.id);
    if (exists) {
      alert('This SKU is already on this invoice.');
      return;
    }

    const estimateSettings = getSettings().estimate;
    const labourRate = labourRateForSaleType(foundSku, saleType);
    const defaultRate = foundSku.sellingMethod === 'Per Piece'
      ? labourRate
      : foundSku.material === 'Gold' ? estimateSettings.defaultGoldRate : estimateSettings.defaultSilverRate;
    const metalAmount = calculateMetalAmount(foundSku, defaultRate, 1, saleType);
    const fineWeightDue = calculateFineWeightDue(foundSku, 1, saleType);
    const labourAmount = calculateLabourAmount(foundSku, labourRate, 1);

    const newItem: BillingItem = {
      id: `bitem-${foundSku.id}`,
      sku: foundSku,
      metalRate: defaultRate,
      labourAmount,
      labour: labourRate,
      piroi: foundSku.piroi,
      otherCharges: 0,
      metalAmount,
      fineWeightDue,
      itemTotal: metalAmount + labourAmount + foundSku.piroi,
      quantity: 1,
    };

    setItems((prev) => [...prev, newItem]);
  };

  const handleUpdateItem = (itemId: string, field: keyof BillingItem, value: number) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const updated = { ...item, [field]: value };
        const rate = updated.metalRate;
        const metalAmount = calculateMetalAmount(updated.sku, rate, updated.quantity, saleType);
        updated.metalAmount = metalAmount;
        updated.fineWeightDue = calculateFineWeightDue(updated.sku, updated.quantity, saleType);
        updated.labourAmount = calculateLabourAmount(updated.sku, updated.labour, updated.quantity);
        updated.itemTotal = calculateItemTotal(updated);
        return updated;
      })
    );
  };

  const handleRemoveItem = (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
  };

  const handleSaleTypeChange = (nextType: SaleType) => {
    setSaleType(nextType);
    setItems((prev) =>
      prev.map((item) => {
        const labour = labourRateForSaleType(item.sku, nextType);
        const updated = { ...item, labour };
        if (updated.sku.sellingMethod === 'Per Piece') updated.metalRate = labour;
        updated.metalAmount = calculateMetalAmount(updated.sku, updated.metalRate, updated.quantity, nextType);
        updated.fineWeightDue = calculateFineWeightDue(updated.sku, updated.quantity, nextType);
        updated.labourAmount = calculateLabourAmount(updated.sku, labour, updated.quantity);
        updated.itemTotal = calculateItemTotal(updated);
        return updated;
      })
    );
  };

  const handleSelectCustomer = (nextCustomer: Customer | null) => {
    setCustomer(nextCustomer);
    if (nextCustomer?.customerType) handleSaleTypeChange(nextCustomer.customerType);
  };

  const handleNewSale = () => {
    setCustomer(null);
    setItems([]);
    setDiscount(0);
    setAdditionalCharges(0);
    setNotes('');
    setInvoiceNumber(getNextInvoiceNumber());
    setInvoiceDate(new Date().toISOString().slice(0, 10));
  };

  const handleCreateCustomer = (data: Parameters<typeof addCustomer>[0]) => {
    const created = addCustomer(data);
    setCustomers(getCustomers());
    return created;
  };

  const subtotal = items.reduce((a, i) => a + i.itemTotal, 0);
  const discountAmount = discount;
  const afterDiscount = subtotal - discountAmount + additionalCharges;
  const settings = getSettings();
  const gstPercent = 0;
  const gstAmount = 0;
  const grandTotal = afterDiscount + gstAmount;
  const roundOff = settings.estimate.roundOff ? Math.round(grandTotal) - grandTotal : 0;
  const finalTotal = grandTotal + roundOff;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">New Estimate</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate · {invoiceDate ? new Date(`${invoiceDate}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-muted-foreground">
            Date
            <input
              type="date"
              value={invoiceDate}
              onChange={(event) => setInvoiceDate(event.target.value)}
              className="input-field ml-2 w-36 py-1.5 text-xs"
            />
          </label>
          <div className="flex items-center bg-muted rounded-sm p-1">
            {(['Retail', 'Semi-Wholesale', 'Wholesale'] as SaleType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => handleSaleTypeChange(type)}
                className={`px-3 py-1.5 rounded-sm text-xs font-semibold transition-colors ${
                  saleType === type ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded-full">
            Draft · {invoiceNumber}
          </span>
          <button onClick={handleNewSale} className="btn-ghost py-2 text-xs">Discard</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
        {/* Left: Customer + Items */}
        <div className="xl:col-span-2 space-y-4">
          <CustomerSearchPanel
            customers={customers}
            selectedCustomer={customer}
            onSelectCustomer={handleSelectCustomer}
            onCreateCustomer={handleCreateCustomer}
          />
          <ScanItemPanel onScan={handleScanSku} />
          <BillingItemsTable
            items={items}
            onUpdateItem={handleUpdateItem}
            onRemoveItem={handleRemoveItem}
          />
        </div>

        {/* Right: Summary */}
        <div className="xl:col-span-1">
          <BillingSummaryPanel
            subtotal={subtotal}
            discount={discount}
            onDiscountChange={setDiscount}
            additionalCharges={additionalCharges}
            onAdditionalChargesChange={setAdditionalCharges}
            gstPercent={gstPercent}
            gstAmount={gstAmount}
            roundOff={roundOff}
            finalTotal={finalTotal}
            customer={customer}
            notes={notes}
            onNotesChange={setNotes}
            itemCount={items.length}
            items={items}
            invoiceNumber={invoiceNumber}
            saleType={saleType}
            invoiceDate={invoiceDate}
            onNewSale={handleNewSale}
          />
        </div>
      </div>
    </div>
  );
}

'use client';

import { MOCK_CUSTOMERS, MOCK_INVOICES, MOCK_LEDGER, type Customer, type CustomerType, type Invoice, type LedgerEntry, type Payment } from './mockData';
import { getSettings } from './settingsStore';

const CUSTOMER_KEY = 'jaishri.customers.v1';
const INVOICE_KEY = 'jaishri.invoices.v1';
const LEDGER_KEY = 'jaishri.ledger.v1';

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStored<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;
  const saved = window.localStorage.getItem(key);
  if (!saved) return fallback;
  try {
    return JSON.parse(saved) as T;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T) {
  if (canUseStorage()) window.localStorage.setItem(key, JSON.stringify(value));
}

function persistAppStore() {
  writeStored(CUSTOMER_KEY, _customers);
  writeStored(INVOICE_KEY, _invoices);
  writeStored(LEDGER_KEY, _ledger);
}

function normalizeCustomer(customer: Customer): Customer {
  return {
    ...customer,
    customerType: customer.customerType ?? 'Retail',
    outstandingSilverFine: customer.outstandingSilverFine ?? 0,
  };
}

function normalizeInvoice(invoice: Invoice): Invoice {
  const fineWeightDue = invoice.fineWeightDue ?? invoice.items.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled = invoice.fineWeightSettled ?? Math.max(0, fineWeightDue - (invoice.fineWeightPending ?? fineWeightDue));
  return recalculateInvoice({
    ...invoice,
    saleType: invoice.saleType ?? 'Retail',
    amountDue: invoice.amountDue ?? invoice.grandTotal,
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending: Math.max(0, fineWeightDue - fineWeightSettled),
  });
}

function recalculateInvoice(invoice: Invoice): Invoice {
  const amountReceived = invoice.payments.reduce((total, payment) => total + payment.amount, 0);
  const pendingAmount = Math.max(0, invoice.grandTotal - amountReceived);
  const fineWeightDue = invoice.fineWeightDue ?? invoice.items.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled = invoice.fineWeightSettled ?? Math.max(0, fineWeightDue - (invoice.fineWeightPending ?? fineWeightDue));
  const fineWeightPending = Math.max(0, fineWeightDue - fineWeightSettled);
  const status: Invoice['status'] =
    pendingAmount <= 0 && fineWeightPending <= 0 ? 'Paid' : amountReceived > 0 || fineWeightSettled > 0 ? 'Partial' : 'Pending';
  return { ...invoice, amountReceived, pendingAmount, fineWeightDue, fineWeightSettled, fineWeightPending, amountDue: invoice.amountDue ?? invoice.grandTotal, status };
}

function recalculateCustomer(customerId: string) {
  const invoices = _invoices.filter((invoice) => invoice.customerId === customerId && invoice.status !== 'Cancelled');
  const totalPurchases = invoices.reduce((total, invoice) => total + invoice.grandTotal, 0);
  const outstandingSilverFine = invoices.reduce((total, invoice) => total + (invoice.fineWeightPending ?? 0), 0);
  const totalReceived = _ledger
    .filter((entry) => entry.customerId === customerId && entry.type === 'Payment')
    .reduce((total, entry) => total + entry.credit, 0);
  const lastPurchase = invoices
    .map((invoice) => invoice.date)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || '';

  _customers = _customers.map((customer) =>
    customer.id === customerId
      ? {
          ...customer,
          totalPurchases,
          totalReceived,
          outstanding: Math.max(0, totalPurchases - totalReceived),
          outstandingSilverFine,
          lastPurchase: lastPurchase || customer.lastPurchase,
        }
      : customer
  );
}

function recalculateLedgerBalances(customerId: string) {
  let balance = 0;
  let fineBalance = 0;
  _ledger = _ledger.map((entry) => {
    if (entry.customerId !== customerId) return entry;
    balance = balance + entry.debit - entry.credit;
    fineBalance = fineBalance + (entry.fineDebit ?? 0) - (entry.fineCredit ?? 0);
    return { ...entry, balance, fineBalance };
  });
}

// ── Customer Store ────────────────────────────────────────────────────────────

let _customers: Customer[] = readStored(CUSTOMER_KEY, [...MOCK_CUSTOMERS]).map(normalizeCustomer);
let _customerSeq = 1;

export function getCustomers(): Customer[] {
  return _customers;
}

export function addCustomer(data: Omit<Customer, 'id' | 'createdAt' | 'customerType' | 'totalPurchases' | 'totalReceived' | 'outstanding' | 'outstandingSilverFine' | 'lastPurchase'> & { customerType?: CustomerType }): Customer {
  const customer: Customer = {
    ...data,
    customerType: data.customerType ?? 'Retail',
    id: `cust-${Date.now()}-${_customerSeq++}`,
    createdAt: new Date().toISOString(),
    totalPurchases: 0,
    totalReceived: 0,
    outstanding: 0,
    outstandingSilverFine: 0,
    lastPurchase: new Date().toISOString(),
  };
  _customers = [customer, ..._customers];
  persistAppStore();
  return customer;
}

export function updateCustomer(id: string, updates: Partial<Customer>): void {
  _customers = _customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
  persistAppStore();
}

export function removeCustomer(id: string): void {
  _customers = _customers.filter((c) => c.id !== id);
  _invoices = _invoices.filter((invoice) => invoice.customerId !== id);
  _ledger = _ledger.filter((entry) => entry.customerId !== id);
  persistAppStore();
}

// ── Invoice Store ─────────────────────────────────────────────────────────────

let _invoices: Invoice[] = readStored(INVOICE_KEY, [...MOCK_INVOICES]).map(normalizeInvoice);
let _invoiceSeq = _invoices.length + 1;

export function getInvoices(): Invoice[] {
  return _invoices;
}

export function getInvoiceById(id: string): Invoice | undefined {
  return _invoices.find((invoice) => invoice.id === id || invoice.invoiceNumber === id);
}

export function getNextInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const seq = String(_invoiceSeq).padStart(4, '0');
  const prefix = getSettings().estimate.prefix || 'JV';
  return `${prefix}-${year}-${seq}`;
}

export function addInvoice(invoice: Invoice): void {
  if (_invoices.some((inv) => inv.invoiceNumber === invoice.invoiceNumber)) {
    throw new Error(`Invoice number already exists: ${invoice.invoiceNumber}`);
  }
  const normalizedInvoice = recalculateInvoice(invoice);
  _invoices = [normalizedInvoice, ..._invoices];
  _invoiceSeq++;

  // Update customer stats
  const customer = _customers.find((c) => c.id === normalizedInvoice.customerId);
  if (customer) {
    const received = normalizedInvoice.payments.reduce((a, p) => a + p.amount, 0);
    updateCustomer(normalizedInvoice.customerId, {
      totalPurchases: customer.totalPurchases + normalizedInvoice.grandTotal,
      totalReceived: customer.totalReceived + received,
      outstanding: customer.outstanding + normalizedInvoice.pendingAmount,
      outstandingSilverFine: (customer.outstandingSilverFine ?? 0) + (normalizedInvoice.fineWeightPending ?? 0),
      lastPurchase: normalizedInvoice.date,
    });
  }

  // Add ledger entry for invoice
  addLedgerEntry({
    customerId: normalizedInvoice.customerId,
    date: normalizedInvoice.date,
    type: 'Invoice',
    description: `Invoice ${normalizedInvoice.invoiceNumber} - ${normalizedInvoice.items.length} item(s)`,
    debit: normalizedInvoice.grandTotal,
    credit: 0,
    fineDebit: normalizedInvoice.fineWeightDue ?? 0,
    reference: normalizedInvoice.invoiceNumber,
    invoiceId: normalizedInvoice.id,
  });

  // Add ledger entries for payments
  for (const pmt of normalizedInvoice.payments) {
    if (pmt.amount > 0) {
      addLedgerEntry({
        customerId: normalizedInvoice.customerId,
        date: normalizedInvoice.date,
        type: 'Payment',
        description: `Payment via ${pmt.mode} against ${normalizedInvoice.invoiceNumber}`,
        debit: 0,
        credit: pmt.amount,
        reference: pmt.reference || normalizedInvoice.invoiceNumber,
        paymentId: pmt.id,
        invoiceId: normalizedInvoice.id,
      });
    }
  }

  recalculateCustomer(normalizedInvoice.customerId);
  persistAppStore();
}

export function updateInvoiceDate(invoiceId: string, date: string): void {
  const normalizedDate = date ? new Date(`${date}T12:00:00`).toISOString() : new Date().toISOString();
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) throw new Error('Estimate not found.');

  _invoices = _invoices.map((inv) => (inv.id === invoice.id ? { ...inv, date: normalizedDate } : inv));
  _ledger = _ledger.map((entry) => (entry.invoiceId === invoice.id || entry.reference === invoice.invoiceNumber ? { ...entry, date: normalizedDate } : entry));
  recalculateLedgerBalances(invoice.customerId);
  recalculateCustomer(invoice.customerId);
  persistAppStore();
}

export function updateInvoice(invoiceId: string, updates: Partial<Invoice>): Invoice {
  const current = getInvoiceById(invoiceId);
  if (!current) throw new Error('Estimate not found.');

  const mergedItems = (updates.items ?? current.items).map((item) => {
    const metalAmount = Number(item.metalAmount) || 0;
    const labour = Number(item.labour) || 0;
    const piroi = Number(item.piroi) || 0;
    const otherCharges = Number(item.otherCharges) || 0;
    return {
      ...item,
      grossWeight: Number(item.grossWeight) || 0,
      customerNetWeight: Number(item.customerNetWeight) || 0,
      metalRate: Number(item.metalRate) || 0,
      labour,
      piroi,
      otherCharges,
      metalAmount,
      fineWeightDue: Number(item.fineWeightDue) || 0,
      itemTotal: metalAmount + labour + piroi + otherCharges,
      taxRate: 0,
      taxAmount: 0,
    };
  });

  const subtotal = mergedItems.reduce((total, item) => total + item.itemTotal, 0);
  const discount = Number(updates.discount ?? current.discount) || 0;
  const additionalCharges = Number(updates.additionalCharges ?? current.additionalCharges) || 0;
  const beforeRoundOff = Math.max(0, subtotal - discount + additionalCharges);
  const roundOff = getSettings().estimate.roundOff ? Math.round(beforeRoundOff) - beforeRoundOff : 0;
  const fineWeightDue = mergedItems.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled = Math.min(current.fineWeightSettled ?? 0, fineWeightDue);
  const normalized = recalculateInvoice({
    ...current,
    ...updates,
    items: mergedItems,
    subtotal,
    discount,
    discountPercent: subtotal > 0 ? (discount / subtotal) * 100 : 0,
    additionalCharges,
    gst: 0,
    gstPercent: 0,
    roundOff,
    grandTotal: Math.round(beforeRoundOff + roundOff),
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending: Math.max(0, fineWeightDue - fineWeightSettled),
    amountDue: Math.round(beforeRoundOff + roundOff),
  });

  _invoices = _invoices.map((invoice) => (invoice.id === current.id ? normalized : invoice));
  _ledger = _ledger.filter((entry) => entry.invoiceId !== current.id && entry.reference !== current.invoiceNumber);

  addLedgerEntry({
    customerId: normalized.customerId,
    date: normalized.date,
    type: 'Invoice',
    description: `Invoice ${normalized.invoiceNumber} - ${normalized.items.length} item(s)`,
    debit: normalized.grandTotal,
    credit: 0,
    fineDebit: normalized.fineWeightDue ?? 0,
    reference: normalized.invoiceNumber,
    invoiceId: normalized.id,
  });

  for (const pmt of normalized.payments) {
    if (pmt.amount > 0) {
      addLedgerEntry({
        customerId: normalized.customerId,
        date: pmt.date,
        type: 'Payment',
        description: `Payment via ${pmt.mode} against ${normalized.invoiceNumber}`,
        debit: 0,
        credit: pmt.amount,
        reference: pmt.reference || normalized.invoiceNumber,
        paymentId: pmt.id,
        invoiceId: normalized.id,
      });
    }
  }

  recalculateLedgerBalances(current.customerId);
  if (normalized.customerId !== current.customerId) recalculateLedgerBalances(normalized.customerId);
  recalculateCustomer(current.customerId);
  if (normalized.customerId !== current.customerId) recalculateCustomer(normalized.customerId);
  persistAppStore();
  return normalized;
}

// ── Ledger Store ──────────────────────────────────────────────────────────────

let _ledger: LedgerEntry[] = readStored(LEDGER_KEY, [...MOCK_LEDGER]);
let _ledgerSeq = 1;

export function getLedger(): LedgerEntry[] {
  return _ledger;
}

export function getLedgerForCustomer(customerId: string): LedgerEntry[] {
  return _ledger.filter((e) => e.customerId === customerId);
}

export function addLedgerEntry(entry: Omit<LedgerEntry, 'id' | 'balance' | 'fineBalance'>): void {
  // Compute running balance for this customer
  const existing = _ledger.filter((e) => e.customerId === entry.customerId);
  const prevBalance = existing.length > 0 ? existing[existing.length - 1].balance : 0;
  const prevFineBalance = existing.length > 0 ? existing[existing.length - 1].fineBalance ?? 0 : 0;
  const balance = prevBalance + entry.debit - entry.credit;
  const fineBalance = prevFineBalance + (entry.fineDebit ?? 0) - (entry.fineCredit ?? 0);

  const newEntry: LedgerEntry = {
    ...entry,
    id: `ledger-${Date.now()}-${_ledgerSeq++}`,
    balance,
    fineBalance,
  };
  _ledger = [..._ledger, newEntry];
  persistAppStore();
}

// ── Payment Recording ─────────────────────────────────────────────────────────

export function recordPayment(customerId: string, payment: Omit<Payment, 'id'>, invoiceId?: string): void {
  const pmt: Payment = {
    ...payment,
    id: `pmt-${Date.now()}`,
  };

  // Update invoice if specified
  if (invoiceId) {
    _invoices = _invoices.map((inv) => {
      if (inv.id !== invoiceId) return inv;
      const newReceived = inv.amountReceived + pmt.amount;
      const newPending = Math.max(0, inv.grandTotal - newReceived);
      const newStatus: Invoice['status'] =
        newPending <= 0 ? 'Paid' : newReceived > 0 ? 'Partial' : 'Pending';
      return {
        ...inv,
        payments: [...inv.payments, pmt],
        amountReceived: newReceived,
        pendingAmount: newPending,
        status: newStatus,
      };
    });
  }

  // Update customer outstanding
  const customer = _customers.find((c) => c.id === customerId);
  if (customer) {
    updateCustomer(customerId, {
      totalReceived: customer.totalReceived + pmt.amount,
      outstanding: Math.max(0, customer.outstanding - pmt.amount),
    });
  }

  // Add ledger entry
  addLedgerEntry({
    customerId,
    date: pmt.date,
    type: 'Payment',
    description: `Payment received via ${pmt.mode}${pmt.notes ? ' — ' + pmt.notes : ''}`,
    debit: 0,
    credit: pmt.amount,
    reference: pmt.reference || '',
    paymentId: pmt.id,
    invoiceId,
  });

  persistAppStore();
}

export function settleSilverFine(
  customerId: string,
  grams: number,
  mode: 'Silver' | 'Cash',
  silverRate?: number,
  invoiceId?: string
): void {
  const fineCredit = Math.max(0, Number(grams) || 0);
  if (fineCredit <= 0) throw new Error('Fine grams must be greater than 0.');
  if (mode === 'Cash' && (!silverRate || silverRate <= 0)) throw new Error('Silver rate is required for cash fine settlement.');

  let remaining = fineCredit;
  const eligible = [..._invoices]
    .filter((invoice) => invoice.customerId === customerId && invoice.status !== 'Cancelled' && (invoice.fineWeightPending ?? 0) > 0)
    .sort((a, b) => {
      if (invoiceId && a.id === invoiceId) return -1;
      if (invoiceId && b.id === invoiceId) return 1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

  if (eligible.length === 0) throw new Error('No silver fine is pending for this customer.');

  for (const invoice of eligible) {
    if (remaining <= 0) break;
    const pendingFine = invoice.fineWeightPending ?? 0;
    const applied = Math.min(pendingFine, remaining);
    remaining -= applied;
    _invoices = _invoices.map((inv) =>
      inv.id === invoice.id
        ? recalculateInvoice({
            ...inv,
            fineWeightSettled: (inv.fineWeightSettled ?? 0) + applied,
            fineWeightPending: Math.max(0, (inv.fineWeightPending ?? 0) - applied),
          })
        : inv
    );
  }

  const settled = fineCredit - remaining;
  if (settled <= 0) throw new Error('Unable to apply silver fine settlement.');
  const amountEquivalent = mode === 'Cash' ? settled * (silverRate ?? 0) : 0;

  addLedgerEntry({
    customerId,
    date: new Date().toISOString(),
    type: 'Payment',
    description:
      mode === 'Cash'
        ? `Silver fine settled by cash - ${settled.toFixed(3)} g @ ₹${Number(silverRate).toLocaleString('en-IN')}/g`
        : `Silver fine received - ${settled.toFixed(3)} g`,
    debit: 0,
    credit: 0,
    fineCredit: settled,
    silverRate: mode === 'Cash' ? silverRate : undefined,
    reference: mode === 'Cash' ? `Fine cash equivalent ₹${Math.round(amountEquivalent).toLocaleString('en-IN')}` : 'Silver fine received',
    invoiceId,
  });

  recalculateLedgerBalances(customerId);
  recalculateCustomer(customerId);
  persistAppStore();
}

export function deleteRecordedPayment(ledgerEntryId: string): void {
  const entry = _ledger.find((item) => item.id === ledgerEntryId && item.type === 'Payment');
  if (!entry) throw new Error('Payment entry not found.');

  if ((entry.fineCredit ?? 0) > 0) {
    let remaining = entry.fineCredit ?? 0;
    const affected = [..._invoices]
      .filter((invoice) => invoice.customerId === entry.customerId && (entry.invoiceId ? invoice.id === entry.invoiceId : (invoice.fineWeightDue ?? 0) > 0))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    for (const invoice of affected) {
      if (remaining <= 0) break;
      const pending = invoice.fineWeightPending ?? 0;
      const due = invoice.fineWeightDue ?? 0;
      const canRestore = Math.max(0, due - pending);
      const restored = Math.min(canRestore, remaining);
      remaining -= restored;
      _invoices = _invoices.map((inv) =>
        inv.id === invoice.id
          ? recalculateInvoice({
              ...inv,
              fineWeightSettled: Math.max(0, (inv.fineWeightSettled ?? 0) - restored),
              fineWeightPending: pending + restored,
            })
          : inv
      );
    }
  }

  _invoices = _invoices.map((invoice) => {
    if (entry.invoiceId && invoice.id !== entry.invoiceId) return invoice;

    let removed = false;
    const payments = invoice.payments.filter((payment) => {
      const exactMatch = entry.paymentId && payment.id === entry.paymentId;
      const fallbackMatch =
        !entry.paymentId &&
        invoice.customerId === entry.customerId &&
        payment.amount === entry.credit &&
        payment.reference === entry.reference &&
        Math.abs(new Date(payment.date).getTime() - new Date(entry.date).getTime()) < 2000;

      if (!removed && (exactMatch || fallbackMatch)) {
        removed = true;
        return false;
      }
      return true;
    });

    return payments.length !== invoice.payments.length ? recalculateInvoice({ ...invoice, payments }) : invoice;
  });

  _ledger = _ledger.filter((item) => item.id !== ledgerEntryId);
  recalculateLedgerBalances(entry.customerId);
  recalculateCustomer(entry.customerId);
  persistAppStore();
}

// ── Dashboard Stats (computed) ────────────────────────────────────────────────

import { getDesigns } from './designStore';

export function computeDashboardStats() {
  const designs = getDesigns();
  const allSkus = designs.flatMap((d) => d.skus);

  const totalDesigns = designs.length;
  const totalSkus = allSkus.length;
  const inStock = allSkus.filter((s) => s.status === 'In Stock').length;
  const reserved = allSkus.filter((s) => s.status === 'Reserved').length;
  const onApproval = allSkus.filter((s) => s.status === 'On Approval').length;
  const sold = allSkus.filter((s) => s.status === 'Sold').length;

  const goldInStock = allSkus.filter((s) => s.material === 'Gold' && s.status === 'In Stock');
  const silverInStock = allSkus.filter((s) => s.material === 'Silver' && s.status === 'In Stock');
  const goldStockWeight = goldInStock.reduce((a, s) => a + s.customerNetWeight, 0);
  const silverStockWeight = silverInStock.reduce((a, s) => a + s.customerNetWeight, 0);

  const today = new Date().toISOString().slice(0, 10);
  const todayInvoices = _invoices.filter((inv) => inv.date.slice(0, 10) === today);
  const todaySales = todayInvoices.reduce((a, inv) => a + inv.grandTotal, 0);

  const monthStart = new Date();
  monthStart.setDate(1);
  const monthInvoices = _invoices.filter((inv) => new Date(inv.date) >= monthStart);
  const monthSales = monthInvoices.reduce((a, inv) => a + inv.grandTotal, 0);

  const totalOutstanding = _customers.reduce((a, c) => a + c.outstanding, 0);

  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const ageingOver90 = allSkus.filter(
    (s) => s.status === 'In Stock' && now - new Date(s.createdAt).getTime() > ninetyDaysMs
  ).length;

  return {
    totalDesigns,
    totalSkus,
    inStock,
    reserved,
    onApproval,
    sold,
    goldStockWeight,
    silverStockWeight,
    goldStockCount: goldInStock.length,
    silverStockCount: silverInStock.length,
    todaySales,
    monthSales,
    totalOutstanding,
    approvalDue: onApproval,
    ageingOver90,
  };
}

export function computePendingPayments() {
  const now = Date.now();
  return _invoices
    .filter((inv) => inv.pendingAmount > 0 && inv.status !== 'Cancelled')
    .map((inv) => ({
      id: inv.id,
      customerName: inv.customerName,
      mobile: inv.customerMobile,
      invoiceNumber: inv.invoiceNumber,
      amount: inv.pendingAmount,
      daysOld: Math.floor((now - new Date(inv.date).getTime()) / (1000 * 60 * 60 * 24)),
    }));
}

export function computeApprovalDue() {
  const designs = getDesigns();
  return designs.flatMap((d) =>
    d.skus
      .filter((s) => s.status === 'On Approval')
      .map((s) => ({
        id: s.id,
        customerName: '—',
        mobile: '—',
        skuNumber: s.skuNumber,
        designNumber: s.designNumber,
        issuedDate: s.createdAt.slice(0, 10),
        expectedReturn: '—',
        overdueDays: 0,
      }))
  );
}

export function computeAgeingStock() {
  const designs = getDesigns();
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return designs.flatMap((d) =>
    d.skus
      .filter((s) => s.status === 'In Stock' && now - new Date(s.createdAt).getTime() > ninetyDaysMs)
      .map((s) => ({
        id: s.id,
        designNumber: s.designNumber,
        skuNumber: s.skuNumber,
        category: d.category,
        material: s.material,
        days: Math.floor((now - new Date(s.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
        grossWeight: s.grossWeight,
      }))
  );
}

export function computeRecentActivity() {
  const activities: { id: string; type: string; description: string; time: string; amount: number }[] = [];

  const recentInvoices = [..._invoices]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3);

  for (const inv of recentInvoices) {
    activities.push({
      id: `act-inv-${inv.id}`,
      type: 'sale',
      description: `Invoice ${inv.invoiceNumber} — ${inv.customerName}`,
      time: new Date(inv.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      amount: inv.grandTotal,
    });
  }

  const recentDesigns = getDesigns().slice(0, 2);
  for (const d of recentDesigns) {
    activities.push({
      id: `act-design-${d.id}`,
      type: 'stock',
      description: `Design ${d.designNumber} added — ${d.skus.length} SKU(s)`,
      time: new Date(d.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      amount: 0,
    });
  }

  return activities.slice(0, 5);
}

export function computeCategoryStockData() {
  const designs = getDesigns();
  const categoryMap: Record<string, number> = {};
  for (const d of designs) {
    const inStock = d.skus.filter((s) => s.status === 'In Stock').length;
    if (inStock > 0) {
      categoryMap[d.category] = (categoryMap[d.category] || 0) + inStock;
    }
  }
  const COLORS = ['#D4A843', '#B8902E', '#9B7A28', '#7D6422', '#C4A030', '#E8C060', '#F0D080', '#A89020'];
  return Object.entries(categoryMap).map(([name, value], i) => ({
    name,
    value,
    fill: COLORS[i % COLORS.length],
  }));
}

export function computeMonthlySalesData() {
  const monthMap: Record<string, { goldSales: number; silverSales: number }> = {};
  for (const inv of _invoices) {
    const month = new Date(inv.date).toLocaleString('en-IN', { month: 'short', year: '2-digit' });
    if (!monthMap[month]) monthMap[month] = { goldSales: 0, silverSales: 0 };
    for (const item of inv.items) {
      if (item.material === 'Gold') monthMap[month].goldSales += item.itemTotal;
      else monthMap[month].silverSales += item.itemTotal;
    }
  }
  return Object.entries(monthMap).map(([month, data]) => ({ month, ...data }));
}

export function computeCategorySalesData() {
  const catMap: Record<string, { count: number; value: number }> = {};
  for (const inv of _invoices) {
    for (const item of inv.items) {
      if (!catMap[item.category]) catMap[item.category] = { count: 0, value: 0 };
      catMap[item.category].count += 1;
      catMap[item.category].value += item.itemTotal;
    }
  }
  return Object.entries(catMap).map(([category, data]) => ({ category, ...data }));
}

export function computePaymentModeData() {
  const modeMap: Record<string, number> = {};
  for (const inv of _invoices) {
    for (const pmt of inv.payments) {
      modeMap[pmt.mode] = (modeMap[pmt.mode] || 0) + pmt.amount;
    }
  }
  const total = Object.values(modeMap).reduce((a, v) => a + v, 0);
  const COLORS: Record<string, string> = {
    Cash: '#22c55e',
    UPI: '#3b82f6',
    Card: '#8b5cf6',
    'Bank Transfer': '#f59e0b',
    Credit: '#ef4444',
    Other: '#94a3b8',
  };
  return Object.entries(modeMap).map(([mode, amount]) => ({
    mode,
    value: total > 0 ? Math.round((amount / total) * 100) : 0,
    amount,
    fill: COLORS[mode] || '#94a3b8',
  }));
}

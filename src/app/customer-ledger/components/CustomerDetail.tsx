'use client';

import React, { useEffect, useState } from 'react';
import {
  CreditCard,
  Mail,
  MapPin,
  Phone,
  RotateCcw,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import {
  deleteRecordedPayment,
  getBillsOfCustomer,
  getCustomerBooks,
  getLedgerForCustomer,
  removeCustomer,
} from '@/lib/appStore';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  balanceShown,
  fineBalanceShown,
  gramsShown,
  isPaymentEntry,
  rupeesShown,
  voidedReceipts,
} from '@/lib/ledgerView';
import type { Customer, LedgerEntry } from '@/lib/mockData';
import { PREVIEW_MODE } from '@/lib/previewMode';
import CustomerInvoiceList from './CustomerInvoiceList';
import CustomerLedgerTable from './CustomerLedgerTable';
import ReceivePaymentPanel from './ReceivePaymentPanel';

// The customer card (task WEB10). In a real build every figure on it is the customer's row of V2 (customer_balances) in memory: outstanding, advance, balance and the silver, written the same
// way as on the estimate and in the ledger (src/lib/ledgerView.ts), so that the last running balance of the ledger below IS the card's balance (I4). The bills are the customer's rows of V1,
// the ledger is V3 as the server sent it. The screen is drawn again when memory changes (a poll, a payment of this browser); the ledger, which is read from the server after the card opens and
// again after a change, has no event of its own, so it is looked at once a second and drawn again only when it is another ledger.
// The prototype's Delete buttons exist in a preview build only: a bill, a payment and a customer are never deleted on the API (a payment is voided, WEB11).

const TABS = [
  { id: 'ctab-ledger', label: 'Ledger' },
  { id: 'ctab-invoices', label: 'Invoices' },
  { id: 'ctab-payments', label: 'Payments' },
];

// what the card reads: the customer, the bills and the receipts behind the figures (src/lib/appStore.ts)
const BOOKS = [
  'users',
  'customers',
  'customer-balances',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
] as const;

const sameEntries = (a: readonly LedgerEntry[], b: readonly LedgerEntry[]): boolean =>
  a === b || (a.length === b.length && a.every((entry, i) => entry === b[i]));

interface CustomerDetailProps {
  customer: Customer;
  onDeleted?: () => void;
}

export default function CustomerDetail({ customer, onDeleted }: CustomerDetailProps) {
  const [activeTab, setActiveTab] = useState('ctab-ledger');
  const [showPaymentPanel, setShowPaymentPanel] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>(() => getLedgerForCustomer(customer.id));

  useRowCacheVersion(...BOOKS);

  useEffect(() => {
    const look = () => {
      const next = getLedgerForCustomer(customer.id);
      setLedger((before) => (sameEntries(before, next) ? before : next));
    };
    const timer = setInterval(look, 1000);
    return () => clearInterval(timer);
  }, [customer.id]);

  // every bill of the customer, the newest first: the dues brought forward and the cancelled ones too (their pending adds up to the outstanding of the card)
  const invoices = getBillsOfCustomer(customer.id).reverse();
  const books = getCustomerBooks(customer.id);

  const handleDeletePayment = (entry: LedgerEntry) => {
    const label =
      (entry.fineCredit ?? 0) > 0
        ? `${entry.fineCredit?.toFixed(3)} g fine settlement`
        : rupeesShown(entry.credit);
    if (!window.confirm(`Delete payment of ${label}? This will recalculate outstanding balance.`))
      return;
    try {
      deleteRecordedPayment(entry.id);
      setLedger(getLedgerForCustomer(customer.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to delete payment.');
    }
  };

  const handleDeleteCustomer = () => {
    const linkedCount = invoices.length + ledger.length;
    const warning =
      linkedCount > 0
        ? ` This will also remove ${invoices.length} estimate(s) and ${ledger.length} ledger entr${ledger.length === 1 ? 'y' : 'ies'}.`
        : '';
    if (!window.confirm(`Delete customer "${customer.name}"?${warning} This cannot be undone.`))
      return;
    removeCustomer(customer.id);
    onDeleted?.();
  };

  const voided = voidedReceipts(ledger);
  const paymentEntries = ledger.filter(isPaymentEntry);
  const owes = customer.outstanding > 0;
  const fineOwed = (customer.outstandingSilverFine ?? 0) > 0;
  // the extra figures of V2 that the prototype's card did not have: while the customer's row has not arrived they are blank, never made up
  const holds = books ? Number(books.advance) > 0 : false;
  const stats = [
    {
      id: 'cs-purchases',
      label: 'Total Purchases',
      value: rupeesShown(customer.totalPurchases),
      icon: <TrendingUp size={14} className="text-blue-600" />,
      color: 'bg-blue-50',
    },
    {
      id: 'cs-received',
      label: 'Amount Received',
      value: rupeesShown(customer.totalReceived),
      icon: <TrendingUp size={14} className="text-emerald-600" />,
      color: 'bg-emerald-50',
    },
    {
      id: 'cs-outstanding',
      label: 'Outstanding',
      value: rupeesShown(customer.outstanding),
      icon: <TrendingDown size={14} className={owes ? 'text-amber-600' : 'text-emerald-600'} />,
      color: owes ? 'bg-amber-50' : 'bg-emerald-50',
    },
    ...(PREVIEW_MODE
      ? []
      : [
          {
            id: 'cs-advance',
            label: 'Advance',
            value: books ? rupeesShown(Number(books.advance)) : '-',
            icon: (
              <Wallet size={14} className={holds ? 'text-emerald-600' : 'text-muted-foreground'} />
            ),
            color: holds ? 'bg-emerald-50' : 'bg-muted',
          },
          {
            id: 'cs-balance',
            label: 'Balance',
            value: books ? balanceShown(Number(books.balance)) : '-',
            icon: <Wallet size={14} className="text-muted-foreground" />,
            color: 'bg-muted',
          },
        ]),
    {
      id: 'cs-fine',
      label: 'Silver Fine Due',
      value: gramsShown(customer.outstandingSilverFine ?? 0),
      icon: <TrendingDown size={14} className={fineOwed ? 'text-amber-600' : 'text-emerald-600'} />,
      color: fineOwed ? 'bg-amber-50' : 'bg-emerald-50',
    },
    ...(PREVIEW_MODE
      ? []
      : [
          {
            id: 'cs-fine-balance',
            label: 'Silver Fine Balance',
            value: books ? fineBalanceShown(Number(books.fineBalance)) : '-',
            icon: <Wallet size={14} className="text-muted-foreground" />,
            color: 'bg-muted',
          },
        ]),
    {
      id: 'cs-last',
      label: 'Last Purchase',
      value: customer.lastPurchase
        ? new Date(customer.lastPurchase).toLocaleDateString('en-IN')
        : '-',
      icon: <RotateCcw size={14} className="text-muted-foreground" />,
      color: 'bg-muted',
    },
  ];

  return (
    <div className="space-y-4 fade-in">
      <div className="jewel-card p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary">
              {customer.name.charAt(0)}
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">{customer.name}</h2>
              <p className="text-[11px] font-semibold text-primary mt-0.5">
                {customer.customerType}
              </p>
              <div className="flex flex-wrap gap-3 mt-1">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Phone size={11} /> {customer.mobile}
                </span>
                {customer.email && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Mail size={11} /> {customer.email}
                  </span>
                )}
                {customer.address && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <MapPin size={11} /> {customer.address}
                  </span>
                )}
              </div>
              {customer.gstNumber && (
                <p className="text-xs text-muted-foreground mt-1">GST: {customer.gstNumber}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowPaymentPanel((p) => !p)} className="btn-primary py-2">
              <CreditCard size={14} />
              Receive Payment
            </button>
            {PREVIEW_MODE && (
              <button
                onClick={handleDeleteCustomer}
                className="inline-flex items-center gap-1 rounded-sm border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                <Trash2 size={14} />
                Delete Customer
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {stats.map((stat) => (
            <div key={stat.id} className={`${stat.color} rounded-xl p-3 flex items-center gap-2.5`}>
              <div className="flex-shrink-0">{stat.icon}</div>
              <div>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
                <p data-testid={stat.id} className="text-sm font-bold text-foreground font-tabular">
                  {stat.value}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showPaymentPanel && (
        <ReceivePaymentPanel customer={customer} onClose={() => setShowPaymentPanel(false)} />
      )}

      <div className="jewel-card overflow-hidden">
        <div className="flex border-b border-border px-4 bg-muted/20">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm transition-colors ${activeTab === tab.id ? 'tab-active' : 'tab-inactive'}`}
            >
              {tab.label}
              {tab.id === 'ctab-ledger' && ledger.length > 0 && (
                <span className="ml-1.5 bg-muted text-muted-foreground text-xs px-1.5 py-0.5 rounded-full">
                  {ledger.length}
                </span>
              )}
              {tab.id === 'ctab-invoices' && invoices.length > 0 && (
                <span className="ml-1.5 bg-muted text-muted-foreground text-xs px-1.5 py-0.5 rounded-full">
                  {invoices.length}
                </span>
              )}
              {tab.id === 'ctab-payments' && paymentEntries.length > 0 && (
                <span className="ml-1.5 bg-muted text-muted-foreground text-xs px-1.5 py-0.5 rounded-full">
                  {paymentEntries.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="p-4">
          {activeTab === 'ctab-ledger' && <CustomerLedgerTable entries={ledger} />}
          {activeTab === 'ctab-invoices' && <CustomerInvoiceList invoices={invoices} />}
          {activeTab === 'ctab-payments' && (
            <div className="space-y-3">
              {paymentEntries.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No payments recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto scrollbar-thin">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/60 border-b border-border">
                        {['Date', 'Description', 'Reference', 'Amount', 'Fine']
                          .concat(PREVIEW_MODE ? ['Action'] : [])
                          .map((heading) => (
                            <th
                              key={heading}
                              className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                            >
                              {heading}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {paymentEntries.map((entry) => (
                        <tr key={entry.id} className="table-row-hover">
                          <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                            {new Date(entry.date).toLocaleDateString('en-IN')}
                          </td>
                          <td className="px-3 py-3 text-foreground">
                            {entry.description}
                            {entry.paymentId && voided.has(entry.paymentId) && (
                              <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                                Voided
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                            {entry.reference || '-'}
                          </td>
                          <td className="px-3 py-3 font-tabular font-bold text-emerald-600 whitespace-nowrap">
                            {rupeesShown(entry.credit)}
                          </td>
                          <td className="px-3 py-3 font-tabular font-bold text-amber-600 whitespace-nowrap">
                            {(entry.fineCredit ?? 0) > 0 ? gramsShown(entry.fineCredit ?? 0) : '-'}
                          </td>
                          {PREVIEW_MODE && (
                            <td className="px-3 py-3">
                              <button
                                type="button"
                                onClick={() => handleDeletePayment(entry)}
                                className="inline-flex items-center gap-1 rounded-sm border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                              >
                                <Trash2 size={13} />
                                Delete
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

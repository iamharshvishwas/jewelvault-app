'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  getCustomers,
  addCustomer,
  computeOutstanding,
  getLedgerForCustomer,
  getLedgerStatus,
  loadLedgerForCustomer,
  watchCustomerLedger,
} from '@/lib/appStore';
import SaveButton from '@/components/ui/SaveButton';
import { paiseShown } from '@/lib/ledgerView';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import CustomerList from './CustomerList';
import CustomerDetail from './CustomerDetail';
import type { Customer, CustomerType } from '@/lib/mockData';
import { X, Loader2 } from 'lucide-react';

interface AddCustomerForm {
  name: string;
  mobile: string;
  customerType: CustomerType;
  email: string;
  address: string;
  gstNumber: string;
  notes: string;
}

export default function CustomerLedgerClient() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // C6: a second click before the first answer is ignored (the ref answers at once, before the button has been drawn disabled)
  const savingNow = useRef(false);
  const [ledger, setLedger] = useState<{ state: string; message: string | null; empty: boolean }>({
    state: 'idle',
    message: null,
    empty: true,
  });
  const [form, setForm] = useState<AddCustomerForm>({
    name: '',
    mobile: '',
    customerType: 'Retail',
    email: '',
    address: '',
    gstNumber: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Partial<AddCustomerForm>>({});

  // C17: after any write that touches money the client polls at once, and that poll brings the customer's bill-summary rows and customer-balances row (V1, V2). The card is drawn
  // again as soon as memory holds them, not at the next tick of the clock below; the tick stays for the ledger's own state and for the preview build, whose store has no events.
  const books = useRowCacheVersion('customers', 'customer-balances', 'bills', 'bill-summary');
  const selectedId = selectedCustomer?.id ?? null;

  useEffect(() => {
    const refresh = () => {
      const list = getCustomers();
      setCustomers(list);
      // Keep selected customer in sync
      if (selectedId) {
        const updated = list.find((c) => c.id === selectedId);
        if (updated) setSelectedCustomer(updated);
        // the state of the open card's ledger (WEB07): loading the first time, or why it could not be loaded
        const status = getLedgerStatus(selectedId);
        const empty = getLedgerForCustomer(selectedId).length === 0;
        setLedger((before) =>
          before.state === status.state &&
          before.message === status.message &&
          before.empty === empty
            ? before
            : { ...status, empty }
        );
      }
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [selectedId, books]);

  // C3: the ledger of the customer is read from the server when the card opens, and again whenever that customer's updated_at changes
  useEffect(() => {
    if (!selectedCustomer?.id) return undefined;
    return watchCustomerLedger(selectedCustomer.id);
  }, [selectedCustomer?.id]);

  // what the customers owe in all: the sum of V2 `outstanding` in whole paise (the selectors, C14), the same figure as the dashboard, not a sum of the floats on the list
  const totalOutstanding = computeOutstanding().outstandingPaise;

  const validate = (): boolean => {
    const errs: Partial<AddCustomerForm> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.mobile.trim()) errs.mobile = 'Mobile is required';
    else if (!/^\d{10}$/.test(form.mobile.trim()))
      errs.mobile = 'Enter a valid 10-digit mobile number';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleAddCustomer = async () => {
    if (savingNow.current) return;
    if (!validate()) return;
    savingNow.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // X6 with a fresh Idempotency-Key; pressing the button again for the same customer after a failure sends the same key (the store keeps it), so a customer is never made twice
      const newCustomer = await addCustomer({
        name: form.name.trim(),
        mobile: form.mobile.trim(),
        customerType: form.customerType,
        email: form.email.trim(),
        address: form.address.trim(),
        gstNumber: form.gstNumber.trim(),
        notes: form.notes.trim(),
      });
      setCustomers(getCustomers());
      setSelectedCustomer(newCustomer);
      setShowAddForm(false);
      setForm({
        name: '',
        mobile: '',
        customerType: 'Retail',
        email: '',
        address: '',
        gstNumber: '',
        notes: '',
      });
      setErrors({});
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The customer could not be saved.');
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customer Ledger</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {customers.length} customer{customers.length !== 1 ? 's' : ''} ·{' '}
            <span data-testid="ledger-total-outstanding">{paiseShown(totalOutstanding)}</span> total
            outstanding
          </p>
        </div>
        <button onClick={() => setShowAddForm(true)} className="btn-primary py-2">
          + Add Customer
        </button>
      </div>

      {/* Add Customer Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="jewel-card w-full max-w-lg p-6 space-y-4 slide-up">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-foreground">Add New Customer</h2>
              <button onClick={() => setShowAddForm(false)} className="btn-ghost p-1.5">
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Priya Sharma"
                  className="input-field"
                />
                {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Mobile <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  value={form.mobile}
                  onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
                  placeholder="10-digit mobile number"
                  className="input-field font-mono"
                  maxLength={10}
                />
                {errors.mobile && <p className="text-xs text-red-500 mt-1">{errors.mobile}</p>}
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com"
                  className="input-field"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Customer Type
                </label>
                <select
                  value={form.customerType}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, customerType: e.target.value as CustomerType }))
                  }
                  className="input-field"
                >
                  {(['Retail', 'Semi-Wholesale', 'Wholesale'] as CustomerType[]).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  GST Number
                </label>
                <input
                  type="text"
                  value={form.gstNumber}
                  onChange={(e) => setForm((f) => ({ ...f, gstNumber: e.target.value }))}
                  placeholder="e.g. 27AABCU9603R1ZX"
                  className="input-field font-mono"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Address
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  placeholder="Full address"
                  className="input-field"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="text-xs font-semibold text-foreground block mb-1.5">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Any notes about this customer..."
                  rows={2}
                  className="input-field resize-none text-sm"
                />
              </div>
            </div>

            {saveError && (
              <p role="alert" data-testid="customer-save-error" className="text-xs text-red-600">
                {saveError}
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <SaveButton
                onClick={handleAddCustomer}
                disabled={saving}
                className="btn-primary flex-1 justify-center py-2.5"
              >
                {saving ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Add Customer'
                )}
              </SaveButton>
              <button onClick={() => setShowAddForm(false)} className="btn-secondary py-2.5">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-4">
        <div className="lg:col-span-1">
          <CustomerList
            customers={customers}
            selectedId={selectedCustomer?.id ?? null}
            onSelect={setSelectedCustomer}
          />
        </div>
        <div className="lg:col-span-3">
          {selectedCustomer && ledger.state === 'failed' && (
            <div
              role="alert"
              data-testid="ledger-error"
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              <span>{ledger.message ?? 'The ledger could not be loaded.'}</span>
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                onClick={() => void loadLedgerForCustomer(selectedCustomer.id)}
              >
                Try again
              </button>
            </div>
          )}
          {selectedCustomer && ledger.state === 'loading' && ledger.empty && (
            <p data-testid="ledger-loading" className="mb-3 text-xs text-muted-foreground">
              Loading the ledger…
            </p>
          )}
          {selectedCustomer ? (
            <CustomerDetail
              key={selectedCustomer.id}
              customer={selectedCustomer}
              onDeleted={() => {
                setCustomers(getCustomers());
                setSelectedCustomer(null);
              }}
            />
          ) : (
            <div className="jewel-card p-12 text-center">
              <p className="text-sm text-muted-foreground">
                {customers.length === 0
                  ? 'No customers yet. Click "+ Add Customer" to get started.'
                  : 'Select a customer to view their ledger'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

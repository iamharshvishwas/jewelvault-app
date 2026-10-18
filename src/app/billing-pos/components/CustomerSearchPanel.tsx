'use client';
import React, { useRef, useState } from 'react';
import { Search, User, X, Phone, MapPin, Plus } from 'lucide-react';
import type { Customer, CustomerType } from '@/lib/mockData';
import SaveButton from '@/components/ui/SaveButton';

interface CustomerSearchPanelProps {
  customers: Customer[];
  selectedCustomer: Customer | null;
  onSelectCustomer: (c: Customer | null) => void;
  // X6 is a call to the server (WEB07): the new customer comes back when it has been saved, or the promise is rejected with the plain sentence of what went wrong
  onCreateCustomer: (data: {
    name: string;
    mobile: string;
    customerType: CustomerType;
    email: string;
    address: string;
    gstNumber: string;
    notes: string;
  }) => Customer | Promise<Customer>;
}

export default function CustomerSearchPanel({
  customers,
  selectedCustomer,
  onSelectCustomer,
  onCreateCustomer,
}: CustomerSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    mobile: string;
    customerType: CustomerType;
    email: string;
    address: string;
    gstNumber: string;
    notes: string;
  }>({
    name: '',
    mobile: '',
    customerType: 'Retail',
    email: '',
    address: '',
    gstNumber: '',
    notes: '',
  });

  // C6: Save is disabled while a save runs, and a second click before the first answer is ignored (the ref answers at once, before the button has been drawn disabled)
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const filtered =
    query.length >= 2
      ? customers.filter(
          (c) => c.mobile.includes(query) || c.name.toLowerCase().includes(query.toLowerCase())
        )
      : [];

  const handleSelect = (c: Customer) => {
    onSelectCustomer(c);
    setQuery('');
    setShowResults(false);
  };

  const handleCreate = async () => {
    if (saving.current) return;
    if (!form.name.trim() || !form.mobile.trim()) {
      alert('Customer name and mobile number are required.');
      return;
    }
    saving.current = true;
    setIsSaving(true);
    setSaveError(null);
    try {
      // pressing Save again for the same customer after a failure sends the same Idempotency-Key (the store keeps it), so a customer is never made twice
      const customer = await onCreateCustomer({
        name: form.name.trim(),
        mobile: form.mobile.trim(),
        customerType: form.customerType,
        email: form.email.trim(),
        address: form.address.trim(),
        gstNumber: form.gstNumber.trim(),
        notes: form.notes.trim(),
      });
      onSelectCustomer(customer);
      setForm({
        name: '',
        mobile: '',
        customerType: 'Retail',
        email: '',
        address: '',
        gstNumber: '',
        notes: '',
      });
      setShowAddForm(false);
      setQuery('');
      setShowResults(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The customer could not be saved.');
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  };

  if (selectedCustomer) {
    return (
      <div className="jewel-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Customer</h3>
          <button onClick={() => onSelectCustomer(null)} className="btn-ghost p-1.5 text-xs">
            <X size={14} /> Change
          </button>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <User size={18} className="text-primary" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground">{selectedCustomer.name}</p>
            <p className="text-[11px] font-semibold text-primary mt-0.5">
              {selectedCustomer.customerType}
            </p>
            <div className="flex flex-wrap gap-3 mt-1">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Phone size={11} /> {selectedCustomer.mobile}
              </span>
              {selectedCustomer.address && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <MapPin size={11} /> {selectedCustomer.address}
                </span>
              )}
            </div>
            {selectedCustomer.outstanding > 0 && (
              <div className="mt-2 text-xs bg-amber-50 border border-amber-100 text-amber-700 px-2 py-1 rounded-lg inline-flex items-center gap-1">
                Outstanding: ₹{selectedCustomer.outstanding.toLocaleString('en-IN')}
              </div>
            )}
            {(selectedCustomer.outstandingSilverFine ?? 0) > 0 && (
              <div className="mt-2 ml-2 text-xs bg-amber-50 border border-amber-100 text-amber-700 px-2 py-1 rounded-lg inline-flex items-center gap-1">
                Fine: {selectedCustomer.outstandingSilverFine.toFixed(3)} g
              </div>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total Purchases</p>
            <p className="text-sm font-bold text-foreground font-tabular">
              ₹{(selectedCustomer.totalPurchases / 1000).toFixed(1)}K
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="jewel-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">Customer</h3>
        <button
          type="button"
          onClick={() => setShowAddForm((value) => !value)}
          className="btn-secondary py-1.5 text-xs"
        >
          <Plus size={13} />
          Add Customer
        </button>
      </div>
      {showAddForm && (
        <div className="mb-4 p-3 rounded-xl border border-border bg-muted/30 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            className="input-field text-xs"
            placeholder="Customer name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="input-field text-xs"
            placeholder="Mobile number"
            value={form.mobile}
            onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
          />
          <select
            className="input-field text-xs"
            value={form.customerType}
            onChange={(e) =>
              setForm((f) => ({ ...f, customerType: e.target.value as CustomerType }))
            }
          >
            {(['Retail', 'Semi-Wholesale', 'Wholesale'] as CustomerType[]).map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <input
            className="input-field text-xs"
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <input
            className="input-field text-xs"
            placeholder="GST number (optional)"
            value={form.gstNumber}
            onChange={(e) => setForm((f) => ({ ...f, gstNumber: e.target.value }))}
          />
          <input
            className="input-field text-xs sm:col-span-2"
            placeholder="Address"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          />
          {saveError && (
            <p
              role="alert"
              data-testid="customer-save-error"
              className="sm:col-span-2 text-xs text-red-600"
            >
              {saveError}
            </p>
          )}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              disabled={isSaving}
              className="btn-ghost py-1.5 text-xs"
            >
              Cancel
            </button>
            <SaveButton
              type="button"
              onClick={handleCreate}
              disabled={isSaving}
              className="btn-primary py-1.5 text-xs"
            >
              {isSaving ? 'Saving…' : 'Save Customer'}
            </SaveButton>
          </div>
        </div>
      )}
      <div className="relative">
        <Search
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          placeholder="Search by mobile or name..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowResults(true);
          }}
          onFocus={() => setShowResults(true)}
          className="input-field pl-9"
        />
        {query && (
          <button
            onClick={() => {
              setQuery('');
              setShowResults(false);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}

        {showResults && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 jewel-card-elevated z-30 overflow-hidden max-h-60 overflow-y-auto">
            {filtered.map((c) => (
              <button
                key={`cust-result-${c.id}`}
                onClick={() => handleSelect(c)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <User size={14} className="text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.mobile}</p>
                </div>
                {c.outstanding > 0 && (
                  <span className="text-xs text-amber-600 font-semibold">
                    ₹{(c.outstanding / 1000).toFixed(1)}K due
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {showResults && query.length >= 2 && filtered.length === 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 jewel-card-elevated z-30 p-4 text-center">
            <p className="text-xs text-muted-foreground">
              No customer found for &quot;{query}&quot;
            </p>
            <button
              type="button"
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  mobile: /^\d+$/.test(query) ? query : f.mobile,
                  name: /^\d+$/.test(query) ? f.name : query,
                }));
                setShowAddForm(true);
              }}
              className="btn-primary mt-2 py-1.5 text-xs"
            >
              + Create New Customer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

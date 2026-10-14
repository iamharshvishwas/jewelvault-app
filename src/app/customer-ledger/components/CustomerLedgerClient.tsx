'use client';
import React, { useState, useEffect } from 'react';
import { getCustomers, addCustomer } from '@/lib/appStore';
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
  const [form, setForm] = useState<AddCustomerForm>({
    name: '', mobile: '', customerType: 'Retail', email: '', address: '', gstNumber: '', notes: '',
  });
  const [errors, setErrors] = useState<Partial<AddCustomerForm>>({});

  useEffect(() => {
    const refresh = () => {
      const list = getCustomers();
      setCustomers(list);
      // Keep selected customer in sync
      if (selectedCustomer) {
        const updated = list.find((c) => c.id === selectedCustomer.id);
        if (updated) setSelectedCustomer(updated);
      }
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [selectedCustomer?.id]);

  const totalOutstanding = customers.reduce((a, c) => a + c.outstanding, 0);

  const validate = (): boolean => {
    const errs: Partial<AddCustomerForm> = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.mobile.trim()) errs.mobile = 'Mobile is required';
    else if (!/^\d{10}$/.test(form.mobile.trim())) errs.mobile = 'Enter a valid 10-digit mobile number';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleAddCustomer = async () => {
    if (!validate()) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 300));
    const newCustomer = addCustomer({
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
    setForm({ name: '', mobile: '', customerType: 'Retail', email: '', address: '', gstNumber: '', notes: '' });
    setErrors({});
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customer Ledger</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {customers.length} customer{customers.length !== 1 ? 's' : ''} · ₹{totalOutstanding.toLocaleString('en-IN')} total outstanding
          </p>
        </div>
        <button onClick={() => setShowAddForm(true)} className="btn-primary py-2">+ Add Customer</button>
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
                <label className="text-xs font-semibold text-foreground block mb-1.5">Customer Type</label>
                <select
                  value={form.customerType}
                  onChange={(e) => setForm((f) => ({ ...f, customerType: e.target.value as CustomerType }))}
                  className="input-field"
                >
                  {(['Retail', 'Semi-Wholesale', 'Wholesale'] as CustomerType[]).map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">GST Number</label>
                <input
                  type="text"
                  value={form.gstNumber}
                  onChange={(e) => setForm((f) => ({ ...f, gstNumber: e.target.value }))}
                  placeholder="e.g. 27AABCU9603R1ZX"
                  className="input-field font-mono"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="text-xs font-semibold text-foreground block mb-1.5">Address</label>
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

            <div className="flex gap-3 pt-2">
              <button
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
              </button>
              <button onClick={() => setShowAddForm(false)} className="btn-secondary py-2.5">Cancel</button>
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
          {selectedCustomer ? (
            <CustomerDetail
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
                  ? 'No customers yet. Click "+ Add Customer" to get started.' :'Select a customer to view their ledger'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

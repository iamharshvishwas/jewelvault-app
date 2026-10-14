'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ImagePlus, Plus, Search, Trash2, X } from 'lucide-react';
import AppImage from '@/components/ui/AppImage';
import { getCategories } from '@/lib/catalogStore';
import { getCustomers } from '@/lib/appStore';
import { addOrder, getOrders, removeOrder, updateOrder, type OrderBookEntry, type OrderStatus } from '@/lib/orderStore';
import type { Customer } from '@/lib/mockData';

const STATUSES: OrderStatus[] = ['Pending', 'In Progress', 'Ready', 'Delivered', 'Cancelled'];
const MATERIALS = ['Gold', 'Silver'];

const emptyForm = {
  customerId: '',
  customerName: '',
  customerMobile: '',
  itemDetails: '',
  category: '',
  material: 'Gold',
  purity: '',
  size: '',
  imageUrl: '',
  estimatedTotal: '',
  advanceAmount: '',
  approxDeliveryDate: '',
  notes: '',
};

function imageFileToStoredDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Unable to prepare image preview.'));
      img.onload = () => {
        const maxSide = 1000;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Unable to resize image.'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function OrderBookClient() {
  const [orders, setOrders] = useState<OrderBookEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const refresh = () => {
    setOrders(getOrders());
    setCustomers(getCustomers());
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  const categories = useMemo(() => getCategories(), []);
  const filtered = orders.filter((order) => {
    const haystack = `${order.orderNumber} ${order.customerName} ${order.customerMobile} ${order.itemDetails} ${order.category} ${order.status}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  const selectCustomer = (customerId: string) => {
    const customer = customers.find((item) => item.id === customerId);
    setForm((prev) => ({
      ...prev,
      customerId,
      customerName: customer?.name || prev.customerName,
      customerMobile: customer?.mobile || prev.customerMobile,
    }));
  };

  const saveOrder = () => {
    if (!form.customerName.trim() || !form.customerMobile.trim() || !form.itemDetails.trim()) {
      alert('Customer name, mobile and order details are required.');
      return;
    }
    addOrder({
      customerId: form.customerId,
      customerName: form.customerName.trim(),
      customerMobile: form.customerMobile.trim(),
      itemDetails: form.itemDetails.trim(),
      category: form.category,
      material: form.material,
      purity: form.purity.trim(),
      size: form.size.trim(),
      imageUrl: form.imageUrl,
      estimatedTotal: Number(form.estimatedTotal) || 0,
      advanceAmount: Number(form.advanceAmount) || 0,
      approxDeliveryDate: form.approxDeliveryDate,
      status: 'Pending',
      notes: form.notes.trim(),
    });
    setForm(emptyForm);
    setShowForm(false);
    refresh();
  };

  const deleteOrder = (order: OrderBookEntry) => {
    if (!window.confirm(`Delete order ${order.orderNumber} for ${order.customerName}?`)) return;
    removeOrder(order.id);
    refresh();
  };

  const addOrderImage = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file.');
      return;
    }
    try {
      const imageUrl = await imageFileToStoredDataUrl(file);
      setForm((prev) => ({ ...prev, imageUrl }));
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to save image.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Order Book</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Receive custom orders, advance payments and approximate delivery dates.</p>
        </div>
        <button onClick={() => setShowForm((value) => !value)} className="btn-primary py-2">
          <Plus size={15} />
          New Order
        </button>
      </div>

      {showForm && (
        <section className="jewel-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <CalendarClock size={18} className="text-primary" />
            <h2 className="text-base font-bold">Receive Order</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            <label className="text-xs font-semibold">
              Existing Customer
              <select className="input-field mt-1" value={form.customerId} onChange={(event) => selectCustomer(event.target.value)}>
                <option value="">Walk-in / new customer</option>
                {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} - {customer.mobile}</option>)}
              </select>
            </label>
            <Field label="Customer Name" value={form.customerName} onChange={(value) => setForm((prev) => ({ ...prev, customerName: value }))} />
            <Field label="Mobile" value={form.customerMobile} onChange={(value) => setForm((prev) => ({ ...prev, customerMobile: value }))} />
            <label className="text-xs font-semibold">
              Category
              <select className="input-field mt-1" value={form.category} onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}>
                <option value="">Select category</option>
                {categories.map((category) => <option key={category}>{category}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold">
              Material
              <select className="input-field mt-1" value={form.material} onChange={(event) => setForm((prev) => ({ ...prev, material: event.target.value }))}>
                {MATERIALS.map((material) => <option key={material}>{material}</option>)}
              </select>
            </label>
            <Field label="Purity" value={form.purity} onChange={(value) => setForm((prev) => ({ ...prev, purity: value }))} placeholder="22K / 925" />
            <Field label="Size / Length" value={form.size} onChange={(value) => setForm((prev) => ({ ...prev, size: value }))} />
            <Field label="Approx Delivery Date" type="date" value={form.approxDeliveryDate} onChange={(value) => setForm((prev) => ({ ...prev, approxDeliveryDate: value }))} />
            <Field label="Estimated Total" type="number" value={form.estimatedTotal} onChange={(value) => setForm((prev) => ({ ...prev, estimatedTotal: value }))} />
            <Field label="Advance Payment" type="number" value={form.advanceAmount} onChange={(value) => setForm((prev) => ({ ...prev, advanceAmount: value }))} />
            <label className="md:col-span-3 text-xs font-semibold">
              Order Details
              <textarea className="input-field mt-1 min-h-24" value={form.itemDetails} onChange={(event) => setForm((prev) => ({ ...prev, itemDetails: event.target.value }))} placeholder="Design details, sample reference, stones, engraving, customer requirements..." />
            </label>
            <div className="md:col-span-3 grid md:grid-cols-[180px_1fr] gap-3 items-start">
              <div className="aspect-square rounded-sm border border-border image-placeholder overflow-hidden flex items-center justify-center">
                {form.imageUrl ? (
                  <AppImage src={form.imageUrl} alt="Order reference" width={240} height={240} className="w-full h-full object-cover" />
                ) : (
                  <ImagePlus size={28} className="text-muted-foreground" />
                )}
              </div>
              <div className="space-y-2">
                <label className="inline-flex items-center gap-2 btn-secondary py-2 cursor-pointer">
                  <ImagePlus size={15} />
                  Add Order Picture
                  <input type="file" accept="image/*" className="hidden" onChange={(event) => addOrderImage(event.target.files?.[0])} />
                </label>
                {form.imageUrl && (
                  <button type="button" onClick={() => setForm((prev) => ({ ...prev, imageUrl: '' }))} className="inline-flex items-center gap-1 text-xs text-red-600 border border-red-200 rounded-sm px-3 py-2 hover:bg-red-50">
                    <X size={13} />
                    Remove Picture
                  </button>
                )}
                <p className="text-xs text-muted-foreground">Use this for customer sample, reference design, sketch, or WhatsApp image.</p>
              </div>
            </div>
            <label className="md:col-span-3 text-xs font-semibold">
              Notes
              <textarea className="input-field mt-1 min-h-20" value={form.notes} onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="btn-secondary py-2">Cancel</button>
            <button onClick={saveOrder} className="btn-primary py-2">Save Order</button>
          </div>
        </section>
      )}

      <section className="jewel-card overflow-hidden">
        <div className="p-4 border-b border-border">
          <div className="relative max-w-lg">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} className="input-field pl-9" placeholder="Search order, customer, mobile, item..." />
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No orders recorded yet.</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Order', 'Picture', 'Customer', 'Details', 'Delivery', 'Advance', 'Balance', 'Status', 'Action'].map((heading) => (
                    <th key={heading} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((order) => (
                  <tr key={order.id} className="table-row-hover">
                    <td className="px-3 py-3 font-mono font-bold text-primary">{order.orderNumber}</td>
                    <td className="px-3 py-3">
                      <div className="w-14 h-14 rounded-sm border border-border image-placeholder overflow-hidden flex items-center justify-center">
                        {order.imageUrl ? (
                          <AppImage src={order.imageUrl} alt={`${order.orderNumber} reference`} width={80} height={80} className="w-full h-full object-cover" />
                        ) : (
                          <ImagePlus size={18} className="text-muted-foreground" />
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-semibold text-foreground">{order.customerName}</p>
                      <p className="text-muted-foreground">{order.customerMobile}</p>
                    </td>
                    <td className="px-3 py-3 min-w-72">
                      <p className="font-semibold text-foreground">{order.category || 'Custom'} · {order.material} {order.purity}</p>
                      <p className="text-muted-foreground line-clamp-2">{order.itemDetails}</p>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{order.approxDeliveryDate ? new Date(order.approxDeliveryDate).toLocaleDateString('en-IN') : '-'}</td>
                    <td className="px-3 py-3 font-tabular font-bold text-emerald-600">₹{order.advanceAmount.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3 font-tabular font-bold text-amber-600">₹{order.balanceAmount.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-3">
                      <select className="input-field text-xs py-1.5" value={order.status} onChange={(event) => { updateOrder(order.id, { status: event.target.value as OrderStatus }); refresh(); }}>
                        {STATUSES.map((status) => <option key={status}>{status}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      <button onClick={() => deleteOrder(order)} className="inline-flex items-center gap-1 rounded-sm border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="text-xs font-semibold">
      {label}
      <input className="input-field mt-1" type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

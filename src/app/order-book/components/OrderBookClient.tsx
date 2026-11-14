'use client';

import React, { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useSession } from '@/lib/authStore';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getOrders, type OrderView } from '@/lib/orderStore';
import { ORDER_STATUSES, ORDER_STATUS_LABEL, type OrderStatus } from '@/lib/orderStatus';
import NewOrderForm from './NewOrderForm';
import OrderCard from './OrderCard';

// FB-F1 (FB-D8, Siddhi #13): the Order Book. Every role reads the list (the orders are in memory, kept fresh by the poll); the owner and the biller make orders and move them along. Tabs
// filter by status, a search finds an order by its number or its words (and, for the owner and the biller, the customer). Staff see no customer, no New order and no status button
// (ruling A4, F-extra-1): for them the customer is not even looked up.

type Tab = 'all' | OrderStatus;
const TABS: readonly Tab[] = ['all', ...ORDER_STATUSES];
const tabLabel = (tab: Tab) => (tab === 'all' ? 'All' : ORDER_STATUS_LABEL[tab]);

function matches(order: OrderView, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === '') return true;
  return [order.orderNo, order.description, order.notes, order.customerName, order.customerMobile]
    .filter((part): part is string => typeof part === 'string')
    .some((part) => part.toLowerCase().includes(text));
}

export default function OrderBookClient() {
  useRowCacheVersion('orders', 'customers');
  const { role } = useSession();
  const today = useBusinessToday();
  const canWrite = role === 'owner' || role === 'biller';
  const orders = getOrders({ withCustomers: canWrite });
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState('');

  const counted = (t: Tab) =>
    t === 'all' ? orders.length : orders.filter((o) => o.status === t).length;
  const shown = orders.filter((o) => (tab === 'all' || o.status === tab) && matches(o, query));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Order Book</h1>
          <p className="text-sm text-muted-foreground">
            {orders.length} {orders.length === 1 ? 'order' : 'orders'}
          </p>
        </div>
        {canWrite && !showForm && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setNotice('');
              setShowForm(true);
            }}
          >
            <Plus size={16} />
            New order
          </button>
        )}
      </div>

      {notice && (
        <p
          role="status"
          data-testid="order-notice"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}

      {canWrite && showForm && (
        <NewOrderForm
          onClose={() => setShowForm(false)}
          onSaved={(saved) => {
            setShowForm(false);
            setTab('all');
            setNotice(`Order ${saved.orderNo} saved.`);
          }}
        />
      )}

      <div
        role="tablist"
        aria-label="Orders by status"
        className="flex gap-1 overflow-x-auto scrollbar-thin pb-1"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid="order-tab"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              tab === t
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {tabLabel(t)} ({counted(t)})
          </button>
        ))}
      </div>

      <div className="relative">
        <Search
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label="Search orders"
          placeholder={
            canWrite
              ? 'Search by order number, customer or words…'
              : 'Search by order number or words…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="input-field pl-9"
        />
      </div>

      {shown.length === 0 ? (
        <p
          data-testid="orders-none"
          className="jewel-card p-6 text-center text-sm text-muted-foreground"
        >
          {orders.length === 0 ? 'No orders yet.' : 'No order matches.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((order) => (
            <OrderCard key={order.id} order={order} role={role} today={today} />
          ))}
        </div>
      )}
    </div>
  );
}

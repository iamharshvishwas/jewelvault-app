'use client';
import React from 'react';
import Link from 'next/link';
import { ClipboardList } from 'lucide-react';
import { useSession } from '@/lib/authStore';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { ordersDue } from '@/lib/orderStore';
import { DUE_WITHIN_DAYS, dueLabel } from '@/lib/orderStatus';
import { dayLabel } from '@/lib/rateGuard';

// FB-F1 (FB-D8, Siddhi #13): "Orders due" on the dashboard, for the owner, the biller and the staff. The orders due today, tomorrow or the day after, or overdue, that are neither delivered
// nor cancelled (`ordersDue`), counted from the Asia/Kolkata business day (`useBusinessToday`, never the computer's own day), the most overdue first. The card is drawn again when an order
// changes (the poll brings another browser's order within one poll) and when the day changes. Staff see no customer (ruling A4). Each order opens the Order Book.

/** How many orders the card lists; the Order Book has them all. */
const SHOWN = 10;

export default function DashboardOrdersPanel() {
  useRowCacheVersion('orders', 'customers');
  const today = useBusinessToday();
  const role = useSession().session?.role ?? null; // TODO(task-18): can() instead of the role key
  const withCustomers = role === 'owner' || role === 'biller';
  const rows = today ? ordersDue(today, { withCustomers }) : [];

  return (
    <section data-testid="orders-due-panel" className="jewel-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ClipboardList
            size={15}
            className={rows.length > 0 ? 'text-amber-600' : 'text-muted-foreground'}
          />
          Orders due
        </h2>
        <span data-testid="orders-due-count" className="text-xs text-muted-foreground">
          {rows.length === 0 ? 'None' : `${rows.length} ${rows.length === 1 ? 'order' : 'orders'}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p data-testid="orders-due-none" className="text-xs text-muted-foreground">
          No order is due in the next {DUE_WITHIN_DAYS} days or overdue.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.slice(0, SHOWN).map((order) => (
            <li
              key={order.id}
              data-testid="orders-due-row"
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href="/order-book"
                  className="font-mono font-bold text-primary hover:underline"
                >
                  {order.orderNo}
                </Link>
                {withCustomers && (
                  <span className="ml-2 font-semibold text-foreground">
                    {order.customerName ?? 'Unknown customer'}
                  </span>
                )}
                <p className="truncate text-muted-foreground">{order.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {order.deliveryDate ? dayLabel(order.deliveryDate) : ''}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-semibold text-foreground">
                  {order.statusLabel}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-semibold ${order.daysLeft < 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}
                >
                  {dueLabel(order.daysLeft)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > SHOWN && (
        <p data-testid="orders-due-more" className="text-xs text-muted-foreground">
          And {rows.length - SHOWN} more in the{' '}
          <Link href="/order-book" className="text-primary hover:underline">
            Order Book
          </Link>
          .
        </p>
      )}
    </section>
  );
}

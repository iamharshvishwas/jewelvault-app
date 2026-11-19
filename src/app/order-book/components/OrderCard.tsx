'use client';

import React, { useRef, useState } from 'react';
import { CalendarClock, ImagePlus, Phone, User } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import type { Holder } from '@/lib/access';
import { newUuid } from '@/lib/api/client';
import {
  addOrderPhoto,
  canAddPhoto,
  orderSaveMessage,
  setOrderStatus,
  type OrderView,
} from '@/lib/orderStore';
import {
  daysUntil,
  dueLabel,
  isClosedOrder,
  orderActions,
  orderBookAccess,
} from '@/lib/orderStatus';
import { MAX_ORIGINAL_BYTES, photoUrl, prepareImage } from '@/lib/photos';
import { dayLabel } from '@/lib/rateGuard';

// FB-F1: one order of the Order Book. A person without "See customers" sees the number, the description, the delivery date, the status and the photos, and no customer (ruling A4, F-extra-1);
// a person without "Make and change orders" has no status button and no photo control either (staff, among today's roles). Whoever holds those ticks (the owner and the biller) sees the customer,
// the next step of the chain and Cancel (src/lib/orderStatus.ts, F-extra-2), and adds a photo while the order is not delivered or cancelled (F-extra-5); a delivered order is cancelled only
// by a person who may change a closed order. Cancel asks once more before it is sent.

export const STATUS_STYLE: Readonly<Record<OrderView['status'], string>> = {
  open: 'bg-sky-100 text-sky-800',
  in_progress: 'bg-amber-100 text-amber-800',
  ready: 'bg-emerald-100 text-emerald-800',
  delivered: 'bg-muted text-muted-foreground',
  cancelled: 'bg-red-100 text-red-700',
};

export default function OrderCard({
  order,
  holder,
  today,
}: {
  order: OrderView;
  /** The person looking at the book: their ticks decide the customer line, the photo control and the buttons. */
  holder: Holder | null;
  today: string;
}) {
  const access = orderBookAccess(holder);
  const actions = orderActions(order.status, holder);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const run = async (work: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(orderSaveMessage(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const addPhoto = (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    void run(async () => {
      if (file.size > MAX_ORIGINAL_BYTES) throw new Error('A picture over 25 MB cannot be added.');
      const made = await prepareImage(file);
      await addOrderPhoto(order.id, {
        photoId: newUuid(),
        full: made.full,
        thumb: made.thumb,
        stored: { full: null, thumb: null },
      });
    });
  };

  const days =
    order.deliveryDate && today && !isClosedOrder(order.status)
      ? daysUntil(today, order.deliveryDate)
      : null;

  return (
    <article
      data-testid="order-card"
      data-order-no={order.orderNo}
      className="jewel-card p-4 space-y-3 min-w-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold text-primary">{order.orderNo}</p>
          {access.customers && (
            <p
              data-testid="order-customer"
              className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm"
            >
              <span className="flex items-center gap-1 font-semibold text-foreground">
                <User size={13} /> {order.customerName ?? 'Unknown customer'}
              </span>
              {order.customerMobile && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Phone size={11} /> {order.customerMobile}
                </span>
              )}
            </p>
          )}
        </div>
        <span
          data-testid="order-status"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[order.status]}`}
        >
          {order.statusLabel}
        </span>
      </div>

      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{order.description}</p>

      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock size={13} />
        {order.deliveryDate ? `Delivery ${dayLabel(order.deliveryDate)}` : 'No delivery date'}
        {days !== null && days <= 2 && (
          <span
            className={`rounded-full px-2 py-0.5 font-semibold ${days < 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}
          >
            {dueLabel(days)}
          </span>
        )}
      </p>

      {order.notes && (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {order.notes}
        </p>
      )}

      {(order.photoIds.length > 0 || (access.edit && canAddPhoto(order))) && (
        <div className="flex flex-wrap items-center gap-2">
          {order.photoIds.map((photoId) => (
            <a
              key={photoId}
              href={photoUrl(photoId, 'full')}
              target="_blank"
              rel="noreferrer"
              className="block h-16 w-16 overflow-hidden rounded-lg border border-border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the API's own picture, served as stored (the build has no image optimiser) */}
              <img
                data-testid="order-photo"
                src={photoUrl(photoId, 'thumb')}
                alt={`Photo of ${order.orderNo}`}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </a>
          ))}
          {access.edit && canAddPhoto(order) && (
            <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-border text-[11px] text-muted-foreground hover:border-primary">
              <ImagePlus size={16} />
              Add photo
              <input
                data-testid="order-add-photo"
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  addPhoto(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      )}

      {error && (
        <p role="alert" data-testid="order-error" className="text-xs text-red-600">
          {error}
        </p>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {confirmCancel ? (
            <>
              <span className="w-full text-xs text-foreground">Cancel {order.orderNo}?</span>
              <SaveButton
                type="button"
                disabled={busy}
                className="btn-primary bg-red-600 py-1.5 text-xs hover:bg-red-700"
                onClick={() =>
                  void run(async () => {
                    await setOrderStatus(order.id, 'cancelled');
                    setConfirmCancel(false);
                  })
                }
              >
                Yes, cancel the order
              </SaveButton>
              <button
                type="button"
                disabled={busy}
                className="btn-ghost py-1.5 text-xs"
                onClick={() => setConfirmCancel(false)}
              >
                No
              </button>
            </>
          ) : (
            actions.map((action) =>
              action.to === 'cancelled' ? (
                <button
                  key={action.to}
                  type="button"
                  disabled={busy}
                  className="btn-ghost py-1.5 text-xs text-red-600"
                  onClick={() => setConfirmCancel(true)}
                >
                  {action.label}
                </button>
              ) : (
                <SaveButton
                  key={action.to}
                  type="button"
                  disabled={busy}
                  className="btn-primary py-1.5 text-xs"
                  onClick={() => void run(() => setOrderStatus(order.id, action.to))}
                >
                  {action.label}
                </SaveButton>
              )
            )
          )}
        </div>
      )}
    </article>
  );
}

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2, X } from 'lucide-react';
import CustomerSearchPanel from '@/app/billing-pos/components/CustomerSearchPanel';
import SaveButton from '@/components/ui/SaveButton';
import { isApiError, newUuid } from '@/lib/api/client';
import { addCustomer, getCustomers } from '@/lib/appStore';
import { SaveError } from '@/lib/cache/edit';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import type { Customer } from '@/lib/mockData';
import {
  MAX_ORDER_PHOTOS,
  ORDER_TEXT_MAX,
  createOrder,
  orderSaveMessage,
  type NewOrderInput,
} from '@/lib/orderStore';
import { MAX_ORIGINAL_BYTES, prepareImage, type PhotoToUpload } from '@/lib/photos';

// FB-F1 (FB-D8, Siddhi #13): the new order form of the owner and the biller. The customer is chosen with the billing screen's own search (CustomerSearchPanel: by mobile or name, or a new
// customer saved on the spot), then what the order is, the delivery date, up to 3 photos and notes. A photo is made in the browser by the Add Design resizer (src/lib/photos.ts
// `prepareImage`: 1000 px at quality 72 and a 320 px thumbnail) and uploaded under the order's id before the order is made. No money: an advance is a payment in the ledger.

interface PickedPhoto {
  photo: PhotoToUpload;
  previewUrl: string;
}

export interface SavedOrder {
  orderNo: string;
}

export default function NewOrderForm({
  onSaved,
  onClose,
}: {
  onSaved: (saved: SavedOrder) => void;
  onClose: () => void;
}) {
  useRowCacheVersion('customers', 'customer-balances');
  const customers = getCustomers();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [description, setDescription] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [photoNotice, setPhotoNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const preparingRef = useRef(false);
  const previewUrls = useRef(new Set<string>());
  // The order's id, made when Save is first pressed (P2), and the last try that could not be confirmed: its entries as text and its Idempotency-Key (C6).
  const attempt = useRef<{ orderId: string | null; text: string | null; key: string | null }>({
    orderId: null,
    text: null,
    key: null,
  });

  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const addFiles = async (list: FileList | null) => {
    if (!list || preparingRef.current) return;
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const room = Math.max(0, MAX_ORDER_PHOTOS - photos.length);
    const taking = files.slice(0, room);
    const problems: string[] = [];
    preparingRef.current = true;
    setPreparing(true);
    setPhotoNotice('');
    const added: PickedPhoto[] = [];
    try {
      for (const file of taking) {
        if (file.size > MAX_ORIGINAL_BYTES) {
          problems.push('A picture over 25 MB was not added.');
          continue;
        }
        try {
          const made = await prepareImage(file);
          const url = URL.createObjectURL(made.thumb);
          previewUrls.current.add(url);
          added.push({
            photo: {
              photoId: newUuid(),
              full: made.full,
              thumb: made.thumb,
              stored: { full: null, thumb: null },
            },
            previewUrl: url,
          });
        } catch (failure) {
          problems.push(
            failure instanceof Error ? failure.message : 'A picture could not be added.'
          );
        }
      }
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
    if (files.length > taking.length)
      problems.push(`An order can have at most ${MAX_ORDER_PHOTOS} photos.`);
    setPhotoNotice(problems.join(' '));
    if (added.length > 0) setPhotos((current) => [...current, ...added]);
  };

  const removePhoto = (photoId: string) => {
    const gone = photos.find((p) => p.photo.photoId === photoId);
    if (gone) {
      URL.revokeObjectURL(gone.previewUrl);
      previewUrls.current.delete(gone.previewUrl);
    }
    setPhotoNotice('');
    setPhotos((current) => current.filter((p) => p.photo.photoId !== photoId));
  };

  const save = async () => {
    if (savingRef.current || preparingRef.current) return; // a second click while the first is on its way is the same click (C6)
    const orderId = attempt.current.orderId ?? newUuid();
    attempt.current.orderId = orderId;
    const input: NewOrderInput = {
      orderId,
      customerId: customer?.id ?? '',
      description,
      deliveryDate,
      notes,
      photos: photos.map((p) => p.photo),
    };
    // the same entries as the last try that could not be confirmed are the same order: the same key makes it once (C6)
    const text = JSON.stringify({ ...input, photos: input.photos.map((p) => p.photoId) });
    const key = attempt.current.text === text ? attempt.current.key : null;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setProgress('Saving…');
    try {
      const made = await createOrder(input, {
        idempotencyKey: key ?? undefined,
        onProgress: setProgress,
      });
      attempt.current = { orderId: null, text: null, key: null };
      onSaved({ orderNo: made.order_no });
    } catch (failure) {
      const cause = failure instanceof SaveError ? failure.origin : failure;
      // the call was made and its answer is not known: Save again for the same entries sends the same key
      const lost = isApiError(cause) && cause.unconfirmed ? cause.idempotencyKey : null;
      attempt.current = { orderId, text: lost ? text : null, key: lost };
      setError(orderSaveMessage(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
      setProgress('');
    }
  };

  return (
    <section
      data-testid="new-order-form"
      aria-label="New order"
      className="jewel-card p-4 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">New order</h2>
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost p-2"
          aria-label="Close the new order form"
        >
          <X size={16} />
        </button>
      </div>

      <CustomerSearchPanel
        customers={customers}
        selectedCustomer={customer}
        onSelectCustomer={setCustomer}
        onCreateCustomer={addCustomer}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-muted-foreground">Description</span>
          <textarea
            className="input-field mt-1 min-h-20"
            value={description}
            maxLength={ORDER_TEXT_MAX}
            placeholder="What to make: design, metal, purity, size, weight…"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Delivery date</span>
          <input
            type="date"
            className="input-field mt-1"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-muted-foreground">Notes</span>
          <textarea
            className="input-field mt-1 min-h-16"
            value={notes}
            maxLength={ORDER_TEXT_MAX}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            Photos ({photos.length} of {MAX_ORDER_PHOTOS})
          </span>
          {photos.length < MAX_ORDER_PHOTOS && (
            <label className="btn-secondary cursor-pointer py-1.5 text-xs">
              <ImagePlus size={14} />
              {preparing ? 'Preparing…' : 'Add photo'}
              <input
                data-testid="order-photo-input"
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={preparing || saving}
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
        {photoNotice && (
          <p data-testid="order-photo-notice" className="text-xs text-amber-700">
            {photoNotice}
          </p>
        )}
        {photos.length > 0 && (
          <div className="grid grid-cols-3 gap-2 sm:max-w-sm">
            {photos.map((p) => (
              <div
                key={p.photo.photoId}
                data-testid="order-photo-tile"
                className="relative aspect-square overflow-hidden rounded-lg border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a picture in this page's memory, not a file of the site */}
                <img src={p.previewUrl} alt="Order photo" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(p.photo.photoId)}
                  disabled={saving}
                  aria-label="Remove this photo"
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-red-600"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" data-testid="order-save-error" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {progress && <span className="text-xs text-muted-foreground">{progress}</span>}
        <button type="button" onClick={onClose} disabled={saving} className="btn-ghost">
          Cancel
        </button>
        <SaveButton
          type="button"
          onClick={save}
          disabled={saving || preparing}
          className="btn-primary"
        >
          {saving ? 'Saving…' : 'Save order'}
        </SaveButton>
      </div>
    </section>
  );
}

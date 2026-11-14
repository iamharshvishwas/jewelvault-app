'use client';

// FB-F1 (FB-D8, Siddhi #13): the Order Book's store, on the row cache like every other book (spec C2, C8, C9). The orders are the `orders` rows of FB-E1 that the hydrate loads and the poll
// keeps fresh (src/lib/cache); this file reads them from memory and makes the shapes the screens know. Nothing is kept in browser storage: the old prototype key is neither read nor written
// nor wiped, and there is no copy of the orders outside memory.
//
//   - the list (`getOrders`) and the dashboard's "Orders due" (`ordersDue`) are read from memory. The customer's name and mobile are looked up for the owner and the biller only: staff are
//     never told who an order is for (ruling A4, F-extra-1), so for them the customer is not even looked up;
//   - a NEW order (`createOrder`) uploads its photos first under the order's id, which the page makes (P2, C11), then makes ONE call with an Idempotency-Key; nothing is shown until the API
//     has answered with ITS number (`ORD-2026-0001`) and status (`open`);
//   - a change of status (`setOrderStatus`) and a photo added later (`addOrderPhoto`) are ordinary edits (src/lib/cache/edit.ts): shown at once, one PATCH with the exact stamp of the row,
//     rolled back if the API refuses. The buttons offered are those of src/lib/orderStatus.ts (F-extra-2); a closed order takes no new photo (F-extra-5).
// An order holds NO MONEY: an advance is an ordinary payment in the customer's ledger.
import type { OrderRow, OrderStatus } from '@/lib/api/types';
import { rowCache, savingNotAvailable } from './cache/cache';
import { SaveError, editRow } from './cache/edit';
import { sendCreateOrder } from './cache/orders';
import {
  DUE_WITHIN_DAYS,
  ORDER_STATUS_LABEL,
  ORDER_STATUSES,
  daysUntil,
  isClosedOrder,
} from './orderStatus';
import { PHOTO_RULES, uploadPhoto, type PhotoToUpload } from './photos';
import { PREVIEW_MODE } from './previewMode';

export type { OrderStatus } from '@/lib/api/types';

/** The widths of the API's columns (VARCHAR(2000)). */
export const ORDER_TEXT_MAX = 2000;
/** At most 3 photos to an order (the API's cap, the same as a design's). */
export const MAX_ORDER_PHOTOS = PHOTO_RULES.maxPerDesign;

export interface OrderView {
  id: string;
  /** `ORD-2026-0001`. */
  orderNo: string;
  customerId: string;
  /** Null for staff (never looked up), or when the customer is not in memory. */
  customerName: string | null;
  customerMobile: string | null;
  description: string;
  /** `YYYY-MM-DD`, or null when no date was given. */
  deliveryDate: string | null;
  status: OrderStatus;
  statusLabel: string;
  photoIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface DueOrder extends OrderView {
  /** 0 today, 1 tomorrow, 2 the day after, below 0 overdue. */
  daysLeft: number;
}

export interface ReadOptions {
  /** The owner and the biller: true. Staff: false (the default), and the customer is not looked up at all. */
  withCustomers?: boolean;
}

function viewOf(row: OrderRow, withCustomers: boolean): OrderView {
  const customer = withCustomers ? rowCache.get('customers', row.customer_id) : undefined;
  const status = (ORDER_STATUSES as readonly string[]).includes(row.status) ? row.status : 'open';
  return {
    id: row.id,
    orderNo: row.order_no,
    customerId: row.customer_id,
    customerName: customer?.name ?? null,
    customerMobile: customer?.mobile ?? null,
    description: row.description,
    deliveryDate: row.delivery_date ?? null,
    status,
    statusLabel: ORDER_STATUS_LABEL[status],
    photoIds: Array.isArray(row.photo_ids) ? row.photo_ids : [],
    notes: row.notes ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Nearest delivery first, an order with no date after every dated one, then by number. */
function byDelivery(a: OrderView, b: OrderView): number {
  if (a.deliveryDate !== b.deliveryDate) {
    if (a.deliveryDate === null) return 1;
    if (b.deliveryDate === null) return -1;
    return a.deliveryDate < b.deliveryDate ? -1 : 1;
  }
  return a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0;
}

let listed: { version: string; orders: OrderView[] } | null = null;

/** Every order in memory, nearest delivery first. The same array until the orders (or, with customers, the customers) change. */
export function getOrders(options: ReadOptions = {}): OrderView[] {
  const withCustomers = options.withCustomers === true;
  const version = `${withCustomers ? 'c' : 's'}:${withCustomers ? rowCache.versionOf('orders', 'customers') : rowCache.versionOf('orders')}`;
  if (listed && listed.version === version) return listed.orders;
  const orders = rowCache
    .rows('orders')
    .map((row) => viewOf(row, withCustomers))
    .sort(byDelivery);
  listed = { version, orders };
  return orders;
}

/** One order from memory, or null. */
export function getOrder(id: string, options: ReadOptions = {}): OrderView | null {
  const row = rowCache.get('orders', id);
  return row ? viewOf(row, options.withCustomers === true) : null;
}

/**
 * The orders the dashboard warns of (FB-D8): due today, tomorrow or the day after, or overdue, and neither delivered nor cancelled. `today` is the Asia/Kolkata business date
 * (`useBusinessToday`), never the computer's own day. The most overdue first. `rows` defaults to the orders in memory.
 */
export function ordersDue(
  today: string,
  options: ReadOptions & { rows?: readonly OrderRow[] } = {}
): DueOrder[] {
  const rows = options.rows ?? rowCache.rows('orders');
  const due: DueOrder[] = [];
  for (const row of rows) {
    if (isClosedOrder(row.status) || !row.delivery_date) continue;
    const daysLeft = daysUntil(today, row.delivery_date);
    if (daysLeft === null || daysLeft > DUE_WITHIN_DAYS) continue;
    due.push({ ...viewOf(row, options.withCustomers === true), daysLeft });
  }
  return due.sort((a, b) => a.daysLeft - b.daysLeft || byDelivery(a, b));
}

// ------------------------------------------------------------------------------------------------ the writes

const refused = (message: string) => new SaveError(new Error(message));
const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface NewOrderInput {
  /** Made by the page before the first upload (P2): the photos are stored under it. */
  orderId: string;
  customerId: string;
  description: string;
  /** `YYYY-MM-DD`, or blank for none. */
  deliveryDate: string;
  notes: string;
  /** In the order they were added. Each was given its id by the page. */
  photos: PhotoToUpload[];
}

/** The body of `POST /v1/orders` from what the person typed: the ids the page made and the entries, nothing the API makes (no number, no status, no stamp) and no money. Throws a SaveError. */
export function createOrderBody(input: NewOrderInput): Record<string, unknown> {
  if (!input.customerId) throw refused('Choose the customer first. Nothing was changed.');
  const description = input.description.trim();
  if (description === '') throw refused('Write a description of the order. Nothing was changed.');
  if (description.length > ORDER_TEXT_MAX)
    throw refused('The description can be at most 2,000 characters. Nothing was changed.');
  const notes = input.notes.trim();
  if (notes.length > ORDER_TEXT_MAX)
    throw refused('The notes can be at most 2,000 characters. Nothing was changed.');
  const date = input.deliveryDate.trim();
  if (date !== '' && (!BUSINESS_DATE.test(date) || daysUntil(date, date) === null))
    throw refused('The delivery date is not a date. Nothing was changed.');
  if (input.photos.length > MAX_ORDER_PHOTOS)
    throw refused(`An order can have at most ${MAX_ORDER_PHOTOS} photos. Nothing was changed.`);
  const body: Record<string, unknown> = {
    order_id: input.orderId,
    customer_id: input.customerId,
    description,
  };
  if (date !== '') body.delivery_date = date;
  if (notes !== '') body.notes = notes;
  if (input.photos.length > 0) body.photo_ids = input.photos.map((photo) => photo.photoId);
  return body;
}

/**
 * Makes an order (FB-E1 X13). The photos go up first, one after another, under the order's id (a photo already stored for this id is not sent again, so a second Save sends only what is
 * missing); then ONE call with the entries and an Idempotency-Key. The order the API returned goes into memory. `idempotencyKey` is the key of an earlier try of the SAME order that could
 * not be confirmed. Throws a SaveError.
 */
export async function createOrder(
  input: NewOrderInput,
  options: { idempotencyKey?: string; onProgress?: (message: string) => void } = {}
): Promise<OrderRow> {
  if (PREVIEW_MODE) throw savingNotAvailable('An order');
  const body = createOrderBody(input); // everything that can be refused is refused before anything goes out
  const session = rowCache.generation();
  for (const [at, photo] of input.photos.entries()) {
    options.onProgress?.(`Uploading photo ${at + 1} of ${input.photos.length}…`);
    try {
      await uploadPhoto(input.orderId, photo, 'orders');
    } catch (error) {
      throw new SaveError(error, { label: input.photos.length > 1 ? `Photo ${at + 1}` : null });
    }
  }
  options.onProgress?.('Saving the order…');
  const answer = await sendCreateOrder(body, options.idempotencyKey);
  if (rowCache.generation() === session) rowCache.merge('orders', [answer.order]);
  return answer.order;
}

/** Moves an order to `to` (one of the buttons of orderStatus.ts): shown at once, one PATCH, rolled back if refused. Resolves with the row the API returned. Throws a SaveError. */
export async function setOrderStatus(id: string, to: OrderStatus): Promise<OrderRow | null> {
  if (PREVIEW_MODE) throw savingNotAvailable('A change of status');
  const row = rowCache.get('orders', id);
  if (!row) throw refused('That order is not loaded. Nothing was changed.');
  if (row.status === to) return row;
  return editRow({ resource: 'orders', id, changes: { status: to } });
}

/** Can a photo be added to this order now? Not to a delivered or cancelled order (F-extra-5), and not past 3. */
export function canAddPhoto(order: Pick<OrderView, 'status' | 'photoIds'>): boolean {
  return !isClosedOrder(order.status) && order.photoIds.length < MAX_ORDER_PHOTOS;
}

/** Adds a photo at the end of an order's list: the upload under the order's id, then the PATCH of `photo_ids` (a biller may only add at the end). Throws a SaveError. */
export async function addOrderPhoto(id: string, photo: PhotoToUpload): Promise<OrderRow | null> {
  if (PREVIEW_MODE) throw savingNotAvailable('A photo of an order');
  const row = rowCache.get('orders', id);
  if (!row) throw refused('That order is not loaded. Nothing was changed.');
  if (isClosedOrder(row.status))
    throw refused(`This order is ${row.status}: no photo can be added to it. Nothing was changed.`);
  const before = Array.isArray(row.photo_ids) ? row.photo_ids : [];
  if (before.length >= MAX_ORDER_PHOTOS)
    throw refused(`An order can have at most ${MAX_ORDER_PHOTOS} photos. Nothing was changed.`);
  try {
    await uploadPhoto(id, photo, 'orders');
  } catch (error) {
    throw new SaveError(error);
  }
  return editRow({ resource: 'orders', id, changes: { photo_ids: [...before, photo.photoId] } });
}

/** The words for an order that could not be saved (C13): the API's own sentence, with a plain line for the refusals that need one. */
export function orderSaveMessage(error: unknown): string {
  if (!(error instanceof SaveError))
    return error instanceof Error ? error.message : 'The order could not be saved.';
  if (error.field === 'order_id' && error.code === 'JV_INVALID_INPUT')
    return 'This order was already saved. Look for it in the list. Nothing more was changed.';
  if (error.field === 'photo_ids' || error.field === 'changes.photo_ids')
    return 'The photos could not be attached to the order. Remove them, add them again and save. Nothing was changed.';
  return error.message;
}

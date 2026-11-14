// FB-F1: the call that makes an order, FB-E1's `POST /v1/orders` (X13 create_order), beside edit.ts and stock.ts so that the store (src/lib/orderStore.ts), which the screens read on every
// draw, makes no network call itself (C9). It carries an Idempotency-Key made by the client once, or the key of an earlier try of the same order that could not be confirmed
// (`ApiError.idempotencyKey`): the answer that was lost comes back and one order is made. The status, the number and the stamps are the API's; an order holds no money.
import { api } from '@/lib/api/client';
import type { CreateOrderResponse } from '@/lib/api/types';
import { SaveError } from './edit';

/** `POST /v1/orders` (201 `{ order }`). Throws a SaveError. */
export async function sendCreateOrder(
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<CreateOrderResponse> {
  try {
    return await api.post<CreateOrderResponse>(
      '/v1/orders',
      body,
      idempotencyKey ? { idempotencyKey } : { idempotent: true }
    );
  } catch (error) {
    throw new SaveError(error);
  }
}

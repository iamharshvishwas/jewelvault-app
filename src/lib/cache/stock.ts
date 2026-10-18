// The calls of the two stock functions, X8 create_design and X9 set_sku_status (spec X8, X9, C5, C6; task WEB06). The write side lives here, beside edit.ts, so that the store
// (src/lib/designStore.ts), which the screens re-read every second, makes no network call itself (C9). Each call carries an Idempotency-Key made by the client once, or the key of
// an earlier try of the same action that could not be confirmed (`ApiError.idempotencyKey`): the answer that was lost then comes back and nothing is made twice.
//
// What the store does with the answer (put the rows in memory unless the session ended) is the store's; these functions only send and give back what the API answered.
// Both throw a SaveError, whose `message` is the plain C13 text and whose `origin` is the ApiError.
import { api } from '@/lib/api/client';
import type { CreateDesignResponse, SetSkuStatusResponse } from '@/lib/api/types';
import { SaveError } from './edit';

const keyed = (idempotencyKey: string | undefined) =>
  idempotencyKey ? { idempotencyKey } : { idempotent: true };

/** X8 `POST /v1/designs` (201). The body is the screen's ids and entries and nothing the API makes. */
export async function sendCreateDesign(
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<CreateDesignResponse> {
  try {
    return await api.post<CreateDesignResponse>('/v1/designs', body, keyed(idempotencyKey));
  } catch (error) {
    throw new SaveError(error);
  }
}

/** X9 `POST /v1/skus/status` (200): the pieces asked, in the order asked. */
export async function sendSkuStatus(
  body: { sku_ids: string[]; status: string; note?: string },
  idempotencyKey?: string
): Promise<SetSkuStatusResponse> {
  try {
    return await api.post<SetSkuStatusResponse>('/v1/skus/status', body, keyed(idempotencyKey));
  } catch (error) {
    throw new SaveError(error);
  }
}

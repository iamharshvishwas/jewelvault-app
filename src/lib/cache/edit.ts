// The write side of the memory: ordinary edits (spec C5 (a), A5, C8, C11). Task WEB05.
//
// An ordinary edit is a change to the content columns of a row that already exists (stock, categories, customers, settings, daily rates). The screen does not wait for the server:
//
//   1. the row is HELD (`rowCache.hold`), so that a copy of it arriving in a poll waits aside until the write ends (C4);
//   2. memory is updated at once with the change, under the stamp the row already has: nothing here makes up an id, a number or a stamp (C11);
//   3. ONE write is awaited: `PATCH /v1/<resource>/<id>` with `{ expected_updated_at, changes }`, where `changes` holds only the fields that were changed and
//      `expected_updated_at` is the exact text of the stamp of the row the person started from, never turned into a date (A5). No Idempotency-Key: the same edit sent twice is
//      refused the second time by the stale check;
//   4. on success the row the server returned replaces the edit; on failure memory goes back to what it was, and the error says why (C13). A `409 JV_STALE` carries the current
//      row in `details.current`: that row goes into memory instead ("the screen reloads"), and the error is marked `stale`;
//   5. the hold ends, whatever happened.
//
// A NEW row (a category, a sub-category, a daily rate) is not an edit: its id, its stamps and its place come from the database (C11), so nothing is shown until the server has
// answered (`insertRow`). A setting is one row per key and the last write wins (`putSettingValue`): it has no stale check, so nothing is reloaded on a conflict.
//
// Nothing here is kept in browser storage (C8). A write that ends after the session has ended (a logout, a 401) puts nothing back in memory (U8).
import { api, isApiError } from '@/lib/api/client';
import type { SettingRow, SyncRows } from '@/lib/api/types';
import { rowCache } from './cache';

export type EditableResource =
  | 'designs'
  | 'skus'
  | 'categories'
  | 'subcategories'
  | 'daily-rates'
  | 'customers';
export type InsertableResource = 'categories' | 'subcategories' | 'daily-rates';

const ADDRESS: Readonly<Record<EditableResource, string>> = {
  designs: '/v1/designs',
  skus: '/v1/skus',
  categories: '/v1/categories',
  subcategories: '/v1/subcategories',
  'daily-rates': '/v1/daily-rates',
  customers: '/v1/customers',
};

// ------------------------------------------------------------------------------------------------ the error of a save

/**
 * Why a save did not happen, for the screen: `message` is the plain text of C13 (the API's own sentence for a refused input, with "Nothing was changed."), prefixed with the
 * name of the row when several rows were being saved. `stale` means somebody else saved the row first: the current row is in memory now and the person's change was not made.
 * `saved` is how many rows of this save were written before the one that failed.
 */
export class SaveError extends Error {
  /** The S8 code, one of the client's own (NETWORK, GATEWAY, BAD_RESPONSE), or LOCAL for a refusal made here before any call. */
  readonly code: string;
  readonly status: number;
  readonly stale: boolean;
  /** The input the API (or this module) found fault with, such as `changes.customer_net_weight`. */
  readonly field: string | null;
  readonly saved: number;
  readonly label: string | null;
  readonly origin: unknown;

  constructor(cause: unknown, options: { label?: string | null; saved?: number } = {}) {
    const origin = cause instanceof SaveError ? cause.origin : cause;
    const text = origin instanceof Error ? origin.message : String(origin);
    super(options.label ? `${options.label}: ${text}` : text);
    this.name = 'SaveError';
    this.origin = origin;
    this.label = options.label ?? null;
    this.saved = options.saved ?? 0;
    if (isApiError(origin)) {
      this.code = origin.code;
      this.status = origin.status;
      this.stale = origin.code === 'JV_STALE';
      const field = origin.details.field;
      this.field = typeof field === 'string' ? field : null;
    } else {
      this.code = 'LOCAL';
      this.status = 0;
      this.stale = false;
      this.field = null;
    }
  }
}

const localError = (message: string) => new SaveError(new Error(message));

// ------------------------------------------------------------------------------------------------ decimals as text (S3)

/**
 * A decimal number from a screen as the text the API takes: the shortest text of the number, padded with zeros to the scale of its column. Nothing is rounded: a number with more
 * decimals than the column has stays as it is, for the API to refuse, rather than being cut here without a word. No float arithmetic.
 */
export function decimalText(value: number, decimals: number): string {
  const text = String(value);
  if (!Number.isFinite(value) || value < 0 || /e/i.test(text))
    throw new RangeError(`${text} is not an amount or a weight that can be saved.`);
  const [whole, fraction = ''] = text.split('.');
  return fraction.length >= decimals ? text : `${whole}.${fraction.padEnd(decimals, '0')}`;
}

const stripped = (text: string): string => {
  const [whole, fraction = ''] = text.trim().split('.');
  const digits = fraction.replace(/0+$/, '');
  const head = whole.replace(/^0+(?=\d)/, '');
  return digits === '' ? head : `${head}.${digits}`;
};

/** Do two decimal texts say the same number ("10.5" and "10.500")? By the digits, not by float. */
export function sameDecimal(a: string, b: string): boolean {
  return stripped(a) === stripped(b);
}

// ------------------------------------------------------------------------------------------------ an edit of an existing row

export interface EditSpec<R extends EditableResource> {
  resource: R;
  id: string;
  /** Only the fields that changed, as the API takes them (text for money and weight). */
  changes: Record<string, unknown>;
  /** The `updated_at` text of the row the person started from. Default: the row in memory now. */
  expectedUpdatedAt?: string;
  /** What the row is called in a message when several rows are saved at once (a design number, a piece number). */
  label?: string;
}

/** An edit that is in memory and held, and waits to be sent. */
export interface PendingEdit {
  readonly label: string;
  /** Sends the write and ends the edit: the returned row replaces the optimistic one, or memory is rolled back. Throws what the client threw. */
  send(): Promise<unknown>;
  /** The edit will not be sent: memory goes back and the hold ends. */
  cancel(): void;
}

function staleRow(error: unknown): object | null {
  if (!isApiError(error) || error.code !== 'JV_STALE') return null;
  const current = error.details.current;
  return current !== null && typeof current === 'object' ? (current as object) : null;
}

/**
 * Holds the row, shows the change in memory at once and gives back the edit to send. Returns null when there is nothing to change. Throws a SaveError when the row is not in
 * memory or its last edit is still on its way (a second edit is refused, not queued: C6).
 */
export function beginEdit<R extends EditableResource>(spec: EditSpec<R>): PendingEdit | null {
  if (Object.keys(spec.changes).length === 0) return null;
  const { resource, id, changes } = spec;
  const before = rowCache.get(resource, id);
  if (!before) throw localError('That record is not loaded.');
  if (rowCache.isHeld(resource, id))
    throw localError('This record is still being saved. Wait a moment, then try again.');

  const session = rowCache.generation();
  const expected = spec.expectedUpdatedAt ?? (before as { updated_at: string }).updated_at;
  const release = rowCache.hold(resource, id);
  // the optimistic row keeps the stamp it has: the cache keeps a copy whose stamp is not older, and nothing is made up
  rowCache.merge(resource, [{ ...before, ...changes } as never]);
  let ended = false;
  const sessionGone = () => rowCache.generation() !== session;

  return {
    label: spec.label ?? '',
    cancel() {
      if (ended) return;
      ended = true;
      if (!sessionGone()) rowCache.merge(resource, [before as never]);
      release();
    },
    async send() {
      if (ended) throw localError('This change was already sent.');
      ended = true;
      try {
        const answer = await api.patch<{ row: SyncRows[R] }>(`${ADDRESS[resource]}/${id}`, {
          expected_updated_at: expected,
          changes,
        });
        if (!sessionGone()) rowCache.merge(resource, [answer.row]);
        return answer.row;
      } catch (error) {
        if (!sessionGone()) {
          // somebody else saved first: their row is what memory holds now; any other failure puts back what was there
          rowCache.merge(resource, [(staleRow(error) ?? before) as never]);
        }
        throw error;
      } finally {
        release();
      }
    },
  };
}

/**
 * Sends the edits one after another and stops at the first failure: the ones not sent yet are rolled back, the ones sent stay saved. Resolves with how many were written; throws a
 * SaveError (with `saved`) for the first that failed.
 */
export async function sendEdits(edits: readonly PendingEdit[]): Promise<number> {
  let saved = 0;
  for (let i = 0; i < edits.length; i += 1) {
    try {
      await edits[i].send();
      saved += 1;
    } catch (error) {
      for (let j = i + 1; j < edits.length; j += 1) edits[j].cancel();
      // a row is named in the message only when there are several (which piece failed); a single row needs no name
      throw new SaveError(error, {
        saved,
        label: edits.length > 1 ? edits[i].label || null : null,
      });
    }
  }
  return saved;
}

/** Begins every edit (nothing is held if one of them cannot begin). Skips the ones with nothing to change. */
export function beginEdits(specs: ReadonlyArray<EditSpec<EditableResource>>): PendingEdit[] {
  const begun: PendingEdit[] = [];
  try {
    for (const spec of specs) {
      const edit = beginEdit(spec);
      if (edit) begun.push(edit);
    }
  } catch (error) {
    for (const edit of begun) edit.cancel();
    throw error;
  }
  return begun;
}

/** One edit, begun and sent. Resolves with the row the server returned, or null when there was nothing to change. */
export async function editRow<R extends EditableResource>(
  spec: EditSpec<R>
): Promise<SyncRows[R] | null> {
  const edit = beginEdit(spec);
  if (!edit) return null;
  try {
    return (await edit.send()) as SyncRows[R];
  } catch (error) {
    throw new SaveError(error);
  }
}

// ------------------------------------------------------------------------------------------------ a new row

/**
 * A new category, sub-category or daily rate. Nothing is put in memory until the server has answered, and the row is the one it returned: the id, the stamps and the person
 * columns are the database's (C11). Throws a SaveError.
 */
export async function insertRow<R extends InsertableResource>(
  resource: R,
  body: Record<string, unknown>
): Promise<SyncRows[R]> {
  const session = rowCache.generation();
  try {
    const answer = await api.post<{ row: SyncRows[R] }>(ADDRESS[resource], body);
    if (rowCache.generation() === session) rowCache.merge(resource, [answer.row]);
    return answer.row;
  } catch (error) {
    throw new SaveError(error);
  }
}

// ------------------------------------------------------------------------------------------------ a setting

/**
 * `PUT /v1/settings/<key>` with `{ value }`: one row per key, and the last write wins (A4, API13b): the body carries no stamp, so a conflict reloads nothing. Memory shows the new
 * value at once and goes back if the write fails. A key that has no row yet is shown after the answer. Throws a SaveError.
 */
export async function putSettingValue(key: string, value: object): Promise<SettingRow> {
  const session = rowCache.generation();
  const before = rowCache.get('settings', key);
  if (before && rowCache.isHeld('settings', key))
    throw localError('This setting is still being saved. Wait a moment, then try again.');
  const release = before ? rowCache.hold('settings', key) : null;
  if (before) rowCache.merge('settings', [{ ...before, value }]);
  try {
    const answer = await api.put<{ row: SettingRow }>(`/v1/settings/${encodeURIComponent(key)}`, {
      value,
    });
    if (rowCache.generation() === session) rowCache.merge('settings', [answer.row]);
    return answer.row;
  } catch (error) {
    if (before && rowCache.generation() === session) rowCache.merge('settings', [before]);
    throw new SaveError(error);
  } finally {
    release?.();
  }
}

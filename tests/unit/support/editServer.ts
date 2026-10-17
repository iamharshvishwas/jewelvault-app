// A fake JewelVault server for the ordinary edits (WEB05), spoken to through the REAL API client by a stubbed `fetch`.
//
// It answers what API13 and API13b built and nothing more: `PATCH /v1/<designs|skus|categories|subcategories|daily-rates|customers>/:id` with
// `{expected_updated_at, changes}` (200 `{row}`, 409 JV_STALE with the row in `details.current`, 404), `POST` of categories, subcategories and daily rates
// (201 `{row}` with an id and stamps of its own making) and `PUT /v1/settings/:key` with `{value}` (no stale check: the last write wins). Rows carry the exact
// six-decimal stamps of the wire; decimal columns come back with the scale of their column, as the real API writes them.
//
// A test can make the server wait (`pause()`, then `release()` for the next answer or `releaseAll()`), refuse the next call (`refuseNext`), or lose it
// (`dropNext`: the network fails, nothing reaches the server).
import { at } from './rows';

type Row = Record<string, unknown>;

export interface EditCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An S8 refusal with the API's own sentence. */
export const refusal = (
  code: string,
  status: number,
  message = 'made up by the test',
  details: Record<string, unknown> = {}
) => json(status, { error: { code, message, details }, request_id: 'req-edit' });

const SCALE: Record<string, number> = {
  gross_weight: 3,
  customer_net_weight: 3,
  stone_weight: 3,
  kundan_weight: 3,
  piroi: 2,
  labour_retail: 2,
  labour_semi: 2,
  labour_wholesale: 2,
  rate_per_gram: 2,
};

/** "10.5" is "10.500" in a DECIMAL(12,3) column: the answer of the real API has the scale of the column. */
function scaled(field: string, value: unknown): unknown {
  const decimals = SCALE[field];
  if (decimals === undefined || typeof value !== 'string') return value;
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(decimals, '0')}`;
}

const PATCHABLE = new Set([
  'designs',
  'skus',
  'categories',
  'subcategories',
  'daily-rates',
  'customers',
]);
const INSERTABLE = new Set(['categories', 'subcategories', 'daily-rates']);

export class FakeEditServer {
  readonly calls: EditCall[] = [];
  /** Every row the server has, by resource and key. */
  readonly tables = new Map<string, Map<string, Row>>();
  /** Runs before a call is answered: return a Response to answer with it. */
  onRequest?: (call: EditCall) => Response | undefined | Promise<Response | undefined>;
  private refusals: Response[] = [];
  private drops = 0;
  private paused = false;
  private waiting: Array<() => void> = [];
  private tick = 0;
  private ids = 0;

  // ---- the server's data

  /** Puts a row on the server (the same one the test puts in the cache). */
  seed(resource: string, row: Row, keyField = resource === 'settings' ? 'setting_key' : 'id'): Row {
    const table = this.tables.get(resource) ?? new Map<string, Row>();
    table.set(String(row[keyField]), { ...row });
    this.tables.set(resource, table);
    return row;
  }

  row(resource: string, key: string): Row | undefined {
    return this.tables.get(resource)?.get(key);
  }

  /** Somebody else changes a row on the server: it gets a new stamp. */
  changeElsewhere(resource: string, key: string, fields: Row): Row {
    const row = this.row(resource, key);
    if (!row) throw new Error(`no ${resource} row ${key}`);
    Object.assign(row, fields, { updated_at: this.nextStamp() });
    return row;
  }

  private nextStamp(): string {
    this.tick += 1;
    return at(1000 + this.tick, 123);
  }

  // ---- the behaviour of a test

  refuseNext(response: Response): void {
    this.refusals.push(response);
  }

  /** The next call never gets an answer: the network fails (nothing reaches the server). */
  dropNext(): void {
    this.drops += 1;
  }

  /** From now on a call waits until `release()`. */
  pause(): void {
    this.paused = true;
  }

  /** Lets the oldest waiting call be answered. */
  release(): void {
    this.waiting.shift()?.();
  }

  releaseAll(): void {
    this.paused = false;
    for (const wake of this.waiting.splice(0)) wake();
  }

  /** Resolves when the server has received `count` calls. */
  async received(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.calls.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.calls.length < count)
      throw new Error(`only ${this.calls.length} calls reached the server, wanted ${count}`);
  }

  summary(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }

  // ---- the server

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const call: EditCall = {
      method: init.method ?? 'GET',
      path: url.pathname,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
    };
    if (this.drops > 0) {
      this.drops -= 1;
      this.calls.push(call);
      throw new TypeError('Failed to fetch');
    }
    this.calls.push(call);
    if (this.paused) await new Promise<void>((resolve) => this.waiting.push(resolve));
    const override = await this.onRequest?.(call);
    if (override) return override;
    const refused = this.refusals.shift();
    if (refused) return refused;
    return this.answer(call);
  };

  private answer(call: EditCall): Response {
    const parts = call.path.split('/').filter(Boolean); // v1, <resource>, <id>
    const resource = parts[1];
    const key = parts[2] !== undefined ? decodeURIComponent(parts[2]) : undefined;
    const body = call.body ?? {};

    if (call.method === 'PUT' && resource === 'settings' && key !== undefined) {
      if (Object.keys(body).join() !== 'value')
        return refusal('JV_INVALID_INPUT', 422, 'the body is { value } and nothing else');
      const table = this.tables.get('settings') ?? new Map<string, Row>();
      this.tables.set('settings', table);
      const before = table.get(key);
      const row: Row = {
        setting_key: key,
        created_at: before?.created_at ?? at(0),
        created_by: null,
        updated_by: null,
        ...before,
        value: body.value,
        updated_at: this.nextStamp(),
      };
      table.set(key, row);
      return json(before ? 200 : 201, { row });
    }

    if (call.method === 'PATCH' && PATCHABLE.has(resource) && key !== undefined) {
      const stored = this.row(resource, key);
      if (!stored) return refusal('JV_NOT_FOUND', 404, 'That record does not exist.');
      if (typeof body.expected_updated_at !== 'string' || typeof body.changes !== 'object')
        return refusal('JV_INVALID_INPUT', 422, 'expected_updated_at and changes are required');
      if (body.expected_updated_at !== stored.updated_at) {
        return refusal('JV_STALE', 409, 'This row was changed.', { current: stored });
      }
      for (const [field, value] of Object.entries(body.changes as Row))
        stored[field] = scaled(field, value);
      stored.updated_at = this.nextStamp();
      return json(200, { row: stored });
    }

    if (call.method === 'POST' && INSERTABLE.has(resource) && key === undefined) {
      this.ids += 1;
      const row: Row = {
        id: `ffffffff-0000-4000-8000-${String(this.ids).padStart(12, '0')}`,
        ...Object.fromEntries(Object.entries(body).map(([f, v]) => [f, scaled(f, v)])),
        ...(resource === 'categories' || resource === 'subcategories' ? { active: true } : {}),
        created_at: this.nextStamp(),
        created_by: null,
        updated_by: null,
      };
      row.updated_at = row.created_at;
      const table = this.tables.get(resource) ?? new Map<string, Row>();
      table.set(String(row.id), row);
      this.tables.set(resource, table);
      return json(201, { row });
    }

    return refusal('JV_NOT_FOUND', 404, 'No such route in the fake server.');
  }
}

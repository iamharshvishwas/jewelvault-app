// A fake JewelVault server for the stock functions and the photos (WEB06), spoken to through the REAL API client by a stubbed `fetch`.
//
// It answers what API16 and API17 built and nothing more:
//   PUT  /v1/designs/:design_id/photos/:photo_id?kind=full|thumb   raw bytes; 201 `{photo_id, design_id, kind, mime, byte_size, sha256}`, 409 JV_NOT_ALLOWED with `details.reason` (duplicate,
//        design_full), 415 for a body that is not an image (the first bytes decide), 413 over 2 MiB
//   POST /v1/designs            X8 create_design: 201 `{design, skus}` (+ `sku_private` for the owner), numbers made here, 422 on `design_id`, `design.photo_ids` and `design.*`, 403 JV_FORBIDDEN for a
//        staff caller's `pieces[i].original_net_weight`; the same Idempotency-Key and body is answered again with the first answer, the same key with another body is a 422
//   POST /v1/skus/status        X9 set_sku_status: 200 `{skus}` in the order asked; a Sold piece is 409 JV_NOT_ALLOWED with `details.sku_ids`; `Sold` as the status is a 422
// Rows carry the exact six-decimal stamps of the wire and the scale of their columns.
//
// A test can make a call wait (`pause()`, `release()`), refuse the next call (`refuseNext`), or lose it (`dropNext`: the network fails and nothing reaches the server).
import { at, designRow, skuPrivateRow, skuRow, uuid } from './rows';

type Row = Record<string, unknown>;

export interface StockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** The JSON body, when there is one. */
  body: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The raw body of an upload. */
  bytes: Blob | undefined;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const refusal = (
  code: string,
  status: number,
  message = 'made up by the test',
  details: Record<string, unknown> = {}
) => json(status, { error: { code, message, details }, request_id: 'req-stock' });

const SCALE: Record<string, number> = {
  gross_weight: 3,
  customer_net_weight: 3,
  stone_weight: 3,
  kundan_weight: 3,
  piroi: 2,
  labour_retail: 2,
  labour_semi: 2,
  labour_wholesale: 2,
};
const scaled = (field: string, value: unknown): unknown => {
  const decimals = SCALE[field];
  if (decimals === undefined || typeof value !== 'string') return value;
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(decimals, '0')}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = [
  'In Stock',
  'Reserved',
  'On Approval',
  'Sold',
  'Returned',
  'Repair',
  'Transferred',
  'Missing',
  'Damaged',
  'Archived',
];

export interface StoredPhoto {
  designId: string;
  kind: string;
  bytes: Blob;
  contentType: string;
}

export class FakeStockServer {
  readonly calls: StockCall[] = [];
  readonly photos = new Map<string, StoredPhoto>();
  readonly designs = new Map<string, Row>();
  readonly skus = new Map<string, Row>();
  readonly skuPrivate = new Map<string, Row>();
  /** Who is calling: staff may not send the owner's weight and get no `sku_private` back. */
  role: 'owner' | 'biller' | 'staff' = 'owner';
  /** The categories of the shop (id, prefix), for the number of a design. */
  categories = new Map<string, string>([[uuid(101), 'RING']]);
  /** Runs before a call is answered: return a Response to answer with it. */
  onRequest?: (call: StockCall) => Response | undefined | Promise<Response | undefined>;
  private refusals: Response[] = [];
  private drops = 0;
  private paused = false;
  private waiting: Array<() => void> = [];
  private tick = 0;
  private numbers = new Map<string, number>();
  private claims = new Map<string, { body: string; response: unknown }>();
  private ids = 0;

  private nextStamp(): string {
    this.tick += 1;
    return at(2000 + this.tick, 777);
  }

  refuseNext(response: Response): void {
    this.refusals.push(response);
  }
  dropNext(): void {
    this.drops += 1;
  }
  pause(): void {
    this.paused = true;
  }
  release(): void {
    this.waiting.shift()?.();
  }
  releaseAll(): void {
    this.paused = false;
    for (const wake of this.waiting.splice(0)) wake();
  }

  summary(): string[] {
    return this.calls.map(
      (c) => `${c.method} ${c.path}${c.query.kind ? `?kind=${c.query.kind}` : ''}`
    );
  }

  /** Puts a design of the server's own (as if another person had made it). */
  seedSku(row: Row): void {
    this.skus.set(String(row.id), { ...row });
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const body = init.body;
    const call: StockCall = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: typeof body === 'string' ? JSON.parse(body) : undefined,
      bytes: body instanceof Blob ? body : undefined,
    };
    this.calls.push(call);
    if (this.drops > 0) {
      this.drops -= 1;
      throw new TypeError('Failed to fetch');
    }
    if (this.paused) await new Promise<void>((resolve) => this.waiting.push(resolve));
    const override = await this.onRequest?.(call);
    if (override) return override;
    const refused = this.refusals.shift();
    if (refused) return refused;
    return this.answer(call);
  };

  private async answer(call: StockCall): Promise<Response> {
    const parts = call.path.split('/').filter(Boolean);
    if (
      call.method === 'PUT' &&
      parts[0] === 'v1' &&
      parts[1] === 'designs' &&
      parts[3] === 'photos'
    )
      return this.upload(call, parts[2], parts[4]);
    if (call.method === 'POST' && call.path === '/v1/designs') return this.createDesign(call);
    if (call.method === 'POST' && call.path === '/v1/skus/status') return this.setStatus(call);
    return refusal('JV_NOT_FOUND', 404, 'No such route in the fake server.');
  }

  // ---- photos (API17)

  private async upload(call: StockCall, designId: string, photoId: string): Promise<Response> {
    const kind = call.query.kind;
    if (!UUID.test(designId) || !UUID.test(photoId))
      return refusal('JV_INVALID_INPUT', 422, 'design_id must be a UUID', { field: 'design_id' });
    if (kind !== 'full' && kind !== 'thumb')
      return refusal('JV_INVALID_INPUT', 422, 'kind must be full or thumb', { field: 'kind' });
    const bytes = call.bytes;
    if (!bytes) return refusal('JV_UNSUPPORTED_MEDIA_TYPE', 415, 'Send the photo as raw bytes.');
    if (bytes.size > 2 * 1024 * 1024)
      return refusal('JV_PAYLOAD_TOO_LARGE', 413, 'A photo can be at most 2 MiB.');
    const head = new Uint8Array(await bytes.slice(0, 3).arrayBuffer());
    if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff))
      return refusal(
        'JV_UNSUPPORTED_MEDIA_TYPE',
        415,
        'This file is not a JPEG, PNG or WebP image.'
      );
    if (this.photos.has(`${photoId}:${kind}`))
      return refusal('JV_NOT_ALLOWED', 409, 'This photo was already uploaded.', {
        field: 'photo_id',
        reason: 'duplicate',
      });
    const mine = new Set(
      [...this.photos.entries()]
        .filter(([, p]) => p.designId === designId)
        .map(([key]) => key.split(':')[0])
    );
    if (!mine.has(photoId) && mine.size >= 3)
      return refusal('JV_NOT_ALLOWED', 409, 'A design can have at most 3 photos.', {
        field: 'design_id',
        reason: 'design_full',
      });
    this.photos.set(`${photoId}:${kind}`, {
      designId,
      kind,
      bytes,
      contentType: call.headers['content-type'] ?? '',
    });
    return json(201, {
      photo_id: photoId,
      design_id: designId,
      kind,
      mime: 'image/jpeg',
      byte_size: bytes.size,
      sha256: 'a'.repeat(64),
    });
  }

  // ---- X8

  private async createDesign(call: StockCall): Promise<Response> {
    const key = call.headers['idempotency-key'];
    if (!key || !UUID.test(key))
      return refusal('JV_INVALID_INPUT', 422, 'Idempotency-Key is required');
    const body = call.body ?? {};
    const text = JSON.stringify(body);
    const claim = this.claims.get(key);
    if (claim && claim.body !== text)
      return refusal('JV_INVALID_INPUT', 422, 'This Idempotency-Key was used for another request.');
    const role = this.role;
    const design = (body.design ?? {}) as Row;
    const pieces = (body.pieces ?? []) as Row[];
    // the rules of the body that need no database
    const allowed = new Set(['design_id', 'design', 'pieces']);
    for (const name of Object.keys(body))
      if (!allowed.has(name))
        return refusal('JV_INVALID_INPUT', 422, `${name} is not allowed`, { field: name });
    const forbiddenInDesign = ['design_no', 'id', 'status', 'location', 'created_at', 'updated_at'];
    for (const name of forbiddenInDesign)
      if (name in design)
        return refusal('JV_INVALID_INPUT', 422, `design.${name} is not allowed`, {
          field: `design.${name}`,
        });
    if (typeof body.design_id !== 'string' || !UUID.test(body.design_id))
      return refusal('JV_INVALID_INPUT', 422, 'design_id must be a UUID', { field: 'design_id' });
    for (const [i, group] of pieces.entries()) {
      for (const name of ['sku_no', 'barcode', 'status', 'location', 'id'])
        if (name in group)
          return refusal('JV_INVALID_INPUT', 422, `pieces[${i}].${name} is not allowed`, {
            field: `pieces[${i}].${name}`,
          });
      for (const name of ['labour_retail', 'labour_semi', 'labour_wholesale'])
        if (group[name] === '')
          return refusal(
            'JV_INVALID_INPUT',
            422,
            `pieces[${i}].${name} must be plain decimal text`,
            { field: `pieces[${i}].${name}` }
          );
    }
    if (pieces.reduce((n, g) => n + Number(g.pieces ?? 0), 0) > 500)
      return refusal('JV_INVALID_INPUT', 422, 'pieces must make at most 500 pieces in all', {
        field: 'pieces',
      });
    const photoIds = (design.photo_ids ?? []) as string[];
    const primary = (design.primary_photo_id ?? photoIds[0] ?? null) as string | null;
    if (primary !== null && !photoIds.includes(primary))
      return refusal(
        'JV_INVALID_INPUT',
        422,
        "design.primary_photo_id must be one of the design's photo ids",
        { field: 'design.primary_photo_id' }
      );
    // the claim, then the role check
    if (claim) return json(201, claim.response, { 'idempotent-replay': 'true' });
    const withWeight = pieces.findIndex((g) => g.original_net_weight !== undefined);
    if (role !== 'owner' && withWeight >= 0)
      return refusal(
        'JV_FORBIDDEN',
        403,
        'The original net weight can only be entered by the owner.',
        { field: `pieces[${withWeight}].original_net_weight` }
      );
    // the checks
    if (this.designs.has(String(body.design_id)))
      return refusal('JV_INVALID_INPUT', 422, 'design_id is already used by a design', {
        field: 'design_id',
      });
    const prefix = this.categories.get(String(design.category_id));
    if (prefix === undefined)
      return refusal('JV_INVALID_INPUT', 422, 'design.category_id is not a category', {
        field: 'design.category_id',
      });
    if (photoIds.length > 3 || new Set(photoIds).size !== photoIds.length)
      return refusal(
        'JV_INVALID_INPUT',
        422,
        'design.photo_ids must be at most 3 different photos',
        { field: 'design.photo_ids' }
      );
    for (const id of photoIds) {
      const full = this.photos.get(`${id}:full`);
      const thumb = this.photos.get(`${id}:thumb`);
      if (!full || !thumb || full.designId !== body.design_id || thumb.designId !== body.design_id)
        return refusal(
          'JV_INVALID_INPUT',
          422,
          'design.photo_ids names a photo that is not stored for this design',
          { field: 'design.photo_ids' }
        );
    }
    // the numbers, then the writes
    const n = (this.numbers.get(prefix) ?? 0) + 1;
    this.numbers.set(prefix, n);
    const designNo = `${prefix}-${String(n).padStart(5, '0')}`;
    const designRowOut = designRow(0, {
      id: String(body.design_id),
      design_no: designNo,
      name: (design.name as string | undefined) ?? null,
      category_id: String(design.category_id),
      subcategory_id: (design.subcategory_id as string | null | undefined) ?? null,
      material: design.material as 'Gold' | 'Silver',
      purity: String(design.purity),
      selling_method: design.selling_method as 'By Weight' | 'Per Piece',
      description: (design.description as string | undefined) ?? null,
      notes: (design.notes as string | undefined) ?? null,
      tags: (design.tags as string[] | undefined) ?? [],
      primary_photo_id: primary,
      photo_ids: photoIds,
      created_at: this.nextStamp(),
      updated_at: this.nextStamp(),
    });
    this.designs.set(designRowOut.id, designRowOut as unknown as Row);
    const skus: Row[] = [];
    const privates: Row[] = [];
    let piece = 0;
    for (const group of pieces) {
      for (let i = 0; i < Number(group.pieces); i += 1) {
        piece += 1;
        this.ids += 1;
        const skuNo = `${designNo}-${String(piece).padStart(3, '0')}`;
        const retail = (group.labour_retail as string | null | undefined) ?? '0.00';
        const wholesale = (group.labour_wholesale as string | null | undefined) ?? retail;
        const semi = (group.labour_semi as string | null | undefined) ?? wholesale;
        const row = skuRow(0, 0, {
          id: `eeeeeeee-0000-4000-8000-${String(this.ids).padStart(12, '0')}`,
          design_id: designRowOut.id,
          sku_no: skuNo,
          barcode: `BC-${skuNo}`,
          gross_weight: scaled('gross_weight', group.gross_weight ?? '0') as string,
          customer_net_weight: scaled(
            'customer_net_weight',
            group.customer_net_weight ?? '0'
          ) as string,
          stones: Number(group.stones ?? 0),
          stone_weight: scaled('stone_weight', group.stone_weight ?? '0') as string,
          kundan: Number(group.kundan ?? 0),
          kundan_weight: scaled('kundan_weight', group.kundan_weight ?? '0') as string,
          piroi: scaled('piroi', group.piroi ?? '0') as string,
          labour_retail: scaled('labour_retail', retail) as string,
          labour_semi: scaled('labour_semi', semi) as string,
          labour_wholesale: scaled('labour_wholesale', wholesale) as string,
          status: 'In Stock',
          location: 'Main Showroom',
          notes: (group.notes as string | undefined) ?? null,
          created_at: designRowOut.created_at,
          updated_at: designRowOut.created_at,
        });
        this.skus.set(row.id, row as unknown as Row);
        skus.push(row as unknown as Row);
        if (role === 'owner' && group.original_net_weight !== undefined) {
          const p = {
            ...skuPrivateRow(0, String(scaled('gross_weight', group.original_net_weight))),
            sku_id: row.id,
          };
          this.skuPrivate.set(row.id, p as unknown as Row);
          privates.push(p as unknown as Row);
        }
      }
    }
    const answer: Row = { design: designRowOut as unknown as Row, skus };
    if (role === 'owner') answer.sku_private = privates;
    this.claims.set(key, { body: text, response: answer });
    return json(201, answer);
  }

  // ---- X9

  private async setStatus(call: StockCall): Promise<Response> {
    const key = call.headers['idempotency-key'];
    if (!key || !UUID.test(key))
      return refusal('JV_INVALID_INPUT', 422, 'Idempotency-Key is required');
    const body = call.body ?? {};
    const ids = body.sku_ids as string[] | undefined;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500)
      return refusal('JV_INVALID_INPUT', 422, 'sku_ids must be a list of 1 to 500 piece ids', {
        field: 'sku_ids',
      });
    if (!STATUSES.includes(String(body.status)) || body.status === 'Sold')
      return refusal('JV_INVALID_INPUT', 422, 'status cannot be Sold here', { field: 'status' });
    for (const [i, id] of ids.entries())
      if (!this.skus.has(id))
        return refusal('JV_INVALID_INPUT', 422, `sku_ids[${i}] is not a piece`, {
          field: `sku_ids[${i}]`,
        });
    const sold = ids.filter((id) => this.skus.get(id)?.status === 'Sold');
    if (sold.length > 0)
      return refusal(
        'JV_NOT_ALLOWED',
        409,
        'A piece that is Sold cannot be changed here. Cancel or re-issue its bill instead.',
        { field: 'sku_ids', sku_ids: sold }
      );
    const stamp = this.nextStamp();
    for (const id of ids) {
      const row = this.skus.get(id) as Row;
      if (row.status === body.status) continue;
      row.status = body.status;
      row.archived_at = body.status === 'Archived' ? stamp : null;
      row.updated_at = stamp;
    }
    return json(200, { skus: ids.map((id) => this.skus.get(id)) });
  }
}

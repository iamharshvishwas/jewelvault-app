// WEB05: the stock-side stores write to the API (spec C5 (a), C8, C11). The unit half of PT-W5, T-E05 and T-C01; the browser halves are tests/e2e/stock-edit.spec.ts.
//
//   PT-W5  an ordinary edit updates memory at once, awaits one write with only the changed fields and the exact updated_at text, replaces the row on success and rolls back
//          with the reason on failure, a stale edit reloads the row; settings are one row per key and the last write wins; categories, sub-categories and daily rates
//   T-E05  (clause) no business data in browser storage once the stock stores are on the API
//   T-C01  (clause) the browser cache never makes up an id or a number except a new design's id (C11)
//
// The stores are the real ones over the real API client; only `fetch` is a stand-in (tests/unit/support/editServer.ts, which answers as API13 and API13b do).
// They read the flag of the preview build when they load, so each case imports a fresh copy of them over a fake `window`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEditServer, refusal } from './support/editServer';
import {
  at,
  categoryRow,
  designRow,
  rateRow,
  settingRow,
  skuPrivateRow,
  skuRow,
  subcategoryRow,
  userRow,
  uuid,
} from './support/rows';

// ------------------------------------------------------------------------------------------------ the world of a case

/** A storage that records every touch, so a test can say "never touched". */
function fakeStorage() {
  const data = new Map<string, string>();
  const touched: string[] = [];
  const api = {
    getItem: (key: string) => {
      touched.push(`get ${key}`);
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem: (key: string, value: string) => {
      touched.push(`set ${key}`);
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      touched.push(`remove ${key}`);
      data.delete(key);
    },
    clear: () => {
      touched.push('clear');
      data.clear();
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  return { api, data, touched };
}

async function world({ preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4229');
  const local = fakeStorage();
  const session = fakeStorage();
  vi.stubGlobal('window', { localStorage: local.api, sessionStorage: session.api });
  const server = new FakeEditServer();
  vi.stubGlobal('fetch', server.fetch);
  const [cacheModule, edit, designs, catalog, settings] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/cache/edit'),
    import('@/lib/designStore'),
    import('@/lib/catalogStore'),
    import('@/lib/settingsStore'),
  ]);
  const cache = cacheModule.rowCache;
  type Resource = Parameters<typeof cache.merge>[0];
  /** Rows in memory and on the server alike: what the hydrate left, and what the server has. */
  const put = (resource: Resource, rows: readonly object[]) => {
    cache.merge(resource, rows as never);
    for (const row of rows) server.seed(resource, row as Record<string, unknown>);
  };
  return {
    server,
    cache,
    edit,
    designs,
    catalog,
    settings,
    put,
    storageTouched: () => [...local.touched, ...session.touched],
  };
}
type World = Awaited<ReturnType<typeof world>>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The stamp of the piece the cases edit has microseconds and trailing zeros, so that a round trip through a Date would show. */
const SKU_STAMP = at(10, 100); // 2026-10-15T09:00:10.000100Z

/** What the hydrate leaves in memory (and the server has): two categories, four sub-categories, two designs, three pieces, the owner's weight, the settings and a rate. */
function fillShop(w: World) {
  w.put('users', [userRow(1, { full_name: 'Asha Verma' })]);
  w.put('categories', [
    categoryRow(1, 'Ring', 'RING'),
    categoryRow(2, 'Earrings', 'ER'),
    categoryRow(3, 'Retired', 'RET', { active: false }),
  ]);
  w.put('subcategories', [
    subcategoryRow(1, 1, 'Kundan'),
    subcategoryRow(2, 1, 'Casting'),
    subcategoryRow(3, 1, 'Old style', { active: false }),
    subcategoryRow(4, 2, 'Jadau'),
  ]);
  w.put('designs', [
    designRow(1, { name: 'Bridal ring', category_id: uuid(101), subcategory_id: uuid(201) }),
    designRow(2, { name: 'Jhumka', category_id: uuid(102), subcategory_id: uuid(204) }),
  ]);
  w.put('skus', [
    skuRow(1, 1, { updated_at: SKU_STAMP }),
    skuRow(2, 1, { notes: 'first' }),
    skuRow(3, 2),
  ]);
  w.put('sku-private', [skuPrivateRow(1, '10.125')]);
  w.put('settings', [
    settingRow('business', { displayName: 'Jaishri Gold Palace', phone: '0141', extra: 1 }),
    settingRow('estimate', { prefix: 'JV', roundOff: true, footerNote: 'Estimate only' }),
    settingRow('numbering', { designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' }),
    settingRow('taxes', { gstEnabled: false, gstPercent: 0, estimateTaxPercent: 0 }),
    settingRow('materials', [
      { name: 'Gold', purities: ['18K', '22K'] },
      { name: 'Silver', purities: ['925'] },
    ]),
    settingRow('locations', ['Main Showroom', 'Workshop']),
  ]);
  w.put('daily-rates', [
    rateRow(1, {
      material: 'Gold',
      purity: '22K',
      rate_per_gram: '7350.00',
      rate_date: '2026-10-14',
    }),
    rateRow(2, {
      material: 'Gold',
      purity: '22K',
      rate_per_gram: '7400.00',
      rate_date: '2026-10-15',
    }),
  ]);
}

const designOf = (w: World, id = uuid(301)) => {
  const design = w.designs.getDesigns().find((d) => d.id === id);
  if (!design) throw new Error(`no design ${id}`);
  return design;
};
const pieceOf = (w: World, id: string) => {
  const sku = w.designs
    .getDesigns()
    .flatMap((d) => d.skus)
    .find((s) => s.id === id);
  if (!sku) throw new Error(`no piece ${id}`);
  return sku;
};
const skuId = (n: number) => uuid(1000 + n);

/** What the screen does: a working copy of the design as it was when the person started, and the same design with their changes. */
function startEditing(w: World, id = uuid(301)) {
  const base = designOf(w, id);
  return { base, draft: structuredClone(base) };
}

// ================================================================================================ PT-W5

describe('PT-W5 an ordinary edit shows in memory at once and awaits ONE write with only the changed fields (C5 (a), A5)', () => {
  it('shows the new value before the server has answered, marks the row pending, and sends one PATCH with the changed fields and the exact updated_at text', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    w.server.pause();

    const saving = w.designs.upsertDesign(draft, base);

    // at once: the piece shows the edit, its row is held, and exactly one write has left
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(10.5);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(true);
    expect(w.server.summary()).toEqual([`PATCH /v1/skus/${skuId(1)}`]);
    const call = w.server.calls[0];
    expect(call.headers['x-jv-client']).toBe('web');
    expect(call.headers['idempotency-key']).toBeUndefined(); // an edit needs none (A5)
    // only the changed field, and the stamp as the exact text of the row (six decimals, trailing zeros): never a Date
    expect(call.body).toEqual({
      expected_updated_at: SKU_STAMP,
      changes: { customer_net_weight: '10.500' },
    });
    expect(Object.keys((call.body as { changes: object }).changes)).toEqual([
      'customer_net_weight',
    ]);

    w.server.releaseAll();
    await expect(saving).resolves.toBe(1);
  });

  it('on success the returned row replaces the edit and the row is no longer pending', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    draft.skus[0].notes = '  checked  ';
    await w.designs.upsertDesign(draft, base);

    const stored = w.cache.get('skus', skuId(1));
    const onServer = w.server.row('skus', skuId(1));
    expect(stored).toEqual(onServer); // the row the server returned, as it returned it
    expect(stored?.updated_at).not.toBe(SKU_STAMP);
    expect(stored?.customer_net_weight).toBe('10.500');
    expect(stored?.notes).toBe('checked'); // the server's own version (trimmed), not the screen's
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(10.5);
    expect(pieceOf(w, skuId(1)).notes).toBe('checked');
  });

  it("on a refusal memory is rolled back at once and the error carries the reason, in the API's own words", async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 99;
    w.server.refuseNext(
      refusal(
        'JV_INVALID_INPUT',
        422,
        'changes.customer_net_weight must not be above the gross weight',
        { field: 'changes.customer_net_weight' }
      )
    );
    const saving = w.designs.upsertDesign(draft, base);
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(99); // shown at once

    await expect(saving).rejects.toMatchObject({
      name: 'SaveError',
      code: 'JV_INVALID_INPUT',
      stale: false,
      saved: 0,
      field: 'changes.customer_net_weight',
    });
    await saving.catch((error: Error) => {
      expect(error.message).toContain('must not be above the gross weight');
      expect(error.message).toContain('Nothing was changed.');
    });
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(11.25); // back to what it was
    expect(w.cache.get('skus', skuId(1))?.updated_at).toBe(SKU_STAMP);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
  });

  it('when the outcome cannot be known (the network fails) memory is rolled back too, and the message says it could not be confirmed', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    w.server.dropNext();
    const error = await w.designs.upsertDesign(draft, base).catch((e: Error) => e);
    expect(error).toMatchObject({ name: 'SaveError', code: 'NETWORK', stale: false });
    expect((error as Error).message).toBe('Could not confirm that this was saved.');
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(11.25);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
  });

  it('a stale edit (409 JV_STALE) puts the current row from the answer in memory, says so, and changed nothing', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    // somebody else saved the same piece first
    const theirs = w.server.changeElsewhere('skus', skuId(1), {
      notes: 'changed by the other browser',
    });

    const error = (await w.designs.upsertDesign(draft, base).catch((e: Error) => e)) as Error & {
      stale: boolean;
    };
    expect(error).toMatchObject({ name: 'SaveError', code: 'JV_STALE', stale: true });
    expect(error.message).toBe(
      'This was changed by someone else. The latest version has been loaded. Nothing was changed.'
    );
    // the row is the other browser's, in full: not the edit, not the old copy
    expect(w.cache.get('skus', skuId(1))).toEqual(theirs);
    expect(pieceOf(w, skuId(1)).notes).toBe('changed by the other browser');
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(11.25);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
  });

  it("sends the stamp of the row the person STARTED from, and only what they changed: a poll that brought somebody else's change meanwhile makes it stale, it is never overwritten", async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    // the poll delivers the other browser's change while the person is typing
    const theirs = w.server.changeElsewhere('skus', skuId(1), { location: 'Workshop' });
    w.cache.merge('skus', [theirs as never], { polled: true });
    expect(pieceOf(w, skuId(1)).location).toBe('Workshop');

    const error = (await w.designs.upsertDesign(draft, base).catch((e: Error) => e)) as Error & {
      stale: boolean;
    };
    // the request carried the OLD stamp and ONLY the person's field: the other browser's location was not sent back
    expect(w.server.calls[0].body).toEqual({
      expected_updated_at: SKU_STAMP,
      changes: { customer_net_weight: '10.500' },
    });
    expect(error.stale).toBe(true);
    expect(pieceOf(w, skuId(1)).location).toBe('Workshop');
    expect(pieceOf(w, skuId(1)).customerNetWeight).toBe(11.25);
  });

  it('a pending row ignores polled copies until its write ends; then the returned row (the newer stamp) is what stays', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[1].notes = 'my note';
    w.server.pause();
    const saving = w.designs.upsertDesign(draft, base);
    // a poll brings an older copy of the held row
    w.cache.merge('skus', [skuRow(2, 1, { notes: 'a polled copy', updated_at: at(20) })], {
      polled: true,
    });
    expect(pieceOf(w, skuId(2)).notes).toBe('my note');
    w.server.releaseAll();
    await saving;
    expect(pieceOf(w, skuId(2)).notes).toBe('my note');
    expect(w.cache.get('skus', skuId(2))).toEqual(w.server.row('skus', skuId(2)));
  });

  it('a design and its pieces: every changed row shows at once, each is ONE write with its own fields, the design first, one after another', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.designName = 'Bridal ring (gold)';
    draft.description = 'A ring.';
    draft.skus[0].notes = 'piece one';
    draft.skus[1].piroi = 151.5;
    w.server.pause();

    const saving = w.designs.upsertDesign(draft, base);
    // all three rows show the edit and are held, though only the first write has left
    expect(designOf(w).designName).toBe('Bridal ring (gold)');
    expect(pieceOf(w, skuId(1)).notes).toBe('piece one');
    expect(pieceOf(w, skuId(2)).piroi).toBe(151.5);
    for (const [resource, key] of [
      ['designs', uuid(301)],
      ['skus', skuId(1)],
      ['skus', skuId(2)],
    ] as const)
      expect(w.cache.isHeld(resource, key), `${resource} ${key}`).toBe(true);
    expect(w.server.summary()).toEqual([`PATCH /v1/designs/${uuid(301)}`]);

    w.server.release();
    await w.server.received(2);
    w.server.release();
    await w.server.received(3);
    w.server.releaseAll();
    await expect(saving).resolves.toBe(3);

    expect(w.server.summary()).toEqual([
      `PATCH /v1/designs/${uuid(301)}`,
      `PATCH /v1/skus/${skuId(1)}`,
      `PATCH /v1/skus/${skuId(2)}`,
    ]);
    expect((w.server.calls[0].body as { changes: object }).changes).toEqual({
      name: 'Bridal ring (gold)',
      description: 'A ring.',
    });
    expect((w.server.calls[1].body as { changes: object }).changes).toEqual({ notes: 'piece one' });
    expect((w.server.calls[2].body as { changes: object }).changes).toEqual({ piroi: '151.50' });
    expect(w.cache.get('designs', uuid(301))).toEqual(w.server.row('designs', uuid(301)));
    expect(w.cache.isHeld('designs', uuid(301))).toBe(false);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
    expect(w.cache.isHeld('skus', skuId(2))).toBe(false);
  });

  it('a failure on the second row keeps the first (saved), stops there, rolls the unsent third back, and names the piece and how many were saved', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.designName = 'Renamed';
    draft.skus[0].grossWeight = 5; // refused by the server below
    draft.skus[1].notes = 'never sent';
    w.server.onRequest = (call) =>
      call.path.endsWith(skuId(1))
        ? refusal(
            'JV_INVALID_INPUT',
            422,
            'changes.gross_weight must not be below the customer net weight',
            {
              field: 'changes.gross_weight',
            }
          )
        : undefined;

    const error = (await w.designs.upsertDesign(draft, base).catch((e: Error) => e)) as Error;
    expect(error).toMatchObject({ name: 'SaveError', code: 'JV_INVALID_INPUT', saved: 1 });
    expect(error.message).toContain('RING-00001-001'); // which piece
    expect(error.message).toContain('must not be below the customer net weight');
    expect(w.server.summary()).toEqual([
      `PATCH /v1/designs/${uuid(301)}`,
      `PATCH /v1/skus/${skuId(1)}`,
    ]); // the third never left
    expect(designOf(w).designName).toBe('Renamed'); // saved, from the server's row
    expect(w.cache.get('designs', uuid(301))).toEqual(w.server.row('designs', uuid(301)));
    expect(pieceOf(w, skuId(1)).grossWeight).toBe(12.5); // rolled back
    expect(pieceOf(w, skuId(2)).notes).toBe('first'); // rolled back without being sent
    for (const key of [skuId(1), skuId(2)]) expect(w.cache.isHeld('skus', key)).toBe(false);
    expect(w.cache.isHeld('designs', uuid(301))).toBe(false);
  });

  it('a save that changes nothing sends nothing', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 11.25; // the same number
    draft.designName = base.designName;
    await expect(w.designs.upsertDesign(draft, base)).resolves.toBe(0);
    expect(w.server.calls).toEqual([]);
    expect(w.cache.isHeld('skus', skuId(1))).toBe(false);
  });

  it('money and weight go out as decimal TEXT with the scale of their column, and a number with too many decimals is NOT rounded for the server to refuse it', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].grossWeight = 12.75;
    draft.skus[0].piroi = 151.5;
    draft.skus[0].retailLabour = 360;
    draft.skus[0].labour = 360;
    draft.skus[0].semiWholesaleLabour = 330.25;
    draft.skus[0].stoneWeight = 1.2345; // more decimals than the column has
    draft.skus[0].stones = 4;
    await w.designs.upsertDesign(draft, base).catch(() => undefined);
    const { changes } = w.server.calls[0].body as { changes: Record<string, unknown> };
    expect(changes).toEqual({
      gross_weight: '12.750',
      piroi: '151.50',
      labour_retail: '360.00',
      labour_semi: '330.25',
      stone_weight: '1.2345',
      stones: 4,
    });
    for (const value of Object.values(changes))
      expect(typeof value === 'string' || Number.isInteger(value)).toBe(true);
  });

  it('what no ordinary edit may change is never sent: ids, numbers, barcodes and the status; a changed status or original weight is refused before any call', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].notes = 'x';
    draft.designName = 'y';
    await w.designs.upsertDesign(draft, base);
    for (const call of w.server.calls) {
      const sent = JSON.stringify(call.body);
      for (const never of [
        '"id"',
        'design_no',
        'sku_no',
        'barcode',
        '"status"',
        'original_net_weight',
        'created_',
        'updated_by',
      ])
        expect(sent, never).not.toContain(never);
    }

    const status = startEditing(w);
    status.draft.skus[0].status = 'Reserved';
    await expect(w.designs.upsertDesign(status.draft, status.base)).rejects.toThrow(/status/i);
    const original = startEditing(w);
    original.draft.skus[0].originalNetWeight = 9;
    await expect(w.designs.upsertDesign(original.draft, original.base)).rejects.toThrow(
      /original/i
    );
    expect(w.server.calls).toHaveLength(2); // only the two of the first save
  });

  it('the category and the sub-category of a design are sent as ids; a category that does not exist is refused before any call', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.category = 'Earrings';
    draft.subcategory = 'Jadau';
    await w.designs.upsertDesign(draft, base);
    expect((w.server.calls[0].body as { changes: object }).changes).toEqual({
      category_id: uuid(102),
      subcategory_id: uuid(204),
    });
    expect(designOf(w).category).toBe('Earrings');
    expect(designOf(w).subcategory).toBe('Jadau');

    const bad = startEditing(w);
    bad.draft.category = 'No such category';
    await expect(w.designs.upsertDesign(bad.draft, bad.base)).rejects.toThrow(/not a category/i);
    expect(w.server.calls).toHaveLength(1);
  });

  it('a write that ends after a logout puts nothing back in memory', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].customerNetWeight = 10.5;
    w.server.pause();
    const saving = w.designs.upsertDesign(draft, base);
    w.cache.clear(); // the session ended while the write was on its way
    w.server.releaseAll();
    await saving.catch(() => undefined);
    expect(w.cache.size()).toBe(0);
  });

  it('a second edit of a row whose write is still on its way is refused, not queued behind it', async () => {
    const w = await world();
    fillShop(w);
    const first = startEditing(w);
    first.draft.skus[0].notes = 'one';
    w.server.pause();
    const saving = w.designs.upsertDesign(first.draft, first.base);
    const second = startEditing(w);
    second.draft.skus[0].notes = 'two';
    await expect(w.designs.upsertDesign(second.draft, second.base)).rejects.toThrow(
      /still being saved/i
    );
    w.server.releaseAll();
    await saving;
    expect(w.server.calls).toHaveLength(1);
  });
});

describe('PT-W5 settings are one row per key, the last write wins and nothing else is sent (C5 (a), D3, A4)', () => {
  it('a change of one section is ONE PUT of that key with { value } and no stale stamp; the other sections are not sent', async () => {
    const w = await world();
    fillShop(w);
    const current = w.settings.getSettings();
    w.server.pause();
    const saving = w.settings.saveSettings({
      ...current,
      estimate: { ...current.estimate, prefix: 'XY', roundOff: false },
    });
    // at once
    expect(w.settings.getSettings().estimate.prefix).toBe('XY');
    expect(w.server.summary()).toEqual(['PUT /v1/settings/estimate']);
    expect(w.server.calls[0].body).toEqual({
      value: { prefix: 'XY', roundOff: false, footerNote: 'Estimate only' },
    });
    expect(Object.keys(w.server.calls[0].body as object)).toEqual(['value']); // no expected_updated_at
    w.server.releaseAll();
    const saved = await saving;
    expect(saved.estimate.prefix).toBe('XY');
    expect(w.cache.get('settings', 'estimate')).toEqual(w.server.row('settings', 'estimate'));
    expect(w.cache.isHeld('settings', 'estimate')).toBe(false);
  });

  it('the value keeps the keys the screen does not know, and leaves out what is not part of the row (the rates and the category prefixes)', async () => {
    const w = await world();
    fillShop(w);
    const current = w.settings.getSettings();
    await w.settings.saveSettings({
      ...current,
      business: { ...current.business, phone: '0142' },
      numbering: { ...current.numbering, skuPadding: 4 },
    });
    const sent = Object.fromEntries(
      w.server.calls.map((c) => [c.path.split('/').pop(), (c.body as { value: object }).value])
    );
    expect(sent.business).toMatchObject({
      phone: '0142',
      extra: 1,
      displayName: 'Jaishri Gold Palace',
    });
    expect(sent.numbering).toEqual({ designPadding: 5, skuPadding: 4, barcodePrefix: 'BC' });
    expect(JSON.stringify(sent)).not.toContain('categoryPrefixes');
    expect(JSON.stringify(sent)).not.toContain('defaultGoldRate');
    expect(Object.keys(sent).sort()).toEqual(['business', 'numbering']);
  });

  it('a refusal (a role that may not write settings) rolls the section back and says why', async () => {
    const w = await world();
    fillShop(w);
    const current = w.settings.getSettings();
    w.server.refuseNext(refusal('JV_FORBIDDEN', 403, 'You are not allowed to do this.'));
    const error = (await w.settings
      .saveSettings({ ...current, estimate: { ...current.estimate, prefix: 'ZZ' } })
      .catch((e: Error) => e)) as Error;
    expect(error).toMatchObject({ name: 'SaveError', code: 'JV_FORBIDDEN' });
    expect(error.message).toBe('You are not allowed to do this. Nothing was changed.');
    expect(w.settings.getSettings().estimate.prefix).toBe('JV');
    expect(w.cache.isHeld('settings', 'estimate')).toBe(false);
  });

  it('a list key (the materials) is saved as the list', async () => {
    const w = await world();
    fillShop(w);
    const current = w.settings.getSettings();
    await w.settings.saveSettings({
      ...current,
      materials: [...current.materials, { name: 'Silver', purities: ['800'] }],
    });
    expect(w.server.summary()).toEqual(['PUT /v1/settings/materials']);
    expect((w.server.calls[0].body as { value: unknown[] }).value).toHaveLength(3);
  });

  it('saving what is already there sends nothing', async () => {
    const w = await world();
    fillShop(w);
    await w.settings.saveSettings(w.settings.getSettings());
    expect(w.server.calls).toEqual([]);
  });
});

describe('PT-W5 categories and sub-categories are rows of their own: a new one comes back from the server, the others are ordinary edits', () => {
  it('a new category is not in memory until the server has answered, goes out as { name, prefix } alone, and has the id the server gave it', async () => {
    const w = await world();
    fillShop(w);
    w.server.pause();
    const adding = w.catalog.createCategory('Anklet Set', 'ANS');
    expect(w.catalog.getCategories()).not.toContain('Anklet Set'); // nothing made up
    expect(w.server.calls[0]).toMatchObject({ method: 'POST', path: '/v1/categories' });
    expect(w.server.calls[0].body).toEqual({ name: 'Anklet Set', prefix: 'ANS' });
    w.server.releaseAll();
    await expect(adding).resolves.toBe('Anklet Set');
    expect(w.catalog.getCategories()).toContain('Anklet Set');
    expect(w.catalog.getCategoryPrefix('Anklet Set')).toBe('ANS');
    const row = w.cache.rows('categories').find((c) => c.name === 'Anklet Set');
    expect(row?.id).toMatch(/^ffffffff-0000-4000-8000-/); // the server's, not one made here
  });

  it('a refused new category (somebody made the same name meanwhile) leaves memory as it was and carries the reason', async () => {
    const w = await world();
    fillShop(w);
    w.server.refuseNext(
      refusal('JV_INVALID_INPUT', 422, 'name is already used by another category', {
        field: 'name',
      })
    );
    const before = w.cache.rows('categories');
    const error = (await w.catalog
      .createCategory('Brooch Set', 'BRS')
      .catch((e: Error) => e)) as Error;
    expect(error).toMatchObject({ name: 'SaveError', code: 'JV_INVALID_INPUT', field: 'name' });
    expect(error.message).toContain('already used by another category');
    expect(w.cache.rows('categories')).toBe(before);
  });

  it('a name that is in use is not made again: the category is returned as it is, with no call', async () => {
    const w = await world();
    fillShop(w);
    await expect(w.catalog.createCategory('  ring ', 'RNG')).resolves.toBe('Ring');
    await expect(w.catalog.createSubcategory('Ring', 'kundan')).resolves.toBe('Kundan');
    expect(w.server.calls).toEqual([]);
  });

  it('a category that was removed once (inactive) is brought back, not made again', async () => {
    const w = await world();
    fillShop(w);
    await w.catalog.createCategory('Retired', 'RET');
    expect(w.server.summary()).toEqual([`PATCH /v1/categories/${uuid(103)}`]);
    expect((w.server.calls[0].body as { changes: object }).changes).toEqual({ active: true });
    expect(w.catalog.getCategories()).toContain('Retired');
  });

  it('a new sub-category goes out with the id of its category; a removed one of the same name is brought back', async () => {
    const w = await world();
    fillShop(w);
    await w.catalog.createSubcategory('Ring', 'Plain');
    expect(w.server.calls[0]).toMatchObject({ method: 'POST', path: '/v1/subcategories' });
    expect(w.server.calls[0].body).toEqual({ category_id: uuid(101), name: 'Plain' });
    expect(w.catalog.getSubcategories('Ring')).toEqual(['Casting', 'Kundan', 'Plain']);

    await w.catalog.createSubcategory('Ring', 'Old style');
    expect(w.server.calls[1]).toMatchObject({
      method: 'PATCH',
      path: `/v1/subcategories/${uuid(203)}`,
    });
    expect((w.server.calls[1].body as { changes: object }).changes).toEqual({ active: true });
    expect(w.catalog.getSubcategories('Ring')).toContain('Old style');
  });

  it('renaming and removing a sub-category are ordinary edits: at once in memory, one PATCH each with the exact stamp', async () => {
    const w = await world();
    fillShop(w);
    w.server.pause();
    const renaming = w.catalog.renameSubcategory('Ring', 'Kundan', 'Kundan work');
    expect(w.catalog.getSubcategories('Ring')).toEqual(['Casting', 'Kundan work']);
    expect(w.server.calls[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/subcategories/${uuid(201)}`,
    });
    expect(w.server.calls[0].body).toEqual({
      expected_updated_at: at(1),
      changes: { name: 'Kundan work' },
    });
    w.server.releaseAll();
    await expect(renaming).resolves.toBe('Kundan work');

    w.server.pause();
    const removing = w.catalog.removeSubcategory('Ring', 'Casting');
    expect(w.catalog.getSubcategories('Ring')).toEqual(['Kundan work']);
    await w.server.received(2);
    expect((w.server.calls[1].body as { changes: object }).changes).toEqual({ active: false });
    w.server.releaseAll();
    await removing;
    expect(w.cache.get('subcategories', uuid(202))?.active).toBe(false); // kept, not deleted (S7)
  });

  it('a refused rename is rolled back', async () => {
    const w = await world();
    fillShop(w);
    w.server.refuseNext(
      refusal(
        'JV_INVALID_INPUT',
        422,
        'changes.name is already used by another subcategory of this category',
        {
          field: 'changes.name',
        }
      )
    );
    await expect(w.catalog.renameSubcategory('Ring', 'Kundan', 'Casting')).rejects.toThrow(
      /already used/
    );
    expect(w.catalog.getSubcategories('Ring')).toEqual(['Casting', 'Kundan']);
  });
});

describe('PT-W5 the daily rates: a rate per day, material and purity; an insert comes back from the server, a correction is an ordinary edit', () => {
  it("a rate for a day with none is a POST of { material, purity, rate_per_gram, rate_date } and nothing else; the row is the server's", async () => {
    const w = await world();
    fillShop(w);
    w.server.pause();
    const saving = w.settings.saveDailyRates('2026-10-16', [
      { material: 'Gold', purity: '18K', rate: '5800' },
    ]);
    expect(w.cache.rows('daily-rates').some((r) => r.rate_date === '2026-10-16')).toBe(false);
    expect(w.server.calls[0]).toMatchObject({ method: 'POST', path: '/v1/daily-rates' });
    expect(w.server.calls[0].body).toEqual({
      material: 'Gold',
      purity: '18K',
      rate_per_gram: '5800.00',
      rate_date: '2026-10-16',
    });
    w.server.releaseAll();
    await expect(saving).resolves.toBe(1);
    const row = w.cache.rows('daily-rates').find((r) => r.rate_date === '2026-10-16');
    expect(row).toMatchObject({ material: 'Gold', purity: '18K', rate_per_gram: '5800.00' });
    expect(row?.id).toMatch(/^ffffffff-/);
  });

  it('a rate that already has a row for the day is corrected with one PATCH of rate_per_gram and the exact stamp; one that did not change is not sent', async () => {
    const w = await world();
    fillShop(w);
    const saving = w.settings.saveDailyRates('2026-10-15', [
      { material: 'Gold', purity: '22K', rate: '7500.5' },
    ]);
    await w.server.received(1);
    expect(w.server.calls[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/daily-rates/${uuid(802)}`,
    });
    expect(w.server.calls[0].body).toEqual({
      expected_updated_at: at(1),
      changes: { rate_per_gram: '7500.50' },
    });
    await saving;
    expect(w.cache.get('daily-rates', uuid(802))?.rate_per_gram).toBe('7500.50');

    await expect(
      w.settings.saveDailyRates('2026-10-15', [
        { material: 'Gold', purity: '22K', rate: '7500.50' },
      ])
    ).resolves.toBe(0);
    expect(w.server.calls).toHaveLength(1);
  });

  it('a rate that is not an amount with at most two decimals is refused before any call', async () => {
    const w = await world();
    fillShop(w);
    for (const rate of ['', 'abc', '-5', '0', '7350.505', '1e3'])
      await expect(
        w.settings.saveDailyRates('2026-10-15', [{ material: 'Gold', purity: '24K', rate }])
      ).rejects.toThrow(/rate/i);
    expect(w.server.calls).toEqual([]);
  });

  it('a role that may not correct a rate (a biller) is told so, and the rate is as it was', async () => {
    const w = await world();
    fillShop(w);
    w.server.refuseNext(refusal('JV_FORBIDDEN', 403, 'You are not allowed to do this.'));
    const error = (await w.settings
      .saveDailyRates('2026-10-15', [{ material: 'Gold', purity: '22K', rate: '7600' }])
      .catch((e: Error) => e)) as Error;
    expect(error).toMatchObject({ name: 'SaveError', code: 'JV_FORBIDDEN' });
    expect(w.cache.get('daily-rates', uuid(802))?.rate_per_gram).toBe('7400.00');
  });

  it("a refused day (a biller asking for yesterday) leaves nothing in memory and carries the API's words", async () => {
    const w = await world();
    fillShop(w);
    w.server.refuseNext(
      refusal('JV_INVALID_INPUT', 422, 'rate_date must be today', { field: 'rate_date' })
    );
    const before = w.cache.rows('daily-rates');
    const error = (await w.settings
      .saveDailyRates('2026-10-14', [{ material: 'Gold', purity: '18K', rate: '5800' }])
      .catch((e: Error) => e)) as Error;
    expect(error).toMatchObject({ code: 'JV_INVALID_INPUT', field: 'rate_date' });
    expect(error.message).toContain('rate_date must be today');
    expect(w.cache.rows('daily-rates')).toBe(before);
  });

  it('several rates are written one after another and the first refusal stops the rest; what was saved is counted', async () => {
    const w = await world();
    fillShop(w);
    w.server.onRequest = (call) =>
      (call.body as { purity?: string } | undefined)?.purity === '20K'
        ? refusal(
            'JV_INVALID_INPUT',
            422,
            'rate_date already has a rate for this material and purity',
            {
              field: 'rate_date',
            }
          )
        : undefined;
    const error = (await w.settings
      .saveDailyRates('2026-10-16', [
        { material: 'Gold', purity: '18K', rate: '5800' },
        { material: 'Gold', purity: '20K', rate: '6300' },
        { material: 'Gold', purity: '24K', rate: '8000' },
      ])
      .catch((e: Error) => e)) as Error & { saved: number };
    expect(error.saved).toBe(1);
    expect(error.message).toContain('20K');
    expect(w.server.calls.map((c) => (c.body as { purity: string }).purity)).toEqual([
      '18K',
      '20K',
    ]);
  });

  it('the rate sheet of a day gives the rate of each purity of the materials setting, and the last rate before the day when there is none', async () => {
    const w = await world();
    fillShop(w);
    const sheet = w.settings.getRateSheet('2026-10-16');
    const gold22 = sheet.find((e) => e.material === 'Gold' && e.purity === '22K');
    expect(gold22?.row).toBeUndefined();
    expect(gold22?.suggestion?.rate_per_gram).toBe('7400.00');
    const today = w.settings.getRateSheet('2026-10-15').find((e) => e.purity === '22K');
    expect(today?.row?.rate_per_gram).toBe('7400.00');
    expect(sheet.map((e) => `${e.material} ${e.purity}`)).toEqual([
      'Gold 18K',
      'Gold 22K',
      'Silver 925',
    ]);
  });
});

describe('PT-W5 the preview build keeps working in memory, with nothing in browser storage', () => {
  it('an edit of a piece, a category and the settings changes the sample data for the session and calls no server', async () => {
    const w = await world({ preview: true });
    const design = w.designs.getDesigns()[0];
    const draft = structuredClone(design);
    draft.designName = 'Changed in the preview';
    await w.designs.upsertDesign(draft, design);
    expect(w.designs.getDesigns().find((d) => d.id === design.id)?.designName).toBe(
      'Changed in the preview'
    );
    await expect(w.catalog.createCategory('Preview category', 'PRV')).resolves.toBe(
      'Preview category'
    );
    expect(w.catalog.getCategories()).toContain('Preview category');
    const settings = w.settings.getSettings();
    await w.settings.saveSettings({
      ...settings,
      estimate: { ...settings.estimate, prefix: 'PV' },
    });
    expect(w.settings.getSettings().estimate.prefix).toBe('PV');
    expect(w.server.calls).toEqual([]);
    expect(w.storageTouched()).toEqual([]);
  });
});

// ================================================================================================ T-E05

/** The `.ts` and `.tsx` files under a folder of src, without tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const SRC = path.resolve(__dirname, '../../src');
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

/** The identifiers and strings of the code of a file, comments left out (the TypeScript parser does not see a comment as code). */
function codeWords(file: string): { identifiers: Set<string>; strings: string[] } {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      strings.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { identifiers, strings };
}

const STOCK_SIDE_FILES = [
  'lib/designStore.ts',
  'lib/catalogStore.ts',
  'lib/settingsStore.ts',
  'lib/cache/edit.ts',
  'app/edit-stock/components/EditStockClient.tsx',
  'app/settings/components/SettingsClient.tsx',
  'app/components/DashboardRateCard.tsx',
];
const STORAGE_NAMES = ['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase', 'caches'];

describe('T-E05 (WEB05 clause) no business data in browser storage once the stock stores are on the API (C8)', () => {
  it('a session of edits in a real build touches no storage: not local, not session, and the old jaishri.* keys are never read or written', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.designName = 'Edited';
    draft.skus[0].notes = 'note';
    await w.designs.upsertDesign(draft, base);
    await w.catalog.createCategory('Brooch Set', 'BRS');
    await w.catalog.createSubcategory('Ring', 'Plain');
    await w.catalog.renameSubcategory('Ring', 'Kundan', 'Kundan work');
    await w.catalog.removeSubcategory('Ring', 'Casting');
    const settings = w.settings.getSettings();
    await w.settings.saveSettings({ ...settings, business: { ...settings.business, phone: '1' } });
    await w.settings.saveDailyRates('2026-10-16', [
      { material: 'Gold', purity: '18K', rate: '5800' },
    ]);
    // reads too
    w.designs.getDesigns();
    w.catalog.getCategories();
    w.settings.getSettings();
    // a failed save and a refused one
    w.server.refuseNext(refusal('JV_FORBIDDEN', 403));
    await w.settings
      .saveSettings({ ...settings, taxes: { ...settings.taxes, gstPercent: 3 } })
      .catch(() => undefined);
    expect(w.storageTouched()).toEqual([]);
    w.cache.clear();
    expect(w.storageTouched()).toEqual([]);
  });

  it('the stock stores, the write side of the cache and the three screens name no browser storage and no jaishri.* key', () => {
    for (const file of STOCK_SIDE_FILES) {
      const { identifiers, strings } = codeWords(path.join(SRC, file));
      for (const name of STORAGE_NAMES)
        expect(identifiers.has(name), `${file}: ${name}`).toBe(false);
      expect(
        strings.filter((s) => s.includes('jaishri.')),
        `${file}: an old key`
      ).toEqual([]);
    }
  });

  it("the one file of src that still uses browser storage is the money side's (WEB07; the preview build's sample data): the hidden Order Book's store keeps its orders in memory since the clean-up of 19 October (tests/unit/order-store.test.ts)", () => {
    const using = sourceFiles(SRC)
      .filter((file) => {
        const { identifiers } = codeWords(file);
        return STORAGE_NAMES.some((name) => identifiers.has(name));
      })
      .map(rel)
      .sort();
    expect(using).toEqual(['lib/appStore.ts']);
  });
});

describe('T-E05 (WEB05 clause) every control that saves is a SaveButton, so it is off while the banner shows (C7)', () => {
  it('no plain <button> of the three screens runs a function that saves, adds, removes, renames, resets or persists', () => {
    const offenders: string[] = [];
    for (const file of [
      'app/edit-stock/components/EditStockClient.tsx',
      'app/settings/components/SettingsClient.tsx',
      'app/components/DashboardRateCard.tsx',
    ]) {
      const full = path.join(SRC, file);
      const source = ts.createSourceFile(
        full,
        readFileSync(full, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TSX
      );
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (node.tagName.getText(source) === 'button') {
            const onClick = node.attributes.properties.find(
              (p) => ts.isJsxAttribute(p) && p.name.getText(source) === 'onClick'
            );
            const text = onClick?.getText(source) ?? '';
            if (/(save|add|remove|delete|rename|create|persist|reset|submit)/i.test(text))
              offenders.push(`${file}: ${node.getText(source).slice(0, 80)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});

// ================================================================================================ T-C01

describe("T-C01 (WEB05 clause) the browser cache never makes up an id or a number except a new design's id (C11)", () => {
  it('a new row (a category, a sub-category, a rate) is in memory only after the server answered, with the id the server gave it, and nothing the screen made up was sent', async () => {
    const w = await world();
    fillShop(w);
    await w.catalog.createCategory('Anklet Set', 'ANS');
    await w.catalog.createSubcategory('Ring', 'Plain');
    await w.settings.saveDailyRates('2026-10-16', [
      { material: 'Gold', purity: '18K', rate: '5800' },
    ]);
    for (const call of w.server.calls) {
      expect(call.method).toBe('POST');
      expect(Object.keys(call.body as object)).not.toContain('id');
      expect(Object.keys(call.body as object)).not.toContain('created_at');
      expect(Object.keys(call.body as object)).not.toContain('updated_at');
    }
    for (const resource of ['categories', 'subcategories', 'daily-rates'] as const) {
      const made = w.cache
        .rows(resource)
        .filter((r) => (r as { id: string }).id.startsWith('ffffffff-'));
      expect(made.length, resource).toBe(1);
      expect(made[0]).toEqual(w.server.row(resource, (made[0] as { id: string }).id));
    }
  });

  it('a row an ordinary edit puts in memory before the answer has the ids, numbers and stamps it already had: nothing is made up', async () => {
    const w = await world();
    fillShop(w);
    const { base, draft } = startEditing(w);
    draft.skus[0].notes = 'x';
    w.server.pause();
    const saving = w.designs.upsertDesign(draft, base);
    const optimistic = w.cache.get('skus', skuId(1));
    expect(optimistic).toMatchObject({
      id: skuId(1),
      sku_no: 'RING-00001-001',
      barcode: 'BC100001',
      updated_at: SKU_STAMP,
      created_at: at(0),
    });
    w.server.releaseAll();
    await saving;
  });

  it('the number a screen shows for a design that is not saved yet is not a number: "Number assigned when saved"', async () => {
    const w = await world();
    fillShop(w);
    // RING-00001 exists; a cache that counted would say RING-00002
    expect(w.designs.reserveNextDesignNumber('Ring', 'RING')).toBe('Number assigned when saved');
    expect(w.designs.reserveNextDesignNumber('Earrings', 'ER')).toBe('Number assigned when saved');
  });

  it('the stock side of the code has no way to make an id or a number: no random, no clock-made id, no key', () => {
    const generators = ['randomUUID', 'getRandomValues', 'random', 'newIdempotencyKey'];
    for (const file of STOCK_SIDE_FILES) {
      const { identifiers } = codeWords(path.join(SRC, file));
      for (const name of generators) expect(identifiers.has(name), `${file}: ${name}`).toBe(false);
    }
    // an id built from the clock
    for (const file of STOCK_SIDE_FILES) {
      const text = readFileSync(path.join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text, file).not.toMatch(/`(?:cf|user|design|sku|cat)-\$\{Date\.now\(\)/);
    }
  });
});

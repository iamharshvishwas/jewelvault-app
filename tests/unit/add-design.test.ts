// WEB06: Add Design with photos, create_design (X8) and set_sku_status (X9) from the screens (spec P2, P4, X8, X9, D9, C6, C11, C13). The unit half of PT-W6; the browser half is
// tests/e2e/add-design.spec.ts.
//
//   PT-W6  the photo is made in the browser (longest side 1000 px at JPEG quality 72 and a thumbnail of 320 px), both kinds are uploaded under one id BEFORE create_design is
//          called, create_design carries only ids and the person's own entries (no number, no barcode, no status, no image text), the numbers on the screen are the ones the API
//          returned, a photo address comes from NEXT_PUBLIC_API_URL, the owner may enter the original weight and nobody else, a fourth photo is refused in plain words, a retry
//          of an unconfirmed save carries the same Idempotency-Key, and a status change is one call with the pieces asked
//   T-C01  (clause) the only id the browser makes is the new design's (and its photos'); the API's numbers are shown
//   T-D03  (clause) a staff body holds no original weight; the owner's weight is kept in memory only for the owner
//
// The stores are the real ones over the real API client; only `fetch` is a stand-in (tests/unit/support/stockServer.ts, which answers as API16 and API17 do).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoToUpload } from '@/lib/photos';
import { FakeStockServer, refusal } from './support/stockServer';
import {
  categoryRow,
  designRow,
  settingRow,
  skuRow,
  subcategoryRow,
  userRow,
  uuid,
} from './support/rows';

const API = 'http://localhost:4229';
const SRC = path.resolve(__dirname, '../../src');

// ------------------------------------------------------------------------------------------------ the world of a case

async function world({ preview = false, role = 'owner' as 'owner' | 'staff' } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', API);
  vi.stubGlobal('window', {});
  const server = new FakeStockServer();
  server.role = role;
  vi.stubGlobal('fetch', server.fetch);
  const [cacheModule, designs, photos, client, edit] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/designStore'),
    import('@/lib/photos'),
    import('@/lib/api/client'),
    import('@/lib/cache/edit'),
  ]);
  const cache = cacheModule.rowCache;
  type Resource = Parameters<typeof cache.merge>[0];
  const put = (resource: Resource, rows: readonly object[]) => cache.merge(resource, rows as never);
  return { server, cache, designs, photos, client, edit, put };
}
type World = Awaited<ReturnType<typeof world>>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** What the hydrate leaves in memory: one category with a sub-category, the people, the settings. */
function fillShop(w: World) {
  w.put('users', [userRow(1, { full_name: 'Asha Verma' })]);
  w.put('categories', [categoryRow(1, 'Ring', 'RING'), categoryRow(2, 'Chain', 'CHN')]);
  w.put('subcategories', [subcategoryRow(1, 1, 'Kundan')]);
  w.put('settings', [
    settingRow('numbering', { designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' }),
  ]);
}

/** A JPEG as far as the first bytes go (the API reads the type from them). */
const jpeg = (size = 64) =>
  new Blob([new Uint8Array([0xff, 0xd8, 0xff, ...new Array(size - 3).fill(7)])], {
    type: 'image/jpeg',
  });

const DESIGN_ID = uuid(7001);
const PHOTO_A = uuid(7101);
const PHOTO_B = uuid(7102);
const PHOTO_C = uuid(7103);

/** A photo as the screen holds it once it is prepared: the two pictures, nothing stored yet. */
function photoOf(_w: World, photoId: string): PhotoToUpload {
  return { photoId, full: jpeg(80), thumb: jpeg(40), stored: { full: null, thumb: null } };
}

const group = (over: Record<string, string | number> = {}) => ({
  pieces: 1,
  grossWeight: '12.5',
  originalNetWeight: '',
  customerNetWeight: '11.25',
  stones: '',
  stoneWeight: '',
  kundan: '',
  kundanWeight: '',
  piroi: '',
  retailLabour: '353',
  semiWholesaleLabour: '',
  wholesaleLabour: '',
  notes: '',
  ...over,
});

function input(w: World, over: Record<string, unknown> = {}) {
  return {
    designId: DESIGN_ID,
    designName: 'Bridal ring',
    category: 'Ring',
    subcategory: 'Kundan',
    material: 'Gold',
    purity: '22K',
    sellingMethod: 'By Weight',
    description: '',
    tags: ['bridal'],
    notes: '',
    photos: [] as PhotoToUpload[],
    primaryPhotoId: null as string | null,
    groups: [group()],
    ...over,
  };
}

// ================================================================================================ PT-W6: the photo is made in the browser

describe('PT-W6 the photo is made in the browser: longest side 1000 px at quality 72, a thumbnail of 320 px (P2)', () => {
  it('fits a picture inside the longest side, never enlarges it, and keeps the shape', async () => {
    const w = await world();
    const fit = w.photos.fitWithin;
    expect(fit(960, 1280, 1000)).toEqual({ width: 750, height: 1000 });
    expect(fit(960, 1280, 320)).toEqual({ width: 240, height: 320 });
    expect(fit(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 });
    expect(fit(800, 600, 1000)).toEqual({ width: 800, height: 600 }); // a small picture is not enlarged
    expect(fit(1000, 1000, 1000)).toEqual({ width: 1000, height: 1000 });
    expect(fit(10000, 3, 1000)).toEqual({ width: 1000, height: 1 }); // a side is never 0
  });

  it('the rules are the decisions of Harsh: 1000 px, quality 72 (0.72), 320 px, at most 3 photos', async () => {
    const w = await world();
    expect(w.photos.PHOTO_RULES).toEqual({
      maxPerDesign: 3,
      fullSide: 1000,
      thumbSide: 320,
      quality: 0.72,
    });
  });

  it('the rules are the setting `photos` of D3 when it is sound, and the decisions where it is missing, wrong or beyond what the API takes', async () => {
    const w = await world();
    const { photoRulesFrom, PHOTO_RULES } = w.photos;
    expect(photoRulesFrom(undefined)).toEqual(PHOTO_RULES);
    expect(photoRulesFrom(null)).toEqual(PHOTO_RULES);
    // the row the seeds make
    expect(
      photoRulesFrom({
        maxPerDesign: 3,
        maxSidePx: 1000,
        jpegQuality: 0.72,
        thumbSidePx: 320,
        maxBytes: 2097152,
      })
    ).toEqual(PHOTO_RULES);
    expect(
      photoRulesFrom({ maxSidePx: 800, thumbSidePx: 200, jpegQuality: 0.6, maxPerDesign: 2 })
    ).toEqual({
      maxPerDesign: 2,
      fullSide: 800,
      thumbSide: 200,
      quality: 0.6,
    });
    // a design never holds more than the 3 the API takes
    expect(photoRulesFrom({ maxPerDesign: 10 }).maxPerDesign).toBe(3);
    expect(photoRulesFrom({ maxPerDesign: 0 }).maxPerDesign).toBe(3);
    // nonsense is the decision, field by field
    expect(
      photoRulesFrom({ maxSidePx: 'big', jpegQuality: 2, thumbSidePx: -4, maxPerDesign: 1.5 })
    ).toEqual(PHOTO_RULES);
    expect(photoRulesFrom({ maxSidePx: 300, thumbSidePx: 400 }).thumbSide).toBe(300);
  });

  it('prepareImage uses the setting `photos` in memory when no rules are given', async () => {
    const w = await world();
    w.put('settings', [
      settingRow('photos', { maxPerDesign: 3, maxSidePx: 800, jpegQuality: 0.6, thumbSidePx: 200 }),
    ]);
    const seen: Array<{ width: number; height: number; quality: number }> = [];
    const codec = {
      decode: async () => ({ width: 960, height: 1280, close: () => undefined }),
      encode: async (
        _i: unknown,
        size: { width: number; height: number },
        _t: number,
        quality: number
      ) => {
        seen.push({ ...size, quality });
        return jpeg();
      },
    };
    await w.photos.prepareImage(new Blob(['x']), { codec });
    expect(seen).toEqual([
      { width: 600, height: 800, quality: 0.6 },
      { width: 150, height: 200, quality: 0.6 },
    ]);
  });

  it('prepareImage asks the codec for a full picture of 1000 px and a thumbnail of 320 px, both at quality 0.72, and lets go of the decoded picture', async () => {
    const w = await world();
    const encoded: Array<{ width: number; height: number; turns: number; quality: number }> = [];
    let closed = 0;
    const codec = {
      decode: async () => ({ width: 960, height: 1280, close: () => (closed += 1) }),
      encode: async (
        _image: unknown,
        size: { width: number; height: number },
        turns: number,
        quality: number
      ) => {
        encoded.push({ ...size, turns, quality });
        return jpeg(size.width);
      },
    };
    const made = await w.photos.prepareImage(new Blob(['x']), { codec });
    expect(encoded).toEqual([
      { width: 750, height: 1000, turns: 0, quality: 0.72 },
      { width: 240, height: 320, turns: 0, quality: 0.72 },
    ]);
    expect(made.full.size).toBe(750);
    expect(made.thumb.size).toBe(240);
    expect(closed).toBe(1);
  });

  it('a turn is made in the picture itself (not only on the screen), and the sizes stay the same', async () => {
    const w = await world();
    const seen: number[] = [];
    const codec = {
      decode: async () => ({ width: 1280, height: 960, close: () => undefined }),
      encode: async (_image: unknown, _size: unknown, turns: number) => {
        seen.push(turns);
        return jpeg();
      },
    };
    await w.photos.prepareImage(new Blob(['x']), { codec, quarterTurns: 3 });
    expect(seen).toEqual([3, 3]);
  });

  it('a picture that cannot be read is refused in plain words, and the decoded picture is let go of when encoding fails', async () => {
    const w = await world();
    const broken = {
      decode: async () => {
        throw new Error('EncodingError');
      },
      encode: async () => jpeg(),
    };
    await expect(w.photos.prepareImage(new Blob(['x']), { codec: broken })).rejects.toThrow(
      /could not be read.*JPEG, PNG or WebP/i
    );
    let closed = 0;
    const failing = {
      decode: async () => ({ width: 10, height: 10, close: () => (closed += 1) }),
      encode: async () => {
        throw new Error('toBlob failed');
      },
    };
    await expect(w.photos.prepareImage(new Blob(['x']), { codec: failing })).rejects.toThrow(
      /could not be prepared/i
    );
    expect(closed).toBe(1);
  });
});

describe('PT-W6 the photo address comes from NEXT_PUBLIC_API_URL (P3, H4)', () => {
  it('full and thumb addresses are on the API origin, on the public read route', async () => {
    const w = await world();
    expect(w.client.api.photoUrl(PHOTO_A, 'full')).toBe(`${API}/v1/photos/${PHOTO_A}/full`);
    expect(w.photos.photoUrl(PHOTO_A, 'thumb')).toBe(`${API}/v1/photos/${PHOTO_A}/thumb`);
  });

  it('a photo id that is not a UUID makes no address (the page never builds a path from free text)', async () => {
    const w = await world();
    expect(() => w.client.api.photoUrl('../../v1/auth/me', 'full')).toThrow(/photo id/i);
  });

  it('the designs of memory show the photos of the API: the gallery gets the full pictures with the primary first, the lists the 320 px thumbnail of the primary', async () => {
    const w = await world();
    fillShop(w);
    w.put('designs', [
      designRow(1, { photo_ids: [PHOTO_A, PHOTO_B, PHOTO_C], primary_photo_id: PHOTO_B }),
      designRow(2),
    ]);
    const [withPhotos, without] = [...w.designs.getDesigns()].sort((a, b) =>
      a.designNumber.localeCompare(b.designNumber)
    );
    expect(withPhotos.images).toEqual([
      `${API}/v1/photos/${PHOTO_B}/full`,
      `${API}/v1/photos/${PHOTO_A}/full`,
      `${API}/v1/photos/${PHOTO_C}/full`,
    ]);
    expect(withPhotos.thumbs).toEqual([
      `${API}/v1/photos/${PHOTO_B}/thumb`,
      `${API}/v1/photos/${PHOTO_A}/thumb`,
      `${API}/v1/photos/${PHOTO_C}/thumb`,
    ]);
    expect(withPhotos.primaryImage).toBe(`${API}/v1/photos/${PHOTO_B}/thumb`);
    // a design with no photo shows the placeholder, as before
    expect(without.images).toEqual(['/assets/images/no_image.png']);
    expect(without.primaryImage).toBe('/assets/images/no_image.png');
  });
});

describe('PT-W6 the upload: both kinds under one id, the full picture first (P2, API17)', () => {
  it('PUTs the raw bytes to the photo address with the kind, the picture type, X-JV-Client and the cookie, and no JSON header and no key', async () => {
    const w = await world();
    const photo = photoOf(w, PHOTO_A);
    await w.photos.uploadPhoto(DESIGN_ID, photo);
    expect(w.server.summary()).toEqual([
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_A}?kind=full`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_A}?kind=thumb`,
    ]);
    const [full, thumb] = w.server.calls;
    expect(full.bytes).toBe(photo.full);
    expect(thumb.bytes).toBe(photo.thumb);
    for (const call of w.server.calls) {
      expect(call.headers['content-type']).toBe('image/jpeg');
      expect(call.headers['x-jv-client']).toBe('web');
      expect(call.headers['idempotency-key']).toBeUndefined();
      expect(call.body).toBeUndefined();
    }
    expect(photo.stored).toEqual({ full: DESIGN_ID, thumb: DESIGN_ID });
  });

  it('what is stored already is not sent again, and a "duplicate" answer counts as stored (a lost answer, a second try)', async () => {
    const w = await world();
    const photo = photoOf(w, PHOTO_A);
    w.server.dropNext(); // the first try never reaches the server
    await expect(w.photos.uploadPhoto(DESIGN_ID, photo)).rejects.toThrow();
    expect(photo.stored).toEqual({ full: null, thumb: null });
    await w.photos.uploadPhoto(DESIGN_ID, photo);
    expect(w.server.summary().filter((s) => s.startsWith('PUT'))).toHaveLength(3);
    // the same photo again: nothing goes out
    const before = w.server.calls.length;
    await w.photos.uploadPhoto(DESIGN_ID, photo);
    expect(w.server.calls).toHaveLength(before);
    // the server already has the full picture (its answer was lost): "duplicate" is a success and the thumbnail follows
    const lost = photoOf(w, PHOTO_B);
    w.server.photos.set(`${PHOTO_B}:full`, {
      designId: DESIGN_ID,
      kind: 'full',
      bytes: lost.full,
      contentType: 'image/jpeg',
    });
    await w.photos.uploadPhoto(DESIGN_ID, lost);
    expect(lost.stored).toEqual({ full: DESIGN_ID, thumb: DESIGN_ID });
    expect(w.server.photos.has(`${PHOTO_B}:thumb`)).toBe(true);
  });

  it('a photo stored for another design id is uploaded again under the new one', async () => {
    const w = await world();
    const photo = photoOf(w, PHOTO_A);
    photo.stored = { full: uuid(9999), thumb: uuid(9999) };
    await w.photos.uploadPhoto(DESIGN_ID, photo);
    expect(w.server.summary()).toHaveLength(2);
  });

  it('a refusal stops the upload and says why in plain words, not the code', async () => {
    const w = await world();
    const photo = photoOf(w, PHOTO_A);
    w.server.refuseNext(
      refusal('JV_NOT_ALLOWED', 409, 'A design can have at most 3 photos.', {
        field: 'design_id',
        reason: 'design_full',
      })
    );
    const error = await w.photos.uploadPhoto(DESIGN_ID, photo).catch((e: Error) => e);
    expect((error as Error).message).toBe('A design can have at most 3 photos.');
    expect(w.server.calls).toHaveLength(1); // the thumbnail did not follow
    expect(photo.stored).toEqual({ full: null, thumb: null });
  });

  it('the plain messages: too many photos, photos waiting, the store is full, too large, not a picture, no connection', async () => {
    const w = await world();
    const { ApiError } = w.client;
    const make = (code: string, status: number, reason?: string) =>
      new ApiError({ code, status, message: 'x', details: reason ? { reason } : {}, write: true });
    const say = w.photos.photoErrorMessage;
    expect(say(make('JV_NOT_ALLOWED', 409, 'design_full'))).toMatch(/at most 3 photos/i);
    expect(say(make('JV_NOT_ALLOWED', 409, 'unattached_count'))).toMatch(
      /waiting|save the designs/i
    );
    expect(say(make('JV_NOT_ALLOWED', 409, 'unattached_bytes'))).toMatch(
      /waiting|save the designs/i
    );
    expect(say(make('JV_NOT_ALLOWED', 409, 'database_full'))).toMatch(/full/i);
    expect(say(make('JV_PAYLOAD_TOO_LARGE', 413))).toMatch(/too large/i);
    expect(say(make('JV_UNSUPPORTED_MEDIA_TYPE', 415))).toMatch(/JPEG, PNG or WebP/i);
    expect(say(make('NETWORK', 0))).toMatch(/connection|try again/i);
    for (const code of [
      'JV_NOT_ALLOWED',
      'JV_PAYLOAD_TOO_LARGE',
      'JV_UNSUPPORTED_MEDIA_TYPE',
      'NETWORK',
      'JV_RATE_LIMITED',
    ]) {
      expect(say(make(code, 409, 'design_full')), code).not.toMatch(/JV_/);
    }
    expect(say(make('JV_RATE_LIMITED', 429))).toMatch(/wait/i);
  });
});

// ================================================================================================ PT-W6: create_design (X8)

describe("PT-W6 create_design (X8): the photos first, then one call with ids and the person's own entries", () => {
  it('uploads every photo (full, then thumb) BEFORE it calls create_design, and sends the design id, the photo ids, the primary and nothing the API makes', async () => {
    const w = await world();
    fillShop(w);
    const photos = [photoOf(w, PHOTO_A), photoOf(w, PHOTO_B), photoOf(w, PHOTO_C)];
    const created = await w.designs.createDesign(
      input(w, { photos, primaryPhotoId: PHOTO_B, groups: [group({ pieces: 2 })] })
    );
    expect(w.server.summary()).toEqual([
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_A}?kind=full`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_A}?kind=thumb`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_B}?kind=full`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_B}?kind=thumb`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_C}?kind=full`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_C}?kind=thumb`,
      'POST /v1/designs',
    ]);
    const post = w.server.calls[6];
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers['x-jv-client']).toBe('web');
    expect(post.body).toEqual({
      design_id: DESIGN_ID,
      design: {
        category_id: uuid(101),
        subcategory_id: uuid(201),
        name: 'Bridal ring',
        material: 'Gold',
        purity: '22K',
        selling_method: 'By Weight',
        tags: ['bridal'],
        photo_ids: [PHOTO_A, PHOTO_B, PHOTO_C],
        primary_photo_id: PHOTO_B,
      },
      pieces: [
        {
          pieces: 2,
          gross_weight: '12.500',
          customer_net_weight: '11.250',
          labour_retail: '353.00',
        },
      ],
    });
    expect(created.designId).toBe(DESIGN_ID);
  });

  it('T-C01 clause: the body holds no design number, piece number, barcode, status, location, stamp or person, and no image text (P4)', async () => {
    const w = await world();
    fillShop(w);
    await w.designs.createDesign(
      input(w, { photos: [photoOf(w, PHOTO_A)], primaryPhotoId: PHOTO_A })
    );
    const post = w.server.calls.find((c) => c.method === 'POST' && c.path === '/v1/designs');
    const text = JSON.stringify(post?.body);
    for (const name of [
      'design_no',
      'sku_no',
      'barcode',
      'status',
      'location',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'images',
    ])
      expect(text, name).not.toContain(`"${name}"`);
    expect(text).not.toContain('data:');
    expect(text).not.toContain('blob:');
    expect(w.server.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a blank rate is absent (never ""), a blank weight is absent, a number comes with the scale of its column, and nothing is rounded', async () => {
    const w = await world();
    fillShop(w);
    await w.designs.createDesign(
      input(w, {
        groups: [
          group({
            grossWeight: '',
            customerNetWeight: '',
            retailLabour: '',
            semiWholesaleLabour: '325.5',
            wholesaleLabour: '',
            piroi: '150',
            stones: '3',
            stoneWeight: '.5',
            kundan: '2',
            kundanWeight: '0.250',
            notes: '  remark  ',
          }),
        ],
      })
    );
    const piece = w.server.calls.find((c) => c.path === '/v1/designs')?.body?.pieces[0];
    expect(piece).toEqual({
      pieces: 1,
      labour_semi: '325.50',
      piroi: '150.00',
      stones: 3,
      stone_weight: '0.500',
      kundan: 2,
      kundan_weight: '0.250',
      notes: 'remark',
    });
    expect('labour_retail' in piece).toBe(false);
    expect('gross_weight' in piece).toBe(false);
  });

  it('what is not a number, or has more decimals than the column, is refused before anything is sent: no upload, no call, nothing rounded', async () => {
    const w = await world();
    fillShop(w);
    const photos = [photoOf(w, PHOTO_A)];
    for (const [field, value, message] of [
      ['grossWeight', '1e3', /gross weight/i],
      ['grossWeight', '12.3456', /at most 3 decimals/i],
      ['customerNetWeight', '-1', /customer net weight/i],
      ['piroi', '10.999', /at most 2 decimals/i],
      ['retailLabour', 'abc', /retail/i],
      ['stones', '2.5', /whole number/i],
      ['pieces', 0, /pieces/i],
      ['pieces', 101, /at most 100/i],
    ] as const) {
      const error = await w.designs
        .createDesign(input(w, { photos, groups: [group({ [field]: value })] }))
        .catch((e: Error) => e);
      expect((error as Error).message, `${field} ${value}`).toMatch(message);
    }
    // more than 500 pieces in all
    const many = await w.designs
      .createDesign(
        input(w, { photos, groups: Array.from({ length: 6 }, () => group({ pieces: 100 })) })
      )
      .catch((e: Error) => e);
    expect((many as Error).message).toMatch(/at most 500 pieces/i);
    expect(w.server.calls).toEqual([]);
  });

  it('names the group in a refusal of the API: "Group 2, customer net weight", not pieces[1].customer_net_weight', async () => {
    const w = await world();
    fillShop(w);
    w.server.refuseNext(
      refusal(
        'JV_INVALID_INPUT',
        422,
        'pieces[1].customer_net_weight must not be above the gross weight',
        {
          field: 'pieces[1].customer_net_weight',
        }
      )
    );
    const error = await w.designs
      .createDesign(input(w, { groups: [group(), group({ customerNetWeight: '99' })] }))
      .catch((e: Error) => e);
    const say = w.designs.designSaveMessage(error as never);
    expect(say).toMatch(/Group 2/);
    expect(say).toMatch(/customer net weight/i);
    expect(say).not.toMatch(/pieces\[/);
  });

  it("T-D03 clause: the owner's original weight goes out only when it was typed, and the answer's sku_private is kept for the owner", async () => {
    const w = await world({ role: 'owner' });
    fillShop(w);
    await w.designs.createDesign(
      input(w, { groups: [group({ pieces: 2, originalNetWeight: '10.125' })] })
    );
    const body = w.server.calls.find((c) => c.path === '/v1/designs')?.body;
    expect(body?.pieces[0].original_net_weight).toBe('10.125');
    const privates = w.cache.rows('sku-private');
    expect(privates).toHaveLength(2);
    expect(privates.every((p) => p.original_net_weight === '10.125')).toBe(true);
    const created = w.designs.getDesigns().find((d) => d.designNumber === 'RING-00001');
    expect(created?.skus.map((s) => s.originalNetWeight)).toEqual([10.125, 10.125]);
  });

  it("T-D03 clause: a staff body has no original weight when none was typed, and the API's refusal of one is plain", async () => {
    const w = await world({ role: 'staff' });
    fillShop(w);
    await w.designs.createDesign(input(w));
    const body = w.server.calls.find((c) => c.path === '/v1/designs')?.body;
    expect(JSON.stringify(body)).not.toContain('original_net_weight');
    expect(w.cache.rows('sku-private')).toEqual([]);
    // a staff screen never has the field; if a value ever reached the call, the API refuses it and says so
    const second = await world({ role: 'staff' });
    fillShop(second);
    const error = await second.designs
      .createDesign(input(second, { groups: [group({ originalNetWeight: '10' })] }))
      .catch((e: Error) => e);
    expect(second.designs.designSaveMessage(error)).toMatch(
      /only the owner can enter the original net weight/i
    );
    expect(second.cache.rows('designs')).toEqual([]);
  });

  it('the rows the API returned are in memory at once, with ITS numbers: the design number, the piece numbers and the barcodes are not made here', async () => {
    const w = await world();
    fillShop(w);
    const created = await w.designs.createDesign(
      input(w, {
        groups: [
          group({ pieces: 2 }),
          group({ pieces: 1, grossWeight: '8', customerNetWeight: '7' }),
        ],
      })
    );
    expect(created.designNumber).toBe('RING-00001');
    expect(created.pieces.map((p) => p.skuNumber)).toEqual([
      'RING-00001-001',
      'RING-00001-002',
      'RING-00001-003',
    ]);
    expect(created.pieces.map((p) => p.barcode)).toEqual([
      'BC-RING-00001-001',
      'BC-RING-00001-002',
      'BC-RING-00001-003',
    ]);
    const design = w.designs.getDesigns().find((d) => d.id === DESIGN_ID);
    expect(design?.designNumber).toBe('RING-00001');
    expect(design?.skus.map((s) => s.skuNumber)).toEqual(created.pieces.map((p) => p.skuNumber));
    expect(design?.skus.map((s) => s.status)).toEqual(['In Stock', 'In Stock', 'In Stock']);
    // the very rows the API sent
    expect(w.cache.get('designs', DESIGN_ID)).toEqual(w.server.designs.get(DESIGN_ID));
  });

  it('the photos of the new design show from the API in the very next view', async () => {
    const w = await world();
    fillShop(w);
    await w.designs.createDesign(
      input(w, { photos: [photoOf(w, PHOTO_A), photoOf(w, PHOTO_B)], primaryPhotoId: PHOTO_A })
    );
    const design = w.designs.getDesigns().find((d) => d.id === DESIGN_ID);
    expect(design?.images).toEqual([
      `${API}/v1/photos/${PHOTO_A}/full`,
      `${API}/v1/photos/${PHOTO_B}/full`,
    ]);
    expect(design?.primaryImage).toBe(`${API}/v1/photos/${PHOTO_A}/thumb`);
  });

  it('a failed photo upload ends the save before create_design is called, says which photo, and what was stored stays stored for the next try', async () => {
    const w = await world();
    fillShop(w);
    const photos = [photoOf(w, PHOTO_A), photoOf(w, PHOTO_B)];
    // the full picture of the second photo is refused as a non-picture
    w.server.onRequest = (call) =>
      call.path.includes(PHOTO_B) && call.query.kind === 'full'
        ? refusal('JV_UNSUPPORTED_MEDIA_TYPE', 415, 'This file is not a JPEG, PNG or WebP image.')
        : undefined;
    const error = (await w.designs
      .createDesign(input(w, { photos, primaryPhotoId: PHOTO_A }))
      .catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/photo 2/i);
    expect(error.message).toMatch(/JPEG, PNG or WebP/);
    expect(w.server.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(photos[0].stored).toEqual({ full: DESIGN_ID, thumb: DESIGN_ID });
    expect(photos[1].stored).toEqual({ full: null, thumb: null });
    // the next try sends only what is missing
    w.server.onRequest = undefined;
    const before = w.server.calls.length;
    await w.designs.createDesign(input(w, { photos, primaryPhotoId: PHOTO_A }));
    const sent = w.server.summary().slice(before);
    expect(sent).toEqual([
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_B}?kind=full`,
      `PUT /v1/designs/${DESIGN_ID}/photos/${PHOTO_B}?kind=thumb`,
      'POST /v1/designs',
    ]);
  });

  it('a refusal on the photos of the design is plain: the photos could not be attached', async () => {
    const w = await world();
    fillShop(w);
    const photo = photoOf(w, PHOTO_A);
    w.server.onRequest = (call) =>
      call.method === 'POST'
        ? refusal(
            'JV_INVALID_INPUT',
            422,
            'design.photo_ids names a photo that is not stored for this design',
            {
              field: 'design.photo_ids',
            }
          )
        : undefined;
    const error = await w.designs
      .createDesign(input(w, { photos: [photo], primaryPhotoId: PHOTO_A }))
      .catch((e: Error) => e);
    const say = w.designs.designSaveMessage(error as never);
    expect(say).toMatch(/photos could not be attached/i);
    expect(say).not.toMatch(/design\.photo_ids/);
  });

  it('a design id the server already has is told plainly: it was saved already (a retry after a lost answer)', async () => {
    const w = await world();
    fillShop(w);
    await w.designs.createDesign(input(w));
    const error = await w.designs.createDesign(input(w)).catch((e: Error) => e);
    const say = w.designs.designSaveMessage(error as never);
    expect(say).toMatch(/already saved/i);
  });

  it('C6: pressing Save again for the SAME action sends the same Idempotency-Key and makes one design, however many answers were lost', async () => {
    const w = await world();
    fillShop(w);
    const body = input(w, { photos: [photoOf(w, PHOTO_A)], primaryPhotoId: PHOTO_A });
    // the first try: the network fails at the upload
    w.server.dropNext();
    const first = (await w.designs.createDesign(body).catch((e: Error) => e)) as Error;
    expect(first).toBeInstanceOf(w.edit.SaveError);
    // the second try: the photos go up, the call is made and the design is made, but the answer is lost
    let lostOnce = false;
    const real = w.server.fetch;
    vi.stubGlobal('fetch', async (target: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(target, init);
      if (init?.method === 'POST' && !lostOnce) {
        lostOnce = true;
        throw new TypeError('Failed to fetch');
      }
      return response;
    });
    const second = (await w.designs.createDesign(body).catch((e: Error) => e)) as InstanceType<
      typeof w.edit.SaveError
    >;
    expect(second).toBeInstanceOf(w.edit.SaveError);
    expect(second.message).toMatch(/could not confirm/i);
    const key = (second.origin as InstanceType<typeof w.client.ApiError>).idempotencyKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(w.cache.rows('designs')).toEqual([]); // not shown: the browser does not know that it exists
    // Save again with that key: the first answer comes back
    const third = await w.designs.createDesign(body, { idempotencyKey: key as string });
    expect(third.designNumber).toBe('RING-00001');
    const posts = w.server.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.headers['idempotency-key'])).toEqual([key, key]);
    expect(w.server.designs.size).toBe(1);
    expect(w.designs.getDesigns()).toHaveLength(1);
  });

  it('nothing is made up to show: the cache holds no design before the API has answered', async () => {
    const w = await world();
    fillShop(w);
    w.server.pause();
    const saving = w.designs.createDesign(input(w));
    for (let i = 0; i < 20 && w.server.calls.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.designs.getDesigns()).toEqual([]);
    w.server.releaseAll();
    await saving;
    expect(w.designs.getDesigns()).toHaveLength(1);
  });

  it('an answer that arrives after a logout puts nothing in memory (U8)', async () => {
    const w = await world();
    fillShop(w);
    w.server.pause();
    const saving = w.designs.createDesign(input(w));
    for (let i = 0; i < 20 && w.server.calls.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    w.cache.clear();
    w.server.releaseAll();
    await saving;
    expect(w.cache.rows('designs')).toEqual([]);
    expect(w.cache.rows('skus')).toEqual([]);
  });

  it('a category or a sub-category that is not in memory is refused before any call', async () => {
    const w = await world();
    fillShop(w);
    await expect(w.designs.createDesign(input(w, { category: 'Nothing' }))).rejects.toThrow(
      /not a category/i
    );
    await expect(w.designs.createDesign(input(w, { subcategory: 'Nothing' }))).rejects.toThrow(
      /not a sub-category/i
    );
    expect(w.server.calls).toEqual([]);
  });
});

// ================================================================================================ PT-W6: set_sku_status (X9)

describe('PT-W6 set_sku_status (X9) from the stock screen: one call, the pieces asked, shown after the API has answered', () => {
  function stocked(w: World) {
    fillShop(w);
    const rows = [
      skuRow(1, 1),
      skuRow(2, 1),
      skuRow(3, 1, { status: 'Sold', sold_bill_id: uuid(5001) }),
    ];
    w.put('designs', [designRow(1)]);
    w.put('skus', rows);
    for (const row of rows) w.server.seedSku(row as unknown as Record<string, unknown>);
    return rows;
  }
  const pieceId = (n: number) => uuid(1000 + n);

  it('sends {sku_ids, status} with an Idempotency-Key, merges the rows it gets back, and Archived sets archived_at', async () => {
    const w = await world();
    stocked(w);
    const rows = await w.designs.setSkuStatus([pieceId(1), pieceId(2)], 'Archived');
    expect(w.server.summary()).toEqual(['POST /v1/skus/status']);
    const call = w.server.calls[0];
    expect(call.body).toEqual({ sku_ids: [pieceId(1), pieceId(2)], status: 'Archived' });
    expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers['x-jv-client']).toBe('web');
    expect(rows.map((r) => r.status)).toEqual(['Archived', 'Archived']);
    const inMemory = w.cache.get('skus', pieceId(1));
    expect(inMemory?.status).toBe('Archived');
    expect(inMemory?.archived_at).not.toBeNull();
    expect(inMemory).toEqual(w.server.skus.get(pieceId(1)));
    // leaving Archived clears it
    await w.designs.setSkuStatus([pieceId(1)], 'In Stock');
    expect(w.cache.get('skus', pieceId(1))?.archived_at).toBeNull();
  });

  it('shows nothing before the API has answered (a status can be refused), and the view has the new status after it', async () => {
    const w = await world();
    stocked(w);
    w.server.pause();
    const saving = w.designs.setSkuStatus([pieceId(1)], 'Repair');
    for (let i = 0; i < 20 && w.server.calls.length === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.cache.get('skus', pieceId(1))?.status).toBe('In Stock');
    w.server.releaseAll();
    await saving;
    const piece = w.designs.getDesigns()[0].skus.find((s) => s.id === pieceId(1));
    expect(piece?.status).toBe('Repair');
  });

  it('Sold is not a status to choose: refused before any call', async () => {
    const w = await world();
    stocked(w);
    await expect(w.designs.setSkuStatus([pieceId(1)], 'Sold')).rejects.toThrow(/bill/i);
    await expect(w.designs.setSkuStatus([], 'Repair')).rejects.toThrow(/no piece/i);
    expect(w.server.calls).toEqual([]);
  });

  it('at most 500 pieces in a call: more is refused before any call', async () => {
    const w = await world();
    stocked(w);
    const ids = Array.from({ length: 501 }, (_, i) => uuid(20000 + i));
    await expect(w.designs.setSkuStatus(ids, 'Repair')).rejects.toThrow(/at most 500/i);
    expect(w.server.calls).toEqual([]);
  });

  it('a Sold piece is refused by the API, in plain words, and nothing in the call changes', async () => {
    const w = await world();
    stocked(w);
    const error = (await w.designs
      .setSkuStatus([pieceId(1), pieceId(3)], 'Archived')
      .catch((e: Error) => e)) as InstanceType<typeof w.edit.SaveError>;
    expect(error).toBeInstanceOf(w.edit.SaveError);
    expect(error.code).toBe('JV_NOT_ALLOWED');
    expect(error.message).toMatch(/Sold/);
    expect(error.message).not.toMatch(/JV_/);
    expect(w.cache.get('skus', pieceId(1))?.status).toBe('In Stock');
    expect(w.server.skus.get(pieceId(1))?.status).toBe('In Stock');
  });

  it('a lost answer is not shown as saved, and pressing the control again with the same key is the same change', async () => {
    const w = await world();
    stocked(w);
    w.server.dropNext();
    const error = (await w.designs
      .setSkuStatus([pieceId(1)], 'Damaged')
      .catch((e: Error) => e)) as InstanceType<typeof w.edit.SaveError>;
    expect(error.message).toMatch(/could not confirm/i);
    expect(w.cache.get('skus', pieceId(1))?.status).toBe('In Stock');
    const key = (error.origin as InstanceType<typeof w.client.ApiError>).idempotencyKey as string;
    await w.designs.setSkuStatus([pieceId(1)], 'Damaged', { idempotencyKey: key });
    expect(w.server.calls.map((c) => c.headers['idempotency-key'])).toEqual([key, key]);
    expect(w.cache.get('skus', pieceId(1))?.status).toBe('Damaged');
  });

  it("updateSkuStatus (the billing screen's Sold, WEB08) is not this function and still says it cannot be saved yet in a real build", async () => {
    const w = await world();
    stocked(w);
    expect(() => w.designs.updateSkuStatus(pieceId(1), 'Sold')).toThrow(/cannot be saved yet/);
  });
});

// ================================================================================================ the screens

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

describe('PT-W6 / P4 the Add Design screen holds no image text and no number of its own making', () => {
  const FILES = [
    'app/add-design/components/AddDesignClient.tsx',
    'lib/photos.ts',
    'lib/designStore.ts',
  ];

  it('no data: address, no data-URL reader, no canvas-to-text, and no browser storage', () => {
    for (const file of FILES) {
      const { identifiers, strings } = codeWords(path.join(SRC, file));
      for (const name of [
        'toDataURL',
        'readAsDataURL',
        'localStorage',
        'sessionStorage',
        'indexedDB',
      ])
        expect(identifiers.has(name), `${file}: ${name}`).toBe(false);
      expect(
        strings.filter((s) => s.startsWith('data:')),
        `${file}: a data: address`
      ).toEqual([]);
    }
  });

  it("the store builds no piece number and no barcode: the numbers on the screen are the API's", () => {
    const { identifiers } = codeWords(path.join(SRC, 'lib/designStore.ts'));
    for (const name of ['barcodePrefix', 'skuPadding', 'barcodeFor'])
      expect(identifiers.has(name), `designStore: ${name}`).toBe(false);
  });

  it('an id is made by the page only for the design and its photos, from the one generator of the client', () => {
    const screen = codeWords(path.join(SRC, 'app/add-design/components/AddDesignClient.tsx'));
    for (const name of ['randomUUID', 'getRandomValues', 'random'])
      expect(screen.identifiers.has(name), name).toBe(false);
    expect(screen.identifiers.has('newUuid')).toBe(true);
  });

  it('every control of the screen that saves is a SaveButton, so it is off while the banner shows (C7)', () => {
    const full = path.join(SRC, 'app/add-design/components/AddDesignClient.tsx');
    const source = ts.createSourceFile(
      full,
      readFileSync(full, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (node.tagName.getText(source) === 'button') {
          const onClick = node.attributes.properties.find(
            (p) => ts.isJsxAttribute(p) && p.name.getText(source) === 'onClick'
          );
          if (
            /(handleSubmit|handleAddCategory|handleAddSubcategory)/.test(
              onClick?.getText(source) ?? ''
            )
          )
            offenders.push(node.getText(source).slice(0, 100));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(offenders).toEqual([]);
    // and the controls that do save exist, as SaveButton
    expect(readFileSync(full, 'utf8')).toMatch(/<SaveButton[^>]*onClick=\{handleSubmit\}/);
  });
});

// PDF-5: the photos of the catalogue PDF (src/lib/pdf/photoFetch.ts), fetched by the page as data URLs:
//   - each distinct photo once, from its address (by default the 320 px thumbnail on the API's origin); the data URL keeps the answer's own content type
//   - never more than `concurrency` (6 unless told) at a time; the progress at the start and after each photo, ending at (total, total)
//   - a 404, a network error, an answer that is not a picture (`text/html`), a photo that never answers (past `timeoutMs`): that photo is in `failed`, the others arrive
//   - Stop (the signal aborted): rejects with an AbortError and starts no new fetch; a signal aborted before the start fetches nothing
//
// The fetch is a fake (`fetchImpl`): no network. Node has no FileReader, so these tests also show the data URL is made without one.
//
// Run: npm test -- tests/unit/photo-fetch.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPhotoDataUrls } from '@/lib/pdf/photoFetch';

// A 1 x 1 grey JPEG and a 1 x 1 gold PNG; and the PNG tests/e2e/stock-catalogue.spec.ts had before PDF-6 (now a JPEG), whose picture data is cut short (its IEND chunk is out of step), which
// pdfmake cannot open.
const JPEG_HEX =
  'FFD8FFE000104A46494600010100000100010000FFDB004300100B0C0E0C0A100E0D0E1211101318281A181616183123251D283A333D3C3933383740485C4E404457453738506D51575F626768673E4D71797064785C656763FFC0000B080001000101011100FFC40014000100000000000000000000000000000005FFC40014100100000000000000000000000000000000FFDA0008010100003F0069FFD9';
const PNG_HEX =
  '89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C4944415478DA63B8B2DE1C00041501BB877ABA670000000049454E44AE426082';
const E2E_PNG_HEX =
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082';
const JPEG = Buffer.from(JPEG_HEX, 'hex');
const PNG = Buffer.from(PNG_HEX, 'hex');

const urlOf = (photoId: string) => `https://photos.test/${photoId}/thumb`;

const picture = (bytes: Buffer, type = 'image/jpeg') =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });

/** A fetch that answers each address with `answer(photoId)`, and keeps the addresses it was asked for and the signal of each call. */
function fakeFetch(answer: (photoId: string) => Promise<Response> | Response) {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal) signals.push(init.signal);
    return answer(/^https:\/\/photos\.test\/([^/]+)\/thumb$/.exec(url)?.[1] ?? '');
  }) as typeof fetch;
  return { fetchImpl, calls, signals };
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PDF-5 fetchPhotoDataUrls: the photos', () => {
  it('each distinct photo is fetched once, from its address, as a data URL of its own type', async () => {
    const { fetchImpl, calls } = fakeFetch((id) =>
      id === 'b' ? picture(PNG, 'image/png') : picture(JPEG)
    );
    const { photos, failed } = await fetchPhotoDataUrls(['a', 'b', 'a', 'c', 'b'], {
      fetchImpl,
      urlOf,
    });
    expect([...calls].sort()).toEqual([urlOf('a'), urlOf('b'), urlOf('c')]);
    expect(failed).toEqual([]);
    expect([...photos.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(photos.get('a')).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    expect(photos.get('b')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('by default, the thumbnail on the API origin', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
    const fresh = await import('@/lib/pdf/photoFetch');
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return picture(JPEG);
    }) as typeof fetch;
    const { photos } = await fresh.fetchPhotoDataUrls([id], { fetchImpl });
    expect(calls).toEqual([`https://api.example.test/v1/photos/${id}/thumb`]);
    expect(photos.has(id)).toBe(true);
  });

  it('never more than `concurrency` at a time: 3 when told, 6 unless told', async () => {
    for (const [concurrency, expected] of [
      [3, 3],
      [undefined, 6],
    ] as const) {
      let inFlight = 0;
      let most = 0;
      const { fetchImpl } = fakeFetch(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await later(5);
        inFlight -= 1;
        return picture(JPEG);
      });
      const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
      const { photos } = await fetchPhotoDataUrls(ids, { fetchImpl, urlOf, concurrency });
      expect(photos.size).toBe(20);
      expect(most, `concurrency ${concurrency}`).toBe(expected);
    }
  });

  it('the progress: at the start, then after each photo, ending at (total, total)', async () => {
    const reports: Array<[number, number]> = [];
    const { fetchImpl } = fakeFetch((id) =>
      id === 'b' ? new Response('', { status: 404 }) : picture(JPEG)
    );
    await fetchPhotoDataUrls(['a', 'b', 'a', 'c'], {
      fetchImpl,
      urlOf,
      onProgress: (done, total) => reports.push([done, total]),
    });
    expect(reports).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});

describe('PDF-5 fetchPhotoDataUrls: a photo that fails', () => {
  it('404, a network error, a page that is not a picture and a photo that never answers are failed; the others arrive', async () => {
    const { fetchImpl, calls, signals } = fakeFetch((id) => {
      switch (id) {
        case 'missing':
          return new Response('Not found', {
            status: 404,
            headers: { 'content-type': 'image/jpeg' },
          });
        case 'broken':
          throw new TypeError('Failed to fetch');
        case 'html':
          return new Response('<html></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        case 'slow':
          // never answers, and pays no attention to its signal
          return new Promise<Response>(() => {});
        default:
          return picture(JPEG);
      }
    });
    const reports: Array<[number, number]> = [];
    const started = Date.now();
    const { photos, failed } = await fetchPhotoDataUrls(
      ['first', 'missing', 'broken', 'html', 'slow', 'last'],
      { fetchImpl, urlOf, timeoutMs: 50, onProgress: (done, total) => reports.push([done, total]) }
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect([...photos.keys()].sort()).toEqual(['first', 'last']);
    expect(failed).toEqual(['missing', 'broken', 'html', 'slow']);
    expect(calls).toHaveLength(6);
    expect(reports.at(-1)).toEqual([6, 6]);
    // the photo that took too long was told to stop
    expect(signals[calls.indexOf(urlOf('slow'))].aborted).toBe(true);
  });

  it('a picture the PDF cannot draw is failed too, so its card shows No photo and the PDF is still made', async () => {
    const bodies: Record<string, [Uint8Array<ArrayBuffer>, string]> = {
      // a WebP: pdfmake draws JPEG and PNG only
      webp: [
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
        'image/webp',
      ],
      empty: [new Uint8Array(0), 'image/jpeg'],
      // a JPEG cut before its size, and the e2e file's PNG, cut short: pdfmake would throw on either, and so lose every other photo with them
      cutJpeg: [new Uint8Array(JPEG.subarray(0, 95)), 'image/jpeg'],
      e2ePng: [new Uint8Array(Buffer.from(E2E_PNG_HEX, 'hex')), 'image/png'],
      jpeg: [new Uint8Array(JPEG), 'image/jpeg'],
      png: [new Uint8Array(PNG), 'image/png'],
    };
    const { fetchImpl } = fakeFetch((id) => {
      const [bytes, type] = bodies[id];
      return new Response(bytes, { status: 200, headers: { 'content-type': type } });
    });
    const { photos, failed } = await fetchPhotoDataUrls(Object.keys(bodies), { fetchImpl, urlOf });
    expect([...photos.keys()].sort()).toEqual(['jpeg', 'png']);
    expect(failed).toEqual(['webp', 'empty', 'cutJpeg', 'e2ePng']);
  });

  it('an address that cannot be made is a failed photo, not a failed PDF', async () => {
    const { fetchImpl, calls } = fakeFetch(() => picture(JPEG));
    const { photos, failed } = await fetchPhotoDataUrls(['bad', 'good'], {
      fetchImpl,
      urlOf: (id) => {
        if (id === 'bad') throw new Error('A photo id is a UUID.');
        return urlOf(id);
      },
    });
    expect(failed).toEqual(['bad']);
    expect([...photos.keys()]).toEqual(['good']);
    expect(calls).toEqual([urlOf('good')]);
  });
});

describe('PDF-5 fetchPhotoDataUrls: Stop', () => {
  it('aborting rejects with an AbortError and starts no new fetch', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const { fetchImpl, calls, signals } = fakeFetch(
      () => new Promise<Response>((resolve) => waiting.push(resolve))
    );
    const reports: Array<[number, number]> = [];
    const stop = new AbortController();
    const fetching = fetchPhotoDataUrls(
      Array.from({ length: 10 }, (_, i) => `p${i}`),
      {
        fetchImpl,
        urlOf,
        concurrency: 2,
        signal: stop.signal,
        onProgress: (d, t) => reports.push([d, t]),
      }
    );
    await later(5);
    expect(calls).toHaveLength(2);
    stop.abort();
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
    // the two in flight were told to stop; when they answer anyway, nothing more is fetched or reported
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const answer of waiting) answer(picture(JPEG));
    await later(20);
    expect(calls).toHaveLength(2);
    expect(reports).toEqual([[0, 10]]);
  });

  it('a signal already aborted fetches nothing', async () => {
    const { fetchImpl, calls } = fakeFetch(() => picture(JPEG));
    const reports: Array<[number, number]> = [];
    await expect(
      fetchPhotoDataUrls(['a', 'b'], {
        fetchImpl,
        urlOf,
        signal: AbortSignal.abort(),
        onProgress: (d, t) => reports.push([d, t]),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('no photos: nothing fetched, the progress (0, 0)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => picture(JPEG));
    const reports: Array<[number, number]> = [];
    const result = await fetchPhotoDataUrls([], {
      fetchImpl,
      urlOf,
      onProgress: (d, t) => reports.push([d, t]),
    });
    expect(result.photos.size).toBe(0);
    expect(result.failed).toEqual([]);
    expect(calls).toEqual([]);
    expect(reports).toEqual([[0, 0]]);
  });
});

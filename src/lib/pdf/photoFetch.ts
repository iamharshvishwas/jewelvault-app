// PDF-5: the photos of the catalogue PDF, fetched by the page and handed to pdfmake as data URLs. They are the 320 px thumbnails (`photoUrl(id, 'thumb')`, on the API's origin), which
// the API serves with no cookie and with CORS for the website. Each distinct photo is asked for once, at most `concurrency` at a time. A photo that answers 404, fails on the network, answers
// something that is not a picture the PDF can draw, or takes longer than `timeoutMs` is left out (`failed`: its card shows `No photo`) and the others go on: one photo never stops the paper.
// The progress is reported at the start, (0, total), so the screen can show `photos 0 of {total}` at once, and after each photo. Stop (the signal) ends it with an AbortError: the photos in
// flight are told to stop and nothing new is started.
// Pure: no window, document or navigator, and no FileReader (Node has none): the bytes are made base64 with btoa.
import { photoUrl } from '@/lib/photos';

export interface PhotoFetchOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** How many photos are fetched at a time: 6. */
  concurrency?: number;
  /** How long a photo may take before it counts as failed: 20 seconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** The address of a photo: its thumbnail, `photoUrl(id, 'thumb')`. */
  urlOf?: (photoId: string) => string;
}

const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;

function abortError(): DOMException {
  return new DOMException('The photos were not fetched: stopped.', 'AbortError');
}

// pdfmake draws JPEG and PNG only, and throws on a picture it cannot open, which would cost the whole PDF. So a picture is known by its bytes, whatever the answer calls it, and checked
// as far as pdfmake reads it before drawing: a JPEG's frame header (its size), a PNG's chunks from IHDR to IEND.
const JPEG_FRAMES = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const uint16 = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const uint32 = (bytes: Uint8Array, at: number) =>
  uint16(bytes, at) * 0x10000 + uint16(bytes, at + 2);

/** A JPEG: FF D8, then segment after segment to a frame header with a width, a height and 1, 3 or 4 colours. */
function isJpeg(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (JPEG_FRAMES.has(marker)) {
      // length (2), bits (1), height (2), width (2), colours (1)
      return (
        at + 10 <= bytes.length &&
        uint16(bytes, at + 5) > 0 &&
        uint16(bytes, at + 7) > 0 &&
        [1, 3, 4].includes(bytes[at + 9])
      );
    }
    at += marker === 0xff ? 1 : 2 + uint16(bytes, at + 2);
  }
  return false;
}

/** A PNG: its signature, then whole chunks (length, type, data, check) from IHDR, with a width and a height, through picture data to IEND. */
function isPng(bytes: Uint8Array): boolean {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return false;
  let at = PNG_SIGNATURE.length;
  let pictureData = false;
  while (at + 12 <= bytes.length) {
    const size = uint32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size > bytes.length - at - 12) return false;
    if (at === PNG_SIGNATURE.length) {
      if (type !== 'IHDR' || size !== 13) return false;
      if (uint32(bytes, at + 8) === 0 || uint32(bytes, at + 12) === 0) return false;
    }
    if (type === 'IDAT') pictureData = true;
    if (type === 'IEND') return pictureData;
    at += 12 + size;
  }
  return false;
}

const isDrawable = (bytes: Uint8Array): boolean => isJpeg(bytes) || isPng(bytes);

function base64(bytes: Uint8Array): string {
  let binary = '';
  // in pieces: a call with a whole photo's bytes as arguments would pass the engine's limit
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The data URL of an answer, with its own content type; null when it is not a picture the PDF can draw. */
async function dataUrlOf(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return isDrawable(bytes) ? `data:${type};base64,${base64(bytes)}` : null;
}

/** One photo as a data URL, or null when it failed. Gives up after `timeoutMs`, or at once when `signal` aborts, even if the fetch pays no attention to its own signal. */
async function fetchOne(
  address: () => string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const controller = new AbortController();
  let giveUp = () => {};
  const gaveUp = new Promise<null>((resolve) => {
    giveUp = () => {
      controller.abort();
      resolve(null);
    };
  });
  const timer = setTimeout(giveUp, timeoutMs);
  signal?.addEventListener('abort', giveUp);
  try {
    return await Promise.race([
      fetchImpl(address(), { signal: controller.signal }).then(dataUrlOf),
      gaveUp,
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', giveUp);
  }
}

/** The photos as data URLs by photo id, and the ids that failed (in the order given). Rejects with an AbortError when `signal` aborts. */
export async function fetchPhotoDataUrls(
  photoIds: readonly string[],
  options: PhotoFetchOptions = {}
): Promise<{ photos: Map<string, string>; failed: string[] }> {
  const { signal, onProgress } = options;
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const urlOf = options.urlOf ?? ((photoId: string) => photoUrl(photoId, 'thumb'));
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const lanes = Math.max(1, Math.floor(options.concurrency ?? CONCURRENCY));
  const ids = [...new Set(photoIds)];
  const total = ids.length;
  const photos = new Map<string, string>();
  if (signal?.aborted) throw abortError();

  let next = 0;
  let done = 0;
  onProgress?.(0, total);
  // Each lane takes the next photo when its last one is done, until there are none left or Stop is pressed.
  const lane = async () => {
    while (next < total && !signal?.aborted) {
      const photoId = ids[next++];
      const dataUrl = await fetchOne(() => urlOf(photoId), fetchImpl, timeoutMs, signal);
      if (signal?.aborted) return;
      if (dataUrl !== null) photos.set(photoId, dataUrl);
      done += 1;
      onProgress?.(done, total);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(lanes, total) }, lane));

  if (signal) {
    // Stop answers at once, without waiting for the photos in flight to give up.
    let onAbort = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([all, stopped]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw abortError();
  } else {
    await all;
  }
  return { photos, failed: ids.filter((photoId) => !photos.has(photoId)) };
}

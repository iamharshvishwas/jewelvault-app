// Photos of a design (spec P1 to P4, C11; task WEB06). The photo is made in the browser and kept by the API:
//
//   - the page resizes a picture to a longest side of 1000 px at JPEG quality 72 and makes a thumbnail with a longest side of 320 px (Harsh's decision of 15 Oct 2026, P2; the numbers
//     are kept in the setting `photos`, D3, and these decisions stand wherever it is missing or wrong); the server does no image work. A turn of the picture is made in the picture, not only on the screen;
//   - the page makes the design's id and one id per photo BEFORE it uploads (P2, C11): the photo goes up under its id as two objects, `kind=full` then `kind=thumb`
//     (`PUT /v1/designs/{design_id}/photos/{photo_id}?kind=…`, the raw bytes as the body), and only then is create_design called with the ids. The upload is insert-only: a pair that
//     the server already holds is "duplicate", which here means it is stored (the answer to an earlier try was lost). At most 3 photos belong to a design;
//   - a design row holds only photo ids (P4): nothing in this file makes image text, and the only thing kept in the page is the pictures themselves, in memory, until they are sent;
//   - the address of a photo to show is on the API's origin (`photoUrl`, NEXT_PUBLIC_API_URL): `/v1/photos/{id}/full` for the gallery, `/thumb` for lists.
import { ApiError, api, isApiError } from '@/lib/api/client';
import { rowCache } from '@/lib/cache/cache';

export type PhotoKind = 'full' | 'thumb';

export interface PhotoRules {
  /** P1: how many photos a design can have. */
  maxPerDesign: number;
  /** P2: the longest side of the full picture, in pixels. */
  fullSide: number;
  /** P2: the longest side of the thumbnail, in pixels. */
  thumbSide: number;
  /** P2: the JPEG quality, as the canvas takes it (0.72 is quality 72). */
  quality: number;
}

/** The decisions of Harsh (15 Oct 2026) about a photo: at most 3, longest side 1000 px at quality 72, a thumbnail of 320 px. They are also what the setting `photos` is seeded with. */
export const PHOTO_RULES: Readonly<PhotoRules> = {
  maxPerDesign: 3,
  fullSide: 1000,
  thumbSide: 320,
  quality: 0.72,
};

/** The most photos the API takes for a design (P1, P2): a setting cannot raise it. */
const API_MAX_PHOTOS = 3;

const wholeNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;

/**
 * The photo rules from the value of the setting `photos` (D3: `maxPerDesign`, `maxSidePx`, `jpegQuality`, `thumbSidePx`). A number that is missing, is not a number, or is outside
 * what makes sense (a design holds at most 3 photos on the API; a picture of 200 to 4000 px; a thumbnail of 50 px up to the full size; a quality from 0.3 to 0.95) is replaced by the
 * decision above, so that a wrong setting can neither stop photos nor make one the API refuses.
 */
export function photoRulesFrom(value: unknown): PhotoRules {
  const setting =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const fullSide = wholeNumber(setting.maxSidePx, 200, 4000, PHOTO_RULES.fullSide);
  const quality = setting.jpegQuality;
  return {
    maxPerDesign: wholeNumber(setting.maxPerDesign, 1, API_MAX_PHOTOS, PHOTO_RULES.maxPerDesign),
    fullSide,
    thumbSide: wholeNumber(
      setting.thumbSidePx,
      50,
      fullSide,
      Math.min(PHOTO_RULES.thumbSide, fullSide)
    ),
    quality:
      typeof quality === 'number' && quality >= 0.3 && quality <= 0.95
        ? quality
        : PHOTO_RULES.quality,
  };
}

/** The rules in force: the setting `photos` in memory (every role reads it), else the decisions. */
export function currentPhotoRules(): PhotoRules {
  return photoRulesFrom(rowCache.get('settings', 'photos')?.value);
}

/** A picture much larger than a phone makes is refused before it is decoded: the decoded size, not the file, is what fills the memory. */
export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

export const CANNOT_READ_MESSAGE = 'This picture could not be read. Use a JPEG, PNG or WebP photo.';
export const CANNOT_PREPARE_MESSAGE = 'This picture could not be prepared. Try another photo.';

// ------------------------------------------------------------------------------------------------ the size

/** The size of a picture that fits inside `longestSide` with the same shape. A picture that is smaller already is not enlarged; a side is never 0. */
export function fitWithin(
  width: number,
  height: number,
  longestSide: number
): { width: number; height: number } {
  const scale = Math.min(1, longestSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ------------------------------------------------------------------------------------------------ making the pictures

export interface DecodedImage {
  /** Pixels, the way the person sees the picture (the camera's turn is applied). */
  width: number;
  height: number;
  close(): void;
}

/** The two things only a browser can do: read a picture and write a JPEG. The tests give it a stand-in. */
export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>;
  /** A JPEG of `size`, turned `quarterTurns` quarter turns clockwise (0 to 3), at `quality` (0 to 1). */
  encode(
    image: DecodedImage,
    size: { width: number; height: number },
    quarterTurns: number,
    quality: number
  ): Promise<Blob>;
}

interface BrowserImage extends DecodedImage {
  bitmap: ImageBitmap;
}

const browserCodec: ImageCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const image: BrowserImage = {
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      close: () => bitmap.close(),
    };
    return image;
  },
  async encode(image, size, quarterTurns, quality) {
    const { bitmap } = image as BrowserImage;
    const turned = quarterTurns % 2 === 1;
    const canvas = document.createElement('canvas');
    canvas.width = turned ? size.height : size.width;
    canvas.height = turned ? size.width : size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas.');
    // a JPEG has no transparency: a transparent PNG would turn black
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((quarterTurns * Math.PI) / 2);
    context.drawImage(bitmap, -size.width / 2, -size.height / 2, size.width, size.height);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The picture was not written.'))),
        'image/jpeg',
        quality
      );
    });
  },
};

export interface PreparedImage {
  full: Blob;
  thumb: Blob;
}

/**
 * The two pictures of a photo (P2): the full one with a longest side of 1000 px and the thumbnail with 320 px, both JPEG at quality 72 (the rules of the setting `photos`, else
 * these decisions), turned `quarterTurns` quarter turns clockwise. Throws an Error with a plain message when the file is not a picture the browser can read.
 */
export async function prepareImage(
  file: Blob,
  options: { quarterTurns?: number; codec?: ImageCodec; rules?: PhotoRules } = {}
): Promise<PreparedImage> {
  const codec = options.codec ?? browserCodec;
  const rules = options.rules ?? currentPhotoRules();
  const turns = (((options.quarterTurns ?? 0) % 4) + 4) % 4;
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new Error(CANNOT_READ_MESSAGE);
  }
  try {
    const full = await codec.encode(
      image,
      fitWithin(image.width, image.height, rules.fullSide),
      turns,
      rules.quality
    );
    const thumb = await codec.encode(
      image,
      fitWithin(image.width, image.height, rules.thumbSide),
      turns,
      rules.quality
    );
    return { full, thumb };
  } catch {
    throw new Error(CANNOT_PREPARE_MESSAGE);
  } finally {
    image.close();
  }
}

// ------------------------------------------------------------------------------------------------ the upload

/**
 * A photo ready to go up: its id (made by the page, C11), the two pictures, and, for each kind, the design id it is stored under on the server (null: not yet). The record is
 * kept by the screen from one try to the next, so a second Save sends only what is missing.
 */
export interface PhotoToUpload {
  photoId: string;
  full: Blob;
  thumb: Blob;
  stored: Record<PhotoKind, string | null>;
}

/** The address of a photo to show (P3): on the API's origin, from NEXT_PUBLIC_API_URL. */
export function photoUrl(photoId: string, kind: PhotoKind): string {
  return api.photoUrl(photoId, kind);
}

/** The plain words for a refused or failed photo upload (C13): never a code, never the API's detail. */
export function photoErrorMessage(error: unknown): string {
  if (!isApiError(error))
    return error instanceof Error ? error.message : 'The photo could not be sent.';
  switch (error.code) {
    case 'JV_NOT_ALLOWED':
      switch (error.details.reason) {
        case 'design_full':
          return 'A design can have at most 3 photos.';
        case 'unattached_count':
        case 'unattached_bytes':
          return 'Too many photos are waiting for a design to be saved. Save the designs you have started first.';
        case 'database_full':
          return 'The photo store is full, so no photo can be added now. Tell the owner.';
        default:
          return 'This photo cannot be added.';
      }
    case 'JV_PAYLOAD_TOO_LARGE':
      return 'That photo is too large.';
    case 'JV_UNSUPPORTED_MEDIA_TYPE':
      return 'That file is not a picture. Use a JPEG, PNG or WebP photo.';
    case 'JV_RATE_LIMITED':
      return 'Too many photos were sent at once. Wait a minute and try again.';
    case 'JV_FORBIDDEN':
      return 'You are not allowed to add photos.';
    case 'JV_UNAUTHENTICATED':
    case 'JV_SESSION_EXPIRED':
      return error.message;
    case 'NETWORK':
      return 'The photo could not be sent: no connection to the server. Try again.';
    case 'GATEWAY':
    case 'JV_UNAVAILABLE':
      return 'The photo could not be sent: the server is not answering. Try again in a minute.';
    default:
      return 'The photo could not be sent. Try again.';
  }
}

/** The same failure as the API's, with the words of `photoErrorMessage`. */
function photoFailure(error: unknown): unknown {
  if (!isApiError(error)) return error;
  return new ApiError({
    code: error.code,
    status: error.status,
    message: photoErrorMessage(error),
    details: error.details,
    requestId: error.requestId,
    idempotencyKey: error.idempotencyKey,
    retryAfterS: error.retryAfterS,
    write: true,
  });
}

/**
 * Uploads the two objects of a photo under the design's id: the full picture, then the thumbnail. A kind that is stored for this design id is not sent again; "duplicate" from
 * the server counts as stored (insert-only, and the id is this page's own). Any other refusal ends the upload and is thrown as an ApiError with the plain words of C13.
 */
export async function uploadPhoto(designId: string, photo: PhotoToUpload): Promise<void> {
  for (const kind of ['full', 'thumb'] as const) {
    if (photo.stored[kind] === designId) continue;
    try {
      await api.upload(`/v1/designs/${designId}/photos/${photo.photoId}`, photo[kind], {
        query: { kind },
      });
    } catch (error) {
      const duplicate =
        isApiError(error) &&
        error.code === 'JV_NOT_ALLOWED' &&
        error.details.reason === 'duplicate';
      if (!duplicate) throw photoFailure(error);
    }
    photo.stored[kind] = designId;
  }
}

/**
 * Image upload validation for AMPED-05A.
 *
 * Nothing a client says about a file is trusted. The declared Content-Type is
 * only allowed to agree with what the bytes actually are; the filename never
 * decides anything; and the storage key is generated entirely server-side.
 *
 * Supported formats are exactly JPEG, PNG, WebP and AVIF. The dimension
 * inspector is a small pure-TypeScript parser for those four containers, so it
 * runs under workerd without a native image library. It reads header metadata
 * only - no decoding, so a decompression bomb cannot cost us memory; it is
 * rejected before anything is written.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_DIMENSION = 12_000;
export const MAX_PIXELS = 80_000_000;

export type AllowedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

export const ALLOWED_MIME: readonly AllowedMime[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
];

export type MediaRole = 'poster' | 'hero' | 'gallery' | 'artist' | 'venue' | 'og';

export const MEDIA_ROLES: readonly MediaRole[] = [
  'poster',
  'hero',
  'gallery',
  'artist',
  'venue',
  'og',
];

const EXTENSION: Record<AllowedMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** Controlled upload failure. `status` is the HTTP status the API should use. */
export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly fields: Record<string, string>,
    message = 'Upload rejected.',
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

// ---------------------------------------------------------------------------
// Dimension inspection (header metadata only)
// ---------------------------------------------------------------------------

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  // 8-byte signature, then the IHDR chunk: length(4) 'IHDR' width(4) height(4).
  if (bytes.length < 24) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    // flags(1) reserved(3), then canvas size minus one, 24-bit little-endian.
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    // Frame tag(3), start code 9d 01 2a, then 14-bit width and height.
    const width = ((bytes[27]! << 8) | bytes[26]!) & 0x3fff;
    const height = ((bytes[29]! << 8) | bytes[28]!) & 0x3fff;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    // Signature 0x2f, then 14-bit width-1 and height-1.
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  return null;
}

/**
 * AVIF is ISOBMFF: the primary item's size lives in an `ispe` property box.
 * We read the first `ispe` in the file, which is the primary image property in
 * practice; for validation purposes that is enough to bound the dimensions.
 */
function avifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 4);
  if (brand !== 'avif' && brand !== 'avis' && ascii(bytes, 16, 4) !== 'avif') return null;

  const signature = [0x69, 0x73, 0x70, 0x65]; // 'ispe'
  for (let i = 0; i + 12 <= bytes.length; i += 1) {
    if (
      bytes[i] === signature[0] &&
      bytes[i + 1] === signature[1] &&
      bytes[i + 2] === signature[2] &&
      bytes[i + 3] === signature[3]
    ) {
      // version/flags(4) then width(4) height(4)
      return { width: u32be(bytes, i + 8), height: u32be(bytes, i + 12) };
    }
  }
  return null;
}

export interface ImageInfo {
  mime: AllowedMime;
  width: number;
  height: number;
}

/** Detect the container from its bytes and read its dimensions. Null if unsupported. */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const size = pngDimensions(bytes);
    return size ? { mime: 'image/png', ...size } : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegDimensions(bytes);
    return size ? { mime: 'image/jpeg', ...size } : null;
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpDimensions(bytes);
    return size ? { mime: 'image/webp', ...size } : null;
  }
  const avif = avifDimensions(bytes);
  if (avif) return { mime: 'image/avif', ...avif };
  return null;
}

/** Storage key: random id plus an extension derived only from detected MIME. */
export function storageKeyFor(mediaId: string, mime: AllowedMime): string {
  return `media/${mediaId}.${EXTENSION[mime]}`;
}

/** Public application URL for an asset: identifier-addressed, never a path. */
export function mediaUrlFor(mediaId: string): string {
  return `/media/${mediaId}`;
}

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------

export interface ValidatedUpload {
  mime: AllowedMime;
  width: number;
  height: number;
  byteSize: number;
  bytes: Uint8Array;
  alt: string;
  credit?: string;
  role: MediaRole;
  eventId?: string;
  artistId?: string;
}

export interface UploadFields {
  file: File;
  alt: unknown;
  role: unknown;
  credit?: unknown;
  eventId?: unknown;
  artistId?: unknown;
}

function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate an uploaded file end to end. The declared MIME must be one of the
 * four supported types AND must match what the bytes actually are.
 */
export async function validateUpload(fields: UploadFields): Promise<ValidatedUpload> {
  const role = field(fields.role) as MediaRole;
  if (!MEDIA_ROLES.includes(role)) {
    throw new UploadError(400, { role: 'Choose a supported image role.' });
  }

  const alt = field(fields.alt);
  if (alt.length === 0) {
    throw new UploadError(400, { alt: 'Alt text is required so the image is usable to everyone.' });
  }
  if (alt.length > 400) {
    throw new UploadError(400, { alt: 'Alt text is too long.' });
  }

  const eventId = field(fields.eventId);
  const artistId = field(fields.artistId);
  if (eventId && artistId) {
    throw new UploadError(400, { eventId: 'Attach an image to an event or an artist, not both.' });
  }

  const declared = field(fields.file.type);
  if (!ALLOWED_MIME.includes(declared as AllowedMime)) {
    throw new UploadError(400, {
      file: 'Only JPEG, PNG, WebP or AVIF images can be uploaded.',
    });
  }

  // Size is checked against the real File size before any parsing.
  if (fields.file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, { file: 'Images must be 8 MiB or smaller.' });
  }

  const bytes = new Uint8Array(await fields.file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, { file: 'Images must be 8 MiB or smaller.' });
  }

  const info = inspectImage(bytes);
  if (!info) {
    throw new UploadError(400, { file: 'That file is not a valid JPEG, PNG, WebP or AVIF image.' });
  }
  if (info.mime !== declared) {
    // A PNG masquerading as a JPEG (or the reverse) is refused: the extension
    // and Content-Type are claims, the bytes are the fact.
    throw new UploadError(400, {
      file: 'The file contents do not match the declared image type.',
    });
  }

  if (info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
    throw new UploadError(400, {
      file: `Images must be at most ${MAX_DIMENSION} pixels on either side.`,
    });
  }
  if (info.width * info.height > MAX_PIXELS) {
    throw new UploadError(400, { file: 'That image has too many pixels.' });
  }

  const credit = field(fields.credit);

  return {
    mime: info.mime,
    width: info.width,
    height: info.height,
    byteSize: bytes.byteLength,
    bytes,
    alt,
    ...(credit ? { credit } : {}),
    role,
    ...(eventId ? { eventId } : {}),
    ...(artistId ? { artistId } : {}),
  };
}

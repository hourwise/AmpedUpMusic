/**
 * Local QR-to-PNG rendering (AMPED-08C1).
 *
 * The email attachments must be PNG images, and nothing may leave the Worker:
 * no external QR service, no canvas, no native module. The `qrcode-svg`
 * package (already accepted in AMPED-08B) computes the QR module matrix in
 * pure JavaScript; this module encodes that matrix as a 1-bit greyscale PNG.
 *
 * PNG is used rather than SVG attachments because email clients vary wildly
 * in their SVG support, while a PNG renders everywhere. The encoder is
 * deliberately small and self-contained: the PNG spec only needs a signature,
 * an IHDR, pixel data compressed with zlib, and an IEND — and the Workers
 * runtime provides the zlib stream (`CompressionStream('deflate')`), so only
 * the chunk framing and CRC-32 are ours to write.
 *
 * Determinism: the same token produces the same bytes in a given runtime.
 * Tests pin byte-for-byte equality of repeated renders, which is what the
 * frozen payload snapshot relies on.
 */

import QRCode from 'qrcode-svg';

/** Pixels per QR module in the attached PNG. 8 gives a ~300px image. */
export const QR_PNG_PIXELS_PER_MODULE = 8;

/** Quiet zone in modules. The QR specification asks for at least 4. */
export const QR_PNG_QUIET_ZONE_MODULES = 4;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The QR module matrix for a token, exactly as the provider-independent QR. */
export function ticketQrMatrix(token: string): { modules: boolean[][]; size: number } {
  // padding is irrelevant here: the PNG adds its own, measured in modules.
  const code = new QRCode({ content: token, padding: 0, width: 1, height: 1, ecl: 'M' });
  return { modules: code.qrcode.modules, size: code.qrcode.moduleCount };
}

/**
 * Encode a token as a 1-bit greyscale PNG.
 *
 * Dark modules are 0 (black), light modules are 1 (white): the quiet zone is
 * therefore white without special-casing any pixel.
 */
export async function renderTicketQrPng(token: string): Promise<Uint8Array> {
  const { modules, size } = ticketQrMatrix(token);
  const quiet = QR_PNG_QUIET_ZONE_MODULES;
  const side = (size + quiet * 2) * QR_PNG_PIXELS_PER_MODULE;
  const rowBytes = Math.ceil(side / 8);

  // Each scanline is a filter byte (0 = None) followed by packed pixels.
  const raw = new Uint8Array((rowBytes + 1) * side);
  for (let y = 0; y < side; y += 1) {
    const moduleRow = Math.floor(y / QR_PNG_PIXELS_PER_MODULE) - quiet;
    const rowStart = y * (rowBytes + 1);
    for (let x = 0; x < side; x += 1) {
      const moduleCol = Math.floor(x / QR_PNG_PIXELS_PER_MODULE) - quiet;
      const dark =
        moduleRow >= 0 && moduleRow < size && moduleCol >= 0 && moduleCol < size
          ? modules[moduleRow]![moduleCol]!
          : false;
      if (!dark) {
        raw[rowStart + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = await zlibDeflate(raw);
  return concatBytes(PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
}

/** Base64 for attachment payloads. Chunked so a large image cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  // `deflate` is the zlib wrapper (RFC 1950) that PNG's IDAT requires. The
  // reader is consumed CONCURRENTLY with the write: awaiting the write first
  // deadlocks once the transformed output outgrows the internal queue.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  const output = collectBytes(compressor.readable);
  await writer.write(copy);
  await writer.close();
  return output;
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (char) => char.charCodeAt(0));
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

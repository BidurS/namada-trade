// The PNG file for an RGB pixel buffer: the signature, IHDR, one IDAT and IEND, each chunk with its CRC-32. The
// scanlines are filtered (None, Sub or Up, chosen per row by the smallest sum of absolute values, the heuristic the
// PNG specification suggests) and compressed with the platform's CompressionStream('deflate'), which is the zlib
// framing PNG requires (RFC 1950: a 2-byte header and the Adler-32 trailer; 'deflate-raw' would not do). No
// dependencies: Uint8Array, DataView and CompressionStream only, so it runs in the Worker and in Node alike.
//
// Determinism: the filtered scanlines are a pure function of the pixels (filteredRows), so a fingerprint of a
// picture is a hash of them. The deflate bytes depend on the runtime's zlib build and level: the PNG file is
// byte-stable within one runtime (the same input gives the same file in the same Worker or Node build), but a file
// made in Node may differ by a few bytes from the Worker's for the same pixels, and both are valid.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the IEEE 802.3 polynomial, as PNG uses) over bytes[start, end). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];

/** Bytes a pixel: RGB, 8 bits a sample. */
const BPP = 3;

/**
 * The filtered scanlines of a w × h RGB buffer: one filter byte and 3 × w bytes a row. A pure function of the
 * pixels, with no compression, so two renders of the same picture give the same bytes here on every runtime.
 */
export function filteredRows(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const stride = w * BPP;
  if (rgb.length !== stride * h) throw new Error(`pixel buffer is ${rgb.length} bytes, expected ${stride * h}`);
  const out = new Uint8Array((stride + 1) * h);
  const sub = new Uint8Array(stride);
  const up = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const prev = (y - 1) * stride;
    let sumNone = 0;
    let sumSub = 0;
    let sumUp = 0;
    for (let i = 0; i < stride; i++) {
      const v = rgb[row + i];
      const left = i >= BPP ? rgb[row + i - BPP] : 0;
      const above = y > 0 ? rgb[prev + i] : 0;
      sub[i] = (v - left) & 255;
      up[i] = (v - above) & 255;
      // the heuristic sums each filtered byte as a signed value
      sumNone += v < 128 ? v : 256 - v;
      sumSub += sub[i] < 128 ? sub[i] : 256 - sub[i];
      sumUp += up[i] < 128 ? up[i] : 256 - up[i];
    }
    const o = y * (stride + 1);
    if (sumUp <= sumSub && sumUp <= sumNone) {
      out[o] = 2;
      out.set(up, o + 1);
    } else if (sumSub <= sumNone) {
      out[o] = 1;
      out.set(sub, o + 1);
    } else {
      out[o] = 0;
      out.set(rgb.subarray(row, row + stride), o + 1);
    }
  }
  return out;
}

/** zlib-framed deflate through the platform's CompressionStream. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream is not available on this runtime');
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  })();
  // a copy onto a plain ArrayBuffer: the stream's BufferSource type refuses a view that might sit on a SharedArrayBuffer
  const plain = new Uint8Array(new ArrayBuffer(data.byteLength));
  plain.set(data);
  await writer.write(plain);
  await writer.close();
  await pump;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** One chunk: length, type, data, CRC over type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** The PNG file for a w × h RGB buffer (8 bits a sample, colour type 2, no interlace). */
export async function encodePng(w: number, h: number, rgb: Uint8Array): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: the five adaptive filters
  ihdr[12] = 0; // no interlace
  const idat = await deflate(filteredRows(w, h, rgb));
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

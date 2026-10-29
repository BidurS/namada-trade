// The depth archive (plan 1.6, cap C6): one gzipped JSON object per live pool per hour under
// depth/raw/<pool>/<YYYY>/<MM>/<DD>/<HH>.json.gz and one with the hour's positions and orders under
// depth/positions/<YYYY>/<MM>/<DD>/<HH>.json.gz, written by the hourly job only when the bucket is bound (the binding is
// optional: without it nothing is archived and the owners row says so) and only when the object stays under the cap;
// an object over it is not written and named. Nothing is ever read back by the Worker: the archive is where the raw
// ticks, reserves and orders stay so the stored offsets can be recomputed if the offset set changes.

/** The platform's gzip (CompressionStream exists in the Worker and in Node alike). */
export async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream is not available on this runtime');
  const cs = new CompressionStream('gzip');
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
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const te = new TextEncoder();
export const gzipJson = (value: unknown): Promise<Uint8Array> => gzipBytes(te.encode(JSON.stringify(value)));

/** The object key of a pool's raw state for the hour, or of the hour's positions and orders when `poolId` is null. */
export function archiveKey(poolId: string | null, hour: number): string {
  const d = new Date(hour);
  const p = (n: number) => String(n).padStart(2, '0');
  const path = `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}.json.gz`;
  return poolId == null ? `depth/positions/${path}` : `depth/raw/${poolId}/${path}`;
}

export type ArchiveResult = { key: string; bytes: number } | { key: string; skipped: string };

/** What the hourly job needs of the bucket (the R2 binding's put). */
export interface ArchiveBucket { put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; contentEncoding?: string } }): Promise<unknown> }

/** One object into the archive: gzipped, written only under `maxBytes` (C6), the failure named and never thrown. */
export async function archiveObject(bucket: ArchiveBucket, key: string, value: unknown, maxBytes: number): Promise<ArchiveResult> {
  let gz: Uint8Array;
  try { gz = await gzipJson(value); } catch (e) { return { key, skipped: `not compressed: ${String((e as Error)?.message ?? e).slice(0, 80)}` }; }
  if (gz.byteLength > maxBytes) return { key, skipped: `${gz.byteLength} bytes, over the cap of ${maxBytes}: not written` };
  const buf = new ArrayBuffer(gz.byteLength);
  new Uint8Array(buf).set(gz);
  try {
    await bucket.put(key, buf, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' } });
    return { key, bytes: gz.byteLength };
  } catch (e) {
    return { key, skipped: `put failed: ${String((e as Error)?.message ?? e).slice(0, 80)}` };
  }
}

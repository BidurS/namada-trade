// Security review (2026-10-22), producer answers are read with a byte cap: a node, the indexer, SQS or the forum
// answering with a body too large for the isolate is refused while it streams, so the next node is still asked, and
// an error answer is read only for the part HttpError keeps.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, fetchText, HttpError, ResponseTooLargeError, FETCH_JSON_MAX_BYTES, FETCH_TEXT_MAX_BYTES } from '../worker/src/util';
import { namadaStatus, namadaStatusAny, blockResults, LIVE_READ, RpcBreaker } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';

afterEach(() => vi.unstubAllGlobals());

const MiB = 1024 * 1024;
const status = (height: number) => ({ result: { sync_info: { latest_block_height: String(height), latest_block_time: '2026-10-20T00:00:00Z', catching_up: false, earliest_block_height: '1' } } });

/** One valid JSON document of `size` bytes (a status padded with "x"), served 1 MiB a pull, with the pulls counted. */
function padded(size: number, height = 5) {
  const head = JSON.stringify(status(height)).slice(0, -1) + ',"pad":"';
  const doc = new Uint8Array(size).fill(0x78);
  doc.set(new TextEncoder().encode(head), 0);
  doc.set(new TextEncoder().encode('"}'), size - 2);
  const s = { pulled: 0 };
  const chunks = Math.ceil(size / MiB);
  const stream = () => new ReadableStream<Uint8Array>({
    pull(c) {
      if (s.pulled >= chunks) { c.close(); return; }
      c.enqueue(doc.slice(s.pulled * MiB, Math.min(size, (s.pulled + 1) * MiB)));
      s.pulled++;
    },
  });
  return { stream, s, chunks };
}

describe('fetchJson refuses an answer past its cap while it streams', () => {
  it('a 20 MiB /status is cut after the default cap, not parsed, and not asked for again', async () => {
    const b = padded(20 * MiB);
    const f = vi.fn(async () => new Response(b.stream(), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const err = await namadaStatus({ provider: 't', url: 'https://rpc.example' }, { retries: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(String(err)).toMatch(/^Error: response too large \(over 2\.1 MB\) for https:\/\/rpc\.example\/status$/);
    // the cap (2 MiB) plus the chunk that passed it, plus at most one read ahead
    expect(b.s.pulled).toBeLessThanOrEqual(FETCH_JSON_MAX_BYTES / MiB + 2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an announced Content-Length past the cap is refused before the body is read', async () => {
    const b = padded(20 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(b.stream(), { status: 200, headers: { 'content-length': String(20 * MiB) } })));
    await expect(fetchJson('https://rpc.example/status')).rejects.toThrow(/response too large \(21\.0 MB announced, 2\.1 MB allowed\)/);
    expect(b.s.pulled).toBeLessThanOrEqual(1);
  });

  it('the key never reaches the message', async () => {
    const b = padded(4 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(b.stream(), { status: 200 })));
    await expect(fetchJson('https://api.keplr.app/rpc/osmosis/keplr_SECRET123/status')).rejects.toThrow(/keplr_\*\*\*\/status$/);
  });

  it('an answer under the cap reads as before, whether streamed in many chunks or one', async () => {
    const b = padded(FETCH_JSON_MAX_BYTES - 1, 7);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(b.stream(), { status: 200 })));
    expect((await namadaStatus({ provider: 't', url: 'https://rpc.example' })).height).toBe(7);
    expect(b.s.pulled).toBe(b.chunks);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('﻿' + JSON.stringify(status(8)), { status: 200 })));
    expect((await namadaStatus({ provider: 't', url: 'https://rpc.example' })).height).toBe(8);
  });

  it('a malformed answer is still retried, as res.json() failures were', async () => {
    const f = vi.fn(async () => new Response('{not json', { status: 200 }));
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('https://rpc.example/status', { retries: 1 })).rejects.toThrow(/JSON/);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a caller may allow more: a 6 MiB block_results is read under the block reads\' cap', async () => {
    const b = padded(6 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(b.stream(), { status: 200 })));
    const blk = await blockResults(5, 0, { rpcs: [NAMADA.rpcs[0]], retries: 0 });
    expect(blk.height).toBe(5);
    expect(b.s.pulled).toBe(6);
    const big = padded(FETCH_TEXT_MAX_BYTES + MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big.stream(), { status: 200 })));
    await expect(blockResults(5, 0, { rpcs: [NAMADA.rpcs[0]], retries: 0 })).rejects.toThrow(/response too large/);
    expect(big.s.pulled).toBeLessThanOrEqual(FETCH_TEXT_MAX_BYTES / MiB + 2);
  });
});

describe('the next node is asked when one answers too large', () => {
  it('the live scan\'s head comes from the second node; the first is put last for the rest of the alarm', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(String(u));
      return String(u).startsWith(NAMADA.rpcs[0].url)
        ? new Response(padded(20 * MiB, 999_999_999).stream(), { status: 200 })
        : new Response(JSON.stringify(status(42)), { status: 200 });
    }));
    const breaker = new RpcBreaker();
    const st = await namadaStatusAny({ ...LIVE_READ, breaker });
    expect(st).toMatchObject({ provider: NAMADA.rpcs[1].provider, height: 42 });
    expect(urls).toEqual([`${NAMADA.rpcs[0].url}/status`, `${NAMADA.rpcs[1].url}/status`]);
    expect(breaker.failures(NAMADA.rpcs[0].provider)).toBe(1);
  });
});

describe('an error answer is read only for what HttpError keeps', () => {
  it('fetchJson: a 20 MiB 500 is read for its first chunk on each attempt, and still retried', async () => {
    const seen: { pulled: number }[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { const b = padded(20 * MiB); seen.push(b.s); return new Response(b.stream(), { status: 500 }); }));
    const err = await fetchJson('https://rpc.example/status', { retries: 1 }).catch((e) => e);
    expect(err.message).toMatch(/^HTTP 500 for https:\/\/rpc\.example\/status: \{"result"/);
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s.pulled).toBeLessThanOrEqual(2);
  });

  it('fetchJson: a 4xx is still not retried, with its body\'s start in the message', async () => {
    const f = vi.fn(async () => new Response('not found here', { status: 404 }));
    vi.stubGlobal('fetch', f);
    const err = await fetchJson('https://rpc.example/x').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('HTTP 404 for https://rpc.example/x: not found here');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('fetchText: a 20 MiB 500 is an HttpError after at most two chunks, holding 200 characters of the body', async () => {
    const b = padded(20 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(b.stream(), { status: 500 })));
    const err = await fetchText('https://rpc.example/abci_query').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message.length).toBe('HTTP 500 for https://rpc.example/abci_query: '.length + 200);
    expect(b.s.pulled).toBeLessThanOrEqual(2);
  });
});

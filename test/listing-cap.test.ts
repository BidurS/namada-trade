// Security review (2026-10-22), the chain listings' read cap: the balance listing is one ABCI answer read whole
// under util.ts FETCH_TEXT_MAX_BYTES (16 MiB of JSON, about 127,100 keys; 90,802 on 2026-10-22), and chain users add
// keys for a few base units of gas each. Past the cap every node failed alike, each was blamed for it, and the row
// said only that the listing "could not be read", as for a slow node. Now an answer past the cap is not counted
// against its node, every node past it is a ListingTooLargeError, the row, the record and the overdue row say the
// listing has outgrown the reader, and from 80% of the cap on the row of an applied listing says how close it is.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { bech32m } from '@scure/base';
import { allNamBalances, parseBalanceListing, RpcBreaker, ListingTooLargeError, LISTING_MAX_VALUE_BYTES } from '../worker/src/sources/namada';
import { runBalanceListing, runBondListing, listingOverdue, listingHeadroomNote, BALANCE_LISTING_MS, LISTING_HEADROOM_WARN } from '../worker/src/cron';
import { FETCH_TEXT_MAX_BYTES } from '../worker/src/util';
import { kvSet } from '../worker/src/db';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import { NAM } from '../worker/src/config';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import type { SourceHealth } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());

const BAL = JSON.parse(readFileSync(new URL('./fixtures/balance_listing.json', import.meta.url), 'utf8'));
const MiB = 1024 * 1024;
const H = 3600000, M = 60000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const A = { provider: 'A', url: 'https://a.invalid' }, B = { provider: 'B', url: 'https://b.invalid' };
const env = (db: TestD1) => ({ DB: db } as any);
const enc = new TextEncoder();
const kv = (db: TestD1, key: string) => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
const answer = (value: string | null, height = 8343304) =>
  JSON.stringify({ jsonrpc: '2.0', id: -1, result: { response: { code: 0, log: '', info: '', index: '0', key: null, value, proofOps: null, height: String(height), codespace: '' } } });

/** An answer whose value goes on past the cap: base64 'A's served 1 MiB a pull, up to `limit` bytes, the bytes pulled counted. */
function endless(limit: number) {
  const head = enc.encode('{"jsonrpc":"2.0","id":-1,"result":{"response":{"code":0,"log":"","info":"","index":"0","key":null,"value":"');
  const s = { pulled: 0 };
  const stream = () => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= limit) { c.close(); return; }
        const part = sent === 0 ? head : new Uint8Array(MiB).fill(0x41);
        sent += part.length; s.pulled += part.length;
        c.enqueue(part);
      },
    });
  };
  return { stream, s };
}

/** A balance listing answer of `n` user keys, 99 bytes each (the parser's layout). */
function listingAnswer(n: number): string {
  const raw = (a: string) => bech32m.fromWords(bech32m.decode(a as `${string}1${string}`, 100).words);
  const nam = raw(NAM.namadaToken);
  const b = new Uint8Array(4 + n * 99);
  const v = new DataView(b.buffer);
  v.setUint32(0, n, true);
  let o = 4;
  for (let i = 0; i < n; i++) {
    v.setUint32(o, 4, true); o += 4;
    b[o++] = 0; b[o++] = 2; b[o++] = 10; // the multitoken account (internal, variant 10)
    b[o++] = 0; b[o++] = 0; b.set(nam.subarray(1), o); o += 20; // the NAM token (established)
    b[o++] = 1; v.setUint32(o, 7, true); o += 4; b.set(enc.encode('balance'), o); o += 7;
    b[o++] = 0; b[o++] = 1; v.setUint32(o, i + 1, false); o += 20; // an implicit owner
    v.setUint32(o, 32, true); o += 4; b[o] = 1; o += 32;
  }
  return answer(Buffer.from(b.buffer).toString('base64'));
}

describe('a listing past the read cap', () => {
  it('the cap holds about 127,100 balance keys: 127,000 fit and parse, 127,200 do not', () => {
    expect(LISTING_MAX_VALUE_BYTES).toBe(12 * MiB);
    const small = listingAnswer(127_000), big = listingAnswer(127_200);
    expect(small.length).toBeLessThan(FETCH_TEXT_MAX_BYTES);
    expect(big.length).toBeGreaterThan(FETCH_TEXT_MAX_BYTES);
    expect(parseBalanceListing(JSON.parse(small).result.response.value).entries.size).toBe(127_000);
  });

  it('every node past the cap: a ListingTooLargeError, no node blamed, each read ended at the cap', async () => {
    const nets = [endless(40 * MiB), endless(40 * MiB)];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(nets[call++].stream())));
    const breaker = new RpcBreaker();
    const e = await allNamBalances({ rpcs: [A, B], timeoutMs: 20000, breaker }).catch((x) => x);
    expect(e).toBeInstanceOf(ListingTooLargeError);
    expect(String(e)).toMatch(/^Error: A: response too large \(.*; B: response too large \(/);
    expect([breaker.failures('A'), breaker.failures('B')]).toEqual([0, 0]);
    // the cap, the chunk that passed it and one read ahead: never the 40 MiB served
    for (const n of nets) expect(n.s.pulled).toBeLessThanOrEqual(FETCH_TEXT_MAX_BYTES + 3 * MiB);
  });

  it('an answer announced past the cap counts the same, and is not read', async () => {
    const net = endless(40 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(net.stream(), { headers: { 'content-length': String(17 * MiB) } })));
    const breaker = new RpcBreaker();
    const e = await allNamBalances({ rpcs: [A], timeoutMs: 20000, breaker }).catch((x) => x);
    expect(e).toBeInstanceOf(ListingTooLargeError);
    expect(String(e)).toMatch(/^Error: A: response too large \(17\.8 MB announced, 16\.8 MB allowed\)/);
    expect(breaker.failures('A')).toBe(0);
    expect(net.s.pulled).toBeLessThanOrEqual(MiB);
  });

  it('one node past the cap and one failing is an ordinary failure: only the failing node is blamed', async () => {
    const net = endless(40 * MiB);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => String(u).startsWith(A.url) ? new Response(net.stream()) : new Response('down', { status: 502 })));
    const breaker = new RpcBreaker();
    const e = await allNamBalances({ rpcs: [A, B], timeoutMs: 20000, breaker }).catch((x) => x);
    expect(e).not.toBeInstanceOf(ListingTooLargeError);
    expect(String(e)).toMatch(/^Error: A: response too large \(.*; B: HTTP 502/);
    expect([breaker.failures('A'), breaker.failures('B')]).toEqual([0, 1]);
  });

  it('an answer under the cap reads as before, and its node is not blamed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answer(BAL.value))));
    const breaker = new RpcBreaker();
    const got = await allNamBalances({ rpcs: [A], timeoutMs: 5000, breaker });
    expect(got).toMatchObject({ provider: 'A', height: 8343304, keys: BAL.expected.keys });
    expect(breaker.failures('A')).toBe(0);
  });

  it('the run keeps the last complete pass and its rows, and the row, the record and the overdue row say why', async () => {
    const db = testD1();
    await kvSet(db as any, 'balance.listing', { at: NOW - 2 * H, completeAt: NOW - 2 * H, height: 8343304, provider: 'A', keys: 90802, holders: 64372, totalNam: 0, bytes: 8989296, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, spansAt: null, extendedAt: null, failures: 0 });
    const X = 'tnam1qx' + 'q'.repeat(38);
    insert(db, 'holders', [{ chain: 'namada', address: X, balance: '5000000', balance_num: 5, updated_height: 8343304, updated_at: NOW - 2 * H, verified_at: NOW - 2 * H, verified_src: BALANCE_LISTING_SRC }]);
    const before = db.raw.prepare("SELECT * FROM holders WHERE chain='namada'").all();
    const nets = [endless(40 * MiB), endless(40 * MiB)];
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(nets[call++].stream())));
    const health: SourceHealth[] = [];
    const rec = (await runBalanceListing(env(db), health, NOW, { rpcs: [A, B] }))!;
    expect(rec).toMatchObject({ completeAt: NOW - 2 * H, failedAt: NOW, failures: 1, keys: 90802, error: 'Too large: past the 16.8 MB one read may hold, from every node' });
    expect(kv(db, 'balance.listing')).toMatchObject({ completeAt: NOW - 2 * H, failures: 1 });
    expect(health[0]).toEqual({ name: 'Namada RPC (balance listing)', ok: false, at: NOW, note: "The balance listing is too large to read: every node's answer is past the 16.8 MB one read may hold, so balances stay as of the last complete listing." });
    expect(db.raw.prepare("SELECT * FROM holders WHERE chain='namada'").all()).toEqual(before);
    // the row of the ticks that do not read it keeps the reason whole
    const overdue: SourceHealth[] = [];
    listingOverdue(overdue, 'Namada RPC (balance listing)', 'balance', rec, BALANCE_LISTING_MS, NOW + M);
    expect(overdue[0].note).toBe('No complete balance listing for 2 h (balances as of the last one). Last read 12:00 UTC: Too large: past the 16.8 MB one read may hold, from every node');
    // the bond listing shares the reader and says the same
    const bnet = endless(40 * MiB);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bnet.stream())));
    const bh: SourceHealth[] = [];
    const brec = (await runBondListing(env(db), bh, NOW, 2690, { rpcs: [A] }))!;
    expect(brec).toMatchObject({ failures: 1, error: 'Too large: past the 16.8 MB one read may hold, from every node' });
    expect(bh[0].note).toBe("The bond listing is too large to read: every node's answer is past the 16.8 MB one read may hold, so stakes stay as of the last complete listing.");
  });

  it('from 80% of the cap on, the row of an applied listing says how close it is', async () => {
    expect(LISTING_HEADROOM_WARN).toBe(0.8);
    expect(listingHeadroomNote(8_989_296)).toBe('');
    expect(listingHeadroomNote(Math.ceil(0.8 * LISTING_MAX_VALUE_BYTES) - 1)).toBe('');
    expect(listingHeadroomNote(Math.ceil(0.8 * LISTING_MAX_VALUE_BYTES))).toBe('; the answer is 80% of the 16.8 MB one read may hold');
    const db = testD1();
    const health: SourceHealth[] = [];
    const lister = async () => ({ ...parseBalanceListing(BAL.value), bytes: 11_000_000, height: 8343304, provider: 'TestNode' });
    await runBalanceListing(env(db), health, NOW, {}, lister);
    expect(health[0]).toMatchObject({ ok: true });
    expect(health[0].note).toMatch(/^28 balance keys at height 8,343,304 \(11\.0 MB from TestNode\): 18 addresses hold 324,665 NAM; 18 rows written; the answer is 87% of the 16\.8 MB one read may hold$/);
  });
});

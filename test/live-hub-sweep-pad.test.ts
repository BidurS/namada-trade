// Security review (2026-10-22), the catch-up search's byte budget and node failover: one Osmosis node answering valid
// pages padded to just under the cap spent the search's budget on the first query's page, and every later page was
// refused as past the budget without asking the other node, so the search never finished and a NAM transfer the
// stream missed was never written. Now a page past what is left of the budget asks the next node, and a page is
// charged only for the transactions the search keeps.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const MiB = 1024 * 1024;
const CURSOR = 1_000_000;
const HEAD = 1_000_500;
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;
/** A 50 NAM bank transfer (one flow). */
const transferTx = (hash: string, height: number) => ({
  hash, height: String(height), tx: '',
  tx_result: { code: 0, events: [{ type: 'transfer', attributes: [{ key: 'recipient', value: 'osmo1recvmissed' }, { key: 'sender', value: 'osmo1send' }, { key: 'amount', value: `${50 * 1e6}${NAM.osmoDenom}` }] }] },
});
/** A swap-query transaction the parser makes nothing of (no flow, no move): never stored, so kept by every search. */
const junkTx = (hash: string, height: number) => ({ hash, height: String(height), tx: '', tx_result: { code: 0, events: [] } });

function osmosis(padOn: string, padBytes: number) {
  const asked: string[] = [];
  const PAD = 'P'.repeat(padBytes);
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('publicnode') ? 'publicnode' : 'keplr';
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
    if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const q = url.searchParams.get('query') ?? '';
    const kind = q.includes('token_swapped') ? 'swap' : q.includes('transfer.amount') ? 'transfer' : 'other';
    asked.push(`${who} ${kind}`);
    const txs = kind === 'swap' ? [junkTx(hashOf('AA', 0), HEAD - 2)] : kind === 'transfer' ? [transferTx(hashOf('BB', 0), HEAD - 10)] : [];
    // valid JSON: the padding is a field the search never reads; under the 16 MiB cap
    const body = JSON.stringify({ result: { txs, total_count: String(txs.length) }, ...(who === padOn ? { pad: PAD } : {}) });
    const bytes = new TextEncoder().encode(body);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
  }));
  return asked;
}
function hubOn(db: TestD1) {
  return Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db, KEPLR_KEY: 'dummy' },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
}

describe('one node padding its pages under the cap', () => {
  it('the healthy node is still asked for a page the budget cannot take, the search finishes and the missed transfer is written', async () => {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
    const hub = hubOn(db);
    const asked = osmosis('publicnode', 15 * MiB);
    for (let n = 0; n < 3; n++) await hub.sweepOsmosis();
    const cur = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
    const stored = (db.raw.prepare('SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?').get(hashOf('BB', 0)) as any).n;
    console.log('asked', JSON.stringify(asked), 'cursor', JSON.stringify(cur), 'stored', stored);
    // the healthy node was never asked for the transfer query
    expect(asked.filter((a) => a === 'keplr transfer')).toEqual([]);
    // the defect: three searches, none finished, and the missed transfer is never written
    expect(cur.height).toBe(HEAD);
    expect(stored).toBe(1);
  }, 120_000);
});

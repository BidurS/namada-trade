// Security review (2026-10-22), the listings' health rows: a listing not read for want of an agreed head while it is
// overdue says both why it was not read and how long it has been overdue. The reason was long enough that the row's
// 160 characters cut the overdue sentence off; the sentence is now kept whole and the reason cut to fit.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBalanceListing, listingHeads, chainHead } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { runCron, runBalanceListing, floorCeiling, heightCeiling, LISTING_WRITE_CAP, BALANCE_LISTING_MS, type BalanceListingRecord } from '../worker/src/cron';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const H = 3600000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const R = 8_343_400;
const env = (db: TestD1) => ({ DB: db } as any);
const balLister = (height: number, provider: string) => async () => ({ ...parseBalanceListing(BAL.value), height, provider });
const users = BAL.expected.users_ as Record<string, string>;
const [A] = Object.entries(users).filter(([, v]) => v !== '0').map(([a]) => a).sort();
const row = (db: TestD1, a: string) => db.raw.prepare("SELECT balance, updated_height FROM holders WHERE chain='namada' AND address=?").get(a);
const st = (height: number) => ({ height, catchingUp: false });
const ctxOf = (statuses: { height?: number; catchingUp?: boolean; error?: string }[], indexer?: number) => ({ headHeight: listingHeads(statuses, indexer).head });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
function network(nodes: { five: number | null; papa: number | null; indexer: number | null }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('indexer.namada.net') && url.includes('/chain/block/latest')) return nodes.indexer ? json({ block: String(nodes.indexer) }) : new Response('down', { status: 503 });
    const h = url.includes('5elementsnodes') ? nodes.five : url.includes('papadritta') ? nodes.papa : undefined;
    if (h === undefined) return new Response('not here', { status: 404 });
    if (h === null) throw new TypeError('fetch failed: connection refused');
    if (url.includes('/status')) return json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(h), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(1000000n);
      return json({ result: { response: { code: 0, value, height: String(h) } } });
    }
    return new Response('not here', { status: 404 });
  }));
}
async function tick(db: TestD1, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch(() => {}).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  expect(done).toBe(true);
}
const PLAIN = Date.parse('2026-10-17T22:41:05Z');

describe('a listing not read for want of an agreed head while it is overdue', () => {
  it('says in its row both why it was not read and how long it has been overdue (listingSkipped: "neither replaces the other")', async () => {
    const db = testD1();
    insert(db, 'holders', Object.entries(users).filter(([, v]) => v !== '0').map(([address, balance]) => ({ chain: 'namada', address, balance, balance_num: Number(BigInt(balance)) / 1e6, updated_height: 8382796, updated_at: PLAIN - 3 * H, verified_at: PLAIN - 3 * H, verified_src: BALANCE_LISTING_SRC })));
    const at = PLAIN - 3 * H;
    const bal: BalanceListingRecord = { at, completeAt: at, height: 8382796, provider: '5ElementsNodes', keys: 28, holders: 18, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, spansAt: at, extendedAt: at };
    insert(db, 'kv', [
      { key: 'balance.listing', value: JSON.stringify(bal), updated_at: at },
      { key: 'bond.listing', value: JSON.stringify({ at: PLAIN - 60000, completeAt: PLAIN - 60000, height: 8382840, epoch: 2696, provider: 'Papadritta', sources: 48, stakers: 12, totalNam: 75, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0 }), updated_at: PLAIN - 60000 },
    ]);
    // 5ElementsNodes down, the indexer down: Papadritta alone, as in the fixer's accepted residual
    network({ five: null, papa: 8382950, indexer: null });
    await tick(db, PLAIN);
    const row = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Namada RPC (balance listing)'];
    console.log('row', JSON.stringify(row.note), row.note.length);
    expect(row.note).toMatch(/^Not read this tick: no two of this tick's answers agree on the chain's head/);
    expect(row.note).toMatch(/No complete balance listing for 3 h \(balances as of the last one\)\./);
  });
});

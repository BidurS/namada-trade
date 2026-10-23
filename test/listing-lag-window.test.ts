// Security review (2026-10-22), listing heads: with an honest node lagging 94 to 100 blocks (behind without saying it
// is catching up), the listing head counted it and its height set the bound above which stored rows are set aside, so
// rows the live scan wrote from the up-to-date node's real blocks while the listing streamed were re-stamped and
// rolled back. A node whose newest block is over five minutes old is no answer now, and rows are set aside only above
// the highest node two answers agree on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBalanceListing, listingHeads, chainHead } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { runCron, balanceGate, floorCeiling, type BalanceListingRecord } from '../worker/src/cron';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const H = 3600000;
const R = 8_383_200;
const users = BAL.expected.users_ as Record<string, string>;
const [A] = Object.entries(users).filter(([, v]) => v !== '0').map(([a]) => a).sort();
const rowOf = (db: TestD1, a: string) => db.raw.prepare("SELECT balance, updated_height FROM holders WHERE chain='namada' AND address=?").get(a);
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const BLOCK_MS = 6800;
const NEW = 'tnam1qqzz9review3newholderinablockabovethelistingxx';

/**
 * five: lagging `gap` blocks behind papa (its newest block gap × 6.8 s old), papa and the indexer at the head.
 * While the balance listing is being served, the live scan (following papa) writes A's post-balance from a real block
 * `ahead` blocks above papa's status height.
 */
function network(db: TestD1, o: { five: number; papa: number; indexer: number; liveRow: { height: number; balance: string } | null; asked: string[] }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('indexer.namada.net') && url.includes('/chain/block/latest')) return json({ block: String(o.indexer) });
    const who = url.includes('5elementsnodes') ? 'five' : url.includes('papadritta') ? 'papa' : null;
    if (!who) return new Response('not here', { status: 404 });
    const h = who === 'five' ? o.five : o.papa;
    if (url.includes('/status')) {
      const time = new Date(Date.now() - (o.papa - h) * BLOCK_MS).toISOString();
      return json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(h), latest_block_time: time, catching_up: false, earliest_block_height: '1' } } });
    }
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/shell/prefix/')) {
        o.asked.push(who);
        // the live scan writes a block's post-balance while the 12 MB answer streams
        if (o.liveRow) await runStmts(db, [
          stmt.namadaBalance({ address: A, balance: o.liveRow.balance, height: o.liveRow.height } as any, Date.now()),
          // a first receipt in the same block: an address the listing (from an older height) does not have yet
          stmt.namadaBalance({ address: NEW, balance: '7000000', height: o.liveRow.height } as any, Date.now()),
        ]);
      }
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
const PLAIN = Date.parse('2026-10-23T05:41:05Z');

function seed(db: TestD1) {
  const at = PLAIN - H - 60000;
  insert(db, 'holders', Object.entries(users).filter(([, v]) => v !== '0').map(([address, balance]) => ({ chain: 'namada', address, balance, balance_num: Number(BigInt(balance)) / 1e6, updated_height: R - 530, updated_at: at, verified_at: at, verified_src: BALANCE_LISTING_SRC })));
  // as in production: the balance listing last served by 5ElementsNodes, complete, an hour old (due); the bond listing fresh
  const bal: BalanceListingRecord = { at, completeAt: at, height: R - 530, provider: '5ElementsNodes', keys: 28, holders: 18, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, spansAt: at, extendedAt: at, failedAt: null, failures: 0, refusedProvider: null };
  insert(db, 'kv', [
    { key: 'balance.listing', value: JSON.stringify(bal), updated_at: at },
    { key: 'bond.listing', value: JSON.stringify({ at: PLAIN - 60000, completeAt: PLAIN - 60000, height: R - 9, epoch: 2696, provider: 'Papadritta', sources: 48, stakers: 12, totalNam: 75, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0 }), updated_at: PLAIN - 60000 },
  ]);
}

describe('an honest node lagging 97 blocks', () => {
  const papa = R + 97;
  it('a real block\'s post-balances the live scan wrote during the tick (4 blocks, about 27 s, after the status read) are kept, not rolled back to the listing\'s older state', async () => {
    const db = testD1();
    seed(db);
    const asked: string[] = [];
    const live = { height: papa + 4, balance: '5' };
    network(db, { five: R, papa, indexer: papa, liveRow: live, asked });
    await tick(db, PLAIN);
    const rec = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='balance.listing'").get().value);
    const health = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value)['Namada RPC (balance listing)'];
    console.log('asked', asked, 'record', JSON.stringify({ height: rec.height, provider: rec.provider, unpinned: rec.unpinned, error: rec.error }), '| note', health?.note);
    console.log('row A after the tick', JSON.stringify(rowOf(db, A)), '| listing balance', users[A], '| new holder', JSON.stringify(rowOf(db, NEW)));
    expect(rec.height).toBe(R);
    // The rows came from block R+101, newer than the listing (R): they should stay as the live scan wrote them.
    expect({ A: rowOf(db, A), NEW: rowOf(db, NEW) }).toEqual({ A: { balance: '5', updated_height: papa + 4 }, NEW: { balance: '7000000', updated_height: papa + 4 } });
  });

  it('contrast: the same tick with the node 90 behind leaves the newer row alone', async () => {
    const db = testD1();
    seed(db);
    const asked: string[] = [];
    const p90 = R + 90;
    network(db, { five: R, papa: p90, indexer: p90, liveRow: { height: p90 + 6, balance: '5' }, asked });
    await tick(db, PLAIN);
    expect(rowOf(db, A)).toEqual({ balance: '5', updated_height: p90 + 6 });
  });
});

// Security review (2026-10-22), whose withdraw times the unlock list's "End of each wait" stamp names: while no bond
// listing completes (nodes down, a listing too large) or its write of the map fails, the cron's indexer fallback
// writes kv unbond.withdraw, and every unbond row says its end of the wait is the indexer's; but the stamp beside
// them always named the chain's bond listing (pressure()'s fixed source, and Unlocks.tsx's fixed plain "Namada
// node"). The map now records who wrote it (`source`: 'consensus' from runBondListing, 'indexer' from the fallback;
// a map written before says it by its entries), pressure() names the stamp's source from it, and the Unlocks scope
// row takes its plain source and its label from the server's stamp.
import { describe, it, expect, vi, afterEach } from 'vitest';
// The Unlocks screen's module reads the address bar when it loads (web/src/app/router.ts): a page's, here.
vi.hoisted(() => { (globalThis as any).location ??= { pathname: '/supply', search: '', hash: '' }; });
import { readFileSync } from 'node:fs';
import { runCron, runBondListing } from '../worker/src/cron';
import { pressure, unbondWithdrawWriter, UNBOND_WITHDRAW_SOURCE } from '../worker/src/analytics';
import { NAMADA } from '../worker/src/config';
import { plainSource } from '../web/src/lib/prov';
import { withdrawEndScope } from '../web/src/screens/supply/Unlocks';
import type { BondListing } from '../worker/src/sources/namada';
import type { SourceHealth } from '../shared/types';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const D = 86_400_000, M = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0);
const V = 'tnam1' + 'v'.repeat(40), U = 'tnam1' + 'b'.repeat(40), POS = NAMADA.internal.pos;
const PARAMS = { unbondingLength: 2, pipelineLength: 2, minEpochSec: 21600, epochSec: 21600, apr: null, fetchedAt: NOW };

/** testD1 with the chain parameters, `map` as kv unbond.withdraw, and U's 150,000 NAM unbond a day ago. */
function seeded(map: unknown) {
  const db = testD1();
  insert(db, 'kv', [
    { key: 'chain.params', value: JSON.stringify(PARAMS), updated_at: 1 },
    ...(map ? [{ key: 'unbond.withdraw', value: JSON.stringify(map), updated_at: 1 }] : []),
  ]);
  insert(db, 'flows', [
    { id: 'namada:UBIG:pos', chain: 'namada', height: 2, ts: NOW - D, tx_hash: 'UBIG', kind: 'unbond', from_addr: POS, to_addr: U, amount_num: 150000, meta: JSON.stringify({ validator: V }) },
  ]);
  return db;
}
const indexerEntry = { validator: V, amountNam: 150000, withdrawEpoch: 2700, withdrawTime: NOW + 5 * D };

describe('the stamp on the ends of the wait names who wrote them', () => {
  it('a map the indexer fallback wrote: the stamp says the Namada indexer, as each row does', async () => {
    const db = seeded({ at: NOW - 5 * M, source: 'indexer', byAddress: { [U]: [indexerEntry] } });
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.unlocks.find((u) => u.txHash === 'UBIG')!.liquidAtSource).toBe('indexer');
    expect(p.unbondWithdrawProv).toMatchObject({ source: UNBOND_WITHDRAW_SOURCE.indexer, status: 'live', at: NOW - 5 * M });
    expect(plainSource(p.unbondWithdrawProv)).toBe('Namada indexer');
    const row = withdrawEndScope(p.unbondWithdrawProv)!;
    expect(plainSource(row.p)).toBe('Namada indexer');
    expect(row.label).toBe('End of each wait: the Namada indexer’s list of unstaking requests');
  });

  it('a map written before the field (its entries carry no source, as the fallback\'s always did): the indexer too', async () => {
    const db = seeded({ at: NOW - 5 * M, byAddress: { [U]: [indexerEntry] } });
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.unlocks.find((u) => u.txHash === 'UBIG')!.liquidAtSource).toBe('indexer');
    expect(plainSource(withdrawEndScope(p.unbondWithdrawProv)!.p)).toBe('Namada indexer');
  });

  it('a map the bond listing wrote says so, and the stamp names a Namada node, as before', async () => {
    const db = seeded(null);
    const sources = new Map<string, any>();
    sources.set('tnam1' + 'a'.repeat(40), { bondedBase: 1_000_000_000n, grossBase: 1_000_000_000n, slashedBase: 0n, unbondingBase: 0n, unbondGrossBase: 0n, unbondSlashedBase: 0n, delegations: [{ validator: V, amountNam: 1000 }], unbonds: [] });
    sources.set(U, { bondedBase: 0n, grossBase: 0n, slashedBase: 0n, unbondingBase: 150_000_000_000n, unbondGrossBase: 150_000_000_000n, unbondSlashedBase: 0n, delegations: [],
      unbonds: [{ validator: V, startEpoch: 2680, withdrawEpoch: 2700, amountBase: 150_000_000_000n, grossBase: 150_000_000_000n, slashedBase: 0n, amountNam: 150000 }] });
    const listing: BondListing & { height: number; provider: string } = {
      sources, entries: 2, totalBase: 1_000_000_000n, grossBase: 1_000_000_000n, slashedBase: 0n, unbondingBase: 150_000_000_000n, unbondGrossBase: 150_000_000_000n,
      unbondSlashedBase: 0n, entriesWithUnbonds: 1, entriesWithSlashes: 0, slashes: [], bytes: 0, height: 8343327, provider: 'fixture',
    };
    const health: SourceHealth[] = [];
    await runBondListing({ DB: db } as any, health, NOW, 2690, {}, async () => listing);
    const map = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='unbond.withdraw'").get().value);
    expect(map).toMatchObject({ at: NOW, source: 'consensus' });
    const p = await pressure(db as any, NOW + M, false, 7);
    expect(p.unlocks.find((u) => u.txHash === 'UBIG')!.liquidAtSource).toBe('consensus');
    expect(p.unbondWithdrawProv).toMatchObject({ source: UNBOND_WITHDRAW_SOURCE.consensus, status: 'live', at: NOW });
    const row = withdrawEndScope(p.unbondWithdrawProv)!;
    expect(plainSource(row.p)).toBe('Namada node');
    expect(row.label).toBe('End of each wait: the chain’s own list of unstaking requests');
  });

  it('who wrote a map: its field, else its entries; not told for an empty map or a mix', () => {
    expect(unbondWithdrawWriter({ at: 1, source: 'indexer', byAddress: {} })).toBe('indexer');
    expect(unbondWithdrawWriter({ at: 1, byAddress: { [U]: [{ ...indexerEntry, source: 'consensus' }] } })).toBe('consensus');
    expect(unbondWithdrawWriter({ at: 1, byAddress: { [U]: [indexerEntry] } })).toBe('indexer');
    expect(unbondWithdrawWriter({ at: 1, byAddress: {} })).toBeNull();
    expect(unbondWithdrawWriter({ at: 1, byAddress: { [U]: [indexerEntry, { ...indexerEntry, source: 'consensus' }] } })).toBeNull();
    expect(unbondWithdrawWriter(null)).toBeNull();
  });

  it('no map: the stamp is missing and names both, as before', async () => {
    const p = await pressure(seeded(null) as any, NOW, false, 7);
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'missing', source: UNBOND_WITHDRAW_SOURCE.unknown });
    expect(withdrawEndScope(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- the tick's indexer fallback
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the tick that asks the indexer', () => {
  it('writes the map with source indexer, and the stamp says so', async () => {
    // 12:00:05 UTC, a 10-minute mark; no bond listing has ever completed (the epoch cannot be read, so none starts)
    const T = NOW + 5000;
    const db = testD1();
    insert(db, 'kv', [{ key: 'chain.params', value: JSON.stringify({ ...PARAMS, fetchedAt: T }), updated_at: 1 }]);
    insert(db, 'flows', [
      { id: 'namada:UBIG:pos', chain: 'namada', height: 2, ts: T - D, tx_hash: 'UBIG', kind: 'unbond', from_addr: POS, to_addr: U, amount_num: 150000, meta: JSON.stringify({ validator: V }) },
    ]);
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/pos/unbond/')) {
        asked.push(url);
        return json({ results: [{ validator: { address: V }, minDenomAmount: '150000000000', withdrawEpoch: 2700, withdrawTime: Math.floor((T + 5 * D) / 1000) }] });
      }
      if (url.includes('/status')) return json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.includes('abci_query')) {
        const path = decodeURIComponent(url.split('path=')[1] ?? '');
        if (path.includes('/shell/epoch') || path.includes('/vp/pos/')) return json({ result: { response: { code: 1, info: 'not here', value: null, height: '1' } } });
        const value = path.includes('/shell/prefix/') ? BAL.value : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted)) : u256(1000000n);
        return json({ result: { response: { code: 0, value, height: '8343400' } } });
      }
      return new Response('not here', { status: 404 });
    }));
    vi.useFakeTimers({ now: T, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let done = false, err: unknown = null;
    runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
    for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
    vi.useRealTimers();
    if (err) throw err;
    expect(asked.some((u) => u.endsWith(`/pos/unbond/${U}`))).toBe(true);
    const map = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='unbond.withdraw'").get().value);
    expect(map).toMatchObject({ at: T, source: 'indexer', byAddress: { [U]: [{ validator: V, amountNam: 150000 }] } });
    const p = await pressure(db as any, T + M, false, 7);
    expect(p.unlocks.find((u) => u.txHash === 'UBIG')!.liquidAtSource).toBe('indexer');
    expect(plainSource(withdrawEndScope(p.unbondWithdrawProv)!.p)).toBe('Namada indexer');
  });
});

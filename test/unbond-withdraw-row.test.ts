// Security review (2026-10-22), the unlock list's withdraw times: each complete bond listing wrote every unbond on
// the chain into one kv row (unbond.withdraw: 6,043 entries in 1,036,948 bytes on 2026-10-22, against D1's
// 2,000,000-byte row limit), and unbonds of a base unit cost only their fees. Past the limit the write was dropped
// with no word, the pass still reported ok and switched off the indexer fallback, and pressure() went on serving the
// frozen map with no age check: an unbond withdrawn since kept its old end of the wait, shown as the chain's own for
// a later request of the same address, validator and amount. Now the map keeps only the unbonds the unlock list can
// look up (UNLOCKS_MIN_NAM and up, the size of its rows), a write that fails is on the Sources sheet and brings the
// indexer back at the next 10-minute mark, and pressure() uses the map only while it is current, with its age in
// unbondWithdrawProv. The 2,000,000-byte limit is put on the sqlite D1 stand-in's run() here.
import { describe, it, expect } from 'vitest';
import { runBondListing, withdrawFallbackDue, BOND_LISTING_MS } from '../worker/src/cron';
import { buildUnbondTermStructure, pressure, UNBOND_WITHDRAW_STALE_MS } from '../worker/src/analytics';
import type { BondListing } from '../worker/src/sources/namada';
import { testD1, insert } from './d1-sqlite';
import type { SourceHealth } from '../shared/types';

const D = 86400_000, H = 3600_000, M = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0);
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const V = 'tnam1' + 'v'.repeat(40);
const OLD = 'tnam1' + 'o'.repeat(40);
const BIG = 'tnam1' + 'b'.repeat(40);
const EDGE = 'tnam1' + 'e'.repeat(40);
const UNDER = 'tnam1' + 'u'.repeat(40);
const addr = (i: number) => 'tnam1' + String(i).padStart(40, 'q');
const D1_ROW_MAX = 2_000_000;
const WITHDRAW = 'Namada RPC (unbond withdraw times)';

type Src = BondListing['sources'] extends Map<string, infer S> ? S : never;
const unbondOnly = (base: bigint, withdrawEpoch = 2700): Src => ({
  bondedBase: 0n, grossBase: 0n, slashedBase: 0n, unbondingBase: base, unbondGrossBase: base, unbondSlashedBase: 0n, delegations: [],
  unbonds: [{ validator: V, startEpoch: withdrawEpoch - 20, withdrawEpoch, amountBase: base, grossBase: base, slashedBase: 0n, amountNam: Number(base) / 1e6 }],
});
/**
 * One bonded source (so the gate passes), `dust` sources holding one unbond of a base unit each (what a sender pays
 * only fees for), BIG with a 150,000 NAM unbond, EDGE one base unit under 100,000 NAM (a row of 100,000 matches it
 * within 1e-6) and UNDER at 99,999.99 NAM (no row matches it).
 */
function listing(dust: number): BondListing & { height: number; provider: string } {
  const sources = new Map<string, Src>();
  sources.set('tnam1' + 'a'.repeat(40), { bondedBase: 1_000_000_000n, grossBase: 1_000_000_000n, slashedBase: 0n, unbondingBase: 0n, unbondGrossBase: 0n, unbondSlashedBase: 0n, delegations: [{ validator: V, amountNam: 1000 }], unbonds: [] });
  for (let i = 0; i < dust; i++) sources.set(addr(i), unbondOnly(1n));
  sources.set(BIG, unbondOnly(150_000_000_000n));
  sources.set(EDGE, unbondOnly(99_999_999_999n));
  sources.set(UNDER, unbondOnly(99_999_990_000n));
  const unbonding = BigInt(dust) + 150_000_000_000n + 99_999_999_999n + 99_999_990_000n;
  return {
    sources, entries: dust + 4, totalBase: 1_000_000_000n, grossBase: 1_000_000_000n, slashedBase: 0n, unbondingBase: unbonding, unbondGrossBase: unbonding,
    unbondSlashedBase: 0n, entriesWithUnbonds: dust + 3, entriesWithSlashes: 0, slashes: [], bytes: 0, height: 8343327, provider: 'fixture',
  };
}

/** testD1 whose run() refuses a bound string longer than D1's row limit, or any write to `failKey` (another D1 failure). */
function limitedD1(failKey?: string) {
  const base = testD1();
  const refused: string[] = [];
  const db: any = Object.create(base);
  db.prepare = (sql: string) => {
    const st = base.prepare(sql);
    return Object.assign(Object.create(st), {
      bind: (...p: unknown[]) => {
        const b = st.bind(...p);
        return Object.assign(Object.create(b), {
          run: async () => {
            if (p.some((x) => typeof x === 'string' && x.length > D1_ROW_MAX)) { refused.push('too big'); throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG'); }
            if (failKey && /INSERT OR REPLACE INTO kv/.test(sql) && p[0] === failKey) { refused.push(failKey); throw new Error('D1_ERROR: Network connection lost.'); }
            return b.run();
          },
        });
      },
    });
  };
  db.batch = base.batch.bind(base);
  return { db, base, refused };
}

const PARAMS = { unbondingLength: 2, pipelineLength: 2, minEpochSec: 21600, epochSec: 21600, apr: null, fetchedAt: NOW };
function seed(db: ReturnType<typeof testD1>, mapAt: number) {
  insert(db, 'kv', [
    { key: 'chain.params', value: JSON.stringify(PARAMS), updated_at: 1 },
    // an earlier map: OLD's 100,000 NAM unbond, withdrawable since 20 days ago (withdrawn since: no listing names it)
    { key: 'unbond.withdraw', value: JSON.stringify({ at: mapAt, byAddress: { [OLD]: [{ validator: V, amountNam: 100000, withdrawEpoch: 2600, withdrawTime: NOW - 20 * D, source: 'consensus' }] } }), updated_at: 1 },
  ]);
  insert(db, 'flows', [
    // OLD asks again for 100,000 NAM from V two days ago: still in its wait
    { id: 'namada:UOLD:pos', chain: 'namada', height: 1, ts: NOW - 2 * D, tx_hash: 'UOLD', kind: 'unbond', from_addr: POS, to_addr: OLD, amount_num: 100000, meta: JSON.stringify({ validator: V }) },
    { id: 'namada:UBIG:pos', chain: 'namada', height: 2, ts: NOW - 1 * D, tx_hash: 'UBIG', kind: 'unbond', from_addr: POS, to_addr: BIG, amount_num: 150000, meta: JSON.stringify({ validator: V }) },
    { id: 'namada:UEDGE:pos', chain: 'namada', height: 3, ts: NOW - 1 * D, tx_hash: 'UEDGE', kind: 'unbond', from_addr: POS, to_addr: EDGE, amount_num: 100000, meta: JSON.stringify({ validator: V }) },
  ]);
}
const unlock = (p: Awaited<ReturnType<typeof pressure>>, tx: string) => p.unlocks.find((u) => u.txHash === tx)!;

describe('the withdraw times keep to the unlock list', () => {
  it('keeps only unbonds a row of the list can match, so unbonds of a base unit cannot fill the row; the term structure still counts every unbond', () => {
    const l = listing(12_000);
    const { termStructure, withdrawCache } = buildUnbondTermStructure(l, l.height, 2690, NOW, 21600);
    expect(Object.keys(withdrawCache.byAddress).sort()).toEqual([BIG, EDGE].sort());
    expect(JSON.stringify(withdrawCache).length).toBeLessThan(1_000);
    expect(termStructure.buckets.reduce((a, b) => a + b.count, 0)).toBe(12_003);
    expect(termStructure.totalUnbondingNam).toBeCloseTo(Number(l.unbondingBase) / 1e6, 6);
  });

  it('a listing of 12,000 dust unbonds is stored whole on a D1 that refuses rows over 2,000,000 bytes, and the list shows the chain\'s own end of the wait', async () => {
    const { db, base, refused } = limitedD1();
    seed(base, NOW - 30 * D);
    const health: SourceHealth[] = [];
    const rec = await runBondListing({ DB: db } as any, health, NOW, 2690, {}, async () => listing(12_000));
    expect(refused).toEqual([]);
    expect(rec?.completeAt).toBe(NOW);
    const map = JSON.parse(base.raw.prepare("SELECT value FROM kv WHERE key='unbond.withdraw'").get().value);
    expect(map.at).toBe(NOW);
    expect(Object.keys(map.byAddress).sort()).toEqual([BIG, EDGE].sort());
    expect(health.map((h) => [h.name, h.ok])).toEqual([['Namada RPC (bond listing)', true], [WITHDRAW, true]]);
    expect(health[1].note).toBe('2 unbonds of 100,000 NAM or more (2 addresses) at height 8,343,327');
    const p = await pressure(db, NOW + M, false, 7);
    expect(unlock(p, 'UBIG')).toMatchObject({ liquidAt: NOW + 10 * 21600_000, liquidAtSource: 'consensus' });
    expect(unlock(p, 'UEDGE')).toMatchObject({ liquidAt: NOW + 10 * 21600_000, liquidAtSource: 'consensus' });
    // OLD's withdrawn unbond is gone with the old map: its new request is an estimate, not a wait over 20 days ago
    expect(unlock(p, 'UOLD').liquidAtSource).toBe('estimate');
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'live', at: NOW });
  });

  it('a write D1 refuses is said on the Sources sheet, the stored map keeps its own time, and the indexer is asked at the next 10-minute mark', async () => {
    const { db, base, refused } = limitedD1('unbond.withdraw');
    seed(base, NOW - 30 * D);
    const health: SourceHealth[] = [];
    const rec = await runBondListing({ DB: db } as any, health, NOW, 2690, {}, async () => listing(10));
    expect(refused).toEqual(['unbond.withdraw']);
    expect(rec?.completeAt).toBe(NOW);
    expect(base.raw.prepare("SELECT updated_at FROM kv WHERE key='unbond.withdraw'").get().updated_at).toBe(1);
    // the term structure went in beside it
    expect(base.raw.prepare("SELECT json_extract(value,'$.at') AS at FROM kv WHERE key='unbond.term_structure'").get().at).toBe(NOW);
    const w = health.find((h) => h.name === WITHDRAW)!;
    expect(w).toMatchObject({ ok: false, at: NOW });
    expect(w.note).toMatch(/^Not stored \(Error: D1_ERROR: Network connection lost\.\): the unlock list uses the last ones while under 130 min old, and the indexer is asked meanwhile\.$/);
    expect(w.note!.length).toBeLessThanOrEqual(160);
    // the stored map is older than the listing that completed: the indexer fallback is due
    expect(withdrawFallbackDue(rec!.completeAt, NOW - 30 * D, NOW + 10 * M)).toBe(true);
    // the frozen map is not served: OLD's new request is an estimate, BIG (missing from it) too, and the stamp says why
    const p = await pressure(db, NOW + M, false, 7);
    // the request time + the wait (4 epochs of 6 h here), not the old unbond's end 20 days ago
    expect(unlock(p, 'UOLD')).toMatchObject({ liquidAt: NOW - 2 * D + 4 * 21600_000, liquidAtSource: 'estimate' });
    expect(unlock(p, 'UBIG').liquidAtSource).toBe('estimate');
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'stale', at: NOW - 30 * D });
  });

  it('the fallback runs when no listing completed in three intervals or the map is older than the last one, and not after the indexer stored a newer map', () => {
    expect(withdrawFallbackDue(null, NOW, NOW)).toBe(true);
    expect(withdrawFallbackDue(NOW - 3 * BOND_LISTING_MS, NOW, NOW)).toBe(true);
    expect(withdrawFallbackDue(NOW - H, NOW - H, NOW)).toBe(false);
    expect(withdrawFallbackDue(NOW - H, NOW - H - M, NOW)).toBe(true);
    expect(withdrawFallbackDue(NOW - H, null, NOW)).toBe(true);
    expect(withdrawFallbackDue(NOW - H, NOW - 50 * M, NOW)).toBe(false);
  });

  it('pressure() uses the map while it is current, not past UNBOND_WITHDRAW_STALE_MS, and not in a view rewound to before it was written', async () => {
    const db = testD1();
    seed(db, NOW);
    const set = (at: number) => db.raw.prepare("UPDATE kv SET value = ? WHERE key='unbond.withdraw'")
      .run(JSON.stringify({ at, byAddress: { [BIG]: [{ validator: V, amountNam: 150000, withdrawEpoch: 2700, withdrawTime: NOW + 5 * D, source: 'consensus' }] } }));
    set(NOW - UNBOND_WITHDRAW_STALE_MS);
    let p = await pressure(db as any, NOW, false, 7);
    expect(unlock(p, 'UBIG')).toMatchObject({ liquidAt: NOW + 5 * D, liquidAtSource: 'consensus' });
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'live', at: NOW - UNBOND_WITHDRAW_STALE_MS });
    set(NOW - UNBOND_WITHDRAW_STALE_MS - M);
    p = await pressure(db as any, NOW, false, 7);
    expect(unlock(p, 'UBIG').liquidAtSource).toBe('estimate');
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'stale', note: '131 min old' });
    set(NOW);
    p = await pressure(db as any, NOW - H, true, 7);
    expect(unlock(p, 'UBIG').liquidAtSource).toBe('estimate');
    expect(p.unbondWithdrawProv).toMatchObject({ status: 'missing', at: null, note: 'The withdraw times had not been read at this moment.' });
    db.raw.prepare("DELETE FROM kv WHERE key='unbond.withdraw'").run();
    expect((await pressure(db as any, NOW, false, 7)).unbondWithdrawProv).toMatchObject({ status: 'missing', note: 'The withdraw times have not been read yet.' });
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBondListing } from '../worker/src/sources/namada';
import { runBondListing } from '../worker/src/cron';
import {
  buildUnbondTermStructure,
  matchMaspPassthroughs,
  blindSpot,
  pressure,
  orderflowSeries,
  type PoolLeg,
} from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { DEFAULT_THRESHOLDS, detectCrossBlockArbTraders, INTERNAL_ADDRESSES } from '../shared/alerts';
import { liquidityNormalizedThresholds, detectTwapBursts, reconstructIntentChains } from '../shared/alerts-lab';
import { annotateSlippageCurve } from '../worker/src/sources/sqs';
import { testD1, insert } from './d1-sqlite';
import type { Flow, SlippageCurvePoint, SourceHealth } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BONDS = fx('bonds_listing.json');
const H = 3600_000, D = 86400_000, M = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0);
const MASP = INTERNAL_ADDRESSES.masp;
const POS = INTERNAL_ADDRESSES.pos;

describe('1. Consensus unbonds & slashes decoded from /vp/pos/bonds_and_unbonds/to', () => {
  const l = parseBondListing(BONDS.value);
  const e = BONDS.expected;

  it('decodes every unbond and slash vector in the mainnet fixture without skipping bytes', () => {
    expect(l.entriesWithUnbonds).toBe(e.withUnbonds); // 15 entries carry unbonds in the mainnet fixture
    expect(l.entriesWithSlashes).toBe(e.withSlashes); // 3 entries carry slashes in the mainnet fixture
    expect(l.unbondingBase > 0n).toBe(true);
    expect(l.slashes.length).toBeGreaterThanOrEqual(e.withSlashes);

    // Sources with bondedBase === 0n that exist only because of pending/withdrawable unbonds now expose their unbonds
    const unbondOnly1 = l.sources.get('tnam1q98jzz306gldxvtg5quwnej4zvna6pgnquk2t4dc')!;
    const unbondOnly2 = l.sources.get('tnam1q9mnn2qkg3fzuw8hzwgnuxa42rvdjhkn5s065aa3')!;
    expect(unbondOnly1.bondedBase).toBe(0n);
    expect(unbondOnly1.unbondingBase > 0n).toBe(true);
    expect(unbondOnly1.unbonds.length).toBeGreaterThan(0);
    expect(unbondOnly2.bondedBase).toBe(0n);
    expect(unbondOnly2.unbondingBase > 0n).toBe(true);
    expect(unbondOnly2.unbonds.length).toBeGreaterThan(0);
  });

  it('builds an epoch-by-epoch forward unlock term structure and consensus liquidAt lookup', async () => {
    const { termStructure, withdrawCache } = buildUnbondTermStructure(l, 8343327, 2690, NOW, 21600);
    expect(termStructure.totalUnbondingNam).toBeCloseTo(Number(l.unbondingBase) / 1e6, 5);
    expect(termStructure.withdrawableNowNam + termStructure.inFlightNam).toBeCloseTo(termStructure.totalUnbondingNam, 5);
    expect(termStructure.buckets.length).toBeGreaterThan(0);
    // Buckets are sorted by withdrawEpoch ascending
    expect(termStructure.buckets.map((b) => b.withdrawEpoch)).toEqual(
      [...termStructure.buckets.map((b) => b.withdrawEpoch)].sort((a, b) => a - b),
    );
    expect(Object.keys(withdrawCache.byAddress).length).toBeGreaterThan(0);

    // Running runBondListing persists unbond.term_structure and unbond.withdraw so pressure() serves consensus liquidAt
    const db = testD1();
    const health: SourceHealth[] = [];
    await runBondListing({ DB: db } as any, health, NOW, 2690, {}, async () => ({
      ...l,
      height: 8343327,
      provider: 'TestNode',
    }));

    const sampleAddr = Object.keys(withdrawCache.byAddress)[0];
    const sampleUnbond = withdrawCache.byAddress[sampleAddr][0];
    insert(db, 'flows', [
      {
        id: 'namada:U1:pos',
        chain: 'namada',
        height: 8343000,
        ts: NOW - 2 * D,
        tx_hash: 'U1',
        kind: 'unbond',
        from_addr: POS,
        to_addr: sampleAddr,
        amount_num: sampleUnbond.amountNam,
        meta: JSON.stringify({ validator: sampleUnbond.validator }),
      },
    ]);

    const p = await pressure(db as any, NOW, false);
    expect(p.unbondTermStructure).toBeDefined();
    expect(p.unbondTermStructure?.totalUnbondingNam).toBeCloseTo(termStructure.totalUnbondingNam, 5);
    const hit = p.unlocks.find((u) => u.txHash === 'U1');
    if (sampleUnbond.amountNam >= 100_000) {
      expect(hit?.liquidAtSource).toBe('consensus');
      expect(hit?.liquidAt).toBe(sampleUnbond.withdrawTime);
    }
  });
});

describe('2. MASP Turnstile & Timing/Amount Correlation Linker', () => {
  it('links low-entropy <24h MASP passthroughs while computing k-anonymity set size', () => {
    const legs: PoolLeg[] = [
      // Whale shields 250,000 NAM and unshields 249,995 NAM (fee ~5 NAM) 25 minutes later to osmo1_dump
      { ts: NOW - 3 * H, amount: 250_000, dir: 'in', bridge: false, from: 'tnam1qwhalevault', to: MASP },
      { ts: NOW - 3 * H + 25 * M, amount: 249_995, dir: 'out', bridge: true, from: MASP, to: 'osmo1freshdumper' },
      // Two different users shield 50,000 NAM within an hour of a 50,000 NAM exit -> k = 2 (medium confidence)
      { ts: NOW - 10 * H, amount: 50_000, dir: 'in', bridge: false, from: 'tnam1quser1', to: MASP },
      { ts: NOW - 9 * H, amount: 50_000, dir: 'in', bridge: false, from: 'tnam1quser2', to: MASP },
      { ts: NOW - 8 * H, amount: 49_990, dir: 'out', bridge: false, from: MASP, to: 'tnam1qrecipient' },
      // Sticky shield with no matching outflow
      { ts: NOW - 5 * D, amount: 1_000_000, dir: 'in', bridge: false, from: 'tnam1qlongterm', to: MASP },
    ];

    const links = matchMaspPassthroughs(legs);
    expect(links).toHaveLength(2);
    const whaleLink = links.find((x) => x.outTo === 'osmo1freshdumper')!;
    expect(whaleLink).toMatchObject({
      inFrom: 'tnam1qwhalevault',
      outTo: 'osmo1freshdumper',
      anonymitySetK: 1,
      confidence: 'high',
      dwellMs: 25 * M,
    });

    const k2Link = links.find((x) => x.outTo === 'tnam1qrecipient')!;
    expect(k2Link.anonymitySetK).toBe(2);
    expect(k2Link.confidence).toBe('medium');
  });

  it('exposes passthroughs7d, turnstileNam7d, and stickySharePct7d in blindSpot()', async () => {
    const db = testD1();
    insert(db, 'flows', [
      { id: 'n1', chain: 'namada', height: 100, ts: NOW - 4 * H, tx_hash: 'T1', kind: 'shield', from_addr: 'tnam1qwhale', to_addr: MASP, amount_num: 100_000, meta: null },
      { id: 'n2', chain: 'namada', height: 110, ts: NOW - 3 * H, tx_hash: 'T2', kind: 'ibc_out', from_addr: MASP, to_addr: 'osmo1dumper', amount_num: 99_990, meta: null },
      { id: 'n3', chain: 'namada', height: 120, ts: NOW - 2 * D, tx_hash: 'T3', kind: 'shield', from_addr: 'tnam1qsaver', to_addr: MASP, amount_num: 300_000, meta: null },
    ]);

    const bs = await blindSpot(db as any, NOW, false);
    expect(bs.shields7d).toBe(400_000);
    expect(bs.unshields7d).toBe(99_990);
    expect(bs.passthroughs7d).toHaveLength(1);
    expect(bs.passthroughs7d?.[0]).toMatchObject({
      inFrom: 'tnam1qwhale',
      outTo: 'osmo1dumper',
      confidence: 'high',
    });
    expect(bs.turnstileNam7d).toBe(99_990);
    expect(bs.stickySharePct7d).toBeCloseTo((1 - 99_990 / 400_000) * 100, 3);
  });
});

describe('3. 2-Hop Burner Transfer Attribution in unlocks and onDeck', () => {
  it('traces withdraw -> Namada burner transfer -> IBC bridge -> Osmosis sell back to the withdrawing vault', async () => {
    const db = testD1();
    const vault = 'tnam1qbacker_vault';
    const burner = 'tnam1qdisposable_burner';
    const osmoSeller = 'osmo1seller_acct';

    insert(db, 'labels', [
      { address: vault, chain: 'namada', label: 'Genesis: af_backers', category: 'backer', source: 'genesis' },
    ]);
    insert(db, 'address_links', [
      { osmo_addr: osmoSeller, namada_addr: burner, first_seen: NOW - 10 * H, last_seen: NOW - 10 * H, transfers: 1, volume_num: 400_000 },
    ]);
    insert(db, 'flows', [
      // 1. Vault withdraws 400,000 NAM from PoS
      { id: 'f1', chain: 'namada', height: 1, ts: NOW - 12 * H, tx_hash: 'W_TX', kind: 'withdraw', from_addr: POS, to_addr: vault, amount_num: 400_000, meta: null },
      // 2. Vault transfers 400,000 NAM to an unlabeled burner 1 hour later
      { id: 'f2', chain: 'namada', height: 2, ts: NOW - 11 * H, tx_hash: 'HOP_TX', kind: 'transfer', from_addr: vault, to_addr: burner, amount_num: 400_000, meta: null },
      // 3. Burner bridges 400,000 NAM to Osmosis
      { id: 'f3', chain: 'namada', height: 3, ts: NOW - 10 * H, tx_hash: 'IBC_OUT_TX', kind: 'ibc_out', from_addr: burner, to_addr: osmoSeller, amount_num: 400_000, meta: null },
      { id: 'f4', chain: 'osmosis', height: 4, ts: NOW - 10 * H + 2 * M, tx_hash: 'IBC_IN_TX', kind: 'ibc_in', from_addr: burner, to_addr: osmoSeller, amount_num: 400_000, meta: null },
      // 4. Osmosis seller dumps 250,000 NAM on DEX
      { id: 'f5', chain: 'osmosis', height: 5, ts: NOW - 9 * H, tx_hash: 'SELL_TX', kind: 'sell', from_addr: osmoSeller, to_addr: 'osmo1pool', amount_num: 250_000, meta: null },
    ]);

    const p = await pressure(db as any, NOW, false);
    // Unlocks: the withdrawal's outcome is attributed through the burner hop (400k bridged_out / 250k sold) instead of 'liquid'
    const w = p.unlocks.find((u) => u.txHash === 'W_TX')!;
    expect(w).toBeDefined();
    expect(w.outcome).toEqual({ kind: 'bridged_out', amountNam: 400_000 });

    // OnDeck: osmoSeller's linkedNamada is `burner`, and `hopOriginNamada` surfaces `vault` with its label!
    const deck = p.onDeck.find((d) => d.address === osmoSeller)!;
    expect(deck.linkedNamada).toBe(burner);
    expect(deck.hopOriginNamada).toMatchObject({
      address: vault,
      label: 'Genesis: af_backers',
    });
    expect(deck.dumpHazardScore).toBeGreaterThan(0.5);
  });
});

describe('4. Sub-Threshold TWAP Burst Detection & Cross-Block Arbitrage Filtering', () => {
  it('flags cross-block non-atomic arbitrageurs and detects sub-threshold TWAP splitters', () => {
    const flows: Flow[] = [
      // Cross-block arb bot: 4 buys and 4 sells of 8,000 NAM across different blocks (not flagged as single-tx meta.arb)
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `arb-buy-${i}`, chain: 'osmosis' as const, height: 100 + i * 2, ts: NOW - 60 * M + i * 5 * M,
        txHash: `AB${i}`, kind: 'buy' as const, from: 'pool', to: 'osmo1arbbot', amount: 8_000,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `arb-sell-${i}`, chain: 'osmosis' as const, height: 101 + i * 2, ts: NOW - 58 * M + i * 5 * M,
        txHash: `AS${i}`, kind: 'sell' as const, from: 'osmo1arbbot', to: 'pool', amount: 8_000,
      })),
      // Whale TWAP splitter: 5 sells of 4,500 NAM each (each < 10,000 NAM bigSwap threshold, sum = 22,500 NAM) within 25m
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `twap-sell-${i}`, chain: 'osmosis' as const, height: 200 + i, ts: NOW - 30 * M + i * 5 * M,
        txHash: `TW${i}`, kind: 'sell' as const, from: 'osmo1twapwhale', to: 'pool', amount: 4_500,
      })),
    ];

    const turnarounds = detectCrossBlockArbTraders(flows);
    expect(turnarounds.get('osmo1arbbot')?.crossBlockArb).toBe(true);
    expect(turnarounds.get('osmo1arbbot')?.turnaroundRatio).toBe(1);
    expect(turnarounds.get('osmo1twapwhale')?.crossBlockArb).toBe(false);

    const bursts = detectTwapBursts(flows, DEFAULT_THRESHOLDS);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({
      ruleId: 'twap_burst',
      address: 'osmo1twapwhale',
      amountNam: 22_500,
    });
  });

  it('scales liquidity-normalized thresholds with reference pool reserve and reconstructs multi-stage intent chains', () => {
    const thinTh = liquidityNormalizedThresholds(120_000, DEFAULT_THRESHOLDS);
    expect(thinTh.bigSwap).toBe(3_000); // 2.5% of 120k NAM
    expect(thinTh.ibcInventory).toBe(7_200); // 6% of 120k NAM

    const deepTh = liquidityNormalizedThresholds(2_000_000, DEFAULT_THRESHOLDS);
    expect(deepTh.bigSwap).toBe(50_000);
    expect(deepTh.ibcInventory).toBe(120_000);

    const flows: Flow[] = [
      { id: '1', chain: 'namada', height: 1, ts: NOW - 5 * H, txHash: 'H1', kind: 'withdraw', from: POS, to: 'tnam1qorigin', amount: 150_000 },
      { id: '2', chain: 'namada', height: 2, ts: NOW - 4 * H, txHash: 'H2', kind: 'transfer', from: 'tnam1qorigin', to: 'tnam1qburner', amount: 150_000 },
      { id: '3', chain: 'osmosis', height: 3, ts: NOW - 3 * H, txHash: 'H3', kind: 'ibc_in', from: 'tnam1qburner', to: 'osmo1exec', amount: 150_000 },
      { id: '4', chain: 'osmosis', height: 4, ts: NOW - 2 * H, txHash: 'H4', kind: 'sell', from: 'osmo1exec', to: 'pool', amount: 60_000 },
    ];
    const chains = reconstructIntentChains(flows, new Map([['osmo1exec', 'tnam1qburner']]));
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      entityAddress: 'tnam1qorigin',
      namadaOrigin: 'tnam1qorigin',
      osmosisTarget: 'osmo1exec',
      stage: 4,
      unlockedOrUnshieldedNam: 150_000,
      bridgedNam: 150_000,
      soldNam: 60_000,
    });
    expect(chains[0].stagesSeen).toEqual(expect.arrayContaining(['withdraw_or_unshield', 'burner_hop', 'ibc_bridge', 'dex_sell']));
    expect(chains[0].dumpHazardScore).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Review fixes (docs/review-deep-protocol-intelligence.md)', () => {
  const l = parseBondListing(BONDS.value);
  it('1. no epoch length, no clock time: an unbond keeps its withdraw epoch and liquidAt is null with the reason, never a 21,600 s stand-in', async () => {
    // at epoch 1 every fixture unbond is still in flight
    const none = buildUnbondTermStructure(l, 8343327, 1, NOW, null);
    expect(none.termStructure).toMatchObject({ epochSec: null, epochSecSource: null, withdrawableNowNam: 0 });
    expect(none.termStructure.inFlightNam).toBeCloseTo(none.termStructure.totalUnbondingNam, 6);
    for (const b of none.termStructure.buckets) expect(b.estimatedAt).toBeNull();
    for (const list of Object.values(none.withdrawCache.byAddress)) for (const u of list) expect(u.withdrawTime).toBeNull();
    const measured = buildUnbondTermStructure(l, 8343327, 1, NOW, 25_000, '6.9 h measured over 40 epochs');
    expect(measured.termStructure).toMatchObject({ epochSec: 25_000, epochSecSource: '6.9 h measured over 40 epochs' });
    for (const b of measured.termStructure.buckets) expect(b.estimatedAt).toBe(NOW + (b.withdrawEpoch - 1) * 25_000_000);
    // already withdrawable: the time is the listing's, no epoch length needed
    const now = buildUnbondTermStructure(l, 8343327, 2690, NOW, null);
    for (const b of now.termStructure.buckets) expect(b).toMatchObject({ withdrawableNow: true, estimatedAt: NOW });

    // the cron writes the cache without a time when the chain parameters are not stored
    const db = testD1();
    await runBondListing({ DB: db } as any, [], NOW, 1, {}, async () => ({ ...l, height: 8343327, provider: 'TestNode' }));
    const cache = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='unbond.withdraw'").get().value);
    const entries = Object.values(cache.byAddress as Record<string, { withdrawTime: number | null; source: string }[]>).flat();
    expect(entries.length).toBeGreaterThan(0);
    for (const u of entries) expect(u).toMatchObject({ withdrawTime: null, source: 'consensus' });
    // pressure(): a listed unbond above the list floor with no time is shown without one and says why
    const big = 'tnam1qbigunbonder';
    cache.byAddress[big] = [{ validator: 'tnam1qvalidator', amountNam: 150_000, withdrawEpoch: 2712, withdrawTime: null, source: 'consensus' }];
    db.raw.prepare("UPDATE kv SET value = ? WHERE key='unbond.withdraw'").run(JSON.stringify(cache));
    insert(db, 'flows', [{ id: 'namada:U2:pos', chain: 'namada', height: 8343000, ts: NOW - 2 * D, tx_hash: 'U2', kind: 'unbond', from_addr: POS, to_addr: big, amount_num: 150_000, meta: JSON.stringify({ validator: 'tnam1qvalidator' }) }]);
    const p = await pressure(db as any, NOW, false);
    const hit = p.unlocks.find((u) => u.txHash === 'U2')!;
    expect(hit).toMatchObject({ liquidAt: null, liquidAtSource: null });
    expect(hit.liquidAtNote).toBe("Withdrawable from epoch 2,712 (the chain's bond listing); the time is not known because the epoch length could not be read.");
    expect(p.unbondingProv.status).toBe('missing');
  });

  it('2. the term structure is stamped by its age like every other figure: live, stale past three bond-listing intervals, missing when absent', async () => {
    const db = testD1();
    expect((await pressure(db as any, NOW, false)).unbondTermStructureProv).toMatchObject({ status: 'missing', at: null });
    const ts = buildUnbondTermStructure(l, 8343327, 2690, NOW - 30 * D, 21_600).termStructure;
    insert(db, 'kv', [{ key: 'unbond.term_structure', value: JSON.stringify(ts), updated_at: NOW }]);
    const stale = await pressure(db as any, NOW, false);
    expect(stale.unbondTermStructureProv).toMatchObject({ status: 'stale', at: NOW - 30 * D, height: 8343327 });
    expect(stale.unbondTermStructure?.totalUnbondingNam).toBeCloseTo(ts.totalUnbondingNam, 6);
    db.raw.prepare("UPDATE kv SET value = ? WHERE key='unbond.term_structure'").run(JSON.stringify({ ...ts, at: NOW - H }));
    expect((await pressure(db as any, NOW, false)).unbondTermStructureProv).toMatchObject({ status: 'live', at: NOW - H });
    // rewound before it was written: not shown as if it had been
    expect((await pressure(db as any, NOW - 2 * H, true)).unbondTermStructureProv.status).toBe('missing');
  });

  it('3. an Osmosis account linked to both the vault and its burner is one seller: a sale is counted once', async () => {
    const db = testD1();
    const vault = 'tnam1qvault_shared', burner = 'tnam1qburner_shared', osmo = 'osmo1shared';
    insert(db, 'flows', [
      // both sent NAM to the one Osmosis account (Osmosis's records of the crossings: the link pressure() reads)
      { id: 'g0a', chain: 'osmosis', height: 3, ts: NOW - 10 * H, tx_hash: 'IN_VAULT', kind: 'ibc_in', from_addr: vault, to_addr: osmo, amount_num: 100_000, meta: null },
      { id: 'g0b', chain: 'osmosis', height: 4, ts: NOW - 10 * H, tx_hash: 'IN_BURNER', kind: 'ibc_in', from_addr: burner, to_addr: osmo, amount_num: 100_000, meta: null },
      { id: 'g1', chain: 'namada', height: 1, ts: NOW - 12 * H, tx_hash: 'W_SHARED', kind: 'withdraw', from_addr: POS, to_addr: vault, amount_num: 300_000, meta: null },
      { id: 'g2', chain: 'namada', height: 2, ts: NOW - 11 * H, tx_hash: 'HOP_SHARED', kind: 'transfer', from_addr: vault, to_addr: burner, amount_num: 200_000, meta: null },
      { id: 'g3', chain: 'osmosis', height: 5, ts: NOW - 9 * H, tx_hash: 'SELL_SHARED', kind: 'sell', from_addr: osmo, to_addr: 'osmo1pool', amount_num: 100_000, meta: null },
    ]);
    const p = await pressure(db as any, NOW, false);
    expect(p.unlocks.find((u) => u.txHash === 'W_SHARED')!.outcome).toEqual({ kind: 'sold', amountNam: 100_000 });
  });

  it('4. a burner\'s upstream origin comes from transfers in the 48 h before its NAM arrived, of a meaningful size: dust eight days earlier names nobody', async () => {
    const db = testD1();
    const burner = 'tnam1qburner_origin', osmo = 'osmo1fresh_origin', genesis = 'tnam1qgenesis_origin', origin = 'tnam1qreal_origin';
    insert(db, 'labels', [{ address: genesis, chain: 'namada', label: 'Early backers (genesis)', category: 'backer', source: 'genesis' }]);
    insert(db, 'address_links', [{ osmo_addr: osmo, namada_addr: burner, first_seen: NOW - H, last_seen: NOW - H, transfers: 1, volume_num: 400_000 }]);
    insert(db, 'flows', [
      { id: 'o1', chain: 'namada', height: 1, ts: NOW - 8 * D, tx_hash: 'DUST', kind: 'transfer', from_addr: genesis, to_addr: burner, amount_num: 0.5, meta: null },
      { id: 'o2', chain: 'osmosis', height: 4, ts: NOW - H, tx_hash: 'IN_ORIGIN', kind: 'ibc_in', from_addr: burner, to_addr: osmo, amount_num: 400_000, meta: null },
    ]);
    let deck = (await pressure(db as any, NOW, false)).onDeck.find((d) => d.address === osmo)!;
    expect(deck.linkedNamada).toBe(burner);
    expect(deck.hopOriginNamada).toBeUndefined();
    // a 2,000 NAM transfer the day before is in the window but under a tenth of what crossed: still nobody
    insert(db, 'flows', [{ id: 'o3', chain: 'namada', height: 2, ts: NOW - 20 * H, tx_hash: 'SMALL', kind: 'transfer', from_addr: genesis, to_addr: burner, amount_num: 2_000, meta: null }]);
    deck = (await pressure(db as any, NOW, false)).onDeck.find((d) => d.address === osmo)!;
    expect(deck.hopOriginNamada).toBeUndefined();
    // the real funding, two hours before the crossing: named
    insert(db, 'flows', [{ id: 'o4', chain: 'namada', height: 3, ts: NOW - 3 * H, tx_hash: 'FUND', kind: 'transfer', from_addr: origin, to_addr: burner, amount_num: 400_000, meta: null }]);
    deck = (await pressure(db as any, NOW, false)).onDeck.find((d) => d.address === osmo)!;
    expect(deck.hopOriginNamada).toMatchObject({ address: origin, label: null });
    // the same funding after the crossing is not an origin of it
    db.raw.prepare("UPDATE flows SET ts = ? WHERE id = 'o4'").run(NOW - 30 * M);
    deck = (await pressure(db as any, NOW, false)).onDeck.find((d) => d.address === osmo)!;
    expect(deck.hopOriginNamada).toBeUndefined();
  });

  it('5. a rung without a sell quote does not widen the next slice: the sell baseline is the last quoted rung', () => {
    const spot = 0.001;
    const raw: SlippageCurvePoint[] = [
      { amountNam: 1_000, usdSize: 1, buyImpactPct: 0.2, sellImpactPct: 0.2, buyEffectiveUsd: 0.001002, sellEffectiveUsd: 0.000998, sellOutUsdc: 0.998, buyInUsdc: 1.002, buyOutNam: 1_000, buyExact: true },
      { amountNam: 5_000, usdSize: 5, buyImpactPct: 0.5, sellImpactPct: null as any, buyEffectiveUsd: 0.001005, sellEffectiveUsd: null as any, sellOutUsdc: null, buyInUsdc: 5.025, buyOutNam: 5_000, buyExact: true },
      { amountNam: 10_000, usdSize: 10, buyImpactPct: 0.8, sellImpactPct: 0.8, buyEffectiveUsd: 0.001008, sellEffectiveUsd: 0.000992, sellOutUsdc: 9.92, buyInUsdc: 10.08, buyOutNam: 10_000, buyExact: true },
    ];
    const res = annotateSlippageCurve(raw, spot);
    expect(res.curve[1].marginalSellUsd).toBeNull();
    // the 1,000 → 10,000 slice: (9.92 − 0.998) / 9,000 = $0.000991 a NAM, 0.89% under spot (not 0% from a 5,000 NAM denominator)
    expect(res.curve[2].marginalSellUsd).toBeCloseTo(0.000991, 6);
    expect(res.curve[2].marginalSellImpactPct).toBeCloseTo(0.87, 1);
    expect(res.liquidityCliffNam).toBeNull();
  });
});

describe('5. Concentrated Liquidity Tick-Cliff Detector on Slippage Curve', () => {
  it('computes marginal slice execution prices and flags a >2.5x marginal slippage cliff', () => {
    const spot = 0.001;
    const raw: SlippageCurvePoint[] = [
      { amountNam: 1_000, usdSize: 1, buyImpactPct: 0.2, sellImpactPct: 0.2, buyEffectiveUsd: 0.001002, sellEffectiveUsd: 0.000998, sellOutUsdc: 0.998, buyInUsdc: 1.002, buyOutNam: 1_000, buyExact: true },
      { amountNam: 5_000, usdSize: 5, buyImpactPct: 0.5, sellImpactPct: 0.5, buyEffectiveUsd: 0.001005, sellEffectiveUsd: 0.000995, sellOutUsdc: 4.975, buyInUsdc: 5.025, buyOutNam: 5_000, buyExact: true },
      { amountNam: 10_000, usdSize: 10, buyImpactPct: 0.8, sellImpactPct: 0.8, buyEffectiveUsd: 0.001008, sellEffectiveUsd: 0.000992, sellOutUsdc: 9.92, buyInUsdc: 10.08, buyOutNam: 10_000, buyExact: true },
      // Above 10,000 NAM, active CL tick liquidity is exhausted: next 15,000 NAM only gets $12.00 ($0.0008/NAM -> 20% marginal impact!)
      { amountNam: 25_000, usdSize: 25, buyImpactPct: 12.0, sellImpactPct: 12.3, buyEffectiveUsd: 0.00112, sellEffectiveUsd: 0.0008768, sellOutUsdc: 21.92, buyInUsdc: 28.0, buyOutNam: 25_000, buyExact: true },
    ];

    const res = annotateSlippageCurve(raw, spot);
    expect(res.liquidityCliffNam).toBe(10_000);
    expect(res.cliffNote).toMatch(/Concentrated Liquidity cliff above 10,000 NAM/);
    expect(res.curve[2].marginalSellImpactPct).toBeCloseTo(1.1, 2); // (9.92 - 4.975) / 5000 = 0.000989 -> 1.1%
    expect(res.curve[3].marginalSellImpactPct).toBeCloseTo(20.0, 2); // (21.92 - 9.92) / 15000 = 0.0008 -> 20%
  });
});

describe('6. Dune-Grade Live Charts & Long-Term Multi-Year Analytics', () => {
  it('computes signed orderflow buckets, running CVD, VWAP, and bid absorption regime while excluding arb bots', async () => {
    const db = testD1();
    insert(db, 'flows', [
      // Heavy sell volume (100k NAM) absorbed at $0.1000
      {
        id: 's1', chain: 'osmosis', height: 10, ts: NOW - 6 * H, tx_hash: 'S1', kind: 'sell',
        from_addr: 'osmo1seller', to_addr: 'pool', amount_num: 100_000, price_usd: 0.1000, value_usd: 10_000,
        meta: JSON.stringify({ effectivePriceUsd: 0.1000, poolId: '1' }),
      },
      // Modest buy volume (20k NAM) at $0.0998 (price barely drops -0.2% despite -80k net delta -> bid_absorption!)
      {
        id: 'b1', chain: 'osmosis', height: 12, ts: NOW - 2 * H, tx_hash: 'B1', kind: 'buy',
        from_addr: 'pool', to_addr: 'osmo1buyer', amount_num: 20_000, price_usd: 0.0998, value_usd: 1_996,
        meta: JSON.stringify({ effectivePriceUsd: 0.0998, poolId: '1' }),
      },
      // Arb bot swap (excluded from CVD)
      {
        id: 'a1', chain: 'osmosis', height: 13, ts: NOW - 1 * H, tx_hash: 'A1', kind: 'buy',
        from_addr: 'pool', to_addr: 'osmo1bot', amount_num: 500_000, price_usd: 0.1000, value_usd: 50_000,
        meta: JSON.stringify({ arb: true, effectivePriceUsd: 0.1000 }),
      },
    ]);

    const of = await orderflowSeries(db as any, NOW, false, 24);
    expect(of.grossVolumeNam).toBe(120_000);
    expect(of.netCvdNam).toBe(-80_000);
    expect(of.buySharePct).toBeCloseTo((20_000 / 120_000) * 100, 3);
    expect(of.absorptionRegime).toBe('bid_absorption');
    expect(of.buckets.some((b) => b.sellNam === 100_000 && b.vwapUsd === 0.1)).toBe(true);
    expect(of.buckets[of.buckets.length - 1].cvdNam).toBe(-80_000);

    // Also verify GET /api/orderflow endpoint for 1y (8760h)
    const req = new Request(`https://namada.trade/api/orderflow?hours=8760&at=${NOW}`);
    const res = await app.fetch(req, { DB: db } as any);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.hours).toBe(8760);
    expect(body.bucketMs).toBe(D);
    expect(body.netCvdNam).toBe(-80_000);
  });

  it('populates pipelineSummary cohort attribution in pressure() and pulseSeries in blindSpot()', async () => {
    const db = testD1();
    const vault = 'tnam1qgenesis_investor';
    const burner = 'tnam1qhop_relay';
    const osmoDest = 'osmo1whale_dump';

    insert(db, 'labels', [
      { address: vault, chain: 'namada', label: 'Genesis: early_backer', category: 'backer', source: 'genesis' },
    ]);
    insert(db, 'address_links', [
      { osmo_addr: osmoDest, namada_addr: burner, first_seen: NOW - 20 * H, last_seen: NOW - 20 * H, transfers: 1, volume_num: 300_000 },
    ]);
    insert(db, 'flows', [
      { id: 'h1', chain: 'namada', height: 1, ts: NOW - 22 * H, tx_hash: 'H1', kind: 'transfer', from_addr: vault, to_addr: burner, amount_num: 300_000, meta: null },
      { id: 'h2', chain: 'osmosis', height: 2, ts: NOW - 20 * H, tx_hash: 'H2', kind: 'ibc_in', from_addr: burner, to_addr: osmoDest, amount_num: 300_000, meta: null },
      { id: 'h3', chain: 'osmosis', height: 3, ts: NOW - 18 * H, tx_hash: 'H3', kind: 'sell', from_addr: osmoDest, to_addr: 'pool', amount_num: 100_000, meta: null },
      // MASP shield + fast turnstile exit
      { id: 'm1', chain: 'namada', height: 4, ts: NOW - 10 * H, tx_hash: 'M1', kind: 'shield', from_addr: 'tnam1quser', to_addr: MASP, amount_num: 80_000, meta: null },
      { id: 'm2', chain: 'namada', height: 5, ts: NOW - 9 * H, tx_hash: 'M2', kind: 'unshield', from_addr: MASP, to_addr: 'tnam1qexit', amount_num: 79_990, meta: null },
    ]);

    const p90 = await pressure(db as any, NOW, false, 90);
    expect(p90.windowDays).toBe(90);
    expect(p90.pipelineSummary).toBeDefined();
    expect(p90.pipelineSummary?.cohorts.genesisBackersNam).toBe(300_000);

    const bs = await blindSpot(db as any, NOW, false);
    expect(bs.pulseSeries).toBeDefined();
    expect(bs.pulseSeries!.length).toBeGreaterThan(0);
    const totalIn = bs.pulseSeries!.reduce((s, b) => s + b.inNam, 0);
    const totalTurn = bs.pulseSeries!.reduce((s, b) => s + b.turnstileNam, 0);
    expect(totalIn).toBe(80_000);
    expect(totalTurn).toBe(79_990);
  });

  it('serves long-range /api/metrics/history up to 1,500 days by stitching pos_bonded and swap flows', async () => {
    const db = testD1();
    insert(db, 'metrics', [
      { key: 'supply.pos_bonded', ts: NOW - 200 * D, value: 410_000_000 },
      { key: 'supply.total_stake', ts: NOW - 2 * D, value: 455_000_000 },
      // the hourly job's rollup of that hour (series.ts rollupStmts): a range in buckets of an hour or more reads the rollups
      { key: 'supply.total_stake.1h', ts: NOW - 2 * D, value: 455_000_000 },
      { key: 'supply.total_stake.1h.lo', ts: NOW - 2 * D, value: 455_000_000 },
      { key: 'supply.total_stake.1h.hi', ts: NOW - 2 * D, value: 455_000_000 },
      { key: 'price.swap_1h', ts: NOW - 1 * D, value: 0.085 },
    ]);
    insert(db, 'flows', [
      {
        id: 'old-swap', chain: 'osmosis', height: 1, ts: NOW - 180 * D, tx_hash: 'OS1', kind: 'buy',
        from_addr: 'pool', to_addr: 'osmo1early', amount_num: 10_000, counter_denom: 'USDC', counter_amount: 1_200, pool_id: '3005',
        price_usd: 0.12, value_usd: 1_200, meta: null,
      },
      // Not executed NAM/USDC prices, so never stitched in: a trade priced at the quote, and a USDC trade in a pool
      // anyone could have created at any price.
      {
        id: 'spot-swap', chain: 'osmosis', height: 1, ts: NOW - 150 * D, tx_hash: 'OS2', kind: 'sell',
        from_addr: 'osmo1early', to_addr: null, amount_num: 10_000, counter_denom: 'OSMO', counter_amount: 3, pool_id: '3368',
        price_usd: 0.5, value_usd: 5_000, meta: null,
      },
      {
        id: 'foreign-pool', chain: 'osmosis', height: 1, ts: NOW - 120 * D, tx_hash: 'OS3', kind: 'sell',
        from_addr: 'osmo1early', to_addr: null, amount_num: 50, counter_denom: 'USDC', counter_amount: 0.5, pool_id: '999999',
        price_usd: 0.01, value_usd: 0.5, meta: null,
      },
    ]);

    const stakeRes = await app.fetch(new Request(`https://namada.trade/api/metrics/history?key=supply.total_stake&hours=${24 * 365}&at=${NOW}`), { DB: db } as any);
    const stakeJson = (await stakeRes!.json()) as any;
    expect(stakeJson.history.length).toBe(2);
    expect(stakeJson.history[0].value).toBe(410_000_000);
    expect(stakeJson.history[1].value).toBe(455_000_000);

    const swapRes = await app.fetch(new Request(`https://namada.trade/api/metrics/history?key=price.swap_1h&hours=${24 * 365}&at=${NOW}`), { DB: db } as any);
    const swapJson = (await swapRes!.json()) as any;
    expect(swapJson.history.length).toBe(2);
    expect(swapJson.history[0].value).toBe(0.12);
    expect(swapJson.history[1].value).toBe(0.085);
  });
});

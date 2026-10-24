// Daily digest (2026-10-23), the figures shaped from stored answers: worker/src/digest/figures.ts shapes the answers of
// its statements into the figures of spec section 5 without a database. Fed the production answers the data map's
// survey recorded for 2026-10-23 08:00 UTC (test/fixtures/digest/survey-2026-10-23.json), it gives the figures of the
// spec's worked example (section 7, whose arithmetic is written out there), and under the weekly window the
// "series starts" bases of section 9. No wallet, user or owner row is in the fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  shapeDigestFigures, digestWindow, isNotRead, instantKey, SOURCES,
  type DigestReads, type DigestFigures, type Figure, type ProposalRow, type KvRow,
} from '../worker/src/digest/figures';
import { answered, failed, type Answer, type MetricRow } from '../worker/src/digest/types';
import { epochClock, epochEnd, epochClockAt } from '../worker/src/digest/epoch';
import { changeFrom, readNow, BASE_WINDOW_MS, MINUTE_BOUND_MS } from '../worker/src/digest/freshness';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'digest', 'survey-2026-10-23.json'), 'utf8'));
const T = 1792742400000, A24 = 1792656000000, A7 = 1792137600000, A30 = T - 30 * 86_400_000;
const D = 86_400_000;

const v = <T>(f: Figure<T>): T => { if (isNotRead(f)) throw new Error(`not read: ${f.source}: ${f.reason}`); return f.value; };
const pct2 = (x: number | null) => (x == null ? null : (x * 100).toFixed(2));

/** The DigestReads the collector would have handed the shaper, from the survey's answers. */
function readsFromSurvey(kind: 'daily' | 'weekly'): DigestReads {
  const base = kind === 'weekly' ? A7 : A24;
  const slot = kind === 'weekly' ? '7d' : '24h';
  const instants: Record<string, Answer<MetricRow>> = {};
  const firstTs: Record<string, Answer<{ first_ts: number | null }>> = {};
  for (const [key, inst] of Object.entries<any>(fx.instants)) {
    if (inst.now !== undefined) instants[instantKey(key, T)] = answered(inst.now ? [inst.now] : []);
    if (inst[slot] !== undefined) {
      instants[instantKey(key, base)] = answered(inst[slot] ? [inst[slot]] : []);
      if (!inst[slot]) firstTs[key] = answered([{ first_ts: fx.firstTs[key] ?? null }]);
    }
    if (kind === 'weekly' && key === 'price.usd') { instants[instantKey(key, A30)] = answered([]); firstTs[key] = answered([{ first_ts: fx.firstTs[key] }]); }
  }
  // the epochs the two listings ran in: the first readings of 2696 and 2692 stand for the minute rows at or before each listing
  const e = (n: number) => fx.epochChanges.find((x: any) => x.e === n);
  instants[instantKey('epoch', 1792741122300)] = answered([{ ts: e(2696).first_ts, value: 2696 }]);
  instants[instantKey('epoch', 1792655642703)] = answered([{ ts: e(2692).first_ts, value: 2692 }]);
  const kv: KvRow[] = Object.entries<any>(fx.kv).map(([key, r]) => ({ key, value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value), updated_at: r.updated_at }));
  const props: ProposalRow[] = fx.kv['intel.cache'].value.proposals.map((p: any) => ({
    id: p.id, status: p.status, type: p.type, startEpoch: p.startEpoch, endEpoch: p.endEpoch, title: String(p.title).slice(0, 80), discussionsUrl: null,
    fetchedAt: fx.kv['intel.cache'].value.fetchedAt, indexerEpoch: fx.kv['intel.cache'].value.indexerEpoch,
  }));
  const day = '2026-10-23', baseDay = kind === 'weekly' ? '2026-10-16' : '2026-10-22';
  const days = fx.validators.days.filter((d: any) => d.day === day || d.day === baseDay);
  const pos = kind === 'weekly' ? fx.flows.posByKind7d.map((r: any) => ({ ...r, first_ts: null, last_ts: null, late: 0 })) : fx.flows.posByKind;
  return {
    anchors: answered(kv),
    instants,
    exact: { [instantKey('price.swap_1h.n', 1792731600000)]: answered([fx.instants['price.swap_1h.n'].at_1792731600000]) },
    firstTs,
    listings: Object.fromEntries(fx.listings.map((l: any) => [String(l.at), answered([l])])),
    epochAnchor: answered([{ started: e(2696).first_ts }]),
    epochBefore: answered([{ before_ts: e(2695).last_ts, before_value: 2695 }]),
    posByKind: answered(pos),
    largest: { bond: answered(fx.flows.largestBond), unbond: answered([]) },
    ties: { bond: answered(fx.flows.tieBond), unbond: answered(fx.flows.tieUnbond) },
    withdrawnBetween: answered(fx.flows.withdrawnBetweenListings),
    queueMatured: answered(fx.queue.matured_2693_2696),
    queueRange: answered(fx.queue.range_2697_2700),
    queueNext: answered(fx.queue.next_after_2700),
    queueFirst: answered([{ e: fx.queue.first }]),
    trusted: answered(fx.flows.trusted),
    trades: answered(fx.flows.trades),
    bridge: answered(fx.flows.bridgeOsmosis),
    refunds: answered(fx.flows.refunds),
    bridgeOuts: null,
    // the survey's MASP statement had no chain filter and returned the Osmosis ibc_out rows too (the data map's caution); the module's statement has it
    maspIn: answered(fx.flows.maspInWithoutChainFilter.filter((r: any) => r.kind !== 'ibc_out')),
    maspOut: answered(fx.flows.maspOut),
    maspFees: answered(fx.flows.maspOtherCoinFees),
    proposals: answered(props),
    govClaims: answered(fx.governance.claims24h),
    vdDays: answered(days),
    vdMoves: answered(fx.flows ? fx.validators.moves.slice(0, 5) : []),
    vdSets: answered(fx.validators.sets),
    vdStates: answered(fx.validators.states),
    vdCompared: days.length === 2 ? { day, baseDay, noListingToday: false, baseIsOldest: false } : null,
  };
}

describe('the worked example of 2026-10-23 08:00 UTC (spec section 7) from the stored answers', () => {
  const fig: DigestFigures = shapeDigestFigures(readsFromSurvey('daily'), digestWindow(T, 'daily'));

  it('staked NAM: total stake +467,207.00 (+0.17 %), the staking account −720,267.35, on its way out 74,018,952.09, stakers −2 with 246 validators', () => {
    const s = v(fig.staked);
    const ts = v(s.totalStake);
    expect(ts.value).toBe(267774764.266631);
    expect(ts.at).toBe(1792742342769);
    expect(ts.change.kind).toBe('ok');
    if (ts.change.kind !== 'ok') return;
    expect(ts.change.delta).toBeCloseTo(467207.0, 2);
    expect(pct2(ts.change.pct)).toBe('0.17');
    expect(ts.change.base.ts).toBe(1792655942278);
    expect(ts.change.baseOff).toBe(false);
    expect(fig.staked && !isNotRead(fig.staked) && fig.staked.stamp.source).toBe(SOURCES.totalStake);
    const ac = v(s.account);
    expect(ac.value).toBe(341793716.357239);
    expect(ac.change.kind === 'ok' && ac.change.delta).toBeCloseTo(-720267.35, 2);
    expect(s.onItsWayOutOrUnclaimed).toBeCloseTo(74018952.09, 2);
    const st = v(s.stakers);
    expect(st.value).toBe(19340);
    expect(st.change.kind === 'ok' && st.change.delta).toBe(-2);
    expect(v(s.validators).value).toBe(246);
  });

  it('requests: 10 bonds of 373,220 NAM, the largest 50,000 at 12:35 UTC in block 8,374,275, seven of that size to six validators; 2 unbonds of 30,900, the largest 25,100', () => {
    const r = v(fig.requests);
    expect(r.bonds.n).toBe(10);
    expect(r.bonds.nam).toBe(373220);
    expect(r.bonds.largestNam).toBe(50000);
    expect(r.bonds.largest?.ts).toBe(1792672521237);
    expect(new Date(r.bonds.largest!.ts).toISOString()).toBe('2026-10-22T12:35:21.237Z');
    expect(r.bonds.largest?.height).toBe(8374275);
    expect(r.bonds.largest?.validator).toBe('tnam1qx405kgvey8wwfcyt7rgsr4nvkrqsnztxs2kz7wv');
    // the survey's LIMIT 3 read saw three of them; the per-validator read shows seven bonds of 50,000 NAM to six validators in the window
    expect(r.bonds.largest?.ties).toBe(7);
    expect(r.bonds.largest?.validators).toBe(6);
    expect(fx.flows.posByValidator.filter((x: any) => x.kind === 'bond' && x.nam % 50000 === 0).reduce((s: number, x: any) => s + x.n, 0)).toBe(7);
    expect(r.unbonds.n).toBe(2);
    expect(r.unbonds.nam).toBe(30900);
    expect(r.unbonds.largestNam).toBe(25100);
    expect(r.unbonds.largest).toBeNull();
    expect(r.decodeFailures).toBe(0);
    expect(r.partial).toBeNull();
    expect(!isNotRead(fig.requests) && fig.requests.stamp.source).toBe(SOURCES.namadaScan);
  });

  it('the pipeline: 181,962.02 in flight, 36,859,599.85 withdrawable (epochs 56–2,696), matured 0.00 over 2,693–2,696 by the identity and the queue, 1,170,000 withdrawn, nothing unlocking in 2,697–2,700, next 37,489.27 NAM at epoch 2,704 about 03:35 UTC on 25 Oct', () => {
    const p = v(fig.pipeline);
    expect(p.inFlight).toBe(181962.018281);
    expect(p.withdrawable).toBe(36859599.847648);
    expect(p.withdrawableEpochs).toEqual([56, 2696]);
    expect(p.listing).toEqual({ at: 1792741122300, height: 8384271, provider: 'Papadritta', epoch: 2696 });
    expect('notComputed' in p.matured).toBe(false);
    if ('notComputed' in p.matured) return;
    expect(p.matured.nam).toBeCloseTo(0, 2);
    expect(p.matured.epochs).toEqual([2693, 2696]);
    expect(p.matured.base).toEqual({ at: 1792655642703, withdrawable: 38029599.847648 });
    expect(p.matured.withdrawnBetween).toEqual({ nam: 1170000, n: 1 });
    expect(p.matured.direct).toEqual({ nam: 0, n: 0 });
    expect(p.matured.differs).toBe(false);
    expect(p.withdrawn).toEqual({ n: 1, nam: 1170000, largest: 1170000, lastTs: 1792678774775 });
    const u = v(p.unlocking);
    expect(u.epochs).toEqual([2697, 2700]);
    expect(u.approx).toBe(false);
    expect(u.buckets).toEqual([]);
    expect(u.nam).toBe(0);
    expect(u.next?.epoch).toBe(2704);
    expect(u.next?.nam).toBe(37489.267473);
    expect(u.next?.n).toBe(2);
    expect(u.next?.epochsAway).toBe(8);
    expect(new Date(u.next!.at!).toISOString().slice(0, 19)).toBe('2026-10-25T03:35:20');
    // the clock: epoch 2,696 began 03:33:03 UTC by its first reading, the reading before it 03:23 UTC, so ± 10 min
    expect(new Date(fig.anchors.epoch.startedAt!).toISOString()).toBe('2026-10-23T03:33:03.586Z');
    expect(Math.round(fig.anchors.epoch.errorMs! / 60_000)).toBe(10);
    expect(fig.anchors.epoch.epochSecNote).toBe('about 6.00 h an epoch, measured over the last 30 epochs');
  });

  it('rewards: 17 claims, 3,250.15 NAM, the largest 928.27', () => {
    const r = v(fig.rewards);
    expect(r.n).toBe(17);
    expect(r.nam).toBeCloseTo(3250.15, 2);
    expect(r.largest).toBeCloseTo(928.27, 2);
  });

  it('price: $0.00087359, +3.31 % on the day; the 05:00 UTC hour executed at $0.00091650 from 1 trade, the quote 4.68 % under it (ok); no VWAP from one trade', () => {
    const p = v(fig.price);
    const q = v(p.quote);
    expect(q.value.toFixed(8)).toBe('0.00087359');
    expect(q.change.kind === 'ok' && pct2(q.change.pct)).toBe('3.31');
    expect(q.change.kind === 'ok' && q.change.base.value.toFixed(8)).toBe('0.00084557');
    expect(q.longChange).toBeNull();
    const e = v(p.executed);
    expect(e.last).toEqual({ hourStart: 1792731600000, price: 0.0009165048816351421, n: 1 });
    expect(e.status).toBe('compared');
    expect(pct2(e.comparison!.pct)).toBe('-4.68');
    expect(e.comparison!.band).toBe('ok');
    expect(e.vwap).toBeNull();
    expect(!isNotRead(p.executed) && p.executed.stamp.source).toBe(SOURCES.tradeIndex);
  });

  it('trades: 9 trades, 60,537.86 NAM (bought 29,284.64 / sold 31,253.22), $53.91 at the stored prices (1 at execution, 8 at the quote), 4 traders; the Osmosis data API says $41.74', () => {
    const t = v(fig.trades);
    // the bases as production held them for the window (read-only count of 2026-10-23 over the same rows)
    expect(t.basis).toEqual({ execution: 1, pool_1h: 0, spot: 8, swap_1h: 0, unstated: 0 });
    expect(t.n).toBe(9);
    expect(t.nam).toBeCloseTo(60537.86, 2);
    expect(t.buyNam).toBeCloseTo(29284.64, 2);
    expect(t.sellNam).toBeCloseTo(31253.22, 2);
    expect(t.usd).toBeCloseTo(53.91, 2);
    expect(t.unpriced).toBe(0);
    expect(t.traders).toBe(4);
    expect(t.more).toBe(false);
    const api = v(t.apiVolumeUsd);
    expect(api.value).toBeCloseTo(41.74, 2);
    expect(api.at).toBe(1792742304000);
    expect(!isNotRead(t.apiVolumeUsd) && t.apiVolumeUsd.stamp.source).toBe(SOURCES.osmosisApi);
  });

  it('bridge: Namada → Osmosis 1,454.20 (1 crossing), Osmosis → Namada 359,041.66 (5, largest 259,041.66), net +357,587.45 to Namada; the escrow fell by the same (matches)', () => {
    const b = v(fig.bridge);
    expect(b.toOsmosis).toEqual({ n: 1, nam: 1454.202387, largest: 1454.202387 });
    expect(b.toNamada).toEqual({ n: 5, nam: 359041.657201, largest: 259041.657201 });
    expect(b.refunded).toEqual({ n: 0, nam: 0 });
    expect(b.netToNamada).toBeCloseTo(357587.454814, 6);
    const e = v(b.escrow);
    expect(e.value).toBe(20832856.303644);
    expect(e.change.kind === 'ok' && e.change.delta).toBeCloseTo(-357587.454814, 6);
    expect(e.matches).toBe(true);
    expect(Math.abs(e.differsBy!)).toBeLessThan(1e-6);
  });

  it('shielded pool: in 100,003.00 (4 shielded IBC deposits, 2 shieldings), out 3.28 (4 unshieldings incl. 0.24 of fees), net +99,999.73; the balance rose by the same (matches)', () => {
    const m = v(fig.masp);
    expect(m.in.ibcIn).toEqual({ n: 4, nam: 100000 });
    expect(m.in.shield).toEqual({ n: 2, nam: 3 });
    expect(m.in.total).toBe(100003);
    expect(m.out.unshield).toEqual({ n: 4, nam: 3.0341 });
    expect(m.out.feesNam).toBeCloseTo(0.2409, 4);
    expect(m.out.total).toBeCloseTo(3.275, 4);
    expect(m.net).toBeCloseTo(99999.725, 3);
    const b = v(m.balance);
    expect(b.change.kind === 'ok' && b.change.delta).toBeCloseTo(99999.725, 3);
    expect(b.matches).toBe(true);
  });

  it('holders: Namada 64,825 (−1 vs 64,826 at 07:27 UTC yesterday, listing height 8,384,388 by 5ElementsNodes), Osmosis 1,313 (no change); the 10 largest hold 23.94 % of minted NAM and 49.07 % of the NAM on Osmosis; the 10 largest validators 53.15 % of stake (53.24 % yesterday)', () => {
    const h = v(fig.holders);
    const n = v(h.namada);
    expect(n.value).toBe(64825);
    expect(n.change.kind === 'ok' && n.change.delta).toBe(-1);
    expect(n.change.kind === 'ok' && new Date(n.change.base.ts).toISOString().slice(11, 16)).toBe('07:27');
    expect(n.listing).toEqual({ height: 8384388, provider: '5ElementsNodes' });
    const o = v(h.osmosis);
    expect(o.value).toBe(1313);
    expect(o.change.kind === 'ok' && o.change.delta).toBe(0);
    expect(o.notCurrent).toBeNull();
    const nt = v(h.namadaTop10);
    expect(nt.nam).toBe(274832001.624664);
    expect(pct2(nt.share)).toBe('23.94');
    expect(v(nt.denominator).value).toBe(1147916525.090649);
    expect(nt.yesterday).toBeNull();
    const ot = v(h.osmosisTop10);
    expect(ot.nam).toBe(10221302.566133);
    expect(pct2(ot.share)).toBe('49.07');
    expect(v(ot.denominator).value).toBe(20831242.303644);
    const s = v(h.stakeTop10Pct);
    expect(s.value.toFixed(2)).toBe('53.15');
    expect(s.change.kind === 'ok' && s.change.base.value.toFixed(2)).toBe('53.24');
  });

  it('governance: nothing opened, closed or ending in epochs 2,697–2,700; the newest of the 20 proposals read is #42, rejected', () => {
    const g = v(fig.governance);
    expect(g.opened).toEqual([]);
    expect(g.closed).toEqual([]);
    expect(g.ending).toEqual([]);
    expect(g.endingEpochs).toEqual([2697, 2700]);
    expect(g.proposals).toHaveLength(20);
    expect(g.proposals[0].id).toBe(42);
    expect(g.proposals[0].status).toBe('executedRejected');
    expect(g.proposals[0].link).toBe('https://namada.valopers.com/proposals/42');
    expect(g.pageOneOnly).toBe(true);
    expect(g.indexerEpoch).toBe(2698);
  });

  it('validators: 246 on both days, 0 joined, 0 left, 0 state changes; +442,107.00 NAM between the listings, gross 504,213.00; PathrockNetwork +100,000 (57 → 58 delegators) first of five', () => {
    const w = v(fig.validators);
    expect(w.day).toBe('2026-10-23');
    expect(w.baseDay).toBe('2026-10-22');
    expect(w.dayRow.validators).toBe(246);
    expect(w.baseRow.validators).toBe(246);
    expect(w.joined).toBe(0);
    expect(w.left).toBe(0);
    expect(w.stateChanges).toEqual([]);
    expect(w.stakeDelta).toBeCloseTo(442107.0, 2);
    expect(w.gross).toBe(504213);
    expect(w.moves).toHaveLength(5);
    expect(w.moves[0]).toMatchObject({ name: 'PathrockNetwork', delta: 100000, delegators: 58, delegatorsBefore: 57, state: 'consensus' });
    expect(w.moves.map((m) => m.name)).toEqual(['PathrockNetwork', 'Stake&Relax 🦥', 'MELLIFERA', 'OriginStake', 'StakeUp']);
    expect(w.noListingToday).toBe(false);
    expect(new Date(w.dayRow.as_of!).toISOString().slice(11, 16)).toBe('00:10');
    expect(new Date(w.baseRow.as_of!).toISOString().slice(11, 16)).toBe('00:27');
  });

  it('the anchors: epoch 2,696 at 07:59 UTC, both indexes current, the bond listing at height 8,384,271 and the balance listing at 8,384,388, minted NAM 1,147,916,525.09 (+79,762.80)', () => {
    const a = fig.anchors;
    expect(v(a.epochReading)).toEqual({ ts: 1792742342769, value: 2696 });
    expect(a.epoch.eNow).toBe(2696);
    expect(a.namada.cursor).toEqual({ height: 8388520, at: 1792770353357 });
    expect(a.namada.behind).toBe(false);
    expect(a.osmosis.streaming).toBe(true);
    expect(a.osmosis.sweep).toEqual({ height: 73054078, at: 1792770232662 });
    expect(a.bondListing).toMatchObject({ completeAt: 1792741122300, height: 8384271, provider: 'Papadritta', epoch: 2696, live: true });
    expect(a.balanceListing).toMatchObject({ completeAt: 1792741923099, height: 8384388, provider: '5ElementsNodes', live: true });
    expect(a.paramsLive).toBe(true);
    const m = v(a.mintedSupply);
    expect(m.value).toBe(1147916525.090649);
    expect(m.change.kind === 'ok' && m.change.delta).toBeCloseTo(79762.8, 2);
  });

  it('every figure carries a stamp with its source and time, and no figure is a NotRead', () => {
    for (const k of ['staked', 'requests', 'pipeline', 'rewards', 'price', 'trades', 'bridge', 'masp', 'holders', 'governance', 'validators'] as const) {
      const f = fig[k];
      expect(isNotRead(f), k).toBe(false);
      if (isNotRead(f)) continue;
      expect(typeof f.stamp.source, k).toBe('string');
      expect(Number.isFinite(f.stamp.at), k).toBe(true);
    }
  });
});

describe('the weekly window over the same answers (spec section 9)', () => {
  const fig = shapeDigestFigures(readsFromSurvey('weekly'), digestWindow(T, 'weekly'));

  it('total stake has no 7 d base: the series starts 18 Oct 04:00 UTC; the staking account has one (+5,920.03)', () => {
    const s = v(fig.staked);
    const ts = v(s.totalStake);
    expect(ts.change).toEqual({ kind: 'before-start', firstTs: 1792296002018 });
    expect(new Date(1792296002018).toISOString()).toBe('2026-10-18T04:00:02.018Z');
    const ac = v(s.account);
    expect(ac.change.kind === 'ok' && ac.change.delta).toBeCloseTo(5920.03, 2);
    expect(ac.change.kind === 'ok' && ac.change.base.ts).toBe(1792137567420);
  });

  it('price: −13.97 % over 7 d vs $0.00101543 at 07:59 UTC on 16 Oct; no 30 d base (series starts 15 Oct)', () => {
    const q = v(v(fig.price).quote);
    expect(q.change.kind === 'ok' && pct2(q.change.pct)).toBe('-13.97');
    expect(q.change.kind === 'ok' && q.change.base.value.toFixed(8)).toBe('0.00101543');
    expect(q.longChange).toEqual({ kind: 'before-start', firstTs: 1792037666692 });
  });

  it('holders, stake and the pipeline have no 7 d base yet: series start 20 Oct', () => {
    const h = v(fig.holders);
    expect(v(h.namada).change).toEqual({ kind: 'before-start', firstTs: 1792533242232 });
    expect(v(h.osmosis).change).toEqual({ kind: 'before-start', firstTs: 1792533002871 });
    expect(v(h.stakeTop10Pct).change).toEqual({ kind: 'before-start', firstTs: 1792532822267 });
    const p = v(fig.pipeline);
    expect('notComputed' in p.matured && p.matured.notComputed).toMatch(/no listing 7 d ago: series starts 2026-10-20T21:47:02/);
    expect('notComputed' in p.matured && p.matured.direct).toEqual({ nam: 0, n: 0 });
    expect(v(p.unlocking).epochs).toEqual([2697, 2724]);
  });

  it('the 7 d flows: 34 bonds of 713,451.43, 8 unbonds of 138,528.47 (largest 100,000), 61 claims of 69,931.03, 6 withdrawals of 1,195,782.11', () => {
    const r = v(fig.requests);
    expect([r.bonds.n, r.bonds.nam, r.unbonds.n, r.unbonds.nam, r.unbonds.largestNam]).toEqual([34, 713451.431704, 8, 138528.468491, 100000]);
    expect(v(fig.rewards)).toMatchObject({ n: 61, nam: 69931.033828, largest: 45730.920161 });
    expect(v(fig.pipeline).withdrawn).toMatchObject({ n: 6, nam: 1195782.110187, largest: 1170000 });
  });

  it('the window is the 7 × 24 h to T and the validator base day is seven days back', () => {
    expect(fig.from).toBe(T - 7 * D);
    expect(fig.to).toBe(T);
    expect(isNotRead(fig.validators) && fig.validators.reason).toMatch(/only one snapshot day exists/);
  });
});

describe('the reading rules on their own (spec section 5, freshness)', () => {
  it('a now reading past its bound is not read, with the last reading\'s time and no value', () => {
    const r = readNow('Namada RPC (total stake)', { ts: T - 11 * 60_000, value: 1 }, T, MINUTE_BOUND_MS);
    expect(r).toEqual({ notRead: true, source: 'Namada RPC (total stake)', lastAt: T - 11 * 60_000, reason: 'last answered 07:49 UTC, 11 min ago; the figure is not shown' });
    expect(readNow('x', null, T, MINUTE_BOUND_MS)).toMatchObject({ notRead: true, lastAt: null, reason: 'never answered; the figure is not shown' });
    expect(readNow('x', { ts: T - MINUTE_BOUND_MS, value: 2 }, T, MINUTE_BOUND_MS)).toMatchObject({ value: { ts: T - MINUTE_BOUND_MS, value: 2 }, stamp: { source: 'x', at: T - MINUTE_BOUND_MS, status: 'live' } });
  });

  it('a base is taken within 2 h of its instant; further back it names its time; none in the window is no change; before the series is "series starts"', () => {
    const now = { ts: T, value: 110 };
    expect(changeFrom(now, { ts: A24 - 60_000, value: 100 }, A24, MINUTE_BOUND_MS, undefined)).toEqual({ kind: 'ok', base: { ts: A24 - 60_000, value: 100 }, delta: 10, pct: 0.1, baseOff: false });
    expect(changeFrom(now, { ts: A24 - 90 * 60_000, value: 100 }, A24, MINUTE_BOUND_MS, undefined)).toMatchObject({ kind: 'ok', baseOff: true });
    expect(changeFrom(now, { ts: A24 - BASE_WINDOW_MS - 1, value: 100 }, A24, MINUTE_BOUND_MS, undefined)).toEqual({ kind: 'no-base', from: A24 - BASE_WINDOW_MS, to: A24, lastBefore: { ts: A24 - BASE_WINDOW_MS - 1, value: 100 } });
    expect(changeFrom(now, null, A24, MINUTE_BOUND_MS, 1792296002018)).toEqual({ kind: 'before-start', firstTs: 1792296002018 });
    expect(changeFrom(now, null, A24, MINUTE_BOUND_MS, undefined)).toEqual({ kind: 'before-start', firstTs: null });
    expect(changeFrom(now, { ts: A24, value: 0 }, A24, MINUTE_BOUND_MS, undefined)).toMatchObject({ kind: 'ok', pct: null });
  });
});

describe('the epoch clock (spec 5.3, settlement 8)', () => {
  const params = { unbondingLength: 53, pipelineLength: 2, cubicSlashingWindowLength: 1, minEpochSec: 21600, epochSec: 21617.16293333333, apr: null, fetchedAt: T - 3600_000 };
  const started = 1792726383586, before = { ts: 1792725806538, value: 2695 };

  it('E_end from the anchor: 03:33:03 + 24 h at 08:00 → +4; at 03:40 → +4; +5 from 09:34:30 (the spec\'s "at 09:32 → +5" is 2.5 min before that boundary); the clock of epoch 2,704 is 03:35:20 UTC on 25 Oct', () => {
    const at = (hhmmss: string) => Date.UTC(2026, 9, 23, Number(hhmmss.slice(0, 2)), Number(hhmmss.slice(3, 5)), Number(hhmmss.slice(6) || 0));
    expect(epochEnd(epochClock(at('08:00'), 2696, at('08:00'), started, before, params, true), D)).toBe(2700);
    expect(epochEnd(epochClock(at('03:40'), 2696, at('03:40'), started, before, params, true), D)).toBe(2700);
    // five epochs after 03:33:03.586 is 09:34:29.4 the next day: at 09:32 the span to T + 24 h still holds four whole epochs
    expect(epochEnd(epochClock(at('09:32'), 2696, at('09:32'), started, before, params, true), D)).toBe(2700);
    expect(epochEnd(epochClock(at('09:34:29'), 2696, at('09:34:29'), started, before, params, true), D)).toBe(2700);
    expect(epochEnd(epochClock(at('09:34:30'), 2696, at('09:34:30'), started, before, params, true), D)).toBe(2701);
    const c = epochClock(T, 2696, T, started, before, params, true);
    expect(new Date(epochClockAt(c, 2704)!).toISOString().slice(0, 19)).toBe('2026-10-25T03:35:20');
    expect(c.errorMs).toBe(started - before.ts);
    expect(c.approx).toBe(false);
  });

  it('without an anchor the fallback is e24 = round(86,400 / epochSec) = 4 epochs, "about", and no clock time', () => {
    for (const b of [null, { ts: started - 60_000, value: 2696 }]) {
      const c = epochClock(T, 2696, T, started, b, params, true);
      expect(c.approx).toBe(true);
      expect(c.startedAt).toBeNull();
      expect(epochEnd(c, D)).toBe(2700);
      expect(epochClockAt(c, 2704)).toBeNull();
    }
  });

  it('without live chain parameters there is no epoch length: epochs only, never a clock time', () => {
    const c = epochClock(T, 2696, T, started, before, { ...params, fetchedAt: T - 25 * 3600_000 }, false);
    expect(c.epochMs).toBeNull();
    expect(epochEnd(c, D)).toBeNull();
    expect(epochClockAt(c, 2704)).toBeNull();
    expect(epochClock(T, null, null, null, null, params, true).eNow).toBeNull();
  });
});

describe('a section whose statement failed', () => {
  it('is its own NotRead with "the database did not answer this read"; the other sections are read; the header part throws', () => {
    const reads = readsFromSurvey('daily');
    reads.vdDays = failed('no such table: validator_daily');
    reads.trades = failed('D1_ERROR');
    const fig = shapeDigestFigures(reads, digestWindow(T, 'daily'));
    expect(fig.validators).toEqual({ notRead: true, source: SOURCES.validatorDaily, lastAt: null, reason: 'the database did not answer this read' });
    expect(fig.trades).toMatchObject({ notRead: true, source: SOURCES.osmosisIndex, reason: 'the database did not answer this read' });
    expect(isNotRead(fig.staked)).toBe(false);
    expect(isNotRead(fig.bridge)).toBe(false);
    const broken = readsFromSurvey('daily');
    broken.anchors = failed('D1_ERROR');
    expect(() => shapeDigestFigures(broken, digestWindow(T, 'daily'))).toThrow(/kv anchors/);
  });
});

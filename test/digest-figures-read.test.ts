// Daily digest (2026-10-23), the reads: worker/src/digest/figures.ts, operator.ts and watchlists.ts run their statements
// on the SQLite stand-in with the real migrations. Seeded with the production rows the data map's survey captured in
// full for 2026-10-23 08:00 UTC (the metric instants, the epoch readings, the listings, the kv records, the queue rows,
// the six largest validator moves, the three 50,000 NAM bonds of block 8,374,275, the two unbonds, the withdrawal, the
// shielded-pool deposits and the Osmosis rows that mirror them), the statements give the figures those rows hold, run
// in three batch waves on their indexes, and each "not read" rule of spec section 5 answers as written. Ids, hashes and
// the heights the survey did not capture are fixture placeholders ('digest-test:…', 0) that no assertion reads; the
// watched and trading addresses are fixture-shaped, never a real wallet. Nothing is fetched and nothing is posted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { readDigestFigures, collectDigestReads, digestWindow, isNotRead, SOURCES, type DigestFigures, type Figure } from '../worker/src/digest/figures';
import { readOperatorFigures, healthEpisodes, isoWeek, dailyClaimKey, weeklyClaimKey, digestKeysAsked } from '../worker/src/digest/operator';
import { readWatchlists, admitWallets, DIGEST_WATCH_ADDRS_MAX, WATCH_CHUNK, WATCH_BATCH, WATCH_CAP_REASON, type WatchLine } from '../worker/src/digest/watchlists';
import { DB_NOT_ANSWERED, type NotRead } from '../worker/src/digest/types';
import { SQL, DIGEST_TRADES_MAX, MASP_ADDRESS } from '../worker/src/digest/sql';
import { BOND_LISTING_BOUND_MS, BALANCE_LISTING_BOUND_MS, EXECUTED_COMPARE_MS, CHECK_STALE_MS, GOV_LINK_MAX, HOLDER_FIGURES_BOUND_MS } from '../worker/src/digest/freshness';
import type { Prepared } from '../worker/src/digest/waves';
import { BOND_LISTING_MS, BALANCE_LISTING_MS, PRICE_CHECK_WINDOW_MS } from '../worker/src/cron';
import { CHECK_STALE_MS as API_CHECK_STALE_MS } from '../worker/src/api';
import { GOV_LINK_MAX as DISCORD_GOV_LINK_MAX } from '../worker/src/sources/discord';
import { HOLDER_FIGURES_SERVE_MS } from '../worker/src/holders';
import { NAMADA } from '../worker/src/config';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'digest', 'survey-2026-10-23.json'), 'utf8'));
const T = 1792742400000, A24 = 1792656000000, A7 = 1792137600000;
const H = 3600_000, D = 86_400_000;
const POS = NAMADA.internal.pos;
const MASP = MASP_ADDRESS;

const v = <T>(f: Figure<T>): T => { if (isNotRead(f)) throw new Error(`not read: ${f.source}: ${f.reason}`); return f.value; };
const nr = (f: Figure<unknown>): NotRead => { if (!isNotRead(f)) throw new Error('read'); return f; };

/** A fixture address of one chain, in the bech32 character set, never a real one. */
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn';
function fixtureAddress(chain: 'namada' | 'osmosis', i: number): string {
  let s = '';
  let n = i;
  do { s = ALPHABET[n % 20] + s; n = Math.floor(n / 20); } while (n > 0);
  const body = ('qwatch' + s).padEnd(chain === 'namada' ? 40 : 38, 'q');
  return (chain === 'namada' ? 'tnam1' : 'osmo1') + body;
}

/** Seeds the survey's rows. */
function seedSurvey(db: TestD1) {
  const metrics: { key: string; ts: number; value: number }[] = [];
  for (const [key, inst] of Object.entries<any>(fx.instants)) {
    for (const slot of ['now', '24h', '7d']) if (inst[slot]) metrics.push({ key, ts: inst[slot].ts, value: inst[slot].value });
    if (inst.at_1792731600000) metrics.push({ key, ts: 1792731600000, value: inst.at_1792731600000.value });
  }
  // the epoch readings the anchor needs: the first reading of each epoch and the last of the one before
  for (const e of fx.epochChanges) {
    metrics.push({ key: 'epoch', ts: e.first_ts, value: e.e });
    if (e.last_ts !== 1792742342769) metrics.push({ key: 'epoch', ts: e.last_ts, value: e.e });
  }
  insert(db, 'metrics', metrics);
  insert(db, 'listings', fx.listings);
  insert(db, 'kv', Object.entries<any>(fx.kv).map(([key, r]) => ({ key, value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value), updated_at: r.updated_at })));
  insert(db, 'unbond_queue', fx.queue.rows);
  insert(db, 'checks', fx.checks.map((c: any) => ({ ...c, title: c.key, detail: '{}' })));
  const day = fx.validators.days.find((d: any) => d.day === '2026-10-23'), yday = fx.validators.days.find((d: any) => d.day === '2026-10-22');
  insert(db, 'validator_daily', fx.validators.moves.flatMap((m: any) => [
    { day: '2026-10-23', validator: m.validator, stake: m.s_today, delegators: m.d_today, commission: null, state: m.state, name: m.name, as_of: day.as_of, height: day.height, names_at: day.names_at },
    { day: '2026-10-22', validator: m.validator, stake: m.s_yday, delegators: m.d_yday, commission: null, state: m.state, name: m.name, as_of: yday.as_of, height: yday.height, names_at: yday.names_at },
  ]));
  const flow = (id: string, chain: string, kind: string, ts: number, height: number, amount: number, extra: Record<string, unknown> = {}) =>
    ({ id: `digest-test:${id}`, chain, height, ts, tx_hash: `DIGESTTEST${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}`, kind, from_addr: null, to_addr: null, amount_num: amount, meta: null, ...extra });
  const bonds = fx.flows.largestBondsTop3.map((b: any, i: number) => flow(`bond:${i}`, 'namada', 'bond', b.ts, b.height, b.amount_num, { to_addr: POS, meta: JSON.stringify({ validator: b.validator, source: 'namada-rpc' }) }));
  const unbonds = [
    flow('unbond:0', 'namada', 'unbond', 1792701219137, 0, 25100, { from_addr: POS, meta: JSON.stringify({ validator: 'tnam1q87f9g34lagl5e6y482fwtad7870rk4vzsqaq7mf', source: 'namada-rpc' }) }),
    flow('unbond:1', 'namada', 'unbond', 1792714032064, 0, 5800, { from_addr: POS, meta: JSON.stringify({ validator: 'tnam1qy7fms2m4kpx5khvp4x7r3pr8e4xdqghpsrsd0pn', source: 'namada-rpc' }) }),
  ];
  const withdraw = flow('withdraw:0', 'namada', 'withdraw', 1792678774775, 0, 1170000, { from_addr: POS });
  const trade = flow('trade:0', 'osmosis', 'sell', fx.flows.trustedLast[0].ts, 0, fx.flows.trustedLast[0].amount_num, {
    from_addr: fixtureAddress('osmosis', 7), counter_denom: 'USDC', counter_amount: fx.flows.trustedLast[0].counter_amount, pool_id: '3005', value_usd: null,
  });
  const masp = fx.flows.maspRows.map((r: any, i: number) => flow(`masp:${i}`, r.chain, r.kind, r.ts, r.height, r.amount_num, { to_addr: MASP, meta: r.seq ? JSON.stringify({ packetSequence: r.seq, channel: r.channel }) : null }));
  insert(db, 'flows', [...bonds, ...unbonds, withdraw, trade, ...masp]);
}

const plan = (db: TestD1, s: Prepared) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params) as { detail: string }[]).map((p) => p.detail).join(' | ');

describe('readDigestFigures on the survey\'s rows', () => {
  const db = testD1();
  seedSurvey(db);
  const log: Prepared[] = [];
  let fig: DigestFigures;
  it('runs three batch waves of bound statements and reads the header rows', async () => {
    const queriesBefore = db.queries;
    fig = await readDigestFigures(db, T, 'daily', log);
    // about 66: the kv anchors, 31 one-row metric instants, 16 window reads, then the dependent instants and the queue
    expect(log.length).toBeGreaterThan(30);
    expect(log.length).toBeLessThan(80);
    expect(db.queries - queriesBefore).toBe(log.length);
    for (const s of log) expect(s.sql, s.sql.slice(0, 60)).not.toMatch(/179[0-9]{10}|tnam1q[0-9a-z]{30}|osmo1[0-9a-z]{30}/);
    expect(fig.kind).toBe('daily');
    expect(fig.from).toBe(A24);
    expect(fig.to).toBe(T);
  });

  it('the metrics-backed figures are the worked example\'s: total stake +467,207.00, price +3.31 %, escrow and pool balances, holders, the stake top-10 share', () => {
    const s = v(fig.staked);
    const ts = v(s.totalStake);
    expect(ts.value).toBe(267774764.266631);
    expect(ts.change.kind === 'ok' && ts.change.delta).toBeCloseTo(467207.0, 2);
    expect(s.onItsWayOutOrUnclaimed).toBeCloseTo(74018952.09, 2);
    expect(v(s.stakers).value).toBe(19340);
    const q = v(v(fig.price).quote);
    expect(q.change.kind === 'ok' && (q.change.pct! * 100).toFixed(2)).toBe('3.31');
    const e = v(v(fig.price).executed);
    expect(e.status).toBe('compared');
    expect((e.comparison!.pct * 100).toFixed(2)).toBe('-4.68');
    expect(e.last?.n).toBe(1);
    const h = v(fig.holders);
    expect(v(h.namada).value).toBe(64825);
    expect(v(h.namada).listing).toEqual({ height: 8384388, provider: '5ElementsNodes' });
    expect((v(h.namadaTop10).share! * 100).toFixed(2)).toBe('23.94');
    expect((v(h.osmosisTop10).share! * 100).toFixed(2)).toBe('49.07');
    expect(v(h.stakeTop10Pct).value.toFixed(2)).toBe('53.15');
    expect(v(fig.anchors.mintedSupply).change.kind === 'ok').toBe(true);
  });

  it('the epoch clock is anchored on the first reading of epoch 2,696 (03:33:03 UTC, ± 10 min); the pipeline\'s next unlock is 37,489.27 NAM at epoch 2,704 about 03:35 UTC on 25 Oct', () => {
    expect(fig.anchors.epoch.eNow).toBe(2696);
    expect(new Date(fig.anchors.epoch.startedAt!).toISOString()).toBe('2026-10-23T03:33:03.586Z');
    expect(Math.round(fig.anchors.epoch.errorMs! / 60_000)).toBe(10);
    const p = v(fig.pipeline);
    expect(p.inFlight).toBe(181962.018281);
    expect(p.withdrawable).toBe(36859599.847648);
    expect(p.withdrawableEpochs).toEqual([2688, 2696]);
    expect(p.listing).toEqual({ at: 1792741122300, height: 8384271, provider: 'Papadritta', epoch: 2696 });
    expect('notComputed' in p.matured).toBe(false);
    if ('notComputed' in p.matured) return;
    expect(p.matured.nam).toBeCloseTo(0, 2);
    expect(p.matured.epochs).toEqual([2693, 2696]);
    expect(p.matured.withdrawnBetween).toEqual({ nam: 1170000, n: 1 });
    expect(p.matured.direct).toEqual({ nam: 0, n: 0 });
    expect(p.withdrawn).toMatchObject({ n: 1, nam: 1170000 });
    const u = v(p.unlocking);
    expect(u.epochs).toEqual([2697, 2700]);
    expect(u.buckets).toEqual([]);
    expect(u.next).toMatchObject({ epoch: 2704, nam: 37489.267473, n: 2, epochsAway: 8 });
    expect(new Date(u.next!.at!).toISOString().slice(0, 16)).toBe('2026-10-25T03:35');
  });

  it('with no bond listing near the base instant, the epoch then still bounds what matured: the queue\'s own sum over those epochs, withdrawals since not counted', async () => {
    const db = testD1();
    seedSurvey(db);
    db.exec(`DELETE FROM metrics WHERE key = 'stake.withdrawable_nam' AND ts <= ${A24}`);
    insert(db, 'metrics', [{ key: 'epoch', ts: A24 - 60_000, value: 2692 }]);
    const p = v((await readDigestFigures(db, T, 'daily')).pipeline);
    if (!('notComputed' in p.matured)) throw new Error('a base listing was found');
    expect(p.matured.epochs).toEqual([2693, 2696]);
    const want = (fx.queue.rows as { withdraw_epoch: number; nam: number; n: number }[]).filter((q) => q.withdraw_epoch > 2692 && q.withdraw_epoch <= 2696);
    expect(p.matured.direct).toEqual({ nam: want.reduce((a, q) => a + q.nam, 0), n: want.reduce((a, q) => a + q.n, 0) });
    // an epoch reading older than its bound at the base instant gives no range and no sum
    db.exec(`DELETE FROM metrics WHERE key = 'epoch' AND ts > ${A24 - 20 * 60_000} AND ts <= ${A24}`);
    const q = v((await readDigestFigures(db, T, 'daily')).pipeline);
    if (!('notComputed' in q.matured)) throw new Error('a base listing was found');
    expect(q.matured.epochs).toBeNull();
    expect(q.matured.direct).toBeNull();
  });

  it('the flows statements count the seeded rows: three 50,000 NAM bonds (a tie of three to three validators, the earliest linked), the two unbonds, the withdrawal, one trusted trade', () => {
    const r = v(fig.requests);
    expect(r.bonds).toMatchObject({ n: 3, nam: 150000, largestNam: 50000 });
    // three rows of the same amount at the same time: the row order (id) breaks the tie, so the link is the same on every read
    expect(r.bonds.largest).toMatchObject({ amount: 50000, ts: 1792672521237, height: 8374275, ties: 3, validators: 3, validator: 'tnam1qx405kgvey8wwfcyt7rgsr4nvkrqsnztxs2kz7wv' });
    expect(r.bonds.largest!.explorerHash).toBe('DIGESTTESTBOND0');
    expect(r.unbonds).toMatchObject({ n: 2, nam: 30900, largestNam: 25100 });
    expect(r.unbonds.largest).toMatchObject({ amount: 25100, ts: 1792701219137, ties: 1 });
    expect(v(fig.rewards)).toMatchObject({ n: 0, nam: 0, largest: null });
    const t = v(fig.trades);
    expect(t).toMatchObject({ n: 1, nam: 9970.02, traders: 1, sellNam: 9970.02, buyNam: 0, unpriced: 1, usd: null, more: false });
    expect(v(t.apiVolumeUsd).value).toBeCloseTo(41.74, 2);
  });

  it('the shielded pool counts the four deposits and two shieldings once (100,003 NAM): the Osmosis rows whose receiver is the MASP address are left out by the chain filter and counted by the bridge instead', () => {
    const m = v(fig.masp);
    expect(m.in).toEqual({ shield: { n: 2, nam: 3 }, ibcIn: { n: 4, nam: 100000 }, total: 100003 });
    expect(m.out.total).toBe(0);
    const b = v(fig.bridge);
    expect(b.toNamada).toEqual({ n: 4, nam: 100000, largest: 31000 });
    expect(b.toOsmosis).toEqual({ n: 0, nam: 0, largest: null });
    expect(b.refunded).toEqual({ n: 0, nam: 0 });
    expect(SQL.maspIn).toMatch(/f\.chain = 'namada'/);
    expect(SQL.maspOut).toMatch(/f\.chain = 'namada'/);
    expect(SQL.maspOtherCoinFees).toMatch(/f\.chain = 'namada'/);
    // the same rows without the guard would double count: the data map's caution
    const unguarded = db.raw.prepare(`SELECT SUM(amount_num) s FROM flows WHERE to_addr = ? AND kind IN ('ibc_in','ibc_out') AND ts >= ? AND ts < ?`).get(MASP, A24, T) as { s: number };
    expect(unguarded.s).toBe(200000);
  });

  it('the validator diff over the six seeded movers: PathrockNetwork +100,000 first of five, gross 350,000, none joined or left, no state change, listing to listing 00:27 → 00:10', () => {
    const w = v(fig.validators);
    expect([w.day, w.baseDay]).toEqual(['2026-10-23', '2026-10-22']);
    expect(w.dayRow.validators).toBe(6);
    expect(w.moves[0]).toMatchObject({ name: 'PathrockNetwork', delta: 100000, delegators: 58, delegatorsBefore: 57 });
    expect(w.moves).toHaveLength(5);
    expect(w.gross).toBe(350000);
    expect([w.joined, w.left, w.stateChanges]).toEqual([0, 0, []]);
    expect(w.stakeDelta).toBeCloseTo(350000, 2);
  });

  it('governance: the 20 cached proposals, no claim in the window, nothing ending in 2,697–2,700', () => {
    const g = v(fig.governance);
    expect(g.proposals).toHaveLength(20);
    expect(g.proposals[0]).toMatchObject({ id: 42, status: 'executedRejected' });
    expect(g.opened).toEqual([]);
    expect(g.endingEpochs).toEqual([2697, 2700]);
  });

  it('every statement runs on its index: the metrics key, flows_kind / flows_to / flows_from, the queue\'s and the listings\' rowid, kv\'s key or kv_alert_claim_time; only validator_daily is scanned', () => {
    for (const s of log) {
      const p = plan(db, s);
      const sql = s.sql.replace(/\s+/g, ' ');
      expect(p, sql.slice(0, 100)).not.toMatch(/SCAN flows|INDEX flows_ts|SCAN metrics|SCAN kv\b|SCAN holders|SCAN unbond_queue|SCAN listings/);
      if (/FROM validator_daily|validator_daily a/.test(sql)) continue;
      expect(p, sql.slice(0, 100)).toMatch(/sqlite_autoindex_metrics_1|flows_kind|flows_to|flows_from|INTEGER PRIMARY KEY|sqlite_autoindex_kv_1|kv_alert_claim_time|SEARCH unbond_queue/);
    }
    const claims = log.find((s) => s.sql.includes("key LIKE 'alert:gov:prop:%'"))!;
    expect(claims.sql).toMatch(/INDEXED BY kv_alert_claim_time/);
    expect(claims.sql).toMatch(/key >= 'alert:' AND key < 'alert;'/);
    expect(plan(db, claims)).toMatch(/kv_alert_claim_time/);
    const anchor = log.find((s) => s.sql.includes('started'))!;
    expect(anchor.sql).toMatch(/ts > \? AND ts <= \?/);
    expect(anchor.params[0]).toBe(T - 2 * 21617.16293333333 * 1000);
    const trades = log.find((s) => s.sql.includes('traders'))!;
    expect(trades.sql).toMatch(new RegExp(`LIMIT ${DIGEST_TRADES_MAX + 1}`));
  });

  it('the weekly variant reads the 7 d instants, the 7 × 24 h flows window and the base day seven days back, and says where a series starts', async () => {
    const wlog: Prepared[] = [];
    const w = await readDigestFigures(db, T, 'weekly', wlog);
    expect(w.from).toBe(A7);
    expect(wlog.some((s) => s.params[0] === 'supply.total_stake' && s.params[1] === A7)).toBe(true);
    expect(wlog.some((s) => s.sql === SQL.firstTs && s.params[0] === 'supply.total_stake')).toBe(true);
    // the seeded series' first row (the real series starts 2026-10-18T04:00Z; the survey's rows begin at the 24 h base)
    expect(v(v(w.staked).totalStake).change).toEqual({ kind: 'before-start', firstTs: 1792655942278 });
    expect(wlog.find((s) => s.sql.includes('FROM validator_daily WHERE day IN'))!.params).toEqual(['2026-10-23', '2026-10-16']);
    // no snapshot seven days back: the oldest day present is the base, and the figure says so
    expect(v(w.validators)).toMatchObject({ day: '2026-10-23', baseDay: '2026-10-22', baseIsOldest: true, noListingToday: false });
    expect(wlog.some((s) => s.sql === SQL.vdOldestDay)).toBe(true);
    const q = v(v(w.price).quote);
    expect(q.change.kind === 'ok' && (q.change.pct! * 100).toFixed(2)).toBe('-13.97');
    // the 30 d base: before the seeded series' first row (the 7 d reading; the real series starts 2026-10-15T04:14Z)
    expect(q.longChange).toEqual({ kind: 'before-start', firstTs: 1792137567420 });
    expect(wlog.find((s) => s.params[0] === 'dex.volume_7d_usd_osmosis')).toBeTruthy();
  });
});

describe('every "not read" rule (spec section 5): no value, the last reading\'s time, the reason', () => {
  const fresh = () => { const db = testD1(); seedSurvey(db); return db; };

  it('a now reading past its bound: total stake read 11 min before T → not read with the last time, the figure not shown', async () => {
    const db = fresh();
    db.exec(`UPDATE metrics SET ts = ${T - 11 * 60_000} WHERE key = 'supply.total_stake' AND ts = 1792742342769`);
    const fig = await readDigestFigures(db, T, 'daily');
    const s = v(fig.staked);
    expect(s.totalStake).toEqual({ notRead: true, source: SOURCES.totalStake, lastAt: T - 11 * 60_000, reason: 'last answered 07:49 UTC, 11 min ago; the figure is not shown' });
    expect(s.onItsWayOutOrUnclaimed).toBeNull();
    expect(isNotRead(s.account)).toBe(false);
  });

  it('a missing base: the 24 h reading 3 h before its instant → no change, with the empty window named', async () => {
    const db = fresh();
    db.exec(`UPDATE metrics SET ts = ${A24 - 3 * H} WHERE key = 'supply.total_stake' AND ts = 1792655942278`);
    const fig = await readDigestFigures(db, T, 'daily');
    expect(v(v(fig.staked).totalStake).change).toEqual({ kind: 'no-base', from: A24 - 2 * H, to: A24, lastBefore: { ts: A24 - 3 * H, value: 267307557.266631 } });
  });

  it('a base before the series starts: no reading at or before 24 h ago → "series starts" with the first row, read only then', async () => {
    const db = fresh();
    db.exec(`DELETE FROM metrics WHERE key = 'supply.total_stake' AND ts <= ${A24}`);
    db.exec(`INSERT INTO metrics (key, ts, value) VALUES ('supply.total_stake', ${A24 + H}, 267300000)`);
    const log: Prepared[] = [];
    const fig = await readDigestFigures(db, T, 'daily', log);
    expect(v(v(fig.staked).totalStake).change).toEqual({ kind: 'before-start', firstTs: A24 + H });
    expect(log.filter((s) => s.sql === SQL.firstTs).map((s) => s.params[0])).toEqual(['supply.total_stake', 'holders.namada.top10_nam', 'holders.osmosis.top10_nam']);
  });

  it('the Namada cursor older than 3 min or 30 blocks behind the head → the flow lines are partial windows, counted to the cursor\'s time, never not read', async () => {
    const db = fresh();
    db.exec(`UPDATE kv SET updated_at = ${T - 4 * 60_000} WHERE key = 'namada.cursor'`);
    const fig = await readDigestFigures(db, T, 'daily');
    expect(fig.anchors.namada.behind).toBe(true);
    expect(fig.anchors.namada.partial).toEqual({ countedTo: T - 4 * 60_000, height: 8388520 });
    expect(v(fig.requests).partial).toEqual({ countedTo: T - 4 * 60_000, height: 8388520 });
    expect(v(fig.masp).partial).toEqual({ countedTo: T - 4 * 60_000, height: 8388520 });
    expect(v(fig.requests).bonds.n).toBe(3);
    const db2 = fresh();
    db2.exec(`UPDATE kv SET updated_at = ${T - 60_000}, value = '8388400' WHERE key = 'namada.cursor'`);
    db2.exec(`UPDATE kv SET value = '{"height":8388513,"at":${T - 60_000}}' WHERE key = 'namada.head'`);
    const f2 = await readDigestFigures(db2, T, 'daily');
    expect(f2.anchors.namada.lag).toBe(113);
    expect(f2.anchors.namada.behind).toBe(true);
  });

  it('the Osmosis stream down and the sweep older than 15 min → the Osmosis lines are partial windows to the sweep\'s time; a live sweep is not', async () => {
    const db = fresh();
    db.exec(`UPDATE kv SET value = '{"connected":false,"height":73054078}', updated_at = ${T - 10 * 60_000} WHERE key = 'osmosis.live'`);
    db.exec(`UPDATE kv SET value = '{"height":73054000,"at":${T - 20 * 60_000}}' WHERE key = 'osmosis.cursor'`);
    const fig = await readDigestFigures(db, T, 'daily');
    expect(fig.anchors.osmosis.streaming).toBe(false);
    expect(fig.anchors.osmosis.partial).toEqual({ countedTo: T - 20 * 60_000, height: 73054000 });
    expect(v(fig.trades).partial).toEqual({ countedTo: T - 20 * 60_000, height: 73054000 });
    expect(v(fig.bridge).partial).toEqual({ countedTo: T - 20 * 60_000, height: 73054000 });
    db.exec(`UPDATE kv SET value = '{"height":73054000,"at":${T - 5 * 60_000}}' WHERE key = 'osmosis.cursor'`);
    const f2 = await readDigestFigures(db, T, 'daily');
    expect(f2.anchors.osmosis.partial).toBeNull();
    expect(f2.anchors.osmosis.stamp).toMatchObject({ at: T - 5 * 60_000, height: 73054000, status: 'live' });
  });

  it('a section whose statement fails (validator_daily dropped): that section is "not read — the database did not answer this read"; every other section is read', async () => {
    const db = fresh();
    db.exec('DROP TABLE validator_daily');
    const fig = await readDigestFigures(db, T, 'daily');
    expect(fig.validators).toEqual({ notRead: true, source: SOURCES.validatorDaily, lastAt: null, reason: DB_NOT_ANSWERED });
    for (const k of ['staked', 'requests', 'pipeline', 'rewards', 'price', 'trades', 'bridge', 'masp', 'holders', 'governance'] as const) expect(isNotRead(fig[k]), k).toBe(false);
  });

  it('the header part failing (the metrics table gone) throws, so nothing is built this tick', async () => {
    const db = fresh();
    db.exec('DROP TABLE metrics');
    await expect(readDigestFigures(db, T, 'daily')).rejects.toThrow(/epoch could not be read/);
    const db2 = fresh();
    db2.exec('DROP TABLE kv');
    await expect(readDigestFigures(db2, T, 'daily')).rejects.toThrow(/kv anchors could not be read/);
  });

  it('holders.figures older than 2 h → no top-10 share (the counts stay)', async () => {
    const db = fresh();
    const hf = { ...fx.kv['holders.figures'].value };
    hf.namada = { ...hf.namada, top10: { s: hf.namada.top10.s, at: T - HOLDER_FIGURES_BOUND_MS - 60_000 } };
    db.exec(`UPDATE kv SET value = '${JSON.stringify(hf)}' WHERE key = 'holders.figures'`);
    const h = v((await readDigestFigures(db, T, 'daily')).holders);
    expect(nr(h.namadaTop10)).toMatchObject({ source: SOURCES.holderIndex, lastAt: T - HOLDER_FIGURES_BOUND_MS - 60_000, reason: 'last answered 05:59 UTC, 2 h 1 min ago; the figure is not shown' });
    expect(isNotRead(h.osmosisTop10)).toBe(false);
    expect(v(h.namada).value).toBe(64825);
  });

  it('intel.cache older than 30 min, or the indexer health row not ok → "Governance: not read since HH:MM UTC"', async () => {
    const db = fresh();
    const cache = { ...fx.kv['intel.cache'].value, fetchedAt: T - 31 * 60_000 };
    db.exec(`UPDATE kv SET value = '${JSON.stringify(cache).replace(/'/g, "''")}' WHERE key = 'intel.cache'`);
    expect(nr((await readDigestFigures(db, T, 'daily')).governance)).toEqual({ notRead: true, source: SOURCES.proposals, lastAt: T - 31 * 60_000, reason: 'not read since 07:29 UTC' });
    const db2 = fresh();
    const health = { ...fx.kv['source.health'].value, 'Namada indexer (indexer.namada.net)': { ok: false, at: T - 60_000, note: 'HTTP 503' } };
    db2.exec(`UPDATE kv SET value = '${JSON.stringify(health).replace(/'/g, "''")}' WHERE key = 'source.health'`);
    expect(nr((await readDigestFigures(db2, T, 'daily')).governance).reason).toBe('not read since 15:41 UTC (HTTP 503)');
  });

  it('chain.params missing → epochs only: no span in time, the next bucket named by epochs away with no clock time; governance has no ending window', async () => {
    const db = fresh();
    db.exec("DELETE FROM kv WHERE key = 'chain.params'");
    const fig = await readDigestFigures(db, T, 'daily');
    expect(fig.anchors.paramsLive).toBe(false);
    const u = v(v(fig.pipeline).unlocking);
    expect(u.epochs).toBeNull();
    expect(u.approx).toBe(true);
    expect(u.next).toEqual({ epoch: 2704, nam: 37489.267473, n: 2, at: null, epochsAway: 8 });
    expect(v(fig.governance).endingEpochs).toBeNull();
    const stale = fresh();
    stale.exec(`UPDATE kv SET value = '${JSON.stringify({ ...fx.kv['chain.params'].value, fetchedAt: T - 25 * H })}' WHERE key = 'chain.params'`);
    expect(v(v((await readDigestFigures(stale, T, 'daily')).pipeline).unlocking).epochs).toBeNull();
  });

  it('the epoch anchor not readable (no earlier epoch\'s reading in the range) → e24 = 4 epochs, "about", no clock time', async () => {
    const db = fresh();
    db.exec(`DELETE FROM metrics WHERE key = 'epoch' AND ts < ${T - H}`);
    const fig = await readDigestFigures(db, T, 'daily');
    expect(fig.anchors.epoch.approx).toBe(true);
    expect(fig.anchors.epoch.startedAt).toBeNull();
    const u = v(v(fig.pipeline).unlocking);
    expect(u.epochs).toEqual([2697, 2700]);
    expect(u.approx).toBe(true);
    expect(u.next).toMatchObject({ epoch: 2704, at: null, epochsAway: 8 });
  });

  it('the bond listing past 2 h, or failed since its last pass → no pipeline figure at all, "not read since <completeAt>"', async () => {
    const db = fresh();
    db.exec(`UPDATE kv SET value = '${JSON.stringify({ ...fx.kv['bond.listing'].value, completeAt: T - BOND_LISTING_BOUND_MS - 60_000 })}' WHERE key = 'bond.listing'`);
    expect(nr((await readDigestFigures(db, T, 'daily')).pipeline)).toEqual({ notRead: true, source: SOURCES.bondListing, lastAt: T - BOND_LISTING_BOUND_MS - 60_000, reason: 'not read since 05:59 UTC' });
    const db2 = fresh();
    db2.exec(`UPDATE kv SET value = '${JSON.stringify({ ...fx.kv['bond.listing'].value, failedAt: T - 60_000, error: 'both nodes timed out' })}' WHERE key = 'bond.listing'`);
    expect(nr((await readDigestFigures(db2, T, 'daily')).pipeline).reason).toBe('not read since 07:38 UTC (both nodes timed out)');
  });

  it('the balance listing failed since its last pass → Namada holders not read (the old count is not printed); a stale count likewise', async () => {
    const db = fresh();
    db.exec(`UPDATE kv SET value = '${JSON.stringify({ ...fx.kv['balance.listing'].value, failedAt: T - 60_000, error: 'Too large' })}' WHERE key = 'balance.listing'`);
    const h = v((await readDigestFigures(db, T, 'daily')).holders);
    expect(nr(h.namada)).toEqual({ notRead: true, source: SOURCES.balanceListing, lastAt: 1792741923099, reason: 'the balance listing last completed 07:52 UTC (Too large)' });
    const db2 = fresh();
    db2.exec(`UPDATE metrics SET ts = ${T - BALANCE_LISTING_BOUND_MS - 60_000} WHERE key = 'holders.namada' AND ts = 1792741923099`);
    expect(nr(v((await readDigestFigures(db2, T, 'daily')).holders).namada).reason).toMatch(/^last answered 04:59 UTC, 3 h 1 min ago/);
  });

  it('the Osmosis holder pass trusted more than 6 h ago → the count is "not current" with that pass\'s start', async () => {
    const db = fresh();
    db.exec(`UPDATE kv SET value = '${JSON.stringify({ ...fx.kv['osmosis.holders.pass'].value, trustedStartedAt: T - 7 * H })}' WHERE key = 'osmosis.holders.pass'`);
    expect(v(v((await readDigestFigures(db, T, 'daily')).holders).osmosis).notCurrent).toEqual({ trustedStartedAt: T - 7 * H });
  });

  it('the executed price: an hour older than 6 h is shown without a comparison; older than 24 h says none in 24 h; no quote means no comparison', async () => {
    const db = fresh();
    db.exec(`UPDATE metrics SET ts = ${T - EXECUTED_COMPARE_MS - H} WHERE key IN ('price.swap_1h', 'price.swap_1h.n') AND ts = 1792731600000`);
    let e = v(v((await readDigestFigures(db, T, 'daily')).price).executed);
    expect(e.status).toBe('no-comparison');
    expect(e.comparison).toBeNull();
    expect(e.last?.hourStart).toBe(T - EXECUTED_COMPARE_MS - H);
    db.exec(`UPDATE metrics SET ts = ${T - 25 * H} WHERE key IN ('price.swap_1h', 'price.swap_1h.n') AND ts = ${T - EXECUTED_COMPARE_MS - H}`);
    e = v(v((await readDigestFigures(db, T, 'daily')).price).executed);
    expect(e.status).toBe('none-in-24h');
    const db2 = fresh();
    db2.exec(`UPDATE metrics SET ts = ${T - 11 * 60_000} WHERE key = 'price.usd' AND ts = 1792742342769`);
    const p = v((await readDigestFigures(db2, T, 'daily')).price);
    expect(nr(p.quote)).toMatchObject({ source: SOURCES.quote, reason: 'last answered 07:49 UTC, 11 min ago; the figure is not shown' });
    expect(v(p.executed)).toMatchObject({ status: 'no-comparison', comparison: null, last: { hourStart: 1792731600000, n: 1 } });
  });

  it('more than 20,000 trades in the window → the newest DIGEST_TRADES_MAX + 1 are read and the figure says there were more', async () => {
    const db = fresh();
    const trader = fixtureAddress('osmosis', 3);
    const stmt = db.raw.prepare("INSERT INTO flows (id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta) VALUES (?, 'osmosis', 0, ?, ?, 'buy', NULL, ?, 100, NULL)");
    db.raw.exec('BEGIN');
    for (let i = 0; i < DIGEST_TRADES_MAX + 10; i++) stmt.run(`digest-test:many:${i}`, A24 + 1000 + i, `MANY${i}`, trader);
    db.raw.exec('COMMIT');
    const t = v((await readDigestFigures(db, T, 'daily')).trades);
    expect(t.n).toBe(DIGEST_TRADES_MAX + 1);
    expect(t.more).toBe(true);
    expect(t.traders).toBe(2);
  });

  it('a refunded Osmosis → Namada send in the window is left out of the bridge figure and counted as refunded', async () => {
    const db = fresh();
    const sender = fixtureAddress('osmosis', 11);
    insert(db, 'flows', [
      { id: 'digest-test:send:1', chain: 'osmosis', height: 0, ts: A24 + 2 * H, tx_hash: 'DIGESTTESTSEND1', kind: 'ibc_out', from_addr: sender, to_addr: null, amount_num: 5000, meta: JSON.stringify({ packetSequence: '9001' }) },
      { id: 'digest-test:refund:1', chain: 'osmosis', height: 0, ts: A24 + 3 * H, tx_hash: 'DIGESTTESTREFUND1', kind: 'other', from_addr: null, to_addr: sender, amount_num: 5000, meta: JSON.stringify({ ibcTimeoutRefund: true, packetSequence: '9001' }) },
    ]);
    const b = v((await readDigestFigures(db, T, 'daily')).bridge);
    expect(b.refunded).toEqual({ n: 1, nam: 5000 });
    expect(b.toNamada).toEqual({ n: 4, nam: 100000, largest: 31000 });
  });

  it('a governance claim in the window names the proposal opened or closed; a proposal voting until an epoch within the window is "ending", with the clock', async () => {
    const db = fresh();
    const cache = { ...fx.kv['intel.cache'].value, fetchedAt: T - 60_000, proposals: [{ id: 43, status: 'voting', type: 'default', startEpoch: 2690, endEpoch: 2699, title: 'A vote', discussionsUrl: 'https://forum.namada.net/t/a-vote/1' }, ...fx.kv['intel.cache'].value.proposals] };
    db.exec(`UPDATE kv SET value = '${JSON.stringify(cache).replace(/'/g, "''")}' WHERE key = 'intel.cache'`);
    insert(db, 'kv', [{ key: 'alert:gov:prop:43:voting', value: '1', updated_at: A24 + 5 * H }, { key: 'alert:gov:prop:42:executedRejected', value: '1', updated_at: A24 - H }]);
    const g = v((await readDigestFigures(db, T, 'daily')).governance);
    expect(g.opened).toEqual([{ id: 43, status: 'voting', at: A24 + 5 * H, proposal: expect.objectContaining({ id: 43, link: 'https://forum.namada.net/t/a-vote/1' }) }]);
    expect(g.closed).toEqual([]);
    expect(g.ending).toHaveLength(1);
    expect(g.ending[0]).toMatchObject({ id: 43, endEpoch: 2699, epochsAway: 3 });
    expect(new Date(g.ending[0].at!).toISOString().slice(0, 16)).toBe('2026-10-23T21:33');
    expect(g.pageOneOnly).toBe(true);
  });

  it('no validator rows for today → the two newest days are compared and the figure says no listing landed today', async () => {
    const db = fresh();
    db.exec("UPDATE validator_daily SET day = '2026-10-21' WHERE day = '2026-10-22'");
    db.exec("UPDATE validator_daily SET day = '2026-10-22' WHERE day = '2026-10-23'");
    const w = v((await readDigestFigures(db, T, 'daily')).validators);
    expect([w.day, w.baseDay, w.noListingToday]).toEqual(['2026-10-22', '2026-10-21', true]);
    expect(w.moves[0].delta).toBe(100000);
  });
});

describe('the bounds reused from the code stay in step with it', () => {
  it('bond and balance listing bounds are three listings, the executed-price window and the check staleness are the cron\'s and the API\'s, the holder figures\' and the link cap the modules\' own', () => {
    expect(BOND_LISTING_BOUND_MS).toBe(3 * BOND_LISTING_MS);
    expect(BALANCE_LISTING_BOUND_MS).toBe(3 * BALANCE_LISTING_MS);
    expect(EXECUTED_COMPARE_MS).toBe(PRICE_CHECK_WINDOW_MS);
    expect(CHECK_STALE_MS).toBe(API_CHECK_STALE_MS);
    expect(GOV_LINK_MAX).toBe(DISCORD_GOV_LINK_MAX);
    expect(HOLDER_FIGURES_BOUND_MS).toBe(HOLDER_FIGURES_SERVE_MS);
  });
});

describe('readWatchlists: one bounded pass over every wallet\'s addresses (spec 5.11)', () => {
  const W = (chain: 'namada' | 'osmosis', i: number) => fixtureAddress(chain, i);

  it('gives the four line shapes: changed, unchanged, base not known, not listed; the confirmation time is the row\'s or the listing\'s', async () => {
    const db = testD1();
    seedSurvey(db);
    const changed = W('namada', 1), same = W('namada', 2), noBase = W('namada', 3), unlisted = W('namada', 4), osmo = W('osmosis', 5);
    insert(db, 'holders', [
      { chain: 'namada', address: changed, balance: '1250000000000', balance_num: 1250000, updated_at: T - 5 * H, verified_at: T - 5 * H, verified_src: 'abci_prefix_listing' },
      { chain: 'namada', address: same, balance: '2100000000', balance_num: 2100, updated_at: T - 5 * H, verified_at: T - 5 * H, verified_src: 'abci' },
      { chain: 'namada', address: noBase, balance: '500000000', balance_num: 500, updated_at: T - H, verified_at: T - H, verified_src: 'abci' },
      { chain: 'osmosis', address: osmo, balance: '2100000000', balance_num: 2100, updated_at: T - 10 * 60_000, verified_at: T - 10 * 60_000, verified_src: 'keplr' },
    ]);
    insert(db, 'balance_spans', [
      { chain: 'namada', address: changed, from_ts: A7 - D, to_ts: A24 + 3 * H, balance: '1262500000000', balance_num: 1262500 },
      { chain: 'namada', address: changed, from_ts: A24 + 4 * H, to_ts: T - 5 * H, balance: '1250000000000', balance_num: 1250000 },
      { chain: 'namada', address: same, from_ts: A24 - D, to_ts: T - 5 * H, balance: '2100000000', balance_num: 2100 },
      { chain: 'namada', address: noBase, from_ts: A24 + 2 * H, to_ts: T - H, balance: '500000000', balance_num: 500 },
      { chain: 'osmosis', address: osmo, from_ts: A24 - D, to_ts: T - 10 * 60_000, balance: '2100000000', balance_num: 2100 },
    ]);
    const wallet = W('namada', 99);
    const log: Prepared[] = [];
    const r = await readWatchlists(db, [{ address: wallet, watchlist: [changed, same, noBase, unlisted, osmo, changed] }], T, 'daily', log);
    const lines = r.lines.get(wallet) as WatchLine[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({ address: changed, chain: 'namada', status: 'changed', now: 1250000, base: 1262500, change: -12500, asOf: 1792741923099, baseSpan: { fromTs: A7 - D, toTs: A24 + 3 * H } });
    expect(lines[1]).toMatchObject({ address: same, status: 'unchanged', now: 2100, base: 2100, change: 0, asOf: T - 5 * H });
    expect(lines[2]).toMatchObject({ address: noBase, status: 'base-unknown', now: 500, base: null, change: null });
    expect(lines[3]).toMatchObject({ address: unlisted, status: 'not-listed', now: null, base: null });
    expect(lines[4]).toMatchObject({ address: osmo, chain: 'osmosis', status: 'unchanged', now: 2100, asOf: T - 10 * 60_000 });
    expect(r).toMatchObject({ wallets: 1, admitted: 1, capped: 0, addresses: 5, statements: 5, batches: 1 });
    for (const s of log) {
      expect(s.sql).not.toMatch(/tnam1|osmo1/);
      expect(s.params.length).toBeLessThanOrEqual(WATCH_CHUNK + 3);
      if (s.sql.includes('FROM holders') || s.sql.includes('FROM balance_spans')) expect(plan(db, s)).toMatch(/sqlite_autoindex_(holders|balance_spans)_1/);
    }
    const weekly = await readWatchlists(db, [{ address: wallet, watchlist: [changed] }], T, 'weekly');
    expect((weekly.lines.get(wallet) as WatchLine[])[0]).toMatchObject({ status: 'changed', base: 1262500 });
  });

  it('60 wallets of 100 addresses: the first 50 are read (5,000 addresses), the rest say the cap; at most 112 reads of 90 addresses in 3 batches; no statement text holds an address', async () => {
    const db = testD1();
    const wallets = Array.from({ length: 60 }, (_, w) => ({ address: W('namada', 100000 + w), watchlist: Array.from({ length: 100 }, (_, i) => W(i % 2 ? 'namada' : 'osmosis', 1000 + w * 100 + i)) }));
    const a = admitWallets(wallets);
    expect([a.admitted.length, a.capped.length, a.addresses.size]).toEqual([50, 10, DIGEST_WATCH_ADDRS_MAX]);
    const log: Prepared[] = [];
    const r = await readWatchlists(db, wallets, T, 'daily', log);
    expect([r.admitted, r.capped, r.addresses]).toEqual([50, 10, 5000]);
    expect(r.statements).toBeLessThanOrEqual(113);
    expect(r.batches).toBeLessThanOrEqual(3);
    expect(Math.ceil(r.statements / WATCH_BATCH)).toBe(r.batches);
    for (const s of log) {
      expect(s.params.length).toBeLessThanOrEqual(WATCH_CHUNK + 3);
      expect(s.sql).not.toMatch(/tnam1|osmo1/);
    }
    for (const w of wallets.slice(50)) expect(r.lines.get(w.address)).toEqual({ notRead: true, source: 'watchlist', lastAt: null, reason: WATCH_CAP_REASON });
    for (const w of wallets.slice(0, 50)) expect((r.lines.get(w.address) as WatchLine[]).every((l) => l.status === 'not-listed')).toBe(true);
  });

  it('a failed read makes every admitted wallet\'s lines the NotRead; wallets with no addresses get an empty list', async () => {
    const db = testD1();
    db.exec('DROP TABLE balance_spans');
    const w1 = W('namada', 200001), w2 = W('namada', 200002);
    const r = await readWatchlists(db, [{ address: w1, watchlist: [W('namada', 7)] }, { address: w2, watchlist: [] }], T);
    expect(r.lines.get(w1)).toEqual({ notRead: true, source: 'watchlist', lastAt: null, reason: DB_NOT_ANSWERED });
    expect(r.lines.get(w2)).toEqual({ notRead: true, source: 'watchlist', lastAt: null, reason: DB_NOT_ANSWERED });
    const none = await readWatchlists(testD1(), [], T);
    expect(none).toMatchObject({ wallets: 0, admitted: 0, statements: 0, batches: 0 });
  });
});

describe('readOperatorFigures: sources degraded, checks, alert counts, the digest\'s own delivery (spec section 8)', () => {
  const seedOps = () => {
    const db = testD1();
    seedSurvey(db);
    const log = [
      { name: 'Namada RPC Papadritta', at: A24 - H, ok: false, note: 'before the window' },
      { name: 'Namada RPC Papadritta', at: Date.UTC(2026, 9, 23, 3, 12), ok: false, note: 'timeout' },
      { name: 'Namada RPC Papadritta', at: Date.UTC(2026, 9, 23, 3, 40), ok: true, note: 'height 8381000' },
      { name: 'Keplr Osmosis REST (holders)', at: Date.UTC(2026, 9, 23, 6, 50), ok: false, note: 'HTTP 502' },
      { name: 'check:bonded_coverage', at: Date.UTC(2026, 9, 23, 4, 0), ok: false, note: 'warn' },
    ];
    insert(db, 'kv', [
      { key: 'source.health.log', value: JSON.stringify(log), updated_at: T },
      { key: 'digest.last', value: JSON.stringify({ key: 'alert:digest:daily:2026-10-22', at: A24 + 5000, targets: 501, posted: 497, skipped: 4 }), updated_at: A24 + 5000 },
      { key: 'alerts.skipped', value: JSON.stringify({ total: 4, last: { what: 'digest 2026-10-22 (4 past the run\'s deadline)', n: 4, at: A24 + 40_000 } }), updated_at: A24 + 40_000 },
      { key: 'alert:digest:daily:2026-10-22', value: '1', updated_at: A24 + 5000 },
      ...Array.from({ length: 14 }, (_, i) => ({ key: `alert:flow:digest-test-${i}`, value: '1', updated_at: 1792656467877 + i * 3_600_000 })),
      // a crossing is claimed per channel: alert:ibc:<channel>:<sequence>:<the channel's 32-hex digest>
      ...Array.from({ length: 5 }, (_, i) => ({ key: `alert:ibc:channel-1:${900 + i}:${String(i).repeat(32)}`, value: '1', updated_at: 1792722880139 - i * 60_000 })),
    ]);
    db.exec(`UPDATE checks SET status = 'warn' WHERE key = 'bonded_coverage'`);
    db.exec(`UPDATE checks SET checked_at = ${T - CHECK_STALE_MS - 60_000} WHERE key = 'supply_integrity'`);
    db.exec(`UPDATE checks SET status = 'idle' WHERE key = 'price_vs_execution'`);
    return db;
  };

  it('the episodes: Papadritta not ok 03:12–03:40 UTC, Keplr holders not ok since 06:50 (still), the check flip; the current map all ok (28 rows in the survey\'s map)', async () => {
    const db = seedOps();
    const log: Prepared[] = [];
    const ops = await readOperatorFigures(db, T, 'daily', log);
    const s = v(ops.sources);
    expect([s.ok, s.total]).toEqual([28, 28]);
    expect(s.notOk).toEqual([]);
    expect(s.episodes).toEqual([
      { name: 'Namada RPC Papadritta', from: Date.UTC(2026, 9, 23, 3, 12), to: Date.UTC(2026, 9, 23, 3, 40), note: 'timeout' },
      { name: 'check:bonded_coverage', from: Date.UTC(2026, 9, 23, 4, 0), to: null, note: 'warn' },
      { name: 'Keplr Osmosis REST (holders)', from: Date.UTC(2026, 9, 23, 6, 50), to: null, note: 'HTTP 502' },
    ]);
    expect(s.logFrom).toBe(Date.UTC(2026, 9, 23, 3, 12));
    expect(log).toHaveLength(6);
    for (const st of log) expect(plan(db, st)).not.toMatch(/SCAN kv\b/);
  });

  it('checks: one warn, one stale, idle neither; 8 of 11 passing', async () => {
    const c = v((await readOperatorFigures(seedOps(), T, 'daily')).checks);
    expect([c.ok, c.total]).toEqual([8, 11]);
    expect(c.notPassing.map((x) => [x.key, x.status, x.stale])).toEqual([['bonded_coverage', 'warn', false], ['supply_integrity', 'ok', true]]);
  });

  it('alerts in the 24 h: 15 posts (14 moves, 5 of them crossings, yesterday\'s digest at 08:00:05; the last 02:34 UTC today); 4 posts not sent on record', async () => {
    const a = v((await readOperatorFigures(seedOps(), T, 'daily')).alerts);
    expect(a.claimed).toMatchObject({ n: 15, moves: 14, crossings: 5, governance: 0, forum: 0, digests: 1, other: 0, firstAt: A24 + 5000, lastAt: 1792722880139 });
    expect(new Date(a.claimed.lastAt!).toISOString().slice(11, 16)).toBe('02:34');
    expect(a.skipped).toEqual({ total: 4, last: { what: 'digest 2026-10-22 (4 past the run\'s deadline)', n: 4, at: A24 + 40_000 } });
  });

  it('a crossing is one post: claimed for two channels it counts once, its second record\'s claim is no post, and the older second key of a move is no post either', async () => {
    const db = seedOps();
    const at = A24 + 6 * H;
    insert(db, 'flows', [
      { id: 'osmosis:DIGESTCROSS:0', chain: 'osmosis', height: 1, ts: at, tx_hash: 'DIGESTCROSS', kind: 'ibc_out', from_addr: null, to_addr: null, amount_num: 1, meta: null },
      { id: 'namada:DIGESTCROSS:0', chain: 'namada', height: 1, ts: at + H, tx_hash: 'DIGESTCROSS', kind: 'ibc_in', from_addr: null, to_addr: null, amount_num: 1, meta: null },
    ]);
    insert(db, 'kv', [
      // the first record of the crossing: its move claim, its crossing claimed for two channels a moment later
      { key: 'alert:flow:osmosis:DIGESTCROSS:0', value: '1', updated_at: at + 1000 },
      { key: `alert:ibc:channel-1:777:${'a'.repeat(32)}`, value: '1', updated_at: at + 1200 },
      { key: `alert:ibc:channel-1:777:${'b'.repeat(32)}`, value: '1', updated_at: at + 1300 },
      // the older second key a move once took beside its own, at the same instant
      { key: 'alert:tx:osmosis:DIGESTCROSS', value: '1', updated_at: at + 1000 },
      // the second record an hour later: its move claim is taken, the crossing is already claimed, nothing is posted
      { key: 'alert:flow:namada:DIGESTCROSS:0', value: '1', updated_at: at + H + 1000 },
    ]);
    const a = v((await readOperatorFigures(db, T, 'daily')).alerts);
    expect(a.claimed).toMatchObject({ n: 16, moves: 15, crossings: 6, digests: 1, other: 0 });
  });

  it('delivery: yesterday\'s digest reached 497 of 501 channels and its key was claimed; a day with no claim says so; the weekly lists the week\'s dailies not sent', async () => {
    const db = seedOps();
    const d = v((await readOperatorFigures(db, T, 'daily')).delivery);
    expect(d.last).toEqual({ key: 'alert:digest:daily:2026-10-22', at: A24 + 5000, targets: 501, posted: 497, skipped: 4 });
    expect(d.previous).toEqual({ key: 'alert:digest:daily:2026-10-22', sentAt: A24 + 5000 });
    expect(d.dailiesNotSent).toEqual([]);
    const monday = Date.UTC(2026, 9, 26, 8);
    const w = v((await readOperatorFigures(db, monday, 'weekly')).delivery);
    expect(w.previous.key).toBe('alert:digest:weekly:2026-W43');
    expect(w.dailiesNotSent).toEqual(['alert:digest:daily:2026-10-19', 'alert:digest:daily:2026-10-20', 'alert:digest:daily:2026-10-21', 'alert:digest:daily:2026-10-23', 'alert:digest:daily:2026-10-24', 'alert:digest:daily:2026-10-25']);
    expect(w.dailiesNotSent).not.toContain('alert:digest:daily:2026-10-22');
    db.exec("DELETE FROM kv WHERE key = 'alert:digest:daily:2026-10-22'");
    expect(v((await readOperatorFigures(db, T, 'daily')).delivery).previous).toEqual({ key: 'alert:digest:daily:2026-10-22', sentAt: null });
    expect(v((await readOperatorFigures(db, monday, 'weekly')).delivery).dailiesNotSent).toHaveLength(7);
  });

  it('a failed statement is that line\'s NotRead; the quiet day has no episodes', async () => {
    const db = testD1();
    seedSurvey(db);
    db.exec('DROP TABLE checks');
    const ops = await readOperatorFigures(db, T, 'daily');
    expect(ops.checks).toEqual({ notRead: true, source: 'checks', lastAt: null, reason: DB_NOT_ANSWERED });
    const s = v(ops.sources);
    expect(s.episodes).toEqual([]);
    expect(s.logFrom).toBeNull();
    expect(v(ops.alerts).claimed.n).toBe(0);
    expect(v(ops.delivery)).toMatchObject({ last: null, previous: { key: 'alert:digest:daily:2026-10-22', sentAt: null } });
  });

  it('the claim keys: the UTC date for the daily, the Monday\'s ISO week for the weekly (2026-10-26 → 2026-W44; 2026-01-01, a Thursday, is in 2026-W01)', () => {
    expect(dailyClaimKey(T)).toBe('alert:digest:daily:2026-10-23');
    expect(weeklyClaimKey(Date.UTC(2026, 9, 26, 8))).toBe('alert:digest:weekly:2026-W44');
    expect(isoWeek(Date.UTC(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
    expect(new Date(Date.UTC(2026, 0, 1)).getUTCDay()).toBe(4);
    expect(isoWeek(Date.UTC(2024, 11, 30))).toEqual({ year: 2025, week: 1 });
    expect(isoWeek(Date.UTC(2027, 0, 3))).toEqual({ year: 2026, week: 53 });
    expect(digestKeysAsked(T, 'daily')).toEqual(['alert:digest:daily:2026-10-22']);
    expect(digestKeysAsked(Date.UTC(2026, 9, 26, 8), 'weekly')).toHaveLength(8);
    expect(healthEpisodes([])).toEqual([]);
  });
});

describe('collectDigestReads marks what did not run', () => {
  it('without a live epoch the anchor, the queue and the matured reads are not run and say why', async () => {
    const db = testD1();
    seedSurvey(db);
    db.exec(`UPDATE metrics SET ts = ${T - 11 * 60_000} WHERE key = 'epoch' AND ts = 1792742342769`);
    const r = await collectDigestReads(db, digestWindow(T, 'daily'));
    expect(r.epochAnchor).toEqual({ ok: false, error: 'the epoch at T is not live' });
    expect(r.queueNext).toEqual({ ok: false, error: 'the epoch at T is not live' });
    expect(r.queueRange).toEqual({ ok: false, error: 'the epoch clock is not known' });
    expect(r.queueMatured.ok).toBe(true);
  });
});

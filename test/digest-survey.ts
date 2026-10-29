// Daily digest (2026-10-23): the survey's stored rows for tests that need them, shared by the build test. seedSurvey
// writes the rows test/digest-figures-read.test.ts seeds (the same function, so both read the same database), seedCharts
// adds the stored hourly and daily series of test/fixtures/digest-charts/ (the read-only SELECT answers of 2026-10-23),
// and readsFromSurvey is the answer set test/digest-figures-shape.test.ts hands the shaper. No row here is a wallet's:
// ids and hashes the survey did not capture are fixture placeholders ('digest-test:…'), the addresses fixture-shaped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insert, type TestD1 } from './d1-sqlite';
import { instantKey, type DigestReads, type KvRow, type ProposalRow } from '../worker/src/digest/figures';
import { answered, type Answer, type MetricRow } from '../worker/src/digest/types';
import { MASP_ADDRESS } from '../worker/src/digest/sql';
import { NAMADA } from '../worker/src/config';

export const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'digest', 'survey-2026-10-23.json'), 'utf8'));
export const T = 1792742400000, A24 = 1792656000000, A7 = 1792137600000, A30 = T - 30 * 86_400_000;
const POS = NAMADA.internal.pos;

/** A fixture address of one chain, in the bech32 character set, never a real one. */
const ALPHABET = 'qpzry9x8gf2tvdw0s3jn';
export function fixtureAddress(chain: 'namada' | 'osmosis', i: number, stem = 'qwatch'): string {
  let s = '';
  let n = i;
  do { s = ALPHABET[n % 20] + s; n = Math.floor(n / 20); } while (n > 0);
  const body = (stem + s).padEnd(chain === 'namada' ? 40 : 38, 'q');
  return (chain === 'namada' ? 'tnam1' : 'osmo1') + body;
}

/** Seeds the survey's rows (as test/digest-figures-read.test.ts does). */
export function seedSurvey(db: TestD1) {
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
  const masp = fx.flows.maspRows.map((r: any, i: number) => flow(`masp:${i}`, r.chain, r.kind, r.ts, r.height, r.amount_num, { to_addr: MASP_ADDRESS, meta: r.seq ? JSON.stringify({ packetSequence: r.seq, channel: r.channel }) : null }));
  insert(db, 'flows', [...bonds, ...unbonds, withdraw, trade, ...masp]);
}

const chartRows = (name: string): any[] =>
  (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'digest-charts', `${name}.json`), 'utf8')) as { results: any[] }[])[0].results;

/** Adds the charts' stored series: the hourly quote, the executed hours, the hourly total stake and the daily flow keys (7 and 30 days). */
export function seedCharts(db: TestD1) {
  const put = db.raw.prepare('INSERT OR IGNORE INTO metrics (key, ts, value) VALUES (?, ?, ?)');
  for (const r of [...chartRows('price_quote_1h'), ...chartRows('price_quote_1h_30d')]) put.run('price.usd.1h', r.ts, r.value);
  for (const r of [...chartRows('stake_1h')]) put.run('supply.total_stake.1h', r.ts, r.value);
  for (const name of ['price_exec_1h', 'price_exec_1h_30d', 'flows_daily', 'flows_daily_30d']) for (const r of chartRows(name)) put.run(r.key, r.ts, r.value);
}

/** The DigestReads the collector would have handed the shaper, from the survey's answers (test/digest-figures-shape.test.ts). */
export function readsFromSurvey(kind: 'daily' | 'weekly'): DigestReads {
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
    // the survey's MASP statement had no chain filter and returned the Osmosis ibc_out rows too; the module's statement has it
    maspIn: answered(fx.flows.maspInWithoutChainFilter.filter((r: any) => r.kind !== 'ibc_out')),
    maspOut: answered(fx.flows.maspOut),
    maspFees: answered(fx.flows.maspOtherCoinFees),
    proposals: answered(props),
    govClaims: answered(fx.governance.claims24h),
    vdDays: answered(days),
    vdMoves: answered(fx.validators.moves.slice(0, 5)),
    vdSets: answered(fx.validators.sets),
    vdStates: answered(fx.validators.states),
    // the depth store did not exist on 2026-10-23: no hour on record
    depthHour: answered([]),
    depthDay: answered([{ lo: null, hi: null, n: 0, first_hour: null, last_hour: null }]),
    vdCompared: days.length === 2 ? { day, baseDay, noListingToday: false, baseIsOldest: false } : null,
  };
}

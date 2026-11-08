// NAM since genesis (the Supply page, 2026-11-07): the dated split read from docs/data and checked against the per-epoch
// table (scripts/export-proof.ts), the sentence's maths from fixture figures (web/src/screens/supply/since-genesis.ts),
// the words carrying only the figures given (N2, with the copy lint's own rules over the new screens), the supply.mint
// series the cron writes once per judged epoch step, and the overview serving the newest step and the chain's rewards
// total from the kv rows, missing with the reason before they exist and absent under Rewind.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSupplySplit, parseSupplyTsv, microOf, readSupplySplit, type SupplyPeriodsFile } from '../scripts/export-proof';
import { lintFile, numLintFile } from '../scripts/copy-lint';
import { SUPPLY_SPLIT } from '../web/src/generated/supply';
import { genesisShares, sinceGenesisParts } from '../web/src/screens/supply/since-genesis';
import { SUPPLY_WORDS, TIMELINE_WORDS } from '../shared/copy';
import { mintMetricStmt, MINT_SERIES_KEY, MINT_RULE_KV, type MintRuleState, type MintStep } from '../worker/src/cron';
import { SERIES_KEYS } from '../worker/src/series-api';
import { MASP_MAKEUP_KV } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { BANNED } from './banned-words';
import type { MaspMakeup, Overview, SeriesResponse } from '../shared/types';

const ROOT = join(__dirname, '..');
const H = 3_600_000, D = 24 * H, MIN = 60_000;
/** 7 Nov 2026 12:00 UTC, whole minute. */
const NOW = Date.UTC(2026, 10, 7, 12, 0);
afterEach(() => { vi.useRealTimers(); });

const periodsFile = (): SupplyPeriodsFile => JSON.parse(readFileSync(join(ROOT, 'docs', 'data', 'supply_since_genesis.json'), 'utf8'));
const tableRows = () => parseSupplyTsv(readFileSync(join(ROOT, 'docs', 'data', 'supply_by_epoch_1207_2737.tsv'), 'utf8'));

describe('the dated split (docs/data)', () => {
  it('is what the generated file carries: epochs 1207 to 2737, 1,179 of 1,531 measured, the stretch 2200 to 2409 modelled', () => {
    const s = readSupplySplit(ROOT);
    expect(s).toEqual(SUPPLY_SPLIT);
    expect(s.derivedOn).toBe('2026-11-02');
    expect(s.genesisNam).toBe(1_000_000_000);
    expect(s.fromEpoch).toBe(1207);
    expect(s.toEpoch).toBe(2737);
    expect(s.fromBlock).toBe(3_750_313);
    expect(s.toBlock).toBe(8_514_218);
    expect(s.stakingNam).toBeCloseTo(30_514_698.864115, 6);
    expect(s.publicFundingNam).toBeCloseTo(10_295_702.540893, 6);
    expect(s.epochs).toBe(1531);
    expect(s.measuredEpochs).toBe(1179);
    expect(s.modelled).toEqual({ fromEpoch: 2200, toEpoch: 2409, fromDay: '2026-06-07', toDay: '2026-07-29', stakingNam: 4_146_759.344549 });
    // the growth from genesis to epoch 2737, exactly the periods plus the growth before them
    expect(s.mintedAtToEpochNam - s.genesisNam).toBeCloseTo(148_734_527.288587, 5);
    // the transfer into the public-funding account: block, time and hash as the chain has them
    expect(s.transfer).toEqual({ nam: 52_378_111.75, block: 5_725_013, at: Date.UTC(2026, 2, 10, 20, 5, 3), txHash: '5E9C6830725480D376A2E5C1C484CBAC7E782D454E1D68CD1203F6E9772C8B29' });
  });

  it('the table\'s rows are the epochs the indexer has, in order, and each period\'s rows stay within the period\'s totals', () => {
    const rows = tableRows();
    expect(rows).toHaveLength(1179);
    expect(rows[0].epoch).toBe(1207);
    expect(rows[rows.length - 1].epoch).toBe(2737);
    expect(rows.filter((r) => r.epoch >= 2200 && r.epoch <= 2409)).toHaveLength(0);
    const file = periodsFile();
    for (const p of file.periods) {
      const inRows = rows.filter((r) => r.epoch >= p.fromEpoch && r.epoch <= p.toEpoch);
      expect(inRows).toHaveLength(p.indexerRows);
      expect(inRows.reduce((a, r) => a + r.staking, 0n) <= microOf(p.stakingNam)).toBe(true);
      expect(inRows.reduce((a, r) => a + r.publicFunding, 0n) <= microOf(p.publicFundingNam)).toBe(true);
    }
    // public funding has been 0 since epoch 1489: every row from there on gives it 0
    expect(rows.filter((r) => r.epoch >= file.publicFundingRateZeroFromEpoch).every((r) => r.publicFunding === 0n)).toBe(true);
    expect(rows.filter((r) => r.epoch < file.publicFundingRateZeroFromEpoch).every((r) => r.publicFunding > 0n)).toBe(true);
  });

  it('refuses a period total below its rows, a gap between periods and periods that do not add up', () => {
    const rows = tableRows();
    const low = periodsFile();
    low.periods[0].stakingNam = '19000000';
    expect(() => buildSupplySplit(low, rows)).toThrow(/staking inflation exceeds/);
    const gap = periodsFile();
    gap.periods[1].fromEpoch = 2201;
    expect(() => buildSupplySplit(gap, rows)).toThrow(/gap or overlap/);
    const off = periodsFile();
    off.before.observedNam = '91555381.466872';
    expect(() => buildSupplySplit(off, rows)).toThrow(/not the growth from genesis/);
    const count = periodsFile();
    count.periods[2].indexerRows = 193;
    expect(() => buildSupplySplit(count, rows)).toThrow(/rows in the table/);
    expect(microOf('1148734527.288587')).toBe(1_148_734_527_288_587n);
    expect(microOf('0')).toBe(0n);
    expect(microOf('52378111.75')).toBe(52_378_111_750_000n);
    expect(() => microOf('1,000')).toThrow(/not a NAM amount/);
  });
});

describe('the since-genesis sentence', () => {
  // the live figures as the halted chain gives them: all NAM at block 8,517,986, the pool's rewards total
  const TOTAL = 1_148_774_450.123456, REWARDS = 27_347_610.418808;

  it('its parts come from the live figures and the split, and add up to the growth', () => {
    const a = sinceGenesisParts(TOTAL, REWARDS, SUPPLY_SPLIT);
    expect(a.why).toBeNull();
    const p = a.parts!;
    expect(p.genesisNam).toBe(1_000_000_000);
    expect(p.nowNam).toBe(TOTAL);
    expect(p.growthNam).toBeCloseTo(148_774_450.123456, 6);
    expect(p.rewardsNam).toBe(REWARDS);
    expect(p.stakingNam).toBe(SUPPLY_SPLIT.stakingNam);
    expect(p.publicFundingNam).toBe(SUPPLY_SPLIT.publicFundingNam);
    expect(p.togetherNam).toBeCloseTo(148_774_450.123456 - REWARDS - 30_514_698.864115 - 10_295_702.540893, 6);
    expect(p.rewardsNam + p.stakingNam + p.publicFundingNam + p.togetherNam).toBeCloseTo(p.growthNam, 6);
    const shares = genesisShares(p);
    expect(shares.map((s) => s.key)).toEqual(['rewards', 'staking', 'publicFunding', 'together']);
    expect(shares.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 9);
    expect(shares[0].pct).toBeCloseTo((REWARDS / p.growthNam) * 100, 9);
  });

  it('a live figure not read, or one the split does not fit, gives no sentence and the reason, never a stand-in', () => {
    expect(sinceGenesisParts(null, REWARDS, SUPPLY_SPLIT)).toEqual({ parts: null, why: 'All NAM in existence was not read.' });
    expect(sinceGenesisParts(TOTAL, null, SUPPLY_SPLIT).why).toMatch(/shielded rewards was not read/);
    expect(sinceGenesisParts(1_000_000_000, REWARDS, SUPPLY_SPLIT).why).toMatch(/at or below the genesis total/);
    expect(sinceGenesisParts(1_000_000_000 + 1_000, 500, SUPPLY_SPLIT).why).toMatch(/do not fit/);
    expect(sinceGenesisParts(Number.NaN, REWARDS, SUPPLY_SPLIT).parts).toBeNull();
  });

  it('the words carry exactly the figures given and type none of their own (N2); the new screens pass the copy lint', () => {
    const t = SUPPLY_WORDS.sinceGenesis('1,000,000,000', '1,148,774,450', '27,347,610', '1207', '2737', '30,514,699', '10,295,703');
    expect(t).toBe('Since genesis, NAM supply grew from 1,000,000,000 to 1,148,774,450 NAM: 27,347,610 NAM minted into the shielded pool as shielded rewards (the chain’s own total), the rest staking inflation and public-funding inflation, which can be told apart only from epoch 1207 on (30,514,699 and 10,295,703 NAM from epoch 1207 to 2737; before that, together).');
    expect(t.replace(/1,000,000,000|1,148,774,450|27,347,610|1207|2737|30,514,699|10,295,703/g, '')).not.toMatch(/\d/);
    // every other sentence of the words file, given letters for figures, has no digit of its own
    const letters = [
      SUPPLY_WORDS.caveat('D', 'A', 'B', 'C', 'E', 'F', 'G', 'H', 'I'),
      SUPPLY_WORDS.mintNow('N', 'E', 'B'), SUPPLY_WORDS.mintNotRead, SUPPLY_WORDS.transfer('N', 'B', 'D'), SUPPLY_WORDS.dated('D'),
      SUPPLY_WORDS.parts.rewards, SUPPLY_WORDS.parts.staking('A', 'B'), SUPPLY_WORDS.parts.publicFunding('A', 'B'), SUPPLY_WORDS.parts.together('A', 'B'),
      ...Object.values(SUPPLY_WORDS.scope), SUPPLY_WORDS.heading, ...Object.values(TIMELINE_WORDS),
    ];
    for (const s of letters) {
      expect(s, s).not.toMatch(/\d/);
      expect(s, s).not.toMatch(BANNED);
    }
    expect(SUPPLY_WORDS.mintNow('19,961.144868', '2738', '8,514,219')).toBe('19,961.144868 NAM of staking inflation was minted into the staking account as epoch 2738 started (the chain’s record, block 8,514,219).');
    expect(SUPPLY_WORDS.transfer('52,378,111.75', '5,725,013', '10 Mar 2026')).toBe('The public-funding account also received 52,378,111.75 NAM in one transfer at block 5,725,013 (10 Mar 2026): moved from another account, not newly minted.');
    for (const f of ['web/src/screens/supply/SinceGenesis.tsx', 'web/src/screens/supply/index.tsx', 'web/src/screens/shielded/Timeline.tsx', 'web/src/screens/shielded/index.tsx', 'web/src/screens/trade/index.tsx', 'web/src/ui/PriceChart.tsx', 'web/src/ui/SeriesChart.tsx']) {
      expect(numLintFile(join(ROOT, f)), f).toEqual([]);
      expect(lintFile(join(ROOT, f)), f).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- the newest epoch's staking inflation

const step = (over: Partial<MintStep> = {}): MintStep => ({
  epoch: 2738, fromHeight: 8_514_218, height: 8_514_219, provider: 'StakeAndRelax', mintedBeforeBase: '1148734527288587', grewBase: '19961144868',
  stakingBase: '19961144868', shieldedBase: '0', shieldedEpoch: false, maspRiseBase: null, posRiseBase: null, posRiseMatches: null, fits: true, at: NOW - 2 * H, ...over,
});
const state = (lastStep: MintStep | null, over: Partial<MintRuleState> = {}): MintRuleState => ({ anchor: null, pending: null, judgedAt: lastStep?.at ?? null, lastStep, broke: null, unjudged: null, keysFailedAt: null, ...over });
const makeup = (rewards: MaspMakeup['rewards']): MaspMakeup => ({
  at: NOW - H, since: Date.UTC(2025, 5, 13), in: { nam: 100, n: 1, shield: { nam: 100, n: 1 }, bridge: { nam: 0, n: 0 } }, out: { nam: 10, n: 1, feesNam: 0 }, rewards, balance: { nam: 90, at: NOW - H },
});
async function overview(db: TestD1, at?: number): Promise<Overview> {
  const res = await app.request(`/api/overview${at != null ? `?at=${at}` : ''}`, {}, { DB: db } as any);
  expect(res.status).toBe(200);
  return (await res.json()) as Overview;
}

describe('the newest epoch\'s staking inflation', () => {
  it('the cron writes one supply.mint row per newly judged step, the chain\'s staking inflation in NAM', () => {
    const none = state(null);
    expect(mintMetricStmt(undefined, none, NOW)).toBeNull();
    const first = state(step());
    const s = mintMetricStmt(none, first, NOW)!;
    expect(s).not.toBeNull();
    expect(s.sql).toMatch(/INSERT OR REPLACE INTO metrics/);
    expect(s.params).toEqual([NOW, MINT_SERIES_KEY, 19_961.144868]);
    expect(MINT_SERIES_KEY).toBe('supply.mint');
    // the next ticks hold the same step: no second row
    expect(mintMetricStmt(first, first, NOW + MIN)).toBeNull();
    expect(mintMetricStmt(first, state(step(), { judgedAt: NOW + MIN }), NOW + MIN)).toBeNull();
    // the next step, judged: its own row, its own figure
    const next = state(step({ epoch: 2739, fromHeight: 8_514_219, height: 8_517_300, stakingBase: '19961615079', at: NOW + 6 * H }));
    expect(mintMetricStmt(first, next, NOW + 6 * H)!.params).toEqual([NOW + 6 * H, MINT_SERIES_KEY, 19_961.615079]);
    // a state written before this release has no step time: still one row
    expect(mintMetricStmt(none, state(step({ at: undefined })), NOW)!.params[2]).toBe(19_961.144868);
  });

  it('/api/series serves supply.mint as a sparse key with its own words: a point per step, no gaps, live', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const def = SERIES_KEYS['supply.mint'];
    expect(def).toMatchObject({ unit: 'nam', agg: 'last', sparse: true, native: '1h' });
    expect(def.words).toBeDefined();
    const db = testD1();
    insert(db, 'metrics', [{ ts: NOW - 9 * H, key: 'supply.mint', value: 19_961.144868 }, { ts: NOW - 3 * H, key: 'supply.mint', value: 19_961.615079 }]);
    const res = await app.request(`/api/series?key=supply.mint&from=${NOW - 2 * D}`, {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SeriesResponse;
    expect(body.sparse).toBe(true);
    expect(body.gaps).toEqual([]);
    expect(body.points.map((p) => p.v)).toEqual([19_961.144868, 19_961.615079]);
    expect(body.start).toBe(NOW - 9 * H);
    expect(body.prov).toMatchObject({ status: 'live', at: NOW - 3 * H });
    expect(body.prov.note).toBe('Written once per epoch step; the newest step was judged 7 Nov 2026 09:00 UTC.');
    expect(body.sources[0].startNote).toMatch(/^The staking inflation the chain recorded for each epoch step since 7 Nov 2026, in NAM an epoch, written once per step/);
    // a range after the start without a step: said in the key's own words, never as hours without a trade
    const empty = (await (await app.request(`/api/series?key=supply.mint&from=${NOW - 2 * H}`, {}, { DB: db } as any)).json()) as SeriesResponse;
    expect(empty.points).toEqual([]);
    expect(empty.prov).toMatchObject({ status: 'missing', note: 'No epoch step was judged in this range.' });
    // a range before the series starts says so
    const before = (await (await app.request(`/api/series?key=supply.mint&from=${NOW - 2 * D}&to=${NOW - D}`, {}, { DB: db } as any)).json()) as SeriesResponse;
    expect(before.prov).toMatchObject({ status: 'missing', note: 'Nothing in this range: the series starts on 7 Nov 2026.' });
  });

  it('/api/overview serves the newest step and the chain\'s rewards total from the kv rows: missing with the reason before they exist, absent under Rewind', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = testD1();
    let o = await overview(db);
    expect(o.supply.mint).toMatchObject({ nam: null, epoch: null, height: null, prov: { status: 'missing' } });
    expect(o.supply.mint!.prov.note).toMatch(/^Not read yet: the chain records an epoch/);
    expect(o.supply.shieldedRewards).toMatchObject({ value: null, prov: { status: 'missing' } });
    expect(o.supply.shieldedRewards!.prov.note).toMatch(/has not been read yet/);
    // the rows written: the mint rule's state with a judged step, the daily ledger with the rewards read
    insert(db, 'kv', [
      { key: MINT_RULE_KV, value: JSON.stringify(state(step())), updated_at: NOW - 2 * H },
      { key: MASP_MAKEUP_KV, value: JSON.stringify(makeup({ nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW - H })), updated_at: NOW - H },
    ]);
    o = await overview(db);
    expect(o.supply.mint).toEqual({
      nam: 19_961.144868, epoch: 2738, height: 8_514_219,
      prov: { source: 'Namada RPC abci_query (last_inflation_amount)', at: NOW - 2 * H, height: 8_514_219, status: 'live', note: "The chain's record of the staking inflation minted as epoch 2738 started, read at block 8514219 (StakeAndRelax). It is read again when the next epoch starts." },
    });
    expect(o.supply.shieldedRewards).toEqual({
      value: 27_347_610.418808,
      prov: { source: 'Namada RPC (shielded rewards total)', at: NOW - H, height: 8_517_986, status: 'live', note: "The chain's running total of shielded rewards, read once a day (StakeAndRelax)." },
    });
    // a day and more without a new read of the rewards total: old, with how long
    db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(makeup({ nam: 27_347_610.418808, base: '27347610418808', height: 8_517_986, provider: 'StakeAndRelax', at: NOW - 30 * H })), MASP_MAKEUP_KV);
    o = await overview(db);
    expect(o.supply.shieldedRewards!.prov).toMatchObject({ status: 'stale', note: 'Read once a day, and not since 30 hours ago (StakeAndRelax).' });
    // a state without a step time (written before this release): the last judgement's time stands in
    db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(state(step({ at: undefined }), { judgedAt: NOW - 90 * MIN })), MINT_RULE_KV);
    o = await overview(db);
    expect(o.supply.mint!.prov.at).toBe(NOW - 90 * MIN);
    // rewound: current rows are not as of that time, so neither figure is served
    const r = await overview(db, NOW - D);
    expect(r.supply.mint).toBeUndefined();
    expect(r.supply.shieldedRewards).toBeUndefined();
  });
});

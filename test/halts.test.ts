// Not judged across a halt (shared/halts.ts): a check that compares two readings does not judge a pair on either side
// of a stretch in which Namada made no blocks. One rule, applied alike wherever two readings taken at different times
// are compared and judged: the mint rule, the staking account's remainder, the shielded pool's daily ledger, and the
// digest's two balance lines. The stretches are the table's, their times the chain's own header times; the rule is
// shown on stretches from the past, and the pages say it in the same words.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { END_GAP_MS, NO_BLOCKS, endAfter, noBlocksAcrossTimes, noBlocksBetween, notJudgedAcross, openStretches, resumedKv, resumedSeen } from '../shared/halts';
import { INCIDENTS } from '../scripts/incidents';
import { HALT } from '../shared/halt';
import { NAMADA } from '../worker/src/config';
import { chainReachedTo, mintKeysWanted, mintRuleNext, posRemainderNext, posRemainderReads, maspLedgerCheck, readResumed, type MintReading, type BondListingRecord, type MaspDay } from '../worker/src/cron';
import { checkDetail } from '../web/src/lib/prov';
import { readDigestFigures } from '../worker/src/digest/figures';
import { measuredEnds, toMessageFigures } from '../worker/src/digest/build';
import { renderShared } from '../worker/src/digest/message';
import { testD1 } from './d1-sqlite';
import { seedSurvey, T as SURVEY_T } from './digest-survey';
import type { Check } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); });

const H = 3_600_000, MIN = 60_000, D = 24 * H;
const lineOf = (key: string, status: string, detail: Record<string, unknown>) => checkDetail({ key, status: status as Check['status'], title: '', detail, checkedAt: 0 });
const words = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');
const stretch = (lastBlock: number) => NO_BLOCKS.find((s) => s.lastBlock === lastBlock)!;

describe('the table of stretches with no blocks', () => {
  it('holds every stretch scripts/incidents.ts lists, by the last block before each, oldest first, and the current one', () => {
    const listed = INCIDENTS.flatMap((i) => i.halts ?? []).map((h) => h.from);
    const current = INCIDENTS.find((i) => i.id === HALT.id)!;
    expect(NO_BLOCKS.map((s) => s.lastBlock)).toEqual([...listed, 8_517_986].sort((a, b) => a - b));
    expect(current.sources.map((s) => s.label).join(' ')).toContain('8,517,986');
    expect(openStretches().map((s) => s.lastBlock)).toEqual([8_517_986]);
  });

  it('its times are the chain\'s own header times: the last block before each stretch, and its end as endAfter tells it from the blocks after', () => {
    const header = new Map<number, number>();
    for (const f of readdirSync(new URL('./fixtures/', import.meta.url)).filter((n) => n.startsWith('namada_blockchain_'))) {
      const d = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
      for (const m of (d.result ?? d).block_metas ?? []) header.set(Number(m.header.height), Date.parse(String(m.header.time).replace(/(\.\d{3})\d+Z$/, '$1Z')));
    }
    for (const s of NO_BLOCKS) {
      expect(s.lastBlockAt, `${s.lastBlock}`).toBe(header.get(s.lastBlock));
      if (s.resumedAt != null) expect(s.resumedAt, `${s.lastBlock}: end`).toBe(endAfter(s, (h) => header.get(h))?.ts);
    }
  });

  it('a pair of blocks is across a stretch when one is at its last block or before and the other after it', () => {
    expect(noBlocksBetween(7_914_140, 7_914_154)?.lastBlock).toBe(7_914_153);
    expect(noBlocksBetween(7_914_153, 7_914_154)?.lastBlock).toBe(7_914_153);
    // two stretches between them: the first is named
    expect(noBlocksBetween(7_914_100, 7_914_154)?.lastBlock).toBe(7_914_107);
    expect(noBlocksBetween(7_914_154, 7_914_200)).toBeNull();
    expect(noBlocksBetween(7_914_150, 7_914_153)).toBeNull();
    // the current stretch needs no end: any block after its last is on the other side
    expect(noBlocksBetween(8_517_986, 8_517_990)?.lastBlock).toBe(8_517_986);
    expect(noBlocksBetween(8_517_986, 8_517_986)).toBeNull();
    expect(noBlocksBetween(null, 8_517_990)).toBeNull();
  });

  it('a pair of times is across a stretch when one is before the first block after it and the other at it or later', () => {
    const s = stretch(8_200_078);
    expect(noBlocksAcrossTimes(Date.UTC(2026, 9, 8), Date.UTC(2026, 9, 9))).toEqual(s);
    expect(noBlocksAcrossTimes(Date.UTC(2026, 9, 9), Date.UTC(2026, 9, 10))).toBeNull();
    // the current stretch: only with its end measured, and only an end after its last block
    const day = [Date.UTC(2026, 10, 11), Date.UTC(2026, 10, 12)] as const;
    expect(noBlocksAcrossTimes(...day)).toBeNull();
    expect(noBlocksAcrossTimes(...day, { 8_517_986: Date.UTC(2026, 10, 11, 14) })).toMatchObject({ lastBlock: 8_517_986, resumedAt: Date.UTC(2026, 10, 11, 14) });
    expect(noBlocksAcrossTimes(Date.UTC(2026, 9, 31), Date.UTC(2026, 10, 1), { 8_517_986: Date.UTC(2026, 9, 31, 14) })).toBeNull();
    // a measured end seconds after the last block (the block agreed on then) is no end
    expect(noBlocksAcrossTimes(Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 3), { 8_517_986: Date.UTC(2026, 10, 2, 22, 49, 51) })).toBeNull();
  });

  it('says it in measured words: from when to when no block was made, or for a time after which block', () => {
    expect(words(notJudgedAcross(stretch(8_200_078)))).toBe('not judged across a halt: Namada made no blocks from 7 Oct 2026, 10:12 UTC (block 8,200,078) to 8 Oct 2026, 17:03 UTC');
    expect(words(notJudgedAcross(stretch(8_517_986)))).toBe('not judged across a halt: Namada made no blocks for a time after block 8,517,986 (2 Nov 2026, 22:49 UTC)');
  });
});

describe('the time blocks were made again after the current stretch', () => {
  const LAST_AT = Date.UTC(2026, 10, 2, 22, 49, 36, 642);
  // a block's header time is when the block before it was agreed on: block 8,517,986 was agreed on at 22:49:51 on
  // 2 November (its precommits), so block 8,517,987 carries that time whenever it is made, and the block after it the
  // time blocks were made again
  const AGREED = Date.UTC(2026, 10, 2, 22, 49, 51, 200);
  const AGAIN = Date.UTC(2026, 10, 11, 14, 0, 7);

  it('the end is the first block after the stretch whose header is well after the last block\'s', () => {
    const s = { lastBlock: 8_517_986, lastBlockAt: LAST_AT };
    expect(END_GAP_MS).toBe(10 * MIN);
    expect(endAfter(s, (h) => new Map([[8_517_987, AGREED], [8_517_988, AGAIN]]).get(h))).toEqual({ height: 8_517_988, ts: AGAIN });
    // the shape of every stretch before: the last block agreed on only when blocks were made again
    expect(endAfter(s, (h) => new Map([[8_517_987, AGAIN]]).get(h))).toEqual({ height: 8_517_987, ts: AGAIN });
    // the block after next not known: cannot be told yet; neither far after: none
    expect(endAfter(s, (h) => new Map([[8_517_987, AGREED]]).get(h))).toBeUndefined();
    expect(endAfter(s, (h) => new Map([[8_517_987, AGREED], [8_517_988, AGREED + 7000]]).get(h))).toBeNull();
  });

  it('the block scan records it once, when the blocks that tell it are read on one run', () => {
    const times = new Map([[8_517_987, AGREED], [8_517_988, AGAIN], [8_517_989, AGAIN + 7000]]);
    expect(resumedSeen(8_517_986, 8_517_990, (h) => times.get(h))).toEqual([{ key: resumedKv(8_517_986), height: 8_517_988, ts: AGAIN }]);
    // read on two runs: the second run does not hold the first block's time, so nothing is recorded (the ledger reads them)
    expect(resumedSeen(8_517_986, 8_517_987, (h) => times.get(h))).toEqual([]);
    expect(resumedSeen(8_517_987, 8_517_995, (h) => (h >= 8_517_988 ? times.get(h) : undefined))).toEqual([]);
    expect(resumedSeen(8_517_980, 8_517_986, (h) => times.get(h))).toEqual([]);
  });

  it('how far the chain reached is the scan\'s cursor (as the tick holds it, a record with a height) or a node\'s newest block, the higher', () => {
    expect(chainReachedTo({ height: 8_518_500 }, null)).toBe(8_518_500);
    expect(chainReachedTo({ height: 8_517_986 }, 8_518_020)).toBe(8_518_020);
    expect(chainReachedTo(null, 8_517_986)).toBe(8_517_986);
    expect(chainReachedTo(undefined, undefined)).toBeNull();
  });

  it('the ledger reads it as recorded; with no record, or one that cannot be an end, reads the two headers from a node and records the end; a read that cannot tell it throws', async () => {
    const node = { rpcs: [{ provider: 'a', url: 'https://node.example' }], retries: 0 };
    const recorded = testD1();
    recorded.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(resumedKv(8_517_986), JSON.stringify({ height: 8_517_988, ts: AGAIN }));
    expect(await readResumed(recorded as any, 8_518_500, {})).toEqual({ 8_517_986: AGAIN });
    // the scan not past the stretch: nothing to read
    expect(await readResumed(testD1() as any, 8_517_986, {})).toEqual({});

    const meta = (h: number, iso: string) => ({ header: { chain_id: NAMADA.chainId, height: String(h), time: iso } });
    const answer = (metas: unknown[]) => vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('/blockchain?minHeight=8517987&maxHeight=');
      return new Response(JSON.stringify({ result: { block_metas: metas } }), { headers: { 'content-type': 'application/json' } });
    });
    // a record of the block agreed on seconds after the last one (as the scan of an earlier version wrote it) is no end
    const db = testD1();
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(resumedKv(8_517_986), JSON.stringify({ height: 8_517_987, ts: AGREED }));
    vi.stubGlobal('fetch', answer([meta(8_517_988, '2026-11-11T14:00:07.000Z'), meta(8_517_987, '2026-11-02T22:49:51.200Z')]));
    expect(await readResumed(db as any, 8_518_500, node)).toEqual({ 8_517_986: AGAIN });
    expect(JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(resumedKv(8_517_986)) as any).value)).toEqual({ height: 8_517_988, ts: AGAIN });

    // the chain at the block after the stretch only, its header the old agreement: the end cannot be told yet
    vi.stubGlobal('fetch', answer([meta(8_517_987, '2026-11-02T22:49:51.200Z')]));
    await expect(readResumed(testD1() as any, 8_517_987, node)).rejects.toThrow(/cannot be told yet/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })));
    await expect(readResumed(testD1() as any, 8_518_500, node)).rejects.toThrow();
  });
});

describe('the mint rule, on the stretch after block 7,914,153', () => {
  const T = Date.UTC(2026, 8, 6, 12, 0);
  const m0 = 1_100_000_000_000_000n;
  const r = (epoch: number, minted: bigint, height: number, at: number): MintReading => ({ epoch, mintedBase: String(minted), height, provider: 'A', at, maspBase: null, posBase: null });

  it('a reading across the stretch whose total differs is not judged, holds no warning, and the next reading is judged against it', () => {
    const before = mintRuleNext(null, r(2500, m0, 7_914_150, T), null, T);
    // while no block is made every minute reads the same block, and the unchanged total is judged each time
    const same = mintRuleNext(before.state, r(2500, m0, 7_914_153, T + 9 * D - MIN), null, T + 9 * D - MIN);
    expect(same.status).toBe('ok');
    const across = mintRuleNext(same.state, r(2500, m0 + 5n, 7_914_160, T + 9 * D), null, T + 9 * D);
    expect(across.detail).toMatchObject({ verdict: 'not-judged', why: 'halt', fromHeight: 7_914_153, halt: { lastBlock: 7_914_153 } });
    expect(across.status).not.toBe('warn');
    expect(across.state).toMatchObject({ anchor: { height: 7_914_160 }, pending: null, broke: null, unjudged: null });
    expect(words(lineOf('supply_mint_rule', across.status, across.detail))).toBe('Not judged across a halt: Namada made no blocks from 6 Sep 2026, 13:45 UTC (block 7,914,153) to 14 Sep 2026, 16:50 UTC');
    const next = mintRuleNext(across.state, r(2500, m0 + 5n, 7_914_170, T + 9 * D + MIN), null, T + 9 * D + MIN);
    expect(next.detail).toMatchObject({ verdict: 'same' });
    expect(next.status).toBe('ok');
  });

  it('epochs apart across the stretch: not judged across it (never a gap held as a warning), and the epoch step\'s record is not read for it', () => {
    const same = mintRuleNext(null, r(2500, m0, 7_914_153, T), null, T);
    expect(mintKeysWanted(same.state, r(2501, m0, 7_914_160, T + 9 * D))).toBe(false);
    const gap = mintRuleNext(same.state, r(2503, m0 + 9n, 7_914_160, T + 9 * D), null, T + 9 * D);
    expect(gap.detail).toMatchObject({ verdict: 'not-judged', why: 'halt' });
    expect(gap.state.unjudged).toBeNull();
    // the same step with no stretch between: the record is wanted, as before
    const plain = mintRuleNext(null, r(2500, m0, 7_914_160, T), null, T);
    expect(mintKeysWanted(plain.state, r(2501, m0, 7_914_170, T + 6 * H))).toBe(true);
  });

  it('without the stretch between them, the same difference is a reading that does not fit, as before', () => {
    const before = mintRuleNext(null, r(2500, m0, 7_914_160, T), null, T);
    expect(mintRuleNext(before.state, r(2500, m0 + 5n, 7_914_170, T + MIN), null, T + MIN).detail).toMatchObject({ verdict: 'pending' });
  });
});

describe('the staking account\'s remainder, on the stretch after block 8,200,078', () => {
  const T = Date.UTC(2026, 9, 1, 12, 0);
  const rec = (over: Partial<BondListingRecord> = {}): BondListingRecord => ({
    at: T, completeAt: T, height: 8_200_000, epoch: 2600, provider: 'A', sources: 10, stakers: 10, totalNam: 1, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0,
    bondedBase: '269402168820000', unbondingBase: '36653965820000', slashedBase: '0', unbondSlashedBase: '0', ...over,
  });
  const reads = (posBase: bigint) => ({ posBase, inflationBase: null, provider: 'A' });

  it('two listings on either side of the stretch are not judged, the second is kept for the next, and no inflation is read for them', () => {
    const first = posRemainderNext(null, rec(), reads(400_000_000_000_000n), T);
    const later = rec({ at: T + 8 * D, completeAt: T + 8 * D, height: 8_200_120, epoch: 2601 });
    expect(posRemainderReads(first.state, later)).toEqual({ inflation: false });
    const across = posRemainderNext(first.state, later, reads(400_000_900_000_000n), T + 8 * D);
    const d = JSON.parse(String(across.row!.params[3]));
    expect(across.row!.params[1]).toBe('idle');
    expect(d).toMatchObject({ judged: false, notJudged: 'halt', fromHeight: 8_200_000, halt: { lastBlock: 8_200_078 } });
    expect(across.state.last).toMatchObject({ height: 8_200_120 });
    expect(words(lineOf('pos_remainder', 'idle', d))).toBe('Not judged across a halt: Namada made no blocks from 7 Oct 2026, 10:12 UTC (block 8,200,078) to 8 Oct 2026, 17:03 UTC');
    // one epoch apart with no stretch between: the inflation is read, as before
    expect(posRemainderReads(first.state, rec({ height: 8_200_050, epoch: 2601 }))).toEqual({ inflation: true });
  });
});

describe('the shielded pool\'s daily ledger', () => {
  const scanOk = { behind: false, lagBlocks: 0, note: '' };
  // one epoch at both ends: no shielded-reward epoch starts in the day, so the ledger judges the moves alone
  const day = (dayStart: number): MaspDay => ({
    day: new Date(dayStart).toISOString().slice(0, 10), dayStart, dayEnd: dayStart + D,
    start: { ts: dayStart - MIN, nam: 1_000_000, epoch: 2741 }, end: { ts: dayStart + D - MIN, nam: 1_000_900, epoch: 2741 },
    legs: { shieldNam: 100, ibcInNam: 0, unshieldNam: 0, ibcOutNam: 0, feesNam: 0, moves: 3, otherKinds: [] },
  });
  const judge = (d: MaspDay, resumed: Record<number, number> | null | undefined) => {
    const s = maspLedgerCheck({ day: d, scan: scanOk, multiplier: 4, rewards: [], resumed }, d.dayEnd + 30_000);
    return { status: s.params[1] as string, detail: JSON.parse(String(s.params[3])) };
  };

  it('on the stretch after block 8,200,078: the day blocks were made again is not judged, the day after is', () => {
    const across = judge(day(Date.UTC(2026, 9, 8)), {});
    expect(across).toMatchObject({ status: 'idle', detail: { judged: false, notJudged: 'halt', halt: { lastBlock: 8_200_078 } } });
    expect(words(lineOf('masp_ledger', 'idle', across.detail))).toBe('8 Oct 2026: not judged across a halt: Namada made no blocks from 7 Oct 2026, 10:12 UTC (block 8,200,078) to 8 Oct 2026, 17:03 UTC');
    expect(judge(day(Date.UTC(2026, 9, 9)), {}).detail).toMatchObject({ judged: true });
  });

  it('on the current stretch: with its end measured, the day is not judged; with no end measured yet, as before; with the end unread, tried again', () => {
    const DAY = Date.UTC(2026, 10, 11);
    expect(judge(day(DAY), { 8_517_986: DAY + 14 * H }).detail).toMatchObject({ notJudged: 'halt', halt: { lastBlock: 8_517_986, resumedAt: DAY + 14 * H } });
    expect(judge(day(DAY + D), { 8_517_986: DAY + 14 * H }).detail).toMatchObject({ judged: true });
    expect(judge(day(DAY), {}).detail).toMatchObject({ judged: true });
    const unread = judge(day(DAY), null);
    expect(unread).toMatchObject({ status: 'idle', detail: { judged: false, notJudged: 'halt-unread', retry: true } });
    expect(words(lineOf('masp_ledger', 'idle', unread.detail))).toBe('11 Nov 2026: not judged yet, the time blocks were made again after a halt could not be read; tried again');
  });

  it('a day on which nothing happened is said as before, whatever is known of the end', () => {
    const DAY = Date.UTC(2026, 10, 11);
    const still: MaspDay = { ...day(DAY), end: { ts: DAY + D - MIN, nam: 1_000_000, epoch: 2741 }, legs: { shieldNam: 0, ibcInNam: 0, unshieldNam: 0, ibcOutNam: 0, feesNam: 0, moves: 0, otherKinds: [] } };
    for (const resumed of [null, {}, { 8_517_986: DAY + 14 * H }]) expect(judge(still, resumed).detail, JSON.stringify(resumed)).toMatchObject({ notJudged: 'nothing-happened' });
  });
});

describe('the ends the digest takes', () => {
  const row = (lastBlock: number, ts: number) => ({ key: resumedKv(lastBlock), value: JSON.stringify({ height: lastBlock + 2, ts }) });
  const AGAIN = Date.UTC(2026, 10, 11, 14, 0, 7);
  it('a recorded end is taken; with the scan past the stretch and no end that can be one, none can be relied on', () => {
    expect(measuredEnds([row(8_517_986, AGAIN)], '8518100')).toEqual({ 8_517_986: AGAIN });
    // the scan still at the stretch: nothing is past it, the lines judge as before
    expect(measuredEnds([], '8517986')).toEqual({});
    // past it with no record, or with a record of the block agreed on seconds after the last one: not relied on
    expect(measuredEnds([], '8517987')).toBeNull();
    expect(measuredEnds([row(8_517_986, Date.UTC(2026, 10, 2, 22, 49, 51))], '8518100')).toBeNull();
    // a read that failed: the rows, or the cursor
    expect(measuredEnds(null, '8518100')).toBeNull();
    expect(measuredEnds([row(8_517_986, AGAIN)], undefined)).toEqual({ 8_517_986: AGAIN });
    expect(measuredEnds([], undefined)).toBeNull();
  });
});

describe('the digest\'s two balance lines', () => {
  it('a base and a reading on either side of a stretch: the change is said, not judged as matching or differing', async () => {
    const db = testD1();
    seedSurvey(db);
    const fig = toMessageFigures(await readDigestFigures(db, SURVEY_T, 'daily'));
    const plain = words(JSON.stringify(renderShared(fig, SURVEY_T, 'daily').embed));
    expect(plain).toMatch(/Escrow [^"]*\((matches|differs by [^)]*)\)/);
    // the same figures, their base and reading moved to either side of the stretch after block 8,200,078
    const moved = JSON.parse(JSON.stringify(fig));
    for (const m of [moved.bridge.value.escrow, moved.masp.value.balance]) { m.bases[0].base.at = Date.UTC(2026, 9, 8, 8); m.at = Date.UTC(2026, 9, 9, 8); }
    const said = words(JSON.stringify(renderShared(moved, SURVEY_T, 'daily').embed));
    const across = '(not judged across a halt: Namada made no blocks from 7 Oct 2026, 10:12 UTC (block 8,200,078) to 8 Oct 2026, 17:03 UTC)';
    expect(said.split(across).length - 1).toBe(2);
    expect(said).not.toContain('shielded rewards accrue');

    // the measured ends could not be read: a pair reaching past the current stretch's last block is said as not judged
    const unread = JSON.parse(JSON.stringify(fig));
    unread.resumed = null;
    for (const m of [unread.bridge.value.escrow, unread.masp.value.balance]) { m.bases[0].base.at = Date.UTC(2026, 10, 11, 8); m.at = Date.UTC(2026, 10, 12, 8); }
    const unknown = words(JSON.stringify(renderShared(unread, SURVEY_T, 'daily').embed));
    expect(unknown.split('(not judged: the time blocks were made again after a halt could not be read)').length - 1).toBe(2);
    // and a pair wholly before it is judged as before
    const before = JSON.parse(JSON.stringify(fig));
    before.resumed = null;
    expect(words(JSON.stringify(renderShared(before, SURVEY_T, 'daily').embed))).toMatch(/Escrow [^"]*\((matches|differs by [^)]*)\)/);
  });
});

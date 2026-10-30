// The stream-share check (scale plan, Stage 1 item 7): how much of the last 24 h of Osmosis moves reached the site only
// through the five-minute catch-up search (meta.via 'catch-up search', live-hub.ts sweepOsmosis) and not the live
// stream. The plan's critic measured 8% on 23 Oct, 13% on 28 Oct and 17% on 29 Oct (31 of 181 rows). The check passes
// under 5%, has nothing to compare on a day with no Osmosis move (never 0%) or with too few to judge (under 21, where
// one move found late would be 5% or more by itself), shows a share that passes under the line, never at it (review of
// 2026-10-29: 9 of 181 read "5.0%" while it passed), runs hourly with one read of the day's rows
// by time (flows_ts), and says its cadence, so the Status page reads "no recent result" only once an hourly run is
// missed. The cron's tick also records its completion for the operator's incidents (worker/src/ops.ts); a tick the lock
// skips records nothing. Fetch is stubbed: every host answers 503.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { kvJson, stubDiscord, tick } from './digest-net';
import { streamShareCheck, streamShareDue, takeTickLock, STREAM_SHARE_SQL, STREAM_SHARE_EVERY_MS, STREAM_SHARE_MIN_FLOWS, STREAM_SHARE_OK_PCT } from '../worker/src/cron';
import { checkOf, CHECK_STALE_MS } from '../worker/src/api';
import { checkStaleMs } from '../worker/src/digest/freshness';
import { shapeChecks } from '../worker/src/digest/operator';
import { SQL } from '../worker/src/digest/sql';
import { answered, digestWindow } from '../worker/src/digest/types';
import { checkDetail, checkTitle, CHECK_TITLES } from '../web/src/lib/prov';
import { BANNED } from './banned-words';
import { OPS_KV } from '../worker/src/ops';
import type { Check } from '../shared/types';

const T = Date.UTC(2026, 9, 29, 20, 0, 30);
const MIN = 60_000, H = 60 * MIN;
const flow = (id: string, ts: number, chain: 'osmosis' | 'namada', via: string | null, extra: Record<string, unknown> = {}) => ({
  id: `${chain}:${id}:0`, chain, height: 1, ts, tx_hash: id, kind: 'buy', from_addr: chain === 'osmosis' ? 'osmo1pool' : 'tnam1qpool', to_addr: chain === 'osmosis' ? 'osmo1buyer' : 'tnam1qbuyer',
  amount_num: 10_000, meta: JSON.stringify({ tsSource: 'block', ...(via ? { via } : {}), ...extra }),
});
/** The day of 29 Oct as the critic counted it: 181 Osmosis rows, 31 of them found by the catch-up search. */
function day(db: TestD1, now: number) {
  const rows = Array.from({ length: 181 }, (_, i) => flow(`O${i}`, now - 23 * H + i * 7 * MIN, 'osmosis', i < 31 ? 'catch-up search' : null));
  insert(db, 'flows', [
    ...rows,
    // a Namada move found late by a scan that was behind is another chain's
    flow('N1', now - H, 'namada', 'late scan'), flow('N2', now - H, 'namada', null),
    // outside the 24 h, and a row with no meta (written by the stream, as an old row may be)
    flow('OLD', now - 25 * H, 'osmosis', 'catch-up search'),
    { ...flow('BARE', now - 2 * H, 'osmosis', null), meta: null },
  ]);
}
const c = (detail: Record<string, unknown>, status: Check['status'] = 'ok'): Check => ({ key: 'osmosis_stream_share', status, title: '', detail, checkedAt: 0 });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the stream-share check: math and status', () => {
  it('17.13% of 181 (29 Oct) needs a look; under 5% passes; exactly 5% does not; a day with no move, or too few, is idle, never 0%', () => {
    const at = (n: number, late: number) => { const s = streamShareCheck(n, late, T); return { status: s.params[1], detail: JSON.parse(String(s.params[3])) }; };
    expect(at(181, 31)).toEqual({ status: 'warn', detail: { flows: 181, catchUp: 31, sharePct: 17.13, okBelowPct: STREAM_SHARE_OK_PCT, minFlows: 21, windowHours: 24, everyMs: H, from: T - 24 * H, to: T } });
    expect(at(200, 9)).toMatchObject({ status: 'ok', detail: { sharePct: 4.5 } });
    expect(at(100, 5)).toMatchObject({ status: 'warn', detail: { sharePct: 5 } });
    // judged on the share itself; a share that passes is written cut, never as the line (4.999% is 4.99, not 5)
    expect(at(100_000, 4_999)).toMatchObject({ status: 'ok', detail: { sharePct: 4.99 } });
    expect(at(181, 9)).toMatchObject({ status: 'ok', detail: { sharePct: 4.97 } });
    expect(at(0, 0)).toEqual({ status: 'idle', detail: { flows: 0, catchUp: 0, sharePct: null, okBelowPct: 5, minFlows: 21, windowHours: 24, everyMs: H, from: T - 24 * H, to: T, noFlows: true } });
    // 21 moves: the fewest of which one found late is under 5% (1 of 20 would be 5% by itself)
    expect(STREAM_SHARE_MIN_FLOWS).toBe(21);
    expect(at(20, 1)).toMatchObject({ status: 'idle', detail: { flows: 20, catchUp: 1, sharePct: 5, tooFew: true } });
    expect(at(1, 1)).toMatchObject({ status: 'idle', detail: { tooFew: true } });
    expect(at(21, 1)).toMatchObject({ status: 'ok', detail: { sharePct: 4.76 } });
    expect(at(21, 1).detail.tooFew).toBeUndefined();
    expect(at(21, 2)).toMatchObject({ status: 'warn' });
    expect(streamShareCheck(181, 31, T).params[0]).toBe('osmosis_stream_share');
  });

  it('the read counts the Osmosis rows of the 24 h and those the catch-up search wrote, on flows_ts', () => {
    const db = testD1();
    day(db, T);
    expect(db.raw.prepare(STREAM_SHARE_SQL).get(T - 24 * H, T)).toEqual({ n: 182, late: 31, repaired: 0 });
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${STREAM_SHARE_SQL}`).all(T - 24 * H, T) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/SEARCH flows USING INDEX flows_ts \(ts>\? AND ts<\?\)/);
    expect(testD1().raw.prepare(STREAM_SHARE_SQL).get(T - 24 * H, T)).toEqual({ n: 0, late: 0, repaired: 0 });
  });

  it('a move a history repair wrote (scripts/backfill-osmosis.ts) is neither the stream\'s nor the catch-up\'s: counted apart (merged stage 1 review)', () => {
    const db = testD1();
    day(db, T);
    // 30 moves neither the stream nor the catch-up search found, written by a repair: before, they read as heard live
    insert(db, 'flows', Array.from({ length: 30 }, (_, i) => flow(`R${i}`, T - 3 * H + i * MIN, 'osmosis', 'history repair')));
    expect(db.raw.prepare(STREAM_SHARE_SQL).get(T - 24 * H, T)).toEqual({ n: 182, late: 31, repaired: 30 });
    const d = JSON.parse(String(streamShareCheck(182, 31, T, 30).params[3]));
    expect(d).toMatchObject({ flows: 182, catchUp: 31, repaired: 30 });
    expect(checkDetail(c(d, 'warn'))).toMatch(/; 30 more moves written by a history repair are not counted$/);
    expect(JSON.parse(String(streamShareCheck(182, 31, T).params[3])).repaired).toBeUndefined();
  });

  it('runs hourly: never run, or its last run an hour old', () => {
    expect(streamShareDue(null, T)).toBe(true);
    expect(streamShareDue(T - STREAM_SHARE_EVERY_MS + 1, T)).toBe(false);
    expect(streamShareDue(T - STREAM_SHARE_EVERY_MS, T)).toBe(true);
  });
});

describe('the stream-share check: words and staleness', () => {
  it('a plain title and one line of what it found, in the words the site uses elsewhere', () => {
    expect(CHECK_TITLES.osmosis_stream_share).toBe('Osmosis moves reach this site as they happen');
    expect(checkTitle({ key: 'osmosis_stream_share' })).toBe(CHECK_TITLES.osmosis_stream_share);
    const line = (n: number, late: number) => checkDetail(c(JSON.parse(String(streamShareCheck(n, late, T).params[3]))));
    const d = JSON.parse(String(streamShareCheck(181, 31, T).params[3]));
    expect(checkDetail(c(d, 'warn'))).toBe('17.1% found late: 31 of 181 Osmosis moves in the last 24 h were not heard live; the five-minute catch-up found them');
    // one found late is "was ... it"; none is said as such, not as 0.0% of them not heard live
    expect(line(181, 1)).toBe('0.6% found late: 1 of 181 Osmosis moves in the last 24 h was not heard live; the five-minute catch-up found it');
    expect(line(181, 0)).toBe('None found late: all 181 Osmosis moves in the last 24 h were heard live');
    // a share that passes never reads as the line, and one that is not nothing never reads 0.0%
    expect(line(181, 9)).toBe('4.97% found late: 9 of 181 Osmosis moves in the last 24 h were not heard live; the five-minute catch-up found them');
    expect(line(100_000, 4_999)).toMatch(/^4\.99% found late: 4,999 of 100,000 /);
    expect(line(3_000, 1)).toMatch(/^0\.033% found late: 1 of 3,000 /);
    expect(line(100, 5)).toMatch(/^5\.0% found late: 5 of 100 /);
    // too few to judge: the counts, not a share
    expect(line(7, 1)).toBe('Too few to judge: 7 Osmosis moves in the last 24 h, 1 found late; the share is judged from 21 moves');
    expect(line(1, 0)).toBe('Too few to judge: 1 Osmosis move in the last 24 h, none found late; the share is judged from 21 moves');
    expect(checkDetail(c(JSON.parse(String(streamShareCheck(0, 0, T).params[3])), 'idle'))).toBe('No Osmosis move in the last 24 h to compare');
    expect(checkDetail(c({}))).toBeNull();
    // counts that cannot be (more found late than moves) say nothing rather than a share over 100%
    expect(checkDetail(c({ flows: 10, catchUp: 11 }))).toBeNull();
    for (const s of [CHECK_TITLES.osmosis_stream_share, checkDetail(c(d))!, line(181, 1)!, line(181, 0)!, line(7, 1)!, checkDetail(c({ noFlows: true }))!]) expect(s).not.toMatch(BANNED);
  });

  it('is current for twice its hour, where a check run every tick is stale after 15 min', () => {
    const row = (age: number, detail: Record<string, unknown>) => ({ key: 'osmosis_stream_share', status: 'warn', title: 't', detail: JSON.stringify(detail), checked_at: T - age });
    expect(checkStaleMs(H)).toBe(2 * H);
    expect(checkStaleMs(null)).toBe(CHECK_STALE_MS);
    expect(checkStaleMs('x')).toBe(CHECK_STALE_MS);
    expect(checkOf(row(90 * MIN, { everyMs: H }), T).status).toBe('warn');
    expect(checkOf(row(2 * H + 1, { everyMs: H }), T).status).toBe('stale');
    expect(checkOf(row(CHECK_STALE_MS + 1, {}), T).status).toBe('stale');
    // a cadence shorter than the rule never makes a check stale sooner
    expect(checkOf(row(CHECK_STALE_MS, { everyMs: 1000 }), T).status).toBe('warn');
  });

  it("the digest's operator embed judges it the same way: passing 50 min after its run, not run past two hours", () => {
    const reads = (age: number) => ({ checks: answered([
      { key: 'osmosis_stream_share', status: 'ok', checked_at: T - age, every_ms: H },
      { key: 'rpc_consensus', status: 'ok', checked_at: T - age, every_ms: null },
    ]) }) as any;
    expect(shapeChecks(reads(50 * MIN), digestWindow(T, 'daily')).value).toMatchObject({ ok: 1, total: 2, notPassing: [{ key: 'rpc_consensus', stale: true }] });
    expect(shapeChecks(reads(2 * H + 1), digestWindow(T, 'daily')).value).toMatchObject({ ok: 0, notPassing: [{ key: 'osmosis_stream_share', stale: true }, { key: 'rpc_consensus', stale: true }] });
    // the read takes the cadence from the detail, and a detail that is not JSON never fails it
    const db = testD1();
    insert(db, 'checks', [
      { key: 'osmosis_stream_share', status: 'ok', title: 't', detail: JSON.stringify({ everyMs: H }), checked_at: T },
      { key: 'old_row', status: 'ok', title: 't', detail: 'not json', checked_at: T },
    ]);
    expect(db.raw.prepare(SQL.checks).all()).toEqual([
      { key: 'osmosis_stream_share', status: 'ok', checked_at: T, every_ms: H },
      { key: 'old_row', status: 'ok', checked_at: T, every_ms: null },
    ]);
  });
});

describe('the cron tick', () => {
  it('writes the check on its first tick and again an hour later, not every minute, and records each completed tick; a skipped tick records none', { timeout: 120_000 }, async () => {
    stubDiscord();
    const db = testD1();
    day(db, T);
    const env = { DB: db } as any;
    const checkedAt = () => (db.raw.prepare("SELECT checked_at, status FROM checks WHERE key = 'osmosis_stream_share'").get() as { checked_at: number; status: string } | undefined);
    await tick(env, T);
    expect(checkedAt()).toEqual({ checked_at: T, status: 'warn' });
    const first = kvJson(db, OPS_KV).lastTickAt;
    expect(first).toBeGreaterThanOrEqual(T);
    await tick(env, T + MIN);
    expect(checkedAt()!.checked_at).toBe(T);
    expect(kvJson(db, OPS_KV).lastTickAt).toBeGreaterThanOrEqual(T + MIN);
    await tick(env, T + H);
    expect(checkedAt()!.checked_at).toBe(T + H);
    // another tick holds the lock: this one does nothing, so it completes no tick
    const before = kvJson(db, OPS_KV).lastTickAt;
    expect(await takeTickLock(db as any, 'held', T + H + MIN)).toBe(true);
    await tick(env, T + H + MIN + 1000);
    expect(kvJson(db, OPS_KV).lastTickAt).toBe(before);
  });
});

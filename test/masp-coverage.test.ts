// masp_tx_coverage (2026-11-07): this site's record of shielded transactions against Namada's shielded-transaction
// indexer (masp.namada.net), on real answers of both: the block_results of blocks 8,515,196, 8,515,250, 7,903,391 and
// 8,512,781 from namada-rpc.stakeandrelax.net and the indexer's /api/v1/tx answers for the same blocks (fixtures
// masp_block_*.json, masp_indexer_tx_*.json, read 2026-11-07, nothing stripped). The live hub records what a block's
// results name (worker/src/masp-seen.ts, migration 0021 masp_seen); the hourly check (worker/src/cron.ts
// maspCoverageCheck) names what the indexer lists and this site lacks, by block, transaction and batch index only.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { maspSeenOf, maspSeenStmts, seenKey, MASP_SEEN_RANGE_SQL } from '../worker/src/masp-seen';
import { maspIndexerHeight, maspIndexerTxs, parseMaspIndexerTxs, MASP_INDEXER_HEALTH, MASP_INDEXER_MAX_HEIGHTS } from '../worker/src/sources/masp-indexer';
import { maspCoverageCheck, maspCoverageIdle, maspCoverageWindow, maspCoverageDue, MASP_COVERAGE_EVERY_MS, MASP_COVERAGE_MISSES_KEPT } from '../worker/src/cron';
import { checkOf } from '../worker/src/api';
import { checkDetail, CHECK_TITLES } from '../web/src/lib/prov';
import { MASP_INDEXER, NAMADA } from '../worker/src/config';
import { BANNED } from './banned-words';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { Check } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const BLOCKS = { 8515196: fx('masp_block_8515196.json'), 8515250: fx('masp_block_8515250.json'), 7903391: fx('masp_block_7903391.json'), 8512781: fx('masp_block_8512781.json') } as Record<number, any>;
/** A block as sources/namada.ts blockResults hands it to the hub: every event of the answer, in one list. */
const blockOf = (height: number, ts = 0) => {
  const r = BLOCKS[height].result;
  return { height, ts, events: [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])] };
};
const MIN = 60_000, H = 3600_000;
const lineOf = (s: { params: unknown[] }) => checkDetail({ key: String(s.params[0]), status: s.params[1] as Check['status'], title: '', detail: JSON.parse(String(s.params[3])), checkedAt: Number(s.params[4]) });
const statusOf = (s: { params: unknown[] }) => s.params[1] as string;
const detailOf = (s: { params: unknown[] }) => JSON.parse(String(s.params[3])) as Record<string, unknown>;
const servedAt = (s: { params: unknown[] }, at: number) => checkOf({ key: s.params[0], status: s.params[1], title: s.params[2], detail: s.params[3], checked_at: s.params[4] }, at).status;

describe('what a block\'s results name (masp-seen.ts)', () => {
  it('reads the indexed-tx of each masp event, once: a fee payment at (0, 0), one at transaction 1 of its block, a transfer at batch index 1', () => {
    expect(maspSeenOf(blockOf(8515250))).toEqual({ seen: [{ height: 8515250, blockIndex: 0, batchIndex: 0, kind: 'fee-payment' }], refused: 0 });
    expect(maspSeenOf(blockOf(8515196))).toEqual({ seen: [{ height: 8515196, blockIndex: 0, batchIndex: 0, kind: 'fee-payment' }], refused: 0 });
    expect(maspSeenOf(blockOf(7903391))).toEqual({ seen: [{ height: 7903391, blockIndex: 1, batchIndex: 0, kind: 'fee-payment' }], refused: 0 });
    expect(maspSeenOf(blockOf(8512781))).toEqual({ seen: [{ height: 8512781, blockIndex: 0, batchIndex: 1, kind: 'transfer' }], refused: 0 });
    // a block without a masp event names nothing
    expect(maspSeenOf({ height: 1, ts: 0, events: [{ type: 'token/transfer', attributes: [] }] })).toEqual({ seen: [], refused: 0 });
  });
  it('one inner transaction named by both events is one row; an index that does not parse or names another block is refused, never guessed', () => {
    const ev = (type: string, idx: unknown) => ({ type, attributes: [{ key: 'indexed-tx', value: typeof idx === 'string' ? idx : JSON.stringify(idx) }] });
    const both = maspSeenOf({ height: 10, ts: 0, events: [ev('masp/fee-payment', { block_height: 10, block_index: 0, batch_index: 0 }), ev('masp/transfer', { block_height: 10, block_index: 0, batch_index: 0 }), ev('masp/transfer', { block_height: 10, block_index: 0, batch_index: 2 })] });
    expect(both).toEqual({ seen: [{ height: 10, blockIndex: 0, batchIndex: 0, kind: 'fee-payment+transfer' }, { height: 10, blockIndex: 0, batchIndex: 2, kind: 'transfer' }], refused: 0 });
    const bad = maspSeenOf({ height: 10, ts: 0, events: [ev('masp/transfer', 'not json'), ev('masp/transfer', { block_height: 11, block_index: 0, batch_index: 0 }), ev('masp/transfer', { block_height: 10, block_index: -1, batch_index: 0 }), { type: 'masp/transfer', attributes: [] }] });
    expect(bad).toEqual({ seen: [], refused: 4 });
    // 24 rows a statement, 4 parameters each
    const stmts = maspSeenStmts(Array.from({ length: 50 }, (_, i) => ({ height: 1, blockIndex: i, batchIndex: 0, kind: 'transfer' })));
    expect(stmts.map((s) => s.params.length)).toEqual([96, 96, 8]);
    expect(stmts[0].sql).toMatch(/^INSERT OR IGNORE INTO masp_seen/);
  });
});

describe('the indexer\'s answers (sources/masp-indexer.ts)', () => {
  const page = fx('masp_indexer_tx_8515150_100.json');
  it('lists each inner transaction by its place on the chain, the bytes left unread, and the index names agree with the chain\'s own events on every block checked', () => {
    expect(parseMaspIndexerTxs(page, 8515150, 8515250)).toEqual([
      { height: 8515196, blockIndex: 0, batchIndex: 0, feePayment: true },
      { height: 8515250, blockIndex: 0, batchIndex: 0, feePayment: true },
    ]);
    // masp_tx_index is the batch index and block_index the transaction's index in the block: the same key as the chain's indexed-tx
    for (const [h, name] of [[7903391, 'masp_indexer_tx_7903391.json'], [8512781, 'masp_indexer_tx_8512781.json']] as const) {
      const listed = parseMaspIndexerTxs(fx(name), h, h).map((t) => seenKey(t.height, t.blockIndex, t.batchIndex));
      const seen = maspSeenOf(blockOf(h)).seen.map((s) => seenKey(s.height, s.blockIndex, s.batchIndex));
      expect(listed, name).toEqual(seen);
    }
    expect(parseMaspIndexerTxs(fx('masp_indexer_tx_7903391.json'), 7903391, 7903391)).toEqual([{ height: 7903391, blockIndex: 1, batchIndex: 0, feePayment: true }]);
    expect(parseMaspIndexerTxs(fx('masp_indexer_tx_8512781.json'), 8512781, 8512781)).toEqual([{ height: 8512781, blockIndex: 0, batchIndex: 1, feePayment: false }]);
    for (const h of [8515196, 8515250]) expect(parseMaspIndexerTxs(page, 8515150, 8515250).filter((t) => t.height === h).map((t) => seenKey(t.height, t.blockIndex, t.batchIndex))).toEqual(maspSeenOf(blockOf(h)).seen.map((s) => seenKey(s.height, s.blockIndex, s.batchIndex)));
  });
  it('refuses an answer of another shape, or one listing a block outside the window', () => {
    expect(() => parseMaspIndexerTxs(page, 8515200, 8515250)).toThrow(/outside blocks 8515200 to 8515250/);
    expect(() => parseMaspIndexerTxs({ txs: 'x' }, 1, 2)).toThrow(/without a txs list/);
    expect(() => parseMaspIndexerTxs({ txs: [{ block_height: 1, batch: [] }] }, 1, 2)).toThrow(/without its block height, block index or batch/);
    expect(() => parseMaspIndexerTxs({ txs: [{ block_height: 1, block_index: 0, batch: [{ is_masp_fee_payment: false }] }] }, 1, 2)).toThrow(/without its batch index/);
    expect(parseMaspIndexerTxs({ txs: [] }, 1, 2)).toEqual([]);
  });
  it('asks the two routes as the service takes them, and a range past its last transaction is the error it answers (HTTP 500), never a judgement', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      asked.push(url);
      if (url.endsWith('/api/v1/height')) return Response.json({ block_height: 8517143 });
      if (url.includes('height=8515150&height_offset=100')) return Response.json(page);
      if (url.includes('height=8517144')) return new Response(JSON.stringify(fx('masp_indexer_past_tip.json')), { status: 500 });
      return new Response('not here', { status: 404 });
    }));
    expect(await maspIndexerHeight()).toBe(8517143);
    expect(asked[0]).toBe(`${MASP_INDEXER}/api/v1/height`);
    expect(await maspIndexerTxs(8515150, 8515250)).toHaveLength(2);
    expect(asked[1]).toBe(`${MASP_INDEXER}/api/v1/tx?height=8515150&height_offset=100`);
    await expect(maspIndexerTxs(8517144, 8517154)).rejects.toThrow(/HTTP 500/);
    await expect(maspIndexerTxs(1, MASP_INDEXER_MAX_HEIGHTS + 1)).rejects.toThrow(/over the 3000 one read asks for/);
    await expect(maspIndexerTxs(10, 9)).rejects.toThrow(/not a window/);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ height: 1 })));
    await expect(maspIndexerHeight()).rejects.toThrow(/without a block height/);
  });
});

// ---------------------------------------------------------------- the hub records what it sees

const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const seenRows = (db: TestD1) => db.raw.prepare('SELECT height, block_index, batch_index, kind FROM masp_seen ORDER BY height, block_index, batch_index').all();

describe('the live hub records every shielded transaction a block\'s results name', () => {
  it('scanning the real blocks 8,515,196 to 8,515,250 writes their two fee payments to masp_seen beside the blocks\' rows', async () => {
    const db = testD1();
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', '8515195', 0)").run();
    const HEAD = 8515250;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(HEAD), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.pathname === '/blockchain') {
        const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), HEAD);
        const metas = [];
        for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date(Date.now() - (HEAD - h) * 6000).toISOString() }, num_txs: '0' });
        return Response.json({ result: { last_height: String(HEAD), block_metas: metas } });
      }
      if (url.pathname === '/block_results') {
        const h = Number(url.searchParams.get('height'));
        if (BLOCKS[h]) return Response.json(BLOCKS[h]);
        return Response.json({ result: { height: String(h), end_block_events: [] } });
      }
      // the block's transaction bytes are not served: the hub reads what it can from the events and goes on
      throw new Error(`not served: ${url.pathname}`);
    }));
    await hubOf(db).scanNamada();
    expect(db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get().value).toBe(String(HEAD));
    expect(seenRows(db)).toEqual([
      { height: 8515196, block_index: 0, batch_index: 0, kind: 'fee-payment' },
      { height: 8515250, block_index: 0, batch_index: 0, kind: 'fee-payment' },
    ]);
    // the same block read again changes nothing
    await runStmts(db, maspSeenStmts(maspSeenOf(blockOf(8515250)).seen));
    expect(seenRows(db)).toHaveLength(2);
    expect((await db.prepare(MASP_SEEN_RANGE_SQL).bind(8515196, 8515249).all()).results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the hourly check

describe('masp_tx_coverage: the window and the row', () => {
  const NOW = Date.UTC(2026, 10, 7, 12, 0);
  const page = parseMaspIndexerTxs(fx('masp_indexer_tx_8515150_100.json'), 8515150, 8515250);
  const seen = (...heights: number[]) => heights.map((h) => ({ height: h, block_index: 0, batch_index: 0 }));

  it('judges from the block after the last judged to the lowest of the scan\'s cursor, the block below the indexer\'s last transaction and 3,000 blocks on', () => {
    expect(maspCoverageWindow(null, 8515250, 8517143)).toEqual({ idle: 'first-run' });
    expect(maspCoverageWindow(null, null, 8517143)).toEqual({ idle: 'no-cursor' });
    expect(maspCoverageWindow({ judgedTo: 8515149, at: 0 }, 8515250, 8517143)).toEqual({ from: 8515150, to: 8515250 });
    expect(maspCoverageWindow({ judgedTo: 8515149, at: 0 }, 8517986, 8517143)).toEqual({ from: 8515150, to: 8517142 });
    expect(maspCoverageWindow({ judgedTo: 8500000, at: 0 }, 8517986, 8517143)).toEqual({ from: 8500001, to: 8500001 + MASP_INDEXER_MAX_HEIGHTS - 1 });
    // the halt: no block scanned since the last run
    expect(maspCoverageWindow({ judgedTo: 8517986, at: 0 }, 8517986, 8517143)).toEqual({ idle: 'no-new-heights' });
    // the indexer's last transaction below the blocks waiting
    expect(maspCoverageWindow({ judgedTo: 8517500, at: 0 }, 8517986, 8517143)).toEqual({ idle: 'indexer-behind' });
    expect(maspCoverageDue(null, NOW)).toBe(true);
    expect(maspCoverageDue(NOW - 59 * MIN, NOW)).toBe(false);
    expect(maspCoverageDue(NOW - MASP_COVERAGE_EVERY_MS, NOW)).toBe(true);
  });

  it('every transaction the indexer lists on record: a pass naming the blocks; hourly, current at 61 minutes and stale past two hours', () => {
    const s = maspCoverageCheck({ from: 8515150, to: 8515250 }, page, seen(8515196, 8515250), { cursor: 8515250, indexerHeight: 8517143 }, NOW);
    expect(statusOf(s)).toBe('ok');
    expect(detailOf(s)).toEqual({ everyMs: MASP_COVERAGE_EVERY_MS, judged: true, from: 8515150, to: 8515250, blocks: 101, indexerTxs: 2, feePayments: 2, seen: 2, onlyHere: 0, missing: 0, misses: [], cursor: 8515250, indexerHeight: 8517143 });
    expect(lineOf(s)).toBe("All 2 shielded transactions the indexer lists for blocks 8,515,150 to 8,515,250 are in this site's record");
    expect(servedAt(s, NOW + 61 * MIN)).toBe('ok');
    expect(servedAt(s, NOW + 2 * H + MIN)).toBe('stale');
    const one = maspCoverageCheck({ from: 8515200, to: 8515250 }, page.filter((t) => t.height === 8515250), seen(8515250), { cursor: 8515250, indexerHeight: 8517143 }, NOW);
    expect(lineOf(one)).toBe("The one shielded transaction the indexer lists for blocks 8,515,200 to 8,515,250 is in this site's record");
    const none = maspCoverageCheck({ from: 8516000, to: 8516500 }, [], [], { cursor: 8516500, indexerHeight: 8517143 }, NOW);
    expect(statusOf(none)).toBe('ok');
    expect(lineOf(none)).toBe("No shielded transaction in blocks 8,516,000 to 8,516,500, in the indexer's record or this site's");
  });

  it('a transaction the indexer lists and this site lacks needs a look, named by block, transaction and batch index only; one this site has and the indexer does not is counted, not a miss', () => {
    const s = maspCoverageCheck({ from: 8515150, to: 8515250 }, page, [...seen(8515196), { height: 8515200, block_index: 0, batch_index: 0 }], { cursor: 8515250, indexerHeight: 8517143 }, NOW);
    expect(statusOf(s)).toBe('warn');
    expect(detailOf(s)).toMatchObject({ judged: true, indexerTxs: 2, seen: 2, onlyHere: 1, missing: 1, misses: [{ height: 8515250, blockIndex: 0, batchIndex: 0 }] });
    expect(JSON.stringify(detailOf(s))).not.toMatch(/bytes|tnam1|amount/);
    expect(lineOf(s)).toBe("1 of 2 shielded transactions the indexer lists for blocks 8,515,150 to 8,515,250 is not in this site's record: block 8,515,250, transaction 0, batch 0");
    // many misses: three named, the rest counted, at most MASP_COVERAGE_MISSES_KEPT kept in the detail
    const many = Array.from({ length: 60 }, (_, i) => ({ height: 8515150 + i, blockIndex: 0, batchIndex: i % 2, feePayment: false }));
    const m = maspCoverageCheck({ from: 8515150, to: 8515250 }, many, [], { cursor: 8515250, indexerHeight: 8517143 }, NOW);
    expect(statusOf(m)).toBe('warn');
    expect((detailOf(m).misses as unknown[]).length).toBe(MASP_COVERAGE_MISSES_KEPT);
    expect(lineOf(m)).toBe("60 of 60 shielded transactions the indexer lists for blocks 8,515,150 to 8,515,250 are not in this site's record: block 8,515,150, transaction 0, batch 0; block 8,515,151, transaction 0, batch 1; block 8,515,152, transaction 0, batch 0; and 57 more");
  });

  it('on the D1 stand-in: the rows the hub wrote, read by the window, against the indexer\'s page', async () => {
    const db = testD1();
    await runStmts(db, maspSeenStmts([...maspSeenOf(blockOf(8515196)).seen, ...maspSeenOf(blockOf(8515250)).seen]));
    const rows = (await db.prepare(MASP_SEEN_RANGE_SQL).bind(8515150, 8515250).all<{ height: number; block_index: number; batch_index: number }>()).results;
    expect(statusOf(maspCoverageCheck({ from: 8515150, to: 8515250 }, page, rows, { cursor: 8515250, indexerHeight: 8517143 }, NOW))).toBe('ok');
    insert(db, 'masp_seen', []);
    db.raw.prepare('DELETE FROM masp_seen WHERE height = 8515196').run();
    const less = (await db.prepare(MASP_SEEN_RANGE_SQL).bind(8515150, 8515250).all<{ height: number; block_index: number; batch_index: number }>()).results;
    const s = maspCoverageCheck({ from: 8515150, to: 8515250 }, page, less, { cursor: 8515250, indexerHeight: 8517143 }, NOW);
    expect(statusOf(s)).toBe('warn');
    expect(detailOf(s).misses).toEqual([{ height: 8515196, blockIndex: 0, batchIndex: 0 }]);
  });

  it('nothing to compare is idle with its reason: the first run, the halt, the indexer behind, no scan position', () => {
    const ctx = { cursor: 8517986, indexerHeight: 8517143, judgedTo: 8517986 };
    const first = maspCoverageIdle('first-run', { ...ctx, judgedTo: null }, NOW);
    expect(statusOf(first)).toBe('idle');
    expect(detailOf(first)).toMatchObject({ everyMs: MASP_COVERAGE_EVERY_MS, judged: false, notJudged: 'first-run', cursor: 8517986 });
    expect(lineOf(first)).toBe("This site's record of shielded transactions starts at block 8,517,986; the blocks after it are judged from the next hour");
    expect(lineOf(maspCoverageIdle('no-new-heights', ctx, NOW))).toBe('No block scanned since block 8,517,986: nothing new to compare');
    expect(lineOf(maspCoverageIdle('indexer-behind', { ...ctx, judgedTo: 8517500 }, NOW))).toBe("The indexer's last shielded transaction is at block 8,517,143, below the blocks waiting to be judged (from 8,517,501): nothing to compare yet");
    expect(lineOf(maspCoverageIdle('no-cursor', { ...ctx, cursor: null }, NOW))).toBe("This site's block scan has no position on record: nothing to compare");
    expect(servedAt(maspCoverageIdle('no-new-heights', ctx, NOW), NOW + 90 * MIN)).toBe('idle');
    expect(servedAt(maspCoverageIdle('no-new-heights', ctx, NOW), NOW + 2 * H + MIN)).toBe('stale');
    // the indexer not read: idle with the error, the hourly cadence, and no height (null, never 0)
    const down = maspCoverageIdle('indexer-not-read', { cursor: 8517986, indexerHeight: null, judgedTo: 8517986, error: 'HTTP 503' }, NOW);
    expect(statusOf(down)).toBe('idle');
    expect(detailOf(down)).toEqual({ everyMs: MASP_COVERAGE_EVERY_MS, judged: false, notJudged: 'indexer-not-read', cursor: 8517986, indexerHeight: null, judgedTo: 8517986, note: 'the indexer could not be read: nothing compared this hour (HTTP 503)' });
    expect(lineOf(down)).toBe('The indexer could not be read at the last try: nothing compared this hour');
    expect(lineOf(down)).not.toMatch(BANNED);
    expect(servedAt(down, NOW + 90 * MIN)).toBe('idle');
  });

  it('the title and every line read plain, and the source\'s row is named as the sheet shows it', () => {
    expect(CHECK_TITLES.masp_tx_coverage).toBe("Every shielded transaction Namada's shielded-transaction indexer lists for the blocks this site has scanned since this record began is in this site's record");
    expect(MASP_INDEXER_HEALTH).toBe('masp.namada.net (MASP transactions)');
    const lines = [
      lineOf(maspCoverageCheck({ from: 8515150, to: 8515250 }, page, seen(8515196, 8515250), { cursor: 8515250, indexerHeight: 8517143 }, NOW)),
      lineOf(maspCoverageCheck({ from: 8515150, to: 8515250 }, page, seen(8515196), { cursor: 8515250, indexerHeight: 8517143 }, NOW)),
      lineOf(maspCoverageIdle('first-run', { cursor: 1, indexerHeight: 2, judgedTo: null }, NOW)),
      lineOf(maspCoverageIdle('indexer-behind', { cursor: 10, indexerHeight: 5, judgedTo: 8 }, NOW)),
    ];
    for (const l of lines) { expect(l).toBeTruthy(); expect(l, l ?? '').not.toMatch(BANNED); }
    expect(CHECK_TITLES.masp_tx_coverage).not.toMatch(BANNED);
  });
});

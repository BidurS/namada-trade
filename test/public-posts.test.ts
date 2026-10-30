// The site's public posts (worker/src/public-posts.ts, sources/x.ts, sources/telegram.ts), scale plan Stage 1 item 3:
// at most one move a closed UTC hour on X and on the public Telegram channel, the hour's largest by dollars (a trade
// at its settle, else NAM times its stored price), read from the stored moves once the hour has settled, from $100
// and the chain's whale size, never a bot round trip, a rewards claim or a move whose dollars are not known, and
// beside it the hour's largest bridge crossing when the move is none, under its own share; a quiet hour posts
// nothing; an hour whose moves or settle quotes cannot be read waits; the moves never take the recap's place; a
// crossing is posted once across its two records; a post is built from the allowlist of a move's fields, so a memo, a
// tag, a forum text or a bridge receiver that is no address (an object's own key names too) never reaches it; a forum
// post reaches Telegram as its title and category alone, and a proposal reaches the channel as X posts it, as plain
// words. Fetch is stubbed: nothing reaches X or Telegram.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { readTo } from './hour-cover';
import { BANNED } from './banned-words';
import { rowToFlow } from '../worker/src/analytics';
import { configureAlerts, moveCard, resetClaimMemory } from '../worker/src/sources/discord';
import { hourText, postGovOnX, postHourCrossingOnX, postHourOnX, postRecapOnX, xLength, X_RECAP_HOUR_UTC, X_SHARES } from '../worker/src/sources/x';
import { forumMessage, hourMessage, sendTelegramForum, sendTelegramGov, sendTelegramHour, telegramRun } from '../worker/src/sources/telegram';
import { saveSettings, defaultPrefs } from '../worker/src/settings';
import {
  hourCovered, hourMoves, plainOutsider, publicHour, publicMoveOf, HOUR_MOVES_SQL, HOUR_SETTLE_MS, PUBLIC_HOUR_READ, PUBLIC_POST_USD_MIN, type NamFloors,
} from '../worker/src/public-posts';
import type { Flow, ForumPost, GovernanceProposal } from '../shared/types';

const KEYS = { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const TOKEN = '123:test-token';
const CHANNEL = '@NamadaTradeAlerts';
const FLOORS: NamFloors = { osmosis: 10000, namada: 10000 };
const SELLER = 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh';
const BUYER = 'osmo16u4xsll7kwgs9w8z6zy86z3galv7le4ywv5qmm';
const RECEIVER = 'osmo1khrd2gyj6hu2s6hh4kpgp42etgdfch3rtvmz82';
const NAMADA = 'tnam1qpjppur46s3ja5uwzsyamxwzvtwnkeeycyl472u3';
const H = 3_600_000;
const at = (h: number, m = 0, s = 0, ms = 0) => Date.UTC(2026, 9, 29, h, m, s, ms);
let t = 0;

const xEnv = (db: TestD1, extra: object = {}) => ({ DB: db, ...KEYS, ...extra }) as any;
const tgEnv = (db: TestD1, extra: object = {}) => ({ DB: db, SETTINGS_KEY: KEY, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL: CHANNEL, ...extra }) as any;
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

/** A database whose record is read on both chains past every hour these tests post (hourCovered). */
const indexed = () => { const db = testD1(); readTo(db, Date.UTC(2027, 0, 1)); return db; };

/** A stored move: a sale on Osmosis by default; `meta` as an object. */
let n = 0;
function move(db: TestD1, ts: number, extra: Record<string, unknown> = {}) {
  n++;
  const { meta, ...rest } = extra as { meta?: unknown };
  insert(db, 'flows', [{
    id: `osmosis:PP${n}:0`, chain: 'osmosis', height: 73_444_000 + n, ts, tx_hash: `PP${n}`, kind: 'sell', from_addr: SELLER, to_addr: null,
    amount_num: 1_000_000, pool_id: '3005', price_usd: 0.00015, value_usd: 150, meta: JSON.stringify(meta ?? { priceSource: 'spot' }), ...rest,
  }]);
  return `${rest.chain ?? 'osmosis'}:PP${n}:0`;
}

/** X and Telegram as stubs: every post's text, by where it went. */
function voices(answer: (url: string) => { status: number; json: any } | null = () => null) {
  const x: string[] = [];
  const tg: { chat: string; text: string; button?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const a = answer(url);
    if (a) return new Response(JSON.stringify(a.json), { status: a.status });
    if (url === 'https://api.x.com/2/tweets') { x.push(body.text); return new Response(JSON.stringify({ data: { id: String(x.length) } }), { status: 201 }); }
    if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/sendMessage`)) {
      tg.push({ chat: body.chat_id, text: body.text, button: body.reply_markup?.inline_keyboard?.[0]?.[0]?.url });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    throw new Error(`not stubbed: ${url}`);
  }));
  return { x, tg };
}

/** The tick's posts for the hour due at `now`, as the cron makes them (cron.ts syncIntelAndAlerts): X's move part's answer. */
async function tick(db: TestD1, now: number, tg = true) {
  t = now;
  const hour = publicHour(db as any, now, FLOORS);
  const r = await postHourOnX(xEnv(db), hour, now);
  await postHourCrossingOnX(xEnv(db), hour, now);
  if (tg) await sendTelegramHour(tgEnv(db), hour, telegramRun(10, 10_000));
  return r;
}

beforeEach(() => {
  t = at(9, 10);
  n = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts(KEY, true);
  resetClaimMemory();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the hour', () => {
  it('is the latest one closed HOUR_SETTLE_MS ago, keyed by its start', () => {
    const db = indexed();
    expect(HOUR_SETTLE_MS).toBe(10 * 60_000);
    expect(publicHour(db as any, at(9, 9, 59, 999), FLOORS)).toMatchObject({ start: at(7), end: at(8), key: '2026-10-29T07' });
    expect(publicHour(db as any, at(9, 10), FLOORS)).toMatchObject({ start: at(8), end: at(9), key: '2026-10-29T08' });
    expect(publicHour(db as any, at(10, 9, 59), FLOORS)).toMatchObject({ start: at(8), end: at(9) });
  });

  it('is read on one range of the flows_ts index, bounded by the hour and by PUBLIC_HOUR_READ', () => {
    const db = indexed();
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${HOUR_MOVES_SQL}`).all(at(8), at(9), 10000) as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan).toMatch(/SEARCH f USING INDEX flows_ts \(ts>\? AND ts<\?\)/);
    expect(plan).not.toMatch(/SCAN f\b/);
    expect(HOUR_MOVES_SQL).toContain(`LIMIT ${PUBLIC_HOUR_READ}`);
    expect(HOUR_MOVES_SQL).not.toMatch(/label|memo/i);
  });
});

describe('an hour the record does not hold whole yet (merged stage 1 review, 2026-10-29)', () => {
  // The hour was read once at HH:10 and claimed, posted or quiet, whatever the indexes had read: a 60,000 NAM sell the
  // stream missed at 08:58 and the catch-up search found at 09:13 was never posted, and a 12,000 NAM buy went out as
  // the hour's largest. The hour now waits, unclaimed, until both indexes are past its end.
  it('waits for the Osmosis catch-up search: nothing posted or claimed, then the move it found late is the one posted', async () => {
    const db = testD1();
    // the search's last finished read reached a block of 08:57; the Namada scan is past the hour
    readTo(db, at(9, 9), { osmosis: at(8, 57) });
    move(db, at(8, 20), { kind: 'buy', from_addr: null, to_addr: BUYER, amount_num: 12_000, price_usd: 0.01, value_usd: 120, meta: { priceSource: 'spot' } });
    expect(await hourCovered(db as any, at(9))).toBe('The hour ending 09:00 UTC is not read yet: the Osmosis catch-up search has read up to a block of 08:57 UTC.');
    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('failed');
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
    expect(kv(db, 'alert:x:hour:2026-10-29T08')).toBeNull();
    expect(kv(db, 'alert:tg:ch:hour:2026-10-29T08')).toBeNull();
    // the search finds the sell the stream missed and reads past 09:00
    const late = move(db, at(8, 58), { amount_num: 60_000, price_usd: 0.01, value_usd: 600, meta: { priceSource: 'spot', via: 'catch-up search' } });
    readTo(db, at(9, 14), { osmosis: at(9, 13) });
    expect(await hourCovered(db as any, at(9))).toBeNull();
    expect(await tick(db, at(9, 15))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.x[0]).toMatch(/^60,000 \$NAM sold on Osmosis/);
    expect(s.tg).toHaveLength(1);
    expect(kv(db, `alert:x:flow:${late}`)).not.toBeNull();
  });

  it('waits for the Namada scan, and for a node seen past the hour; a cursor written by code before blockAt waits too', async () => {
    const db = testD1();
    readTo(db, at(9, 9), { namadaCursor: 8_399_000 });
    expect(await hourCovered(db as any, at(9))).toBe('The hour ending 09:00 UTC is not read yet: the Namada scan has read up to block 8,399,000, below block 8,400,000 of 09:00 UTC or later.');
    // the block below the node's newest is enough: every block before 09:00 is below that one
    readTo(db, at(9, 9), { namadaCursor: 8_399_999 });
    expect(await hourCovered(db as any, at(9))).toBeNull();
    // the cron's last look at the nodes is from before the hour's end
    readTo(db, at(8, 59));
    expect(await hourCovered(db as any, at(9))).toBe('The hour ending 09:00 UTC is not read yet: the Osmosis catch-up search has read up to a block of 08:59 UTC; no Namada node has been seen with a block of 09:00 UTC or later yet.');
    readTo(db, at(9, 9), { osmosis: null });
    expect(await hourCovered(db as any, at(9))).toBe('The hour ending 09:00 UTC is not read yet: the Osmosis catch-up search has not said how far it has read.');
    move(db, at(8, 20));
    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('failed');
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
    expect(kv(db, 'alert:x:hour:2026-10-29T08')).toBeNull();
  });
});

describe('choosing the hour\'s move', () => {
  it('takes the largest by dollars that clears both floors; bots, rewards, other coins, unpriced moves and the hour\'s edges never qualify', async () => {
    const db = indexed();
    // a sale of 900,000 NAM settled at $120 (its stored quote would make it $450: the settle is what counts)
    move(db, at(8, 5), { amount_num: 900_000, price_usd: 0.0005, value_usd: 450, meta: { priceSource: 'spot', settle: { nam: -900_000, coins: { allUSDC: 120 } } } });
    // a crossing of 1,500,000 NAM to Osmosis at $0.00011: $165
    const bridge = move(db, at(8, 20), { kind: 'ibc_in', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 1_500_000, pool_id: null, price_usd: 0.00011, value_usd: 165, meta: { priceSource: 'spot' } });
    // never: a bot round trip either way it is marked, a rewards claim, a move under 10,000 NAM, one under $100, one
    // with no price, a move in another coin, and moves on the hour's two edges
    move(db, at(8, 30), { kind: 'other', amount_num: 5_000_000, value_usd: 750, meta: { priceSource: 'spot', arb: true } });
    move(db, at(8, 31), { amount_num: 3_000_000, value_usd: 450, meta: { priceSource: 'spot', arb: true } });
    move(db, at(8, 32), { kind: 'rewards', chain: 'namada', from_addr: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to_addr: NAMADA, amount_num: 2_000_000, value_usd: 300 });
    move(db, at(8, 33), { kind: 'transfer', to_addr: BUYER, amount_num: 9_999, price_usd: 1, value_usd: 9_999 });
    move(db, at(8, 34), { kind: 'transfer', to_addr: BUYER, amount_num: 600_000, price_usd: 0.00016, value_usd: 96 });
    move(db, at(8, 35), { kind: 'transfer', to_addr: BUYER, amount_num: 2_000_000, price_usd: null, value_usd: null, meta: {} });
    move(db, at(8, 36), { kind: 'unshield', chain: 'namada', from_addr: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah', to_addr: NAMADA, amount_num: 10_000_000, value_usd: 1500, meta: { tokenSymbol: 'OSMO' } });
    move(db, at(7, 59, 59, 999), { amount_num: 3_000_000, value_usd: 450 });
    move(db, at(9), { amount_num: 3_000_000, value_usd: 450 });

    const moves = await hourMoves(db as any, at(8), at(9), FLOORS);
    expect(moves.map((m) => [m.id, Math.round(m.usd)])).toEqual([[bridge, 165], [expect.stringMatching(/^osmosis:PP\d+:0$/), 120]]);
    expect(moves[1].basis).toEqual({ kind: 'settle', side: 'sell' });
    expect(moves.every((m) => m.usd >= PUBLIC_POST_USD_MIN)).toBe(true);

    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.x[0]).toMatch(/^1,500,000 \$NAM bridged to Osmosis\n\nFrom tnam1qpjpp…472u3 to osmo1khrd2…vmz82\. Worth \$165\.00 at \$0\.000110 a NAM \(Osmosis quote\)\./);
    expect(s.x[0]).toContain('\n\nLargest priced move of the hour, bot round trips and rewards claims left out.\n\n08:20 UTC · Osmosis record, block 73,444,002');
    expect(xLength(s.x[0])).toBeLessThanOrEqual(280);
    // the public channel heard the same move, its hour named
    expect(s.tg).toHaveLength(1);
    expect(s.tg[0]).toMatchObject({ chat: CHANNEL, button: `https://namada.trade/activity?addr=${RECEIVER}` });
    expect(s.tg[0].text).toMatch(/^<i>Largest priced move of the hour ending 09:00 UTC, bot round trips and rewards claims left out<\/i>\n\n<b>1,500,000 NAM bridged to Osmosis<\/b>\n\nFrom tnam1qpjpp…472u3 to osmo1khrd2…vmz82\. Worth \$165\.00/);
    expect(s.tg[0].text).toContain('<i>NamadaTrade · Osmosis record, block 73,444,002 · 29 Oct 2026, 08:20 UTC</i>');
  });

  it('a post too long for X gives up its why line first, then its text, never its title or its record', async () => {
    const db = indexed();
    // a sale with no settle on record through five pools: the longest sentence a move's post makes
    move(db, at(8, 5), { amount_num: 1_000_000, pool_id: '3005,3368,3009,3402,1', meta: { priceSource: 'spot' } });
    const s = voices();
    await tick(db, at(9, 10), false);
    expect(xLength(s.x[0])).toBeLessThanOrEqual(280);
    expect(s.x[0]).toMatch(/^1,000,000 \$NAM sold on Osmosis\n\nSold by osmo1nn62s…evpvh in pools 3005, 3368, 3009 and 2 more\. What it settled at is not on record/);
    expect(s.x[0]).not.toContain('Largest');
    expect(s.x[0]).toMatch(/\n\n08:05 UTC · Osmosis record, block [\d,]+$/);
  });

  it('a trade counts at its settle: one that settled under another move\'s dollars gives way to it, whatever its quote', async () => {
    const db = indexed();
    move(db, at(8, 5), { amount_num: 1_000_000, price_usd: 0.0002, value_usd: 200, meta: { priceSource: 'spot', settle: { nam: -1_000_000, coins: { allUSDC: 110 } } } });
    const transfer = move(db, at(8, 6), { kind: 'transfer', to_addr: BUYER, amount_num: 600_000, price_usd: 0.0003, value_usd: 180 });
    expect((await hourMoves(db as any, at(8), at(9), FLOORS))[0].id).toBe(transfer);
    const s = voices();
    await tick(db, at(9, 10), false);
    expect(s.x[0]).toMatch(/^600,000 \$NAM transferred on Osmosis/);
  });

  it('a settled sale says what it settled at, with its source', async () => {
    const db = indexed();
    move(db, at(8, 5), { amount_num: 900_000, pool_id: '3005,3368,3009', meta: { priceSource: 'spot', settle: { nam: -900_000, coins: { allUSDC: 120 } } } });
    const s = voices();
    await tick(db, at(9, 10), false);
    expect(s.x[0]).toContain('Sold by osmo1nn62s…evpvh in pools 3005, 3368 and 3009. Settled at $0.000133 a NAM, $120.00 in all (what the trader got, fees in).');
  });

  it('posts one move an hour, at most: the hour is claimed, and a later tick of the same hour posts nothing', async () => {
    const db = indexed();
    move(db, at(8, 5));
    move(db, at(8, 6), { amount_num: 2_000_000, value_usd: 300 });
    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('posted');
    expect(await tick(db, at(9, 11))).toBe('skipped');
    expect(await tick(db, at(10, 9))).toBe('skipped');
    expect(s.x).toHaveLength(1);
    expect(s.x[0]).toMatch(/^2,000,000 \$NAM sold/);
    expect(s.tg).toHaveLength(1);
    expect(kv(db, 'alert:x:hour:2026-10-29T08')).toBe('1');
    expect(kv(db, 'alert:tg:ch:hour:2026-10-29T08')).toBe('1');
  });

  it('a quiet hour posts nothing and spends none of the day\'s moves; the hour is read once', async () => {
    const db = indexed();
    move(db, at(8, 5), { amount_num: 50_000, value_usd: 7.5 });
    const s = voices();
    const claims = () => (db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'alert:%hour:2026-10-29T08%'").get() as { n: number }).n;
    const prepared = db.queries;
    expect(await tick(db, at(9, 10))).toBe('quiet');
    // each voice's move and crossing parts
    expect(claims()).toBe(4);
    const once = db.queries - prepared;
    expect(await tick(db, at(9, 11))).toBe('skipped');
    // the second tick reads the four claims and nothing of the hour's moves
    expect(db.queries - prepared - once).toBeLessThanOrEqual(4);
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
    expect(kv(db, 'alert:x:day:2026-10-29:move')).toBeNull();
  });

  it('an hour whose moves cannot be read posts nothing and is asked again next tick', async () => {
    const db = indexed();
    move(db, at(8, 5));
    const s = voices();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql === HOUR_MOVES_SQL) throw new Error('D1 down');
      return prepare(sql);
    });
    expect(await tick(db, at(9, 10))).toBe('failed');
    expect(kv(db, 'alert:x:hour:2026-10-29T08')).toBeNull();
    expect(kv(db, 'alert:tg:ch:hour:2026-10-29T08')).toBeNull();
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
    spy.mockRestore();
    expect(await tick(db, at(9, 11))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.tg).toHaveLength(1);
  });

  it('a settle quote that cannot be read is no settle not on record: the hour waits, and is posted at its settle once read', async () => {
    const db = indexed();
    // a sale of 900,000 NAM paid in OSMO: its stored quote makes it $450, its settle (600 OSMO at $0.20) $120
    move(db, at(8, 5), { amount_num: 900_000, price_usd: 0.0005, value_usd: 450, meta: { priceSource: 'spot', settle: { nam: -900_000, coins: { OSMO: 600 } } } });
    await db.prepare('INSERT INTO metrics (key, ts, value) VALUES (?, ?, ?)').bind('price.osmo_usd', at(8, 4), 0.2).run();
    // a crossing of 1,100,000 NAM at $0.00015: $165
    move(db, at(8, 20), { kind: 'ibc_in', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 1_100_000, pool_id: null, value_usd: 165 });
    const s = voices();
    const spy = vi.spyOn(db, 'batch').mockRejectedValue(new Error('D1 down'));
    expect(await tick(db, at(9, 10))).toBe('failed');
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
    expect(db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'alert:%'").all()).toEqual([]);
    spy.mockRestore();
    // read, the sale is $120 and gives way to the crossing; the post never says the settle is not on record
    expect(await tick(db, at(9, 11))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.x[0]).toMatch(/^1,100,000 \$NAM bridged to Osmosis/);
    expect(s.x.concat(s.tg.map((m) => m.text)).join('\n')).not.toContain('not on record');
  });

  it('X or Telegram not answering gives the hour back for the next tick', async () => {
    const db = indexed();
    move(db, at(8, 5));
    let down = true;
    const s = voices((url) => (down ? { status: 503, json: { title: 'Service Unavailable', ok: false } } : null));
    await tick(db, at(9, 10));
    expect(kv(db, 'alert:x:hour:2026-10-29T08')).toBeNull();
    expect(kv(db, 'alert:tg:ch:hour:2026-10-29T08')).toBeNull();
    down = false;
    expect(await tick(db, at(9, 11))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.tg).toHaveLength(1);
  });

  it('the moves never take the recap\'s place: past the moves\' share an hour is passed over, and the recap still posts', async () => {
    const db = indexed();
    for (let h = 0; h <= X_SHARES.move; h++) move(db, at(h, 30));
    expect(X_SHARES.move).toBeGreaterThanOrEqual(8);
    const s = voices();
    for (let h = 0; h < X_SHARES.move; h++) expect(await tick(db, at(h + 1, 10), false)).toBe('posted');
    expect(await tick(db, at(X_SHARES.move + 1, 10), false)).toBe('full');
    // that hour is done, not asked again each minute
    expect(await tick(db, at(X_SHARES.move + 1, 11), false)).toBe('skipped');
    expect(s.x).toHaveLength(X_SHARES.move);
    t = at(X_RECAP_HOUR_UTC, 1);
    await postRecapOnX(xEnv(db), async () => ({ generatedAt: t, price: { usd: { value: 0.00015 } } }), t, async () => null);
    expect(s.x).toHaveLength(X_SHARES.move + 1);
    expect(s.x.at(-1)).toMatch(/^NAM today/);
  });

  it('a crossing is posted once: its other record, an hour later, gives way to that hour\'s next move', async () => {
    const db = indexed();
    // the crossing of 2026-10-29 (test/bridge-pair-sequence.test.ts): sent from Namada at 05:53, received at 06:31
    move(db, at(5, 53), { id: 'namada:SEQ:4', chain: 'namada', kind: 'ibc_out', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 800_000, pool_id: null, price_usd: 0.00015, value_usd: 120, meta: { priceSource: 'spot', channel: 'channel-1', packetSequence: '8568' } });
    move(db, at(6, 31), { kind: 'ibc_in', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 800_000, pool_id: null, price_usd: 0.00015, value_usd: 120, meta: { priceSource: 'spot', channel: 'channel-98451', packetSequence: '8568' } });
    const s = voices();
    expect(await tick(db, at(6, 10))).toBe('posted');
    expect(s.x[0]).toContain('Namada record, block');
    expect(await tick(db, at(7, 10))).toBe('quiet');
    expect(s.x).toHaveLength(1);
    expect(s.tg).toHaveLength(1);
    // with another move in that hour, it is that move
    const db2 = indexed();
    resetClaimMemory();
    move(db2, at(5, 53), { id: 'namada:SEQ2:4', chain: 'namada', kind: 'ibc_out', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 800_000, pool_id: null, price_usd: 0.00015, value_usd: 120, meta: { priceSource: 'spot', channel: 'channel-1', packetSequence: '9001' } });
    move(db2, at(6, 31), { kind: 'ibc_in', from_addr: NAMADA, to_addr: RECEIVER, amount_num: 800_000, pool_id: null, price_usd: 0.00015, value_usd: 120, meta: { priceSource: 'spot', channel: 'channel-98451', packetSequence: '9001' } });
    move(db2, at(6, 40), { kind: 'transfer', to_addr: BUYER, amount_num: 700_000, value_usd: 105 });
    const s2 = voices();
    await tick(db2, at(6, 10));
    expect(await tick(db2, at(7, 10))).toBe('posted');
    expect(s2.x[1]).toMatch(/^700,000 \$NAM transferred on Osmosis/);
    // a larger move of the hour was posted already, and the post says it is the largest left
    expect(s2.x[0]).toContain('Largest priced move of the hour, bot round trips');
    expect(s2.x[1]).toContain('Largest priced move of the hour not posted already, bot round trips and rewards claims left out.');
    expect(s2.tg[1].text).toContain('700,000 NAM transferred on Osmosis');
    expect(s2.tg[1].text).toContain('<i>Largest priced move of the hour ending 07:00 UTC not posted already,');
    // the crossing led each hour, so neither hour gave a crossing post of its own
    expect(s2.x).toHaveLength(2);
  });

  it('a move the live posts carried before this selector is not posted again: the hour\'s next one is', async () => {
    const db = indexed();
    const first = move(db, at(8, 5), { amount_num: 2_000_000, value_usd: 300 });
    move(db, at(8, 6));
    insert(db, 'kv', [{ key: `alert:x:flow:${first}`, value: '1', updated_at: at(8, 6) }, { key: `alert:tg:ch:flow:${first}`, value: '1', updated_at: at(8, 6) }]);
    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('posted');
    expect(s.x).toHaveLength(1);
    expect(s.x[0]).toMatch(/^1,000,000 \$NAM sold/);
    expect(s.tg[0].text).toContain('1,000,000 NAM sold');
  });

  it('a voice that is not set up posts nothing: no X keys, no channel, or a Worker that sends no alerts', async () => {
    const db = indexed();
    move(db, at(8, 5));
    const s = voices();
    const hour = publicHour(db as any, at(9, 10), FLOORS);
    expect(await postHourOnX(xEnv(db, { X_ACCESS_SECRET: undefined }), hour, at(9, 10))).toBe('skipped');
    await sendTelegramHour(tgEnv(db, { TELEGRAM_CHANNEL: undefined }), hour, telegramRun(10, 10_000));
    configureAlerts(KEY, false);
    expect(await postHourOnX(xEnv(db), hour, at(9, 10))).toBe('skipped');
    await sendTelegramHour(tgEnv(db), hour, telegramRun(10, 10_000));
    expect(s.x).toEqual([]);
    expect(s.tg).toEqual([]);
  });
});

describe('the hour\'s crossing', () => {
  const crossing = (db: TestD1, ts: number, nam: number) =>
    move(db, ts, { kind: 'ibc_in', from_addr: NAMADA, to_addr: RECEIVER, amount_num: nam, pool_id: null, value_usd: nam * 0.00015 });

  it('a crossing a larger trade outweighs is posted beside it; an hour a crossing leads posts no second one', async () => {
    const db = indexed();
    // 08:00 to 09:00: a sale of 2,100,000 NAM ($315), a crossing of 2,000,000 ($300) and a smaller one
    move(db, at(8, 5), { amount_num: 2_100_000, value_usd: 315 });
    crossing(db, at(8, 20), 2_000_000);
    crossing(db, at(8, 25), 1_000_000);
    // 09:00 to 10:00: a crossing leads, so it is the hour's move, and the hour's other crossing is not posted
    crossing(db, at(9, 5), 3_000_000);
    crossing(db, at(9, 6), 2_500_000);
    move(db, at(9, 7), { amount_num: 1_000_000, value_usd: 150 });
    const s = voices();
    expect(await tick(db, at(9, 10))).toBe('posted');
    expect(s.x).toHaveLength(2);
    expect(s.x[0]).toMatch(/^2,100,000 \$NAM sold on Osmosis/);
    expect(s.x[1]).toMatch(/^2,000,000 \$NAM bridged to Osmosis\n\nFrom tnam1qpjpp…472u3 to osmo1khrd2…vmz82\. Worth \$300\.00/);
    expect(s.x[1]).toContain('\n\nLargest priced bridge crossing of the hour.\n\n08:20 UTC');
    expect(s.tg.map((m) => m.text.split('\n')[0])).toEqual([
      '<i>Largest priced move of the hour ending 09:00 UTC, bot round trips and rewards claims left out</i>',
      '<i>Largest priced bridge crossing of the hour ending 09:00 UTC</i>',
    ]);
    expect(s.tg[1].text).toContain('<b>2,000,000 NAM bridged to Osmosis</b>');
    expect(kv(db, 'alert:x:day:2026-10-29:move')).toBe('1');
    expect(kv(db, 'alert:x:day:2026-10-29:ibc')).toBe('1');
    // a later tick of that hour posts nothing more
    await tick(db, at(9, 30));
    expect(s.x).toHaveLength(2);
    expect(s.tg).toHaveLength(2);
    // the next hour: its crossing of 3,000,000 NAM is its move, and nothing else is posted
    await tick(db, at(10, 10));
    expect(s.x).toHaveLength(3);
    expect(s.x[2]).toMatch(/^3,000,000 \$NAM bridged to Osmosis/);
    expect(s.tg).toHaveLength(3);
    expect(kv(db, 'alert:x:hour:2026-10-29T09:ibc')).toBe('1');
    expect(kv(db, 'alert:x:day:2026-10-29:ibc')).toBe('1');
  });

  it('the crossings\' share is their own: once spent the hour\'s crossing is passed over, and the moves still post', async () => {
    const db = indexed();
    for (let h = 0; h <= X_SHARES.ibc; h++) {
      move(db, at(h, 5), { amount_num: 2_100_000, value_usd: 315 });
      crossing(db, at(h, 20), 2_000_000);
    }
    const s = voices();
    for (let h = 0; h < X_SHARES.ibc; h++) {
      t = at(h + 1, 10);
      const hour = publicHour(db as any, t, FLOORS);
      expect(await postHourOnX(xEnv(db), hour, t)).toBe('posted');
      expect(await postHourCrossingOnX(xEnv(db), hour, t)).toBe('posted');
    }
    t = at(X_SHARES.ibc + 1, 10);
    const hour = publicHour(db as any, t, FLOORS);
    expect(await postHourOnX(xEnv(db), hour, t)).toBe('posted');
    expect(await postHourCrossingOnX(xEnv(db), hour, t)).toBe('full');
    expect(await postHourCrossingOnX(xEnv(db), hour, t + 60_000)).toBe('skipped');
    expect(s.x.filter((p) => /bridged/.test(p))).toHaveLength(X_SHARES.ibc);
    expect(s.x.filter((p) => /sold/.test(p))).toHaveLength(X_SHARES.ibc + 1);
  });
});

describe('the allowlist', () => {
  const HOSTILE = 'Claim at namada-claim.xyz @admin https://t.me/scam';
  it('a move carrying a memo, a wallet\'s tag and a bridge receiver that is no address is posted with none of them', async () => {
    const db = indexed();
    insert(db, 'labels', [{ address: NAMADA, chain: 'namada', label: HOSTILE, category: 'other', source: 'user', author: 'tnam1qauthor', updated_at: 1 }]);
    insert(db, 'labels', [{ address: RECEIVER, chain: 'osmosis', label: 'Official airdrop namada-claim.xyz', category: 'other', source: 'user', author: 'tnam1qauthor', updated_at: 1 }]);
    // a send from Osmosis to Namada whose receiver is text the sender chose, with a memo
    move(db, at(8, 5), { kind: 'ibc_out', from_addr: RECEIVER, to_addr: 'namada-claim.xyz', amount_num: 2_000_000, pool_id: null, value_usd: 300, meta: { priceSource: 'spot', memo: `visit ${HOSTILE}` } });
    // and a sale by a tagged wallet, through text that only looks like a pool list
    move(db, at(8, 6), { from_addr: NAMADA, amount_num: 1_500_000, pool_id: '3005,https://namada-claim.xyz', value_usd: 225, meta: { priceSource: 'spot', memo: HOSTILE } });
    const s = voices();
    await tick(db, at(9, 10));
    const hour = publicHour(db as any, at(10, 10), FLOORS);
    const second = (await hourMoves(db as any, at(8), at(9), FLOORS))[1];
    const posts = [s.x[0], s.tg[0].text, hourText(second), hourMessage(second, hour).html];
    for (const p of posts) {
      expect(p).not.toMatch(/namada-claim|claim at|airdrop|admin|visit|scam|https?:|t\.me|@/i);
      // no bare domain either: no dot between a word and letters
      expect(p.replace(/<[^>]+>/g, '')).not.toMatch(/[\p{L}\p{N}-]\.\p{L}/u);
    }
    expect(s.x[0]).toContain('From osmo1khrd2…vmz82 to text that is not an address.');
    expect(hourText(second)).toContain('Sold by tnam1qpjpp…472u3 in pool 3005.');
    // the move is about its receiver, which is no address: the button opens the site's moves, not a page of that text
    expect(s.tg[0].button).toBe('https://namada.trade/activity');
  });

  it('a bridge receiver named as one of an object\'s own keys reads as text that is not an address, on the public posts and the cards', () => {
    for (const to of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const f = rowToFlow({ id: 'osmosis:PROTO:0', chain: 'osmosis', height: 1, ts: at(8, 5), tx_hash: 'PROTO', kind: 'ibc_out', from_addr: RECEIVER, to_addr: to, amount_num: 2_000_000, pool_id: null, price_usd: 0.00015, value_usd: 300, meta: JSON.stringify({ priceSource: 'spot' }) } as any);
      const m = publicMoveOf(f, FLOORS)!;
      expect(m.other, to).toBe('text that is not an address');
      const card = moveCard(f, { whaleNam: 10000 });
      for (const text of [hourText(m), hourMessage(m, { end: at(9) }).html, card.embed.description ?? '', ...card.parts.map((p) => p.text)]) {
        expect(text, to).not.toMatch(/native code|\[object|function/);
      }
    }
  });

  it('outsider text a post must carry is plain words: no link, no bare domain, no mention, no hidden character', () => {
    expect(plainOutsider('Airdrop at https://namada-claim.xyz/claim and t.me/scam, ask @admin or ＠mod', 250))
      .toBe('Airdrop at namada-claim[.]xyz/claim and t[.]me/scam, ask (at)admin or (at)mod');
    expect(plainOutsider('namada-claim．xyz', 50)).toBe('namada-claim[.]xyz');
    expect(plainOutsider('namada-claim。xyz', 50)).toBe('namada-claim[.]xyz');
    expect(plainOutsider('a\u200Bb\u202Ec\uE03Ad\n\ne', 50)).toBe('a b c d e');
    expect(plainOutsider('Upgrade to v1.2, 0.5 NAM', 50)).toBe('Upgrade to v1.2, 0.5 NAM');
    expect(plainOutsider('x'.repeat(30) + '😀'.repeat(10), 32)).toBe('x'.repeat(30) + '…');
    expect(plainOutsider(null, 10)).toBe('');
    // a dot after a combining mark NFKC cannot compose, or after any other character that is no space, is broken too
    expect(plainOutsider('claimq\u0301.com and evil\u0300.xyz, ©.io', 80)).toBe('claimq\u0301[.]com and evil\u0300[.]xyz, ©[.]io');
    // no command, hashtag or cashtag; a slash inside a word, a sum and a number stay
    expect(plainOutsider('/stop now #airdrop $SCAM (#join) ＃free /1_x', 80)).toBe('stop now airdrop SCAM (join) free 1_x');
    expect(plainOutsider('Yes and/or no: 1/2 of $100 to proposal #12', 80)).toBe('Yes and/or no: 1/2 of $100 to proposal #12');
    // a host written as four numbers is a link as much as a name (merged stage 1 review): its dots are broken too,
    // in decimal or in hex; a version or a sum of fewer parts stays
    expect(plainOutsider('Airdrop claim: http://45.67.89.10/claim', 80)).toBe('Airdrop claim: 45[.]67[.]89[.]10/claim');
    expect(plainOutsider('45.67.89.10:8080/airdrop and 0x2d.0x43.0x59.0x0a/x', 80)).toBe('45[.]67[.]89[.]10:8080/airdrop and 0x2d[.]0x43[.]0x59[.]0x0a/x');
    expect(plainOutsider('Upgrade v1.2.3 to 1.2.4, 1.5 NAM each', 80)).toBe('Upgrade v1.2.3 to 1.2.4, 1.5 NAM each');
  });
});

describe('the words', () => {
  it('every kind of stored move that may be posted reads in the site\'s words: no banned word, no emoji, inside X\'s 280, nothing an outsider wrote', () => {
    const rows: Record<string, any> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'discord-rows.json'), 'utf8')).rows;
    const kinds = new Set<string>();
    for (const k of Object.keys(rows)) {
      const f = rowToFlow(rows[k]);
      // priced at a dollar a NAM, so each row clears the dollar floor and the words of every kind are read
      const m = publicMoveOf({ ...f, priceUsd: 1, fromLabel: '@someone namada-claim.xyz', toLabel: 'https://evil.example' } as Flow, { osmosis: 1, namada: 1 });
      if (!m) { expect(['bot', 'rewards', 'otherCoin'], k).toContain(k); continue; }
      kinds.add(m.kind);
      const hour = { end: Math.ceil(m.ts / H) * H };
      for (const text of [hourText(m), hourText(m, true), hourMessage(m, hour).html.replace(/<[^>]+>/g, '')]) {
        expect(text, k).not.toMatch(BANNED);
        expect(text, k).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(text, k).not.toMatch(/@|https?:|namada-claim|evil/);
        expect(text, k).not.toMatch(/undefined|null|NaN|—/);
      }
      expect(xLength(hourText(m)), k).toBeLessThanOrEqual(280);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(10);
  });
});

describe('proposals on the public channel and X', () => {
  const hostile: GovernanceProposal = {
    id: 41, title: 'Claim at namada-claim.xyz, ask @admin $SCAM', authors: 'Mallory @admin', abstract: 'Read https://namada-claim.xyz/airdrop first',
    type: 'default', status: 'voting', startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0,
    // the own audit's Low 5 break-out of the discussion link's masked link
    discussionsUrl: 'https://forum.namada.net/t/1)[Votes_on_NamadaTrade](https://evil.example',
  } as GovernanceProposal;

  it('the channel and X carry the title as plain words, no authors, abstract or discussion link; the subscribers\' card is as before', async () => {
    const db = indexed();
    await saveSettings(db as any, KEY, { address: NAMADA, notifications: { ...defaultPrefs(), forumAndGov: true }, channels: { discord: { enabled: false, webhookUrl: null }, telegram: { enabled: true, chatId: 5550009, kind: 'private', title: null, linkedAt: 1 } }, createdAt: 1, updatedAt: 1 } as any);
    const s = voices();
    await sendTelegramGov(tgEnv(db), hostile, true, {}, telegramRun(10, 10_000));
    await postGovOnX(xEnv(db), hostile, true);
    const channel = s.tg.find((m) => m.chat === CHANNEL)!.text;
    const user = s.tg.find((m) => (m.chat as unknown) === 5550009)!.text;
    expect(channel).toContain('Claim at namada-claim[.]xyz, ask (at)admin SCAM');
    // X reads the raw title through xSafe (sources/x.ts cardText): the domain is a removed link there, not a broken one
    expect(s.x[0]).toContain('Claim at [link removed], ask (at)admin SCAM');
    for (const p of [channel, s.x[0]]) expect(p).not.toMatch(/evil|Votes_on|namada-claim\.xyz|@admin|\$SCAM|Mallory|Read |airdrop/);
    expect(channel).toContain('https://namada.valopers.com/proposals/41');
    // the subscribers chose proposal alerts: theirs is the card Discord's subscribers get, unchanged by this
    expect(user).toContain('Mallory');
  });
});

describe('forum posts on Telegram', () => {
  const post = (extra: Partial<ForumPost> = {}): ForumPost => ({
    id: 990001, topicId: 7000, topicTitle: 'Airdrop at namada-claim.xyz, ask @admin https://t.me/scam', topicSlug: 'airdrop', postNumber: 3,
    url: 'https://forum.namada.net/t/airdrop/7000/3', username: 'scammer', displayName: 'Support Team', avatarUrl: null,
    createdAt: new Date(at(8, 40)).toISOString(), excerpt: 'Connect your wallet at https://namada-claim.xyz now', isNewTopic: false, ...extra,
  });

  it('the channel and the subscribers get the title and category alone, as plain words, with a button built from the post\'s numbers', async () => {
    const db = indexed();
    // a subscriber with forum posts on, linked to a Telegram chat
    const prefs = { ...defaultPrefs(), forumAndGov: true };
    await saveSettings(db as any, KEY, { address: NAMADA, notifications: prefs, channels: { discord: { enabled: false, webhookUrl: null }, telegram: { enabled: true, chatId: 5550009, kind: 'private', title: null, linkedAt: 1 } }, createdAt: 1, updatedAt: 1 } as any);
    const s = voices();
    await sendTelegramForum(tgEnv(db), post(), 'General <b>', telegramRun(10, 10_000));
    expect(s.tg.map((m) => m.chat).sort()).toEqual([5550009, CHANNEL].sort() as any);
    for (const m of s.tg) {
      expect(m.text).toBe('<i>Forum · General &lt;b&gt;</i>\n\n<b>Reply 3 in: Airdrop at namada-claim[.]xyz, ask (at)admin t[.]me/scam</b>\n\n<i>NamadaTrade · forum.namada.net · 29 Oct 2026, 08:40 UTC</i>');
      expect(m.text).not.toMatch(/Connect your wallet|scammer|Support Team|https?:/);
      expect(m.button).toBe('https://forum.namada.net/t/7000/3');
    }
  });

  it('a new topic, and a post whose numbers are not numbers', () => {
    expect(forumMessage(post({ isNewTopic: true, postNumber: 1 }), null)).toMatchObject({ button: { url: 'https://forum.namada.net/t/7000' } });
    expect(forumMessage(post({ isNewTopic: true, postNumber: 1 }), null).html).toContain('<b>New topic: Airdrop');
    expect(forumMessage(post({ topicId: 'x' as any, postNumber: 'y' as any, topicTitle: '' }), null)).toMatchObject({ button: { url: 'https://forum.namada.net' } });
    expect(forumMessage(post({ topicId: 'x' as any, postNumber: 'y' as any, topicTitle: '' }), null).html).toContain('<b>A reply in: a topic with no title</b>');
  });
});

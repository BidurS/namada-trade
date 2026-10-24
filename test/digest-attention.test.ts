// Daily digest, the "Trades worth attention" section (2026-10-23, attention-design.txt): the reads over a stand-in
// D1 seeded with the survey's stored rows of the 24 h to 2026-10-23 08:00 UTC (test/fixtures/digest-attention.json),
// the builder at the four levels against attention-example.txt, the bounds, the "not read" rules, the quote-move,
// median, deck and unusual-event rules on small fixtures, the fit rule, the statements' plans, and the picture.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import {
  ATTENTION_SQL, DIGEST_ATTN_LEVELS, DIGEST_ATTN_TRADES, DIGEST_TRADES_MAX, DIGEST_BRIDGE_MAX, DIGEST_ATTN_FOLLOW_MAX, DIGEST_ATTN_COUNT_MAX,
  DIGEST_ATTN_SERIES_MAX, DIGEST_ATTN_TOP, DISCORD_FIELD_MAX, DEFAULT_MARKS, SITE_ADDR_URL,
  readAttentionFigures, renderAttentionPicture, attentionEmbed, attentionLevels, attentionForRoom, embedChars, cutField, fieldsOf, gasWordsOf, shortAddr,
  fmtNam, fmtPrice, isNotRead, notRead, pictureLeftOut, type AttentionFigures, type AttentionLevel, type TradesFigures, type DeckFigures, type UnusualEvent, type Embed,
} from '../worker/src/digest/attention';
import {
  attentionFrame, drawAttention, readPngChunks, renderAttentionPng, DIGEST_ATTN_AXIS_MIN_NAM, DIGEST_ATTN_GRID_LINES, DIGEST_ATTN_PNG, PICTURE_COLOURS,
  type PicturePoint, type PictureTrade,
} from '../worker/src/digest/charts/attention';
import { INTERNAL_ADDRS } from '../worker/src/holders';
import { settleMetaOf, settleOf } from '../shared/settle';
import { INTERNAL_ADDRESSES } from '../shared/alerts';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

interface Fixture {
  now: number; from: number;
  trades: Record<string, unknown>[]; crossing: Record<string, unknown>[]; withdraw: Record<string, unknown>[]; unbondRequests: Record<string, unknown>[];
  quotes: PicturePoint[]; osmoQuote: PicturePoint[];
  osmosisHolders: { address: string; balance_num: number }[];
  namadaHolders: { address: string; balance_num: number; stake_num: number; total_num: number; updated_at: number; above: number }[];
  labels: { address: string; chain: string; label: string; category: string; source: string }[];
  validatorDaily: { day: string; validator: string; name: string; state: string; stake: number }[];
  kv: { key: string; value: string; updated_at: number }[];
  survey: { makers: { maker: string; had_buy: number | null; had_sell: number | null; buys: number; sells: number; bal: number | null }[]; osmoQuoteUsed: number };
}
const fx: Fixture = JSON.parse(readFileSync(new URL('./fixtures/digest-attention.json', import.meta.url), 'utf8'));
const priorTrades: Record<string, unknown>[] = JSON.parse(readFileSync(new URL('./fixtures/series-trades.json', import.meta.url), 'utf8')).rows;
const T = fx.now;
const A24 = fx.from;

/** Fixture-shaped addresses, never a real one. */
const OSMO = (i: number) => `osmo1digest${String(i).padStart(32, 'q')}`;
const TNAM = (i: number) => `tnam1qdigest${String(i).padStart(33, 'q')}`;
const TRADER = fx.trades[0].to_addr as string;
const SELLER = fx.trades[2].from_addr as string;
const RUNNER = fx.trades[6].to_addr as string;
const RECEIVER = fx.crossing[0].to_addr as string;
const SENDER = fx.crossing[0].from_addr as string;
const WITHDRAWER = fx.withdraw[0].to_addr as string;
const POS = INTERNAL_ADDRESSES.pos;

const link = (a: string) => `[\`${shortAddr(a)}\`](${SITE_ADDR_URL}${a})`;
const code = (a: string) => `\`${shortAddr(a)}\``;

// ---------------------------------------------------------------- seeding

function seedHolders(db: TestD1, rows: { chain: string; address: string; balance_num: number; stake_num?: number; total_num?: number; updated_at?: number | null }[]) {
  insert(db, 'holders', rows.map((r) => ({ chain: r.chain, address: r.address, balance: String(Math.round(r.balance_num * 1e6)), balance_num: r.balance_num, stake_num: r.stake_num ?? 0, total_num: r.total_num ?? r.balance_num, updated_at: r.updated_at ?? null })));
}

/** The survey's rows: every table the section reads, as production held them. The two Namada holders rows are "not among the 100 largest" (above = 100), so 100 larger fixture-shaped rows stand in for the holders above them. */
function seedExample(db: TestD1, o: { prior?: boolean } = {}) {
  insert(db, 'flows', [...fx.trades, ...fx.crossing, ...fx.withdraw, ...fx.unbondRequests, ...(o.prior ? priorTrades : [])]);
  insert(db, 'metrics', [...fx.quotes.map((q) => ({ ts: q.ts, key: 'price.usd', value: q.value })), ...fx.osmoQuote.map((q) => ({ ts: q.ts, key: 'price.osmo_usd', value: q.value }))]);
  seedHolders(db, fx.osmosisHolders.map((h) => ({ chain: 'osmosis', ...h })));
  seedHolders(db, fx.namadaHolders.map((h) => ({ chain: 'namada', address: h.address, balance_num: h.balance_num, stake_num: h.stake_num, total_num: h.total_num, updated_at: h.updated_at })));
  seedHolders(db, Array.from({ length: 100 }, (_, i) => ({ chain: 'namada', address: TNAM(1000 + i), balance_num: 2_000_000 + i })));
  insert(db, 'labels', fx.labels);
  insert(db, 'validator_daily', fx.validatorDaily.map((v) => ({ ...v, delegators: 0, as_of: Date.UTC(2026, 9, Number(v.day.slice(-2)), 0, 10), height: 0 })));
  insert(db, 'kv', fx.kv);
}

interface TradeSpec { id: string; ts: number; kind: 'buy' | 'sell'; maker: string | null; nam: number; price?: number | null; settle?: Record<string, unknown>; route?: string; priceSource?: string; chain?: string }
const tradeRow = (t: TradeSpec) => ({
  id: t.id, chain: t.chain ?? 'osmosis', height: 1, ts: t.ts, tx_hash: t.id.split(':')[1] ?? 'X', kind: t.kind,
  from_addr: t.kind === 'sell' ? t.maker : null, to_addr: t.kind === 'buy' ? t.maker : null, amount_num: t.nam,
  counter_denom: null, counter_amount: null, pool_id: t.route ?? '3005', price_usd: t.price ?? null, value_usd: t.price ? t.price * t.nam : null,
  meta: JSON.stringify({ ...(t.maker ? { trader: t.maker } : {}), ...(t.priceSource ? { priceSource: t.priceSource } : {}), ...(t.settle ? { settle: t.settle } : {}) }),
});
const quoteRows = (points: [number, number][], key = 'price.usd') => points.map(([ts, value]) => ({ ts, key, value }));

/** A stand-in whose batch fails when any statement in it matches `bad`: one line's reads fail, the others answer. */
const failing = (db: TestD1, bad: RegExp): D1Database => ({
  prepare: (sql: string) => db.prepare(sql),
  batch: async (stmts: { sql: string }[]) => { if (stmts.some((s) => bad.test(s.sql))) throw new Error('D1 did not answer'); return db.batch(stmts as any); },
} as unknown as D1Database);

const field = (e: Embed, name: string) => e.fields?.find((f) => f.name === name)?.value;
const trades = (fig: AttentionFigures) => fig.trades as TradesFigures;
const deck = (fig: AttentionFigures) => fig.deck as DeckFigures;

// ---------------------------------------------------------------- the example

describe('the figures of attention-example.txt from the survey\'s stored rows', () => {
  it('reads the window: nine trades by four addresses, the median, each settle price at its own minute, the quote moves, the deck, the withdrawal', async () => {
    const db = testD1();
    seedExample(db, { prior: true });
    const fig = await readAttentionFigures(db as unknown as D1Database, T, 'daily');
    expect(fig.from).toBe(A24);
    expect(fig.indexBehind).toBeNull();
    expect(fig.params?.unbondingLength).toBe(53);

    const t = trades(fig);
    expect(isNotRead(fig.trades)).toBe(false);
    expect(t.n).toBe(9);
    expect(t.traders).toBe(4);
    expect(fmtNam(t.nam)).toBe('60,537.86');
    expect(t.bounded).toBe(false);
    // the 5th of 9 amounts sorted: 9,922.116 (t_onepass rn 5)
    expect(t.median).toBeCloseTo(9922.116, 6);
    expect(t.read.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // No. 1: allUSDC at a dollar plus gas at the transaction's own OSMO rate
    expect(fmtPrice(t.read[0].settle!.usdPerNam)).toBe('$0.00093128');
    expect(t.read[0].gas).toEqual({ coin: 'OSMO', rate: 'tx' });
    // No. 2: gas at the price.osmo_usd reading of 02:34:02 UTC, 18 s before the trade
    expect(fmtPrice(t.read[1].settle!.usdPerNam)).toBe('$0.00088435');
    expect(t.read[1].gas).toEqual({ coin: 'OSMO', rate: 'quote' });
    // No. 3 at 05:01 UTC: the one stored OSMO quote is 2.5 h old, so its gas is left out and said so
    expect(fmtPrice(t.read[2].settle!.usdPerNam)).toBe('$0.00091376');
    expect(t.read[2].settle!.gasLeftOut).toBe(true);
    expect(t.read[2].gas).toEqual({ coin: 'OSMO', rate: 'left out' });
    // the quote around the shown trades, from the minute readings
    const m1 = t.read[0].move;
    expect(isNotRead(m1)).toBe(false);
    if (!m1 || isNotRead(m1)) throw new Error('move not read');
    expect(m1.before).toEqual({ ts: 1792722842190, value: 0.000857464110491627 });
    expect(m1.after15).toEqual({ ts: 1792723742838, value: 0.000940727060585553 });
    expect(m1.after15!.value / m1.before!.value - 1).toBeCloseTo(0.0971, 4);
    const m3 = t.read[2].move;
    if (!m3 || isNotRead(m3)) throw new Error('move not read');
    expect(m3.after15!.value / m3.before!.value - 1).toBeCloseTo(-0.0781, 4);
    expect(t.read[3].move).toBeNull();
    // the makers' records from the rows seeded: the window's own trades and the two earlier sales of the seller in test/fixtures/series-trades.json
    expect(t.read[0].record).toMatchObject({ buys: 2, sells: 0, hadBefore: false, rank: 72 });
    expect(t.read[2].record).toMatchObject({ buys: 0, sells: 5, hadBefore: true, rank: 41 });
    expect(t.read[6].record).toMatchObject({ buys: 3, sells: 0, hadBefore: false, rank: 47 });
    expect(t.read[5].onDeck).toBe(true);
    expect(t.read[5].record).toMatchObject({ buys: 0, sells: 1, rank: null, balance: null });

    const d = deck(fig);
    expect(isNotRead(fig.deck)).toBe(false);
    expect(d).toMatchObject({ crossings: 1, receivers: 1, bounded: false });
    expect(fmtNam(d.nam)).toBe('1,454.20');
    expect(d.rows).toHaveLength(1);
    const row = d.rows[0];
    expect(row.address).toBe(RECEIVER);
    expect(row.sender?.address).toBe(SENDER);
    expect(row.sender?.label).toEqual({ plain: 'Public sale allocation (genesis)', source: 'genesis', byline: null });
    // past the 100 largest (the count reads a few past them, for the protocol accounts it takes out)
    expect(row.sender?.holder).toMatchObject({ balance: 0 });
    expect((row.sender?.holder as { above: number }).above).toBeGreaterThanOrEqual(DIGEST_ATTN_TOP);
    expect(row.sender?.hop).toBeNull();
    const f = row.follow;
    if (isNotRead(f)) throw new Error('follow-ups not read');
    expect(f.soldSince).toBeCloseTo(1415.011633, 6);
    expect(f.soldCounted).toBeCloseTo(1415.011633, 6);
    expect(f.sentBackCounted).toBe(0);
    expect(f.remaining).toBeCloseTo(39.190754, 6);
    expect(f.feeNote).toBe(true);
    expect(f.prior).toEqual({ n: 0, nam: 0, bounded: false });
    expect(f.hazard).toBe(0.42);
    expect(f.holder).toBeNull();
    // the sale paid in OSMO at 15:36 UTC the day before has no OSMO quote within 5 min: its own recorded price stands, with its basis
    expect(f.sales).toHaveLength(1);
    expect(f.sales[0].settle).toBeNull();
    expect(f.sales[0].own).toEqual({ usd: 0.000848090485748579, how: 'spot' });
    expect(f.sales[0].settleNam).toBeCloseTo(-1454.202387, 6);

    const u = fig.unusual;
    expect(u.traders).toEqual({ total: 4, top: 3 });
    // the seeded store holds no earlier trade for two of the three top-100 makers, so the first-trade rule fires for them (production had 29 and 157 earlier buys: survey.makers)
    expect((u.first as UnusualEvent[]).map((e) => e.rule === 'first' && [e.address, e.rank])).toEqual([[RUNNER, 47], [TRADER, 72]]);
    expect(u.multiple).toEqual([]);
    expect(u.unshield).toEqual([]);
    const wd = (u.withdraw as UnusualEvent[])[0];
    if (wd.rule !== 'withdraw') throw new Error('not a withdrawal');
    expect(wd.nam).toBe(1_170_000);
    expect(wd.address).toBe(WITHDRAWER);
    expect(wd.label?.plain).toBe('Public sale allocation (genesis)');
    expect(wd.request).toEqual({ ts: 1789909239851, nam: 1_170_000, validator: 'tnam1q9pt4hukg0ga362jq2slhg4tuf692zqqngzzz54k', exact: true });
    expect(wd.validator).toEqual({ address: 'tnam1q9pt4hukg0ga362jq2slhg4tuf692zqqngzzz54k', name: 'Stakecito', state: 'jailed' });
    // no epoch reading near the request of 20 Sep: the estimate, 56 epochs of the measured length after the request
    expect(wd.maturity?.kind).toBe('estimate');
    if (wd.maturity?.kind !== 'estimate') throw new Error('not an estimate');
    expect(wd.maturity.epochs).toBe(56);
    expect(Math.round(wd.maturity.epochSec)).toBe(21617);
    expect(new Date(wd.maturity.at).toISOString().slice(0, 16)).toBe('2026-10-04T13:16');
    expect(wd.since).toMatchObject({ restaked: 0, bridgedOut: 0, shielded: 0, transferred: 0 });
    expect(wd.holder).toMatchObject({ balance: 1211311.865739, stake: 0, above: 100 });
    expect(fig.series).toHaveLength(1328);
    expect(fig.pictureTrades).toHaveLength(9);
  });

  it('renders the lines the seeded rows support: the gas left out is said, the unpriced sale keeps its own price with its basis, the first-trade rule names its makers', async () => {
    const db = testD1();
    seedExample(db, { prior: true });
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const a0 = attentionEmbed(fig, 'A0').embed;
    const largest = field(a0, 'Largest trades')!;
    expect(largest).toContain(`3. Sold 9,970.02 NAM at 05:01 UTC, ${code(SELLER)} · settled at $0.00091376 ⁷ (gave 10,000.00 NAM, fees in, for 9.14 USDC; gas left out: no OSMO quote within 5 min before) · quote −7.81 % in the 15 min after ⁶ · no buy, 5 sales on record; No. 41 ¹⁴.`);
    expect(largest).toContain('· 2 buys, no sale on record; No. 72 Osmosis holder ¹⁴.');
    expect(field(a0, 'NAM on deck')).toContain(`· sold 1,415.01 NAM 76 s later, at $0.00084809 ⁷ (quote at the time) · no sale in the 30 d before · selling estimate 42 %`);
    const unusual = field(a0, 'Unusual')!;
    expect(unusual.split('\n')[0]).toContain('• 1,170,000.00 NAM unlocked and withdrawn from staking at 14:19 UTC yesterday by');
    expect(unusual).toContain(`• First trade in 90 days from a top-100 holder: Bought 16,137.55 NAM at 02:34 UTC by ${code(TRADER)} (No. 72 ¹⁴, 2 buys, no sale on record).`);
    expect(unusual).toContain(`• First trade in 90 days from a top-100 holder: Bought 608.85 NAM at 20:36 UTC yesterday by ${code(RUNNER)} (No. 47 ¹⁴, 3 buys, no sale on record).`);
    expect(unusual).toContain('Not found: a trade over 5× the median (49,610.58 NAM); a bridge-out after an unshielding ≥ 50,000 NAM (none ³).');
    expect(a0.description).toContain('3 unusual events by the four rules.');
    // no mark for the OSMO quote where none was used; the labels mark is listed
    expect(field(a0, 'Sources (this embed)')).toBe('¹⁸ this site\'s label index (genesis file; a wallet\'s tag says "Tag by …") · ¹⁹ Osmosis OSMO quote at the trade\'s minute (≤ 5 min before) · other marks: the digest\'s Sources.');
  });
});

/**
 * The figures as the survey read them (q2/*.json): the makers' records from t_first (29, 11/19 and 157 earlier trades,
 * so the first-trade rule finds none) and, as attention-example.txt priced them, the one stored OSMO quote applied to
 * No. 3's gas and to the deck's sale. The module's own reads price a trade only at a quote within 5 min of it.
 */
async function exampleFigures(): Promise<AttentionFigures> {
  const db = testD1();
  seedExample(db);
  const fig = await readAttentionFigures(db as unknown as D1Database, T);
  const t = trades(fig);
  const rank = new Map(fx.osmosisHolders.map((h, i) => [h.address, i + 1]));
  for (const tr of t.read) {
    const s = fx.survey.makers.find((m) => m.maker === tr.maker);
    if (s) tr.record = { buys: s.buys, sells: s.sells, bounded: false, hadBefore: s.had_buy != null || s.had_sell != null, rank: rank.get(tr.maker!) ?? null, balance: s.bal };
  }
  const q = { OSMO: fx.survey.osmoQuoteUsed };
  const third = settleMetaOf(JSON.parse(fx.trades[2].meta as string))!;
  t.read[2].settle = settleOf('sell', third, q);
  t.read[2].gas = gasWordsOf(third, t.read[2].settle);
  t.read[2].own = null;
  const d = deck(fig);
  const sale = d.rows[0].follow;
  if (isNotRead(sale)) throw new Error('follow-ups not read');
  const saleMeta = settleMetaOf(JSON.parse(fx.trades[5].meta as string))!;
  sale.sales[0].settle = settleOf('sell', saleMeta, q);
  sale.sales[0].gas = gasWordsOf(saleMeta, sale.sales[0].settle);
  sale.sales[0].own = null;
  fig.unusual.first = [];
  fig.unusual.traders = { total: 4, top: 3 };
  return fig;
}

const TITLE = 'Trades worth attention · 24 h to 08:00 UTC, 23 Oct 2026';
const DESC = '9 trades by 4 addresses, 60,537.86 NAM ⁸ (bot round trips left out); typical trade 9,922.12 NAM (the median); 1 unusual event by the four rules.';
const LEGEND_LONG = ' Picture: the quote over the 24 h with each trade at its own price — blue bought, orange sold, area by NAM, the 3 largest ringed yellow ⁶ ⁷.';
const LEGEND_SHORT = ' Picture: the quote over the 24 h; blue bought, orange sold, the largest ringed yellow ⁶ ⁷.';
const SOURCES_LONG = '¹⁸ this site\'s label index (genesis file; a wallet\'s tag says "Tag by …")';
const EXAMPLE: Record<AttentionLevel, { description: string; fields: [string, string][]; sourcesAppend: string | null }> = {
  A0: {
    description: DESC + LEGEND_LONG,
    fields: [
      ['Largest trades', [
        `1. Bought 16,137.55 NAM at 02:34 UTC, ${link(TRADER)} · settled at $0.00093128 ⁷ (15.02 USDC + $0.0045 gas, fees in) · quote +9.71 % in the 15 min after ⁶ · 29 buys, no sale on record; No. 72 Osmosis holder ¹⁴.`,
        '2. Bought 11,330.68 NAM at 02:34 UTC, same address · settled at $0.00088435 ⁷ (10.02 USDC + $0.0042 gas at the OSMO minute quote ¹⁹, fees in).',
        `3. Sold 9,970.02 NAM at 05:01 UTC, ${code(SELLER)} · settled at $0.00091355 ⁷ (gave 10,000.00 NAM, fees in, for 9.14 USDC − $0.0021 gas ¹⁹) · quote −7.81 % in the 15 min after ⁶ · 11 buys, 19 sales on record; No. 41 ¹⁴.`,
        `Others: 1 sale of 1,415.01 NAM (on deck) and 3 buys of ~605 NAM within 30 s by ${code(RUNNER)} (157 buys, no sale on record; No. 47 ¹⁴), 20:36 UTC yesterday; and 2 more.`,
      ].join('\n')],
      ['NAM on deck', [
        'In 1,454.20 NAM (1 crossing, 1 address) ⁸ · sold since 1,415.01 · sent back 0.00 · still there 39.19 NAM (the pools\' fee in NAM: all 1,454.20 was given, fees in).',
        `${link(RECEIVER)} in at 15:35 UTC yesterday from ${code(SENDER)} (Public sale allocation (genesis) ¹⁸; emptied by the crossing ¹²) · sold 1,415.01 NAM 76 s later, settled at $0.00086313 ⁷ (25.3624 OSMO at the minute quote ¹⁹ − $0.0032 gas) · no sale in the 30 d before · selling estimate 42 % (from its own sales; the Supply page shows it from 60 %) · holds no NAM on Osmosis now ¹⁴.`,
      ].join('\n')],
      ['Unusual', [
        `• 1,170,000.00 NAM unlocked and withdrawn from staking at 14:19 UTC yesterday by ${link(WITHDRAWER)} (Public sale allocation (genesis) ¹⁸) ³ — requested 20 Sep 13:00 UTC from Stakecito (listed jailed ¹⁷), 32 days earlier ³; withdrawable from about 4 Oct 13:16 UTC (56 epochs of 21,617 s = 14.0 d, an estimate up to one epoch late ⁵). Since: no restake, bridge-out, shielding or transfer to 08:00 ³; holds 1,211,311.87 NAM spendable, 0 staked ¹²; not among the 100 largest holders.`,
        'Not found: a first trade from a top-100 Osmosis holder (3 of today\'s 4 traders are top-100, each with earlier trades ¹⁴); a trade over 5× the median (49,610.58 NAM); a bridge-out after an unshielding ≥ 50,000 NAM (none ³).',
      ].join('\n')],
      ['Sources (this embed)', `${SOURCES_LONG} · ¹⁹ Osmosis OSMO quote at the trade's minute (≤ 5 min before) · other marks: the digest's Sources.`],
    ],
    sourcesAppend: null,
  },
  A1: {
    description: DESC + LEGEND_LONG,
    fields: [
      ['Largest trades', [
        `1. Bought 16,137.55 NAM at 02:34 UTC, ${link(TRADER)} · settled at $0.00093128 ⁷ · quote +9.71 % in the 15 min after ⁶ · 29 buys, no sale on record; No. 72 Osmosis holder ¹⁴.`,
        '2. Bought 11,330.68 NAM at 02:34 UTC, same address · settled at $0.00088435 ⁷.',
        `3. Sold 9,970.02 NAM at 05:01 UTC, ${code(SELLER)} · settled at $0.00091355 ⁷ · quote −7.81 % in the 15 min after ⁶ · 11 buys, 19 sales on record; No. 41 ¹⁴.`,
        '+ 6 smaller: 1 on deck, 3 buys of ~605 NAM by one address (157 buys, no sale on record).',
      ].join('\n')],
      ['NAM on deck', [
        'In 1,454.20 NAM (1 crossing, 1 address) ⁸ · sold since 1,415.01 · sent back 0.00 · still there 39.19 NAM (the pools\' fee in NAM: all 1,454.20 was given, fees in).',
        `${link(RECEIVER)} in at 15:35 UTC yesterday from ${code(SENDER)} (Public sale allocation (genesis) ¹⁸; emptied by the crossing ¹²) · sold 1,415.01 NAM 76 s later, settled at $0.00086313 ⁷ · no sale in the 30 d before · selling estimate 42 % (from its own sales; the Supply page shows it from 60 %) · holds no NAM on Osmosis now ¹⁴.`,
      ].join('\n')],
      ['Unusual', [
        `• 1,170,000.00 NAM unlocked and withdrawn from staking at 14:19 UTC yesterday by ${link(WITHDRAWER)} (Public sale allocation (genesis) ¹⁸) ³ — requested 20 Sep 13:00 UTC from Stakecito (listed jailed ¹⁷), 32 days earlier ³; withdrawable from about 4 Oct 13:16 UTC (56 epochs of 21,617 s = 14.0 d, an estimate up to one epoch late ⁵). Since: no restake, bridge-out, shielding or transfer to 08:00 ³; holds 1,211,311.87 NAM spendable, 0 staked ¹²; not among the 100 largest holders.`,
        'Not found: a first trade from a top-100 Osmosis holder (3 of today\'s 4 traders are top-100, each with earlier trades ¹⁴); a trade over 5× the median (49,610.58 NAM); a bridge-out after an unshielding ≥ 50,000 NAM (none ³).',
      ].join('\n')],
      // the settle clauses are gone at A1, so no figure of this level came from a coin quote: the ¹⁹ entry is not listed (the example kept it)
      ['Sources (this embed)', `${SOURCES_LONG} · other marks: the digest's Sources.`],
    ],
    sourcesAppend: null,
  },
  A2: {
    description: DESC + LEGEND_LONG,
    fields: [
      ['Largest trades', [
        `1. Bought 16,137.55 NAM at 02:34 UTC, ${link(TRADER)} · settled at $0.00093128 ⁷ · quote +9.71 % in the 15 min after ⁶.`,
        `3. Sold 9,970.02 NAM at 05:01 UTC, ${code(SELLER)} · settled at $0.00091355 ⁷ · quote −7.81 % in the 15 min after ⁶.`,
      ].join('\n')],
      ['NAM on deck', [
        'In 1,454.20 NAM (1 crossing, 1 address) ⁸ · sold since 1,415.01 · sent back 0.00 · still there 39.19 NAM.',
        `${link(RECEIVER)} in at 15:35 UTC yesterday from ${code(SENDER)} (Public sale allocation (genesis) ¹⁸) · sold 1,415.01 NAM 76 s later, settled at $0.00086313 ⁷ · selling estimate 42 % (from its own sales; the Supply page shows it from 60 %).`,
      ].join('\n')],
      ['Unusual', [
        `• 1,170,000.00 NAM unlocked and withdrawn from staking at 14:19 UTC yesterday by ${link(WITHDRAWER)} (Public sale allocation (genesis) ¹⁸) ³ — requested 20 Sep 13:00 UTC from Stakecito, 32 days earlier ³; withdrawable from about 4 Oct ⁵. Since: nothing on record to 08:00 ³.`,
        'Nothing else by the four rules.',
      ].join('\n')],
      ['Sources (this embed)', '¹⁸ this site\'s label index · other marks: the digest\'s Sources.'],
    ],
    sourcesAppend: null,
  },
  A3: {
    description: DESC + LEGEND_SHORT,
    fields: [
      ['Largest trades', `1. Bought 16,137.55 NAM at 02:34 UTC, ${code(TRADER)} · settled at $0.00093128 ⁷ · quote +9.71 % in the 15 min after ⁶.`],
      ['NAM on deck', [
        'In 1,454.20 NAM (1 crossing, 1 address) ⁸ · sold since 1,415.01 · sent back 0.00 · still there 39.19 NAM.',
        `${code(RECEIVER)} in at 15:35 UTC yesterday from ${code(SENDER)} (Public sale allocation (genesis) ¹⁸) · sold 1,415.01 NAM 76 s later, settled at $0.00086313 ⁷ · selling estimate 42 % (from its own sales; the Supply page shows it from 60 %).`,
      ].join('\n')],
      ['Unusual', [
        `• 1,170,000.00 NAM unlocked and withdrawn from staking at 14:19 UTC yesterday by ${code(WITHDRAWER)} (Public sale allocation (genesis) ¹⁸) ³ — requested 20 Sep 13:00 UTC from Stakecito, 32 days earlier ³; withdrawable from about 4 Oct ⁵.`,
        'Nothing else by the four rules.',
      ].join('\n')],
    ],
    sourcesAppend: SOURCES_LONG,
  },
};

describe('the builder on the figures as the survey read them gives attention-example.txt at the four levels', () => {
  it('A0 to A3: title, description, each field and the Sources entry, counted as Discord counts', async () => {
    const fig = await exampleFigures();
    const picture = await renderAttentionPicture(fig);
    expect(picture).not.toBeNull();
    expect(picture!.ringed).toBe(3);
    const levels = attentionLevels(fig, { picture });
    for (const level of DIGEST_ATTN_LEVELS) {
      const want = EXAMPLE[level];
      const got = levels[level];
      expect(got.embed.title).toBe(TITLE);
      expect(got.embed.description).toBe(want.description);
      expect(got.embed.fields!.map((f) => [f.name, f.value])).toEqual(want.fields);
      expect(got.sourcesAppend).toBe(want.sourcesAppend);
      expect(got.embed.color).toBe(0xffff00);
      expect(got.embed.image).toEqual({ url: 'attachment://attention.png' });
      const expectedChars = [...TITLE].length + [...want.description].length + want.fields.reduce((a, [n, v]) => a + [...n].length + [...v].length, 0);
      expect(got.chars).toBe(expectedChars);
      for (const f of got.embed.fields!) expect([...f.value].length).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
    }
    // the levels shrink; the floor is a third of the full section
    const chars = DIGEST_ATTN_LEVELS.map((l) => levels[l].chars);
    expect(chars[0]).toBeGreaterThan(chars[1]);
    expect(chars[1]).toBeGreaterThan(chars[2]);
    expect(chars[2]).toBeGreaterThan(chars[3]);
    expect(chars[3]).toBeLessThanOrEqual(1079);
    // every line of the example was read: nothing says "not read"
    for (const l of DIGEST_ATTN_LEVELS) for (const f of levels[l].embed.fields!) expect(f.value).not.toContain('not read');
  });

  it('without a picture the legend sentence is left out and the fields are unchanged; the marks can be renumbered by the digest', async () => {
    const fig = await exampleFigures();
    const plain = attentionEmbed(fig, 'A0');
    expect(plain.embed.description).toBe(DESC);
    expect(plain.embed.image).toBeUndefined();
    expect(plain.embed.fields!.map((f) => [f.name, f.value])).toEqual(EXAMPLE.A0.fields);
    const renumbered = attentionEmbed(fig, 'A3', { marks: { labels: '²⁰', trades: '⁹' } });
    expect(renumbered.embed.fields![0].value).toContain('settled at $0.00093128 ⁹');
    expect(renumbered.sourcesAppend).toBe('²⁰ this site\'s label index (genesis file; a wallet\'s tag says "Tag by …")');
    expect(renumbered.embed.fields![0].value).not.toContain('⁷');
  });

  it('the fit rule takes the first level that fits the room, and leaves the embed out, said in words, when even the floor does not', async () => {
    const fig = await exampleFigures();
    const levels = attentionLevels(fig);
    expect((attentionForRoom(fig, 5_000) as { level: AttentionLevel }).level).toBe('A0');
    expect((attentionForRoom(fig, levels.A0.chars - 1) as { level: AttentionLevel }).level).toBe('A1');
    expect((attentionForRoom(fig, levels.A2.chars) as { level: AttentionLevel }).level).toBe('A2');
    expect((attentionForRoom(fig, levels.A3.chars) as { level: AttentionLevel }).level).toBe('A3');
    const out = attentionForRoom(fig, 500);
    expect(out).toMatchObject({ leftOut: true, over: levels.A3.chars - 500 });
    expect((out as { note: string }).note).toBe(`Trades worth attention: left out for room (${(levels.A3.chars - 500).toLocaleString('en-US')} characters over)`);
  });

  it('the weekly variant reads the 7 × 24 h to the send time and says so', async () => {
    const db = testD1();
    seedExample(db);
    const fig = await readAttentionFigures(db as unknown as D1Database, T, 'weekly');
    expect(fig.from).toBe(T - 7 * D);
    expect(fig.unusual.traders).toEqual({ total: 4, top: 3 });
    const e = attentionEmbed({ ...fig, unusual: { ...fig.unusual, first: [] } }, 'A0').embed;
    expect(e.title).toBe('Trades worth attention · 7 days to 08:00 UTC, 23 Oct 2026');
    expect(field(e, 'Unusual')).toContain("(3 of the week's 4 traders are top-100, each with earlier trades ¹⁴)");
    // the quote's readings start a day into the week: the legend says so rather than "over the 7 days" alone
    expect(attentionEmbed(fig, 'A0', { picture: await renderAttentionPicture(fig) }).embed.description).toContain('Picture: the quote over the 7 days (from 08:00 UTC yesterday) with each trade');
  });
});

// ---------------------------------------------------------------- the rules on small fixtures

describe('the quote move around a trade (L1c)', () => {
  it('names the move from the readings, or says which reading is missing: before older than 5 min, none after 10 min, after 15 min not yet', async () => {
    const db = testD1();
    const t1 = T - 3 * H, t2 = T - 2 * H, t3 = T - 5 * MIN;
    insert(db, 'flows', [
      tradeRow({ id: 'osmosis:A1:swap', ts: t1, kind: 'buy', maker: OSMO(1), nam: 30_000, price: 0.001 }),
      tradeRow({ id: 'osmosis:A2:swap', ts: t2, kind: 'buy', maker: OSMO(2), nam: 20_000, price: 0.001 }),
      tradeRow({ id: 'osmosis:A3:swap', ts: t3, kind: 'sell', maker: OSMO(3), nam: 10_000, price: 0.001 }),
    ]);
    insert(db, 'metrics', quoteRows([
      [t1 - 6 * MIN, 0.0010], [t1 + 12 * MIN, 0.0011], // a before reading 6 min old
      [t2 - 30_000, 0.0010], [t2 + 9 * MIN, 0.0012], // nothing at or after t + 10 min
      [t3 - 30_000, 0.0010],
    ]));
    const e = attentionEmbed(await readAttentionFigures(db as unknown as D1Database, T), 'A0').embed;
    const lines = field(e, 'Largest trades')!.split('\n');
    expect(lines[0]).toContain('· no quote within 5 min before ⁶');
    expect(lines[1]).toContain('· no quote in the 15 min after ⁶');
    expect(lines[2]).toContain('· quote after 15 min: not yet ⁶');
    expect(trades(await readAttentionFigures(db as unknown as D1Database, T)).read[2].move).toMatchObject({ after60: 'not yet', notYet15: true });
  });

  it('a trade without a settle record shows its own recorded price with its basis; one without a price says so; the minute quote is never printed as the settle', async () => {
    const db = testD1();
    insert(db, 'flows', [
      tradeRow({ id: 'osmosis:B1:swap', ts: T - 2 * H, kind: 'buy', maker: OSMO(1), nam: 30_000, price: 0.0009, priceSource: 'spot' }),
      tradeRow({ id: 'osmosis:B2:swap', ts: T - 3 * H, kind: 'sell', maker: OSMO(2), nam: 20_000, price: null }),
      // a coin the parser does not know: no settle price, the row's hourly median price stands
      tradeRow({ id: 'osmosis:B3:swap', ts: T - 4 * H, kind: 'buy', maker: OSMO(3), nam: 10_000, price: 0.00085, priceSource: 'swap_1h', settle: { nam: 10_000, coins: {}, unknown: ['uxyz'] } }),
    ]);
    insert(db, 'metrics', quoteRows([[T - 2 * H - 30_000, 0.5], [T - 3 * H - 30_000, 0.5], [T - 4 * H - 30_000, 0.5]]));
    const e = attentionEmbed(await readAttentionFigures(db as unknown as D1Database, T), 'A0').embed;
    const lines = field(e, 'Largest trades')!.split('\n');
    expect(lines[0]).toContain('· at $0.00090000 ⁷ (quote at the time)');
    expect(lines[1]).toContain('· no price was recorded for this trade');
    expect(lines[2]).toContain('· at $0.00085000 ⁷ (hourly median price)');
    expect(field(e, 'Largest trades')).not.toContain('$0.50000000');
  });
});

describe('the median and the five-times rule (L1a, L3b)', () => {
  it('ten trades: the mean of the 5th and 6th; a 60,000 NAM trade fires the rule with the bar named', async () => {
    const db = testD1();
    insert(db, 'flows', [...fx.trades, tradeRow({ id: 'osmosis:C1:swap', ts: T - H, kind: 'buy', maker: OSMO(9), nam: 60_000, price: 0.0009 })]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    // the ten amounts sorted: 60,000, 16,137.55, 11,330.68, 9,970.02, 9,946.07, 9,922.12, …: the mean of the 5th and 6th
    expect(trades(fig).median).toBeCloseTo((9946.068 + 9922.116) / 2, 6);
    const e = attentionEmbed(fig, 'A0').embed;
    expect(field(e, 'Unusual')).toContain(`• ${link(OSMO(9))} bought 60,000.00 NAM at 07:00 UTC, over 5× the median (49,670.46 NAM) ⁸.`);
    expect(e.description).toContain('typical trade 9,934.09 NAM (the median)');
  });

  it('four trades: too few for a median, no five-times rule, said in the description and the not-found line', async () => {
    const db = testD1();
    insert(db, 'flows', [1, 2, 3, 4].map((i) => tradeRow({ id: `osmosis:D${i}:swap`, ts: T - i * H, kind: 'buy', maker: OSMO(i), nam: 1000 * i, price: 0.001 })));
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect(trades(fig).median).toBeNull();
    expect(fig.unusual.multiple).toEqual([]);
    const e = attentionEmbed(fig, 'A0').embed;
    expect(e.description).toContain('4 trades by 4 addresses, 10,000.00 NAM ⁸ (bot round trips left out); too few trades for a median: 4;');
    expect(field(e, 'Unusual')).toContain('a trade over 5× the median (too few trades for a median: 4)');
  });
});

describe('NAM on deck (L2)', () => {
  const crossing = (receiver: string, sender: string, nam: number, ts: number, id = 'X1') => ({
    id: `osmosis:${id}:ibc_in:1`, chain: 'osmosis', height: 1, ts, tx_hash: id, kind: 'ibc_in', from_addr: sender, to_addr: receiver, amount_num: nam,
    counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ packetSequence: '1' }),
  });
  const transfer = (from: string, to: string, nam: number, ts: number, id: string) => ({
    id: `namada:${id}:0`, chain: 'namada', height: 1, ts, tx_hash: id, kind: 'transfer', from_addr: from, to_addr: to, amount_num: nam,
    counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ innerTxHash: id }),
  });

  it('the fee note appears only when the sales\' settle records give the whole crossing while the pools\' NAM does not; a tag prints its byline; an internal receiver is left out', async () => {
    const db = testD1();
    const t0 = A24 + 2 * H;
    insert(db, 'flows', [
      crossing(OSMO(1), TNAM(1), 1000, t0, 'X1'),
      // sold all of it: the pools got 990, the settle record says 1,000 was given
      tradeRow({ id: 'osmosis:S1:swap', ts: t0 + 5 * MIN, kind: 'sell', maker: OSMO(1), nam: 990, price: 0.001, settle: { nam: -1000, coins: { allUSDC: 0.99 } } }),
      crossing(OSMO(2), TNAM(2), 2000, t0, 'X2'),
      // sold half, no settle record: no fee note
      tradeRow({ id: 'osmosis:S2:swap', ts: t0 + 5 * MIN, kind: 'sell', maker: OSMO(2), nam: 1000, price: 0.001 }),
      crossing(INTERNAL_ADDRESSES.osmoTransfer, TNAM(3), 50_000, t0, 'X3'),
    ]);
    insert(db, 'labels', [{ address: TNAM(2), chain: 'namada', label: 'my cold wallet', category: 'watch', source: 'user', author: TNAM(7) }]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const d = deck(fig);
    expect(d.rows.map((r) => r.address)).toEqual([OSMO(2), OSMO(1)]);
    const f1 = d.rows[1].follow, f2 = d.rows[0].follow;
    if (isNotRead(f1) || isNotRead(f2)) throw new Error('not read');
    expect(f1).toMatchObject({ soldCounted: 990, remaining: 10, feeNote: true });
    expect(f2).toMatchObject({ soldCounted: 1000, remaining: 1000, feeNote: false });
    // pressure()'s dumpHazardScore on these figures
    expect(f1.hazard).toBe(Number(Math.min(0.99, 0.7 * (990 + 5000) / (1000 + 25_000) + 0.25).toFixed(3)));
    const e = attentionEmbed(fig, 'A0').embed;
    const text = field(e, 'NAM on deck')!;
    // the header counts every crossing, the transfer module's 50,000 too; the sums are the listed receivers'
    expect(text.split('\n')[0]).toBe('In 53,000.00 NAM (3 crossings, 3 addresses) ⁸ · of the 2 receivers listed: sold since 1,990.00 · sent back 0.00 · still there 1,010.00 NAM.');
    expect(text).toContain(`${code(OSMO(1))} in at 10:00 UTC yesterday from ${code(TNAM(1))} (not listed ¹²) · sold 990.00 NAM 5 min later, settled at $0.00099000 ⁷ (0.99 USDC) · still there 10.00 NAM is the pools' fee in NAM (all 1,000.00 was given, fees in) · no sale in the 30 d before`);
    expect(text).toContain(`from ${code(TNAM(2))} (my cold wallet, Tag by ${TNAM(7).slice(0, 12)}… ¹⁸; not listed ¹²)`);
    expect(text).not.toContain(INTERNAL_ADDRESSES.osmoTransfer.slice(0, 10));
    expect(text).toContain('the Supply page shows it from 60 %');
  });

  it('the hop origin is read for an unlabeled sender only, and named only when it sent at least max(1,000 NAM, 10 % of the crossing)', async () => {
    const db = testD1();
    const t0 = A24 + 2 * H;
    insert(db, 'flows', [
      crossing(OSMO(1), TNAM(1), 1454, t0, 'X1'),
      transfer(TNAM(5), TNAM(1), 5000, t0 - H, 'H1'),
      crossing(OSMO(2), TNAM(2), 20_000, t0, 'X2'),
      transfer(TNAM(6), TNAM(2), 1000, t0 - H, 'H2'), // 1,000 of 20,000: under the 10 % share
      crossing(OSMO(3), TNAM(3), 1454, t0, 'X3'),
      transfer(TNAM(5), TNAM(3), 5000, t0 - H, 'H3'), // a labelled sender: no hop read
    ]);
    insert(db, 'labels', [{ address: TNAM(3), chain: 'namada', label: 'Genesis: af_backers', category: 'genesis', source: 'genesis' }]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const by = new Map(deck(fig).rows.map((r) => [r.address, r]));
    expect(by.get(OSMO(1))!.sender!.hop).toMatchObject({ address: TNAM(5), nam: 5000 });
    expect(by.get(OSMO(2))!.sender!.hop).toBeNull();
    expect(by.get(OSMO(3))!.sender!.hop).toBeNull();
    const text = field(attentionEmbed(fig, 'A0').embed, 'NAM on deck')!;
    expect(text).toContain(`from ${code(TNAM(1))} (funded 2 hops back by ${code(TNAM(5))}; not listed ¹²)`);
    expect(text).toContain(`from ${code(TNAM(3))} (Early backers (genesis) ¹⁸; not listed ¹²)`);
  });

  it('a refunded send back never left: it is not counted as sent back', async () => {
    const db = testD1();
    const t0 = A24 + 2 * H;
    insert(db, 'flows', [
      crossing(OSMO(1), TNAM(1), 1000, t0, 'X1'),
      { id: 'osmosis:O1:ibc_out:1', chain: 'osmosis', height: 1, ts: t0 + H, tx_hash: 'O1', kind: 'ibc_out', from_addr: OSMO(1), to_addr: TNAM(1), amount_num: 600, counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ packetSequence: '77' }) },
      { id: 'osmosis:R1:refund:1', chain: 'osmosis', height: 1, ts: t0 + 2 * H, tx_hash: 'R1', kind: 'other', from_addr: null, to_addr: OSMO(1), amount_num: 600, counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ ibcTimeoutRefund: true, packetSequence: '77' }) },
    ]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const f = deck(fig).rows[0].follow;
    if (isNotRead(f)) throw new Error('not read');
    expect(f).toMatchObject({ bridgedOutSince: 0, sentBackCounted: 0, remaining: 1000 });
  });
});

describe('the unusual rules (L3)', () => {
  const namada = (kind: string, from: string | null, to: string, nam: number, ts: number, id: string, meta: Record<string, unknown> = {}) => ({
    id: `namada:${id}:0`, chain: 'namada', height: 1, ts, tx_hash: id, kind, from_addr: from, to_addr: to, amount_num: nam,
    counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ innerTxHash: id, ...meta }),
  });
  const VAL = TNAM(900);

  it('a withdrawal with an exact request and an epoch reading at the request names the withdraw epoch and, with the digest\'s clock, its time; a nearest match and no request are said', async () => {
    const db = testD1();
    const wd = A24 + 6 * H;
    insert(db, 'flows', [
      namada('withdraw', POS, TNAM(1), 150_000, wd, 'W1'),
      namada('unbond', POS, TNAM(1), 150_000, wd - 20 * D, 'U1', { validator: VAL }),
      namada('withdraw', POS, TNAM(2), 120_000, wd + H, 'W2'),
      namada('unbond', POS, TNAM(2), 119_000, wd - 25 * D, 'U2', { validator: VAL }),
      namada('withdraw', POS, TNAM(3), 110_000, wd + 2 * H, 'W3'),
      // what the first address did next
      namada('bond', TNAM(1), POS, 100_000, wd + H, 'B1', { validator: VAL }),
      namada('ibc_out', TNAM(1), OSMO(1), 40_000, wd + 2 * H, 'I1'),
      namada('transfer', TNAM(1), TNAM(8), 5_000, wd + 3 * H, 'T1'),
    ]);
    insert(db, 'metrics', quoteRows([[wd - 20 * D - 2 * MIN, 2700]], 'epoch'));
    insert(db, 'kv', fx.kv.filter((k) => k.key === 'chain.params'));
    insert(db, 'validator_daily', [{ day: '2026-10-23', validator: VAL, name: 'Val [x](y)', state: 'consensus', stake: 1, delegators: 1, as_of: T, height: 1 }]);
    const clock = { epoch: 2696, startedAt: Date.UTC(2026, 9, 23, 3, 33, 3), epochSec: 21617.16 };
    const fig = await readAttentionFigures(db as unknown as D1Database, T, 'daily', { clock });
    const evs = fig.unusual.withdraw as UnusualEvent[];
    expect(evs.map((e) => e.nam)).toEqual([150_000, 120_000, 110_000]);
    const first = evs[0];
    if (first.rule !== 'withdraw') throw new Error('x');
    expect(first.maturity).toEqual({ kind: 'exact', epoch: 2756, at: clock.startedAt + 60 * clock.epochSec * 1000 });
    const fields = attentionEmbed(fig, 'A0').embed.fields!.filter((f) => f.name.startsWith('Unusual'));
    const text = fields.map((f) => f.value).join('\n');
    const lines = text.split('\n');
    // epoch 2,700 at the request + 56 = 2,756; its clock: 60 epochs of 21,617.16 s after epoch 2,696 began on 23 Oct 03:33 UTC
    expect(lines[0]).toBe(`• 150,000.00 NAM unlocked and withdrawn from staking at 14:00 UTC yesterday by ${link(TNAM(1))} ³ — requested 2 Oct 14:00 UTC from Val [x] (y), 20 days earlier ³; withdrawable from epoch 2,756, 7 Nov 03:50 UTC ⁵. Since: restaked 100,000.00 NAM, bridged out 40,000.00 NAM, transferred 5,000.00 NAM to ${code(TNAM(8))} ³; not on the holder list ¹².`);
    expect(lines[1]).toContain('— nearest request on record: 119,000.00 NAM on 27 Sep 14:00 UTC from Val [x] (y), 25 days earlier ³; withdrawable from about 11 Oct 14:16 UTC (56 epochs of 21,617 s = 14.0 d, an estimate up to one epoch late ⁵). Since: no restake, bridge-out, shielding or transfer to 08:00 ³; not on the holder list ¹².');
    // three full lines pass Discord's 1,024: the field continues in a second of the same name, no line cut
    expect(lines[2]).toContain('— no unbond request on record for this address ³');
    expect(fields.map((f) => f.name)).toEqual(['Unusual', 'Unusual (cont.)']);
    for (const f of fields) expect([...f.value].length).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
    expect(text.endsWith('…')).toBe(false);
    const one = field(attentionEmbed({ ...fig, unusual: { ...fig.unusual, withdraw: evs.slice(0, 1) } }, 'A0').embed, 'Unusual')!.split('\n');
    expect(one[1]).toBe('Not found: a first trade from a top-100 Osmosis holder (no trades); a trade over 5× the median (too few trades for a median: 0); a bridge-out after an unshielding ≥ 50,000 NAM (none ³).');
    // the short levels: one sentence each, the first event only at the floor
    const a3 = field(attentionEmbed(fig, 'A3').embed, 'Unusual')!.split('\n');
    expect(a3[0]).toBe(`• 150,000.00 NAM unlocked and withdrawn from staking at 14:00 UTC yesterday by ${code(TNAM(1))} ³ — requested 2 Oct 14:00 UTC from Val [x] (y), 20 days earlier ³; withdrawable from epoch 2,756, 7 Nov ⁵.`);
    expect(a3[1]).toBe('and 2 more.');
    expect(a3[2]).toBe('Nothing else by the four rules.');
  });

  it('an unshielding of 60,000 NAM with a bridge-out and one without; events ordered by NAM across the rules; "and N more" past the level\'s count', async () => {
    const db = testD1();
    const t0 = A24 + 3 * H;
    insert(db, 'flows', [
      namada('unshield', INTERNAL_ADDRESSES.masp, TNAM(1), 60_000, t0, 'S1'),
      namada('ibc_out', TNAM(1), OSMO(1), 59_000, t0 + 2 * H, 'I1'),
      namada('unshield', INTERNAL_ADDRESSES.masp, TNAM(2), 70_000, t0, 'S2'),
      // an internal receiver is not an event
      namada('unshield', INTERNAL_ADDRESSES.masp, INTERNAL_ADDRESSES.pgf, 80_000, t0, 'S3'),
      namada('withdraw', POS, TNAM(3), 100_000, t0, 'W1'),
      namada('withdraw', POS, TNAM(4), 100_001, t0, 'W2'),
    ]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect((fig.unusual.unshield as UnusualEvent[]).map((e) => e.nam)).toEqual([70_000, 60_000]);
    const text = field(attentionEmbed(fig, 'A0').embed, 'Unusual')!.split('\n');
    expect(text[0]).toContain('• 100,001.00 NAM unlocked');
    expect(text[1]).toContain('• 100,000.00 NAM unlocked');
    expect(text[2]).toBe(`• 70,000.00 NAM left the shielded set at 11:00 UTC yesterday to ${code(TNAM(2))}, no bridge-out yet (21 h since) ³.`);
    expect(text[3]).toBe(`• 60,000.00 NAM left the shielded set at 11:00 UTC yesterday to ${code(TNAM(1))}, and 59,000.00 NAM of it crossed to Osmosis 2 h later ³.`);
    expect(text[4]).toBe('Not found: a first trade from a top-100 Osmosis holder (no trades); a trade over 5× the median (too few trades for a median: 0).');
    const a2 = field(attentionEmbed(fig, 'A2').embed, 'Unusual')!.split('\n');
    expect(a2).toHaveLength(5);
    expect(a2[3]).toBe('and 1 more.');
    expect(a2[4]).toBe('Nothing else by the four rules.');
    const a3 = field(attentionEmbed(fig, 'A3').embed, 'Unusual')!.split('\n');
    expect(a3[1]).toBe('and 3 more.');
  });

  it('"Nothing else by the four rules" is a claim made only when all four reads answered', async () => {
    const fig = await exampleFigures();
    expect(field(attentionEmbed(fig, 'A2').embed, 'Unusual')).toContain('Nothing else by the four rules.');
    const partly: AttentionFigures = { ...fig, unusual: { ...fig.unusual, unshield: notRead('unshield') } };
    expect(field(attentionEmbed(partly, 'A2').embed, 'Unusual')).toContain('1 of the four rules not read (the unshield-then-bridge rule).');
    expect(field(attentionEmbed(partly, 'A0').embed, 'Unusual')).toContain('1 of the four rules not read (the unshield-then-bridge rule). Not found by the others: a first trade from a top-100 Osmosis holder (3 of today\'s 4 traders are top-100, each with earlier trades ¹⁴); a trade over 5× the median (49,610.58 NAM).');
    expect(attentionEmbed(partly, 'A0').embed.description).toContain('1 unusual event, 1 of the four rules not read.');
  });
});

// ---------------------------------------------------------------- bounds

describe('the bounds', () => {
  it('more than 20,000 trades: the newest 20,000 counted and ranked, a maker\'s count past 1,000 says 1,000+, the picture draws the newest 2,000 without rings', async () => {
    const db = testD1();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < DIGEST_TRADES_MAX + 1; i++) {
      const maker = i < DIGEST_ATTN_COUNT_MAX + 1 ? OSMO(1) : OSMO(2 + (i % 50));
      rows.push(tradeRow({ id: `osmosis:E${i}:swap`, ts: A24 + 1000 + i * 4000, kind: i < DIGEST_ATTN_COUNT_MAX + 1 ? 'buy' : 'sell', maker, nam: i === 0 ? 50_000 : 10 + (i % 7), price: 0.001 }));
    }
    insert(db, 'flows', rows);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const t = trades(fig);
    expect(t.n).toBe(DIGEST_TRADES_MAX + 1);
    expect(t.bounded).toBe(true);
    expect(t.read).toHaveLength(10);
    expect(t.read[0].record).toMatchObject({ buys: DIGEST_ATTN_COUNT_MAX, bounded: true });
    expect(fig.pictureBounded).toBe(true);
    expect(fig.pictureTrades).toHaveLength(2000);
    const e = attentionEmbed(fig, 'A0').embed;
    expect(e.description).toContain('(bot round trips left out; more than 20,000 trades: the newest 20,000 counted)');
    expect(field(e, 'Largest trades')).toContain('1,000+ buys, no sale on record');
    const picture = await renderAttentionPng([{ ts: A24 + 1, value: 0.001 }, { ts: T, value: 0.0011 }], fig.pictureTrades as PictureTrade[], A24, T, { ringsOff: fig.pictureBounded });
    expect(picture).toMatchObject({ ringsOff: true, ringed: 0, trades: 2000 });
    expect(attentionEmbed(fig, 'A0', { picture }).embed.description).toContain('trades drawn without rings (more than 2,000) ⁶ ⁷.');
  }, 60_000);

  it('more than 10,000 crossings: the newest 10,000 counted; a receiver with more than 200 sales: the first 200 counted', async () => {
    const db = testD1();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < DIGEST_BRIDGE_MAX + 1; i++) {
      rows.push({ id: `osmosis:F${i}:ibc_in:1`, chain: 'osmosis', height: 1, ts: A24 + 1000 + i * 8000, tx_hash: `F${i}`, kind: 'ibc_in', from_addr: TNAM(i % 20), to_addr: OSMO(i % 30), amount_num: i % 30 === 0 ? 5 : 1, counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: null });
    }
    for (let i = 0; i < DIGEST_ATTN_FOLLOW_MAX + 1; i++) rows.push(tradeRow({ id: `osmosis:G${i}:swap`, ts: A24 + 2000 + i * 1000, kind: 'sell', maker: OSMO(0), nam: 0.5, price: 0.001 }));
    insert(db, 'flows', rows);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    const d = deck(fig);
    expect(d.bounded).toBe(true);
    expect(d.crossings).toBe(DIGEST_BRIDGE_MAX + 1);
    expect(d.rows).toHaveLength(10);
    const f = d.rows.find((r) => r.address === OSMO(0))!.follow;
    if (isNotRead(f)) throw new Error('not read');
    expect(f.sales).toHaveLength(DIGEST_ATTN_FOLLOW_MAX);
    expect(f.salesBounded).toBe(true);
    const text = field(attentionEmbed(fig, 'A0').embed, 'NAM on deck')!;
    expect(text).toContain('In 11,337.00 NAM (10,001 crossings, 30 addresses) ⁸ (the newest 10,000 crossings counted) · of the 10 receivers listed: sold since');
    expect(text).toContain('in 200 sales (200+: the first 200 counted), $0.00100000 ⁷ on average');
  }, 60_000);

  it('a section field over 1,024 characters continues in a field of the same name, line by line', () => {
    const line = (i: number) => `• line ${i} ${'x'.repeat(300)} 1,234.00 NAM ³.`;
    const text = Array.from({ length: 7 }, (_, i) => line(i)).join('\n');
    const fs = fieldsOf('Unusual', text);
    expect(fs.map((f) => f.name)).toEqual(['Unusual', 'Unusual (cont.)', 'Unusual (cont.)']);
    expect(fs.map((f) => f.value).join('\n')).toBe(text);
    for (const f of fs) expect([...f.value].length).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
    expect(fieldsOf('NAM on deck', 'short')).toEqual([{ name: 'NAM on deck', value: 'short', inline: false }]);
  });

  it('a field over 1,024 characters is cut at a clause boundary, never between a number and its mark', () => {
    const long = Array.from({ length: 80 }, (_, i) => `${(i + 1) * 1000}.00 NAM ⁸`).join(' · ');
    const cut = cutField(long);
    expect([...cut].length).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
    expect(cut.endsWith('NAM ⁸…')).toBe(true);
    expect(cutField('short')).toBe('short');
    const e: Embed = { title: 'T', description: 'dd', fields: [{ name: 'n', value: 'vvv', inline: false }], footer: { text: 'ff' } };
    expect(embedChars(e)).toBe(1 + 2 + 1 + 3 + 2);
  });
});

// ---------------------------------------------------------------- not read

describe('"not read": a read that fails is that line\'s NotRead, never a missing line and never a 0', () => {
  it('the database does not answer at all: every line says so, the picture is left out, the four rules are not read', async () => {
    const db = testD1();
    seedExample(db);
    const fig = await readAttentionFigures(failing(db, /ROW_NUMBER\(\)/), T);
    expect(isNotRead(fig.trades) && isNotRead(fig.deck) && isNotRead(fig.series) && isNotRead(fig.pictureTrades)).toBe(true);
    expect(await renderAttentionPicture(fig)).toBeNull();
    const r = attentionEmbed(fig, 'A0');
    expect(r.embed.description).toBe('Trades: not read — the database did not answer this read; 0 unusual events, 4 of the four rules not read.');
    expect(field(r.embed, 'Largest trades')).toBe('Largest trades: not read — the database did not answer this read.');
    expect(field(r.embed, 'NAM on deck')).toBe('NAM on deck: not read — the database did not answer this read.');
    expect(field(r.embed, 'Unusual')).toBe('4 of the four rules not read (the first-trade rule, the five-times rule, the matured-unbond rule, the unshield-then-bridge rule).');
    expect(r.embed.fields!.map((f) => f.name)).toEqual(['Largest trades', 'NAM on deck', 'Unusual']);
    expect(r.sourcesAppend).toBeNull();
  });

  it('the trades\' follow-up batch fails: the quote moves and the records are not read, the first-trade rule is not read, the trades still stand', async () => {
    const db = testD1();
    seedExample(db);
    const fig = await readAttentionFigures(failing(db, /had_buy/), T);
    const t = trades(fig);
    expect(t.n).toBe(9);
    expect(isNotRead(t.read[0].move) && isNotRead(t.read[0].record)).toBe(true);
    expect(isNotRead(fig.unusual.first)).toBe(true);
    const text = field(attentionEmbed(fig, 'A0').embed, 'Largest trades')!;
    expect(text).toContain('· quote move not read ⁶ · record not read.');
    expect(field(attentionEmbed(fig, 'A0').embed, 'Unusual')).toContain('1 of the four rules not read (the first-trade rule). Not found by the others:');
  });

  it('the deck\'s follow-up batch fails: each receiver\'s crossing is printed with "follow-ups not read"', async () => {
    const db = testD1();
    seedExample(db);
    const fig = await readAttentionFigures(failing(db, /f\.kind IN \('sell','ibc_out'\)/), T);
    const d = deck(fig);
    expect(d.crossings).toBe(1);
    expect(isNotRead(d.rows[0].follow)).toBe(true);
    const text = field(attentionEmbed(fig, 'A0').embed, 'NAM on deck')!.split('\n');
    expect(text[0]).toBe('In 1,454.20 NAM (1 crossing, 1 address) ⁸ · follow-ups not read.');
    expect(text[1]).toBe(`${link(RECEIVER)} in at 15:35 UTC yesterday from ${code(SENDER)} (Public sale allocation (genesis) ¹⁸; sender not read) · follow-ups not read.`);
  });

  it('the unusual rules\' batch fails: the matured-unbond and unshield rules are not read, the trades and the deck stand', async () => {
    const db = testD1();
    seedExample(db);
    const fig = await readAttentionFigures(failing(db, /f\.kind = 'unbond'/), T);
    expect(isNotRead(fig.unusual.withdraw) && isNotRead(fig.unusual.unshield)).toBe(true);
    expect(isNotRead(fig.trades) || isNotRead(fig.deck)).toBe(false);
    const text = field(attentionEmbed(fig, 'A2').embed, 'Unusual')!.split('\n');
    expect(text.at(-1)).toBe('2 of the four rules not read (the matured-unbond rule, the unshield-then-bridge rule).');
    expect(text.slice(0, -1).every((l) => l.startsWith('• First trade in 90 days from a top-100 holder:'))).toBe(true);
  });

  it('the Osmosis index behind (stream down, sweep older than 15 min) is said once in the description; the holder pass not current is said with the rank', async () => {
    const db = testD1();
    seedExample(db);
    db.raw.prepare("DELETE FROM kv WHERE key IN ('osmosis.live', 'osmosis.cursor', 'osmosis.holders.pass')").run();
    insert(db, 'kv', [
      { key: 'osmosis.live', value: JSON.stringify({ connected: false, height: 73_000_000 }), updated_at: T - 40 * MIN },
      { key: 'osmosis.cursor', value: JSON.stringify({ height: 73_000_000, at: T - 40 * MIN }), updated_at: T - 40 * MIN },
      { key: 'osmosis.holders.pass', value: JSON.stringify({ trustedStartedAt: T - 7 * H }), updated_at: T },
    ]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect(fig.indexBehind).toEqual({ countedTo: T - 40 * MIN, height: 73_000_000 });
    const e = attentionEmbed(fig, 'A0').embed;
    expect(e.description).toContain(" Counted to 07:20 UTC only ⁸ — this site's Osmosis index is behind (swept to height 73,000,000); moves since are not counted.");
    expect(field(e, 'Largest trades')).toContain('No. 72 Osmosis holder ¹⁴ (holder list not current since 01:00 UTC)');
  });
});

// ---------------------------------------------------------------- the traders, the ranks and the five-times lines

describe('the first-trade rule, the holder ranks and the five-times lines', () => {
  /** Eleven trades: ten by OSMO(1)..OSMO(10), and a small first trade by OSMO(11), a top-100 holder with no earlier trade. */
  const seedTraders = (db: TestD1) => {
    insert(db, 'flows', [
      ...Array.from({ length: 10 }, (_, i) => tradeRow({ id: `osmosis:R${i}:swap`, ts: T - (i + 2) * H, kind: i % 2 ? 'sell' : 'buy', maker: OSMO(i + 1), nam: 1_000 + 100 * i, price: 0.0009 })),
      tradeRow({ id: 'osmosis:R10:swap', ts: T - 30 * MIN, kind: 'buy', maker: OSMO(11), nam: 60, price: 0.0009 }),
    ]);
  };

  it('looks at every trader of the window, not only the makers of the ten largest trades: a top-100 holder\'s small first trade is found and every trader is counted', async () => {
    const db = testD1();
    seedTraders(db);
    seedHolders(db, [{ chain: 'osmosis', address: OSMO(11), balance_num: 50_000 }]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect(fig.unusual.traders).toEqual({ total: 11, top: 1 });
    const first = fig.unusual.first as UnusualEvent[];
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ rule: 'first', address: OSMO(11), nam: 60, kind: 'buy', rank: 1 });
    // with the trader having traded before the window the rule does not fire, and the words count all eleven
    insert(db, 'flows', [tradeRow({ id: 'osmosis:R11:swap', ts: A24 - 3 * D, kind: 'buy', maker: OSMO(11), nam: 70, price: 0.0009 })]);
    const again = await readAttentionFigures(db as unknown as D1Database, T);
    expect(again.unusual.first).toEqual([]);
    expect(field(attentionEmbed(again, 'A0').embed, 'Unusual')).toContain("(1 of today's 11 traders is top-100, each with earlier trades ¹⁴)");
  });

  it('ranks by the Holders page\'s rule: a pool and a protocol account are not holders, on Osmosis and on Namada', async () => {
    const db = testD1();
    seedTraders(db);
    seedHolders(db, [
      { chain: 'osmosis', address: OSMO(90), balance_num: 9_000_000 },
      { chain: 'osmosis', address: INTERNAL_ADDRESSES.osmoTransfer, balance_num: 8_000_000 },
      { chain: 'osmosis', address: OSMO(11), balance_num: 50_000 },
      { chain: 'namada', address: POS, balance_num: 300_000_000, total_num: 300_000_000 },
      { chain: 'namada', address: TNAM(5), balance_num: 2_000_000, total_num: 2_000_000 },
    ]);
    insert(db, 'labels', [{ address: OSMO(90), chain: 'osmosis', label: 'Pool 3005', category: 'pool', source: 'auto' }]);
    insert(db, 'flows', [{
      id: 'namada:W6:0', chain: 'namada', height: 1, ts: T - 2 * H, tx_hash: 'W6', kind: 'withdraw', from_addr: POS, to_addr: TNAM(6), amount_num: 150_000,
      counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: JSON.stringify({ innerTxHash: 'W6' }),
    }]);
    seedHolders(db, [{ chain: 'namada', address: TNAM(6), balance_num: 150_000, total_num: 150_000 }]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect((fig.unusual.first as UnusualEvent[])[0]).toMatchObject({ address: OSMO(11), rank: 1 });
    const wd = (fig.unusual.withdraw as UnusualEvent[])[0];
    if (wd.rule !== 'withdraw' || !wd.holder || isNotRead(wd.holder)) throw new Error('no holder row');
    // the PoS account holds more but is no holder: one holder (TNAM(5)) is above
    expect(wd.holder.above).toBe(1);
  });

  it('the five-times rule is one line per maker and side, with its count, its NAM in all, the largest and the span', async () => {
    const db = testD1();
    insert(db, 'flows', [
      ...Array.from({ length: 8 }, (_, i) => tradeRow({ id: `osmosis:S${i}:swap`, ts: T - (i + 1) * H, kind: 'buy', maker: OSMO(20 + i), nam: 100, price: 0.0009 })),
      tradeRow({ id: 'osmosis:B1:swap', ts: T - 10 * H, kind: 'buy', maker: OSMO(1), nam: 5_000, price: 0.0009 }),
      tradeRow({ id: 'osmosis:B2:swap', ts: T - 9 * H, kind: 'buy', maker: OSMO(1), nam: 7_000, price: 0.0009 }),
      tradeRow({ id: 'osmosis:B3:swap', ts: T - 8 * H, kind: 'buy', maker: OSMO(1), nam: 6_000, price: 0.0009 }),
      tradeRow({ id: 'osmosis:B4:swap', ts: T - 7 * H, kind: 'sell', maker: OSMO(2), nam: 4_000, price: 0.0009 }),
    ]);
    const fig = await readAttentionFigures(db as unknown as D1Database, T);
    expect(trades(fig).median).toBe(100);
    const lines = field(attentionEmbed(fig, 'A0').embed, 'Unusual')!.split('\n');
    expect(lines[0]).toBe(`• ${link(OSMO(1))} bought 3 times over 5× the median (500.00 NAM), 18,000.00 NAM in all (largest 7,000.00), 22:00 UTC yesterday to 00:00 UTC ⁸.`);
    expect(lines[1]).toBe(`• ${code(OSMO(2))} sold 4,000.00 NAM at 01:00 UTC, over 5× the median (500.00 NAM) ⁸.`);
    expect(attentionEmbed(fig, 'A0').embed.description).toContain('2 unusual events by the four rules');
  });
});

describe('the picture\'s quote line and axis', () => {
  const minutes = (from: number, to: number, value = 0.0009): PicturePoint[] => { const out: PicturePoint[] = []; for (let t = from; t <= to; t += MIN) out.push({ ts: t, value }); return out; };
  const base = async (): Promise<AttentionFigures> => ({ ...(await exampleFigures()) });

  it('with no quote reading near the send time the picture is left out and the description says why in one sentence', async () => {
    const fig = { ...(await base()), series: minutes(A24 + MIN, T - 2 * H) };
    expect(pictureLeftOut(fig)).toBe('the quote was not read since 06:00 UTC');
    expect(await renderAttentionPicture(fig)).toBeNull();
    const e = attentionEmbed(fig, 'A0', { pictureNote: pictureLeftOut(fig) }).embed;
    expect(e.description!.endsWith(' No picture: the quote was not read since 06:00 UTC ⁶.')).toBe(true);
    expect(e.image).toBeUndefined();
    expect(pictureLeftOut({ ...fig, series: [] })).toBe('the quote has no reading in the 24 h');
    expect(pictureLeftOut({ ...fig, series: notRead('series') })).toBe('the quote was not read (the database did not answer)');
  });

  it('a line with stretches without a reading names the longest two and counts the rest; one starting late says so', async () => {
    const fig = { ...(await base()), series: [...minutes(A24 + 2 * H, A24 + 10 * H), ...minutes(A24 + 13 * H, A24 + 14 * H), ...minutes(A24 + 14 * H + 20 * MIN, A24 + 20 * H), ...minutes(A24 + 20 * H + 15 * MIN, T)] };
    const pic = await renderAttentionPicture(fig);
    expect(pic).not.toBeNull();
    expect(attentionEmbed(fig, 'A0', { picture: pic }).embed.description).toContain(
      'Picture: the quote over the 24 h (from 10:00 UTC yesterday; no reading 18:00–21:00 UTC yesterday, 22:00–22:20 UTC yesterday and 1 more gap) with each trade at its own price',
    );
  });

  it('the axis is the quote and the trades of 50 NAM or more; a small trade far off it is not drawn but counted; the grid is a few round steps', async () => {
    const series = minutes(A24 + MIN, T, 0.0009);
    const trades: PictureTrade[] = [
      { ts: A24 + 3 * H, kind: 'buy', nam: 5_000, price: 0.00095 },
      { ts: A24 + 5 * H, kind: 'sell', nam: 3, price: 0.0025 },
      { ts: A24 + 7 * H, kind: 'buy', nam: 2, price: 0.00092 },
    ];
    expect(DIGEST_ATTN_AXIS_MIN_NAM).toBe(50);
    const f = attentionFrame(series, trades, A24, T);
    expect(f.yMax).toBe(0.00095);
    expect(f.grid.length).toBeGreaterThan(0);
    expect(f.grid.length).toBeLessThanOrEqual(DIGEST_ATTN_GRID_LINES);
    const d = drawAttention(series, trades, A24, T);
    expect([d.drawn, d.offAxis]).toEqual([2, 1]);
    const pic = await renderAttentionPng(series, trades, A24, T);
    expect(pic).toMatchObject({ trades: 2, offAxis: 1 });
    const fig = { ...(await base()), series, pictureTrades: trades };
    expect(attentionEmbed(fig, 'A0', { picture: pic }).embed.description).toContain('; 1 trade under 50 NAM priced off the axis not drawn ⁶ ⁷.');
  });

  it('the weekly reads the quote over the whole week (the newest first under its bound); past the bound the newest are drawn and said', async () => {
    expect(ATTENTION_SQL.series).toMatch(/ORDER BY ts DESC LIMIT \?3/);
    expect(DIGEST_ATTN_SERIES_MAX.weekly).toBeGreaterThan(7 * 24 * 60);
    const db = testD1();
    const rows: { ts: number; key: string; value: number }[] = [];
    for (let t = T - 7 * D + 2 * MIN; t <= T; t += 2 * MIN) rows.push({ ts: t, key: 'price.usd', value: 0.0009 });
    insert(db, 'metrics', rows);
    const week = await readAttentionFigures(db as unknown as D1Database, T, 'weekly');
    expect((week.series as PicturePoint[]).length).toBe(rows.length);
    expect((week.series as PicturePoint[])[0].ts).toBe(rows[0].ts);
    expect(week.seriesBounded).toBe(false);
    // a day with more readings than the daily bound: the newest are kept, oldest first
    const dense = testD1();
    const many: { ts: number; key: string; value: number }[] = [];
    for (let t = T - D + 30_000; t <= T; t += 30_000) many.push({ ts: t, key: 'price.usd', value: 0.0009 });
    insert(dense, 'metrics', many);
    const day = await readAttentionFigures(dense as unknown as D1Database, T, 'daily');
    const s = day.series as PicturePoint[];
    expect(s).toHaveLength(DIGEST_ATTN_SERIES_MAX.daily);
    expect(s[s.length - 1].ts).toBe(many[many.length - 1].ts);
    expect(s[0].ts).toBeLessThan(s[1].ts);
    expect(day.seriesBounded).toBe(true);
  });
});

// ---------------------------------------------------------------- the statements

describe('every statement reads an index range and is bound', () => {
  const PARAMS: Record<keyof typeof ATTENTION_SQL, unknown[]> = {
    largest: [A24, T], totals: [A24, T], picture: [A24, T], series: [A24, T, DIGEST_ATTN_SERIES_MAX.daily + 1], move: [T, T - 1, T, T - 1, T, T - 1], maker: [OSMO(1), A24 - 90 * D, A24, T],
    makers: [A24, T], overBar: [A24, T, 1_000], internalNamada: [...INTERNAL_ADDRS],
    deckRows: [A24, T], deckTotals: [A24, T], follow: [OSMO(1), A24, T], prior: [OSMO(1), A24 - 30 * D, A24], osmoHolder: [OSMO(1)], namadaHolder: [TNAM(1)],
    hop: [TNAM(1), 1000, A24, T], top100: [], withdrawals: [A24, T, 100_000], request: [TNAM(1), T], after: [TNAM(1), A24, T], validator: [TNAM(1), '2026-10-23', '2026-10-22'],
    epochAt: [T, T - 1], unshieldings: [A24, T, 50_000], bridgeOut: [TNAM(1), A24, T], kv: [], refunds: [A24, T],
  };
  const NEEDS_INDEX: Record<string, RegExp> = {
    largest: /flows_kind/, totals: /flows_kind/, picture: /flows_kind/, series: /sqlite_autoindex_metrics_1/, move: /sqlite_autoindex_metrics_1/, maker: /flows_to.*flows_from|flows_from.*flows_to/s,
    makers: /flows_kind/, overBar: /flows_kind/, internalNamada: /sqlite_autoindex_holders_1/,
    deckRows: /flows_kind/, deckTotals: /flows_kind/, follow: /flows_from/, prior: /flows_from/, osmoHolder: /sqlite_autoindex_holders_1/, namadaHolder: /holders_total/,
    hop: /flows_to/, top100: /COVERING INDEX holders_rank/, withdrawals: /flows_kind/, request: /flows_to/, after: /flows_from/, validator: /sqlite_autoindex_validator_daily_1/,
    epochAt: /sqlite_autoindex_metrics_1/, unshieldings: /flows_kind/, bridgeOut: /flows_from/, kv: /sqlite_autoindex_kv_1/, refunds: /flows_kind/,
  };

  it('each plan names its index and never scans flows, holders, metrics, labels or kv; no statement has a compound SELECT of more than three terms; no statement text holds an address', () => {
    const db = testD1();
    for (const [name, sql] of Object.entries(ATTENTION_SQL) as [keyof typeof ATTENTION_SQL, string][]) {
      const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...PARAMS[name]) as { detail: string }[]).map((r) => r.detail).join('\n');
      expect(plan, name).toMatch(NEEDS_INDEX[name]);
      expect(plan, name).not.toMatch(/SCAN (flows|holders|metrics|labels|kv|validator_daily)\b/);
      expect((sql.match(/\bUNION\b/g) ?? []).length, name).toBeLessThanOrEqual(2);
      expect(sql, name).not.toMatch(/osmo1[a-z0-9]{10,}|tnam1[a-z0-9]{10,}/);
    }
    // the protocol accounts are one primary-key seek each, never a walk of the holder ranks
    expect((db.raw.prepare(`EXPLAIN QUERY PLAN ${ATTENTION_SQL.internalNamada}`).all(...INTERNAL_ADDRS) as { detail: string }[]).map((r) => r.detail).join('\n')).not.toMatch(/holders_rank|holders_total/);
    expect(ATTENTION_SQL.largest).toContain(`LIMIT ${DIGEST_TRADES_MAX + 1}`);
    expect(ATTENTION_SQL.maker).toMatch(/f\.ts >= \?2 AND f\.ts < \?3/);
    for (const sql of [ATTENTION_SQL.follow, ATTENTION_SQL.prior, ATTENTION_SQL.hop, ATTENTION_SQL.request, ATTENTION_SQL.after, ATTENTION_SQL.bridgeOut]) expect(sql).toMatch(/LIMIT \d+/);
  });

  it('the fixture\'s substituted trader is fixture-shaped and the rendered bodies hold no mention', async () => {
    expect(TRADER).toBe('osmo1digest' + 'q'.repeat(32));
    expect((fx.trades[0].meta as string).includes(TRADER)).toBe(true);
    const fig = await exampleFigures();
    for (const l of DIGEST_ATTN_LEVELS) expect(JSON.stringify(attentionEmbed(fig, l).embed)).not.toMatch(/@|<@|@everyone/);
  });
});

// ---------------------------------------------------------------- the picture

describe('the picture: the quote over the window with each trade at its own price', () => {
  const at = (png: Uint8Array) => {
    const chunks = readPngChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), chunks[0].data[8], chunks[0].data[9]]).toEqual([DIGEST_ATTN_PNG.w, DIGEST_ATTN_PNG.h, 8, 6]);
    const raw = inflateSync(chunks[1].data);
    const stride = DIGEST_ATTN_PNG.w * 4 + 1;
    expect(raw.length).toBe(DIGEST_ATTN_PNG.h * stride);
    for (let y = 0; y < DIGEST_ATTN_PNG.h; y++) expect(raw[y * stride]).toBe(0);
    return (x: number, y: number) => [raw[y * stride + 1 + x * 4], raw[y * stride + 2 + x * 4], raw[y * stride + 3 + x * 4], raw[y * stride + 4 + x * 4]];
  };

  it('is a valid PNG of 1200 × 420 RGBA with filter 0 on every row and a good CRC per chunk, and matches the drawing', async () => {
    const fig = await exampleFigures();
    const pic = await renderAttentionPicture(fig);
    expect(pic).not.toBeNull();
    const px = at(pic!.png);
    expect(pic!.png.length).toBeLessThan(100_000);
    expect(pic!).toMatchObject({ ringed: 3, ringsOff: false, quotes: 1328, trades: 9 });
    // the axis spans the quotes and the trades' prices: the lowest is the first quote reading of the window, the highest the quote's peak
    expect(fmtPrice(pic!.yMin)).toBe('$0.00084557');
    expect(fmtPrice(pic!.yMax)).toBe('$0.00094073');
    const drawn = drawAttention(fig.series as PicturePoint[], fig.pictureTrades as PictureTrade[], fig.from, fig.to).px;
    expect(px(0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(600, 200)).toEqual([...drawn.subarray((200 * DIGEST_ATTN_PNG.w + 600) * 4, (200 * DIGEST_ATTN_PNG.w + 600) * 4 + 4)]);
  });

  it('the three largest trades carry the yellow ring and the others do not; a 10-min gap leaves the line open; the y range takes a trade settled under the lowest quote', async () => {
    const series: PicturePoint[] = [];
    for (let t = A24 + MIN; t <= T; t += MIN) if (t < A24 + 12 * H || t > A24 + 12 * H + 20 * MIN) series.push({ ts: t, value: 0.00101 });
    // prices and times off the grid's steps ($0.00002, 6 h), so a sample beside a disc reads the surface, not a gridline
    const trades: PictureTrade[] = [
      { ts: A24 + 2.5 * H, kind: 'buy', nam: 16_000, price: 0.00111 },
      { ts: A24 + 4.5 * H, kind: 'sell', nam: 12_000, price: 0.00121 },
      { ts: A24 + 6.5 * H, kind: 'buy', nam: 9_000, price: 0.00131 },
      { ts: A24 + 8.5 * H, kind: 'sell', nam: 1_000, price: 0.00141 },
      { ts: A24 + 20.5 * H, kind: 'buy', nam: 500, price: 0.00051 },
    ];
    const pic = await renderAttentionPng(series, trades, A24, T);
    expect(pic).not.toBeNull();
    expect(pic!.yMin).toBe(0.00051);
    const px = at(pic!.png);
    const f = attentionFrame(series, trades, A24, T);
    const ring = (t: PictureTrade) => px(Math.round(f.x(t.ts) + f.r(t.nam) + 3), Math.round(f.y(t.price)));
    const centre = (t: PictureTrade) => px(Math.round(f.x(t.ts)), Math.round(f.y(t.price)));
    expect(ring(trades[0])).toEqual([255, 255, 0, 255]);
    expect(ring(trades[1])).toEqual([255, 255, 0, 255]);
    expect(ring(trades[2])).toEqual([255, 255, 0, 255]);
    expect(ring(trades[3])).toEqual([0, 0, 0, 255]);
    expect(ring(trades[4])).toEqual([0, 0, 0, 255]);
    expect(centre(trades[0])).toEqual([...PICTURE_COLOURS.buy, 255]);
    expect(centre(trades[1])).toEqual([...PICTURE_COLOURS.sell, 255]);
    // the line is drawn where the quote reads and open across the gap
    expect(px(Math.round(f.x(A24 + 10 * H + 15 * MIN)), Math.round(f.y(0.00101)))).toEqual([...PICTURE_COLOURS.line, 255]);
    expect(px(Math.round(f.x(A24 + 12 * H + 10 * MIN)), Math.round(f.y(0.00101)))).toEqual([0, 0, 0, 255]);
  });

  it('no quote reading, or a renderer failure, gives no picture: the section goes without the legend and with its fields unchanged', async () => {
    expect(await renderAttentionPng([], [{ ts: T - H, kind: 'buy', nam: 1, price: 1 }], A24, T)).toBeNull();
    expect(await renderAttentionPng([{ ts: T - H, value: Number.NaN }], [], A24, T)).toBeNull();
    const fig = await exampleFigures();
    const without = attentionEmbed({ ...fig, series: notRead('series') }, 'A0', { picture: await renderAttentionPicture({ ...fig, series: notRead('series') }) });
    expect(without.embed.description).toBe(DESC);
    expect(without.embed.fields!.map((f) => [f.name, f.value])).toEqual(EXAMPLE.A0.fields);
    expect(DEFAULT_MARKS.quote).toBe('⁶');
    expect(DIGEST_ATTN_TRADES).toBe(3);
  });
});

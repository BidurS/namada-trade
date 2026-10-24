// What a move's Discord alert says beside the move (sources/discord-context.ts readMoveContext), over a seeded
// database: the person's own record before it (the move's own crossing, bot trades, other coins and dust left out;
// each crossing once; runs of one kind merged), a trade's newest crossing in, its trades of 30 days, the NAM on deck
// at a receiver as of the post, when an unstaking request becomes spendable (the chain's own list before the
// estimate), the staking wait, the validator's name, a route's quote, the labels joined; all in one D1 batch read
// before the claim, and a batch that fails or hangs never costs the alert.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { readMoveContext, resetContextCache, CONTEXT_DEADLINE_MS } from '../worker/src/sources/discord-context';
import { buildFlowDiscordBody, configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

const I = INTERNAL_ADDRESSES;
// address-shaped (the alphabet of a real address, no b, i, o or 1), so the card treats them as addresses
const osmo = (s: string) => `osmo1${s.padEnd(38, 'q')}`;
const tnam = (s: string) => `tnam1${s.padEnd(40, 'q')}`;
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const T = Date.UTC(2026, 9, 21, 14, 47);
let n = 0;

/** A stored flow row; `meta` as an object. */
function row(over: Partial<Record<string, unknown>> & { kind: string; chain: string; ts: number; amount_num: number }) {
  n += 1;
  const { meta, ...rest } = over as any;
  return { id: `${over.chain}:CTX${n}:0`, height: n, tx_hash: `CTX${n}`, from_addr: null, to_addr: null, price_usd: null, value_usd: null, ...rest, meta: meta === undefined ? '{"tsSource":"block","source":"t"}' : meta === null ? null : JSON.stringify({ source: 't', ...meta }) };
}
const flowOf = (r: any): Flow => ({
  id: r.id, chain: r.chain, height: r.height, ts: r.ts, txHash: r.tx_hash, kind: r.kind, from: r.from_addr, to: r.to_addr, amount: r.amount_num,
  priceUsd: r.price_usd, valueUsd: r.value_usd, meta: r.meta ? JSON.parse(r.meta) : null,
});
/** Part `i` of a card's description; the no-break space between a figure and its unit (shared/format.ts NBSP) read as a space. */
const line = (f: Flow, ctx: any, i: number) => String(buildFlowDiscordBody(f, ctx).embeds[0].description).replace(/\u00a0/g, ' ').split('\n\n')[i];

let db: TestD1;
// row ids run on across tests: an alert's move is claimed once an isolate, whichever test offers it
beforeEach(() => { db = testD1(); resetContextCache(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('a sale: what the seller did before', () => {
  it('the crossing that brought the NAM, the last sales merged, the 30 days\' sales, the record: bots, other coins, dust and the move itself left out', async () => {
    const seller = osmo('sllr');
    insert(db, 'flows', [
      row({ chain: 'osmosis', kind: 'ibc_in', from_addr: tnam('sndr'), to_addr: seller, ts: T - 50 * MIN, amount_num: 1_500_000 }),
      row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T - 14 * MIN, amount_num: 99_221 }),
      row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T - 12 * MIN, amount_num: 49_491 }),
      row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T - 5 * MIN, amount_num: 49_490 }),
      // a bot round trip, a move in another coin and dust: none is a move of this list
      row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T - 4 * MIN, amount_num: 7_000, meta: { arb: true } }),
      row({ chain: 'osmosis', kind: 'transfer', from_addr: seller, to_addr: osmo('xx'), ts: T - 3 * MIN, amount_num: 500, meta: { tokenSymbol: 'OSMO' } }),
      row({ chain: 'osmosis', kind: 'lp_remove', to_addr: seller, ts: T - 2 * MIN, amount_num: 0.001 }),
      // older than 7 days: in the 30 days' count, not in the list
      row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T - 10 * D, amount_num: 1_000 }),
    ]);
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T, amount_num: 791_848 });
    insert(db, 'flows', [sale]);
    const { ctx } = await readMoveContext(db as any, flowOf(sale), T + 5_000);
    expect(ctx.crossingIn).toMatchObject({ amount: 1_500_000, ts: T - 50 * MIN });
    expect(ctx.before!.map((m) => m.amount)).toEqual([49_490, 49_491, 99_221]);
    expect(ctx.trades30d).toEqual({ side: 'sell', n: 4, nam: 199_202, firstTs: T - 10 * D });
    expect(ctx.history).toMatchObject({ n: 5, capped: false });
    expect(line(flowOf(sale), ctx, 2)).toBe("Before this: received 1,500,000 NAM from Namada 50 min earlier; sold 49,490, 49,491 and 99,221 NAM in the 14 min before; sold 199,202 NAM in 4 trades in the 30 days before, the first 10 days before this one; 5 moves by this address on record before this, the first <t:" + Math.floor((T - 10 * D) / 1000) + ":D> (this site's records).");
  });
  it('no sale before is a fact, said; no move on record is said too', async () => {
    const seller = osmo('nwsllr');
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T, amount_num: 21_623 });
    insert(db, 'flows', [sale]);
    const { ctx } = await readMoveContext(db as any, flowOf(sale), T);
    expect(line(flowOf(sale), ctx, 2)).toBe("Before this: no sale by this address in the 30 days before; no earlier move by this address on record (this site's records).");
  });
});

describe('a crossing to Osmosis: both sides, the move\'s own crossing left out, the NAM on deck as of the post', () => {
  it('the sender\'s unshields merged, the receiver new to the record, and its on-deck figure net of its sales and sends back', async () => {
    const sender = tnam('sndr'), receiver = osmo('rcvr');
    const seq = '4242';
    insert(db, 'flows', [
      row({ chain: 'namada', kind: 'unshield', from_addr: I.masp, to_addr: sender, ts: T - 8 * MIN, amount_num: 1_000 }),
      row({ chain: 'namada', kind: 'unshield', from_addr: I.masp, to_addr: sender, ts: T - 7 * MIN, amount_num: 1_600_000 }),
      // the Namada record of this very crossing, 16 s before: not a move before it
      row({ chain: 'namada', kind: 'ibc_out', from_addr: sender, to_addr: receiver, ts: T - 16_000, amount_num: 1_500_000, meta: { channel: NAM.namadaChannel, packetSequence: seq } }),
    ]);
    const recv = row({ chain: 'osmosis', kind: 'ibc_in', from_addr: sender, to_addr: receiver, ts: T, amount_num: 1_500_000, meta: { channel: NAM.osmoChannel, packetSequence: seq } });
    insert(db, 'flows', [recv]);
    const f = flowOf(recv);
    const live = await readMoveContext(db as any, f, T + 5_000);
    expect(live.ctx.otherBefore!.map((m) => m.amount)).toEqual([1_600_000, 1_000]);
    expect(live.ctx.history).toMatchObject({ n: 0 });
    expect(live.ctx.onDeck).toEqual({ bridgedIn: 1_500_000, remaining: 1_500_000 });
    expect(line(f, live.ctx, 2)).toBe("Before this: the sender moved 1,600,000 and 1,000 NAM out of the shielded set in the 8 min before; no sale by the receiver in the 30 days before; no earlier move by the receiver on record (this site's records).\nOn deck at the receiver as of this post: 1,500,000 NAM of 1,500,000 NAM bridged in over the last 7 days, not yet sold or sent back (this site's records).");
    // later: it sold most of it, and a send back that timed out and was refunded does not count
    insert(db, 'flows', [
      row({ chain: 'osmosis', kind: 'sell', from_addr: receiver, ts: T + H, amount_num: 1_484_979 }),
      row({ chain: 'osmosis', kind: 'ibc_out', from_addr: receiver, to_addr: sender, ts: T + 2 * H, amount_num: 10_000, meta: { packetSequence: '77' } }),
      row({ chain: 'osmosis', kind: 'other', from_addr: I.osmoTransfer, to_addr: receiver, ts: T + 3 * H, amount_num: 10_000, meta: { ibcTimeoutRefund: true, packetSequence: '77' } }),
    ]);
    resetContextCache();
    const late = await readMoveContext(db as any, f, T + 4 * H);
    expect(late.ctx.onDeck).toEqual({ bridgedIn: 1_500_000, remaining: 15_021 });
  });
});

describe('each crossing once in a list of moves', () => {
  it('a staker that received NAM from Osmosis has one move listed, though both chains recorded it', async () => {
    const staker = tnam('stkr'), from = osmo('sndr');
    insert(db, 'flows', [
      row({ chain: 'osmosis', kind: 'ibc_out', from_addr: from, to_addr: staker, ts: T - 81_000, amount_num: 312_216.6 }),
      row({ chain: 'namada', kind: 'ibc_in', from_addr: from, to_addr: staker, ts: T - 76_000, amount_num: 312_216.6 }),
    ]);
    const bond = row({ chain: 'namada', kind: 'bond', from_addr: staker, to_addr: I.pos, ts: T, amount_num: 313_430, meta: { validator: tnam('vldtr') } });
    insert(db, 'flows', [bond]);
    const { ctx } = await readMoveContext(db as any, flowOf(bond), T);
    expect(ctx.before).toHaveLength(1);
    expect(line(flowOf(bond), ctx, 2)).toMatch(/^Before this: received 312,217 NAM from Osmosis 1 min earlier; 1 move by this address on record before this/);
  });
});

describe('the two sides of a transfer, and a bot', () => {
  it('a transfer lists the receiver\'s moves and then the sender\'s, a move between the two once', async () => {
    const a = osmo('sndr'), b = osmo('rcvr');
    const between = row({ chain: 'osmosis', kind: 'transfer', from_addr: a, to_addr: b, ts: T - H, amount_num: 609.1 });
    insert(db, 'flows', [between, row({ chain: 'osmosis', kind: 'transfer', from_addr: osmo('thrd'), to_addr: b, ts: T - 2 * H, amount_num: 35.4 })]);
    const t = row({ chain: 'osmosis', kind: 'transfer', from_addr: a, to_addr: b, ts: T, amount_num: 17_003 });
    insert(db, 'flows', [t]);
    const { ctx } = await readMoveContext(db as any, flowOf(t), T);
    expect(line(flowOf(t), ctx, 2)).toMatch(/^Before this: the receiver got 609\.1 and 35\.4 NAM in transfers in the 2 h before; 2 moves by the receiver on record before this/);
  });
  it('a bot round trip has no record line: the list leaves bot trades out, so it would say nothing true of a bot', async () => {
    const bot = osmo('xyzt');
    insert(db, 'flows', [row({ chain: 'osmosis', kind: 'other', from_addr: bot, to_addr: bot, ts: T - H, amount_num: 40_000, meta: { arb: true } })]);
    const r = row({ chain: 'osmosis', kind: 'other', from_addr: bot, to_addr: bot, ts: T, amount_num: 46_275, meta: { arb: true, namBought: 46_274.64, namSold: 46_182.09 } });
    insert(db, 'flows', [r]);
    const { ctx } = await readMoveContext(db as any, flowOf(r), T);
    expect(ctx.before).toBeUndefined();
    expect(ctx.history).toBeUndefined();
    expect(String(buildFlowDiscordBody(flowOf(r), ctx).embeds[0].description)).not.toContain('Before this');
  });
});

describe('what the site\'s pages say such a move means', () => {
  const params = { unbondingLength: 53, pipelineLength: 2, cubicSlashingWindowLength: 1, minEpochSec: 21600, epochSec: 21636, epochSecNote: 'about 6.01 h an epoch, measured over the last 31 epochs', apr: null, fetchedAt: T };
  it('an unstaking request: spendable around the request time + 56 epochs, an estimate said to be one', async () => {
    insert(db, 'kv', [{ key: 'chain.params', value: JSON.stringify(params), updated_at: T }]);
    const staker = tnam('stkr');
    const unbond = row({ chain: 'namada', kind: 'unbond', from_addr: I.pos, to_addr: staker, ts: T, amount_num: 25_100, meta: { validator: tnam('vldtr') } });
    insert(db, 'flows', [unbond]);
    const { ctx } = await readMoveContext(db as any, flowOf(unbond), T);
    const at = T + 56 * 21636 * 1000;
    expect(ctx.unlockAt).toEqual({ at, source: 'estimate', note: 'estimate: the request time + 56 epochs of about 6.01 h an epoch, measured over the last 31 epochs, late by up to one epoch' });
    const u = Math.floor(at / 1000);
    expect(String(buildFlowDiscordBody(flowOf(unbond), ctx).embeds[0].description)).toContain(`Spendable when the wait ends, around <t:${u}:D> (<t:${u}:R>; estimate: the request time + 56 epochs`);
  });
  it('the chain\'s own bond listing, when current and it lists this request, wins over the estimate', async () => {
    const staker = tnam('stkr'), validator = tnam('vldtr');
    insert(db, 'kv', [
      { key: 'chain.params', value: JSON.stringify(params), updated_at: T },
      { key: 'unbond.withdraw', value: JSON.stringify({ at: T + MIN, source: 'consensus', byAddress: { [staker]: [{ validator, amountNam: 25_100, withdrawEpoch: 2760, withdrawTime: T + 13 * D, source: 'consensus' }] } }), updated_at: T },
    ]);
    const unbond = row({ chain: 'namada', kind: 'unbond', from_addr: I.pos, to_addr: staker, ts: T, amount_num: 25_100, meta: { validator } });
    insert(db, 'flows', [unbond]);
    const { ctx } = await readMoveContext(db as any, flowOf(unbond), T + 2 * MIN);
    expect(ctx.unlockAt).toEqual({ at: T + 13 * D, source: 'consensus', note: 'the chain’s own list gives the epoch it ends in; the time comes from the measured epoch length' });
  });
  it('a bond: the staking wait and the validator by the name the site\'s list gives it', async () => {
    const validator = tnam('vldtr');
    insert(db, 'kv', [
      { key: 'chain.params', value: JSON.stringify(params), updated_at: T },
      { key: 'intel.cache', value: JSON.stringify({ validators: [{ address: validator, name: 'A validator' }], topics: [], latestPosts: [], proposals: [] }), updated_at: T },
    ]);
    const bond = row({ chain: 'namada', kind: 'bond', from_addr: tnam('stkr'), to_addr: I.pos, ts: T, amount_num: 313_430, meta: { validator } });
    insert(db, 'flows', [bond]);
    const { ctx } = await readMoveContext(db as any, flowOf(bond), T);
    expect(ctx.validatorName).toBe('A validator');
    expect(ctx.wait).toMatchObject({ epochs: 56, note: 'about 6.01 h an epoch, measured over the last 31 epochs' });
    const d = String(buildFlowDiscordBody(flowOf(bond), ctx).embeds[0].description).replace(/\u00a0/g, ' ');
    expect(d).toMatch(/^By tnam1stkrq…qqqqq, with validator A validator\./);
    expect(d).toContain('Out of the spendable supply until unstaked; unstaking takes 56 epochs, about 14 days (about 6.01 h an epoch, measured over the last 31 epochs).');
  });
  it('a move priced at a quote the cron read as a route\'s spot names the route, from the price\'s read log', async () => {
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [{ how: 'route', refNam: 1000, routes: [], liquidityUsd: null, since: T - H }] }), updated_at: T }]);
    const r = row({ chain: 'namada', kind: 'unshield', from_addr: I.masp, to_addr: tnam('rcvr'), ts: T, amount_num: 60_000, price_usd: 0.0009, value_usd: 54, meta: { priceSource: 'spot' } });
    insert(db, 'flows', [r]);
    const { ctx } = await readMoveContext(db as any, flowOf(r), T);
    expect(ctx.priceRoute).toBe(1000);
    expect(line(flowOf(r), ctx, 0)).toContain('(Osmosis route quote, 1,000 NAM).');
  });
  it('the labels of both sides are joined for a move from the live stream, in the site\'s words, a tag with its byline', async () => {
    const tagged = tnam('tggd');
    insert(db, 'labels', [{ address: tagged, chain: 'namada', label: 'Team wallet', category: 'other', source: 'user', author: tnam('athr') }]);
    const r = row({ chain: 'namada', kind: 'withdraw', from_addr: I.pos, to_addr: tagged, ts: T, amount_num: 1_170_000 });
    insert(db, 'flows', [r]);
    const read = await readMoveContext(db as any, flowOf(r), T);
    expect(line(read.flow, read.ctx, 0)).toMatch(/^To Team wallet tnam1tggdq…qqqqq \(Tag by tnam1athrqqq…\)\./);
  });
});

describe('one bounded read, and never the alert\'s loss', () => {
  it('the whole context is one D1 batch', async () => {
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: osmo('sllr'), ts: T, amount_num: 21_623 });
    insert(db, 'flows', [sale]);
    const batch = vi.spyOn(db, 'batch');
    await readMoveContext(db as any, flowOf(sale), T);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('a batch that fails gives the move alone, and the operator is still posted with its first line and links', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }));
    configureAlerts(undefined, true);
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: osmo('sllr'), ts: T, amount_num: 21_623, price_usd: 0.0009, value_usd: 19.46, meta: { priceSource: 'spot' } });
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: overloaded'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendDiscordWhaleAlert('https://discord.com/api/webhooks/91/op', flowOf(sale), db as any, 10_000);
    expect(calls).toHaveLength(1);
    const e = calls[0].embeds[0];
    expect(e.title).toBe('21,623 NAM sold on Osmosis');
    expect(String(e.description)).toMatch(/^Sold by osmo1sllrq…qqqqq\. What it settled at is not on record; at \$0\.000900 a NAM \(Osmosis quote\) it is worth about \$19\.46\.\n\n\[osmo1sllrq…qqqqq on NamadaTrade\]/);
    expect(String(e.description)).not.toContain('Before this');
  });
  it('a batch that does not come back within its deadline gives the move alone too, and the post goes', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }));
    configureAlerts(undefined, true);
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: osmo('sllr'), ts: T, amount_num: 21_623 });
    vi.spyOn(db, 'batch').mockImplementationOnce(() => new Promise(() => {}));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = Date.now();
    await sendDiscordWhaleAlert('https://discord.com/api/webhooks/92/op', flowOf(sale), db as any, 10_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CONTEXT_DEADLINE_MS - 50);
    expect(calls).toHaveLength(1);
    expect(calls[0].embeds[0].title).toBe('21,623 NAM sold on Osmosis');
  });
  it('the context is read before the move\'s claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    configureAlerts(undefined, true);
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: osmo('sllr'), ts: T, amount_num: 21_623 });
    const order: string[] = [];
    const prep = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { order.push(/INSERT OR IGNORE INTO kv/.test(sql) ? 'claim' : 'read'); return prep(sql); });
    await sendDiscordWhaleAlert('https://discord.com/api/webhooks/93/op', flowOf(sale), db as any, 10_000);
    expect(order).toContain('claim');
    expect(order.indexOf('read')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('read')).toBeLessThan(order.indexOf('claim'));
  });
});

// A large move out of the shielded pool on Discord and Telegram (2026-11-07, C1): the card's "what this means" line says
// what the pool held before the move, the share the move took of the pool and of all NAM, each figure with its source,
// and, only when true, that no move out on this site's record since 13 Jun 2025 was as large. The context read
// (sources/discord-context.ts poolMove) takes the pool's balance before the move from the block's own record of the
// balance after the inner transaction (meta.maspPostNam) plus the inner transaction's legs read as the row's siblings,
// else from the minute reading just before the block, said as "about"; all NAM from the minute reading before the block;
// and asks whether any move out on record was as large only for a move of 10,000 NAM or more. The X text is not touched.
import { describe, it, expect } from 'vitest';
import { buildFlowDiscordBody, moveCard, fits, poolMoveWords, POOL_MOVE_MIN_SHARE_PCT } from '../worker/src/sources/discord';
import { cardMessage } from '../worker/src/sources/telegram';
import { readMoveContext, POOL_MOVE_LARGEST_MIN_NAM, type MoveContext } from '../worker/src/sources/discord-context';
import { rowToFlow } from '../worker/src/analytics';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { RECORD_SINCE } from '../shared/record-since';
import { BANNED } from './banned-words';
import { testD1, insert } from './d1-sqlite';

const MASP = INTERNAL_ADDRESSES.masp;
const T = Date.UTC(2026, 10, 2, 18, 0);
const H = 3_600_000;
const RCPT = 'tnam1qzsulcx3lzusdg98pmt5y460z59leazhy5xpe6d3';
const GAS = 'tnam1qzjg8tswc9j02emdnmmft02lmdafss8cvgpqm8as';
const W = 'FE56A2F79DEB8D2D6BC9A800FFF913487F5971019A575ED61BE9FB311F2C197C';
const INNER = '85DE92A26A13DB5ACB2846F5862F5991AA7F5F49EB4BF53D453301CF79CD5FF8';
/** the pool's NAM after the inner transaction, base units as the block's event wrote them (31,564,969.658039 NAM) */
const POST = '31564969658039';

/** the unshield as a refiled record keeps it: the fee leg a sibling row of the inner transaction (feeRow), not meta.maspFeeNam */
const unshield = (over: Record<string, unknown> = {}) => ({
  id: `namada:${W}:1`, chain: 'namada', height: 8510819, ts: T, tx_hash: W, kind: 'unshield', from_addr: MASP, to_addr: RCPT, amount_num: 15_000_000,
  meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: INNER, maspPostNam: POST }), ...over,
});
/** the same move as the parser files it when the pool paid two targets: the fee folded into the row's meta, no sibling */
const unshieldWithFee = () => unshield({ meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: INNER, maspPostNam: POST, maspFeeNam: 0.134937 }) });
const feeRow = { id: `namada:${W}:2`, chain: 'namada', height: 8510819, ts: T, tx_hash: W, kind: 'masp_fee', from_addr: MASP, to_addr: GAS, amount_num: 0.134937, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: INNER, maspPostNam: POST }) };

const pm = (over: Partial<NonNullable<MoveContext['poolMove']>> = {}): NonNullable<MoveContext['poolMove']> => ({
  beforeNam: 46_564_969.792976, about: false, beforeAt: T, sharePct: 32.213, allNam: 1_148_774_450, allAt: T - 30_000, allSharePct: 1.3057, largest: true, ...over,
});
const desc = (f: ReturnType<typeof rowToFlow>, ctx: MoveContext) => String(fits(moveCard(f, { whaleNam: 10_000, ...ctx })).description);

describe('the means line of a large move out of the pool', () => {
  const f = rowToFlow(unshield());
  it('says what the pool held before, with the block as its source, the share of the pool and of all NAM with theirs, and the largest clause only when true', () => {
    const line = poolMoveWords(pm(), 8510819);
    expect(line).toBe(`The shielded pool held 46,564,970 NAM before this (the chain’s record of block 8,510,819); this took 32.2% of it and 1.3% of all NAM (1,148,774,450 NAM, this site’s reading <t:${Math.floor((T - 30_000) / 1000)}:R>), the largest move out by amount on this site’s record since 13 Jun 2025.`);
    expect(poolMoveWords(pm({ largest: false }), 8510819)).not.toContain('largest');
    expect(poolMoveWords(pm({ largest: null }), 8510819)).not.toContain('largest');
    expect(RECORD_SINCE.shieldedMoves).toBe(Date.UTC(2025, 5, 13));
  });
  it('a pool balance read from the minute before the block is said as "about", with the reading as its source', () => {
    const line = poolMoveWords(pm({ about: true, beforeAt: T - 50_000, beforeNam: 46_500_000 }), 8510819);
    expect(line).toContain(`held about 46,500,000 NAM before this (this site’s reading of the pool <t:${Math.floor((T - 50_000) / 1000)}:R>, before the block)`);
  });
  it('without a reading of all NAM the sentence keeps to the pool', () => {
    const line = poolMoveWords(pm({ allNam: null, allAt: null, allSharePct: null, largest: false }), 8510819);
    expect(line).toBe('The shielded pool held 46,564,970 NAM before this (the chain’s record of block 8,510,819); this took 32.2% of it.');
  });
  it('the card carries the line as its means line at 1% of the pool or more, and none under it; the words never say the minted total did not change or when the receiver was first seen', () => {
    const d = desc(f, { poolMove: pm() });
    expect(d).toContain('The shielded pool held 46,564,970 NAM before this');
    expect(d).not.toMatch(/minted NAM did not change|first seen/i);
    expect(d).not.toMatch(BANNED);
    expect(POOL_MOVE_MIN_SHARE_PCT).toBe(1);
    const small = desc(f, { poolMove: pm({ sharePct: 0.4, largest: false }) });
    expect(small).not.toContain('The shielded pool held');
    // an unshield's means line stays empty without the context, as before
    expect(desc(f, {})).not.toContain('The shielded pool held');
  });
  it('Telegram gets the same card: the line in its HTML with the reading as a time stamp', () => {
    const m = cardMessage(moveCard(f, { whaleNam: 10_000, poolMove: pm() }), T);
    expect(m.html).toContain('The shielded pool held 46,564,970 NAM before this (the chain’s record of block 8,510,819); this took 32.2% of it and 1.3% of all NAM');
    expect(m.html).not.toContain('<t:');
    expect(m.html).toContain('the largest move out by amount on this site’s record since 13 Jun 2025');
  });
  it('a crossing straight out of the pool over the bridge takes the line in place of the on-deck line', () => {
    const out = rowToFlow(unshield({ id: 'namada:X:6', kind: 'ibc_out', to_addr: 'osmo1lspwv8uknff8cxcl8e0n43fp805jeqvuvy2f6x', meta: JSON.stringify({ innerTxHash: INNER, maspPostNam: POST, escrow: INTERNAL_ADDRESSES.ibc }) }));
    const d = desc(out, { poolMove: pm(), onDeck: { bridgedIn: 15_000_000, remaining: 15_000_000 } });
    expect(d).toContain('The shielded pool held');
    expect(d).not.toContain('On deck');
    const body = buildFlowDiscordBody(out, { poolMove: pm() });
    expect(body.embeds[0].description).toContain('this took 32.2% of it');
  });
});

describe('the context read of a move out of the pool (one batch, no retry)', () => {
  it('takes the pool\'s NAM before the move from the block\'s record plus the inner transaction\'s legs, all NAM from the minute before the block, and asks whether any move out on record was as large', async () => {
    const db = testD1();
    insert(db, 'flows', [unshield(), feeRow]);
    insert(db, 'metrics', [{ ts: T - 30_000, key: 'supply.total', value: 1_148_774_450 }, { ts: T + 30_000, key: 'supply.total', value: 999 }]);
    const { ctx } = await readMoveContext(db as any, rowToFlow(unshield()), T + 60_000);
    const p = ctx.poolMove!;
    expect(p).toBeTruthy();
    // 31,564,969.658039 after + 15,000,000 + the fee leg of the same inner transaction (the sibling row)
    expect(p.beforeNam).toBeCloseTo(46_564_969.792976, 5);
    expect(p.about).toBe(false);
    expect(p.beforeAt).toBe(T);
    expect(p.sharePct).toBeCloseTo((15_000_000 / 46_564_969.792976) * 100, 9);
    expect(p.allNam).toBe(1_148_774_450);
    expect(p.allAt).toBe(T - 30_000); // the reading before the block, never one after it
    expect(p.allSharePct).toBeCloseTo((15_000_000 / 1_148_774_450) * 100, 9);
    expect(p.largest).toBe(true);
  });
  it('the same move with the fee folded into its own meta and no sibling row gives the same balance before', async () => {
    const db = testD1();
    insert(db, 'flows', [unshieldWithFee()]);
    const { ctx } = await readMoveContext(db as any, rowToFlow(unshieldWithFee()), T + 60_000);
    expect(ctx.poolMove?.beforeNam).toBeCloseTo(46_564_969.792976, 5);
    // the row's fee is read from the stored row (a public Flow carries no maspFeeNam), so the live flow's own meta serves too
    const live = { ...rowToFlow(unshield()), meta: { innerTxHash: INNER, maspPostNam: POST, maspFeeNam: 0.134937 } };
    const empty = testD1();
    expect((await readMoveContext(empty as any, live, T + 60_000)).ctx.poolMove?.beforeNam).toBeCloseTo(46_564_969.792976, 5);
  });
  it('a move out as large or larger on record since the record starts makes it not the largest; a fee row and a move before the record do not count', async () => {
    const db = testD1();
    insert(db, 'flows', [
      unshield(),
      { id: 'namada:OLD:1', chain: 'namada', height: 100, ts: T - 400 * 24 * H, tx_hash: 'OLD', kind: 'unshield', from_addr: MASP, to_addr: 'tnam1qother', amount_num: 15_000_000, meta: JSON.stringify({ innerTxHash: 'O' }) },
    ]);
    expect((await readMoveContext(db as any, rowToFlow(unshield()), T + 60_000)).ctx.poolMove?.largest).toBe(false);
    const db2 = testD1();
    insert(db2, 'flows', [
      unshield(),
      // before 13 Jun 2025: not on this site's record of the pool
      { id: 'namada:OLDER:1', chain: 'namada', height: 10, ts: RECORD_SINCE.shieldedMoves - H, tx_hash: 'OLDER', kind: 'unshield', from_addr: MASP, to_addr: 'tnam1qother', amount_num: 20_000_000, meta: JSON.stringify({ innerTxHash: 'P' }) },
      // a fee row is no move out to anyone
      { id: 'namada:FEE:1', chain: 'namada', height: 200, ts: T - H, tx_hash: 'FEE', kind: 'masp_fee', from_addr: MASP, to_addr: GAS, amount_num: 20_000_000, meta: JSON.stringify({ innerTxHash: 'F' }) },
    ]);
    expect((await readMoveContext(db2 as any, rowToFlow(unshield()), T + 60_000)).ctx.poolMove?.largest).toBe(true);
  });
  it('under 10,000 NAM the largest question is not asked (one statement fewer) and the answer is null', async () => {
    const db = testD1();
    insert(db, 'flows', [unshield({ amount_num: 9_999 })]);
    const before = db.queries;
    const { ctx } = await readMoveContext(db as any, rowToFlow(unshield({ amount_num: 9_999 })), T + 60_000);
    const small = db.queries - before;
    expect(ctx.poolMove?.largest).toBeNull();
    expect(ctx.poolMove?.sharePct).toBeCloseTo((9_999 / (31_564_969.658039 + 9_999)) * 100, 9);
    const db2 = testD1();
    insert(db2, 'flows', [unshield()]);
    const b2 = db2.queries;
    await readMoveContext(db2 as any, rowToFlow(unshield()), T + 60_000);
    expect(db2.queries - b2).toBe(small + 1);
    expect(POOL_MOVE_LARGEST_MIN_NAM).toBe(10_000);
  });
  it('without the block\'s record the pool\'s balance is the minute reading just before the block, said as about; with no reading before it there is no line', async () => {
    const db = testD1();
    const row = unshield({ meta: JSON.stringify({ innerTxHash: INNER }) });
    insert(db, 'flows', [row]);
    insert(db, 'metrics', [{ ts: T - 45_000, key: 'supply.masp_shielded', value: 46_500_000 }, { ts: T + 15_000, key: 'supply.masp_shielded', value: 31_500_000 }]);
    const { ctx } = await readMoveContext(db as any, rowToFlow(row), T + 60_000);
    expect(ctx.poolMove).toMatchObject({ beforeNam: 46_500_000, about: true, beforeAt: T - 45_000, allNam: null, allSharePct: null });
    expect(ctx.poolMove!.sharePct).toBeCloseTo((15_000_000 / 46_500_000) * 100, 9);
    const db2 = testD1();
    insert(db2, 'flows', [row]);
    expect((await readMoveContext(db2 as any, rowToFlow(row), T + 60_000)).ctx.poolMove).toBeUndefined();
  });
  it('a move into the pool, a move of another coin, and an Osmosis record get no pool line', async () => {
    const db = testD1();
    const shield = rowToFlow({ ...unshield(), id: 'namada:S:1', kind: 'shield', from_addr: RCPT, to_addr: MASP });
    expect((await readMoveContext(db as any, shield, T)).ctx.poolMove).toBeUndefined();
    const other = rowToFlow(unshield({ meta: JSON.stringify({ innerTxHash: INNER, maspPostNam: POST, tokenSymbol: 'OSMO' }) }));
    expect((await readMoveContext(db as any, other, T)).ctx.poolMove).toBeUndefined();
    const osmo = rowToFlow({ ...unshield(), chain: 'osmosis', kind: 'ibc_in' });
    expect((await readMoveContext(db as any, osmo, T)).ctx.poolMove).toBeUndefined();
  });
});

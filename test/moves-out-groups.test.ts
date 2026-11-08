// /shielded "Largest moves out, last 30 days" (2026-11-07, C2): the moves-out read lists crossings straight out of the
// pool to the bridge account too (older records name no receiver), carries the recipient's label (the 2026-09-01
// crossings to the labelled Osmosis address show the 0019 label), groups the window's moves by recipient ranked by the
// group's total, and gives each listed move its share of the pool's NAM before it: from the block's own record when
// the row carries it, else from the minute reading just before the block, said as "about", else not at all.
import { describe, it, expect } from 'vitest';
import { blindSpot, groupMovesOut, poolBeforeOf, poolShareOf, poolShareFor, poolFeeOf, rowToFlow, MOVES_OUT_SHOWN, MOVES_OUT_READ_MAX, POOL_RECORD_SOURCE } from '../worker/src/analytics';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { SHIELDED_WORDS, ADDRESS_WORDS } from '../shared/copy';
import { BANNED } from '../scripts/copy-lint';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const MASP = INTERNAL_ADDRESSES.masp;
const ESCROW = INTERNAL_ADDRESSES.ibc;
const NOW = Date.UTC(2026, 10, 7, 12, 0);
const D = 86_400_000, H = 3_600_000;
const LABELLED = 'osmo1lspwv8uknff8cxcl8e0n43fp805jeqvuvy2f6x';
const A = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const B = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3';
const GAS = 'tnam1qq3t3lccqk4u69zjyaej63rrfpm4eha2v56llrku';

let n = 0;
const row = (over: Record<string, unknown>) => ({ id: `namada:R${++n}:1`, chain: 'namada', height: 8_500_000 + n, ts: NOW - n * H, tx_hash: `R${n}`, kind: 'unshield', from_addr: MASP, to_addr: A, amount_num: 1, meta: null, ...over });
const meta = (m: Record<string, unknown>) => JSON.stringify(m);

describe('the moves-out read', () => {
  it('lists crossings to the bridge account and to a named Osmosis receiver, with the recipient\'s label; a fee row, a move to a protocol account and a move of another coin are not moves out to anyone', async () => {
    const db = testD1();
    insert(db, 'flows', [
      row({ amount_num: 20_000, meta: meta({ innerTxHash: 'I1', maspPostNam: '31000000000000', maspFeeNam: 0.1 }) }),
      row({ kind: 'ibc_out', to_addr: ESCROW, amount_num: 10_000, meta: meta({ shielded: true }) }),
      row({ kind: 'ibc_out', to_addr: LABELLED, amount_num: 5_000_000, ts: NOW - 3 * D, meta: meta({ innerTxHash: 'I3', escrow: ESCROW }) }),
      row({ kind: 'ibc_out', to_addr: LABELLED, amount_num: 2_000_000, ts: NOW - 5 * D, meta: meta({ innerTxHash: 'I4', escrow: ESCROW }) }),
      row({ kind: 'masp_fee', to_addr: GAS, amount_num: 50_000_000, meta: meta({ innerTxHash: 'I5' }) }),
      row({ kind: 'unshield', to_addr: INTERNAL_ADDRESSES.pos, amount_num: 60_000_000 }),
      row({ kind: 'unshield', to_addr: B, amount_num: 70_000_000, meta: meta({ tokenSymbol: 'OSMO' }) }),
      row({ kind: 'unshield', to_addr: B, amount_num: 300, ts: NOW - 40 * D }), // outside the window
    ]);
    const bs = await blindSpot(db as any, NOW, false);
    expect(bs.unshields.map((f) => [f.kind, f.to, f.amount])).toEqual([
      ['ibc_out', LABELLED, 5_000_000], ['ibc_out', LABELLED, 2_000_000], ['unshield', A, 20_000], ['ibc_out', ESCROW, 10_000],
    ]);
    // the 0019 label comes with the row (the labels table of the migrations), as any recipient's label does
    expect(bs.unshields[0].toLabel).toBe('Staking account exploit, 2026-08-31 (Osmosis)');
    expect(bs.unshields[0].toLabelSource).toBe('curated');
    expect(bs.unshields[3].toLabel).toBe('Namada IBC escrow');
    expect(bs.outRead).toBe(4);
    // the groups: the labelled receiver's two crossings first, by their total
    expect(bs.outGroups!.map((g) => [g.to, g.n, g.nam, g.since, g.largestNam])).toEqual([
      [LABELLED, 2, 7_000_000, NOW - 5 * D, 5_000_000], [A, 1, 20_000, bs.unshields[2].ts, 20_000], [ESCROW, 1, 10_000, bs.unshields[3].ts, 10_000],
    ]);
    expect(bs.outGroups![0]).toMatchObject({ toLabel: 'Staking account exploit, 2026-08-31 (Osmosis)', toLabelSource: 'curated', largestId: bs.unshields[0].id, largestKind: 'ibc_out', last: NOW - 3 * D });
    // the share from the block's own record: the pool held 31,000,000 + 20,000 + the 0.1 fee before the unshield
    const s = bs.outShares![bs.unshields[2].id];
    expect(s.about).toBe(false);
    expect(s.beforeNam).toBeCloseTo(31_020_000.1, 6);
    expect(s.sharePct).toBeCloseTo((20_000 / 31_020_000.1) * 100, 9);
    expect(s.prov).toMatchObject({ source: POOL_RECORD_SOURCE, at: bs.unshields[2].ts, height: bs.unshields[2].height, status: 'live' });
    // the rows without the record and without a minute reading before them have no share, never a stand-in
    expect(Object.keys(bs.outShares!)).toEqual([bs.unshields[2].id]);
  });
  it('a row without the block\'s record takes the minute reading just before its block, said as about; a reading after the block is not used', async () => {
    const db = testD1();
    const r1 = row({ amount_num: 3_000_000, ts: NOW - 2 * H, meta: meta({ innerTxHash: 'J1' }) });
    const r2 = row({ amount_num: 1_000, ts: NOW - 20 * D });
    insert(db, 'flows', [r1, r2]);
    insert(db, 'metrics', [
      { ts: NOW - 2 * H - 40_000, key: 'supply.masp_shielded', value: 30_000_000 },
      { ts: NOW - 2 * H + 20_000, key: 'supply.masp_shielded', value: 27_000_000 },
    ]);
    const bs = await blindSpot(db as any, NOW, false);
    const s = bs.outShares![r1.id];
    expect(s).toMatchObject({ about: true, beforeNam: 30_000_000 });
    expect(s.sharePct).toBeCloseTo(10, 9);
    expect(s.prov.source).toBe('Namada RPC (MASP balance)');
    expect(s.prov.at).toBe(NOW - 2 * H - 40_000);
    expect(s.prov.note).toContain('About');
    // r2 is older than every reading: no share
    expect(bs.outShares![r2.id]).toBeUndefined();
  });
  it('the list stays the largest 25 while the groups count every move read, up to the read cap', async () => {
    const db = testD1();
    insert(db, 'flows', Array.from({ length: 30 }, (_, i) => row({ to_addr: i % 2 ? A : B, amount_num: 100 + i, ts: NOW - (i + 1) * H })));
    const bs = await blindSpot(db as any, NOW, false);
    expect(bs.unshields).toHaveLength(MOVES_OUT_SHOWN);
    expect(bs.unshields[0].amount).toBe(129);
    expect(bs.outRead).toBe(30);
    expect(bs.outGroups!.map((g) => g.n)).toEqual([15, 15]);
    expect(MOVES_OUT_READ_MAX).toBe(1000);
  });
  it('no sentence or field names an address beyond the recipients the list shows: the groups sent are the listed recipients\', counted over every row read', async () => {
    const db = testD1();
    // 29 recipients with a move each, largest first, and the labelled Osmosis receiver's crossing above them all: 30 of
    // the 31 rows have distinct recipients, and the smallest row goes to the largest unshield's recipient too
    const C = 'acdefghjklmnpqrstuvwxyz';
    const to = (i: number) => `tnam1q${C[Math.floor(i / C.length)]}${C[i % C.length]}${'q'.repeat(36)}`;
    insert(db, 'flows', [
      row({ kind: 'ibc_out', to_addr: LABELLED, amount_num: 2_000, ts: NOW - H }),
      ...Array.from({ length: 29 }, (_, i) => row({ to_addr: to(i), amount_num: 1_000 - i, ts: NOW - (i + 2) * H, meta: i === 0 ? meta({ innerTxHash: 'K', maspPostNam: '31000000000000' }) : null })),
      row({ to_addr: to(0), amount_num: 1, ts: NOW - 40 * H }),
    ]);
    const bs = await blindSpot(db as any, NOW, false);
    expect(bs.unshields).toHaveLength(MOVES_OUT_SHOWN);
    expect(bs.outRead).toBe(31);
    const shown = new Set(bs.unshields.map((f) => f.to));
    expect(shown.size).toBe(MOVES_OUT_SHOWN);
    // every group is a listed recipient's; the five recipients below the list and the unlisted smallest row have no group of their own
    expect(bs.outGroups!.length).toBe(MOVES_OUT_SHOWN);
    for (const g of bs.outGroups!) expect(shown.has(g.to), g.to).toBe(true);
    expect(bs.outGroups!.some((g) => g.to === to(24))).toBe(false);
    // the listed recipient's group still counts the row the list does not show
    expect(bs.outGroups!.find((g) => g.to === to(0))).toMatchObject({ n: 2, nam: 1_001, largestNam: 1_000 });
    expect(bs.outGroups![0]).toMatchObject({ to: LABELLED, n: 1, nam: 2_000 });
    const named = JSON.stringify({ groups: bs.outGroups, shares: bs.outShares, makeup: bs.makeup }).match(/(tnam1|osmo1)[02-9ac-hj-np-z]{8,}/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const a of named) expect(shown.has(a), a).toBe(true);
    const words = [
      SHIELDED_WORDS.makeup('13 Jun 2025', '1', '2', '3', '4', '5'), SHIELDED_WORDS.bridgeShare('10%', '3 crossings'), SHIELDED_WORDS.group('2 moves', '7,000,000', '2 Nov 2026'),
      SHIELDED_WORDS.poolShare('12.3%', true), SHIELDED_WORDS.largestShare('12.3%', false), SHIELDED_WORDS.outLead, SHIELDED_WORDS.shareHead, SHIELDED_WORDS.movesHead,
      ADDRESS_WORDS.firstSeen('3 Nov 2026', '20 Oct 2026'), ADDRESS_WORDS.fromPool('1', '2', '3 moves'), ADDRESS_WORDS.whyLabel,
    ];
    for (const w of words) {
      expect(w).not.toMatch(/tnam1|osmo1/);
      for (const b of BANNED) expect(w, `${b.word} in "${w}"`).not.toMatch(b.re);
    }
  });
});

describe('the grouping and the share maths', () => {
  const flow = (over: Partial<Flow>): Flow => rowToFlow(row({ amount_num: 1 })) && ({ ...rowToFlow(row({ amount_num: 1 })), ...over });
  it('groupMovesOut: by recipient, the largest total first, a tie by the largest move, each group with its first, last and largest move', () => {
    const g = groupMovesOut([
      flow({ id: 'a', to: A, amount: 5, ts: 100 }), flow({ id: 'b', to: B, amount: 8, ts: 200, kind: 'ibc_out' }),
      flow({ id: 'c', to: A, amount: 3, ts: 50 }), flow({ id: 'd', to: ESCROW, amount: 8, ts: 300 }), flow({ id: 'e', to: null, amount: 100, ts: 1 }),
    ]);
    // three groups of 8 NAM: the two whose one move is 8 before the two moves of 5 and 3, the earlier of those two first
    expect(g.map((x) => [x.to, x.n, x.nam, x.since, x.last, x.largestId, x.largestKind])).toEqual([
      [B, 1, 8, 200, 200, 'b', 'ibc_out'], [ESCROW, 1, 8, 300, 300, 'd', 'unshield'], [A, 2, 8, 50, 100, 'a', 'unshield'],
    ]);
    expect(groupMovesOut([flow({ id: 'a', to: A, amount: 5, ts: 100 }), flow({ id: 'b', to: B, amount: 9, ts: 200 })]).map((x) => x.to)).toEqual([B, A]);
  });
  it('poolBeforeOf: the balance after the inner transaction plus its legs out less its legs in; nothing without the record', () => {
    expect(poolBeforeOf({ maspPostNam: '31593419065539' }, 0.175)).toBeCloseTo(31_593_419.240539, 6);
    expect(poolBeforeOf({ maspPostNam: '1000000' }, 5, 2)).toBeCloseTo(4, 9);
    expect(poolBeforeOf({ maspPostNam: 31593419065539 as unknown as string }, 1)).toBeNull();
    expect(poolBeforeOf({ maspPostNam: 'abc' }, 1)).toBeNull();
    expect(poolBeforeOf(null, 1)).toBeNull();
    expect(poolBeforeOf({}, 1)).toBeNull();
  });
  it('poolShareOf and poolFeeOf', () => {
    expect(poolShareOf(15_000_000, 46_564_969.792976)).toBeCloseTo(32.213, 3);
    expect(poolShareOf(1, 0)).toBeNull();
    expect(poolShareOf(1, null)).toBeNull();
    expect(poolFeeOf({ maspFeeNam: 0.134937 })).toBe(0.134937);
    expect(poolFeeOf({ maspFeeNam: 'x' })).toBe(0);
    expect(poolFeeOf(null)).toBe(0);
  });
  it('poolShareFor prefers the block\'s record, then a reading at or before the move, else nothing', () => {
    const f = flow({ id: 'x', amount: 10, ts: 1_000, height: 7, meta: { maspPostNam: '90000000' } });
    expect(poolShareFor(f, { ts: 900, value: 1 })).toMatchObject({ beforeNam: 100, sharePct: 10, about: false, prov: { height: 7, at: 1_000 } });
    const g = flow({ id: 'y', amount: 10, ts: 1_000, meta: null });
    expect(poolShareFor(g, { ts: 900, value: 40 })).toMatchObject({ beforeNam: 40, sharePct: 25, about: true });
    expect(poolShareFor(g, { ts: 1_001, value: 40 })).toBeNull();
    expect(poolShareFor(g, { ts: 900, value: 0 })).toBeNull();
    expect(poolShareFor(g, null)).toBeNull();
  });
});

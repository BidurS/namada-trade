// The address sheet's three lines of 2026-11-07 (C3): "First seen <date> by this site, which has listed every Namada
// balance since 20 Oct 2026" when holders.first_seen is set (the address answer serves it; NULL stays unsaid); "<N> of <M>
// NAM received came out of the shielded pool (<k> moves)" from the address's own moves; and a curated or genesis label's
// note (the answer keeps serving it) while a wallet's own tag's note is never served.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { app } from '../worker/src/api';
import { fromPoolOf } from '../web/src/screens/sheets/moves';
import { ADDRESS_WORDS } from '../shared/copy';
import { RECORD_SINCE } from '../shared/record-since';
import { fmtDayMonthYear } from '../shared/format';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { stmt } from '../worker/src/db';
import { testD1, insert, runStmts } from './d1-sqlite';
import type { AddressReport, Flow } from '../shared/types';

const MASP = INTERNAL_ADDRESSES.masp;
const ADDR = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd';
const OTHER = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3';
const OSMO = 'osmo1testsellerqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const FIRST = Date.UTC(2026, 10, 3, 9, 30);

// the address answer's live chain reads fail at once, so the stored readings answer (the sheet's lines need no chain)
beforeAll(() => vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test'))));
afterAll(() => vi.unstubAllGlobals());

const report = async (db: ReturnType<typeof testD1>, addr = ADDR): Promise<AddressReport> => {
  const res = await app.request(`/api/address/${addr}`, {}, { DB: db } as any);
  expect(res.status).toBe(200);
  return res.json();
};

describe('the address answer', () => {
  it('serves first_seen when the holder row carries it, and null when it does not or there is no row', async () => {
    const db = testD1();
    insert(db, 'holders', [
      { chain: 'namada', address: ADDR, balance: '5000000', balance_num: 5, updated_at: FIRST, updated_height: 8_500_000, first_seen: FIRST },
      { chain: 'namada', address: OTHER, balance: '5000000', balance_num: 5, updated_at: FIRST, updated_height: 8_500_000, first_seen: null },
    ]);
    expect((await report(db)).firstSeen).toBe(FIRST);
    expect((await report(db, OTHER)).firstSeen).toBeNull();
    expect((await report(db, OSMO)).firstSeen).toBeNull();
  });
  it('serves a curated label\'s note and a genesis label\'s, never a wallet\'s tag\'s note', async () => {
    const db = testD1();
    insert(db, 'labels', [
      { address: ADDR, chain: 'namada', label: 'Named for a reason', category: 'other', source: 'curated', note: 'Why it is named so, in public words.', updated_at: FIRST },
      { address: OTHER, chain: 'namada', label: 'Genesis: af_backers', category: 'backer', source: 'genesis', note: 'From the genesis allocation file.', updated_at: FIRST },
    ]);
    const author = `tnam1q${'z'.repeat(39)}`;
    await runStmts(db, [stmt.userTag(OSMO, 'osmosis', 'Someone I watch', 'watch', author, 'my private reason', FIRST)]);
    expect(db.raw.prepare('SELECT note FROM labels WHERE address = ?').get(OSMO).note).toBe('my private reason');
    expect((await report(db)).label).toMatchObject({ label: 'Named for a reason', source: 'curated', note: 'Why it is named so, in public words.' });
    expect((await report(db, OTHER)).label).toMatchObject({ source: 'genesis', note: 'From the genesis allocation file.' });
    const tagged = await report(db, OSMO);
    expect(tagged.label).toMatchObject({ label: 'Someone I watch', source: 'user', label_source: 'user', note: null });
    expect(JSON.stringify(tagged)).not.toContain('my private reason');
  });
});

describe('the sheet\'s words', () => {
  it('the first-seen line names the listing date and the day this site began listing every balance', () => {
    expect(RECORD_SINCE.everyBalance).toBe(Date.UTC(2026, 9, 20));
    expect(ADDRESS_WORDS.firstSeen(fmtDayMonthYear(FIRST), fmtDayMonthYear(RECORD_SINCE.everyBalance)))
      .toBe('First seen 3 Nov 2026 by this site, which has listed every Namada balance since 20 Oct 2026.');
  });
  it('the pool line, whole and counted over a cut list', () => {
    expect(ADDRESS_WORDS.fromPool('15,000,000', '15,020,000', '2 moves')).toBe('15,000,000 of 15,020,000 NAM received came out of the shielded pool (2 moves).');
    expect(ADDRESS_WORDS.fromPool('5', '5', '1 move', 'the newest 300 moves listed below')).toBe('5 of 5 NAM received came out of the shielded pool (1 move), counted over the newest 300 moves listed below.');
    expect(ADDRESS_WORDS.whyLabel).toBe('Why this label');
  });
});

describe('fromPoolOf: what the address received and the part that came out of the pool', () => {
  const f = (over: Partial<Flow>): Flow => ({ id: 'x', chain: 'namada', height: 1, ts: 1, txHash: 'X', kind: 'transfer', from: OTHER, to: ADDR, amount: 1, ...over });
  it('counts every leg from the pool to the address (an unshield, a crossing out of the pool, the pool\'s fee), NAM only, each crossing once, and nothing the address sent', () => {
    const r = fromPoolOf([
      f({ id: 'a', kind: 'unshield', from: MASP, amount: 15_000_000 }),
      f({ id: 'b', kind: 'masp_fee', from: MASP, amount: 0.134937 }),
      f({ id: 'c', kind: 'transfer', from: OTHER, amount: 20_000 }),
      f({ id: 'd', kind: 'unshield', from: MASP, amount: 290, meta: { tokenSymbol: 'OSMO' } }), // another coin: not NAM
      f({ id: 'e', kind: 'unshield', from: MASP, to: OTHER, amount: 999 }), // not to this address
      f({ id: 'g', kind: 'shield', from: ADDR, to: MASP, amount: 500 }), // sent, not received
      // one crossing to this address recorded on both chains: counted once
      f({ id: 'h', chain: 'osmosis', kind: 'ibc_out', from: OSMO, to: ADDR, amount: 1_000, ts: 10 }),
      f({ id: 'i', chain: 'namada', kind: 'ibc_in', from: OSMO, to: ADDR, amount: 1_000, ts: 10 + 60_000 }),
    ], ADDR);
    expect(r.moves).toBe(2);
    expect(r.fromPoolNam).toBeCloseTo(15_000_000.134937, 6);
    expect(r.receivedNam).toBeCloseTo(15_000_000.134937 + 20_000 + 1_000, 6);
  });
  it('an address that received nothing from the pool has no such moves (the sheet shows no line)', () => {
    expect(fromPoolOf([f({ id: 'c', amount: 20_000 })], ADDR)).toEqual({ receivedNam: 20_000, fromPoolNam: 0, moves: 0 });
    expect(fromPoolOf([], ADDR)).toEqual({ receivedNam: 0, fromPoolNam: 0, moves: 0 });
  });
});

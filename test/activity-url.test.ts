import { describe, it, expect } from 'vitest';
// The Activity URL state (web/src/screens/activity/urlState.ts): reading, cleaning, writing, the grammar's lift into
// parameters, the chips and what each list sends the server. Pure functions; `location` is stubbed for hrefWith.
import {
  HOLDER_DEFAULT, MOVE_DEFAULT, holderPatch, holdersApplied, hrefWith, liftHolders, liftMoves, listPath, movePatch, movesApplied,
  positionsOf, readHolderUrl, readMoveUrl, readText, rememberList,
} from '../web/src/screens/activity/urlState';
import { encodeFlowCursor } from '../shared/paging';

const NOW = Date.UTC(2026, 9, 20, 14, 32, 10);
const DAY = 86_400_000;
const q = (s: string) => new URLSearchParams(s);
(globalThis as unknown as { location: { href: string; origin: string } }).location = { href: 'http://x.test/activity?at=1788116700000&addr=tnam1abc&page=2', origin: 'http://x.test' };

describe('reading the URL', () => {
  it('holders: defaults, values, and a fix for every unreadable or default value', () => {
    expect(readHolderUrl(q(''))).toEqual({ url: HOLDER_DEFAULT, fix: {} });
    const r = readHolderUrl(q('chain=osmosis&by=staked&what=Genesis&q=%20a%20%20b%20&min=1000000&max=x&page=3&size=100'));
    expect(r.url).toEqual({ chain: 'osmosis', by: 'staked', what: 'genesis', q: 'a b', min: 1_000_000, max: null, page: 3, size: 100 });
    expect(r.fix).toEqual({ what: 'genesis', q: 'a b', max: null });
    expect(readHolderUrl(q('chain=namada&by=total&page=1&size=50')).fix).toEqual({ chain: null, by: null, page: null, size: null });
    expect(readHolderUrl(q('what=a%20b&min=-5&page=0&size=7')).fix).toEqual({ what: null, min: null, page: null, size: null });
  });
  it('moves: kinds, sizes, switches, times; a position needs a page after the first; a position in ?before= moves to ?cursor=', () => {
    expect(readMoveUrl(q(''), NOW)).toEqual({ url: MOVE_DEFAULT, fix: {} });
    const c = encodeFlowCursor({ ts: NOW - DAY, height: 8_000_000, id: 'namada:AB:1' });
    const r = readMoveUrl(q(`what=sell&min=100000&bots=off&crossings=both&since=2026-10-13&before=${Date.UTC(2026, 9, 1)}&cursor=${c}&page=3`), NOW);
    expect(r.url).toMatchObject({ what: 'sell', min: 100_000, noBots: true, both: true, since: Date.UTC(2026, 9, 13), before: Date.UTC(2026, 9, 1), cursor: c, page: 3 });
    expect(r.fix).toEqual({});
    expect(readMoveUrl(q(`cursor=${c}`), NOW).fix).toEqual({ cursor: null });
    expect(readMoveUrl(q(`before=${c}&page=2`), NOW)).toMatchObject({ url: { cursor: c, before: null }, fix: { before: null, cursor: c } });
    expect(readMoveUrl(q('what=nonsense&bots=on&since=2999-01-01&before=12&cursor=zzz'), NOW).fix).toEqual({ what: null, bots: null, since: null, before: null, cursor: null });
    // since as unix ms stays ms unless it is a UTC midnight
    expect(readMoveUrl(q(`since=${NOW - DAY}`), NOW).fix).toEqual({});
    expect(readMoveUrl(q(`since=${Date.UTC(2026, 9, 13)}`), NOW).fix).toEqual({ since: '2026-10-13' });
  });
});

describe('writing the URL', () => {
  it('in place: a parameter keeps its position, ?at= and ?addr= stay, a default is removed', () => {
    expect(hrefWith(movePatch({ what: 'sell', page: 1 }))).toBe('/activity?at=1788116700000&addr=tnam1abc&what=sell');
    expect(hrefWith(movePatch({ page: 3, cursor: 'abc' }))).toBe('/activity?at=1788116700000&addr=tnam1abc&page=3&cursor=abc');
    expect(holderPatch({ chain: 'namada', by: 'staked', what: null, q: '  x  ', min: 2.5, size: 50 })).toEqual({ chain: null, by: 'staked', what: null, q: 'x', min: '2.5', size: null });
    expect(movePatch({ since: Date.UTC(2026, 9, 13), before: Date.UTC(2026, 9, 1), noBots: true, both: false })).toEqual({ since: '2026-10-13', before: String(Date.UTC(2026, 9, 1)), bots: 'off', crossings: null });
  });
  it('round trip: what a patch writes reads back as the same state', () => {
    const url = { ...MOVE_DEFAULT, chain: 'osmosis' as const, what: 'ibc' as const, min: 10_000, noBots: true, q: 'tnam1qxyzqxyzq', since: NOW - DAY, before: Date.UTC(2026, 9, 1), page: 4, cursor: encodeFlowCursor({ ts: NOW, height: 1, id: 'x' }), size: 25 as const };
    const back = readMoveUrl(new URLSearchParams(hrefWith(movePatch(url), 'http://x.test/activity').split('?')[1]), NOW);
    expect(back).toEqual({ url, fix: {} });
  });
});

describe('the text, read with the grammar', () => {
  it('moves: "sell >100k last 7 days" applies at once and lifts into parameters; identifiers and free words stay', () => {
    const url = { ...MOVE_DEFAULT, q: 'sell >100k last 7 days tnam1qxyzqxyzq zondax' };
    const a = movesApplied(url, NOW);
    expect(a.eff).toMatchObject({ what: 'sell', min: 100_000, since: Date.UTC(2026, 9, 14) });
    expect(a.addr).toBe('tnam1qxyzqxyzq');
    expect(a.search).toBe('zondax');
    expect(a.chips.map((c) => c.label)).toEqual(['Sells only', 'At least 100,000 NAM', 'Last 7 days (since 14 Oct 2026)', 'Address starts with tnam1qxyzqxyzq…', 'Address or record contains “zondax”']);
    expect(a.count).toBe(5);
    expect(liftMoves(url, NOW)).toEqual({ q: 'tnam1qxyzqxyzq zondax', what: 'sell', chain: 'all', min: 100_000, since: Date.UTC(2026, 9, 14), before: null, noBots: false, both: false });
  });
  it('moves: the text wins over a parameter for the same field, and the parameter chip is not shown twice', () => {
    const a = movesApplied({ ...MOVE_DEFAULT, what: 'buy', q: 'sell' }, NOW);
    expect(a.eff.what).toBe('sell');
    expect(a.chips.map((c) => c.label)).toEqual(['Sells only']);
  });
  it('moves: a holders word is a chip that says it is left out, sets nothing and is not counted', () => {
    const a = movesApplied({ ...MOVE_DEFAULT, q: 'foundation' }, NOW);
    expect(a.chips).toEqual([expect.objectContaining({ label: 'Foundation only', applied: false, note: 'Not a filter on the moves list.' })]);
    expect(a.count).toBe(0);
    expect(a.search).toBe('');
    expect(liftMoves({ ...MOVE_DEFAULT, q: 'foundation' }, NOW).q).toBe('foundation');
  });
  it('moves: an address end is "contains" there (the moves search); a chip removed takes its words out of the text', () => {
    const url = { ...MOVE_DEFAULT, q: 'sell …kj4m' };
    const a = movesApplied(url, NOW);
    expect(a.search).toBe('kj4m');
    const chip = a.chips.find((c) => c.label === 'Sells only')!;
    expect(chip.remove).toEqual({ q: '…kj4m' });
    const free = movesApplied({ ...MOVE_DEFAULT, q: 'zondax sell nam' }, NOW).chips.find((c) => c.key === 'q:free')!;
    expect(free).toMatchObject({ label: 'Address or record contains “zondax”', remove: { q: 'sell' } });
  });
  it('holders: filter words become category, min and max; the server gets the address end and the free words only', () => {
    const url = { ...HOLDER_DEFAULT, by: 'staked' as const, q: 'genesis >1m …kj4m zond 7d' };
    const a = holdersApplied(url, NOW);
    expect(a.eff).toMatchObject({ what: 'genesis', min: 1_000_000 });
    expect(a.search).toBe('…kj4m zond');
    expect(a.chips.map((c) => [c.label, c.applied])).toEqual([['Genesis only', true], ['At least 1,000,000 NAM', true], ['Address ends with kj4m', true], [expect.stringMatching(/^Last 7 days/), false], ['Name or address contains “zond”', true]]);
    expect(liftHolders(url, NOW)).toEqual({ q: '…kj4m zond 7d', what: 'genesis', chain: 'namada', min: 1_000_000, max: null });
    // a size parameter on the staked order says so
    expect(holdersApplied({ ...HOLDER_DEFAULT, by: 'staked', min: 5 }, NOW).chips[0].label).toBe('At least 5 NAM staked');
  });
  it('readText never throws on odd input', () => {
    for (const s of ['', '"', '“unclosed', '>', '..', '100k..', 'tnam1', '…', '$', 'before', 'last', '0x12345678', 'a'.repeat(400)]) {
      expect(() => readText(s, 'moves', NOW)).not.toThrow();
      expect(() => readText(s, 'holders', NOW)).not.toThrow();
    }
  });
});

describe('memory', () => {
  it('each tab remembers its last query without ?at= and ?addr=', () => {
    rememberList('/holders', '?by=staked&at=1&addr=tnam1x&page=2');
    expect(listPath('/holders')).toBe('/holders?by=staked&page=2');
    expect(listPath('/nowhere')).toBe('/nowhere');
  });
  it('positions: one record per query, the 24 most recent kept', () => {
    const p = positionsOf('k0');
    p.cursors.set(2, 'c');
    expect(positionsOf('k0').cursors.get(2)).toBe('c');
    for (let i = 1; i <= 30; i++) positionsOf(`k${i}`);
    expect(positionsOf('k0').cursors.size).toBe(0);
  });
});

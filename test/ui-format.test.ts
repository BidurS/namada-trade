// Number rules from docs/design/system.md 5.3 (web/src/lib/format.ts) and the provenance
// vocabulary (web/src/lib/prov.ts). Pure functions only.
import { describe, it, expect } from 'vitest';
import {
  MINUS, fmtUsdRule, fmtUsdWhole, splitPrice, fmtNamRule, fmtNamSigned, fmtPctRule, fmtPctSigned, fmtCoin,
  fmtAge, ageOf, fmtAgo, fmtUtcLong, fmtUtcClock, fmtDateline, fmtDayMonth, fmtAddr, roundToTotal,
  explorerTx, explorerAddr,
} from '../web/src/lib/format';
import { uiStatus, STATUS_WORD, plainSource, stampText, ageRange, scopeRowText, CHECK_TITLES, checkUi, worstStatus } from '../web/src/lib/prov';

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

describe('dollars (system.md 5.3)', () => {
  it('under $1: six decimals, never "$0"', () => {
    expect(fmtUsdRule(0.001025)).toBe('$0.001025');
    expect(fmtUsdRule(0.0010254146)).toBe('$0.001025');
    expect(fmtUsdRule(0.5)).toBe('$0.500000');
    expect(fmtUsdRule(0.0000001)).not.toBe('$0');
    expect(fmtUsdRule(0.0000001)).not.toMatch(/^\$0(\.0+)?$/);
  });
  it('$1 to $999.99: two decimals', () => {
    expect(fmtUsdRule(5.127)).toBe('$5.13');
    expect(fmtUsdRule(24.5)).toBe('$24.50');
    expect(fmtUsdRule(999.99)).toBe('$999.99');
    expect(fmtUsdRule(0.9999999)).toBe('$1.00');
  });
  it('$1,000 and over: no decimals', () => {
    expect(fmtUsdRule(1819.4)).toBe('$1,819');
    expect(fmtUsdRule(999.996)).toBe('$1,000');
  });
  it('negative dollars use the true minus; missing is a dash', () => {
    expect(fmtUsdRule(-12.3)).toBe(`${MINUS}$12.30`);
    expect(fmtUsdRule(null)).toBe('—');
    expect(fmtUsdRule(Number.NaN)).toBe('—');
  });
  it('whole dollars for depths', () => {
    expect(fmtUsdWhole(831.4)).toBe('$831');
    expect(fmtUsdWhole(1819)).toBe('$1,819');
    expect(fmtUsdWhole(0.4)).toBe('$0.400000');
  });
  it('splits the leading zeros of a sub-dollar price so they can be dimmed', () => {
    expect(splitPrice(0.001025)).toEqual({ lead: '$0.00', sig: '1025' });
    expect(splitPrice(0.5)).toEqual({ lead: '$0.', sig: '500000' });
    expect(splitPrice(1.5)).toEqual({ lead: '', sig: '$1.50' });
    expect(splitPrice(null)).toEqual({ lead: '', sig: '—' });
  });
});

describe('NAM, coins and percentages', () => {
  it('NAM: integers from 1,000 up, two decimals under 10', () => {
    expect(fmtNamRule(17124.4)).toBe('17,124');
    expect(fmtNamRule(341947228.49)).toBe('341,947,228');
    expect(fmtNamRule(4.256)).toBe('4.26');
    expect(fmtNamRule(318)).toBe('318');
    expect(fmtNamRule(13.75)).toBe('13.8');
    expect(fmtNamRule(0)).toBe('0');
  });
  it('signed NAM with the true minus', () => {
    expect(fmtNamSigned(17124)).toBe('+17,124');
    expect(fmtNamSigned(-10968)).toBe(`${MINUS}10,968`);
    expect(fmtNamSigned(0)).toBe('0');
  });
  it('USDC: two decimals', () => {
    expect(fmtCoin(5.045588)).toBe('5.05');
    expect(fmtCoin(102.541464)).toBe('102.54');
  });
  it('price move and share of supply: two decimals; hero share one', () => {
    expect(fmtPctRule(4.8)).toBe('4.80%');
    expect(fmtPctRule(4.4187, 1)).toBe('4.4%');
  });
  it('a sign on every delta, true minus, two decimals', () => {
    expect(fmtPctSigned(0.87)).toBe('+0.87%');
    expect(fmtPctSigned(-1.4908)).toBe(`${MINUS}1.49%`);
    expect(fmtPctSigned(0)).toBe('0.00%');
    expect(fmtPctSigned(-0.001)).toBe('0.00%'); // rounds to zero: no sign, no "−0.00%"
    expect(fmtPctSigned(null)).toBe('—');
  });
  it('rounds shares so they sum to exactly 100', () => {
    const raw = [29.8004, 7.7824, 4.4187, 56.2565, 1.742];
    const r = roundToTotal(raw, 1);
    expect(r).toEqual([29.8, 7.8, 4.4, 56.3, 1.7]);
    expect(Math.round(r.reduce((a, b) => a + b, 0) * 10)).toBe(1000);
    const thirds = roundToTotal([100 / 3, 100 / 3, 100 / 3], 1);
    expect(Math.round(thirds.reduce((a, b) => a + b, 0) * 10)).toBe(1000);
  });
});

describe('ages (system.md 5.3)', () => {
  it('now under 5 s, seconds, minutes, hours with one decimal, days', () => {
    expect(fmtAge(0)).toBe('now');
    expect(fmtAge(4.9 * S)).toBe('now');
    expect(fmtAge(9 * S)).toBe('9\u00a0s');
    expect(fmtAge(32 * MIN)).toBe('32\u00a0min');
    expect(fmtAge(3.2 * H)).toBe('3.2\u00a0h');
    expect(fmtAge(12.7 * H)).toBe('12.7\u00a0h');
    expect(fmtAge(2.3 * D)).toBe('2.3\u00a0days');
    expect(fmtAge(16.4 * D)).toBe('16\u00a0days');
  });
  it('drops ".0" and treats future stamps as now', () => {
    expect(fmtAge(2 * H)).toBe('2\u00a0h');
    expect(fmtAge(-5 * MIN)).toBe('now');
    expect(fmtAge(null)).toBe('—');
  });
  it('ages against a clock, in running text', () => {
    const now = Date.UTC(2026, 9, 17, 11, 24);
    expect(ageOf(now - 10 * S, now)).toBe('10\u00a0s');
    expect(ageOf(null, now)).toBe('—');
    expect(fmtAgo(now - 2 * S, now)).toBe('just now');
    expect(fmtAgo(now - 16 * D, now)).toBe('16\u00a0days ago');
  });
  it('UTC dates and the dateline', () => {
    const t = Date.UTC(2026, 9, 17, 11, 24, 30);
    expect(fmtUtcLong(t)).toBe('17 Oct 2026, 11:24\u00a0UTC');
    expect(fmtUtcClock(t)).toBe('11:24\u00a0UTC');
    expect(fmtDayMonth(t)).toBe('17 Oct');
    expect(fmtDateline(t)).toBe('Sat 17 Oct 2026 · 11:24\u00a0UTC');
  });
  it('short addresses keep the first 10 and last 5 characters', () => {
    expect(fmtAddr('tnam1qqscx0000000000000000000000000000027zh')).toBe('tnam1qqscx…027zh');
    expect(fmtAddr(null)).toBe('—');
  });
});

describe('explorer links', () => {
  it('point at the chain explorers', () => {
    expect(explorerTx('osmosis', 'AB')).toContain('mintscan');
    expect(explorerTx('namada', 'ab')).toContain('/transactions/AB');
    expect(explorerAddr('osmo1x')).toContain('osmosis');
  });
});

describe('provenance words (lib/prov)', () => {
  const now = Date.UTC(2026, 9, 17, 11, 24);
  it('maps server statuses to the four UI states and words', () => {
    expect(uiStatus('live')).toBe('fresh');
    expect(uiStatus('stale')).toBe('old');
    expect(uiStatus('missing')).toBe('none');
    expect(uiStatus('conflict')).toBe('disagree');
    expect(STATUS_WORD.none).toBe('no data');
    expect(STATUS_WORD.disagree).toBe('sources disagree');
  });
  it('names sources in plain words and never invents one', () => {
    expect(plainSource({ source: 'Osmosis SQS' })).toBe('Osmosis quote');
    expect(plainSource({ source: 'Osmosis SQS router' })).toBe('Osmosis quote');
    expect(plainSource({ source: 'Namada RPC Papadritta' })).toBe('Namada node');
    expect(plainSource({ source: 'D1 flow index' })).toBe('Flow index');
    expect(plainSource({ source: 'Keplr Osmosis bank/supply' })).toBe('Osmosis supply');
    expect(plainSource({ source: 'Something new' })).toBe('Something new');
    expect(plainSource({ source: 'Osmosis SQS', plain: 'Size table' })).toBe('Size table');
  });
  it('stamp text: the dot always has a word', () => {
    expect(stampText({ source: 'Osmosis SQS', at: now - 2 * S, status: 'live' }, now)).toBe('Osmosis quote · now');
    expect(stampText({ source: 'D1 flow index', at: now - 3.2 * H, status: 'stale' }, now)).toBe('Flow index · old 3.2\u00a0h');
    expect(stampText({ source: 'Osmosis SQS', at: null, status: 'missing' }, now)).toBe('Osmosis quote · no data');
    expect(stampText({ source: 'Keplr Osmosis bank/supply', at: now - 10 * S, status: 'conflict' }, now)).toBe('Osmosis supply · disagree 10\u00a0s');
  });
  it('scope rows and age ranges', () => {
    const a = { source: 'indexer.namada.net', at: now - 9 * S, status: 'live' as const };
    const b = { source: 'Namada RPC abci_query', at: now - 10 * S, status: 'live' as const };
    expect(ageRange([a, b], now)).toBe('9\u00a0s to 10\u00a0s');
    expect(ageRange([{ ...a, at: now }], now)).toBe('just now');
    expect(scopeRowText(a, now)).toBe('Namada indexer · 11:23\u00a0UTC · 9\u00a0s · fresh');
  });
  it('plain check titles for every cross-check key; ok passes, warn and fail need a look', () => {
    for (const k of ['ibc_conservation', 'bonded_coverage', 'rpc_consensus', 'supply_integrity', 'indexer_lag', 'supply_cross_source', 'price_vs_execution']) {
      expect(CHECK_TITLES[k], k).toBeTruthy();
      expect(CHECK_TITLES[k]).not.toMatch(/\b(RPC|SQS|IBC|ABCI|PoS|MASP|DEX)\b/);
    }
    expect(checkUi('ok').word).toBe('Passes');
    expect(checkUi('warn').word).toBe('Needs a look');
    expect(checkUi('fail').word).toBe('Needs a look');
  });
  it('worst status order: no data > disagree > old > fresh', () => {
    expect(worstStatus(['live', 'stale'])).toBe('stale');
    expect(worstStatus(['stale', 'conflict'])).toBe('conflict');
    expect(worstStatus(['conflict', 'missing', 'live'])).toBe('missing');
    expect(worstStatus([])).toBe('live');
  });
});

// The last trade price's stamp (owner decision 48, 2026-11-10). The price is the record of an event, not a reading
// that ages: while the record of Osmosis trades is current, a price whose last trade was hours ago is current too
// and says how long ago that trade was. It reads "old" only when the record itself is behind (a newer trade may
// not be counted yet), which is a reading that is overdue.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAST_TRADE_BEHIND, LAST_TRADE_CURRENT, LAST_TRADE_SOURCE, LAST_TRADE_STALE_MS, lastTradeProv } from '../worker/src/analytics';
import { stampText } from '../web/src/lib/prov';
import type { Provenance } from '../shared/types';

const NOW = Date.UTC(2026, 10, 10, 12, 0);
const H = 3_600_000;
const record = (status: Provenance['status']): Provenance => ({ source: 'D1 flow index', at: NOW - 60_000, status });
const words = (s: string) => s.replace(/ /g, ' ');

describe('the stamp of the last trade price', () => {
  it('is current while the record of trades is, however long ago the last trade was, and carries that trade\'s time', () => {
    const p = lastTradeProv(NOW - 9 * H, NOW, record('live'));
    expect(p).toEqual({ source: LAST_TRADE_SOURCE, at: NOW - 9 * H, status: 'live', event: 'trade', note: LAST_TRADE_CURRENT });
    // even past the age that alone would have made it old
    expect(9 * H).toBeGreaterThan(LAST_TRADE_STALE_MS);
    expect(lastTradeProv(NOW - 30 * 24 * H, NOW, record('live')).status).toBe('live');
  });

  it('is old when the record of trades is behind, whatever the price\'s own age', () => {
    for (const status of ['stale', 'missing', 'conflict'] as const) {
      expect(lastTradeProv(NOW - 60_000, NOW, record(status)), status).toEqual({ source: LAST_TRADE_SOURCE, at: NOW - 60_000, status: 'stale', event: 'trade', note: LAST_TRADE_BEHIND });
    }
  });

  it('with no price on record there is none, and on a rewound page it is judged by its age alone, as before', () => {
    expect(lastTradeProv(null, NOW, record('live'))).toMatchObject({ source: LAST_TRADE_SOURCE, at: null, status: 'missing' });
    expect(lastTradeProv(NOW - H, NOW, null)).toEqual({ source: LAST_TRADE_SOURCE, at: NOW - H, status: 'live' });
    expect(lastTradeProv(NOW - LAST_TRADE_STALE_MS - 1, NOW, null)).toMatchObject({ status: 'stale' });
    expect(lastTradeProv(NOW - H, NOW, null)).not.toHaveProperty('event');
  });

  it('a series written only for hours with a trade is stamped the same way while its writer is current', () => {
    // the line under the Trade chart takes this stamp: its newest point is the last hour with a trade
    const src = readFileSync(new URL('../worker/src/series-api.ts', import.meta.url), 'utf8');
    expect(src).toContain("? { source: def.source, at: newest.at, status: 'live', event: 'trade', note: `Written only for hours with a trade; the newest one began ${fmtDayTime(newest.at)}.` }");
    // and a writer that has not run leaves it old, with no event mark
    expect(src).toMatch(/: \{ source: def\.source, at: newest\.at, status: 'stale', note: job != null \?/);
  });

  it('reads "last trade N ago" when current, and "old" only when the record is behind', () => {
    const current = lastTradeProv(NOW - 6.7 * H, NOW, record('live'));
    expect(words(stampText(current, NOW))).toMatch(/ · last trade 6\.7 h ago$/);
    expect(words(stampText(current, NOW))).not.toContain('old');
    const behind = lastTradeProv(NOW - 6.7 * H, NOW, record('stale'));
    expect(words(stampText(behind, NOW))).toMatch(/ · old 6\.7 h$/);
    // a reading that is not the record of an event is worded as it always was
    expect(words(stampText({ source: 'Osmosis SQS', at: NOW - 10_000, status: 'live' }, NOW))).toMatch(/ · 10 s$/);
  });
});

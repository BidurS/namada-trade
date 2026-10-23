// Security review (2026-10-22), the series of the Osmosis holder rows: the Osmosis holder figures are stamped no later
// than the start of the last pass of the bank's list that added up to the supply, but the series readers of the same
// rows (the hourly holders.osmosis count and the daily Osmosis size snapshot) still took the newest reading as the
// list's time. After hours of passes that did not add up, the overview said the figures were old while the snapshot of
// the day (which can never be rebuilt) and the hourly count were written as current, from the same untrusted readings.
// Now both take the figures' stamp (holders.ts osmosisStamp): a list no pass of which added up within 6 hours leaves
// the day a gap, as the Namada snapshot does without fresh listings, and the hourly count waits for a trusted pass.
import { describe, it, expect } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { daily, hourly } from '../worker/src/series';
import { holderFigureValues, listingTimes } from '../worker/src/holders';
import { holderFiguresProv } from '../worker/src/api';
import type { SourceHealth } from '../shared/types';

const H = 3600_000, MIN = 60_000;
const osmo = (i: number) => `osmo1${String(i).padStart(38, '0')}`;
// 06:05 UTC: inside the hour's job window
const NOW = Date.UTC(2026, 9, 21, 6, 5);
const READ = NOW - 4 * MIN; // the last pass read every holder again

/** 50 Osmosis holders read at READ, and a pass record whose last pass that added up started at `trusted`. */
function seeded(trusted: number) {
  const db = testD1();
  for (let i = 0; i < 50; i++) {
    insert(db, 'holders', [{ chain: 'osmosis', address: osmo(i), balance: '2000000', balance_num: 2, updated_at: READ, verified_at: READ, verified_src: 'keplr_rest' }]);
  }
  insert(db, 'kv', [{ key: 'osmosis.holders.pass', updated_at: READ, value: JSON.stringify({
    startedAt: READ - MIN, key: null, pages: 1, holders: 50, sumBase: '100000000', ticks: 2, fails: 0, spans: false, spansHour: null,
    completeAt: READ, trustedAt: trusted + MIN, trustedStartedAt: trusted, lastPassMs: MIN,
  }) }]);
  return db;
}
async function series(db: ReturnType<typeof testD1>) {
  const health: SourceHealth[] = [];
  const d = await daily({ DB: db } as any, NOW, { health, validators: async () => [] });
  await hourly({ DB: db } as any, NOW, { pools: [], poolsAt: null, health, listingTick: false, summary: async () => { throw new Error('x'); }, chart: async () => null });
  return {
    waiting: d?.waiting ?? [],
    snap: db.raw.prepare("SELECT bucket, holders, nam, as_of FROM holder_cohorts_daily WHERE chain='osmosis'").all().map((r: any) => ({ ...r })),
    count: db.raw.prepare("SELECT ts, value FROM metrics WHERE key='holders.osmosis'").all().map((r: any) => ({ ...r })),
  };
}

describe('the series of the Osmosis holder rows take the figures\' stamp', () => {
  it('after 7 hours of passes that did not add up: the figures read old, the day\'s snapshot waits (a gap) and the hourly count is not written', async () => {
    const db = seeded(NOW - 7 * H);
    const fig = await holderFigureValues(db as any, NOW, await listingTimes(db as any));
    expect(holderFiguresProv(fig.top10Osmosis?.at, fig.counts?.osmosis_at, NOW)).toMatchObject({ status: 'stale', at: NOW - 7 * H });
    const s = await series(db);
    expect(s.snap).toEqual([]);
    expect(s.waiting).toContain('snapshot osmosis: the holder list is older than 6 h, or no pass of it has added up to the supply since then');
    expect(s.count).toEqual([]);
  });

  it('a pass that added up 20 minutes ago: the snapshot is as of its start and the hourly count is stamped there', async () => {
    const db = seeded(NOW - 20 * MIN);
    const s = await series(db);
    expect(s.snap).toEqual([{ bucket: '1-1k', holders: 50, nam: 100, as_of: NOW - 20 * MIN }]);
    expect(s.count).toEqual([{ ts: NOW - 20 * MIN, value: 50 }]);
  });

  it('the pass that read every holder added up: the stamp is the oldest reading, as before the passes', async () => {
    const db = seeded(READ - MIN);
    const s = await series(db);
    expect(s.snap).toEqual([{ bucket: '1-1k', holders: 50, nam: 100, as_of: READ - MIN }]);
    expect(s.count).toEqual([{ ts: READ - MIN, value: 50 }]);
    // without a pass record (the rows of the build before the passes) the rows' own oldest reading stands
    db.raw.prepare("DELETE FROM kv WHERE key IN ('osmosis.holders.pass', 'jobs.daily', 'jobs.hourly')").run();
    db.raw.prepare('DELETE FROM holder_cohorts_daily').run();
    db.raw.prepare("DELETE FROM metrics WHERE key = 'holders.osmosis'").run();
    const t = await series(db);
    expect(t.snap).toEqual([{ bucket: '1-1k', holders: 50, nam: 100, as_of: READ }]);
    expect(t.count).toEqual([{ ts: READ, value: 50 }]);
  });

  it('no pass has added up yet (a record with no trusted start): no snapshot and no count', async () => {
    const db = seeded(0);
    db.raw.prepare("UPDATE kv SET value = json_set(value, '$.trustedStartedAt', json('null'), '$.trustedAt', json('null')) WHERE key = 'osmosis.holders.pass'").run();
    const s = await series(db);
    expect(s.snap).toEqual([]);
    expect(s.count).toEqual([]);
  });
});

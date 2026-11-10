// The validators view (docs/design/platform-plan.md, release C): GET /api/validators and GET /api/validators/history
// over validator_daily (migration 0007, read by day on the index of migration 0025), the page /validators and the
// two figures its served HTML states. What these tests hold true:
//   - the day served is the newest on record unless one is asked for; a share is a stake over the day's total; how
//     few validators hold MORE than a third and two thirds is counted from the largest down (exact thirds included);
//     a change is against the previous day on record and null where that day has no row;
//   - nothing is invented: an empty table and a failed read are 'missing' with a reason and every figure null, a row
//     the indexer's list did not cover keeps null (never '' or 0), and a day with no names says so in its stamp;
//   - input is refused in plain words before it reaches a statement, and a refusal is never stored;
//   - every read is a search on an index, never a walk of the table, and its rows are capped;
//   - the route's bookkeeping (cache key, reference, route, footer, copy) and the served page's sentences.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { app } from '../worker/src/api';
import { NAMES_STALE_MS, VALIDATOR_READS, historyDays, isDay, spreadCount, validatorHistoryAnswer, validatorsAnswer } from '../worker/src/validators';
import { pageHtml, validatorFacts } from '../worker/src/seo';
import { CACHEABLE_API, CACHE_PARAMS, cacheKeyUrl, isReplay } from '../worker/src/http';
import { endpointByPath } from '../shared/api-catalog';
import { BODY } from '../shared/copy';
import { ROUTE_ALIASES, classifyPath, routeById, routeByPath } from '../shared/routes';
import {
  STATE_NOT_RECORDED, VALIDATORS_MAX, VALIDATORS_SOURCE, VALIDATOR_DAYS_MAX, VALIDATOR_HISTORY_DAYS, VALIDATOR_NAMES_SOURCE, VALIDATOR_NAME_MAX,
  spreadLabel, spreadSentence, validatorNameShown, validatorStateOf, validatorStateWords,
} from '../shared/validators';
import { BANNED } from '../scripts/copy-lint';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import type { ValidatorHistoryResponse, ValidatorsResponse } from '../shared/types';

const D = 86_400_000;
/** 2026-11-10 05:30 UTC: the newest day seeded (9 November) is yesterday's. */
const NOW = Date.UTC(2026, 10, 10, 5, 30);
const DAYS = ['2026-11-07', '2026-11-08', '2026-11-09'];
/** Each day's listing completed ten minutes into the day; the indexer's list was read an hour before. */
const asOf = (day: string) => Date.parse(`${day}T00:10:00Z`);
const namesAt = (day: string) => asOf(day) - 3_600_000;
const heightOf = (day: string) => 8_500_000 + DAYS.indexOf(day) * 10_000;
/** A whole Namada address: tnam1 and forty characters of its alphabet. */
const addr = (c: string) => `tnam1q${c.repeat(39)}`;
const [A, B, C, E, F] = ['a', 'c', 'd', 'e', 'f'].map(addr);

const row = (day: string, validator: string, stake: number, delegators: number, named: { name: string | null; commission: number | null; state: string | null } | null) => ({
  day, validator, stake, delegators, commission: named?.commission ?? null, state: named?.state ?? null, name: named?.name ?? null,
  as_of: asOf(day), height: heightOf(day), names_at: named ? namesAt(day) : null,
});

/**
 * Three days. 7 November: three equal stakes, the indexer's list not read. 8 November: A, B, C and E. 9 November: 40,
 * 30, 20 and 10 (A, B, C and F, which was not there the day before; E is gone), F not in the indexer's list.
 */
function seed(): TestD1 {
  const db = testD1();
  insert(db, 'validator_daily', [
    row(DAYS[0], A, 30, 3, null), row(DAYS[0], B, 30, 2, null), row(DAYS[0], C, 30, 1, null),
    row(DAYS[1], A, 35, 4, { name: 'Alpha', commission: 0.05, state: 'consensus' }), row(DAYS[1], B, 30, 2, { name: 'Beta', commission: 0.1, state: 'consensus' }),
    row(DAYS[1], C, 25, 2, { name: 'Gamma', commission: 0, state: 'jailed' }), row(DAYS[1], E, 5, 1, { name: 'Epsilon', commission: 1, state: 'inactive' }),
    row(DAYS[2], A, 40, 5, { name: 'Alpha', commission: 0.05, state: 'consensus' }), row(DAYS[2], B, 30, 2, { name: 'Beta', commission: 0.1, state: 'consensus' }),
    row(DAYS[2], C, 20, 2, { name: null, commission: null, state: 'belowCapacity' }), row(DAYS[2], F, 10, 1, null),
  ]);
  return db;
}
const get = (db: unknown, path: string) => app.request(path, {}, { DB: db } as any);

afterEach(() => { vi.useRealTimers(); });

describe('GET /api/validators: one day of validator_daily', () => {
  it('serves the newest day on record, largest stake first, with exactly these fields', async () => {
    const a = await validatorsAnswer(seed() as any, NOW);
    expect(Object.keys(a).sort()).toEqual(['asOf', 'count', 'day', 'days', 'namesProv', 'prev', 'prov', 'third', 'totalNam', 'twoThirds', 'validators']);
    expect(a.asOf).toBe(NOW);
    expect(a.day).toBe('2026-11-09');
    expect(a.days).toEqual(['2026-11-09', '2026-11-08', '2026-11-07']);
    expect(a.prev).toBe('2026-11-08');
    expect(a.validators.map((v) => v.validator)).toEqual([A, B, C, F]);
    expect(a.validators.map((v) => v.stake)).toEqual([40, 30, 20, 10]);
    for (const v of a.validators) expect(Object.keys(v).sort()).toEqual(['changeNam', 'commission', 'delegators', 'name', 'share', 'stake', 'state', 'validator']);
    expect(a.totalNam).toBe(100);
    expect(a.count).toBe(4);
    expect(a.validators[0]).toEqual({ validator: A, name: 'Alpha', stake: 40, share: 0.4, delegators: 5, commission: 0.05, state: 'consensus', changeNam: 5 });
  });

  it('a share is the stake over the day\'s total, and the shares add up to one', async () => {
    const a = await validatorsAnswer(seed() as any, NOW);
    expect(a.validators.map((v) => v.share)).toEqual([0.4, 0.3, 0.2, 0.1]);
    expect(a.validators.reduce((n, v) => n + (v.share as number), 0)).toBeCloseTo(1, 12);
    const b = await validatorsAnswer(seed() as any, NOW, '2026-11-08');
    expect(b.validators.reduce((n, v) => n + (v.share as number), 0)).toBeCloseTo(1, 12);
  });

  it('counts how few validators hold MORE than a third and two thirds, exact thirds included', async () => {
    // 40, 30, 20, 10: the largest alone is more than a third; the two largest (70) are more than two thirds
    const a = await validatorsAnswer(seed() as any, NOW);
    expect([a.third, a.twoThirds]).toEqual([1, 2]);
    // 30, 30, 30: one validator holds exactly a third, which is not more than a third; two hold exactly two thirds
    const eq = await validatorsAnswer(seed() as any, NOW, '2026-11-07');
    expect([eq.third, eq.twoThirds]).toEqual([2, 3]);
    expect(spreadCount([40, 30, 20, 10], 100, 1, 3)).toBe(1);
    expect(spreadCount([40, 30, 20, 10], 100, 2, 3)).toBe(2);
    expect(spreadCount([50, 50], 100, 1, 3)).toBe(1);
    expect(spreadCount([100], 100, 2, 3)).toBe(1);
    // a third to the last digit a float holds is still not more than a third
    expect(spreadCount([0.1, 0.1, 0.1], 0.1 + 0.1 + 0.1, 1, 3)).toBe(2);
    // nothing staked, no row, or rows that do not reach the part (more rows exist than were read): not said
    expect(spreadCount([], 0, 1, 3)).toBeNull();
    expect(spreadCount([0, 0], 0, 1, 3)).toBeNull();
    expect(spreadCount([10, 10], 100, 1, 3)).toBeNull();
  });

  it('a change is the stake less the stake on the previous day on record, null where that day has no row for the validator', async () => {
    const a = await validatorsAnswer(seed() as any, NOW);
    expect(a.validators.map((v) => v.changeNam)).toEqual([5, 0, -5, null]);
    // the first day on record has no day before it: no change is stated, and none is 0
    const first = await validatorsAnswer(seed() as any, NOW, '2026-11-07');
    expect(first.prev).toBeNull();
    expect(first.validators.map((v) => v.changeNam)).toEqual([null, null, null]);
    // the previous day on record is the day before in the record, not the calendar: a gap is stepped over
    const db = seed();
    db.exec("DELETE FROM validator_daily WHERE day = '2026-11-08'");
    const gap = await validatorsAnswer(db as any, NOW);
    expect(gap.prev).toBe('2026-11-07');
    expect(gap.validators.map((v) => v.changeNam)).toEqual([10, 0, -10, null]);
  });

  it('keeps null for what the indexer\'s list did not have, and says so when it was not read for the day', async () => {
    const a = await validatorsAnswer(seed() as any, NOW);
    // C is in the list without a name or a commission; F is not in the list at all
    expect(a.validators[2]).toMatchObject({ name: null, commission: null, state: 'belowCapacity' });
    expect(a.validators[3]).toMatchObject({ name: null, commission: null, state: null });
    expect(a.namesProv).toEqual({ source: VALIDATOR_NAMES_SOURCE, at: namesAt('2026-11-09'), status: 'live' });
    const none = await validatorsAnswer(seed() as any, NOW, '2026-11-07');
    expect(none.namesProv).toEqual({ source: 'indexer.namada.net', at: null, status: 'missing', note: 'Names, commission and state were not read for that day.' });
    for (const v of none.validators) expect([v.name, v.commission, v.state]).toEqual([null, null, null]);
    // the stakes of that day are served all the same
    expect(none.totalNam).toBe(90);
    expect(none.prov.status).toBe('stale');
  });

  it('passes on a stored name as text or null, a commission only as a fraction, a state only as one short word', async () => {
    const db = testD1();
    insert(db, 'validator_daily', [
      { ...row('2026-11-09', A, 3, 1, null), name: '', commission: 7, state: '<img src=x onerror=alert(1)>', names_at: namesAt('2026-11-09') },
      { ...row('2026-11-09', B, 2, 1, null), name: '   ', commission: -0.1, state: 'below_threshold', names_at: namesAt('2026-11-09') },
      { ...row('2026-11-09', C, 1, 1, null), name: '<b>Bold</b> & co', commission: 0.2, state: 'x'.repeat(40), names_at: namesAt('2026-11-09') },
    ]);
    const a = await validatorsAnswer(db as any, NOW);
    expect(a.validators.map((v) => [v.name, v.commission, v.state])).toEqual([[null, null, null], [null, null, 'below_threshold'], ['<b>Bold</b> & co', 0.2, null]]);
  });

  it('stamps the listing with its own time and block: current for today\'s and yesterday\'s day, old otherwise, and says which', async () => {
    const live = await validatorsAnswer(seed() as any, NOW);
    expect(live.prov).toEqual({ source: VALIDATORS_SOURCE, at: asOf('2026-11-09'), height: heightOf('2026-11-09'), status: 'live' });
    expect(VALIDATORS_SOURCE).toBe('Namada node (bond listing)');
    // the same day asked for as today's day
    expect((await validatorsAnswer(seed() as any, Date.UTC(2026, 10, 9, 0, 20))).prov.status).toBe('live');
    // two days on, no newer listing is on record
    const old = await validatorsAnswer(seed() as any, NOW + D);
    expect(old.prov).toEqual({ source: VALIDATORS_SOURCE, at: asOf('2026-11-09'), height: heightOf('2026-11-09'), status: 'stale', note: 'The listing of a newer day is not on record.' });
    expect(old.namesProv).toEqual({ source: VALIDATOR_NAMES_SOURCE, at: namesAt('2026-11-09'), status: 'stale', note: 'The listing of a newer day is not on record.' });
    // an earlier day asked for is old for another reason, and its stamp does not say that no newer day exists
    const earlier = await validatorsAnswer(seed() as any, NOW + D, '2026-11-08');
    expect(earlier.prov).toMatchObject({ at: asOf('2026-11-08'), height: heightOf('2026-11-08'), status: 'stale', note: 'This is the listing of an earlier day; newer days are on record.' });
    expect(earlier.prev).toBe('2026-11-07');
    expect(earlier.validators.map((v) => v.validator)).toEqual([A, B, C, E]);
  });

  it('says the indexer\'s list is old when it was read long before the listing it was written with', async () => {
    const db = seed();
    db.raw.prepare("UPDATE validator_daily SET names_at = ? WHERE day = '2026-11-09' AND names_at IS NOT NULL").run(asOf('2026-11-09') - NAMES_STALE_MS - 1);
    const a = await validatorsAnswer(db as any, NOW);
    expect(a.prov.status).toBe('live');
    expect(a.namesProv).toEqual({ source: VALIDATOR_NAMES_SOURCE, at: asOf('2026-11-09') - NAMES_STALE_MS - 1, status: 'stale', note: 'The indexer\'s list was not read again before this listing was made.' });
  });

  it('an empty table: every figure null, no row, and the stamp says nothing is on record', async () => {
    const a = await validatorsAnswer(testD1() as any, NOW);
    expect(a).toEqual({
      asOf: NOW, day: null, days: [], validators: [], totalNam: null, count: null, third: null, twoThirds: null, prev: null,
      prov: { source: VALIDATORS_SOURCE, at: null, status: 'missing', note: 'No validator listing is on record yet.' },
      namesProv: { source: VALIDATOR_NAMES_SOURCE, at: null, status: 'missing', note: 'No validator listing is on record yet.' },
    });
  });

  it('a read that fails: the same shape with the reason, never a zero and never a refusal', async () => {
    const db = seed();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // the database does not answer at all
      const down = await validatorsAnswer({ prepare: () => { throw new Error('D1_ERROR'); } } as any, NOW);
      expect(down).toMatchObject({ day: null, days: [], validators: [], totalNam: null, count: null, third: null, twoThirds: null, prev: null });
      expect(down.prov).toEqual({ source: VALIDATORS_SOURCE, at: null, status: 'missing', note: 'The validator listing could not be read.' });
      expect(down.namesProv.status).toBe('missing');
      // the days are read and the day's rows are not: the days are kept, the figures are not made up
      const half = { prepare: (sql: string) => { if (sql === VALIDATOR_READS.rows) throw new Error('D1_ERROR'); return db.prepare(sql); } };
      const cut = await validatorsAnswer(half as any, NOW);
      expect(cut.days).toEqual(['2026-11-09', '2026-11-08', '2026-11-07']);
      expect(cut).toMatchObject({ day: null, validators: [], totalNam: null, count: null, third: null, twoThirds: null });
      expect(cut.prov.note).toBe('The validator listing could not be read.');
      // without the index of migration 0025 the statements do not run: said as not read, never read another way
      db.exec('DROP INDEX validator_daily_day');
      expect((await validatorsAnswer(db as any, NOW)).prov).toMatchObject({ status: 'missing', note: 'The validator listing could not be read.' });
      expect((await get(db, '/api/validators')).status).toBe(200);
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a day that is not a day, and a day with no listing, in plain words; a refusal is never stored', async () => {
    const db = seed();
    for (const bad of ['yesterday', '2026-13-40', '2026-02-30', '20261109', '2026-11-9', '2026-11-09T00:00', "2026-11-09' OR 1=1", '-1']) {
      const res = await get(db, `/api/validators?day=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get('cache-control'), bad).toBe('no-store');
      expect(await res.json(), bad).toEqual({ error: 'day must be a UTC day written YYYY-MM-DD.', reason: 'day must be a UTC day written YYYY-MM-DD.', endpoint: '/api/validators' });
    }
    const res = await get(db, '/api/validators?day=2026-11-06');
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'No listing of 2026-11-06 is on record.', reason: 'The newest days on record are listed in `days` of this route\'s answer.', endpoint: '/api/validators' });
    expect(isDay('2026-11-09')).toBe(true);
    expect(isDay('2024-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    // an empty `day` reads as left out
    expect(((await (await get(db, '/api/validators?day=')).json()) as ValidatorsResponse).day).toBe('2026-11-09');
  });

  it('is served at /api/validators on the request\'s own clock', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = seed();
    const res = await get(db, '/api/validators');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ValidatorsResponse;
    expect(body).toEqual(await validatorsAnswer(db as any, NOW));
    expect(body.prov.status).toBe('live');
    const day = (await (await get(db, '/api/validators?day=2026-11-08')).json()) as ValidatorsResponse;
    expect(day.day).toBe('2026-11-08');
    expect(day.days).toEqual(body.days);
    // two days later the same rows are old
    vi.setSystemTime(NOW + 2 * D);
    expect(((await (await get(db, '/api/validators')).json()) as ValidatorsResponse).prov.status).toBe('stale');
  });

  it('answers with at most the rows and the days the route states, the totals still of the whole day', async () => {
    const db = testD1();
    const n = VALIDATORS_MAX + 7;
    const many = Array.from({ length: n }, (_, i) => row('2026-11-09', `tnam1q${String(i).padStart(39, '0').replace(/1/g, 'x')}`, n - i, 1, null));
    insert(db, 'validator_daily', many);
    // ninety-five days of one validator
    insert(db, 'validator_daily', Array.from({ length: VALIDATOR_DAYS_MAX + 5 }, (_, i) => row(new Date(Date.UTC(2026, 6, 1) + i * D).toISOString().slice(0, 10), A, 1, 1, null)));
    const a = await validatorsAnswer(db as any, NOW);
    expect(a.validators).toHaveLength(VALIDATORS_MAX);
    expect(a.validators[0].stake).toBe(n);
    expect(a.count).toBe(n);
    expect(a.totalNam).toBe((n * (n + 1)) / 2);
    // shares are of the whole day's total, so the rows served do not add up to one
    expect(a.validators.reduce((s, v) => s + (v.share as number), 0)).toBeLessThan(1);
    expect(a.days).toHaveLength(VALIDATOR_DAYS_MAX);
    expect(a.days[0]).toBe('2026-11-09');
    expect([...a.days].sort().reverse()).toEqual(a.days);
    expect(new Set(a.days).size).toBe(VALIDATOR_DAYS_MAX);
  });
});

describe('GET /api/validators/history: one validator over its days', () => {
  it('answers its newest days oldest first, with exactly these fields', async () => {
    const h = await validatorHistoryAnswer(seed() as any, NOW, A);
    expect(Object.keys(h).sort()).toEqual(['days', 'name', 'prov', 'validator']);
    expect(h.validator).toBe(A);
    expect(h.name).toBe('Alpha');
    expect(h.days).toEqual([
      { day: '2026-11-07', stake: 30, delegators: 3, commission: null, state: null },
      { day: '2026-11-08', stake: 35, delegators: 4, commission: 0.05, state: 'consensus' },
      { day: '2026-11-09', stake: 40, delegators: 5, commission: 0.05, state: 'consensus' },
    ]);
    expect(h.prov).toEqual({ source: VALIDATORS_SOURCE, at: asOf('2026-11-09'), height: heightOf('2026-11-09'), status: 'live' });
  });

  it('caps the days at the number asked for, the newest ones, and at thirty when none is asked for', async () => {
    const db = seed();
    expect((await validatorHistoryAnswer(db as any, NOW, A, '2')).days.map((d) => d.day)).toEqual(['2026-11-08', '2026-11-09']);
    expect((await validatorHistoryAnswer(db as any, NOW, A, '1')).days.map((d) => d.day)).toEqual(['2026-11-09']);
    expect((await validatorHistoryAnswer(db as any, NOW, A, '90')).days).toHaveLength(3);
    const long = testD1();
    insert(long, 'validator_daily', Array.from({ length: VALIDATOR_DAYS_MAX + 5 }, (_, i) => row(new Date(Date.UTC(2026, 6, 1) + i * D).toISOString().slice(0, 10), A, i + 1, 1, null)));
    const def = await validatorHistoryAnswer(long as any, NOW, A);
    expect(def.days).toHaveLength(VALIDATOR_HISTORY_DAYS);
    expect(def.days[def.days.length - 1].stake).toBe(VALIDATOR_DAYS_MAX + 5);
    expect(def.days[0].stake).toBe(VALIDATOR_DAYS_MAX + 5 - VALIDATOR_HISTORY_DAYS + 1);
    expect((await validatorHistoryAnswer(long as any, NOW, A, String(VALIDATOR_DAYS_MAX))).days).toHaveLength(VALIDATOR_DAYS_MAX);
    expect([historyDays(undefined), historyDays(''), historyDays('1'), historyDays('90')]).toEqual([30, 30, 1, 90]);
  });

  it('a validator whose newest day is not current is stamped old; its name is the newest one among the days answered', async () => {
    const h = await validatorHistoryAnswer(seed() as any, NOW, E);
    expect(h.days.map((d) => d.day)).toEqual(['2026-11-08']);
    expect(h.name).toBe('Epsilon');
    expect(h.prov).toEqual({ source: VALIDATORS_SOURCE, at: asOf('2026-11-08'), height: heightOf('2026-11-08'), status: 'stale', note: 'No row of a newer day is on record for this validator.' });
    // C had a name on 8 November and none on 9 November: the newest name among the days answered, or none
    expect((await validatorHistoryAnswer(seed() as any, NOW, C)).name).toBe('Gamma');
    expect((await validatorHistoryAnswer(seed() as any, NOW, C, '1')).name).toBeNull();
    expect((await validatorHistoryAnswer(seed() as any, NOW, F)).name).toBeNull();
  });

  it('refuses an address that is not a whole Namada address, and a days that is not a whole number in the range', async () => {
    const db = seed();
    const bad = ['', 'tnam1', 'tnam1qaaa', A.toUpperCase(), `${A}x'--`, `osmo1${'q'.repeat(38)}`, A.replace('a', 'b'), `${A} `, '%', `tnam1q${'a'.repeat(120)}`];
    for (const v of bad) {
      const res = await get(db, `/api/validators/history?validator=${encodeURIComponent(v)}`);
      expect(res.status, v).toBe(400);
      expect(res.headers.get('cache-control'), v).toBe('no-store');
      const body = (await res.json()) as { error: string; endpoint: string };
      expect(body.endpoint).toBe('/api/validators/history');
      expect(body.error, v).toBe(v ? 'validator must be a whole Namada address.' : 'validator is required: a whole Namada address.');
    }
    expect((await get(db, '/api/validators/history')).status).toBe(400);
    for (const d of ['0', '91', '365', '-1', '1.5', 'abc', '1e1', ' 5', '0x10']) {
      const res = await get(db, `/api/validators/history?validator=${A}&days=${encodeURIComponent(d)}`);
      expect(res.status, d).toBe(400);
      expect(((await res.json()) as { error: string }).error, d).toBe('days must be a whole number from 1 to 90.');
    }
    // the address is checked before the statement is made: nothing is asked of the database for a refused request
    const before = db.queries;
    await get(db, `/api/validators/history?validator=${encodeURIComponent("x' OR '1'='1")}`);
    expect(db.queries).toBe(before);
  });

  it('a validator with no row is not found, in plain words; a failed read is a failure and neither is stored', async () => {
    const db = seed();
    const unknown = addr('g');
    const res = await get(db, `/api/validators/history?validator=${unknown}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'No row is on record for that validator.', reason: 'No row is on record for that validator.', endpoint: '/api/validators/history' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const down = await get({ prepare: () => { throw new Error('D1_ERROR'); } }, `/api/validators/history?validator=${A}`);
      expect(down.status).toBe(500);
      expect(down.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(await down.json())).not.toContain('D1_ERROR');
    } finally {
      log.mockRestore();
    }
  });

  it('is served at /api/validators/history', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const db = seed();
    const res = await get(db, `/api/validators/history?validator=${A}&days=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ValidatorHistoryResponse;
    expect(body).toEqual(await validatorHistoryAnswer(db as any, NOW, A, '2'));
    for (const d of body.days) expect(Object.keys(d).sort()).toEqual(['commission', 'day', 'delegators', 'stake', 'state']);
  });
});

describe('the reads and what they cost', () => {
  const plan = (db: TestD1, sql: string, ...params: unknown[]) => (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join('\n');

  it('every read by day is a search on the index of migration 0025, a validator\'s days a search on the table\'s key; nothing walks the table', () => {
    const db = seed();
    const plans = {
      days: plan(db, VALIDATOR_READS.days),
      sum: plan(db, VALIDATOR_READS.sum, '2026-11-09'),
      rows: plan(db, VALIDATOR_READS.rows, '2026-11-09', VALIDATORS_MAX),
      history: plan(db, VALIDATOR_READS.history, A, 30),
    };
    for (const [name, p] of Object.entries(plans)) expect(p, name).not.toMatch(/SCAN validator_daily|SCAN a\b|SCAN b\b/);
    expect(plans.days).toMatch(/SEARCH validator_daily USING COVERING INDEX validator_daily_day \(day<\?\)/);
    expect(plans.sum).toMatch(/SEARCH validator_daily USING INDEX validator_daily_day \(day=\?\)/);
    expect(plans.rows).toMatch(/SEARCH a USING INDEX validator_daily_day \(day=\?\)/);
    expect(plans.rows).toMatch(/SEARCH b USING INDEX sqlite_autoindex_validator_daily_1 \(validator=\? AND day=\?\)/);
    expect(plans.history).toMatch(/SEARCH validator_daily USING INDEX sqlite_autoindex_validator_daily_1 \(validator=\?\)/);
    // each statement that reads by day names the index, and each is bounded by a LIMIT or by one day's range
    for (const sql of [VALIDATOR_READS.days, VALIDATOR_READS.sum, VALIDATOR_READS.rows]) expect(sql).toContain('INDEXED BY validator_daily_day');
    expect(VALIDATOR_READS.days).toContain(`LIMIT ${VALIDATOR_DAYS_MAX}`);
    expect(VALIDATOR_READS.rows).toMatch(/LIMIT \?2$/);
    expect(VALIDATOR_READS.history).toMatch(/LIMIT \?2$/);
  });

  it('the migration adds the index and nothing else', () => {
    const sql = readFileSync(new URL('../migrations/0025_validator_daily_day.sql', import.meta.url), 'utf8');
    const statements = sql.split('\n').filter((l) => l.trim() && !l.startsWith('--'));
    expect(statements).toEqual(['CREATE INDEX IF NOT EXISTS validator_daily_day ON validator_daily (day);']);
  });

  it('one answer is three statements, a history one', async () => {
    const db = seed();
    const before = db.queries;
    await validatorsAnswer(db as any, NOW);
    expect(db.queries - before).toBe(3);
    const then = db.queries;
    await validatorHistoryAnswer(db as any, NOW, A);
    expect(db.queries - then).toBe(1);
  });
});

describe('the routes\' place in the cache, the limiter and the reference', () => {
  const u = (p: string) => new URL(`https://namada.trade${p}`);

  it('are kept at the edge on exactly the parameters they read', () => {
    expect(CACHE_PARAMS['/api/validators']).toEqual(['day']);
    expect(CACHE_PARAMS['/api/validators/history']).toEqual(['validator', 'days']);
    for (const p of ['/api/validators', '/api/validators/history']) expect(CACHEABLE_API.test(p), p).toBe(true);
    expect(CACHEABLE_API.test('/api/validators/other')).toBe(false);
    expect(cacheKeyUrl(u('/api/validators?r=1&day=2026-11-09&at=5'))).toBe('https://namada.trade/api/validators?day=2026-11-09');
    expect(cacheKeyUrl(u(`/api/validators/history?days=30&zz=1&validator=${A}`))).toBe(`https://namada.trade/api/validators/history?days=30&validator=${A}`);
  });

  it('a day other than the newest and one validator\'s days are limited on a miss; the newest day is not', () => {
    expect(isReplay(u('/api/validators'))).toBe(false);
    expect(isReplay(u('/api/validators?day=2026-11-08'))).toBe(true);
    expect(isReplay(u(`/api/validators/history?validator=${A}`))).toBe(true);
  });

  it('are documented with their parameters, their bounds and the answers they refuse with', () => {
    const list = endpointByPath('/api/validators')!;
    expect(list.params.map((p) => [p.name, p.type])).toEqual([['day', 'day']]);
    expect(list.notFound).toBeUndefined();
    const hist = endpointByPath('/api/validators/history')!;
    expect(hist.params.map((p) => [p.name, p.type, p.required ?? false])).toEqual([['validator', 'address', true], ['days', 'whole', false]]);
    expect(hist.params[1]).toMatchObject({ min: 1, max: VALIDATOR_DAYS_MAX, fallback: String(VALIDATOR_HISTORY_DAYS) });
    expect(hist.notFound).toBeDefined();
    expect(Object.keys(list.fields)).toEqual(['asOf', 'day', 'days', 'validators', 'totalNam', 'count', 'third', 'twoThirds', 'prev', 'prov', 'namesProv']);
    expect(Object.keys(hist.fields)).toEqual(['validator', 'name', 'days', 'prov']);
    // the count of validators behind a third is described as how the staked NAM is spread, in these words
    expect(list.fields.third).toBe('The smallest number of validators, largest first, whose stake together is more than one third of the total: a statement of how the staked NAM is spread. Null when the day has no row.');
    expect(list.fields.twoThirds).toBe('The same for more than two thirds of the total.');
  });
});

describe('the page /validators', () => {
  const route = routeByPath('/validators')!;

  it('is a route of its own, reached by the words people type, linked from the footer after Staking and from the Staking page', () => {
    expect(route).toMatchObject({ id: 'validators', label: 'Validators', index: true, h1: 'Who validates Namada, and how is the staked NAM spread?' });
    expect(routeById('validators')).toBe(route);
    expect(route.tab).toBeUndefined();
    expect(route.key).toBeUndefined();
    for (const from of ['validator', 'validator-set']) {
      expect(ROUTE_ALIASES[from]).toBe('/validators');
      expect(classifyPath(`/${from}`)).toEqual({ kind: 'redirect', to: '/validators' });
    }
    expect(classifyPath('/Validators/')).toEqual({ kind: 'redirect', to: '/validators' });
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const ids = /const LINK_IDS: RouteId\[\] = \[([^\]]+)\]/.exec(read('web/src/app/Footer.tsx'))![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(ids.indexOf('validators')).toBe(ids.indexOf('staking') + 1);
    expect(read('web/src/screens/seo/Staking.tsx')).toContain('<GoLink to="/validators">Every validator and its stake</GoLink>');
    expect(read('web/src/app/App.tsx')).toContain('validators: () => seo().then((m) => ({ default: m.Validators })),');
    expect(read('web/e2e/platform.spec.ts')).toContain("routeByPath('/validators')!");
  });

  it('its words: two paragraphs, plain, no figure typed, no advice, and what the figures are in one sentence', () => {
    const copy = BODY.validators;
    expect(copy.paras).toHaveLength(2);
    expect(copy.sections).toBeUndefined();
    expect(copy.facts).toEqual(['validatorCount', 'validatorThird']);
    // the second paragraph says what the spread is and that it is nothing more, in these words
    expect(copy.paras[1]).toContain('describes how that NAM is spread, and nothing more.');
    for (const p of copy.paras) {
      expect(p).not.toMatch(/\d/);
      expect(p.includes('—')).toBe(false);
      for (const b of BANNED) expect(b.re.test(p), `"${b.word}" in: ${p}`).toBe(false);
    }
    const sentences = copy.paras.join(' ').split(/(?<=\.)\s+/);
    expect(sentences.filter((s) => /first complete listing of each UTC day/.test(s) && /names, commission and state come from the network indexer's list and may be missing/.test(s))).toHaveLength(1);
  });

  it('the served page states the two figures with their source and time when they were read', async () => {
    const a = await validatorsAnswer(seed() as any, NOW);
    const f = validatorFacts(a);
    expect(f).toEqual({
      validatorCount: { text: 'Validators with NAM staked with them: 4', at: asOf('2026-11-09'), source: 'Namada node (bond listing)' },
      validatorThird: { text: 'The largest validator holds more than a third of the staked NAM', at: asOf('2026-11-09'), source: 'Namada node (bond listing)' },
    });
    const html = pageHtml(route, f);
    expect(html).toContain('>Who validates Namada, and how is the staked NAM spread?</h1>');
    expect(html.split('Validators with NAM staked with them: 4').length - 1).toBe(1);
    expect(html.split('The largest validator holds more than a third of the staked NAM').length - 1).toBe(1);
    expect(html).toContain('(Namada node (bond listing), 2026-11-09 00:10 UTC)');
    for (const p of BODY.validators.paras) expect(html).toContain(p.replace(/'/g, '&#39;'));
    expect(html).toContain('<a href="/validators"');
    // three equal stakes: two validators, said in the plural with the count
    const eq = validatorFacts(await validatorsAnswer(seed() as any, NOW, '2026-11-07'));
    expect(eq.validatorThird?.text).toBe('The 2 largest validators hold more than a third of the staked NAM');
    expect(eq.validatorCount?.text).toBe('Validators with NAM staked with them: 3');
  });

  it('and states neither when nothing was read: no list, no zero', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const none = [
        validatorFacts(await validatorsAnswer(testD1() as any, NOW)),
        validatorFacts(await validatorsAnswer({ prepare: () => { throw new Error('D1_ERROR'); } } as any, NOW)),
        validatorFacts(null),
        validatorFacts(undefined),
      ];
      for (const f of none) {
        expect(f).toEqual({});
        const html = pageHtml(route, f);
        expect(html).not.toContain('Validators with NAM staked');
        expect(html).not.toContain('more than a third of the staked NAM');
        expect(html).not.toMatch(/<ul/);
        expect(html).toContain('>Who validates Namada, and how is the staked NAM spread?</h1>');
      }
      // the count is read and the spread is not: one sentence, not two
      const half = validatorFacts({ count: 12, third: null, prov: { source: VALIDATORS_SOURCE, at: NOW, status: 'live' } });
      expect(Object.keys(half)).toEqual(['validatorCount']);
    } finally {
      log.mockRestore();
    }
  });
});

describe('the chain\'s own text, and the words of a state', () => {
  it('a name is printed as text, on one line, without characters that draw nothing, at most forty characters long', () => {
    expect(VALIDATOR_NAME_MAX).toBe(40);
    expect(validatorNameShown('Alpha')).toBe('Alpha');
    expect(validatorNameShown('  Alpha \n  Node\t ')).toBe('Alpha Node');
    const long = validatorNameShown('x'.repeat(80))!;
    expect([...long]).toHaveLength(40);
    expect(long.endsWith('…')).toBe(true);
    expect(validatorNameShown('y'.repeat(40))).toBe('y'.repeat(40));
    // a cut never splits a character written as two code units
    expect([...validatorNameShown('🦀'.repeat(60))!]).toHaveLength(40);
    // direction marks, zero-width marks and control characters are taken out
    expect(validatorNameShown('\u202eevil\u202c\u200b\u0000name\ufeff')).toBe('evil name');
    for (const empty of [null, undefined, '', '   ', '\u200b\u200d', '\u0000']) expect(validatorNameShown(empty as string | null)).toBeNull();
    // markup is text to it: the page prints it through React, which escapes it; nothing here turns it into markup
    expect(validatorNameShown('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    expect(validatorNameShown(42 as unknown as string)).toBeNull();
  });

  it('a state is said in plain words from one table, and a word that is not in it is "Not recorded"', () => {
    expect(validatorStateWords('consensus')).toBe('In the active set');
    expect(validatorStateWords('inactive')).toBe('Not active');
    expect(validatorStateWords('jailed')).toBe('Jailed');
    expect(validatorStateWords('below_capacity')).toBe('Below the active set');
    expect(validatorStateWords('belowCapacity')).toBe('Below the active set');
    expect(validatorStateWords('below_threshold')).toBe('Under the minimum stake');
    expect(validatorStateWords('belowThreshold')).toBe('Under the minimum stake');
    for (const other of ['unknown', 'tombstoned', '', null, undefined, 'constructor', '__proto__', 'toString']) expect(validatorStateWords(other as string | null), String(other)).toBe(STATE_NOT_RECORDED);
    expect(STATE_NOT_RECORDED).toBe('Not recorded');
    expect(validatorStateOf('consensus')).toBe('consensus');
    expect(validatorStateOf('belowCapacity')).toBe('belowCapacity');
    for (const bad of ['', ' consensus', 'a b', '<b>', 'x'.repeat(33), 5, null, undefined, {}]) expect(validatorStateOf(bad)).toBeNull();
  });

  it('the spread is said the same way on the served page and on the screen', () => {
    expect(spreadSentence(1, '1', 'a third')).toBe('The largest validator holds more than a third of the staked NAM');
    expect(spreadSentence(7, '7', 'two thirds')).toBe('The 7 largest validators hold more than two thirds of the staked NAM');
    expect(spreadLabel(1, 'a third')).toBe('largest validator holds more than a third of the staked NAM');
    expect(spreadLabel(7, 'two thirds')).toBe('largest validators hold more than two thirds of the staked NAM');
    expect(spreadLabel(null, 'a third')).toBe('largest validators hold more than a third of the staked NAM');
  });
});

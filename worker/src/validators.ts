// The validators view: GET /api/validators and GET /api/validators/history (mounted in api.ts), and the two figures
// the served page /validators states (seo.ts validatorFacts).
//
// validator_daily (migration 0007) holds one row per validator with stake per UTC day, written once a day by
// series.ts bondListingSeries from the first complete bond listing of that day: the stake and the number of addresses
// bonded come from a Namada node (`as_of`, `height`), the name, commission and state from the indexer's validator
// list (`names_at`, NULL on a row that list did not cover). Nothing is written here and nothing is filled in: a day
// without a listing has no row, a validator the indexer's list did not name has no name, and a read that fails is
// answered as missing with the reason, every figure null.
//
// The reads and what each costs. The table's key is (validator, day): one validator over days is a range of the key.
// One day over validators is a range of the index on (day) (migration 0025, named in every statement that reads by
// day, so a read that stops matching fails instead of reading the whole table): about 250 rows a day, capped at
// VALIDATORS_MAX. The days on record are read one seek a day on the same index, at most VALIDATOR_DAYS_MAX. The stake
// of the day before is one seek a row on the table's key.
import type { Provenance, ValidatorDay, ValidatorHistoryResponse, ValidatorRow, ValidatorsResponse } from '../../shared/types';
import {
  VALIDATORS_MAX, VALIDATOR_DAYS_MAX, VALIDATOR_HISTORY_DAYS, VALIDATORS_SOURCE, VALIDATOR_NAMES_SOURCE, validatorStateOf,
} from '../../shared/validators';
import { ApiInputError } from './api-route';
import { chainOf } from './util';

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The index every read by day runs on (migrations/0025_validator_daily_day.sql). */
const BY_DAY = 'INDEXED BY validator_daily_day';
/** The day on record before ?1: one seek. */
const PREV_DAY = `(SELECT MAX(day) FROM validator_daily ${BY_DAY} WHERE day < ?1)`;

export const VALIDATOR_READS = {
  /**
   * The days on record, newest first: the newest day, then the newest day before each, one seek on the index a day
   * (never a walk of every row of every day). The LIMIT bounds the recursion; its last row is NULL when fewer days
   * are on record, and is left out.
   */
  days: `WITH RECURSIVE d(day) AS (
      SELECT MAX(day) FROM validator_daily ${BY_DAY}
      UNION ALL
      SELECT (SELECT MAX(day) FROM validator_daily ${BY_DAY} WHERE day < d.day) FROM d WHERE d.day IS NOT NULL
      LIMIT ${VALIDATOR_DAYS_MAX})
    SELECT day FROM d WHERE day IS NOT NULL`,
  /**
   * One day as a whole: how many rows, their stake together, how many have stake, the listing's time and block (the
   * oldest among the rows: a sum is as old as its oldest part), the newest read of the indexer's list, and the day on
   * record before it. One range of the index (the day's rows) and one seek. Always one row; `n` is 0 for a day not on record.
   */
  sum: `SELECT COUNT(*) n, SUM(stake) total, SUM(stake > 0) staked, MIN(as_of) as_of, MIN(height) height, MAX(names_at) names_at, ${PREV_DAY} prev
        FROM validator_daily ${BY_DAY} WHERE day = ?1`,
  /**
   * The day's rows, largest stake first, each with its stake on the day on record before (NULL when that day has no
   * row for it, or there is no such day). One range of the index and one seek on the table's key a row; the LIMIT
   * (?2) caps the rows answered, not the range read, which is one day's rows.
   */
  rows: `SELECT a.validator, a.name, a.stake, a.delegators, a.commission, a.state, b.stake prev_stake
         FROM validator_daily a ${BY_DAY}
         LEFT JOIN validator_daily b ON b.validator = a.validator AND b.day = ${PREV_DAY}
         WHERE a.day = ?1 ORDER BY a.stake DESC, a.validator LIMIT ?2`,
  /** One validator's newest days: a range of the table's key, walked from its newest end, ?2 rows at most. */
  history: `SELECT day, stake, delegators, commission, state, name, as_of, height FROM validator_daily WHERE validator = ?1 ORDER BY day DESC LIMIT ?2`,
} as const;

interface SumRow { n: number; total: number | null; staked: number | null; as_of: number | null; height: number | null; names_at: number | null; prev: string | null }
interface DayRow { validator: string; name: string | null; stake: number; delegators: number; commission: number | null; state: string | null; prev_stake: number | null }
interface HistoryRow { day: string; stake: number; delegators: number; commission: number | null; state: string | null; name: string | null; as_of: number; height: number }

const NOT_READ = 'The validator listing could not be read.';
const NONE_YET = 'No validator listing is on record yet.';
const NO_NAMES = 'Names, commission and state were not read for that day.';
const NO_NEWER = 'The listing of a newer day is not on record.';
/** The indexer's list is read once a day: one read more than this long before the listing it was written with is old. */
export const NAMES_STALE_MS = 2 * DAY_MS;

/** A stored name as the API passes it on: text, or null (never an empty string). */
const nameOf = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() ? raw : null);
/** A commission as the API passes it on: a fraction between 0 and 1, or null. */
const commissionOf = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null);

/** Is the text a real UTC day written YYYY-MM-DD? */
export const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && isoDay(Date.parse(`${s}T00:00:00Z`)) === s;

/**
 * Is a day's listing current? The listing of a day is the first complete one of that UTC day, so today's and
 * yesterday's are the newest there can be (today's is written some minutes into the day).
 */
const currentDay = (day: string, now: number): boolean => day >= isoDay(now - DAY_MS);

/**
 * The smallest number of rows, in the order given (largest stake first), whose stake together is MORE than
 * `num / den` of `total`; null when the rows given do not reach it (more rows exist than were read) or nothing is staked.
 */
export function spreadCount(stakes: number[], total: number, num: number, den: number): number | null {
  if (!(total > 0)) return null;
  let sum = 0;
  for (let i = 0; i < stakes.length; i++) {
    sum += stakes[i];
    if (sum * den > total * num) return i + 1;
  }
  return null;
}

const missing = (source: string, note: string): Provenance => ({ source, at: null, status: 'missing', note });
const empty = (now: number, days: string[], note: string): ValidatorsResponse => ({
  asOf: now, day: null, days, validators: [], totalNam: null, count: null, third: null, twoThirds: null, prev: null,
  prov: missing(VALIDATORS_SOURCE, note), namesProv: missing(VALIDATOR_NAMES_SOURCE, note),
});

/**
 * GET /api/validators. `dayParam` left out: the newest day on record. A `dayParam` that is not a day, or a day with
 * no row, is refused (ApiInputError 400). An empty table and a failed read are answers, not refusals: every figure
 * null and the stamp 'missing' with the reason. `now` is the request's clock: it decides only whether the day
 * served is current.
 */
export async function validatorsAnswer(db: D1Database, now: number, dayParam?: string | null): Promise<ValidatorsResponse> {
  const asked = dayParam != null && dayParam !== '' ? dayParam : null;
  if (asked != null && !isDay(asked)) throw new ApiInputError(400, 'day must be a UTC day written YYYY-MM-DD.');
  let days: string[];
  try {
    days = ((await db.prepare(VALIDATOR_READS.days).all<{ day: string }>()).results ?? []).map((r) => r.day);
  } catch (e) {
    console.error('validators days', e);
    return empty(now, [], NOT_READ);
  }
  const day = asked ?? days[0] ?? null;
  if (day == null) return empty(now, days, NONE_YET);
  let sum: SumRow | null, rows: DayRow[];
  try {
    [sum, rows] = await Promise.all([
      db.prepare(VALIDATOR_READS.sum).bind(day).first<SumRow>(),
      db.prepare(VALIDATOR_READS.rows).bind(day, VALIDATORS_MAX).all<DayRow>().then((r) => r.results ?? []),
    ]);
  } catch (e) {
    console.error('validators day', e);
    return empty(now, days, NOT_READ);
  }
  if (!sum || !sum.n || sum.total == null || sum.staked == null || !rows.length) {
    // a day asked for that has no row is a request this route cannot answer; the newest day always has rows
    if (asked != null) throw new ApiInputError(400, `No listing of ${asked} is on record.`, 'The newest days on record are listed in `days` of this route\'s answer.');
    return empty(now, days, NONE_YET);
  }
  const total = sum.total;
  const validators = rows.map((r): ValidatorRow => ({
    validator: r.validator,
    name: nameOf(r.name),
    stake: r.stake,
    share: total > 0 ? r.stake / total : null,
    delegators: r.delegators,
    commission: commissionOf(r.commission),
    state: validatorStateOf(r.state),
    changeNam: r.prev_stake != null ? r.stake - r.prev_stake : null,
  }));
  const stakes = validators.map((v) => v.stake);
  const prov: Provenance = currentDay(day, now)
    ? { source: VALIDATORS_SOURCE, at: sum.as_of, height: sum.height, status: 'live' }
    : {
        source: VALIDATORS_SOURCE, at: sum.as_of, height: sum.height, status: 'stale',
        // the newest day on record says no newer listing exists; an older day asked for says newer ones do
        note: days[0] == null || day >= days[0] ? NO_NEWER : 'This is the listing of an earlier day; newer days are on record.',
      };
  // the indexer's list is read once a day; a list read long before the listing was made is said to be old
  const namesOld = sum.names_at != null && sum.as_of != null && sum.as_of - sum.names_at > NAMES_STALE_MS;
  const namesProv: Provenance = sum.names_at == null
    ? missing(VALIDATOR_NAMES_SOURCE, NO_NAMES)
    : prov.status === 'live' && !namesOld
      ? { source: VALIDATOR_NAMES_SOURCE, at: sum.names_at, status: 'live' }
      : { source: VALIDATOR_NAMES_SOURCE, at: sum.names_at, status: 'stale', note: namesOld ? 'The indexer\'s list was not read again before this listing was made.' : prov.note };
  return {
    asOf: now,
    day,
    days,
    validators,
    totalNam: total,
    count: sum.staked,
    third: spreadCount(stakes, total, 1, 3),
    twoThirds: spreadCount(stakes, total, 2, 3),
    prev: sum.prev ?? null,
    prov,
    namesProv,
  };
}

/** `days` of the history route: left out is VALIDATOR_HISTORY_DAYS; anything but a plain whole number from 1 to VALIDATOR_DAYS_MAX is refused. */
export function historyDays(raw: string | null | undefined): number {
  if (raw == null || raw === '') return VALIDATOR_HISTORY_DAYS;
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= VALIDATOR_DAYS_MAX)) throw new ApiInputError(400, `days must be a whole number from 1 to ${VALIDATOR_DAYS_MAX}.`);
  return n;
}

/**
 * GET /api/validators/history: one validator's newest `days` rows, oldest first. The address must be a whole Namada
 * address (util.ts chainOf, the check of the address report): anything else is refused (400) before it reaches a
 * statement. A validator with no row is not found (404). A failed read is thrown: the route answers it as a
 * failure, never as an empty history.
 */
export async function validatorHistoryAnswer(db: D1Database, now: number, validator: string | null | undefined, daysParam?: string | null): Promise<ValidatorHistoryResponse> {
  if (!validator) throw new ApiInputError(400, 'validator is required: a whole Namada address.');
  if (chainOf(validator) !== 'namada') throw new ApiInputError(400, 'validator must be a whole Namada address.');
  const limit = historyDays(daysParam);
  const rows = (await db.prepare(VALIDATOR_READS.history).bind(validator, limit).all<HistoryRow>()).results ?? [];
  if (!rows.length) throw new ApiInputError(404, 'No row is on record for that validator.');
  const newest = rows[0];
  const days = rows.map((r): ValidatorDay => ({ day: r.day, stake: r.stake, delegators: r.delegators, commission: commissionOf(r.commission), state: validatorStateOf(r.state) })).reverse();
  return {
    validator,
    // the newest name among the rows answered (rows are newest first here)
    name: rows.map((r) => nameOf(r.name)).find((n) => n != null) ?? null,
    days,
    prov: currentDay(newest.day, now)
      ? { source: VALIDATORS_SOURCE, at: newest.as_of, height: newest.height, status: 'live' }
      : { source: VALIDATORS_SOURCE, at: newest.as_of, height: newest.height, status: 'stale', note: 'No row of a newer day is on record for this validator.' },
  };
}

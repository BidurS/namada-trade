// The health log per name (scale plan, Stage 1 item 4): kv source.health.log kept the newest 200 entries of all, so on
// 2026-10-29 osmosis_index, flipping 124 times in 9.6 h, pushed every other source's entries out and the digest's
// operator embed lost them. A name now keeps its newest HEALTH_LOG_PER_NAME (20) entries, within the 48 h and the
// overall 200; what a cap lets go is counted on the name's oldest entry kept (cut, cutFrom), and the operator embed says
// how many of that source's older changes are not kept, beside the other sources' episodes, which are all there.
import { describe, expect, it } from 'vitest';
import { testD1 } from './d1-sqlite';
import { seedSurvey, T } from './digest-survey';
import { kvJson } from './digest-net';
import { appendHealthLog, keepHealthLog, HEALTH_LOG_KEEP_MS, HEALTH_LOG_MAX, HEALTH_LOG_PER_NAME, type HealthLogEntry } from '../worker/src/cron';
import { readAndBuildDigest } from '../worker/src/digest/build';
import { healthEpisodes } from '../worker/src/digest/operator';

const MIN = 60_000, H = 60 * MIN;
const FLAP = 'check:osmosis_index';
/** osmosis_index's day: 124 changes of state in 9.6 h, from `from`, the first a warn. */
const flaps = (from: number): HealthLogEntry[] => Array.from({ length: 124 }, (_, i) => ({ name: FLAP, at: from + Math.round(i * (9.6 * H) / 124), ok: i % 2 === 1, note: i % 2 ? 'ok' : 'warn' }));
const others = (from: number): HealthLogEntry[] => [
  { name: 'Namada RPC Papadritta', at: from + 10 * MIN, ok: false, note: 'no answer' },
  { name: 'Namada RPC Papadritta', at: from + 38 * MIN, ok: true, note: 'height 8,384,000' },
  { name: 'check:bonded_coverage', at: from + H, ok: false, note: 'warn' },
  { name: 'Keplr Osmosis REST (holders)', at: from + 2 * H, ok: false, note: 'upstream unavailable (HTTP 503)' },
  { name: 'Keplr Osmosis REST (holders)', at: from + 2 * H + 5 * MIN, ok: true, note: '' },
];

describe('the health log keeps each name\'s newest entries, so one flapping source cannot push the others out', () => {
  it('124 flips and five other entries: the flapper keeps its newest 20, its oldest kept says 104 were let go and from when; every other entry is kept', () => {
    const from = T - 12 * H;
    const kept = keepHealthLog([...flaps(from), ...others(from)], T);
    const flap = kept.filter((e) => e.name === FLAP);
    expect(flap).toHaveLength(HEALTH_LOG_PER_NAME);
    expect(flap[0]).toMatchObject({ cut: 124 - HEALTH_LOG_PER_NAME, cutFrom: from });
    expect(flap.slice(1).every((e) => e.cut === undefined)).toBe(true);
    expect(flap.map((e) => e.at)).toEqual(flaps(from).slice(-HEALTH_LOG_PER_NAME).map((e) => e.at));
    expect(kept.filter((e) => e.name !== FLAP)).toEqual(others(from));
    // oldest first, as the log always was
    expect(kept.map((e) => e.at)).toEqual([...kept.map((e) => e.at)].sort((a, b) => a - b));
  });

  it('appended one flip at a time, as the ticks append them, the log ends the same and the count adds up', async () => {
    const db = testD1();
    const from = T - 12 * H;
    for (const e of others(from)) await appendHealthLog(db as any, [e], T);
    for (const e of flaps(from)) await appendHealthLog(db as any, [e], T);
    const log = kvJson(db, 'source.health.log') as HealthLogEntry[];
    expect(log).toEqual(keepHealthLog([...flaps(from), ...others(from)], T));
    expect(log.filter((e) => e.name === FLAP)[0]).toMatchObject({ cut: 104, cutFrom: from });
  });

  it('within the overall 200: what the cap lets go of a name that keeps entries is counted on its oldest kept; every entry is kept or counted', () => {
    // 15 sources, 20 changes each, a minute apart in turn: 300 entries, 100 over the cap
    const all: HealthLogEntry[] = [];
    for (let k = 0; k < 20; k++) for (let s = 0; s < 15; s++) all.push({ name: `source ${s}`, at: T - 6 * H + (k * 15 + s) * MIN, ok: k % 2 === 1, note: '' });
    const kept = keepHealthLog(all, T);
    expect(kept).toHaveLength(HEALTH_LOG_MAX);
    expect(kept.length + kept.reduce((n, e) => n + (e.cut ?? 0), 0)).toBe(all.length);
    for (let s = 0; s < 15; s++) {
      const mine = kept.filter((e) => e.name === `source ${s}`);
      expect(mine[0].cutFrom).toBe(all.find((e) => e.name === `source ${s}`)!.at);
    }
  });

  it('an entry past 48 h goes with what it counted; the newest 200 under the cap are as before', () => {
    const old = { name: 'a', at: T - HEALTH_LOG_KEEP_MS - 1, ok: false, note: '', cut: 7, cutFrom: T - HEALTH_LOG_KEEP_MS - H };
    const kept = keepHealthLog([old, { name: 'a', at: T - H, ok: true, note: '' }], T);
    expect(kept).toEqual([{ name: 'a', at: T - H, ok: true, note: '' }]);
  });

  it('the operator embed names the other sources\' episodes in full and says how many of the flapper\'s older changes are not kept', { timeout: 60_000 }, async () => {
    const db = testD1();
    seedSurvey(db);
    const from = T - 12 * H;
    await appendHealthLog(db as any, [...flaps(from), ...others(from)], T);
    const b = await readAndBuildDigest(db as any, T, 'daily');
    const op = b.operatorPosts.flatMap((p) => p.payload.embeds).find((e) => e.title === 'Operator')!;
    expect(op.description).toContain('Namada RPC Papadritta: not ok 20:10–20:38 UTC (28 min)');
    expect(op.description).toContain('Not kept: check:osmosis_index: 104 older changes (20:00 UTC yesterday to ');
    expect(op.description).toContain("the health log keeps each source's newest 20 changes.");
    // the episodes of the kept entries are whole: the flapper's oldest kept is a warn, so its first episode opens there
    const log = kvJson(db, 'source.health.log') as HealthLogEntry[];
    const eps = healthEpisodes(log.filter((e) => e.name === FLAP).map((e) => ({ ...e, note: e.note })));
    expect(eps).toHaveLength(10);
  });
});

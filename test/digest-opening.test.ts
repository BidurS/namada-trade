// The digest's opening (shared/digest-opening.ts, worker/src/digest/opening.ts): what is checked before one is shown,
// what a period asks the model for and stores, and that a digest with none goes out exactly as it does today. The model
// is a fake throughout, and Discord is stubbed before anything could post: nothing leaves the test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { OPENING_MARK, checkOpening, openingPrompt, type OpeningFact } from '../shared/digest-opening';
import { digestOpeningMaker, openingFacts, openingFor, openingKey, openingMakerWith, OPENING_MONTH_CAP_USD, OPENING_SPEND_KEY, type OpeningDeps, type OpeningJob, type OpeningMaker, type OpeningReadFn, type OpeningWriteFn, type StoredOpening } from '../worker/src/digest/opening';
import { prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { readAndBuildDigest, postsFor, discordProblems } from '../worker/src/digest/build';
import { alertBudget, configureAlerts, resetClaimMemory } from '../worker/src/sources/discord';
import { kvGetJson, kvSet } from '../worker/src/db';
import { testD1, type TestD1 } from './d1-sqlite';
import { seedCharts, seedSurvey, T } from './digest-survey';
import { sent, stubDiscord } from './digest-net';

const FACTS: OpeningFact[] = [
  { label: 'Period', value: 'one day' },
  { label: 'Total stake', value: '41,812,345.67 NAM' },
  { label: 'Total stake, change over the period', value: '+0.17 %' },
  { label: 'NAM price', value: '$0.00412345' },
  { label: 'Trades on Osmosis', value: '137' },
];
const GOOD = 'Total stake stood at 41,812,345.67 NAM over the past day, up 0.17 %, with 137 trades on Osmosis.';
const JOB: OpeningJob = { key: 'alert:digest:daily:2026-10-23', state: 'new', facts: FACTS, now: T };
const KV = openingKey(JOB.key);
const db_ = () => testD1() as unknown as D1Database;
const write = (...answers: string[]): ReturnType<typeof vi.fn<OpeningWriteFn>> => {
  let i = 0;
  return vi.fn<OpeningWriteFn>(async () => ({ opening: answers[Math.min(i++, answers.length - 1)], inTokens: 400, outTokens: 100 }));
};
const reads = (...verdicts: boolean[]): ReturnType<typeof vi.fn<OpeningReadFn>> => {
  let i = 0;
  return vi.fn<OpeningReadFn>(async () => { const supported = verdicts[Math.min(i++, verdicts.length - 1)]; return { supported, problem: supported ? '' : 'it names the wrong figure', inTokens: 500, outTokens: 60 }; });
};
const deps = (w: OpeningWriteFn, r: OpeningReadFn, budgetMs?: number): OpeningDeps => ({ write: w, read: r, budgetMs });
const stored = (db: D1Database) => kvGetJson<StoredOpening>(db, KV);

describe('checkOpening', () => {
  it('passes figures copied from the facts, by value', () => {
    expect(checkOpening(GOOD, FACTS)).toEqual({ ok: true, text: GOOD });
    expect(checkOpening('Total stake reached 41812345.67 NAM over the past day.', FACTS).ok).toBe(true);
    expect(checkOpening('NAM was priced at $0.00412345 over the past day.', FACTS).ok).toBe(true);
  });
  it('refuses a number that is not a fact: rounded, or computed', () => {
    expect(checkOpening('Total stake was about 41.8 million NAM.', FACTS)).toEqual({ ok: false, reason: 'the number 41800000 is not among the figures' });
    expect(checkOpening('NAM was priced at $0.0041 over the past day.', FACTS).ok).toBe(false);
    expect(checkOpening('Trades rose 12 % over the past day, to 137.', FACTS)).toEqual({ ok: false, reason: 'the number 12 is not among the figures' });
  });
  it('reads the values only, so a number that appears only in a label is refused', () => {
    const facts = [...FACTS, { label: 'NAM traded in the last 24 hours', value: '5,000.00 NAM' }];
    expect(checkOpening('Over 24 hours, 5,000.00 NAM was traded.', facts)).toEqual({ ok: false, reason: 'the number 24 is not among the figures' });
  });
  it('refuses a number in words, and a multiple of one', () => {
    for (const s of ['Trades reached three times the usual.', 'Total stake nearly doubled.', 'About a hundred trades went through.']) {
      const r = checkOpening(s, FACTS);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason.startsWith('a number in words'), s).toBe(true);
    }
  });
  it('refuses advice, judgement, predictions, causes, expert words, links, mentions, addresses and formatting', () => {
    for (const [s, why] of [
      ['You should buy NAM now.', 'advice'],
      ['A safe day for NAM.', 'a judgement'],
      ['The price will rise.', 'a prediction'],
      ['Trades fell because the bridge slowed.', 'a prediction'],
      ['The MASP took in NAM.', 'an expert word'],
      ['Read more at https://example.com.', 'a link'],
      ['Thanks to @everyone for trading.', 'a link'],
      ['tnam1qxt7uxhj9r00mfm4u870e7ghz6j20jrdz58gm5kj moved NAM.', 'an address'],
      ['A **quiet** day for NAM.', 'a formatting'],
    ] as const) {
      const r = checkOpening(s, FACTS);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason.startsWith(why), s).toBe(true);
    }
  });
  it('refuses an opening past two sentences or 40 words, and an empty one', () => {
    expect(checkOpening('One thing. Another thing. A third thing.', FACTS)).toEqual({ ok: false, reason: 'more than 2 sentences' });
    expect(checkOpening(Array(41).fill('word').join(' '), FACTS)).toEqual({ ok: false, reason: 'longer than 40 words' });
    expect(checkOpening('  ', FACTS)).toEqual({ ok: false, reason: 'the model returned no opening' });
  });
  it('asks with the facts fenced and the refusal said on a retry', () => {
    expect(openingPrompt(FACTS)).toContain('Total stake: 41,812,345.67 NAM');
    expect(openingPrompt(FACTS, 'the number 12 is not among the figures')).toContain('A first opening was refused: the number 12 is not among the figures');
  });
});

describe('openingFor', () => {
  it('stores and answers an opening that passes both readings, and counts its usage', async () => {
    const db = db_(), w = write(GOOD), r = reads(true);
    expect(await openingFor(db, JOB, deps(w, r))).toBe(GOOD);
    expect(w).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(1);
    expect(await stored(db)).toMatchObject({ text: GOOD, status: 'ok', model: 'claude-haiku-5-5' });
    const spend = await kvGetJson<{ month: string; usd: number }>(db, OPENING_SPEND_KEY);
    expect(spend?.month).toBe('2026-10');
    expect(spend?.usd).toBeCloseTo((900 * 0.1 + 160 * 0.5) / 1e6, 10);
  });

  it('gives a refused number back to the model once, with the reason', async () => {
    const db = db_(), w = write('Trades rose 12 %.', GOOD), r = reads(true);
    expect(await openingFor(db, JOB, deps(w, r))).toBe(GOOD);
    expect(w).toHaveBeenCalledTimes(2);
    expect(w.mock.calls[1][1]).toBe('the number 12 is not among the figures');
    expect(r).toHaveBeenCalledTimes(1);
  });

  it('refused twice: no opening, the reason stored, no third call', async () => {
    const db = db_(), w = write('Trades rose 12 %.', 'Trades rose 13 %.'), r = reads(true);
    expect(await openingFor(db, JOB, deps(w, r))).toBeNull();
    expect(w).toHaveBeenCalledTimes(2);
    expect(r).not.toHaveBeenCalled();
    expect(await stored(db)).toMatchObject({ text: null, status: 'rejected', reason: 'the number 13 is not among the figures' });
  });

  it('a second reading that refuses is retried with its reason, and a second refusal leaves no opening', async () => {
    const db = db_(), w = write(GOOD), r = reads(false, true);
    expect(await openingFor(db, JOB, deps(w, r))).toBe(GOOD);
    expect(w.mock.calls[1][1]).toContain('the second reading did not find it in the figures: it names the wrong figure');
    expect(r).toHaveBeenCalledTimes(2);

    const db2 = db_();
    expect(await openingFor(db2, JOB, deps(write(GOOD), reads(false)))).toBeNull();
    expect(await kvGetJson<StoredOpening>(db2, KV)).toMatchObject({ text: null, status: 'rejected' });
  });

  it('an empty answer stands: no retry and no opening', async () => {
    const db = db_(), w = write('  '), r = reads(true);
    expect(await openingFor(db, JOB, deps(w, r))).toBeNull();
    expect(w).toHaveBeenCalledTimes(1);
    expect(await stored(db)).toMatchObject({ status: 'none' });
  });

  it('a call that fails leaves no opening, stores why, and counts what was used', async () => {
    const db = db_(), w = write(GOOD);
    const r = vi.fn<OpeningReadFn>(async () => { throw new Error('the model declined'); });
    expect(await openingFor(db, JOB, deps(w, r))).toBeNull();
    expect(await stored(db)).toMatchObject({ text: null, status: 'failed', reason: 'the model declined' });
    expect((await kvGetJson<{ usd: number }>(db, OPENING_SPEND_KEY))?.usd).toBeCloseTo((400 * 0.1 + 100 * 0.5) / 1e6, 10);
  });

  it('settles at its budget and aborts the call when the model does not answer', async () => {
    const db = db_();
    let aborted = false;
    const w: OpeningWriteFn = (_f, _r, signal) => new Promise((_res, rej) => { signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); });
    const t0 = Date.now();
    expect(await openingFor(db, JOB, deps(w, reads(true), 40))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    await vi.waitFor(async () => expect((await stored(db))?.status).toBe('failed'));
  });

  it('settles at its budget even when the database never answers', async () => {
    const hang = { prepare: () => ({ bind: () => ({ first: () => new Promise(() => {}), run: () => new Promise(() => {}) }) }) } as unknown as D1Database;
    expect(await openingFor(hang, JOB, deps(write(GOOD), reads(true), 40))).toBeNull();
  });

  it('a period already written makes no second call, and answers the same text', async () => {
    const db = db_();
    expect(await openingFor(db, JOB, deps(write(GOOD), reads(true)))).toBe(GOOD);
    const w = write('Other words.'), r = reads(true);
    expect(await openingFor(db, JOB, deps(w, r))).toBe(GOOD);
    expect(await openingFor(db, { ...JOB, state: 'open' }, deps(w, r))).toBe(GOOD);
    expect(w).not.toHaveBeenCalled();
    expect(r).not.toHaveBeenCalled();
  });

  it('a period whose first run wrote nothing stays without one: a later run makes no call', async () => {
    const db = db_();
    expect(await openingFor(db, JOB, deps(write('  '), reads(true)))).toBeNull();
    const w = write(GOOD);
    expect(await openingFor(db, JOB, deps(w, reads(true)))).toBeNull();
    expect(w).not.toHaveBeenCalled();
  });

  it('a period some channels already have, with no row, makes no call', async () => {
    const db = db_(), w = write(GOOD);
    expect(await openingFor(db, { ...JOB, state: 'open' }, deps(w, reads(true)))).toBeNull();
    expect(w).not.toHaveBeenCalled();
    expect(await stored(db)).toBeNull();
  });

  it('two runs at once make one set of calls', async () => {
    const db = db_(), w = write(GOOD), r = reads(true);
    const [a, b] = await Promise.all([openingFor(db, JOB, deps(w, r)), openingFor(db, JOB, deps(w, r))]);
    expect(w).toHaveBeenCalledTimes(1);
    expect([a, b].filter((x) => x === GOOD)).toHaveLength(1);
    expect([a, b]).toContain(null);
  });

  it('an opening that could not be stored is not shown', async () => {
    const db = db_(), real = (db as any).prepare.bind(db);
    const broken = { ...db, prepare: (sql: string) => { if (sql.startsWith('INSERT OR REPLACE')) throw new Error('write failed'); return real(sql); } } as unknown as D1Database;
    expect(await openingFor(broken, JOB, deps(write(GOOD), reads(true)))).toBeNull();
  });

  it('the month at its cap makes no call; a new month starts the count again', async () => {
    const db = db_(), w = write(GOOD);
    await kvSet(db, OPENING_SPEND_KEY, { month: '2026-10', usd: OPENING_MONTH_CAP_USD });
    expect(await openingFor(db, JOB, deps(w, reads(true)))).toBeNull();
    expect(w).not.toHaveBeenCalled();
    expect(await stored(db)).toBeNull();

    await kvSet(db, OPENING_SPEND_KEY, { month: '2026-09', usd: OPENING_MONTH_CAP_USD });
    expect(await openingFor(db, JOB, deps(w, reads(true)))).toBe(GOOD);
    expect((await kvGetJson<{ month: string; usd: number }>(db, OPENING_SPEND_KEY))?.month).toBe('2026-10');
    expect((await kvGetJson<{ month: string; usd: number }>(db, OPENING_SPEND_KEY))?.usd).toBeLessThan(0.01);
  });

  it('too few facts: no call', async () => {
    const db = db_(), w = write(GOOD);
    expect(await openingFor(db, { ...JOB, facts: FACTS.slice(0, 2) }, deps(w, reads(true)))).toBeNull();
    expect(w).not.toHaveBeenCalled();
  });
});

describe('the cron maker', () => {
  const env = (x: object) => ({ DB: db_(), ...x }) as any;
  it('is absent without ANTHROPIC_API_KEY or an operator channel', () => {
    expect(digestOpeningMaker(env({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }))).toBeUndefined();
    expect(digestOpeningMaker(env({ ANTHROPIC_API_KEY: 'test-only' }))).toBeUndefined();
    expect(typeof digestOpeningMaker(env({ ANTHROPIC_API_KEY: 'test-only', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }))).toBe('function');
  });
});

describe('the opening in the digest', () => {
  const KEY = base64.encode(new Uint8Array(32).fill(53));
  const OP = 'https://discord.com/api/webhooks/53/operator';
  const OPENING = 'Figures for the past day follow.';
  const seeded = (): TestD1 => { const db = testD1(); seedSurvey(db); seedCharts(db); return db; };
  const run = async (db: TestD1, maker?: OpeningMaker, sends = true) => {
    const r = await prepareDigests(db as any, T, sends, maker);
    await sendDigests(db as any, OP, r, alertBudget(T), []);
    return r;
  };
  beforeEach(() => { resetDigestMemory(); resetClaimMemory(); configureAlerts(KEY, true); stubDiscord(); vi.useFakeTimers({ now: T, toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('goes first in the shared embed, marked, and is the only change to the digest', { timeout: 120_000 }, async () => {
    const plainDb = seeded();
    await run(plainDb);
    const plain = sent.map((p) => p.json);
    expect(plain.length).toBeGreaterThan(0);

    resetDigestMemory(); resetClaimMemory(); stubDiscord();
    const db = seeded();
    await run(db, openingMakerWith(db as any, deps(write(OPENING), reads(true))));
    const opened = sent.map((p) => p.json);

    expect(opened[0].embeds[0].description).toBe(`${OPENING}\n*${OPENING_MARK}*\n\n${plain[0].embeds[0].description}`);
    opened[0].embeds[0].description = plain[0].embeds[0].description;
    expect(opened).toEqual(plain);
  });

  it('a digest whose window reaches into a time when alerts were paused goes out without the opening, and the model is not asked; one whose window is clear of it has the opening again', { timeout: 180_000 }, async () => {
    const plainDb = seeded();
    await run(plainDb);
    const plain = sent.map((p) => p.json);

    // the newest held run is two hours before this digest: inside its 24 hours
    resetDigestMemory(); resetClaimMemory(); stubDiscord();
    const db = seeded();
    await kvSet(db as any, 'digest.paused', { stretches: [{ from: T - 3 * 86_400_000, to: T - 2 * 3_600_000 }] });
    const held = write(OPENING);
    await run(db, openingMakerWith(db as any, deps(held, reads(true))));
    expect(held).not.toHaveBeenCalled();
    expect(sent[0].json.embeds[0].description).toBe(plain[0].embeds[0].description);
    expect(JSON.stringify(sent.map((p) => p.json))).not.toContain(OPENING_MARK);

    // the newest held run is 26 hours before: the daily's window is clear of it, and the opening is written
    resetDigestMemory(); resetClaimMemory(); stubDiscord();
    const clear = seeded();
    await kvSet(clear as any, 'digest.paused', { stretches: [{ from: T - 5 * 86_400_000, to: T - 26 * 3_600_000 }] });
    const asked = write(OPENING);
    await run(clear, openingMakerWith(clear as any, deps(asked, reads(true))));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(sent[0].json.embeds[0].description.startsWith(`${OPENING}\n*${OPENING_MARK}*`)).toBe(true);
  });

  it('the record of the pause could not be read: the digest goes out without the opening, on time', { timeout: 120_000 }, async () => {
    const db = seeded();
    const real = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql === 'SELECT value FROM kv WHERE key = ?') return { bind: () => ({ first: async () => { throw new Error('D1_ERROR: simulated'); } }) };
      return real(sql);
    };
    const w = write(OPENING);
    await run(db, openingMakerWith(db as any, deps(w, reads(true))));
    expect(w).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent.map((p) => p.json))).not.toContain(OPENING_MARK);
  });

  it('a model that fails leaves the digest exactly as it is today', { timeout: 120_000 }, async () => {
    const plainDb = seeded();
    await run(plainDb);
    const plain = sent.map((p) => p.json);

    resetDigestMemory(); resetClaimMemory(); stubDiscord();
    const db = seeded();
    const w = vi.fn<OpeningWriteFn>(async () => { throw new Error('no answer'); });
    await run(db, openingMakerWith(db as any, deps(w, reads(true))));
    expect(w).toHaveBeenCalledTimes(1);
    expect(sent.map((p) => p.json)).toEqual(plain);
  });

  it('a Worker that does not send (the pause) builds nothing and makes no call', async () => {
    const db = seeded(), maker = vi.fn<OpeningMaker>(async () => OPENING);
    const r = await run(db, maker, false);
    expect(r.jobs).toEqual([]);
    expect(maker).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('a period the channels already have makes no second call on a later run', { timeout: 120_000 }, async () => {
    const db = seeded(), w = write(OPENING), r = reads(true);
    const maker = openingMakerWith(db as any, deps(w, r));
    await run(db, maker);
    expect(w).toHaveBeenCalledTimes(1);
    resetDigestMemory();
    await run(db, maker);
    expect(w).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(1);
  });

  it('the weekly goes through the same path, once a period each', { timeout: 120_000 }, async () => {
    const db = seeded(), maker = vi.fn<OpeningMaker>(async () => null);
    const monday = T + 3 * 86_400_000;
    vi.setSystemTime(monday);
    const r = await prepareDigests(db as any, monday, true, maker);
    expect(r.jobs.map((j) => j.kind)).toEqual(['daily', 'weekly']);
    await Promise.all(r.jobs.map((j) => j.opening));
    expect(maker.mock.calls.map(([b]) => b.kind)).toEqual(['daily', 'weekly']);
  });

  it('the facts are the digest\'s printed figures: values only, in the digest\'s own format, labels with no digit', { timeout: 120_000 }, async () => {
    const b = await readAndBuildDigest(seeded() as any, T, 'daily');
    const facts = openingFacts(b.messageFigures);
    expect(facts[0]).toEqual({ label: 'Period', value: 'one day' });
    expect(facts.length).toBeGreaterThan(3);
    for (const f of facts) expect(f.label).not.toMatch(/\d/);
    const text = JSON.stringify(b.operatorPosts.map((p) => p.payload));
    for (const f of facts.slice(1)) if (!f.value.startsWith('+') && !f.value.startsWith('−')) expect(text, f.label).toContain(f.value);
  });

  it('an opening with no room for it is left out and the recipient\'s digest is what it was', { timeout: 120_000 }, async () => {
    const b = await readAndBuildDigest(seeded() as any, T, 'daily');
    const plain = postsFor(b.parts, null);
    const huge = 'word '.repeat(2_000).trim();
    expect(postsFor(b.parts, null, huge)).toEqual(plain);
    expect(plain.every((p) => discordProblems(p).length === 0)).toBe(true);
    const opened = postsFor(b.parts, null, OPENING);
    expect(opened[0].payload.embeds[0].description?.startsWith(OPENING)).toBe(true);
  });
});

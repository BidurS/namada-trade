// Daily digest (2026-10-23), its posts and the rows it needs: a post with pictures goes as one multipart request
// (payload_json and files[n] in the attachments' order), counted as one post, its answer's body read or cancelled as
// every other; when Discord refuses the files (Invalid Form Body, or a request too large) the same words go once more
// as text only with a plain note, so the digest is not lost; a channel's second message goes only after its first
// was taken, and one not taken is on record. The store additions: the health log mergeHealth and the checks write on
// a flip (and only then), which the operator embed reads; the ten largest holders' NAM as a series, so the Holders
// line gives the share a day before; the holder union's NAM per daily snapshot; and the operator's alert count, which
// counts a forum or governance alert once whatever its claims and a digest by its period's key alone.
// fetch is stubbed before anything could post; the addresses are fixture-shaped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { seedCharts, seedSurvey, T, A24 } from './digest-survey';
import { kvJson, sent, stubDiscord, textOf, tick } from './digest-net';
import {
  alertBudget, configureAlerts, flushAlerts, resetClaimMemory, sendDiscordDigest, textOnly, FILES_REFUSED_NOTE,
  type DigestDelivery, type WebhookPost,
} from '../worker/src/sources/discord';
import { prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { readAndBuildDigest } from '../worker/src/digest/build';
import { readOperatorFigures } from '../worker/src/digest/operator';
import { appendHealthLog, checkFlips, HEALTH_LOG_KEEP_MS, HEALTH_LOG_MAX } from '../worker/src/cron';
import { stmt } from '../worker/src/db';
import { top10History, TOP10_HISTORY_KEYS, HOLDER_FIGURES_VERSION } from '../worker/src/holders';
import { unionStmts } from '../worker/src/series';

const KEY = base64.encode(new Uint8Array(32).fill(47));
const OP = 'https://discord.com/api/webhooks/47/operator';
const MIN = 60_000, H = 60 * MIN;
const KEY_D = 'alert:digest:daily:2026-10-23';

const png = (name: string, n: number) => ({ name, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, n]), type: 'image/png' });
/** A digest's two messages as build.ts lays them out: the first with its pictures and a gallery embed, the second with the attention picture. */
const first: WebhookPost = {
  body: {
    username: 'NamadaTrade',
    embeds: [
      { title: 'NAM daily digest · Fri 23 Oct 2026, 08:00 UTC', description: 'Total stake 267,774,764.27 NAM ¹.', fields: [{ name: 'Price', value: '$0.00087359 ⁶', inline: true }], image: { url: 'attachment://price-7d.png' } },
      { url: 'https://namada.trade/', image: { url: 'attachment://stake-30d.png' } },
    ],
    attachments: [{ id: 0, filename: 'price-7d.png', description: 'Price, 7 days' }, { id: 1, filename: 'stake-30d.png', description: 'Staked NAM, 30 days' }],
  },
  files: [png('price-7d.png', 1), png('stake-30d.png', 2)],
};
const second: WebhookPost = {
  body: { username: 'NamadaTrade', embeds: [{ title: 'Trades worth attention · 24 h to 08:00 UTC, 23 Oct 2026', description: '1 trade by 1 address.', image: { url: 'attachment://attention.png' } }], attachments: [{ id: 0, filename: 'attention.png', description: 'Trades' }] },
  files: [png('attention.png', 3)],
};
const delivery = (posts: WebhookPost[] = [first, second]): DigestDelivery => ({
  key: KEY_D, what: 'digest 2026-10-23', maxPosts: 2, operator: () => posts, subscribers: async () => ({ postsOf: () => posts, capped: 0 }),
});
const formRefused = () => new Response('{"code":50035,"message":"Invalid Form Body","errors":{"attachments":{}}}', { status: 400, headers: { 'content-type': 'application/json' } });

beforeEach(() => { resetDigestMemory(); resetClaimMemory(); configureAlerts(KEY, true); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a post with pictures', () => {
  it('is one multipart request: payload_json with the attachments, files[n] in their order; the second message only after the first was taken', async () => {
    stubDiscord();
    const db = testD1();
    const r = await sendDiscordDigest(OP, delivery(), db as any, alertBudget());
    expect(r).toMatchObject({ state: 'sent', channels: 1, reached: 1, left: 0, first: true });
    expect(sent).toHaveLength(2);
    expect(sent.map((p) => p.form)).toEqual([true, true]);
    expect(sent[0].json.attachments.map((a: any) => a.filename)).toEqual(['price-7d.png', 'stake-30d.png']);
    expect(sent[0].files).toEqual([
      { field: 'files[0]', name: 'price-7d.png', type: 'image/png', size: 9 },
      { field: 'files[1]', name: 'stake-30d.png', type: 'image/png', size: 9 },
    ]);
    expect(sent[0].json.allowed_mentions).toEqual({ parse: [] });
    expect(sent[1].json.embeds[0].title).toMatch(/^Trades worth attention/);
    expect(sent[1].files.map((f) => f.name)).toEqual(['attention.png']);
  });

  it('every answer\'s body is read or cancelled, a success\'s and a refusal\'s alike', async () => {
    const bodies: { read: boolean; cancelled: boolean }[] = [];
    const answer = (status: number, text: string) => {
      const b = { read: false, cancelled: false };
      bodies.push(b);
      let given = false;
      return new Response(new ReadableStream({
        pull(c) { if (!given) { given = true; c.enqueue(new TextEncoder().encode(text)); } else { b.read = true; c.close(); } },
        cancel() { b.cancelled = true; },
      }), { status, headers: { 'content-type': 'application/json' } });
    };
    // the first message's form refused, its text-only post taken, the second message's form taken
    stubDiscord((p) => (p.form && p.json.embeds[0].title?.startsWith('NAM daily') ? answer(400, '{"code":50035,"message":"Invalid Form Body"}') : answer(200, '{"id":"1"}')));
    const db = testD1();
    await sendDiscordDigest(OP, delivery(), db as any, alertBudget());
    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(b.read || b.cancelled).toBe(true);
  });
});

describe('files Discord refuses', () => {
  it('Invalid Form Body: the same words go once more as text only, with the note, and the channel has its digest', async () => {
    stubDiscord((p) => (p.form ? formRefused() : new Response(null, { status: 204 })));
    const db = testD1();
    const budget = alertBudget();
    const r = await sendDiscordDigest(OP, delivery(), db as any, budget);
    expect(r).toMatchObject({ state: 'sent', reached: 1 });
    expect(sent.map((p) => p.form)).toEqual([true, false, true, false]);
    const text = sent[1].json;
    expect(text.attachments).toBeUndefined();
    expect(text.embeds).toEqual([
      { title: 'NAM daily digest · Fri 23 Oct 2026, 08:00 UTC', description: 'Total stake 267,774,764.27 NAM ¹.', fields: [{ name: 'Price', value: '$0.00087359 ⁶', inline: true }] },
      { description: FILES_REFUSED_NOTE },
    ]);
    expect(sent[3].json.embeds.at(-1).description).toBe(FILES_REFUSED_NOTE);
    // four requests, each counted as a post
    expect(budget.posts).toBe(600 - 4);
    await flushAlerts(db as any, budget);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });

  it('a request too large (413) falls back the same way', async () => {
    stubDiscord((p) => (p.form ? new Response('too large', { status: 413 }) : new Response(null, { status: 204 })));
    const r = await sendDiscordDigest(OP, delivery([first]), testD1() as any, alertBudget());
    expect(r).toMatchObject({ state: 'sent', reached: 1 });
    expect(sent.map((p) => p.form)).toEqual([true, false]);
    expect(textOf(sent[1])).not.toContain('attachment://');
  });

  it('a second message Discord does not take is on record; the first one counts the channel as reached', async () => {
    stubDiscord((p) => (p.json.embeds[0].title?.startsWith('Trades') ? new Response('{"code":50035}', { status: 400 }) : new Response(null, { status: 204 })));
    const db = testD1();
    const budget = alertBudget();
    const r = await sendDiscordDigest(OP, delivery([first, { body: second.body }]), db as any, budget);
    expect(r).toMatchObject({ state: 'sent', reached: 1 });
    await flushAlerts(db as any, budget);
    expect(kvJson(db, 'alerts.skipped')).toMatchObject({ last: { what: 'digest 2026-10-23 (1 second message(s) not taken after the first was)', n: 1 } });
  });

  it('textOnly keeps every word, drops the pictures, an embed that held a picture alone, and the attachments list', () => {
    const t = textOnly(first.body) as any;
    expect(t.attachments).toBeUndefined();
    expect(JSON.stringify(t)).not.toContain('attachment://');
    expect(t.embeds).toHaveLength(2);
    expect(t.embeds[0].fields).toEqual((first.body.embeds as any[])[0].fields);
    expect(t.username).toBe('NamadaTrade');
  });

  it('the real digest with its pictures refused still reaches the operator with every figure', { timeout: 60_000 }, async () => {
    stubDiscord((p) => (p.form ? formRefused() : new Response(null, { status: 204 })));
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    vi.useFakeTimers({ now: T, toFake: ['Date'] });
    const health: any[] = [];
    await sendDigests(db as any, OP, await prepareDigests(db as any, T, true), alertBudget(), health);
    const refused = sent.find((p) => p.form)!, kept = sent.find((p) => !p.form)!;
    expect(kept.json.embeds[0].fields).toEqual(refused.json.embeds[0].fields);
    expect(kept.json.embeds.at(-1).description).toBe(FILES_REFUSED_NOTE);
    expect(health.at(-1)).toMatchObject({ ok: true, note: 'Digest 2026-10-23 sent 23 Oct 08:00 UTC to 1 of 1 channel.' });
  });
});

describe('the health log', () => {
  it('a row whose ok flips is appended by the tick\'s health merge, once; a row seen for the first time or unchanged is not', { timeout: 120_000 }, async () => {
    stubDiscord();
    const db = testD1();
    insert(db, 'kv', [{ key: 'source.health', value: JSON.stringify({ 'Namada forum (latest posts)': { name: 'Namada forum (latest posts)', ok: true, at: T - 2 * H, note: '30 latest posts read' } }), updated_at: T - 2 * H }]);
    const env = { DB: db, SETTINGS_KEY: KEY } as any;
    configureAlerts(KEY, false);
    await tick(env, T - H);
    const log = kvJson(db, 'source.health.log') as any[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ name: 'Namada forum (latest posts)', ok: false });
    expect(log[0].at).toBeGreaterThanOrEqual(T - H);
    await tick(env, T - H + MIN);
    expect(kvJson(db, 'source.health.log')).toHaveLength(1);
  });

  it('keeps 48 h and the newest 200; a log that cannot be read is started again', async () => {
    const db = testD1();
    const old = { name: 'a', at: T - HEALTH_LOG_KEEP_MS - 1, ok: false, note: '' };
    await appendHealthLog(db as any, [old, ...Array.from({ length: 250 }, (_, i) => ({ name: `s${i}`, at: T - 1000 + i, ok: i % 2 === 0, note: '' }))], T);
    const log = kvJson(db, 'source.health.log') as any[];
    expect(log).toHaveLength(HEALTH_LOG_MAX);
    expect(log[0].name).toBe('s50');
    expect(log.at(-1).name).toBe('s249');
    db.raw.prepare("UPDATE kv SET value = 'not json' WHERE key = 'source.health.log'").run();
    await appendHealthLog(db as any, [{ name: 'b', at: T, ok: true, note: '' }], T);
    expect(kvJson(db, 'source.health.log')).toEqual([{ name: 'b', at: T, ok: true, note: '' }]);
  });

  it('a check\'s status change is an entry (idle is no fault); a check seen for the first time is not', async () => {
    const db = testD1();
    insert(db, 'checks', [
      { key: 'rpc_consensus', status: 'ok', title: 't', detail: '{}', checked_at: T - MIN },
      { key: 'price_vs_execution', status: 'warn', title: 't', detail: '{}', checked_at: T - MIN },
      { key: 'bridge_records_paired', status: 'ok', title: 't', detail: '{}', checked_at: T - MIN },
    ]);
    const flips = await checkFlips(db as any, [
      stmt.check('rpc_consensus', 'fail', 't', {}, T),
      stmt.check('price_vs_execution', 'idle', 't', {}, T),
      stmt.check('bridge_records_paired', 'ok', 't', {}, T),
      stmt.check('a_new_check', 'fail', 't', {}, T),
      stmt.metric(T, 'price.usd', 1),
    ], T);
    expect(flips).toEqual([
      { name: 'check:rpc_consensus', at: T, ok: false, note: 'fail' },
      { name: 'check:price_vs_execution', at: T, ok: true, note: 'idle' },
    ]);
  });

  it('the operator embed names a source down and up again during the day and a check that went to warn', { timeout: 60_000 }, async () => {
    const db = testD1();
    seedSurvey(db);
    await appendHealthLog(db as any, [
      { name: 'Namada RPC Papadritta', at: T - 4 * H - 48 * MIN, ok: false, note: 'no answer' },
      { name: 'Namada RPC Papadritta', at: T - 4 * H - 20 * MIN, ok: true, note: 'height 8,384,000' },
      { name: 'check:bonded_coverage', at: T - 4 * H, ok: false, note: 'warn' },
    ], T);
    db.raw.prepare("UPDATE checks SET status = 'warn', checked_at = ? WHERE key = 'bonded_coverage'").run(T - MIN);
    const b = await readAndBuildDigest(db as any, T, 'daily');
    const op = b.operatorPosts.flatMap((p) => p.payload.embeds).find((e) => e.title === 'Operator')!;
    expect(op.description).toContain('Namada RPC Papadritta: not ok 03:12–03:40 UTC (28 min)');
    expect(op.description).toContain('bonded_coverage warn since 04:00 UTC');
  });

  it('a day with every source down keeps the operator embed within its share and still says the digest\'s own delivery', async () => {
    const db = testD1();
    seedSurvey(db);
    const health = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Source ${i}`, { name: `Source ${i}`, ok: false, at: T - H, note: `Error: HTTP 503 for https://example.invalid/${'x'.repeat(150)}` }]));
    db.raw.prepare("UPDATE kv SET value = ? WHERE key = 'source.health'").run(JSON.stringify(health));
    const b = await readAndBuildDigest(db as any, T, 'daily');
    const op = b.operatorPosts.flatMap((p) => p.payload.embeds).find((e) => e.title === 'Operator')!;
    expect(op.description!.length).toBeLessThanOrEqual(1_200);
    expect(op.description).toContain('and 24 more (the Sources sheet lists them)');
    expect(op.description).toContain('This digest: the operator channel only (0 subscribers).');
  });
});

describe('the ten largest holders as a series, and the holder union', () => {
  it('each recomputed part writes its sum at its own time; the Holders line then gives the share a day before', { timeout: 60_000 }, async () => {
    const db = testD1();
    seedSurvey(db);
    const atBase = A24 - 20 * MIN;
    const stmts = top10History(db as any, { namada: { top10: { s: 274_000_000, at: atBase } } as any, osmosis: { top10: { s: null, at: null } } as any });
    expect(stmts).toHaveLength(1);
    await db.batch(stmts as any);
    expect(db.raw.prepare('SELECT ts, key, value FROM metrics WHERE key = ?').all(TOP10_HISTORY_KEYS.namada)).toEqual([{ ts: atBase, key: 'holders.namada.top10_nam', value: 274_000_000 }]);
    const now = { s: 274_832_001.62, at: T - 8 * MIN, rowsAt: null };
    db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('holders.figures', JSON.stringify({ v: HOLDER_FIGURES_VERSION, namada: { at: T - 8 * MIN, holders: 1, under1: 0, byCategory: {}, none: 0, rowsAt: null, top10: now, listed: {} }, osmosis: null }), T - 8 * MIN);
    const b = await readAndBuildDigest(db as any, T, 'daily');
    const holders = b.body.shared.fields!.find((f) => f.name === 'Holders')!.value;
    // 274,000,000 of the 1,147,836,762.29 NAM minted at the base instant
    expect(holders).toContain('the 10 largest hold 274,832,001.62 NAM = 23.94 % of minted NAM (23.87 % yesterday)');
  });

  it('the holder union\'s NAM is one row per daily snapshot, the sum of its size lines', () => {
    expect(unionStmts([{ bucket: '1-10', holders: 3, nam: 12.5, spendable: 0, staked: 0 }, { bucket: '10-100', holders: 2, nam: 150, spendable: 0, staked: 0 }, { bucket: 'x', holders: 0, nam: 99, spendable: 0, staked: 0 }], 1234))
      .toEqual([stmt.metric(1234, 'holders.namada.union_nam', 162.5)]);
    expect(unionStmts([], 1234)).toEqual([]);
  });
});

describe('the operator\'s count of the alerts posted', () => {
  it('a forum or governance alert counts once whatever its claims; a digest counts by its period\'s key, never by its channels', async () => {
    const db = testD1();
    const at = T - H;
    insert(db, 'kv', [
      'alert:gov:prop:44:passed', 'alert:gov:prop:44:passed:op', 'alert:gov:prop:45:voting:op', 'alert:forum:post:9:op', 'alert:forum:post:9',
      KEY_D.replace('2026-10-23', '2026-10-22'), `${KEY_D.replace('2026-10-23', '2026-10-22')}:op`, `${KEY_D.replace('2026-10-23', '2026-10-22')}:${'a'.repeat(32)}`, `${KEY_D.replace('2026-10-23', '2026-10-22')}:${'b'.repeat(32)}`,
    ].map((key) => ({ key, value: '1', updated_at: at })));
    const o = await readOperatorFigures(db as any, T, 'daily');
    expect(o.alerts).toMatchObject({ value: { claimed: { governance: 2, forum: 1, digests: 1, n: 4 } } });
  });
});

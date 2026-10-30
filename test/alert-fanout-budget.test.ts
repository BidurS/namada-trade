// Security review (2026-10-22), alert fan-out budget: every saved settings row with forumAndGov on (sign-ins are
// free, and each row needs one wallet signature) added one webhook post to every forum and governance alert, and the
// cron awaited the alerts of a tick one after another with no bound across them. 500 rows made two alerts 1,002 posts,
// twenty alerts 10,020 (the Workers Paid default of subrequests per invocation is 10,000, D1 calls included), and five
// alerts at 150 ms a post kept the tick running 63 s, past the next tick, which the lock then skipped. Now the forum
// and governance alerts of one run share a budget (sources/discord.ts alertBudget: RUN_ALERT_POSTS posts, alerts
// starting within RUN_ALERT_WINDOW_MS): the first alert of a run always starts, a later one only when all its posts
// fit, and one that does not fit waits for the next run without its claim taken, the forum cursor and the stored
// proposal states stopping before it and the forum's Sources row saying so. Proposals go before forum posts, so a run
// of forum posts never keeps them waiting. The operator's channel is posted first, and the subscribers from a place
// that differs per alert, so a deadline cut never falls on the same channels every time. Every webhook answer's body
// is let go (read or cancelled), not left for the garbage collector. Fetch is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { base64 } from '@scure/base';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import {
  configureAlerts, sendDiscordForumAlert, sendDiscordGovAlert, sendDiscordTestAlert, alertBudget, flushAlerts, resetClaimMemory,
  RUN_ALERT_POSTS, RUN_ALERT_WINDOW_MS, RUN_ALERT_DEADLINE_MS, LIVE_ALERT_POSTS, FANOUT_DEADLINE_MS, WEBHOOK_TIMEOUT_MS, windowFor, type AlertBudget,
} from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, DELIVERABLE_MAX, type StoredSettings } from '../worker/src/settings';
import { runCron, FORUM_POSTS_HEALTH, TICK_LOCK_MS } from '../worker/src/cron';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import type { ForumPost, GovernanceProposal } from '../shared/types';
import { digestKey } from '../worker/src/digest/message';
import { publicHour } from '../worker/src/public-posts';
import { readTo } from './hour-cover';
import { NAMADA } from '../worker/src/config';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOW = Date.now();
const KEY = base64.encode(new Uint8Array(32).fill(3));
const OP = 'https://discord.com/api/webhooks/9/operator';
const hook = (tag: string, i: number) => `https://discord.com/api/webhooks/${i}/${tag}`;
const subscriber = (tag: string, i: number): StoredSettings => {
  const s: StoredSettings = { address: `tnam1q${tag}${String(i).padStart(4, '0')}${'q'.repeat(30)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: hook(tag, i) } }, createdAt: NOW, updatedAt: NOW - i };
  s.notifications.forumAndGov = true;
  return s;
};
async function subscribers(db: TestD1, tag: string, n: number) {
  configureAlerts(KEY);
  for (let i = 1; i <= n; i++) await saveSettings(db as any, KEY, subscriber(tag, i));
}
const post = (id: number): ForumPost => ({ id, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: `https://forum.namada.net/t/t/1/${id}`, username: 'u', displayName: null, avatarUrl: null, createdAt: new Date(NOW).toISOString(), excerpt: 'e', isNewTopic: false });
const proposal = (id: number, status: string): GovernanceProposal => ({ id, title: 'p', authors: null, abstract: null, type: 'default', status, startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: null } as GovernanceProposal);
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
/** Every webhook post, in order; Discord answers 204 with no body. */
function discord() {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
  return posts;
}

describe('the forum and governance alerts of one run share a post budget', () => {
  it('covers one whole alert, and ends the run before the next tick', () => {
    expect(RUN_ALERT_POSTS).toBeGreaterThanOrEqual(DELIVERABLE_MAX + 1);
    expect(LIVE_ALERT_POSTS).toBeGreaterThanOrEqual(DELIVERABLE_MAX + 1);
    expect(RUN_ALERT_WINDOW_MS + FANOUT_DEADLINE_MS + WEBHOOK_TIMEOUT_MS).toBeLessThan(60_000);
    expect(RUN_ALERT_WINDOW_MS + FANOUT_DEADLINE_MS + WEBHOOK_TIMEOUT_MS).toBeLessThan(TICK_LOCK_MS);
    // An alert's window grows with its subscribers, but no subscriber post of a run starts past its deadline, and one
    // window is long enough for every channel the cap admits.
    expect(RUN_ALERT_DEADLINE_MS + WEBHOOK_TIMEOUT_MS).toBeLessThan(60_000);
    expect(windowFor(DELIVERABLE_MAX)).toBeLessThan(RUN_ALERT_DEADLINE_MS);
  });

  it('with 500 subscribers the first alert posts 501 times; the second\'s operator post goes at once, its subscribers wait unclaimed and the next run sends them', async () => {
    const db = testD1();
    await subscribers(db, 'fb', 500);
    const posts = discord();
    const run = alertBudget();
    expect(await sendDiscordForumAlert(OP, post(880001), db as any, run)).toBe('done');
    expect(posts).toHaveLength(501);
    expect(posts[0]).toBe(OP);
    expect(new Set(posts).size).toBe(501);
    expect(await sendDiscordForumAlert(OP, post(880002), db as any, run)).toBe('waiting');
    expect(await sendDiscordGovAlert(OP, proposal(880003, 'voting'), true, db as any, run)).toBe('waiting');
    // The operator hears both at once, under a claim of its own; their subscribers wait, unclaimed.
    expect(posts).toHaveLength(503);
    expect(posts.slice(501)).toEqual([OP, OP]);
    expect(run).toMatchObject({ posts: RUN_ALERT_POSTS - 503, waiting: 2 });
    expect(kv(db, 'alert:forum:post:880002')).toBeNull();
    expect(kv(db, 'alert:forum:post:880002:op')).toBe('1');
    expect(kv(db, 'alert:gov:prop:880003:voting')).toBeNull();
    expect(kv(db, 'alert:gov:prop:880003:voting:op')).toBe('1');
    expect(kv(db, 'alerts.skipped')).toBeNull();
    const next = alertBudget();
    expect(await sendDiscordForumAlert(OP, post(880002), db as any, next)).toBe('done');
    // The next run posts its subscribers only: the operator has heard it.
    expect(posts).toHaveLength(1003);
    expect(posts.slice(503)).not.toContain(OP);
    expect(kv(db, 'alert:forum:post:880002')).toBe('1');
  });

  it('a later alert\'s subscribers start when all their posts fit in what is left, and not once the window has closed', async () => {
    const db = testD1();
    await subscribers(db, 'fw', 10);
    const posts = discord();
    const run: AlertBudget = { posts: 25, until: Date.now() + 60_000, started: false, waiting: 0 };
    expect(await sendDiscordForumAlert(OP, post(880101), db as any, run)).toBe('done');
    expect(await sendDiscordForumAlert(OP, post(880102), db as any, run)).toBe('done');
    // 22 posts so far; the third alert's operator post leaves 2, too few for its 10 subscribers
    expect(await sendDiscordForumAlert(OP, post(880103), db as any, run)).toBe('waiting');
    expect(posts).toHaveLength(23);
    expect(posts[22]).toBe(OP);
    const late: AlertBudget = { posts: RUN_ALERT_POSTS, until: Date.now() - 1, started: true, waiting: 0 };
    expect(await sendDiscordForumAlert(OP, post(880104), db as any, late)).toBe('waiting');
    expect(posts).toHaveLength(24);
    expect(posts[23]).toBe(OP);
  });

  it('a first alert larger than the budget posts the operator first, stops at the budget and records the rest', async () => {
    const db = testD1();
    await subscribers(db, 'fc', 30);
    const posts = discord();
    const run: AlertBudget = { posts: 10, until: Date.now() + 60_000, started: false, waiting: 0 };
    expect(await sendDiscordForumAlert(OP, post(880201), db as any, run)).toBe('done');
    expect(posts).toHaveLength(10);
    expect(posts[0]).toBe(OP);
    expect(run.posts).toBe(0);
    // The run's records are written once, when it ends.
    expect(kv(db, 'alerts.skipped')).toBeNull();
    await flushAlerts(db as any, run);
    expect(JSON.parse(kv(db, 'alerts.skipped')!)).toMatchObject({ total: 21, last: { what: "forum post 880201 (21 past the run's post budget)", n: 21 } });
  });

  it('each alert reaches every subscriber once, starting from a place that differs from alert to alert', async () => {
    const db = testD1();
    await subscribers(db, 'fo', 40);
    const posts = discord();
    const firsts = new Set<string>();
    for (let id = 880301; id <= 880306; id++) {
      const from = posts.length;
      await sendDiscordForumAlert(OP, post(id), db as any);
      const these = posts.slice(from);
      expect(these[0]).toBe(OP);
      expect(new Set(these).size).toBe(41);
      firsts.add(these[1]);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe('one budget for each dispatch, which never cuts the operator\'s channel', () => {
  it('nothing left of the run\'s count: the operator is posted, the subscribers are cut and recorded', async () => {
    const db = testD1();
    await subscribers(db, 'fm', 5);
    const posts = discord();
    const spent: AlertBudget = { posts: 0, until: Date.now() + 60_000, started: false, waiting: 0 };
    expect(await sendDiscordForumAlert(OP, post(880501), db as any, spent)).toBe('done');
    expect(posts).toEqual([OP]);
    await flushAlerts(db as any, spent);
    expect(JSON.parse(kv(db, 'alerts.skipped')!)).toMatchObject({ last: { what: "forum post 880501 (5 past the run's post budget)", n: 5 } });
  });

  it('an alert a run admits has a fan-out window of its own, whatever an earlier alert of the run used of its own', async () => {
    const db = testD1();
    await subscribers(db, 'fn', 5);
    const posts = discord();
    const run = alertBudget();
    run.started = true;
    run.opened = Date.now() - FANOUT_DEADLINE_MS - 1000;
    expect(await sendDiscordForumAlert(OP, post(880502), db as any, run)).toBe('done');
    expect(posts).toHaveLength(6);
    expect(run.posts).toBe(RUN_ALERT_POSTS - 6);
    expect(kv(db, 'alerts.skipped')).toBeNull();
  });
});

// ---------------------------------------------------------------- the cron tick

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** The chain answers of test/cron-hang.test.ts, the forum's latest posts above `base`, proposal `prop` in voting, Discord 204. */
function network(base: number, n: number, prop: number) {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://discord.com/')) { posts.push(url); return new Response(null, { status: 204 }); }
    if (url.endsWith('/posts.json')) return json({ latest_posts: Array.from({ length: n }, (_, i) => ({ id: base + n - i, username: 'u', name: null, created_at: '2026-10-17T22:40:00Z', cooked: '<p>x</p>', raw: 'x', post_number: 2, topic_id: 7000, topic_slug: 'gov', topic_title: 'Governance' })) });
    if (url.endsWith('/latest.json')) return json({ topic_list: { topics: [] } });
    if (url.includes('/gov/proposal')) return json({ results: [{ id: prop, content: JSON.stringify({ title: 'Raise the cap' }), type: 'default', status: 'voting' }] });
    if (url.includes('/status')) return json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) return json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
        : path.includes('delegations_at') ? null
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return json({ result: { response: { code: 0, value, height: '8343400' } } });
    }
    if (url.includes('denom_owners')) return json({ denom_owners: [], pagination: { next_key: null, total: '0' } });
    if (url.includes('supply/by_denom')) return json({ amount: { denom: 'x', amount: '10000000' } });
    return new Response('not here', { status: 404 });
  }));
  return posts;
}
async function seededTick(tag: string, users: number, base: number, prop: number) {
  const db = testD1();
  insert(db, 'holders', Array.from({ length: 5 }, (_, i) => ({ chain: 'namada', address: `tnam1qholder${i}`, balance: '1', balance_num: 0.000001, updated_height: 1, updated_at: NOW - 86400000, verified_at: NOW - 86400000, verified_src: BALANCE_LISTING_SRC })));
  await subscribers(db, tag, users);
  insert(db, 'kv', [
    { key: 'forum.last_post_id', value: String(base), updated_at: NOW - 60000 },
    { key: 'gov.state', value: JSON.stringify({ [prop]: 'pending' }), updated_at: NOW - 60000 },
    // this tick is about forum and governance alerts: the day's (and a Monday's week's) digest counts as sent, so a
    // run after 08:00 UTC posts no digest beside them
    ...(['daily', 'weekly'] as const).flatMap((k) => [digestKey(NOW, k), `${digestKey(NOW, k)}:op`]).map((key) => ({ key, value: '1', updated_at: NOW - 60000 })),
  ]);
  return { db, env: { DB: db, KEPLR_KEY: 'k', SETTINGS_KEY: KEY, DISCORD_WEBHOOK_URL: OP, SEND_ALERTS: 'yes' } as any };
}
const forumRow = (db: TestD1) => JSON.parse(kv(db, 'source.health')!)[FORUM_POSTS_HEALTH];

describe('a cron tick', () => {
  it('with 500 subscribers posts the proposal first and the operator\'s forum posts at once, leaving their subscribers, cursor kept, for the next ticks', async () => {
    const base = 881000, prop = 881900;
    const { db, env } = await seededTick('ct', 500, base, prop);
    const posts = network(base, 3, prop);
    await runCron(env);
    expect(posts).toHaveLength(501 + 3);
    expect(posts.slice(501)).toEqual([OP, OP, OP]);
    expect(JSON.parse(kv(db, 'gov.state')!)).toEqual({ [prop]: 'voting' });
    expect(kv(db, 'forum.last_post_id')).toBe(String(base));
    expect(kv(db, `alert:forum:post:${base + 1}`)).toBeNull();
    expect(forumRow(db)).toMatchObject({ ok: true });
    expect(forumRow(db).note).toMatch(/^3 latest posts read; forum or governance alerts wait for the next run/);
    expect(kv(db, 'cron.lock')).toBeNull();

    await runCron(env);
    expect(posts).toHaveLength(504 + 500);
    expect(kv(db, 'forum.last_post_id')).toBe(String(base + 1));
    await runCron(env);
    await runCron(env);
    expect(posts).toHaveLength(4 * 501);
    expect(kv(db, 'forum.last_post_id')).toBe(String(base + 3));
    expect(forumRow(db).note).toBe('3 latest posts read');
    expect(kv(db, 'alerts.skipped')).toBeNull();
  });

  it('with 20 subscribers sends every alert in one tick, as before', async () => {
    const base = 882000, prop = 882900;
    const { db, env } = await seededTick('cs', 20, base, prop);
    const posts = network(base, 3, prop);
    await runCron(env);
    expect(posts).toHaveLength(4 * 21);
    expect(kv(db, 'forum.last_post_id')).toBe(String(base + 3));
    expect(JSON.parse(kv(db, 'gov.state')!)).toEqual({ [prop]: 'voting' });
    expect(forumRow(db).note).toBe('3 latest posts read');
  });

  it('with the X keys set posts the proposal on X and none of the forum posts (owner, 2026-10-29)', async () => {
    const base = 883000, prop = 883900;
    const { db, env } = await seededTick('cx', 2, base, prop);
    // from 13:00 UTC the tick also posts the day's recap (sources/x.ts postRecapOnX): today's is taken, so the run's
    // posts on X are this tick's alerts whatever the hour
    insert(db, 'kv', [{ key: `alert:x:recap:${new Date().toISOString().slice(0, 10)}`, value: '1', updated_at: NOW }]);
    network(base, 3, prop);
    const chain = globalThis.fetch;
    const tweets: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.x.com/2/tweets') return chain(input, init);
      tweets.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ data: { id: String(tweets.length), text: '' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    await runCron({ ...env, X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' });
    expect(kv(db, 'forum.last_post_id')).toBe(String(base + 3));
    expect(kv(db, `alert:x:gov:prop:${prop}:voting`), 'X posting is on in this run').not.toBeNull();
    expect(tweets.length).toBeGreaterThan(0);
    expect(tweets.filter((t) => !t.includes('Raise the cap')), 'every post is the proposal\'s').toEqual([]);
    for (let id = base + 1; id <= base + 3; id++) {
      expect(kv(db, `alert:forum:post:${id}`), 'the forum alert went to Discord').not.toBeNull();
      expect(kv(db, `alert:x:forum:post:${id}`), 'and not to X').toBeNull();
    }
  });

  it('with the X keys set, a proposal X does not take (503) keeps its stored state and goes on X the next run, its Discord alert sent once', async () => {
    const base = 883500, prop = 883950;
    const { db, env } = await seededTick('cy', 2, base, prop);
    insert(db, 'kv', [{ key: `alert:x:recap:${new Date().toISOString().slice(0, 10)}`, value: '1', updated_at: NOW }]);
    const hooks = network(base, 3, prop);
    const chain = globalThis.fetch;
    let status = 503;
    const tweets: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.x.com/2/tweets') return chain(input, init);
      tweets.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify(status === 201 ? { data: { id: '1', text: '' } } : { title: 'Service Unavailable' }), { status, headers: { 'content-type': 'application/json' } });
    }));
    const withX = { ...env, X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
    await runCron(withX);
    expect(tweets).toHaveLength(1);
    expect(kv(db, `alert:x:gov:prop:${prop}:voting`)).toBeNull();
    expect(JSON.parse(kv(db, 'gov.state')!)).toEqual({ [prop]: 'pending' });
    const sent = hooks.length;
    status = 201;
    await runCron(withX);
    expect(tweets).toHaveLength(2);
    expect(tweets[1]).toContain('Raise the cap');
    expect(kv(db, `alert:x:gov:prop:${prop}:voting`)).not.toBeNull();
    expect(JSON.parse(kv(db, 'gov.state')!)).toEqual({ [prop]: 'voting' });
    expect(hooks.length, 'Discord heard the proposal once').toBe(sent);
  });

  it('with the X keys set posts the closed hour\'s largest move once (public-posts.ts), and a later tick of that hour nothing more', async () => {
    // The clock is held at minute 30 of this run's hour (Date alone; it still moves on in real time), so the hour the
    // tick reads is always the one before it, 30 minutes past its close: on the wall clock a move early in that hour
    // was more than X_MAX_AGE_MS old from minute 01 to 09, and the hour the tick reads could change between two ticks.
    vi.useFakeTimers({ now: Math.floor(NOW / 3_600_000) * 3_600_000 + 30 * 60_000, toFake: ['Date'], shouldAdvanceTime: true });
    const base = 884000, prop = 884900;
    const { db, env } = await seededTick('ch', 2, base, prop);
    insert(db, 'kv', [{ key: `alert:x:recap:${new Date().toISOString().slice(0, 10)}`, value: '1', updated_at: NOW }]);
    // the Osmosis catch-up search read past the hour (public-posts.ts hourCovered), and the Namada scan to the head
    readTo(db, Date.now() + 3_600_000, { namadaCursor: 8_343_400 });
    // the test above claimed this hour as quiet in the isolate's memory; this test's database is new, so is its isolate
    resetClaimMemory();
    // a move at each end of the hour the tick reads (the larger one posted), and a larger one in the hour not yet
    // closed, never posted by this tick
    const hour = publicHour(db as any, Date.now(), { osmosis: 10000, namada: 10000 });
    expect(Date.now() - hour.end).toBeGreaterThanOrEqual(30 * 60_000);
    const sale = (id: string, ts: number, nam: number) => ({ id, chain: 'osmosis', height: 1, ts, tx_hash: id, kind: 'sell', from_addr: 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh', to_addr: null, amount_num: nam, pool_id: '3005', price_usd: 0.00015, value_usd: nam * 0.00015, meta: JSON.stringify({ priceSource: 'spot' }) });
    insert(db, 'flows', [
      sale('osmosis:CH0:0', hour.start, 900_000), sale('osmosis:CH1:0', hour.end - 60_000, 1_000_000), sale('osmosis:CH2:0', hour.end + 60_000, 1_100_000),
    ]);
    network(base, 3, prop);
    const chain = globalThis.fetch;
    const tweets: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // the nodes name their chain, so the cron's look at them (checks rpc_consensus) shows a block past the hour
      if (String(input).endsWith('/status')) return new Response(JSON.stringify({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }), { headers: { 'content-type': 'application/json' } });
      if (String(input) !== 'https://api.x.com/2/tweets') return chain(input, init);
      tweets.push(JSON.parse(String(init?.body)).text);
      return new Response(JSON.stringify({ data: { id: String(tweets.length), text: '' } }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));
    const xEnv = { ...env, X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
    await runCron(xEnv);
    const moves = () => tweets.filter((t) => /\$NAM sold on Osmosis/.test(t));
    expect(moves()).toHaveLength(1);
    await runCron(xEnv);
    expect(moves()).toHaveLength(1);
    expect(moves()[0]).toMatch(/^1,000,000 \$NAM sold on Osmosis\n\nSold by osmo1nn62s…evpvh in pool 3005\./);
  });
});

// ---------------------------------------------------------------- answer bodies

/**
 * An answer whose body says when it is let go: read to its end, or cancelled. A 429 carries Discord's headers (a
 * Retry-After and the hook's own scope), as Discord's own answer does: a 429 with none of them limits the site's
 * address (sources/discord.ts siteWide) and pauses the alert's other posts.
 */
function tracked(status: number, text: string | null) {
  const t = { status, released: text == null };
  if (text == null) return { res: new Response(null, { status }), t };
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (!sent) { sent = true; c.enqueue(bytes); } else { c.close(); t.released = true; } },
    cancel() { t.released = true; },
  }, { highWaterMark: 0 });
  const limit = status === 429 ? { 'retry-after': '2', 'x-ratelimit-scope': 'user' } : {};
  return { res: new Response(body, { status, headers: { 'content-type': 'application/json', ...limit } }), t };
}

describe('every webhook answer is let go', () => {
  it('404, 401, 429, 5xx, a 400 and a 200 with a body are each read or cancelled, never left unread', async () => {
    const answers: [number, string | null][] = [
      [404, '{"message": "Unknown Webhook", "code": 10015}'],
      [401, '{"message": "Invalid Webhook Token", "code": 50027}'],
      [429, '{"message": "You are being rate limited.", "retry_after": 1.5, "global": false}'],
      [500, '{"message": "500: Internal Server Error", "code": 0}'],
      [503, 'upstream connect error'],
      [400, '{"message": "Webhooks posted to forum channels must have a thread_name or thread_id", "code": 220001}'],
      [200, '{"id": "1", "type": 0, "content": ""}'],
      [204, null],
    ];
    const db = testD1();
    configureAlerts(KEY);
    for (let i = 0; i < answers.length; i++) await saveSettings(db as any, KEY, subscriber('rb', i + 1));
    const seen: { status: number; released: boolean }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const i = Number(String(u).split('/webhooks/')[1].split('/')[0]) - 1;
      const { res, t } = tracked(...answers[i]);
      seen.push(t);
      return res;
    }));
    await sendDiscordForumAlert(undefined, post(880401), db as any);
    expect(seen).toHaveLength(answers.length);
    expect(seen.filter((t) => !t.released)).toEqual([]);

    const { res, t } = tracked(404, '{"message": "Unknown Webhook", "code": 10015}');
    vi.stubGlobal('fetch', vi.fn(async () => res));
    // A link of its own: the forum alert above found hook rb/1 gone (Unknown Webhook), and a gone link's test post is
    // held, not posted (sources/discord.ts testPostHeld).
    expect(await sendDiscordTestAlert(hook('rt', 1), subscriber('rt', 1))).toBe(false);
    expect(t.released).toBe(true);
  });
});

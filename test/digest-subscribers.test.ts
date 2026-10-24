// Daily digest (2026-10-23), who gets it: a subscriber's switch notifications.dailyDigest is off by default and off
// for a row saved before it existed; with it on, a wallet's channel gets the digest (in quiet hours too) with its own
// watchlist and never the operator's embed, and a link two wallets saved gets one digest, the first-saved wallet's;
// the operator's channel goes first, with the Operator embed. Under the run's post budget, with 500 subscribers, a
// governance alert and a forum post in the same run, every channel gets the digest once, its two messages in one run,
// the operator at once, and the forum's subscribers after the digest's last channel; with 20 subscribers on a Monday
// the daily, the weekly and the forum post go in one run. The Settings preview posts the digest as it looks now to
// the wallet's own channel under the test post's checks, cooldown and budget, takes no claim and writes no record.
// The survey's stored rows are seeded; the wallets and watched addresses are fixture-shaped; fetch is stubbed before
// anything could post, so nothing reaches Discord.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { fixtureAddress, seedCharts, seedSurvey, T, A24 } from './digest-survey';
import { kvJson, kvKeys, sent, stubDiscord, textOf, titlesOf, type SentPost } from './digest-net';
import { alertBudget, configureAlerts, noticeBody, resetClaimMemory, sendDiscordForumAlert, sendDiscordGovAlert, testBody, RUN_ALERT_POSTS } from '../worker/src/sources/discord';
import { DIGEST_HEALTH, PREVIEW_LEAD, prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { applyUpdate, defaultPrefs, publicView, saveSettings, type StoredSettings } from '../worker/src/settings';
import { createSession, type Session } from '../worker/src/auth';
import { app } from '../worker/src/api';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import type { ForumPost, GovernanceProposal, SourceHealth, UserSettings } from '../shared/types';

const KEY = base64.encode(new Uint8Array(32).fill(43));
const OP = 'https://discord.com/api/webhooks/43/operator';
const hook = (i: number) => `https://discord.com/api/webhooks/${4300 + i}/digest`;
const MIN = 60_000, H = 60 * MIN, DAY = 24 * H;
const TNAM = fixtureAddress('namada', 2, 'qdgst');
const OSMO = fixtureAddress('osmosis', 3, 'qdgst');
const short = (a: string) => `${a.slice(0, 14)}…${a.slice(-6)}`;
const BALANCE_LISTING_AT = 1792741923099;

/** A wallet's settings: Discord on with its own link unless given, the digest switch as given (absent: a row saved before it existed). */
function wallet(i: number, o: { digest?: boolean; url?: string; enabled?: boolean; watch?: string[]; quiet?: { start: number; end: number }; forum?: boolean; createdAt?: number } = {}): StoredSettings {
  const n = defaultPrefs();
  delete (n as { dailyDigest?: boolean }).dailyDigest;
  if (o.digest !== undefined) n.dailyDigest = o.digest;
  if (o.watch) { n.watchlist = o.watch; n.watchlistOn = true; }
  if (o.quiet) n.quietHoursUtc = o.quiet;
  if (o.forum) n.forumAndGov = true;
  const at = o.createdAt ?? T - DAY + i;
  return { address: fixtureAddress('namada', 100 + i, 'qwallet'), notifications: n, channels: { discord: { enabled: o.enabled ?? true, webhookUrl: o.url ?? hook(i) } }, createdAt: at, updatedAt: at };
}

function seeded(): TestD1 {
  const db = testD1();
  seedSurvey(db);
  seedCharts(db);
  return db;
}

/** The two watched addresses: a Namada one 12,500 NAM lower than 24 h ago, an Osmosis one unchanged. */
function seedWatch(db: TestD1) {
  insert(db, 'holders', [
    { chain: 'namada', address: TNAM, balance: '1250000000000', balance_num: 1_250_000, updated_height: 8384388, updated_at: BALANCE_LISTING_AT, verified_at: BALANCE_LISTING_AT, verified_src: BALANCE_LISTING_SRC },
    { chain: 'osmosis', address: OSMO, balance: '2100000000', balance_num: 2_100, updated_height: null, updated_at: 1792741802657, verified_at: 1792741802657, verified_src: 'keplr' },
  ]);
  insert(db, 'balance_spans', [
    { chain: 'namada', address: TNAM, from_ts: A24 - 33 * MIN, to_ts: A24 + 27 * MIN, balance: '1262500000000', balance_num: 1_262_500, reads: 2 },
    { chain: 'namada', address: TNAM, from_ts: A24 + 2 * H, to_ts: BALANCE_LISTING_AT, balance: '1250000000000', balance_num: 1_250_000, reads: 20 },
    { chain: 'osmosis', address: OSMO, from_ts: A24 - 10 * H, to_ts: 1792741802657, balance: '2100000000', balance_num: 2_100, reads: 30 },
  ]);
}

/** One cron run's alerts at `at`, in the cron's order: governance, the digests, the forum (cron.ts syncIntelAndAlerts). */
async function run(db: TestD1, at: number, alerts: { gov?: GovernanceProposal[]; forum?: ForumPost[] } = {}) {
  vi.setSystemTime(at);
  const budget = alertBudget();
  const health: SourceHealth[] = [];
  const from = sent.length;
  const gov: GovernanceProposal[] = [], forum: ForumPost[] = [];
  const digests = prepareDigests(db as any, at, true);
  for (const p of alerts.gov ?? []) if ((await sendDiscordGovAlert(OP, p, false, db as any, budget)) === 'waiting') gov.push(p);
  await sendDigests(db as any, OP, await digests, budget, health);
  for (const p of alerts.forum ?? []) if ((await sendDiscordForumAlert(OP, p, db as any, budget)) === 'waiting') forum.push(p);
  return { posts: sent.slice(from), health, waiting: { gov, forum } };
}
const isDigest = (p: SentPost) => titlesOf(p).some((t) => t.startsWith('NAM daily digest') || t.startsWith('Trades worth attention') || t === 'Your watchlist (24 h)' || t === 'Operator');
const byUrl = (posts: SentPost[]) => posts.reduce((m, p) => m.set(p.url, [...(m.get(p.url) ?? []), p]), new Map<string, SentPost[]>());

beforeEach(() => {
  resetDigestMemory();
  resetClaimMemory();
  configureAlerts(KEY, true);
  stubDiscord();
  vi.useFakeTimers({ now: T, toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the switch: notifications.dailyDigest', () => {
  it('off by default and for a row saved before it existed; a boolean saves, anything else is ignored; the view and the connected card carry it', () => {
    expect(defaultPrefs().dailyDigest).toBe(false);
    const old = wallet(1);
    expect('dailyDigest' in old.notifications).toBe(false);
    expect(publicView(old).notifications.dailyDigest).toBeUndefined();
    const on = applyUpdate(old, { notifications: { dailyDigest: true } }) as StoredSettings;
    expect(on.notifications.dailyDigest).toBe(true);
    expect(publicView(on).notifications.dailyDigest).toBe(true);
    for (const v of ['yes', 1, null, {}]) expect((applyUpdate(on, { notifications: { dailyDigest: v } }) as StoredSettings).notifications.dailyDigest).toBe(true);
    const off = applyUpdate(on, { notifications: { dailyDigest: false } }) as StoredSettings;
    expect(off.notifications.dailyDigest).toBe(false);
    const field = (b: { embeds: any[] }) => b.embeds[0].fields.find((f: any) => f.name === 'Daily digest');
    expect(field(testBody(on, undefined, T))).toEqual({ name: 'Daily digest', value: 'on', inline: true });
    expect(field(noticeBody(old, T))).toEqual({ name: 'Daily digest', value: 'off', inline: true });
  });
});

describe('who gets the digest', () => {
  it('the operator first with its Operator embed; each wallet with the switch on gets the same digest with its own watchlist; off, Discord off and an old row get none', { timeout: 60_000 }, async () => {
    const db = seeded();
    seedWatch(db);
    const shared = 'https://discord.com/api/webhooks/4399/shared';
    const ws = {
      watcher: wallet(1, { digest: true, watch: [TNAM, OSMO] }),
      off: wallet(2, { digest: false }),
      noDiscord: wallet(3, { digest: true, enabled: false }),
      old: wallet(4),
      quiet: wallet(5, { digest: true, quiet: { start: 6, end: 10 } }),
      firstOnShared: wallet(6, { digest: true, url: shared, watch: [TNAM], createdAt: T - 2 * DAY }),
      laterOnShared: wallet(7, { digest: true, url: shared, watch: [OSMO], createdAt: T - DAY }),
    };
    for (const w of Object.values(ws)) await saveSettings(db as any, KEY, w);

    const r = await run(db, T);
    const got = byUrl(r.posts);
    expect([...got.keys()].sort()).toEqual([OP, hook(1), hook(5), shared].sort());
    expect(r.posts[0].url).toBe(OP);
    // the same digest for everyone: the first embed of every recipient's first message is identical
    const firstEmbed = (u: string) => JSON.stringify(got.get(u)![0].json.embeds[0]);
    for (const u of [hook(1), hook(5), shared]) expect(firstEmbed(u)).toBe(firstEmbed(OP));
    // the operator's own embed only on the operator's channel, with this digest's channels
    const opText = got.get(OP)!.map(textOf).join('');
    expect(opText).toContain('"title":"Operator"');
    expect(opText).toContain('This digest: 4 channels (3 subscribers).');
    for (const u of [hook(1), hook(5), shared]) expect(got.get(u)!.map(textOf).join('')).not.toContain('"title":"Operator"');
    // the watcher's own watchlist, its addresses shortened, on its channel only
    const watcher = got.get(hook(1))!.map(textOf).join('');
    expect(watcher).toContain('Your watchlist (24 h)');
    expect(watcher).toContain(short(TNAM));
    expect(watcher).toContain('−12,500.00 NAM spendable');
    expect(watcher).toContain(short(OSMO));
    expect(got.get(hook(5))!.map(textOf).join('')).not.toContain('Your watchlist');
    expect(opText).not.toContain(short(TNAM));
    // one digest on the shared link, with the first-saved wallet's watchlist
    const onShared = got.get(shared)!.map(textOf).join('');
    expect(onShared).toContain(short(TNAM));
    expect(onShared).not.toContain(short(OSMO));
    expect(got.get(shared)!.filter((p) => titlesOf(p)[0]?.startsWith('NAM daily digest'))).toHaveLength(1);
    // each channel claimed once under the day's key; the record counts every channel
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23:%')).toHaveLength(4);
    expect(kvJson(db, 'digest.last')).toMatchObject({ key: 'alert:digest:daily:2026-10-23', targets: 4, posted: 4, skipped: 0, waiting: 0 });
    expect(r.health.at(-1)).toMatchObject({ name: DIGEST_HEALTH, ok: true, note: 'Digest 2026-10-23 sent 23 Oct 08:00 UTC to 4 of 4 channels.' });

    // the next run sends nothing more
    const again = await run(db, T + MIN);
    expect(again.posts).toEqual([]);
  });
});

describe('the run\'s post budget', () => {
  const proposal: GovernanceProposal = { id: 990043, title: 'p', authors: null, abstract: null, type: 'default', status: 'passed', startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: null } as GovernanceProposal;
  const post: ForumPost = { id: 990043, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: 'https://forum.namada.net/t/t/1/990043', username: 'u', displayName: null, avatarUrl: null, createdAt: new Date(T).toISOString(), excerpt: 'e', isNewTopic: false };

  it('500 subscribers, a proposal and a forum post at 08:00: every channel gets the digest once, its two messages in one run, and the forum waits for the digest', { timeout: 240_000 }, async () => {
    const db = seeded();
    for (let i = 0; i < 500; i++) await saveSettings(db as any, KEY, wallet(i, { digest: true, forum: true }));
    let gov = [proposal], forum = [post];
    const runs: SentPost[][] = [];
    for (let k = 0; k < 8 && (runs.length === 0 || runs.at(-1)!.length); k++) {
      const r = await run(db, T + k * MIN, { gov, forum });
      runs.push(r.posts);
      gov = r.waiting.gov;
      forum = r.waiting.forum;
    }
    for (const r of runs) expect(r.length).toBeLessThanOrEqual(RUN_ALERT_POSTS);
    expect(gov).toEqual([]);
    expect(forum).toEqual([]);
    const all = runs.flat();
    // the operator: the proposal, the digest's messages and the forum post, all in the first run
    const opPosts = runs[0].filter((p) => p.url === OP);
    expect(opPosts.length).toBe(all.filter((p) => p.url === OP).length);
    expect(opPosts.filter(isDigest).length).toBeGreaterThan(0);
    // every subscriber: the digest once (both its messages in the same run), the proposal once, the forum post once
    const runOf = new Map<string, Set<number>>();
    runs.forEach((r, i) => r.filter(isDigest).forEach((p) => runOf.set(p.url, (runOf.get(p.url) ?? new Set()).add(i))));
    for (let i = 0; i < 500; i++) {
      const mine = all.filter((p) => p.url === hook(i));
      expect(mine.filter((p) => titlesOf(p)[0]?.startsWith('NAM daily digest'))).toHaveLength(1);
      expect(runOf.get(hook(i))!.size).toBe(1);
      expect(mine.filter((p) => !isDigest(p))).toHaveLength(2);
    }
    // the forum's subscribers only in a run after the digest's last channel
    const lastDigestRun = Math.max(...runs.map((r, i) => (r.some((p) => p.url !== OP && isDigest(p)) ? i : -1)));
    const forumRuns = runs.map((r, i) => (r.some((p) => p.url !== OP && textOf(p).includes('forum.namada.net')) ? i : -1)).filter((i) => i >= 0);
    expect(Math.min(...forumRuns)).toBeGreaterThan(lastDigestRun);
    // a later run's channels get the digest built for that run
    const later = runs.findIndex((r, i) => i > 0 && r.some(isDigest));
    expect(runs[later].filter((p) => titlesOf(p)[0]?.startsWith('NAM daily digest'))[0].json.embeds[0].title).toBe(`NAM daily digest · Fri 23 Oct 2026, 08:0${later} UTC`);
    expect(kvJson(db, 'digest.last')).toMatchObject({ key: 'alert:digest:daily:2026-10-23', at: T, targets: 501, posted: 501, skipped: 0, waiting: 0 });
    expect(kvKeys(db, 'alert:digest:daily:2026-10-23:%')).toHaveLength(501);
    expect(kvJson(db, 'alerts.skipped')).toBeNull();
  });

  it('20 subscribers on a Monday: the daily, the weekly and the forum post go in one run', { timeout: 120_000 }, async () => {
    const db = seeded();
    for (let i = 0; i < 20; i++) await saveSettings(db as any, KEY, wallet(i, { digest: true, forum: true }));
    const MON = Date.UTC(2026, 9, 26, 8);
    const r = await run(db, MON, { forum: [post] });
    expect(r.waiting.forum).toEqual([]);
    const titles = r.posts.flatMap(titlesOf);
    expect(titles.filter((t) => t.startsWith('NAM daily digest'))).toHaveLength(21);
    expect(titles.filter((t) => t.startsWith('NAM weekly digest'))).toHaveLength(21);
    expect(r.posts.filter((p) => textOf(p).includes('forum.namada.net'))).toHaveLength(21);
    expect(r.health.map((h) => h.note)).toEqual([
      'Digest 2026-10-26 sent 26 Oct 08:00 UTC to 21 of 21 channels.',
      'Weekly digest 2026-W44 sent 26 Oct 08:00 UTC to 21 of 21 channels.',
    ]);
  });
});

describe('the Settings preview of the digest', () => {
  async function signedIn(db: TestD1, w: StoredSettings) {
    const s = (await createSession(db as any, w.address, 'namada', 'namada')) as Session;
    await saveSettings(db as any, KEY, w);
    return (body: unknown, sends = true) => app.request('/api/me/settings/test', {
      method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, { DB: db, SETTINGS_KEY: KEY, ...(sends ? { SEND_ALERTS: 'yes' } : {}) } as any);
  }

  it('posts the digest as it looks now to the wallet\'s channel, with its watchlist only, and takes no claim; a second press within 30 s waits', { timeout: 60_000 }, async () => {
    const db = seeded();
    seedWatch(db);
    const w = wallet(901, { digest: false, watch: [TNAM] });
    const press = await signedIn(db, w);
    const res = await press({ preview: 'digest' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(sent.every((p) => p.url === hook(901))).toBe(true);
    const first = sent[0].json.embeds[0];
    expect(first.title).toBe('Preview · NAM daily digest · Fri 23 Oct 2026, 08:00 UTC');
    expect(first.description.startsWith(`${PREVIEW_LEAD}\n\n`)).toBe(true);
    const text = sent.map(textOf).join('');
    expect(text).toContain(short(TNAM));
    expect(text).not.toContain('"title":"Operator"');
    expect(sent[0].form).toBe(true);
    expect(kvKeys(db, 'alert:digest:%')).toEqual([]);
    expect(kvJson(db, 'digest.last')).toBeNull();
    // the test posts' budget: the unit an unproven link took was given back when Discord took the post
    expect(kvJson(db, 'alerts.invalid.test')).toMatchObject({ n: 0 });

    const n = sent.length;
    const again = await press({ preview: 'digest' });
    expect(again.status).toBe(429);
    expect(sent.length).toBe(n);
  });

  it('with alerts off it answers 503 and posts nothing; a paused link answers the paused 429 and posts nothing', { timeout: 60_000 }, async () => {
    const db = seeded();
    const press = await signedIn(db, wallet(902, { digest: true }));
    configureAlerts(KEY, false);
    const off = await press({ preview: 'digest' }, false);
    expect(off.status).toBe(503);
    expect(sent).toEqual([]);

    configureAlerts(KEY, true);
    // Discord answers the first post 429 with a Retry-After: the link is paused here
    stubDiscord((_, i) => (i === 0 ? new Response('{"retry_after":60}', { status: 429, headers: { 'retry-after': '60', 'x-ratelimit-scope': 'user' } }) : new Response(null, { status: 204 })));
    const first = await press({ preview: 'digest' });
    expect(await first.json()).toEqual({ success: false });
    const n = sent.length;
    vi.setSystemTime(T + 31_000);
    const paused = await press({ preview: 'digest' });
    expect(paused.status).toBe(429);
    expect(String(((await paused.json()) as { error: string }).error)).toMatch(/pause|wait/i);
    expect(sent.length).toBe(n);
  });
});

describe('the Settings page', () => {
  let RulesPanel: ComponentType<any>, DeliveryPanel: ComponentType<any>, QuietPanel: ComponentType<any>;
  beforeAll(async () => {
    // the Settings screen reads the page's address when its modules load: a page at /settings, with nothing else
    const g = globalThis as any;
    const noop = () => {};
    g.location ??= new URL('https://namada.trade/settings');
    g.history ??= { pushState: noop, replaceState: noop, state: null };
    g.window ??= g;
    g.addEventListener ??= noop;
    g.removeEventListener ??= noop;
    g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
    g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
    ({ RulesPanel, DeliveryPanel, QuietPanel } = await import('../web/src/screens/settings/index'));
  });
  const view = (dailyDigest: boolean | undefined, hasUrl = true): UserSettings => ({
    address: fixtureAddress('namada', 1, 'qwallet'),
    notifications: { ...defaultPrefs(), dailyDigest },
    channels: { discord: { enabled: hasUrl, hasUrl, webhookUrlMasked: hasUrl ? 'https://discord.com/api/webhooks/1••••abcd' : null } },
    createdAt: 1, updatedAt: 1,
  });
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
  const digestSwitch = (html: string) => /<span class="swrow__t"[^>]*>Daily digest at 08:00 UTC<\/span>(?:<span[^>]*>[^<]*<\/span>)?<button[^>]*>/.exec(html)?.[0] ?? '';

  it('the digest switch comes after the votes and forum switch, says when it posts and that quiet hours do not stop it, and waits for a saved link', () => {
    const html = renderToStaticMarkup(createElement(RulesPanel, { s: view(undefined), save: async () => view(true), rules: null, rulesStamp: null }));
    const t = text(html);
    expect(t.indexOf('New votes and forum posts')).toBeLessThan(t.indexOf('Daily digest at 08:00 UTC'));
    expect(t).toContain('The day’s figures in one post at 08:00 UTC every day, and the week’s on Mondays, one digest per channel. It is posted even during quiet hours.');
    // a row saved before the switch existed shows it off
    expect(digestSwitch(html)).toContain('aria-checked="false"');
    expect(digestSwitch(renderToStaticMarkup(createElement(RulesPanel, { s: view(true), save: async () => view(true), rules: null, rulesStamp: null })))).toContain('aria-checked="true"');
    const noLink = renderToStaticMarkup(createElement(RulesPanel, { s: view(false, false), save: async () => view(false, false), rules: null, rulesStamp: null }));
    expect(text(noLink)).toContain('Save a Discord link first.');
    expect(digestSwitch(noLink)).toContain('disabled');
  });

  it('quiet hours say the digest is still posted; the preview button sits beside the test message', () => {
    const quiet = text(renderToStaticMarkup(createElement(QuietPanel, { s: view(true), save: async () => view(true) })));
    expect(quiet).toContain('The daily digest, when it is on, is still posted at 08:00 UTC.');
    const delivery = text(renderToStaticMarkup(createElement(DeliveryPanel, { s: view(true), save: async () => view(true) })));
    expect(delivery.indexOf('Send a test message')).toBeLessThan(delivery.indexOf('Preview the digest'));
  });
});

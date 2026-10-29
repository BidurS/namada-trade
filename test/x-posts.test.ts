// Automatic X posts (worker/src/sources/x.ts): the site's own big moves, votes, forum news and a daily recap, each
// posted once, at most X_DAILY_MAX a day, fresh moves only, within 280 of X's weighted characters, mentioning no one,
// signed with OAuth 1.0a. Fetch is stubbed: nothing reaches X.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { testD1, type TestD1 } from './d1-sqlite';
import { configureAlerts, moveCard } from '../worker/src/sources/discord';
import { cardText, cutX, oauthHeader, postMoveOnX, postOnce, postRecapOnX, recapText, xLength, X_DAILY_MAX, X_MAX_AGE_MS, X_RECAP_HOUR_UTC } from '../worker/src/sources/x';
import { rowToFlow } from '../worker/src/analytics';
import type { Flow } from '../shared/types';

const KEYS = { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
const env = (db: TestD1, extra: object = {}) => ({ DB: db, ...KEYS, ...extra }) as any;
let t = 0;

function x(answer: (n: number) => { status: number; json: any } = (n) => ({ status: 201, json: { data: { id: String(n), text: '' } } })) {
  const posts: string[] = [];
  const headers: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    expect(String(u)).toBe('https://api.x.com/2/tweets');
    posts.push(JSON.parse(String(init?.body)).text);
    headers.push(String((init?.headers as any).authorization));
    const a = answer(posts.length);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } });
  }));
  return { posts, headers };
}
const whale = (n: number, extra: Partial<Flow> = {}): Flow =>
  ({ id: `osmosis:XW${n}:0`, chain: 'osmosis', height: 100 + n, ts: t - 60_000, txHash: `XW${n}`, kind: 'sell', from: 'osmo1sellerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', to: null, amount: 50_000, meta: null, ...extra }) as unknown as Flow;

beforeEach(() => {
  t = Date.UTC(2026, 9, 29, 9);
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts('k', true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the text', () => {
  it('counts as X does: a link 23, most Latin text 1, other scripts and the ellipsis 2', () => {
    expect(xLength('abc')).toBe(3);
    expect(xLength('see https://namada.trade/very/long/path?x=1')).toBe(4 + 23);
    expect(xLength('…')).toBe(2);
    expect(xLength('日本')).toBe(4);
    const cut = cutX('a'.repeat(300));
    expect(xLength(cut)).toBeLessThanOrEqual(280);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('every real card fits in 280, carries no link, and mentions no one', () => {
    const rows: Record<string, any> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'discord-rows.json'), 'utf8')).rows;
    for (const k of Object.keys(rows)) {
      const f = rowToFlow(rows[k]);
      const text = cardText(moveCard({ ...f, fromLabel: '@someone' } as Flow, { whaleNam: 10000 }));
      expect(xLength(text), k).toBeLessThanOrEqual(280);
      expect(text, k).not.toMatch(/https?:\/\//);
      expect(text, k).not.toMatch(/@\w/);
      expect(text, k).toMatch(/UTC/);
    }
  });

  it('the recap gives only the figures it was given, with the day\'s one link', () => {
    const full = recapText({ generatedAt: t, price: { usd: { value: 0.00102 }, change24h: -3.94 }, dex: { volume24hNam: 1234567, buys24h: 40, sells24h: 30 }, supply: { bonded: 600, shielded: 50, total: 1000 }, namada: { holders: 12345 } });
    expect(full).toContain('Price $0.001020 (−3.9% 24h)');
    expect(full).toContain('Staked 60.0% · Shielded 5.0%');
    expect(full).toContain('https://namada.trade');
    expect(xLength(full)).toBeLessThanOrEqual(280);
    const thin = recapText({ generatedAt: t, price: { usd: null } });
    expect(thin).not.toContain('Price');
    expect(thin).not.toContain('undefined');
  });
});

describe('posting', () => {
  it('signs with OAuth 1.0a HMAC-SHA1 over the method, the URL and the oauth parameters', async () => {
    const h = await oauthHeader(KEYS, 'POST', 'https://api.x.com/2/tweets', 'nonce1', 1700000000);
    const params = 'oauth_consumer_key=ck&oauth_nonce=nonce1&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1700000000&oauth_token=at&oauth_version=1.0';
    const base = `POST&${encodeURIComponent('https://api.x.com/2/tweets')}&${encodeURIComponent(params)}`;
    const sig = createHmac('sha1', 'cs&as').update(base).digest('base64');
    expect(h).toContain(`oauth_signature="${encodeURIComponent(sig)}"`);
    expect(h.startsWith('OAuth ')).toBe(true);
    expect(h).not.toContain('cs');
  });

  it('posts a big move once; a crossing\'s two records once; an old or small move never', async () => {
    const db = testD1();
    const s = x();
    await postMoveOnX(env(db), whale(1));
    await postMoveOnX(env(db), whale(1));
    expect(s.posts).toHaveLength(1);
    await postMoveOnX(env(db), whale(2, { ts: t - X_MAX_AGE_MS - 1 }));
    await postMoveOnX(env(db), whale(3, { amount: 9_999 }));
    await postMoveOnX(env(db), whale(4, { kind: 'rewards' } as any));
    expect(s.posts).toHaveLength(1);
  });

  it('posts nothing from a Worker that sends no alerts, or without all four keys', async () => {
    const db = testD1();
    const s = x();
    configureAlerts('k', false);
    await postMoveOnX(env(db), whale(5));
    configureAlerts('k', true);
    await postMoveOnX(env(db, { X_ACCESS_SECRET: undefined }), whale(6));
    expect(s.posts).toHaveLength(0);
  });

  it('stops at the day\'s cap, and starts again the next day', async () => {
    const db = testD1();
    const s = x();
    for (let i = 0; i < X_DAILY_MAX + 3; i++) await postOnce(env(db), `alert:x:test:${i}`, () => `post ${i}`, `test ${i}`);
    expect(s.posts).toHaveLength(X_DAILY_MAX);
    // a post the cap refused is not claimed: it can go tomorrow
    t += 86_400_000;
    expect(await postOnce(env(db), `alert:x:test:${X_DAILY_MAX}`, () => 'again', 'again')).toBe('posted');
  });

  it('X down or busy: the claim and the day\'s post are given back; a refusal keeps them', async () => {
    const db = testD1();
    let status = 503;
    const s = x(() => (status === 201 ? { status, json: { data: { id: '1' } } } : { status, json: { title: 'Service Unavailable' } }));
    expect(await postOnce(env(db), 'alert:x:k1', () => 'one', 'one')).toBe('failed');
    status = 201;
    expect(await postOnce(env(db), 'alert:x:k1', () => 'one', 'one')).toBe('posted');
    status = 403;
    expect(await postOnce(env(db), 'alert:x:k2', () => 'two', 'two')).toBe('failed');
    status = 201;
    expect(await postOnce(env(db), 'alert:x:k2', () => 'two', 'two')).toBe('claimed');
    expect(s.posts).toEqual(['one', 'one', 'two']);
    const used = await db.prepare('SELECT value FROM kv WHERE key = ?').bind('alert:x:day:2026-10-29').first<{ value: string }>();
    expect(Number(used!.value)).toBe(2);
    const last = JSON.parse((await db.prepare("SELECT value FROM kv WHERE key = 'x.last'").first<{ value: string }>())!.value);
    expect(last).toMatchObject({ status: 403, ok: false });
  });

  it('posts the recap once a day from 13:00 UTC; an overview that cannot be read posts nothing and keeps the day open', async () => {
    const db = testD1();
    const s = x();
    const overview = async () => ({ generatedAt: Date.now(), price: { usd: { value: 0.001 }, change24h: 1 }, namada: { holders: 10 } });
    await postRecapOnX(env(db), overview);
    expect(s.posts).toHaveLength(0);
    t = Date.UTC(2026, 9, 29, X_RECAP_HOUR_UTC, 1);
    await postRecapOnX(env(db), async () => { throw new Error('overview 500'); });
    expect(s.posts).toHaveLength(0);
    await postRecapOnX(env(db), overview);
    await postRecapOnX(env(db), overview);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatch(/^NAM today \(13:01 UTC\):/);
  });
});

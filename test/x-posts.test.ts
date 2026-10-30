// Automatic X posts (worker/src/sources/x.ts): the site's own moves (one a closed hour: test/public-posts.test.ts),
// votes and a daily recap (no forum posts), each posted once, each kind under its own share of the day (the recap's
// share its own), within 280 of X's weighted characters, mentioning no one, signed with OAuth 1.0a, and nothing at all
// while kv x.on is '0'. Fetch is stubbed: nothing reaches X.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { configureAlerts, moveCard, resetClaimMemory } from '../worker/src/sources/discord';
import { cardText, cutX, oauthHeader, postGovOnX, postHourOnX, postOnce, postRecapOnX, recapChart, repostNamada, recapText, xLength, xOn, X_DAILY_MAX, X_ON_KEY, X_RECAP_HOUR_UTC, X_SHARES } from '../worker/src/sources/x';
import { publicHour } from '../worker/src/public-posts';
import { rowToFlow } from '../worker/src/analytics';
import type { Flow, GovernanceProposal } from '../shared/types';

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
const proposal = (id: number, title = 'Raise the cap'): GovernanceProposal =>
  ({ id, title, authors: null, abstract: null, type: 'default', status: 'voting', startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: null }) as GovernanceProposal;

beforeEach(() => {
  t = Date.UTC(2026, 9, 29, 9);
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts('k', true);
  // each test's database is new, so are the isolate's claims: two tests post the same day's recap
  resetClaimMemory();
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

describe('the recap\'s picture', () => {
  it('draws the digest\'s price chart from the hourly rows, and nothing when there are none', async () => {
    const db = testD1();
    expect(await recapChart(db as any, t)).toBeNull();
    for (let h = 1; h <= 48; h++) {
      await db.prepare('INSERT INTO metrics (key, ts, value) VALUES (?, ?, ?)').bind('price.usd.1h', t - h * 3_600_000, 0.001 + h * 0.00001).run();
    }
    await db.prepare('INSERT INTO metrics (key, ts, value) VALUES (?, ?, ?)').bind('price.usd', t - 60_000, 0.00101).run();
    const png = await recapChart(db as any, t);
    expect(png).not.toBeNull();
    expect([...png!.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('uploads the picture and attaches it; a picture X does not take leaves the post as text', async () => {
    const db = testD1();
    let uploads = 0, uploadOk = true;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      if (String(u) === 'https://api.x.com/2/media/upload') {
        uploads++;
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.body as FormData).get('media_category')).toBe('tweet_image');
        return new Response(JSON.stringify(uploadOk ? { data: { id: '777' } } : { detail: 'nope' }), { status: uploadOk ? 200 : 400 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: { id: '1' } }), { status: 201 });
    }));
    const pic = async () => new Uint8Array([137, 80, 78, 71]);
    expect(await postOnce(env(db), 'alert:x:p1', 'move', () => 'with picture', 'p1', pic)).toBe('posted');
    expect(bodies[0]).toEqual({ text: 'with picture', media: { media_ids: ['777'] } });
    uploadOk = false;
    expect(await postOnce(env(db), 'alert:x:p2', 'move', () => 'text only', 'p2', pic)).toBe('posted');
    expect(bodies[1]).toEqual({ text: 'text only' });
    expect(await postOnce(env(db), 'alert:x:p3', 'move', () => 'drawing failed', 'p3', async () => { throw new Error('no rows'); })).toBe('posted');
    expect(bodies[2]).toEqual({ text: 'drawing failed' });
    expect(uploads).toBe(2);
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

  it('posts nothing from a Worker that sends no alerts, or without all four keys', async () => {
    const db = testD1();
    const s = x();
    configureAlerts('k', false);
    expect(await postGovOnX(env(db), proposal(5))).toBe('failed');
    configureAlerts('k', true);
    expect(await postGovOnX(env(db, { X_ACCESS_SECRET: undefined }), proposal(6))).toBe('failed');
    expect(s.posts).toHaveLength(0);
  });

  it('each kind stops at its share of the day, the recap\'s share is its own, and the shares start again the next day', async () => {
    expect(X_SHARES.move + X_SHARES.gov + X_SHARES.recap).toBe(X_DAILY_MAX);
    expect(X_SHARES.recap).toBe(1);
    const db = testD1();
    const s = x();
    for (let i = 0; i < X_SHARES.move + 3; i++) await postOnce(env(db), `alert:x:test:${i}`, 'move', () => `move ${i}`, `test ${i}`);
    expect(s.posts).toHaveLength(X_SHARES.move);
    for (let i = 0; i < X_SHARES.gov + 2; i++) await postOnce(env(db), `alert:x:gov:test:${i}`, 'gov', () => `gov ${i}`, `gov ${i}`);
    expect(s.posts).toHaveLength(X_SHARES.move + X_SHARES.gov);
    // the moves and the proposals spent theirs: the recap still has its place
    t = Date.UTC(2026, 9, 29, X_RECAP_HOUR_UTC, 1);
    await postRecapOnX(env(db), async () => ({ generatedAt: t, price: { usd: { value: 0.001 } } }), t, async () => null);
    expect(s.posts).toHaveLength(X_DAILY_MAX);
    expect(s.posts.at(-1)).toMatch(/^NAM today/);
    expect(await postOnce(env(db), 'alert:x:recap:extra', 'recap', () => 'a second recap', 'extra')).toBe('full');
    // a post a share refused is not claimed: it can go tomorrow
    t += 86_400_000;
    expect(await postOnce(env(db), `alert:x:test:${X_SHARES.move}`, 'move', () => 'again', 'again')).toBe('posted');
  });

  it('X down or busy: the claim and the day\'s post are given back; a refusal keeps them', async () => {
    const db = testD1();
    let status = 503;
    const s = x(() => (status === 201 ? { status, json: { data: { id: '1' } } } : { status, json: { title: 'Service Unavailable' } }));
    expect(await postOnce(env(db), 'alert:x:k1', 'move', () => 'one', 'one')).toBe('failed');
    status = 201;
    expect(await postOnce(env(db), 'alert:x:k1', 'move', () => 'one', 'one')).toBe('posted');
    status = 403;
    expect(await postOnce(env(db), 'alert:x:k2', 'move', () => 'two', 'two')).toBe('failed');
    status = 201;
    expect(await postOnce(env(db), 'alert:x:k2', 'move', () => 'two', 'two')).toBe('claimed');
    expect(s.posts).toEqual(['one', 'one', 'two']);
    const used = await db.prepare('SELECT value FROM kv WHERE key = ?').bind('alert:x:day:2026-10-29:move').first<{ value: string }>();
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

describe('reposting @namada', () => {
  const ENV = (db: TestD1) => env(db, { X_ACCESS_TOKEN: '2115675561741951125-abc' });
  /** X as a stub for the look-up, the timeline and the reposts; `posts` is what the timeline holds, newest first. */
  function timeline(posts: () => string[], repost: (id: string) => number = () => 200) {
    const calls: { method: string; url: string; body?: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/users/by/username/namada')) return new Response(JSON.stringify({ data: { id: '999' } }));
      if (url.includes('/users/999/tweets')) {
        const since = new URL(url).searchParams.get('since_id');
        const list = posts().filter((p) => !since || BigInt(p) > BigInt(since));
        return new Response(JSON.stringify(list.length ? { data: list.map((id) => ({ id })), meta: { newest_id: list[0] } } : { meta: { result_count: 0 } }));
      }
      if (url.endsWith('/retweets')) {
        const s = repost(JSON.parse(String(init!.body)).tweet_id);
        return new Response(JSON.stringify(s === 200 ? { data: { retweeted: true } } : { title: 'err' }), { status: s });
      }
      throw new Error(url);
    }));
    return calls;
  }
  const at = (min: number) => Date.UTC(2026, 9, 29, 9, min);

  it('the first look reposts nothing old; later posts are reposted once each, oldest first, as this account', async () => {
    const db = testD1();
    let feed = ['105', '104'];
    const calls = timeline(() => feed);
    expect(await repostNamada(ENV(db), at(0))).toBe(0);
    expect(await repostNamada(ENV(db), at(5))).toBe(0); // not a look minute
    feed = ['108', '107', '106', '105', '104'];
    expect(await repostNamada(ENV(db), at(10))).toBe(3);
    expect(await repostNamada(ENV(db), at(20))).toBe(0);
    const reposts = calls.filter((c) => c.url.endsWith('/retweets'));
    expect(reposts.map((c) => c.body.tweet_id)).toEqual(['106', '107', '108']);
    expect(reposts[0].url).toBe('https://api.x.com/2/users/2115675561741951125/retweets');
    expect(calls.filter((c) => c.url.includes('/users/by/username/')).length).toBe(1);
    expect(calls.find((c) => c.url.includes('/tweets?'))!.url).toContain('exclude=replies%2Cretweets');
  });

  it('a repost X does not answer is tried again at the next look', async () => {
    const db = testD1();
    let feed = ['200'];
    let down = false;
    const calls = timeline(() => feed, () => (down ? 503 : 200));
    await repostNamada(ENV(db), at(0));
    feed = ['202', '201', '200'];
    down = true;
    expect(await repostNamada(ENV(db), at(10))).toBe(0);
    down = false;
    expect(await repostNamada(ENV(db), at(20))).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/retweets')).map((c) => c.body.tweet_id)).toEqual(['201', '201', '202']);
  });

  it('signs a request\'s query parameters with the oauth ones', async () => {
    const url = 'https://api.x.com/2/users/999/tweets?since_id=5&exclude=replies%2Cretweets';
    const h = await oauthHeader(KEYS, 'GET', url, 'n', 1700000000);
    const params = ['exclude=replies%252Cretweets', 'oauth_consumer_key=ck', 'oauth_nonce=n', 'oauth_signature_method=HMAC-SHA1', 'oauth_timestamp=1700000000', 'oauth_token=at', 'oauth_version=1.0', 'since_id=5']
      .join('&').replace(/%252C/, '%2C');
    const base = `GET&${encodeURIComponent('https://api.x.com/2/users/999/tweets')}&${encodeURIComponent(params)}`;
    expect(h).toContain(`oauth_signature="${encodeURIComponent(createHmac('sha1', 'cs&as').update(base).digest('base64'))}"`);
  });
});

describe('the kill switch (kv x.on)', () => {
  const SELLER = 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh';
  /** Every call to X, by URL; X answers as it would, so a call that is made would post. */
  function anyX() {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      calls.push(url);
      if (url.includes('/users/by/username/')) return new Response(JSON.stringify({ data: { id: '999' } }));
      if (url.includes('/tweets?')) return new Response(JSON.stringify({ data: [{ id: '501' }], meta: { newest_id: '501' } }));
      return new Response(JSON.stringify({ data: { id: '1', retweeted: true } }), { status: 201 });
    }));
    return calls;
  }
  const setOn = (db: TestD1, value: string) => insert(db, 'kv', [{ key: X_ON_KEY, value, updated_at: t }]);

  it('reads on with no row or any value but 0, off at 0, and off when it cannot be read', async () => {
    const db = testD1();
    expect(await xOn(db as any)).toBe(true);
    setOn(db, '1');
    expect(await xOn(db as any)).toBe(true);
    db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run(' 0 ', X_ON_KEY);
    expect(await xOn(db as any)).toBe(false);
    const broken = { prepare: () => { throw new Error('D1 down'); } } as any;
    expect(await xOn(broken)).toBe(false);
  });

  it('at 0 stops the hour\'s move, a proposal, the recap and the @namada reposts, claiming nothing; back on, each goes', async () => {
    const db = testD1();
    const calls = anyX();
    setOn(db, '0');
    // a move the hour would post: 1,000,000 NAM sold, worth $150, at 08:30 UTC
    insert(db, 'flows', [{ id: 'osmosis:KS1:0', chain: 'osmosis', height: 1, ts: Date.UTC(2026, 9, 29, 8, 30), tx_hash: 'KS1', kind: 'sell', from_addr: SELLER, to_addr: null, amount_num: 1_000_000, pool_id: '3005', price_usd: 0.00015, value_usd: 150, meta: JSON.stringify({ priceSource: 'spot' }) }]);
    const repostEnv = env(db, { X_ACCESS_TOKEN: '2115675561741951125-abc' });
    const hourAt = (at: number) => publicHour(db as any, at, { osmosis: 10000, namada: 10000 });
    t = Date.UTC(2026, 9, 29, 9, 20);
    expect(await postHourOnX(env(db), hourAt(t), t)).toBe('skipped');
    expect(await postGovOnX(env(db), proposal(7))).toBe('off');
    t = Date.UTC(2026, 9, 29, X_RECAP_HOUR_UTC, 20);
    await postRecapOnX(env(db), async () => ({ generatedAt: t }), t, async () => null);
    expect(await repostNamada(repostEnv, t)).toBe(0);
    expect(calls).toEqual([]);
    expect(db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'alert:x:%'").all()).toEqual([]);

    db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run('1', X_ON_KEY);
    t = Date.UTC(2026, 9, 29, 9, 20);
    expect(await postHourOnX(env(db), hourAt(t), t)).toBe('posted');
    expect(await postGovOnX(env(db), proposal(7))).toBe('posted');
    t = Date.UTC(2026, 9, 29, X_RECAP_HOUR_UTC, 20);
    await postRecapOnX(env(db), async () => ({ generatedAt: t }), t, async () => null);
    await repostNamada(repostEnv, Date.UTC(2026, 9, 29, X_RECAP_HOUR_UTC, 30));
    expect(calls.filter((u) => u === 'https://api.x.com/2/tweets')).toHaveLength(3);
    expect(calls.some((u) => u.includes('/users/by/username/namada'))).toBe(true);
  });
});

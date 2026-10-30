// Automatic X posts (worker/src/sources/x.ts): the site's own big moves, votes and a daily recap (no forum posts), each
// posted once, at most X_DAILY_MAX a day, fresh moves only, within 280 of X's weighted characters, mentioning no one,
// signed with OAuth 1.0a. Fetch is stubbed: nothing reaches X.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { testD1, type TestD1 } from './d1-sqlite';
import { configureAlerts, govCard, moveCard } from '../worker/src/sources/discord';
import { cardText, cutX, oauthHeader, postMoveOnX, postOnce, postRecapOnX, recapChart, repostNamada, recapText, xLength, xSafe, X_DAILY_MAX, X_MAX_AGE_MS, X_RECAP_HOUR_UTC } from '../worker/src/sources/x';
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
    // a bare domain is a link to X too (twitter-text 3.1.0 counts "indexer.namada.net" 23, not 18)
    expect(xLength('read from indexer.namada.net')).toBe(10 + 23);
    expect(xLength('v0.45.1 and 1.5M NAM')).toBe(20);
    // X counts the NFC form, where a few characters take more code points: क़ (U+0958) is two, and U+1D15E is two
    // of weight 2
    expect(xLength('\u0958')).toBe(2);
    expect(xLength('\u{1D15E}')).toBe(4);
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
      const tag = '@someone ＠other claim-nam.xyz';
      const text = cardText(moveCard({ ...f, fromLabel: tag, fromLabelPlain: tag, toLabel: tag, toLabelPlain: tag } as Flow, { whaleNam: 10000, validatorName: 'stake-nam.io ﹫val' }));
      expect(xLength(text), k).toBeLessThanOrEqual(280);
      expect(text, k).not.toMatch(/https?:\/\//);
      expect(text, k).not.toMatch(/claim-nam|stake-nam/);
      expect(text, k).not.toMatch(/[@＠﹫]\w/);
      expect(text, k).toMatch(/UTC/);
    }
  });

  it('text an outsider wrote keeps no link X would make and mentions no one; numbers and short forms stay', () => {
    const out: [string, string][] = [
      ['Claim at https://claim-nam.xyz/airdrop now', 'Claim at [link removed] now'],
      ['Visit claim-nam.xyz/airdrop.', 'Visit [link removed].'],
      ['(www.claim.xyz), then vote', '([link removed]), then vote'],
      ['CLAIM.XYZ:8080/a?b=c', '[link removed]'],
      ['ftp://claim.xyz and http://1.2.3.4/x', '[link removed] and [link removed]'],
      // the forms a browser reads as a full stop, two that only look like one, and a domain in other scripts or in
      // punycode
      ['claim。xyz claim．xyz claim｡xyz claim․xyz claim﹒xyz', Array(5).fill('[link removed]').join(' ')],
      ['пример.рф 例子.中国 xn--e1afmkfd.xn--p1ai ｃｌａｉｍ．ｘｙｚ', Array(4).fill('[link removed]').join(' ')],
      // a character that shows nothing cannot hide one
      ['claim​.xyz claim.⁠xyz cl‍aim.xyz ‮zyx.mialc claim.͏xyz', Array(5).fill('[link removed]').join(' ')],
      ['@namada ＠namada ﹫namada user@claim.xyz', '(at)namada (at)namada (at)namada user(at)[link removed]'],
      ['claim.xyz…', '[link removed]…'],
      // a word that only looks like a domain goes too, so that no cut of what is left can end in one ("x.co…")
      ['x.co1 and cap.Then', '[link removed]1 and [link removed]'],
      ['Raise the cap to 1,500,000.5 NAM in v0.45.1, e.g. 1.5M by a.m. U.S.A. time', 'Raise the cap to 1,500,000.5 NAM in v0.45.1, e.g. 1.5M by a.m. U.S.A. time'],
      ['Tag by tnam1qauthor…', 'Tag by tnam1qauthor…'],
    ];
    for (const [s, want] of out) expect(xSafe(s), s).toBe(want);
    // the two characters X refuses a post for go with the invisible ones, and the text is left in the form X counts
    expect(xSafe('Whale \uFFFF\uFFFE')).toBe('Whale ');
    expect(xSafe('\u0958'.repeat(3))).toBe('\u0915\u093C'.repeat(3));
  });

  it('a proposal\'s title, a wallet\'s tag, a validator\'s name and a bridge receiver\'s text reach X without their links', () => {
    const prop = (title: string) => ({ id: 42, title, authors: null, abstract: null, type: 'default', status: 'votingPeriod', startEpoch: 1, endEpoch: 9, activationEpoch: 10, yayNam: 1_000_000, nayNam: 2_000, abstainNam: 0, discussionsUrl: null }) as GovernanceProposal;
    const gov = cardText(govCard(prop('Claim your NAM at claim-nam.xyz ＠namada'), true));
    expect(gov).toContain('Claim your $NAM at [link removed] (at)namada');
    expect(gov).not.toMatch(/claim-nam|＠/);
    // the record's source is the site's own words, and X counts its domain 23: a long title still fits as X counts
    expect(gov).toContain('indexer.namada.net');
    // a title of characters X counts longer (NFC) still fits as X counts, and is posted in that form
    for (const title of ['\u095C'.repeat(250), '\u{1D15E}'.repeat(125)]) {
      const text = cardText(govCard(prop(title), true));
      expect(text, title.slice(0, 2)).toBe(text.normalize('NFC'));
      expect(xLength(text), title.slice(0, 2)).toBeLessThanOrEqual(280);
    }
    // a long title gives way, never the record: a cut there could leave another domain ("indexer.namada.ne…")
    for (let n = 150; n <= 250; n++) {
      const text = cardText(govCard(prop('A'.repeat(n)), true));
      expect(xLength(text), String(n)).toBeLessThanOrEqual(280);
      expect(text.endsWith('status and votes as read from indexer.namada.net'), String(n)).toBe(true);
    }

    const staker = 'tnam1qstaker' + '0'.repeat(35);
    const unbond = { id: 'namada:U:0', chain: 'namada', height: 5, ts: t - 60_000, txHash: 'U', kind: 'unbond', from: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to: staker, amount: 50_000, meta: { validator: 'tnam1qvalidator' }, toLabel: 'Airdrop at claim-nam.xyz', toLabelPlain: 'Airdrop at claim-nam.xyz', toLabelSource: 'user', toLabelAuthor: 'tnam1qauthor…' } as unknown as Flow;
    const move = cardText(moveCard(unbond, { whaleNam: 10000, validatorName: 'Stake at stake-nam.io' }));
    expect(move).toContain('By Airdrop at [link removed]');
    expect(move).toContain('Tag by tnam1qauthor…');
    expect(move).toContain('from validator Stake at [link removed]');
    expect(move).not.toMatch(/claim-nam|stake-nam/);

    // an Osmosis receiver is free text: a domain typed there is shown as text that is no address, and still no link
    const out = { id: 'namada:B:0', chain: 'namada', height: 6, ts: t - 60_000, txHash: 'B', kind: 'ibc_out', from: staker, to: 'claim-nam.xyz', amount: 50_000, meta: null } as unknown as Flow;
    const crossing = cardText(moveCard(out, { whaleNam: 10000 }));
    expect(crossing).toContain('[link removed] (not an address)');
    expect(crossing).not.toMatch(/claim-nam/);
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
    expect(await postOnce(env(db), 'alert:x:p1', () => 'with picture', 'p1', pic)).toBe('posted');
    expect(bodies[0]).toEqual({ text: 'with picture', media: { media_ids: ['777'] } });
    uploadOk = false;
    expect(await postOnce(env(db), 'alert:x:p2', () => 'text only', 'p2', pic)).toBe('posted');
    expect(bodies[1]).toEqual({ text: 'text only' });
    expect(await postOnce(env(db), 'alert:x:p3', () => 'drawing failed', 'p3', async () => { throw new Error('no rows'); })).toBe('posted');
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

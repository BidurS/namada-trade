// Automatic X posts (worker/src/sources/x.ts): the site's own moves (one a closed hour, and the hour's crossing:
// test/public-posts.test.ts), votes and a daily recap (no forum posts), each posted once, each kind under its own share
// of the day (the recap's share its own), within 280 of X's weighted characters, mentioning no one, signed with OAuth
// 1.0a, and nothing at all while kv x.on is '0', with @namada's posts of that time never reposted after. Fetch is
// stubbed: nothing reaches X.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { configureAlerts, govCard, moveCard, resetClaimMemory } from '../worker/src/sources/discord';
import { cardText, cutX, govRecord, oauthHeader, postGovOnX, postHourOnX, postOnce, postRecapOnX, recapChart, repostNamada, recapText, xLength, xOn, xSafe, X_DAILY_MAX, X_MAX_AGE_MS, X_ON_KEY, X_RECAP_HOUR_UTC, X_SHARES } from '../worker/src/sources/x';
import { publicHour } from '../worker/src/public-posts';
import { rowToFlow } from '../worker/src/analytics';
import type { Flow, GovernanceProposal } from '../shared/types';

const KEYS = { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
const env = (db: TestD1, extra: object = {}) => ({ DB: db, ...KEYS, ...extra }) as any;
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
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
const prop = (title: string, discussionsUrl: string | null = null) => ({ id: 42, title, authors: null, abstract: null, type: 'default', status: 'votingPeriod', startEpoch: 1, endEpoch: 9, activationEpoch: 10, yayNam: 1_000_000, nayNam: 2_000, abstainNam: 0, discussionsUrl }) as GovernanceProposal;
const whale = (n: number, extra: Partial<Flow> = {}): Flow =>
  ({ id: `osmosis:XW${n}:0`, chain: 'osmosis', height: 100 + n, ts: t - 60_000, txHash: `XW${n}`, kind: 'sell', from: 'osmo1sellerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', to: null, amount: 50_000, meta: null, ...extra }) as unknown as Flow;
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
      const tag = '@someone ＠other claim-nam.xyz #airdrop $SCAM';
      const text = cardText(moveCard({ ...f, fromLabel: tag, fromLabelPlain: tag, toLabel: tag, toLabelPlain: tag } as Flow, { whaleNam: 10000, validatorName: 'stake-nam.io ﹫val' }));
      expect(xLength(text), k).toBeLessThanOrEqual(280);
      expect(text, k).not.toMatch(/https?:\/\//);
      expect(text, k).not.toMatch(/claim-nam|stake-nam/);
      expect(text, k).not.toMatch(/[@＠﹫]\w|#airdrop|\$SCAM/);
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
      ['claim\u200B.xyz claim.\u2060xyz cl\u200Daim.xyz \u202Ezyx.mialc claim.\u034Fxyz', Array(5).fill('[link removed]').join(' ')],
      ['@namada ＠namada ﹫namada user@claim.xyz', '(at)namada (at)namada (at)namada user(at)[link removed]'],
      ['claim.xyz…', '[link removed]…'],
      // a word that only looks like a domain goes too, so that no cut of what is left can end in one ("x.co…")
      ['x.co1 and cap.Then', '[link removed]1 and [link removed]'],
      ['Raise the cap to 1,500,000.5 NAM in v0.45.1, e.g. 1.5M by a.m. U.S.A. time', 'Raise the cap to 1,500,000.5 NAM in v0.45.1, e.g. 1.5M by a.m. U.S.A. time'],
      ['Tag by tnam1qauthor…', 'Tag by tnam1qauthor…'],
      // a hashtag or cashtag loses its signs, before the links are read; a figure, a keycap or a sign inside a word stays
      ['#airdrop ##nam #$SCAM ＃tag ＄SCAM $scam.ab', 'airdrop nam SCAM tag SCAM [link removed]'],
      ['a.#co claim.$xyz', '[link removed] [link removed]'],
      // a link taken out leaves no tag behind it
      ['claim.xyz＃airdrop claim.xyz$SCAM', '[link removed] [link removed]'],
      ['$0.0012, #42, $12 million, #\uFE0F\u20E3', '$0.0012, #42, $12 million, #\uFE0F\u20E3'],
      // whatever stands before the sign: X reads a tag after an emoji's variation selector, "²", "½", or a letter newer
      // than its tables, and a sign inside a word costs only the sign
      ['\u2764\uFE0F#airdrop \u00B2#SCAM NAM\u00BD#airdrop \u0560#ab café#latte #\uF870', '\u2764\uFE0Fairdrop \u00B2SCAM NAM\u00BDairdrop \u0560ab cafélatte \uF870'],
    ];
    for (const [s, want] of out) expect(xSafe(s), s).toBe(want);
    // the two characters X refuses a post for go with the invisible ones, and the text is left in the form X counts
    expect(xSafe('Whale \uFFFF\uFFFE')).toBe('Whale ');
    expect(xSafe('\u0958'.repeat(3))).toBe('\u0915\u093C'.repeat(3));
  });

  it('a proposal\'s title, a wallet\'s tag, a validator\'s name and a bridge receiver\'s text reach X without their links', () => {
    const post = (p: GovernanceProposal) => cardText(govCard(p, true), t, govRecord(p));
    const gov = post(prop('Claim your NAM at claim-nam.xyz ＠namada #airdrop $SCAM'));
    expect(gov).toContain('Claim your $NAM at [link removed] (at)namada airdrop SCAM');
    expect(gov).not.toMatch(/claim-nam|＠|#airdrop|\$SCAM/);
    // the site's $NAM never becomes a longer cashtag from the words after it
    expect(post(prop('Raise NAM.x cap'))).toContain('Raise NAM.x cap');
    // the record sends readers to the chain, and to the forum when the proposal is discussed there, in words: no
    // domain, so no link (X bills a post with one at $0.20, not $0.015)
    expect(gov.endsWith('· votes on-chain, read from the Namada indexer')).toBe(true);
    expect(gov).not.toContain('namada.net');
    expect(post(prop('Raise the cap', 'https://forum.namada.net/t/raise-the-cap/123')).endsWith('votes on-chain, read from the Namada indexer · discussion on the Namada forum')).toBe(true);
    expect(post(prop('Raise the cap', 'https://claim-nam.xyz/forum.namada.net'))).not.toContain('forum');
    // a title of characters X counts longer (NFC) still fits as X counts, and is posted in that form
    for (const title of ['\u095C'.repeat(250), '\u{1D15E}'.repeat(125)]) {
      const text = post(prop(title));
      expect(text, title.slice(0, 2)).toBe(text.normalize('NFC'));
      expect(xLength(text), title.slice(0, 2)).toBeLessThanOrEqual(280);
    }
    // a long title gives way, never the record
    for (let n = 150; n <= 250; n++) {
      const text = post(prop('A'.repeat(n), 'https://forum.namada.net/t/1'));
      expect(xLength(text), String(n)).toBeLessThanOrEqual(280);
      expect(text.endsWith('votes on-chain, read from the Namada indexer · discussion on the Namada forum'), String(n)).toBe(true);
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

  it('posts a proposal with its record in words and no link, once per status', async () => {
    const db = testD1();
    const s = x();
    const p = prop('Raise the cap, see claim-nam.xyz', 'https://forum.namada.net/t/raise-the-cap/123');
    await postGovOnX(env(db), p, true);
    await postGovOnX(env(db), p, true);
    expect(s.posts).toEqual([cardText(govCard(p, true), t, govRecord(p))]);
    expect(s.posts[0]).not.toMatch(/https?:\/\/|namada\.net|claim-nam/);
    expect(s.posts[0].endsWith('discussion on the Namada forum')).toBe(true);
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
    expect(X_SHARES.move + X_SHARES.ibc + X_SHARES.gov + X_SHARES.recap).toBe(X_DAILY_MAX);
    expect(X_SHARES.recap).toBe(1);
    const db = testD1();
    const s = x();
    for (let i = 0; i < X_SHARES.move + 3; i++) await postOnce(env(db), `alert:x:test:${i}`, 'move', () => `move ${i}`, `test ${i}`);
    expect(s.posts).toHaveLength(X_SHARES.move);
    // the crossings' share is their own: the moves spent theirs, the crossings still post, to their own share
    for (let i = 0; i < X_SHARES.ibc + 2; i++) await postOnce(env(db), `alert:x:ibc:test:${i}`, 'ibc', () => `crossing ${i}`, `crossing ${i}`);
    expect(s.posts).toHaveLength(X_SHARES.move + X_SHARES.ibc);
    for (let i = 0; i < X_SHARES.gov + 2; i++) await postOnce(env(db), `alert:x:gov:test:${i}`, 'gov', () => `gov ${i}`, `gov ${i}`);
    expect(s.posts).toHaveLength(X_SHARES.move + X_SHARES.ibc + X_SHARES.gov);
    // the moves, the crossings and the proposals spent theirs: the recap still has its place
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

  it('what @namada posted while the switch was off is never reposted once it is back on; posts after it are', async () => {
    const db = testD1();
    const ENV = env(db, { X_ACCESS_TOKEN: '2115675561741951125-abc' });
    let feed = ['105', '104'];
    const calls: { url: string; id?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, id: init?.body ? JSON.parse(String(init.body)).tweet_id : undefined });
      if (url.includes('/users/by/username/namada')) return new Response(JSON.stringify({ data: { id: '999' } }));
      if (url.includes('/users/999/tweets')) {
        const since = new URL(url).searchParams.get('since_id');
        const list = feed.filter((p) => !since || BigInt(p) > BigInt(since));
        return new Response(JSON.stringify(list.length ? { data: list.map((id) => ({ id })), meta: { newest_id: list[0] } } : { meta: { result_count: 0 } }));
      }
      return new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 });
    }));
    const at = (h: number, min: number) => Date.UTC(2026, 9, 29, h, min);
    const reposted = () => calls.filter((c) => c.url.endsWith('/retweets')).map((c) => c.id);
    // on: the first look records where the posts stand
    expect(await repostNamada(ENV, at(9, 0))).toBe(0);
    expect(kv(db, 'x.repost.since')).toBe('105');
    // @namada posts something the owner turns the switch off for, at a minute that is no look minute
    feed = ['106', '105', '104'];
    setOn(db, '0');
    const asked = calls.length;
    expect(await repostNamada(ENV, at(9, 3))).toBe(0);
    expect(kv(db, 'x.repost.since')).toBeNull();
    // hours later, more posts while off; then the switch is back on
    feed = ['107', '106', '105', '104'];
    expect(await repostNamada(ENV, at(11, 0))).toBe(0);
    expect(calls.length, 'X is not asked while off').toBe(asked);
    db.raw.prepare('UPDATE kv SET value = ? WHERE key = ?').run('1', X_ON_KEY);
    // the first look back on only records where the posts stand: 106 and 107 are not reposted
    expect(await repostNamada(ENV, at(11, 10))).toBe(0);
    expect(kv(db, 'x.repost.since')).toBe('107');
    feed = ['108', '107', '106', '105', '104'];
    expect(await repostNamada(ENV, at(11, 20))).toBe(1);
    expect(reposted()).toEqual(['108']);
  });

  it('a switch that cannot be read reposts nothing and keeps the cursor', async () => {
    const db = testD1();
    insert(db, 'kv', [{ key: 'x.repost.since', value: '105', updated_at: t }]);
    const calls = anyX();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql === 'SELECT value FROM kv WHERE key = ?') throw new Error('D1 down');
      return prepare(sql);
    });
    expect(await repostNamada(env(db, { X_ACCESS_TOKEN: '2115675561741951125-abc' }), Date.UTC(2026, 9, 29, 9, 10))).toBe(0);
    expect(calls).toEqual([]);
    spy.mockRestore();
    expect(kv(db, 'x.repost.since')).toBe('105');
  });
});

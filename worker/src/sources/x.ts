// Posts on X (@ the owner's account), automatically: at most one move a closed UTC hour, the hour's largest by dollars
// (public-posts.ts, the selector the public Telegram channel shares: from PUBLIC_POST_USD_MIN and the chain's whale
// size, no bot round trips or rewards claims), and beside it the hour's largest bridge crossing when its move is no
// crossing, new and changed governance proposals, and a daily recap at 13:00 UTC with the daily digest's price chart
// (owner's choices, 2026-10-29). Forum topics and replies are not posted (owner, 2026-10-29): any forum account writes
// them, links and bare domains included, and the post would carry them under the site's name.
//
// A move's post is built from the selector's allowlist of its fields (public-posts.ts PublicMove), so no memo, label,
// tag or bridge receiver text reaches X. The one outsider text posted is a proposal's title, through xSafe (cardText);
// the card's author, abstract and link are not posted, and its record is govRecord's words.
//
// X's API is paid per call (https://docs.x.com/x-api/getting-started/pricing: $0.015 a post, $0.20 a post with a
// link, checked 2026-10-29), so only the recap carries a link; an alert names the move, its figures and their source
// in words, a proposal's post sends readers to the chain and the forum in words (owner, 2026-10-29: govRecord), and
// the profile links the site. Each kind of post has its own share of a UTC day (X_SHARES), so moves, crossings and
// proposals never take one another's place or the recap's, and a move older than X_MAX_AGE_MS when it is offered is
// not posted: the account reads as live. kv `x.on` = '0' stops every post, the recap and the @namada reposts included
// (xSwitch), and @namada's posts made while it was off are never reposted.
//
// Each post is claimed once (`alert:x:` keys, swept with the other claims: auth.ts sweepAuth). An answer that is no
// answer, a 5xx or a 429 gives the claim back, so the post is tried again (a proposal at the cron's next run: postOnce
// 'again'); a refusal (401/403: the keys, 402: no credits, 400: the text) is not tried again, and kv `x.last` records it
// for the health view. Text an outsider wrote (a proposal's title, the one such text posted) carries no link, mentions
// no one and tags nothing (xSafe): a link, a bare domain or a word holding a host written as four numbers is
// "[link removed]", an @ "(at)", and a hashtag or cashtag loses its sign.
//
// The keys are the owner's X app's (OAuth 1.0a, Read and Write): X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
// X_ACCESS_SECRET, set by scripts/x-connect.sh at hidden prompts. Without all four nothing is posted.
import type { GovernanceProposal } from '../../../shared/types';
import { SITE } from '../../../shared/site';
import { kvSet } from '../db';
import { holdsNumericHost, safeHttpUrl } from '../../../shared/flow-rules';
import { alertsOn, claimDiscordAlert, fits, govCard, releaseClaims, type Card, type GovContext } from './discord';
import { mdToPlain } from './telegram';
import { claimTaken, hourPick, publicRecord, publicTitle, publicValue, publicWho, publicWhy, type HourPart, type PublicHour, type PublicMove } from '../public-posts';
import { CHART_MINUTE_BOUND_MS, readChartRows, shapePriceChart, type ChartContext } from '../digest/charts/read';
import { isNotRead, priceChart, toPng } from '../digest/charts/charts';

export interface XEnv { DB: D1Database; X_API_KEY?: string; X_API_SECRET?: string; X_ACCESS_TOKEN?: string; X_ACCESS_SECRET?: string }

const POST_URL = 'https://api.x.com/2/tweets';
/** A call X does not answer within this long is given up. */
export const X_TIMEOUT_MS = 5000;
/** The most posts a UTC day, the recap included: about $0.40 a day at most. */
export const X_DAILY_MAX = 15;
/**
 * Each kind of post's share of X_DAILY_MAX, counted apart (`alert:x:day:<date>:<kind>`): the hours' moves (at most one
 * an hour, public-posts.ts), the hours' bridge crossings (HourPart 'ibc': one an hour at most, when the hour's move is
 * no crossing), the proposals, and the recap's one, which nothing else can take.
 */
export const X_SHARES = { move: 9, ibc: 2, gov: 3, recap: 1 } as const;
export type XShare = keyof typeof X_SHARES;
/** A move older than this when offered is not posted. */
export const X_MAX_AGE_MS = 2 * 3_600_000;
/** The recap's hour, UTC (the marketing pack's suggested time: mornings in both the US and Europe). */
export const X_RECAP_HOUR_UTC = 13;
/** X's limit, in its weighted characters (twitter-text: most Latin text weighs 1, other scripts and emoji 2). */
export const X_MAX = 280;

/** Whether this Worker posts on X: it sends alerts (SEND_ALERTS) and has all four keys. */
export const postsOnX = (env: XEnv): boolean => alertsOn() && !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);

/** The kill switch's kv key. */
export const X_ON_KEY = 'x.on';
/**
 * The kill switch: kv `x.on` holding '0' stops every post on X, the moves, the proposals, the recap and the @namada
 * reposts ('off'), and what was offered while it was off is not posted once it is on again; anything else, or no row,
 * leaves posting on ('on'). A read that fails ('unread') posts nothing this time, and claims nothing, so the post is
 * offered again (postOnce 'again': the hour and the recap at the next tick, a proposal at the cron's next run).
 */
export async function xSwitch(db: D1Database): Promise<'on' | 'off' | 'unread'> {
  try {
    const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(X_ON_KEY).first<{ value: string }>();
    return r?.value == null || String(r.value).trim() !== '0' ? 'on' : 'off';
  } catch {
    return 'unread';
  }
}
/** Whether X may be posted to now: the kill switch read, and on (xSwitch). */
export const xOn = async (db: D1Database): Promise<boolean> => (await xSwitch(db)) === 'on';

// ---------------------------------------------------------------- the text

/** One character's weight as X counts it (twitter-text v3: these ranges weigh 1, everything else 2). */
const weight = (cp: number) => (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2);

/**
 * A full stop between a domain's parts: the ASCII one, the three a browser maps to it (UTS 46: 。．｡), and two that
 * only look like one (․ ﹒).
 */
const DOT = '[.\\u2024\\u3002\\uFE52\\uFF0E\\uFF61]';
/** A part of a domain, in any script (an address may be written in Cyrillic or Chinese). */
const PART = '[\\p{L}\\p{N}\\p{M}_-]+';
/**
 * A link as X makes one, and more: any scheme ("https://…"), or a bare domain with or without a path ("claim-nam.xyz",
 * "www.claim.xyz/airdrop", "пример.рф", "xn--e1afmkfd.xn--p1ai"). Its last part starts with two letters, so a number
 * ("1.5", "v0.45.1") is not one; a word that only looks like a domain ("cap.Then", "x.co1") is read as one too, which
 * costs a word, never a link, and means no cut of a text it left can end in one ("x.co…").
 */
const LINK = new RegExp(`[a-z][a-z0-9+.-]*:\\/\\/\\S*|${PART}(?:${DOT}${PART})*${DOT}(?:xn--[a-z0-9-]+|\\p{M}*\\p{L}[\\p{L}\\p{M}]+)(?::\\d+)?(?:[/?#]\\S*)?`, 'giu');
/**
 * A hashtag's or cashtag's signs: before a word holding a letter or mark (twitter-text 3.1.0 also counts private-use
 * characters, and its few joining ones, · ・ ～…), never a keycap ("#️⃣"). Whatever stands before the sign: X's own
 * boundary takes an emoji's variation selector, "²" or a letter newer than its tables, so a sign inside a word goes
 * too ("café#latte" is "cafélatte"), which costs a sign, never a tag.
 */
const TAG = /[#＃$＄]+(?![\uFE0F\u20E3])(?=[\p{L}\p{M}\p{N}\p{Co}_\u00B7\u05BE\u05F3\u05F4\u0F0B\u0F0C\u3003\u301C\u309B\u309C\u30A0\u30FB\uA67E\uFF5E]*[\p{L}\p{M}\p{Co}])/gu;
/**
 * Characters that show nothing (zero-width spaces and joiners, direction marks), one of which could hide a link from
 * LINK, and the two X refuses a post for (U+FFFE, U+FFFF): a post that holds one is never made.
 */
const INVISIBLE = /[\p{Cf}\uFFFE\uFFFF]/gu;

/**
 * A text's length as X counts it, or more, never less: X counts the text's NFC form (a few characters take more code
 * points there: "क़" is two), a link counts 23 whatever its length, and so does whatever else LINK reads as one (a
 * bare domain, and a word that only looks like one).
 */
export function xLength(s: string): number {
  let n = 0;
  const rest = s.normalize('NFC').replace(LINK, () => { n += 23; return ''; });
  for (const ch of rest) n += weight(ch.codePointAt(0)!);
  return n;
}
/** Cut to `max` weighted characters, with "…" (which weighs 2) at the end when anything was cut. */
export function cutX(s: string, max = X_MAX): string {
  if (xLength(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (xLength(out + ch) > max - 2) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}
/** What a link left out of a post reads as. */
export const X_LINK_WORDS = '[link removed]';
/**
 * Text an outsider wrote (a proposal's title, a wallet's tag, a validator's name, a bridge receiver's free text) as a
 * post carries it: no link and no bare domain (each is X_LINK_WORDS, the punctuation after it kept), no word holding a
 * host written as four numbers (shared/flow-rules.ts holdsNumericHost: the word is X_LINK_WORDS, the brackets and
 * punctuation around it kept), no one mentioned
 * (an @ and its wide form ＠, which X reads as one, and the small ﹫, which only looks like one, are written "(at)"),
 * and nothing tagged: a hashtag ("#airdrop") or cashtag ("$SCAM") is its word without its signs (TAG), so the post is
 * never listed under it; a figure ("$0.0012", "#42", "$12 million") is no tag and keeps its sign, and the site's own
 * prices never put a letter after one. Invisible characters go first, then the
 * text is put in the NFC form X counts.
 */
export function xSafe(s: string): string {
  // a tag's signs go before the links are read, since taken out after they could join two pieces into one ("a.#co");
  // the second pass is a backstop for a sign the replacements leave before a word (none is known). A word holding a
  // four-number host goes whole, before the links are read, so no link is left in pieces ("claim.xyz/?ip=1.2.3.4").
  const trail = (m: string) => /[.,;:!?'")\]}»”’]+$/.exec(m)?.[0] ?? '';
  const host = (w: string) => (holdsNumericHost(w) ? (/^[({"'«“‘]+/.exec(w)?.[0] ?? '') + X_LINK_WORDS + trail(w) : w);
  return s.replace(INVISIBLE, '').normalize('NFC')
    .replace(TAG, '')
    .replace(/\S+/g, host)
    .replace(LINK, (m) => X_LINK_WORDS + trail(m))
    .replace(/[@＠﹫]/g, '(at)')
    .replace(TAG, '');
}

/**
 * A card as a post: the title, the first paragraph (who moved it and the price, or a proposal's votes) and the record
 * it comes from (the card's footer, or `record` in its place), without links, in X's 280.
 */
export function cardText(card: Card, now = Date.now(), record?: string): string {
  const e = fits(card);
  const first = mdToPlain((e.description ?? '').split('\n\n')[0], now).replace(/\s+/g, ' ').trim();
  record ??= (e.footer?.text ?? '').replace(/^NamadaTrade · /, '');
  const when = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  const tail = [when, record].filter(Boolean).join(' · ');
  // the tail, where the figures come from, is kept whole: the opening words give way first, then the title
  const tailRoom = tail ? xLength(tail) + 2 : 0;
  // $NAM once, in the title (a cashtag: X lists the post under the coin), never where X would read a longer one from
  // the words after it ("NAM.x" would be the cashtag $NAM.x)
  const head = cutX(xSafe(e.title ?? '').replace(/(^|\s)NAM\b(?![._][A-Za-z])/, '$1$$NAM'), X_MAX - tailRoom);
  const body = xSafe(first);
  const room = X_MAX - xLength(head) - tailRoom - 2;
  return cutX([head, room > 20 && body ? cutX(body, room) : '', tail].filter(Boolean).join('\n\n'));
}

// ---------------------------------------------------------------- signing (OAuth 1.0a, HMAC-SHA1)

/** RFC 3986 percent-encoding, as OAuth 1.0a asks. */
const pct = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/**
 * The Authorization header of a request to `url`: its query parameters are signed with the oauth ones, the URL
 * without them; a JSON or multipart body is not part of the signature.
 */
export async function oauthHeader(env: Required<Omit<XEnv, 'DB'>>, method: string, url: string, nonce = crypto.randomUUID().replace(/-/g, ''), ts = Math.floor(Date.now() / 1000)): Promise<string> {
  const o: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(ts), oauth_token: env.X_ACCESS_TOKEN, oauth_version: '1.0',
  };
  const u = new URL(url);
  const signed: [string, string][] = [...Object.entries(o), ...u.searchParams.entries()].map(([k, v]) => [pct(k), pct(v)]);
  signed.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const params = signed.map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${method.toUpperCase()}&${pct(`${u.origin}${u.pathname}`)}&${pct(params)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${pct(env.X_API_SECRET)}&${pct(env.X_ACCESS_SECRET)}`), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  o.oauth_signature = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)));
  return 'OAuth ' + Object.keys(o).sort().map((k) => `${pct(k)}="${pct(o[k])}"`).join(', ');
}

// ---------------------------------------------------------------- posting

/** X's answer to one post: its status, and its id when taken. Never logged with the keys. */
export interface XAnswer { ok: boolean; status: number; id?: string; detail?: string }

export async function xPost(env: XEnv, text: string, mediaIds: string[] = []): Promise<XAnswer> {
  try {
    const auth = await oauthHeader(env as Required<Omit<XEnv, 'DB'>>, 'POST', POST_URL);
    const body = { text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) };
    const res = await fetch(POST_URL, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(X_TIMEOUT_MS) });
    const j = (await res.json().catch(() => null)) as any;
    return { ok: res.ok && !!j?.data?.id, status: res.status, id: j?.data?.id, detail: typeof j?.detail === 'string' ? j.detail.slice(0, 200) : typeof j?.title === 'string' ? j.title : undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}

const UPLOAD_URL = 'https://api.x.com/2/media/upload';
/** A picture upload may take longer than a post. */
export const X_UPLOAD_TIMEOUT_MS = 15_000;
/**
 * Uploads a PNG for a post (POST /2/media/upload, multipart: `media` and media_category tweet_image; the form's fields
 * are not part of an OAuth 1.0a signature): its media id, or null when X did not take it (the post then goes without).
 */
export async function xUpload(env: XEnv, png: Uint8Array): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('media_category', 'tweet_image');
    form.append('media', new Blob([png], { type: 'image/png' }), 'chart.png');
    const auth = await oauthHeader(env as Required<Omit<XEnv, 'DB'>>, 'POST', UPLOAD_URL);
    const res = await fetch(UPLOAD_URL, { method: 'POST', headers: { authorization: auth }, body: form, signal: AbortSignal.timeout(X_UPLOAD_TIMEOUT_MS) });
    const j = (await res.json().catch(() => null)) as any;
    const id = j?.data?.id ?? j?.media_id_string;
    if (res.ok && typeof id === 'string') return id;
    console.error(`x: the picture was not taken (${res.status}${j?.detail ? `: ${String(j.detail).slice(0, 200)}` : ''})`);
    return null;
  } catch (e) {
    console.error('x: the picture was not uploaded', e);
    return null;
  }
}

/** An answer that says nothing of the post: none, a 5xx, or a 429 (X busy, or the app's limit). */
const transient = (a: XAnswer) => a.status === 0 || a.status >= 500 || a.status === 429;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

/** The counter of one kind's posts on the UTC day of `now`. */
const dailyKey = (now: number, share: XShare) => `alert:x:day:${day(now)}:${share}`;
/** Takes one of the day's posts of a kind (X_SHARES), in one statement: false when that kind's posts are spent. */
async function takeDaily(db: D1Database, now: number, share: XShare): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?1, '1', ?2)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(kv.value AS INTEGER) + 1 AS TEXT), updated_at = ?2 WHERE CAST(kv.value AS INTEGER) < ?3`,
  ).bind(dailyKey(now, share), now, X_SHARES[share]).run();
  return Number(r.meta?.changes ?? 0) > 0;
}
const giveBackDaily = (db: D1Database, now: number, share: XShare) =>
  db.prepare(`UPDATE kv SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = ? AND CAST(value AS INTEGER) > 0`).bind(dailyKey(now, share)).run().catch(() => {});

/**
 * Posts `text` under claim `key` (each of the keys, when several: claimed together before the post, so whatever stops
 * the run after X took it, the post is not made again) and one of the day's posts of its kind (`share`). Never throws.
 * While the kill switch is off (xSwitch) nothing is claimed or posted ('off'). 'again': nothing was posted and the
 * claims and the day's post were given back, for a later offer (X gave no answer, a 5xx or a 429; the switch or the
 * day's count could not be read). A refusal keeps them, and is recorded ('failed').
 */
export async function postOnce(env: XEnv, key: string | string[], share: XShare, text: () => Promise<string> | string, what: string, picture?: () => Promise<Uint8Array | null>): Promise<'posted' | 'claimed' | 'full' | 'off' | 'again' | 'failed'> {
  try {
    if (!postsOnX(env)) return 'failed';
    const on = await xSwitch(env.DB);
    if (on !== 'on') return on === 'off' ? 'off' : 'again';
    const keys = [key].flat();
    for (const [i, k] of keys.entries()) {
      if (!(await claimDiscordAlert(env.DB, [k]))) { if (i) await releaseClaims(env.DB, keys.slice(0, i)); return 'claimed'; }
    }
    const now = Date.now();
    let took: boolean;
    try { took = await takeDaily(env.DB, now, share); } catch (e) {
      // the day's count could not be read: nothing was posted, so the claims go back for a later tick
      console.error(`x: ${what}: the day's posts not counted`, e);
      await releaseClaims(env.DB, keys);
      return 'again';
    }
    if (!took) { await releaseClaims(env.DB, keys); return 'full'; }
    let body: string;
    try { body = await text(); } catch (e) {
      // the text could not be read (the recap's overview): nothing was posted, so the claim and the day's post go back
      console.error(`x: ${what} not built`, e);
      await releaseClaims(env.DB, keys);
      await giveBackDaily(env.DB, now, share);
      return 'failed';
    }
    // a picture that cannot be drawn or uploaded never costs the post: it goes as text
    const png = picture ? await picture().catch((e) => { console.error(`x: ${what}: the picture was not drawn`, e); return null; }) : null;
    const media = png ? await xUpload(env, png) : null;
    const a = await xPost(env, body, media ? [media] : []);
    await kvSet(env.DB, 'x.last', JSON.stringify({ at: now, what, status: a.status, ok: a.ok, ...(a.detail ? { detail: a.detail } : {}) })).catch(() => {});
    if (a.ok) return 'posted';
    console.error(`x: ${what} not posted (${a.status}${a.detail ? `: ${a.detail}` : ''})`);
    if (!transient(a)) return 'failed';
    await releaseClaims(env.DB, keys);
    await giveBackDaily(env.DB, now, share);
    return 'again';
  } catch (e) {
    console.error(`x: ${what} not posted`, e);
    return 'failed';
  }
}

/**
 * The hour's move (or crossing: `part`) as a post: the title with the $NAM cashtag (X lists the post under the coin),
 * who moved it and the dollars with their source, why it was chosen, then the move's time (UTC: the post's own date is
 * X's) and record, all from the allowlisted fields (public-posts.ts PublicMove). The title and the tail are kept
 * whole; the why line gives way first, then the text.
 */
export function hourText(m: PublicMove, passed = false, part: HourPart = 'move'): string {
  // built from the move's own fields only (public-posts.ts), and still read as cardText reads a card (xSafe, the $NAM rule)
  const head = xSafe(publicTitle(m)).replace(/(^|\s)NAM\b(?![._][A-Za-z])/, '$1$$NAM');
  const body = xSafe(`${publicWho(m)}. ${publicValue(m)}`);
  const tail = `${new Date(m.ts).toISOString().slice(11, 16)} UTC · ${publicRecord(m)}`;
  const whole = [head, body, `${publicWhy(null, passed, part)}.`, tail].join('\n\n');
  if (xLength(whole) <= X_MAX) return whole;
  const room = X_MAX - xLength(head) - xLength(tail) - 4;
  return cutX([head, room > 20 ? cutX(body, room) : '', tail].filter(Boolean).join('\n\n'));
}

/**
 * A proposal's record on X, in words: the card's footer names indexer.namada.net, which X would make a link (a post
 * with one costs $0.20, not $0.015), so the post says where the votes are and, when the proposal's own discussion is
 * on forum.namada.net, where it is discussed (owner, 2026-10-29: send readers to the forum and the chain).
 */
export function govRecord(p: GovernanceProposal): string {
  const own = safeHttpUrl(p.discussionsUrl);
  const forum = own != null && new URL(own).hostname === 'forum.namada.net';
  return `votes on-chain, read from the Namada indexer${forum ? ' · discussion on the Namada forum' : ''}`;
}

/**
 * One part of the closed hour (public-posts.ts publicHour, hourPick), once (`alert:x:hour:<hour>`, the crossing's
 * `alert:x:hour:<hour>:ibc`), while fresh, under that part's share of the day. A quiet part (nothing qualifies) is
 * claimed and posts nothing, as is one whose share of the day was spent before; an hour whose moves cannot be read is
 * left for the next tick. A move is posted once (`alert:x:ibc:<crossing>` or `alert:x:flow:<id>`, the keys the live
 * posts used, claimed with the hour's before the post): a crossing's other record, in a later hour, gives way to that
 * hour's next move. Never throws.
 */
async function postHourPart(env: XEnv, hour: PublicHour, part: HourPart, now: number): Promise<'posted' | 'quiet' | 'skipped' | 'claimed' | 'full' | 'off' | 'again' | 'failed'> {
  if (!postsOnX(env)) return 'skipped';
  try {
    const key = `alert:x:hour:${hour.key}${part === 'ibc' ? ':ibc' : ''}`;
    if ((await claimTaken(env.DB, key)) || !(await xOn(env.DB))) return 'skipped';
    const posted = (m: PublicMove) => (m.crossing ? `alert:x:ibc:${m.crossing}` : `alert:x:flow:${m.id}`);
    const first = await hourPick(env.DB, await hour.moves(), part, posted);
    if (!first || now - first.move.ts > X_MAX_AGE_MS) { await claimDiscordAlert(env.DB, [key]); return 'quiet'; }
    const pick = first.move;
    const r = await postOnce(env, [key, posted(pick)], part, () => hourText(pick, first.passed, part), `hour ${hour.key}: ${part === 'ibc' ? 'crossing' : 'move'} ${pick.id}`);
    if (r === 'full') await claimDiscordAlert(env.DB, [key]);
    return r;
  } catch (e) {
    console.error(`x: the hour ${hour.key} (${part}) not posted`, e);
    return 'failed';
  }
}
/** The cron's tick: the closed hour's move, its largest (postHourPart). */
export const postHourOnX = (env: XEnv, hour: PublicHour, now = Date.now()) => postHourPart(env, hour, 'move', now);
/** The cron's tick, after the move: the closed hour's largest bridge crossing, when its move is no crossing (postHourPart). */
export const postHourCrossingOnX = (env: XEnv, hour: PublicHour, now = Date.now()) => postHourPart(env, hour, 'ibc', now);

/** A proposal: its card's title (outsider text, xSafe in cardText), its votes and its record in words (govRecord). */
export const postGovOnX = (env: XEnv, prop: GovernanceProposal, isNew: boolean, g: GovContext = {}) =>
  postOnce(env, `alert:x:gov:prop:${prop.id}:${prop.status}`, 'gov', () => cardText(govCard(prop, isNew, g), Date.now(), govRecord(prop)), `proposal ${prop.id} ${prop.status}`);

// ---------------------------------------------------------------- the daily recap

const nf = (n: number, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
/** The overview's figures the recap reads (worker/src/api.ts GET /api/overview). */
export interface RecapFigures {
  generatedAt?: number;
  price?: { usd?: { value?: number | null } | null; change24h?: number | null } | null;
  supply?: { bonded?: number; shielded?: number; total?: number } | null;
  dex?: { volume24hNam?: number; buys24h?: number; sells24h?: number } | null;
  namada?: { holders?: number } | null;
}
/**
 * The recap: price and its day's change, Osmosis trading, the staked and shielded shares, holders, and the one link of
 * the day. A figure the overview did not give is left out, never guessed.
 */
export function recapText(o: RecapFigures, now = Date.now()): string {
  const at = new Date(o.generatedAt ?? now).toISOString().slice(11, 16);
  const lines = [`NAM today (${at} UTC):`];
  const price = o.price?.usd?.value, ch = o.price?.change24h;
  if (price != null) lines.push(`• Price $${price.toFixed(6)}${ch != null ? ` (${ch >= 0 ? '+' : '−'}${nf(Math.abs(ch), 1)}% 24h)` : ''}`);
  const d = o.dex;
  if (d?.volume24hNam != null) lines.push(`• Osmosis 24h: ${nf(d.volume24hNam)} NAM traded${d.buys24h != null && d.sells24h != null ? `, ${d.buys24h} buys / ${d.sells24h} sells` : ''}`);
  const s = o.supply;
  if (s?.total && s.bonded != null && s.shielded != null) lines.push(`• Staked ${nf((s.bonded / s.total) * 100, 1)}% · Shielded ${nf((s.shielded / s.total) * 100, 1)}%`);
  if (o.namada?.holders != null) lines.push(`• ${nf(o.namada.holders)} holders on Namada`);
  lines.push('', `Every number with its source: ${SITE.origin}`);
  return cutX(lines.join('\n'));
}

/**
 * The cron's tick: from X_RECAP_HOUR_UTC, the day's recap once (claimed by date), read from the overview the site
 * answers. A tick before that hour, or after the day's recap, does nothing.
 */
export async function postRecapOnX(env: XEnv, overview: () => Promise<RecapFigures>, now = Date.now(), picture: () => Promise<Uint8Array | null> = () => recapChart(env.DB, now)): Promise<void> {
  if (!postsOnX(env) || new Date(now).getUTCHours() < X_RECAP_HOUR_UTC) return;
  await postOnce(env, `alert:x:recap:${day(now)}`, 'recap', async () => recapText(await overview(), now), `recap ${day(now)}`, picture);
}

/**
 * The recap's picture: the daily digest's price chart (digest/charts: the hourly quote and the executed hourly price
 * over its days to `now`), drawn from the same rows by the same code. Null when the price was not read in that window.
 */
export async function recapChart(db: D1Database, now: number): Promise<Uint8Array | null> {
  const last = await db.prepare("SELECT MAX(ts) ts FROM metrics WHERE key = 'price.usd'").first<{ ts: number | null }>().catch(() => null);
  const at = last?.ts != null ? Number(last.ts) : null;
  const ctx: ChartContext = {
    now, kind: 'daily',
    clock: { eNow: null, epochAt: null, startedAt: null, errorMs: null, epochMs: null, paramsAt: null },
    listing: null, stakeNow: null,
    quoteNow: at != null ? { at, live: now - at <= CHART_MINUTE_BOUND_MS } : null,
  };
  const shaped = shapePriceChart(await readChartRows(db, ctx), ctx);
  if (isNotRead(shaped)) return null;
  return (await toPng(priceChart(shaped.input))).png;
}

// ---------------------------------------------------------------- reposting @namada

/** The account whose posts are reposted (owner, 2026-10-29): Namada's own. */
export const REPOST_HANDLE = 'namada';
/** How often the cron's tick looks for its new posts (each look that finds none costs nothing: reads are billed per post). */
export const REPOST_EVERY_MIN = 10;
/** The most reposts a UTC day, apart from X_DAILY_MAX. */
export const REPOST_DAILY_MAX = 10;

/** A signed GET; its JSON, or null. */
async function xGet(env: XEnv, url: string): Promise<{ status: number; j: any }> {
  try {
    const res = await fetch(url, { headers: { authorization: await oauthHeader(env as Required<Omit<XEnv, 'DB'>>, 'GET', url) }, signal: AbortSignal.timeout(X_TIMEOUT_MS) });
    return { status: res.status, j: await res.json().catch(() => null) };
  } catch {
    return { status: 0, j: null };
  }
}

/** The posting account's id: the number an OAuth 1.0a access token starts with ("<user id>-…"). */
export const ownId = (env: XEnv) => /^(\d+)-/.exec(env.X_ACCESS_TOKEN ?? '')?.[1] ?? null;

/**
 * The cron's tick, every REPOST_EVERY_MIN minutes while the kill switch is on (xSwitch): reposts @namada's new posts
 * (not its replies or its own reposts), oldest first, each once (`alert:x:repost:<post id>`), at most REPOST_DAILY_MAX
 * a day. The first look only records where its posts stand (kv `x.repost.since`), so nothing older than the feature is
 * reposted; the account's id is looked up once (kv `x.repost.id`). A repost X refuses as already made counts as made.
 *
 * Each tick the switch reads off forgets where the posts stood (the cursor is deleted, and X is not asked), so the
 * first look after it is back on is a first look again: what @namada posted while it was off (a post the switch was
 * turned off for, say) is never reposted. A switch that cannot be read leaves the cursor as it is.
 */
export async function repostNamada(env: XEnv, now = Date.now()): Promise<number> {
  if (!postsOnX(env)) return 0;
  const on = await xSwitch(env.DB);
  if (on === 'off') await env.DB.prepare("DELETE FROM kv WHERE key = 'x.repost.since'").run().catch((e) => console.error('x: the repost cursor not cleared', e));
  if (on !== 'on' || Math.floor(now / 60_000) % REPOST_EVERY_MIN !== 0) return 0;
  const me = ownId(env);
  if (!me) return 0;
  let id = (await env.DB.prepare("SELECT value FROM kv WHERE key = 'x.repost.id'").first<{ value: string }>().catch(() => null))?.value;
  if (!id) {
    const u = await xGet(env, `https://api.x.com/2/users/by/username/${REPOST_HANDLE}`);
    id = u.j?.data?.id;
    if (!id) { console.error(`x: @${REPOST_HANDLE} not looked up (${u.status})`); return 0; }
    await kvSet(env.DB, 'x.repost.id', id);
  }
  const since = (await env.DB.prepare("SELECT value FROM kv WHERE key = 'x.repost.since'").first<{ value: string }>().catch(() => null))?.value;
  const q = new URLSearchParams({ exclude: 'replies,retweets', max_results: since ? '10' : '5' });
  if (since) q.set('since_id', since);
  const r = await xGet(env, `https://api.x.com/2/users/${id}/tweets?${q}`);
  if (r.status !== 200) { if (r.status) console.error(`x: @${REPOST_HANDLE}'s posts not read (${r.status})`); return 0; }
  const posts: { id: string }[] = Array.isArray(r.j?.data) ? r.j.data : [];
  const newest = typeof r.j?.meta?.newest_id === 'string' ? r.j.meta.newest_id : posts[0]?.id;
  if (!since) { if (newest) await kvSet(env.DB, 'x.repost.since', newest); return 0; }
  let n = 0;
  // the newest post handled before any that must wait (the day's reposts spent, X not answering)
  let done: string | null = since;
  let waited = false;
  for (const p of [...posts].reverse()) {
    if (!/^\d+$/.test(p.id) || !(await claimDiscordAlert(env.DB, [`alert:x:repost:${p.id}`]))) { done = p.id; continue; }
    const d = await env.DB.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?1, '1', ?2)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(kv.value AS INTEGER) + 1 AS TEXT), updated_at = ?2 WHERE CAST(kv.value AS INTEGER) < ${REPOST_DAILY_MAX}`,
    ).bind(`alert:x:repostday:${day(now)}`, now).run();
    if (!Number(d.meta?.changes ?? 0)) { await releaseClaims(env.DB, [`alert:x:repost:${p.id}`]); waited = true; break; }
    const url = `https://api.x.com/2/users/${me}/retweets`;
    let a: { status: number; j: any };
    try {
      const res = await fetch(url, { method: 'POST', headers: { authorization: await oauthHeader(env as Required<Omit<XEnv, 'DB'>>, 'POST', url), 'content-type': 'application/json' }, body: JSON.stringify({ tweet_id: p.id }), signal: AbortSignal.timeout(X_TIMEOUT_MS) });
      a = { status: res.status, j: await res.json().catch(() => null) };
    } catch { a = { status: 0, j: null }; }
    if (a.j?.data?.retweeted === true || a.status === 200) n++;
    else {
      console.error(`x: @${REPOST_HANDLE}'s post ${p.id} not reposted (${a.status})`);
      if (a.status === 0 || a.status >= 500 || a.status === 429) { await releaseClaims(env.DB, [`alert:x:repost:${p.id}`]); waited = true; break; }
    }
    done = p.id;
  }
  // the next look starts after the newest post handled; one that must wait (its claim given back) is read again
  const next = waited ? done : newest;
  if (next && next !== since) await kvSet(env.DB, 'x.repost.since', next);
  return n;
}

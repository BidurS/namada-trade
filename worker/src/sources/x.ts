// Posts on X (@ the owner's account), automatically: the moves the site's own channel hears of (operatorMove: 10,000
// NAM and up, no bot round trips or rewards claims), new and changed governance proposals, new forum topics and
// replies, and a daily recap at 13:00 UTC with the daily digest's price chart (owner's choices, 2026-10-29).
//
// X's API is paid per call (https://docs.x.com/x-api/getting-started/pricing: $0.015 a post, $0.20 a post with a
// link, checked 2026-10-29), so only the recap carries a link; an alert names the move, its figures and their source
// in words, and the profile links the site. Posts a day are capped (X_DAILY_MAX), and a move older than X_MAX_AGE_MS
// when it is offered (a catch-up search, a late scan) is not posted: the account reads as live.
//
// Each post is claimed once (`alert:x:` keys, swept with the other claims: auth.ts sweepAuth). An answer that is no
// answer, a 5xx or a 429 gives the claim back, so the alert offered again is posted; a refusal (401/403: the keys, 402:
// no credits, 400: the text) is not tried again, and kv `x.last` records it for the health view. Text an outsider
// wrote (a label, a forum post, a proposal) never mentions anyone: an @ is written as "(at)".
//
// The keys are the owner's X app's (OAuth 1.0a, Read and Write): X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
// X_ACCESS_SECRET, set by scripts/x-connect.sh at hidden prompts. Without all four nothing is posted.
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { SITE } from '../../../shared/site';
import { kvSet } from '../db';
import { readMoveContext } from './discord-context';
import { alertsOn, claimDiscordAlert, crossingOf, fits, forumCard, govCard, moveCard, operatorMove, releaseClaims, type Card, type GovContext } from './discord';
import { mdToPlain } from './telegram';
import { CHART_MINUTE_BOUND_MS, readChartRows, shapePriceChart, type ChartContext } from '../digest/charts/read';
import { isNotRead, priceChart, toPng } from '../digest/charts/charts';

export interface XEnv { DB: D1Database; X_API_KEY?: string; X_API_SECRET?: string; X_ACCESS_TOKEN?: string; X_ACCESS_SECRET?: string }

const POST_URL = 'https://api.x.com/2/tweets';
/** A call X does not answer within this long is given up. */
export const X_TIMEOUT_MS = 5000;
/** The most posts a UTC day, the recap included: about $0.40 a day at most. */
export const X_DAILY_MAX = 15;
/** A move older than this when offered is not posted. */
export const X_MAX_AGE_MS = 2 * 3_600_000;
/** The recap's hour, UTC (the marketing pack's suggested time: mornings in both the US and Europe). */
export const X_RECAP_HOUR_UTC = 13;
/** X's limit, in its weighted characters (twitter-text: most Latin text weighs 1, other scripts and emoji 2). */
export const X_MAX = 280;

/** Whether this Worker posts on X: it sends alerts (SEND_ALERTS) and has all four keys. */
export const postsOnX = (env: XEnv): boolean => alertsOn() && !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);

// ---------------------------------------------------------------- the text

/** One character's weight as X counts it (twitter-text v3: these ranges weigh 1, everything else 2). */
const weight = (cp: number) => (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2);
/** A text's length as X counts it; a link counts 23 whatever its length. */
export function xLength(s: string): number {
  let n = 0;
  const urls = s.match(/https?:\/\/\S+/g) ?? [];
  let rest = s;
  for (const u of urls) { rest = rest.replace(u, ''); n += 23; }
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
/** No one is mentioned or tagged by text an outsider wrote. */
const noMentions = (s: string) => s.replace(/@/g, '(at)');

/**
 * A card as a post: the title, the first paragraph (who moved it and the price, or a post's opening words, or a
 * proposal's votes) and the record it comes from, without links, in X's 280.
 */
export function cardText(card: Card, now = Date.now()): string {
  const e = fits(card);
  const first = mdToPlain((e.description ?? '').split('\n\n')[0], now).replace(/\s+/g, ' ').trim();
  const record = (e.footer?.text ?? '').replace(/^NamadaTrade · /, '');
  const when = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
  const tail = [when, record].filter(Boolean).join(' · ');
  // $NAM once, in the title (a cashtag: X lists the post under the coin)
  const head = noMentions(e.title ?? '').replace(/(^|\s)NAM\b/, '$1$$NAM');
  const body = noMentions(first);
  // the tail is kept whole; the opening words give way first
  const room = X_MAX - xLength(head) - (tail ? xLength(tail) + 2 : 0) - 2;
  return cutX([head, room > 20 && body ? cutX(body, room) : '', tail].filter(Boolean).join('\n\n'));
}

// ---------------------------------------------------------------- signing (OAuth 1.0a, HMAC-SHA1)

/** RFC 3986 percent-encoding, as OAuth 1.0a asks. */
const pct = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** The Authorization header of a JSON POST to `url` (a JSON body is not part of the signature). */
export async function oauthHeader(env: Required<Omit<XEnv, 'DB'>>, method: string, url: string, nonce = crypto.randomUUID().replace(/-/g, ''), ts = Math.floor(Date.now() / 1000)): Promise<string> {
  const o: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(ts), oauth_token: env.X_ACCESS_TOKEN, oauth_version: '1.0',
  };
  const params = Object.keys(o).sort().map((k) => `${pct(k)}=${pct(o[k])}`).join('&');
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(params)}`;
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

/** Takes one of the day's X_DAILY_MAX posts, in one statement: false when the day's posts are spent. */
async function takeDaily(db: D1Database, now: number): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?1, '1', ?2)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(kv.value AS INTEGER) + 1 AS TEXT), updated_at = ?2 WHERE CAST(kv.value AS INTEGER) < ${X_DAILY_MAX}`,
  ).bind(`alert:x:day:${day(now)}`, now).run();
  return Number(r.meta?.changes ?? 0) > 0;
}
const giveBackDaily = (db: D1Database, now: number) =>
  db.prepare(`UPDATE kv SET value = CAST(CAST(value AS INTEGER) - 1 AS TEXT) WHERE key = ? AND CAST(value AS INTEGER) > 0`).bind(`alert:x:day:${day(now)}`).run().catch(() => {});

/**
 * Posts `text` under claim `key` and one of the day's posts. Never throws. The claim and the day's post are given back
 * when X gave no answer, a 5xx or a 429; a refusal keeps them, and is recorded.
 */
export async function postOnce(env: XEnv, key: string, text: () => Promise<string> | string, what: string, picture?: () => Promise<Uint8Array | null>): Promise<'posted' | 'claimed' | 'full' | 'failed'> {
  try {
    if (!postsOnX(env)) return 'failed';
    if (!(await claimDiscordAlert(env.DB, [key]))) return 'claimed';
    const now = Date.now();
    if (!(await takeDaily(env.DB, now))) { await releaseClaims(env.DB, [key]); return 'full'; }
    let body: string;
    try { body = await text(); } catch (e) {
      // the text could not be read (the recap's overview): nothing was posted, so the claim and the day's post go back
      console.error(`x: ${what} not built`, e);
      await releaseClaims(env.DB, [key]);
      await giveBackDaily(env.DB, now);
      return 'failed';
    }
    // a picture that cannot be drawn or uploaded never costs the post: it goes as text
    const png = picture ? await picture().catch((e) => { console.error(`x: ${what}: the picture was not drawn`, e); return null; }) : null;
    const media = png ? await xUpload(env, png) : null;
    const a = await xPost(env, body, media ? [media] : []);
    await kvSet(env.DB, 'x.last', JSON.stringify({ at: now, what, status: a.status, ok: a.ok, ...(a.detail ? { detail: a.detail } : {}) })).catch(() => {});
    if (a.ok) return 'posted';
    console.error(`x: ${what} not posted (${a.status}${a.detail ? `: ${a.detail}` : ''})`);
    if (transient(a)) { await releaseClaims(env.DB, [key]); await giveBackDaily(env.DB, now); }
    return 'failed';
  } catch (e) {
    console.error(`x: ${what} not posted`, e);
    return 'failed';
  }
}

/**
 * A move the site's own channel hears of, while it is fresh. A bridge crossing is recorded on both chains: it is
 * claimed by its packet (crossingOf), so it is posted once, from whichever record comes first.
 */
export async function postMoveOnX(env: XEnv, flow: Flow, whaleNam = 10000): Promise<void> {
  if (!postsOnX(env) || !operatorMove(flow, whaleNam) || Date.now() - flow.ts > X_MAX_AGE_MS) return;
  const crossing = crossingOf(flow);
  await postOnce(env, crossing ? `alert:x:ibc:${crossing}` : `alert:x:flow:${flow.id}`, async () => {
    const read = await readMoveContext(env.DB, flow);
    return cardText(moveCard(read.flow, { ...read.ctx, whaleNam }));
  }, `move ${flow.id}`);
}

export const postForumOnX = (env: XEnv, post: ForumPost, categoryName?: string | null) =>
  postOnce(env, `alert:x:forum:post:${post.id}`, () => cardText(forumCard(post, categoryName)), `forum post ${post.id}`);
export const postGovOnX = (env: XEnv, prop: GovernanceProposal, isNew: boolean, g: GovContext = {}) =>
  postOnce(env, `alert:x:gov:prop:${prop.id}:${prop.status}`, () => cardText(govCard(prop, isNew, g)), `proposal ${prop.id} ${prop.status}`);

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
  await postOnce(env, `alert:x:recap:${day(now)}`, async () => recapText(await overview(), now), `recap ${day(now)}`, picture);
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

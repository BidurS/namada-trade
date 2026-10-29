import { CROSSING_PAIR_MS, explorerHashOf, isBotFlow, isIbcRefund, isOtherCoin, priceAtOf, priceHowOf, priceRouteOf, priceSourceWords, safeHttpUrl } from '../../../shared/flow-rules';
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { NAM } from '../config';
import { alertRules, evaluateFlow, INTERNAL_ADDRESSES, isInternal } from '../../../shared/alerts';
import { readDeliverable, inQuietHours, stopChannelStmt, hookOkStmt, thresholdsOf, trialsDue, noticeTriedStmt, NOTICE_TRIES_MAX, type StoredSettings } from '../settings';
import { SITE } from '../../../shared/site';
import { settleUsd, type Settle, type SettledCoin } from '../../../shared/settle';
import { tagByline } from '../../../shared/labels';
import { explorerTx, fmtAddr, fmtAge, fmtCoin, fmtNamRule, fmtPctRule, fmtUsdRule, labelNeedsAddr } from '../../../shared/format';
import { bridgeDest, HUE_HEX, kindInfo } from '../../../shared/kinds';
import { CHAIN_WORD, listWords, moveTitle, partiesOf, pastWords, proposalOpen, proposalStatusWords, proposalTypeWords, sidesOf, tagOfFlow, type Party } from '../../../shared/flow-words';
import { chainOf } from '../util';
import { readMoveContext, HISTORY_COUNT_MAX, type MoveContext, type PriorMove } from './discord-context';
import { FLOW_SELECT, lastAlertBefore, rowToFlow } from '../analytics';
import { kvGetJson, kvSet } from '../db';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * A webhook that accepts the request and never answers must not hold up its caller (the cron's tick, the live
 * stream): every post ends after this long.
 */
export const WEBHOOK_TIMEOUT_MS = 8000;
/** A file a post carries (a digest's picture), sent beside the post's JSON. */
export interface PostFile { name: string; bytes: Uint8Array; type: string }
/** One webhook post: its JSON body and the files it attaches, in the order the body's `attachments` name them (id = index). */
export interface WebhookPost { body: Record<string, unknown>; files?: PostFile[] }
/**
 * Every post names no one: a mention in text an outsider wrote (a forum post, a proposal, a label, a bridge receiver
 * string) is shown as text, never turned into a notification. A post with files goes as Discord's multipart form:
 * the JSON as `payload_json`, each file as `files[n]`; it is still one request, with one answer.
 */
const postWebhook = (url: string, body: Record<string, unknown>, files?: PostFile[]) => {
  const json = JSON.stringify({ ...body, allowed_mentions: { parse: [] } });
  const signal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  if (!files?.length) return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, signal });
  const form = new FormData();
  form.append('payload_json', json);
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes], { type: f.type }), f.name));
  return fetch(url, { method: 'POST', body: form, signal });
};

/** What a post sent without its pictures says (Discord refused the files, or the request was too large). */
export const FILES_REFUSED_NOTE = 'Sent without its pictures: Discord did not take them. Every figure is in the text.';
/** Whether an answer refuses a post's files: Discord's Invalid Form Body (a file it will not take is one) or a request too large. */
const filesRefused = (a: { refused: boolean; status: number }) => a.refused || a.status === 413;
/**
 * A post with files as text only: every embed keeps its words, the pictures it named are left out (an embed that held
 * a picture alone goes), the attachments list goes, and a last embed says the pictures were not attached.
 */
export function textOnly(body: Record<string, unknown>): Record<string, unknown> {
  const embeds = Array.isArray(body.embeds) ? (body.embeds as Record<string, any>[]) : [];
  const kept = embeds
    .map((e) => {
      const img = e?.image?.url;
      if (typeof img !== 'string' || !img.startsWith('attachment://')) return e;
      const { image: _image, ...rest } = e;
      return rest;
    })
    .filter((e) => !!(e?.title || e?.description || (Array.isArray(e?.fields) && e.fields.length) || e?.footer || e?.author));
  const { attachments: _attachments, ...rest } = body;
  const color = typeof kept[0]?.color === 'number' ? { color: kept[0].color } : {};
  return { ...rest, embeds: [...kept.slice(0, 9), { description: FILES_REFUSED_NOTE, ...color }] };
}
/**
 * Lets go of the body of a webhook answer that nothing reads (Discord's 204 has none; a 429 or 5xx carries a short
 * JSON error): it is cancelled, never left for the garbage collector, as every other fetch in the Worker does
 * (util.ts cappedBytes, errorBody). A body discordCode read is already cancelled and stays locked to its reader.
 */
const releaseBody = async (res: Response) => {
  if (res.body && !res.body.locked) await res.body.cancel().catch(() => {});
};

/** Text an outsider wrote, with Discord's masked-link syntax broken ("](" becomes "] ("): no link can hide under other words. */
export const plainMd = (s: string) => s.replace(/\]\(/g, '] (');
/** A value shown inside a code span: a backtick or line break could close the span (an Osmosis bridge receiver is free text). */
const codeSafe = (s: string) => s.replace(/[`\r\n]/g, '');

/** Posts for one move or post run this many at a time (the runtime allows six outgoing connections at once). */
export const POST_CONCURRENCY = 6;
/**
 * Every subscriber's post of an alert starts within the alert's fan-out window, which opens at its first post and
 * lasts at least this long (windowFor makes it longer for an alert with more subscribers). A slow or hostile set of
 * webhooks can then hold up alerts, never the block scan. Each dispatch also bounds all its alerts together
 * (AlertBudget): a cron run and a LiveHub alarm by a post count and a deadline of their own, so a signed-in wallet
 * cannot make its own low-threshold rule match enough moves to hold the alarm past its deadline and starve the other
 * chain's catch-up search or the next block scan; a live stream message by one window across its moves and a post
 * count. What a window, a count or a deadline cuts is never dropped: a LiveHub dispatch keeps it for its next alarm
 * (AlertBudget.defers, live-hub.ts PendingAlert) and a cron run leaves the alert for its next run (admit); a dispatch
 * that can do neither records it (kv `alerts.skipped`, shown by the cron health view). The operator's channel goes
 * first and is never cut.
 */
export const FANOUT_DEADLINE_MS = 15_000;
/**
 * The time a fan-out window allows each round of POST_CONCURRENCY posts: Discord answers a webhook post in about 0.1
 * to 0.4 s. An alert's window is long enough for every one of its subscribers at this pace, so one alert reaches every
 * channel the cap admits (settings.ts DELIVERABLE_MAX, 42 s for 500), within what is left of its dispatch's deadline.
 */
export const POST_PACE_MS = 500;
/** The fan-out window of an alert with `n` subscriber posts (FANOUT_DEADLINE_MS at least). */
export const windowFor = (n: number): number => Math.max(FANOUT_DEADLINE_MS, Math.ceil(n / POST_CONCURRENCY) * POST_PACE_MS);
/** A webhook that failed this many times in a row (unreachable, deleted, refused) is left alone for BACKOFF_MS. */
export const BACKOFF_AFTER = 3;
export const BACKOFF_MS = 10 * 60_000;
/**
 * A user's hook that answers this many 429s of user scope (its own bucket) in one window that the site's own posts did
 * not cause is held for the rest of the window (HookState.held). Every answer's X-RateLimit-Remaining and
 * X-RateLimit-Reset-After are read, successes included, and a hook whose bucket is known empty is paused until it
 * refills, so the site's own pace never fills a hook's bucket; and a 429 of user scope counts toward the hold only
 * when the site's own posts to that hook in the bucket's period were fewer than its X-RateLimit-Limit (an honest burst,
 * or two dispatches posting at once, fills the bucket with the site's posts and never counts; a hook its owner or
 * another service fills from outside counts at every such answer). A success that leaves the bucket empty
 * (X-RateLimit-Remaining 0) though the site's own posts in it were fewer than its limit counts the same way: posts from
 * elsewhere filled it, and the pause it brings would otherwise keep that hook's parts waiting from alarm to alarm with
 * no 429 at all. Posting to such a hook would only spend the window's budget of invalid answers, one 429 at every
 * alarm, while the parts kept for it never drained. The count is kept per window and a success does not reset it (as
 * BACKOFF_AFTER's count of 401, 403 and 404 answers works), so a hook whose owner lets one post in three through is
 * held as surely as one that answers 429 to every post. While it is held its posts are recorded as not sent and cost
 * the dispatch nothing; a hook held through the end of a window is held again at its first such answer of the next
 * one, so a hook kept that way costs each later window at most one invalid answer.
 */
export const RATE_LIMITED_HOLD_AFTER = 3;
/**
 * Discord's bucket for one webhook when its answers do not say (X-RateLimit-Limit, and the period X-RateLimit-Reset-After
 * shows on a bucket's first post): five posts every two seconds. A hook's own answers replace both.
 */
export const BUCKET_LIMIT_DEFAULT = 5;
export const BUCKET_PERIOD_DEFAULT_MS = 2000;
/** The longest bucket period kept for a hook, and how long the site's own posts to a hook are remembered. */
const BUCKET_PERIOD_MAX_MS = 60_000;
/** How many of the site's latest posts to one hook are remembered: more than any bucket Discord gives a webhook. */
const SENT_KEEP = 64;
/**
 * A post started this long before its bucket began, as read from the start of the post an answer is for, may still
 * have reached Discord inside it: the difference between two posts' ways to Discord.
 */
const BUCKET_SLACK_MS = 500;
/**
 * Discord restricts an address that makes more than 10,000 invalid requests in 10 minutes (answers 401, 403 and 429,
 * a 429 of shared scope excepted), and asks that a webhook that answered 404 not be posted again; every alert, the
 * operator's among them, leaves from the same addresses. So answers of those four kinds are counted across every
 * isolate (kv `alerts.invalid`) per INVALID_WINDOW_MS window. Once INVALID_BUDGET is spent, a post goes only to the
 * operator's channel and to proven hooks: a hook whose last answer here was a success, one whose row records a
 * successful post (`okAt`, whichever isolate made it: a Settings save or test post, or an alert), and one whose link
 * was first turned on more than SETTLED_MS ago (the hold is for links saved just now that have never worked, which
 * are the only ones a wallet could make up to spend the budget); once INVALID_CEILING is spent, to the operator's
 * channel only. The rest wait for the next window: a dispatch that sends later keeps them (AlertBudget.defers), any
 * other records them with the posts not sent. Settings test posts have a budget of their own (TEST_INVALID_BUDGET),
 * so they never spend what is kept for the alerts.
 */
export const INVALID_BUDGET = 250;
export const INVALID_CEILING = 1000;
export const INVALID_WINDOW_MS = 10 * 60_000;
/** A link first turned on more than this long ago, with no post recorded, is not a link saved just now to spend the budget. */
export const SETTLED_MS = 24 * 3_600_000;
/** A user's hook that Discord answered is gone (or has a wrong token) is left alone here this long, whatever its row says. */
export const DEAD_HOLD_MS = 24 * 3_600_000;
/** Discord's codes for a webhook that does not exist (Unknown Webhook, a 404) and for a wrong token (Invalid Webhook Token, a 401). */
export const DISCORD_UNKNOWN_WEBHOOK = 10015;
export const DISCORD_INVALID_WEBHOOK_TOKEN = 50027;
const INVALID_KEY = 'alerts.invalid';
/** Hooks this isolate keeps a record of; past it the one seen longest ago is dropped. */
const HOOKS_MAX = 5000;

/**
 * What this isolate knows of each webhook URL: failures in a row (`n`), when it may be posted again after failures
 * or a dead answer (`until`), when a 429's Retry-After or its known-empty bucket ends (`pause`, kept apart: a pause
 * says nothing against the hook, and a dispatch that sends later keeps the posts it holds up), whether its last answer
 * was a success (`ok`), its answers of 401, 403 or 404 in window `w` (`bad`, which a success does not reset, so a hook
 * that alternates success and such an answer still stops at BACKOFF_AFTER per window), its 429s of user scope in
 * window `w` that the site's own posts did not cause, and its successes there that left a bucket the site's own posts
 * did not fill empty (`limited`, which a success does not reset either) and until when
 * it is held for answering RATE_LIMITED_HOLD_AFTER of them (`held`, the window's end), when the site's latest posts to
 * it started (`sent`, a post answered 429 left out: it did not go into the bucket), and its bucket as its answers say
 * it (`limit` posts every `period` ms; `known` once an answer gave the period, which is the longest X-RateLimit-Reset-After
 * seen for that limit).
 */
interface HookState { n: number; until: number; pause: number; ok: boolean; w: number; bad: number; limited: number; held: number; sent: number[]; limit: number; period: number; known: boolean }
const hooks = new Map<string, HookState>();
const windowOf = (t: number) => Math.floor(t / INVALID_WINDOW_MS);
const newHook = (w: number): HookState => ({ n: 0, until: 0, pause: 0, ok: false, w, bad: 0, limited: 0, held: 0, sent: [], limit: BUCKET_LIMIT_DEFAULT, period: BUCKET_PERIOD_DEFAULT_MS, known: false });

/**
 * What a 429 says it limits, by Discord's headers: the hook's own bucket ('user'), a resource others share
 * ('shared'), the site's address ('global': X-RateLimit-Global true, or scope global), nothing Discord says at all
 * ('none': no X-RateLimit header, such as a block page in front of Discord), or a bucket with no scope named
 * ('other'). A global or header-less 429 says nothing of one hook.
 */
export type RateScope = 'user' | 'shared' | 'global' | 'none' | 'other';
/** A hook's bucket as one answer's X-RateLimit headers say it, each part only when the answer gives it. */
interface Bucket { limit: number | null; remaining: number | null; resetMs: number | null }
/**
 * One answer as the dispatcher reads it: Discord's JSON error code (`code`, read for a 400, 401, 403 or 404; null
 * when the answer is not Discord's JSON), a 429's scope (`scope`) and the bucket its headers describe (`bucket`).
 */
interface Answer { ok: boolean; status: number; refused: boolean; invalid: boolean; dead: boolean; waitMs: number; code: number | null; scope: RateScope | null; bucket: Bucket | null }
const NO_ANSWER: Answer = { ok: false, status: 0, refused: false, invalid: false, dead: false, waitMs: 0, code: null, scope: null, bucket: null };
/** A 429 that limits the site's address rather than one hook: of global scope, or with none of Discord's headers. */
const siteWide = (a: Answer) => a.status === 429 && (a.scope === 'global' || a.scope === 'none');

/**
 * The pause a 429 that names no Retry-After brings (a block page in front of discord.com answers so): a short one. A
 * limit that is still there answers the next post the same way, and is counted again; a long pause would only keep
 * what an alarm can send waiting, or, in a dispatch that cannot send later, ask its subscribers to wait in vain.
 */
export const RETRY_AFTER_UNSAID_MS = 3000;
/** Discord's Retry-After (seconds), as a pause of 1 s to BACKOFF_MS; RETRY_AFTER_UNSAID_MS when the answer names none. */
function retryAfterMs(res: Response): number {
  const sec = Number(res.headers.get('retry-after'));
  return Math.min(BACKOFF_MS, Math.max(1000, Number.isFinite(sec) && sec > 0 ? sec * 1000 : RETRY_AFTER_UNSAID_MS));
}
/** A header read as a number, or NaN when it is missing or empty. */
const headerNum = (res: Response, name: string) => {
  const v = res.headers.get(name);
  return v == null || v.trim() === '' ? NaN : Number(v);
};
/** The bucket an answer's X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset-After describe; null when it gives none of them. */
function bucketOf(res: Response): Bucket | null {
  const limit = headerNum(res, 'x-ratelimit-limit');
  const remaining = headerNum(res, 'x-ratelimit-remaining');
  const after = headerNum(res, 'x-ratelimit-reset-after');
  const b: Bucket = {
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(SENT_KEEP, Math.floor(limit)) : null,
    remaining: Number.isFinite(remaining) && remaining >= 0 ? Math.floor(remaining) : null,
    resetMs: Number.isFinite(after) && after >= 0 ? Math.min(BACKOFF_MS, Math.ceil(after * 1000)) : null,
  };
  return b.limit == null && b.remaining == null && b.resetMs == null ? null : b;
}
/** What a 429 limits (RateScope), by its headers. */
function scopeOf(res: Response): RateScope {
  const scope = res.headers.get('x-ratelimit-scope')?.trim().toLowerCase();
  if (res.headers.get('x-ratelimit-global')?.trim().toLowerCase() === 'true' || scope === 'global') return 'global';
  if (scope === 'user' || scope === 'shared') return scope;
  for (const k of res.headers.keys()) if (k.toLowerCase().startsWith('x-ratelimit-')) return 'other';
  return 'none';
}

/**
 * Until when Discord limits the site's address, as this isolate last heard (a 429 of global scope, or one with none of
 * Discord's headers). A dispatch that sends later starts no subscriber post before it: it hands every subscriber's
 * post back from then on (AlertBudget.halted). One that does not waits a short pause out in place, once, and posts
 * anyway past a longer one (each post's own answer decides), and its later alerts wait for the next run (admit); the
 * operator's channel waits a short pause out in place, or is posted anyway.
 */
let sitePause = 0;
/**
 * Records a limit on the site's address for `ms`. It says nothing of any one hook, so it is counted toward no hook's
 * hold (noteAnswer), and it changes no hook's count or window either: each hook's count is its own answers' to keep,
 * with the carry-over a hook held through the end of a window starts the next one with (a limit on the address,
 * which other tenants of the same address can draw, would otherwise let a hook filled from outside escape the hold).
 */
function pauseSite(now: number, ms: number) {
  sitePause = Math.max(sitePause, now + ms);
}

/**
 * Records that a post to `url` starts now, before it is sent, so a 429 that the site's own posts (this one among them,
 * or another dispatch's at the same time) caused is told from one that posts from outside caused. The time is the
 * post's mark for noteAnswer.
 */
function notePost(url: string): number {
  const now = Date.now();
  let f = hooks.get(url);
  if (!f) {
    f = newHook(windowOf(now));
    hooks.set(url, f);
    if (hooks.size > HOOKS_MAX) hooks.delete(hooks.keys().next().value!);
  }
  f.sent = f.sent.filter((t) => t > now - BUCKET_PERIOD_MAX_MS);
  f.sent.push(now);
  if (f.sent.length > SENT_KEEP) f.sent.splice(0, f.sent.length - SENT_KEEP);
  return now;
}
/**
 * The site's own posts to a hook that went into the bucket an answer describes: those started since the bucket began.
 * When an earlier answer gave this bucket's period (`known`: HookState.known, for the same limit) and this one says
 * when it resets, the bucket began that period before its reset, the reset being counted from the start of the post
 * the answer is for (`startedAt`, notePost's mark): Discord measures it when that post reaches it, so neither the time
 * Discord takes over the post nor the answer's way back moves the start read here, and BUCKET_SLACK_MS is left to
 * cover only the difference between two posts' ways to Discord. Otherwise the last period before now is taken (the
 * longer of the one known and the reset this answer gives), which holds every post of the bucket and so never counts
 * the site's own posts as another's.
 */
function ownPosts(f: HookState, now: number, b: Bucket | null, known: boolean, startedAt = now): number {
  const from = b?.resetMs != null && known && b.resetMs <= f.period
    ? Math.min(now, startedAt) + b.resetMs - f.period - BUCKET_SLACK_MS
    : now - Math.max(f.period, b?.resetMs ?? 0);
  return f.sent.filter((t) => t >= from).length;
}

/**
 * Records one answer, and whether it is a 429 of user scope counted toward the hold (the answer). Every answer's
 * bucket headers are kept, successes included, and a bucket known empty pauses the hook until it refills. A 429 is a
 * pause for its Retry-After: on its hook when it is the hook's own (of user or shared scope, or of a bucket that names
 * no scope), on the site's address when it is global or carries none of Discord's headers (counted toward no hook's
 * hold, and leaving every hook's count as it was: pauseSite); either is still charged to the window's budget, as
 * Discord counts it. A user's hook whose 429 of user scope the site's own posts did not cause (ownPosts below the
 * bucket's limit), or whose success leaves a bucket empty that the site's own posts did not fill, counts one toward
 * RATE_LIMITED_HOLD_AFTER in the window, and is held for the window at that many (`held`); a hook held through the end
 * of the window before starts its count one short of it. Any other failure counts toward BACKOFF_AFTER failures in a
 * row. `user`: a user's hook, which an answer of 401, 403 or 404 also counts against in its window (BACKOFF_AFTER of
 * them hold it to the window's end) and which a dead answer holds for DEAD_HOLD_MS; the operator's channel is never
 * held for its window, as dead or as rate-limited.
 * `startedAt`: the post's mark from notePost, from which the answer's bucket is read (ownPosts).
 */
function noteAnswer(url: string, a: Answer, user: boolean, startedAt?: number): boolean {
  const now = Date.now();
  const w = windowOf(now);
  const f = hooks.get(url) ?? newHook(w);
  hooks.delete(url); // set again below, so the map drops the hooks seen longest ago first
  if (f.w !== w) {
    f.limited = f.held === w * INVALID_WINDOW_MS ? RATE_LIMITED_HOLD_AFTER - 1 : 0;
    f.w = w;
    f.bad = 0;
  }
  // A post Discord answered 429 did not go into its bucket.
  if (a.status === 429 && startedAt != null) {
    const i = f.sent.lastIndexOf(startedAt);
    if (i >= 0) f.sent.splice(i, 1);
  }
  const b = a.bucket;
  // Read against the bucket as earlier answers gave it, before this answer's headers are kept.
  const known = f.known && (b?.limit == null || b.limit === f.limit);
  const counted = a.status === 429 && user && a.scope === 'user' && ownPosts(f, now, b, known, startedAt) < (b?.limit ?? f.limit);
  // A success that leaves the bucket empty though the site's own posts in it were fewer than its limit: posts from
  // elsewhere filled it, as a counted 429 says, and the pause it brings would otherwise keep the hook's parts waiting.
  const drained = a.ok && user && b?.remaining === 0 && ownPosts(f, now, b, known, startedAt) < (b.limit ?? f.limit);
  if (b) {
    // A bucket of another limit has a period of its own.
    if (b.limit != null && b.limit !== f.limit) { f.limit = b.limit; f.known = false; }
    if (b.resetMs != null) {
      f.period = Math.min(BUCKET_PERIOD_MAX_MS, Math.max(f.known ? f.period : 0, b.resetMs, BUCKET_PERIOD_DEFAULT_MS));
      f.known = true;
      if (b.remaining === 0) f.pause = Math.max(f.pause, now + b.resetMs);
    }
  }
  if (a.status === 429) {
    if (siteWide(a)) pauseSite(now, a.waitMs);
    else {
      f.pause = Math.max(f.pause, now + a.waitMs);
      if (counted && ++f.limited >= RATE_LIMITED_HOLD_AFTER) f.held = Math.max(f.held, (w + 1) * INVALID_WINDOW_MS);
    }
  } else if (a.ok) {
    f.n = 0;
    f.ok = true;
    if (drained && ++f.limited >= RATE_LIMITED_HOLD_AFTER) f.held = Math.max(f.held, (w + 1) * INVALID_WINDOW_MS);
  }
  else {
    f.ok = false;
    f.n += 1;
    if (f.n >= BACKOFF_AFTER) f.until = Math.max(f.until, now + BACKOFF_MS);
    if (user && a.invalid && ++f.bad >= BACKOFF_AFTER) f.until = Math.max(f.until, (w + 1) * INVALID_WINDOW_MS);
    if (user && a.dead) f.until = Math.max(f.until, now + DEAD_HOLD_MS);
  }
  hooks.set(url, f);
  if (hooks.size > HOOKS_MAX) hooks.delete(hooks.keys().next().value!);
  return counted;
}
/**
 * Whether an answer blames the link itself: Discord's own JSON refusing it (a 400 that is not Invalid Form Body, a
 * 401, 403 or 404; a block page in front of Discord answers every hook alike), or a 429 of user scope counted toward
 * the hold (`counted`, noteAnswer). A row saved on with no post yet taken (the connection notice's note) is stopped at
 * the first such answer (stopTrialHooks, api.ts test route).
 */
const blamesLink = (a: Answer, counted: boolean) =>
  (a.code != null && ((a.status === 400 && !a.refused) || a.status === 401 || a.status === 403 || a.status === 404)) || (a.status === 429 && counted);

/** This isolate's own count for the window, used when the stored count cannot be read. */
let localInvalid = { w: 0, n: 0 };
/** Invalid answers counted in window `w`, by every isolate (kv `alerts.invalid`) or, when that cannot be read, by this one. */
async function invalidSpent(db: D1Database | undefined, w: number): Promise<number> {
  const mine = localInvalid.w === w ? localInvalid.n : 0;
  if (!db) return mine;
  const cur = await kvGetJson<{ w: number; n: number }>(db, INVALID_KEY).catch(() => null);
  return Math.max(mine, cur && cur.w === w && Number.isFinite(cur.n) ? cur.n : 0);
}
/** Adds `n` invalid answers to this isolate's count for window `w`. */
function countInvalid(w: number, n: number) {
  if (n) localInvalid = localInvalid.w === w ? { w, n: localInvalid.n + n } : { w, n };
}
/** Adds `n` invalid answers to window `w` in kv `alerts.invalid`, in one statement, so isolates that write at once never lose a count. */
async function storeInvalid(db: D1Database | undefined, w: number, n: number) {
  if (!n || !db) return;
  await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, json_object('w', ?, 'n', ?), ?)
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_extract(kv.value, '$.w') = ? THEN json_object('w', ?, 'n', json_extract(kv.value, '$.n') + ?) ELSE excluded.value END, updated_at = excluded.updated_at`,
  ).bind(INVALID_KEY, w, n, Date.now(), w, w, n).run().catch((e) => console.error('alerts.invalid:', e));
}

/** kv `alerts.skipped`: posts that were not sent, in all and the last case. */
export interface AlertsSkipped { total: number; last: { what: string; n: number; at: number } }

/**
 * The most webhook posts the forum and governance alerts of one cron run make in all. Every post is a subrequest of
 * the run, counted with its chain reads and D1 calls against the per-invocation limit, and every saved settings row
 * with forumAndGov on adds one post to every alert, so without a bound the posts of a run grow with the subscribers
 * times the alerts. It covers one whole alert (DELIVERABLE_MAX subscribers and the operator) and keeps a run within
 * 1,000 subrequests (the tick measured about 311 on its own, docs/design/screener-plan.md).
 */
export const RUN_ALERT_POSTS = 600;
/** A later forum or governance alert of a run starts only within this long of the run's start (admit). */
export const RUN_ALERT_WINDOW_MS = 30_000;
/**
 * No subscriber post of a cron run's alerts starts later than this after the run's start, so its last post ends
 * (WEBHOOK_TIMEOUT_MS) before the next tick, whatever an alert's window would allow.
 */
export const RUN_ALERT_DEADLINE_MS = 50_000;
/**
 * The most webhook posts one LiveHub dispatch makes: an alarm (its pending alerts, its Namada scan and its Osmosis
 * catch-up search together) or one live stream message. Each post is a subrequest of the invocation. What is assumed
 * of the platform (Cloudflare's Workers and Durable Objects limits as read before 2026-10-23, not measured here): a
 * Durable Object has the same limit as a Worker, 1,000 subrequests per invocation on the Workers Paid plan, an alarm
 * handler being one invocation as a request or a WebSocket message is; fetch() calls and binding calls (each D1
 * statement or batch) count, the object's own storage calls do not. The alarm's own reads are not counted against a
 * figure of their own: a scan keeping up makes a few dozen (status, block metas, block results, tx bytes, D1 writes,
 * the settings read, a claim and a few records per alert), a scan behind about three a block as far as its deadline
 * lets it, and a catch-up search up to 16 pages, a block read per transaction found and a D1 lookup per 90 hashes.
 * About half the limit is kept for those reads, so an alarm whose alerts use the whole count still has about 160
 * blocks of a scan behind, or a search of 100 transactions, before the platform refuses a read. The count covers one
 * whole alert (DELIVERABLE_MAX subscribers and the operator) with a few to spare; what does not fit waits for the
 * next alarm, never dropped (AlertBudget.defers).
 */
export const LIVE_ALERT_POSTS = 520;
/**
 * The shared records of one dispatch: the invalid-answer count of window `w` as read at its first post to a
 * subscriber (`spent`) and the dispatch's own (`pending`), the posts not sent (`skipped`, over `alerts` alerts), and
 * the links posted to with success (`ok`). flushAlerts writes them once, at the end of the dispatch.
 */
interface DispatchRecords { w: number; spent: number | null; pending: number; skipped: { n: number; what: string; alerts: number } | null; ok: Set<string> }
/**
 * One dispatch's alert budget, shared by every alert the dispatch sends: a cron run's forum and governance alerts
 * (alertBudget), one LiveHub alarm's move alerts (alarmBudget) or one live stream message's (fanoutBudget). Every post
 * the dispatch starts is counted once in `posts`, the operator's among them (each is a subrequest), but neither the
 * count, the window nor the deadline ever cuts the operator's channel: it goes first in every alert, and only
 * subscribers' posts are cut past what is left. A post that is not started (backed off, held by the invalid-answer
 * budget, past the window) is not counted.
 * - `posts`: the posts the dispatch may still start.
 * - `until`, `started`, `waiting`, `closed`: a cron run admits its first alert whatever its size, and a later one only
 *   before `until` and when all its subscribers' posts fit in `posts` (admit); `waiting` counts the alerts left for
 *   the next run, and once one waits (`closed`) every later one of the run does.
 * - `deadline`: no subscriber post of the dispatch starts at or after it (a cron run's RUN_ALERT_DEADLINE_MS, an
 *   alarm's own deadline less WEBHOOK_TIMEOUT_MS).
 * - `shared`, `opened`: a live stream message keeps one fan-out window for all its moves, opened at its first post;
 *   every other alert has a window of its own.
 * - `defers`: the dispatch sends later what does not fit now (the LiveHub keeps a move's subscribers that a window,
 *   the count, the deadline or the invalid-answer budget cut for its next alarm, live-hub.ts PendingAlert), so such a
 *   post is handed back (sendDiscordWhaleAlert's answer), not recorded as skipped; without it, it is recorded.
 * - `rec`: the dispatch's shared records (DispatchRecords), read once and written once (flushAlerts).
 * - `unread`: an alert of the run waited because the subscribers' settings could not be read (sendForumGov), so the
 *   run's health note says so rather than that its posts or its window were spent.
 * - `halted`: a dispatch that sends later had a post answered with a 429 that limits the site's address (of global
 *   scope, or with none of Discord's headers): the rest of its subscribers' posts are handed back for the next alarm,
 *   as a deadline cut does (spentOut), and only the operator's channel is posted.
 * - `paused`: an alert of a run that does not send later waited because Discord limited the site's address (admit),
 *   so the run's health note says so.
 */
export interface AlertBudget {
  posts: number;
  until: number;
  started: boolean;
  waiting: number;
  closed?: boolean;
  unread?: boolean;
  halted?: boolean;
  paused?: boolean;
  deadline?: number;
  shared?: boolean;
  opened?: number | null;
  defers?: boolean;
  rec?: DispatchRecords;
}
/** The budget of one cron run's forum and governance alerts. */
export const alertBudget = (now = Date.now()): AlertBudget => ({ posts: RUN_ALERT_POSTS, until: now + RUN_ALERT_WINDOW_MS, deadline: now + RUN_ALERT_DEADLINE_MS, started: false, waiting: 0 });
/** The budget of one LiveHub alarm (live-hub.ts alarm): LIVE_ALERT_POSTS posts and `deadline`, a window per alert; `defers` as the hub keeps a pending list. */
export const alarmBudget = (deadline: number, defers = false): AlertBudget => ({ posts: LIVE_ALERT_POSTS, until: Infinity, deadline, started: false, waiting: 0, defers });
/** The budget of one live stream message (live-hub.ts alertFlows): LIVE_ALERT_POSTS posts and one fan-out window across its moves. */
export const fanoutBudget = (defers = false): AlertBudget => ({ posts: LIVE_ALERT_POSTS, until: Infinity, deadline: Infinity, shared: true, opened: null, started: false, waiting: 0, defers });
/**
 * Whether a dispatch can start no more subscriber posts: its count or its deadline is spent, or, for a dispatch that
 * sends later, Discord limits the site's address (`halted`, or a limit another dispatch of this isolate heard that has
 * not ended), so what is left waits for the next alarm whole.
 */
export const spentOut = (b: AlertBudget | undefined): boolean =>
  !!b && (b.posts <= 0 || Date.now() >= (b.deadline ?? Infinity) || !!b.halted || (!!b.defers && sitePause > Date.now()));
/**
 * Whether an alert of `n` subscriber posts starts under `budget` (none: no bound). The first alert of a run always
 * starts, unless Discord limits the site's address now (sitePause); a later one only when all its posts fit in what is
 * left and the window is open, and no earlier alert of the run waits (`closed`), so the alerts a run sends are always
 * the first ones offered. One that does not start waits for the next run: its caller keeps its cursor before it, and
 * its claim is not taken.
 */
function admit(budget: AlertBudget | undefined, n: number): boolean {
  if (!budget) return true;
  const limited = sitePause > Date.now();
  if (budget.closed || limited || (budget.started && (n > budget.posts || Date.now() >= budget.until))) {
    budget.waiting++;
    budget.closed = true;
    if (limited) budget.paused = true;
    return false;
  }
  budget.started = true;
  return true;
}

/** The dispatch's records for window `w`; a window that turned during the dispatch has its count written first. */
async function recordsOf(db: D1Database | undefined, b: AlertBudget, w: number): Promise<DispatchRecords> {
  if (b.rec && b.rec.w !== w) {
    await storeInvalid(db, b.rec.w, b.rec.pending);
    b.rec = { ...b.rec, w, spent: null, pending: 0 };
  }
  return (b.rec ??= { w, spent: null, pending: 0, skipped: null, ok: new Set() });
}
/** Adds `n` posts not sent for `what` to the dispatch's records (written by flushAlerts). */
function noteSkipped(r: DispatchRecords, n: number, what: string) {
  r.skipped = { n: (r.skipped?.n ?? 0) + n, what, alerts: (r.skipped?.alerts ?? 0) + 1 };
}
/** Records `n` posts not sent for `what`: in the dispatch's records when there is a budget (written once, by flushAlerts), else at once. */
export async function noteNotSent(db: D1Database | undefined, budget: AlertBudget | undefined, n: number, what: string) {
  if (budget) noteSkipped(await recordsOf(db, budget, windowOf(Date.now())), n, what);
  else await recordSkipped(db, n, what);
}
/**
 * Writes what a dispatch recorded, once: its invalid answers (kv `alerts.invalid`), its posts not sent (kv
 * `alerts.skipped`) and its successful posts (each served row's `okAt`, at most once a day a row). Every dispatch
 * calls it when it ends (the cron run, the LiveHub alarm, a stream message); an alert sent without a budget writes its
 * own at once.
 */
export async function flushAlerts(db: D1Database | undefined, budget: AlertBudget | undefined) {
  const r = budget?.rec;
  if (!r) return;
  budget!.rec = undefined;
  await storeInvalid(db, r.w, r.pending);
  if (r.skipped) await recordSkipped(db, r.skipped.n, r.skipped.alerts > 1 ? `${r.skipped.what}, and ${r.skipped.alerts - 1} other alert(s) of the same pass` : r.skipped.what);
  if (r.ok.size) await noteHooksOk(db, r.ok);
}

/** Discord's error code for a body it will not take (Invalid Form Body: a field over its limit, a malformed url). */
export const DISCORD_INVALID_FORM_BODY = 50035;
/** An error answer is read for its first this-many bytes (Discord's JSON error is a few hundred bytes); the rest is cancelled. */
const REFUSAL_READ_MAX_BYTES = 4096;

/**
 * The top-level code of Discord's JSON error answer, or null when the answer is not Discord's JSON (a block page in
 * front of Discord, an empty body). An answer cut at REFUSAL_READ_MAX_BYTES is still read for the code Discord
 * writes before its list of errors. Never throws.
 */
async function discordCode(res: Response): Promise<number | null> {
  try {
    if (!res.body) return null;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (bytes < REFUSAL_READ_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        bytes += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const all = new Uint8Array(Math.min(bytes, REFUSAL_READ_MAX_BYTES));
    let o = 0;
    for (const p of parts) {
      if (o >= all.length) break;
      const part = p.subarray(0, all.length - o);
      all.set(part, o);
      o += part.length;
    }
    const text = new TextDecoder().decode(all);
    try {
      const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
      return typeof code === 'number' ? code : null;
    } catch {
      // The top-level code, before any nested object (each error inside names its own code as a word).
      const m = /^\s*\{[^{]*"code"\s*:\s*(\d+)\s*[,}]/.exec(text);
      return m ? Number(m[1]) : null;
    }
  } catch {
    return null;
  }
}

/**
 * How one answer counts. A 400 with Discord's Invalid Form Body code is the body refused (a field over its limit),
 * the same body lost on every channel; any other 400 is the hook's own (a webhook made in a forum channel answers
 * 220001 to every post that names no thread). A 401, 403, 404 or a 429 not of shared scope is invalid (charged to the
 * window's budget, as Discord counts them, a global or header-less 429 among them). A hook is dead only when Discord's
 * own JSON says so (Unknown Webhook on a 404, Invalid Webhook Token on a 401): a block page in front of Discord answers
 * every hook alike and says nothing of any one of them. Every answer's bucket headers are read, a success's too.
 */
async function answerOf(res: Response): Promise<Answer> {
  const s = res.status;
  const bucket = bucketOf(res);
  if (res.ok) return { ...NO_ANSWER, ok: true, status: s, bucket };
  const scope = s === 429 ? scopeOf(res) : null;
  const invalid = s === 401 || s === 403 || s === 404 || (s === 429 && scope !== 'shared');
  const code = s === 400 || s === 401 || s === 403 || s === 404 ? await discordCode(res) : null;
  return {
    ok: false,
    status: s,
    refused: s === 400 && code === DISCORD_INVALID_FORM_BODY,
    invalid,
    dead: (s === 404 && code === DISCORD_UNKNOWN_WEBHOOK) || (s === 401 && code === DISCORD_INVALID_WEBHOOK_TOKEN),
    waitMs: s === 429 ? retryAfterMs(res) : 0,
    code,
    scope,
    bucket,
  };
}

/**
 * One request to a hook: marked as started (notePost), answered, its answer's body read or cancelled, and the answer
 * counted against the hook (noteAnswer, whose result it returns as `counted`). No answer at all is NO_ANSWER.
 */
async function postOnce(url: string, body: Record<string, unknown>, files: PostFile[] | undefined, user: boolean): Promise<{ a: Answer; counted: boolean }> {
  let a: Answer;
  const startedAt = notePost(url);
  try {
    const res = await postWebhook(url, body, files);
    try { a = await answerOf(res); } finally { await releaseBody(res); }
  } catch { a = NO_ANSWER; }
  return { a, counted: noteAnswer(url, a, user, startedAt) };
}

/** Adds `n` posts not sent for `what` to kv `alerts.skipped` (the cron's health view shows the last). */
async function recordSkipped(db: D1Database | undefined, n: number, what: string) {
  if (!db) return;
  const cur = (await kvGetJson<AlertsSkipped>(db, 'alerts.skipped').catch(() => null)) ?? { total: 0, last: { what, n: 0, at: 0 } };
  await kvSet(db, 'alerts.skipped', { total: cur.total + n, last: { what, n, at: Date.now() } }).catch(() => {});
}

/**
 * Turns off the channel of every user whose hook Discord answered is gone or has a wrong token: Discord asks that
 * such a hook not be posted again, and nothing done on Discord makes the same link work. The rows go out of this
 * isolate's users at once; each row is written only if its owner has not saved it since it was read
 * (settings.ts stopChannelStmt), and the owner turns the channel on again by saving a link.
 */
async function stopDeadHooks(db: D1Database | undefined, dead: Map<string, number>) {
  const c = db ? usersCache.get(db) : undefined;
  if (!db || !c || !settingsKey || !dead.size) return;
  const gone = c.users.filter((u) => dead.has(u.channels.discord.webhookUrl!));
  if (!gone.length) return;
  c.users = c.users.filter((u) => !dead.has(u.channels.discord.webhookUrl!));
  const at = Date.now();
  try {
    const stmts = await Promise.all(gone.map((u) => stopChannelStmt(db, settingsKey!, u, dead.get(u.channels.discord.webhookUrl!)!, at)));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    console.warn(`alerts: ${gone.length} user channel(s) turned off: Discord answered that the webhook is gone or its token is wrong`);
  } catch (e) {
    console.error('alerts: a dead channel could not be turned off:', e);
  }
}

/**
 * Turns off the channel of every row on trial whose link an answer blamed (`blamed`: link to Discord's status): a row
 * saved on with the connection notice's note (its notice was answered nothing against the link, settings.ts `notice`)
 * and no successful post recorded holds its place only until a post or a test shows the link works; the first answer
 * that blames the link (blamesLink) ends that. Rows that share the link but are proven, or carry no note, are left on.
 * Each row is written only while it is as it was read and still records no success (settings.ts stopChannelStmt with
 * reason 'notice'), and the Settings page says what was answered and when.
 */
async function stopTrialHooks(db: D1Database | undefined, blamed: Map<string, number>) {
  const c = db ? usersCache.get(db) : undefined;
  if (!db || !c || !settingsKey || !blamed.size) return;
  const stop = c.users.filter((u) => blamed.has(u.channels.discord.webhookUrl!) && !!u.channels.discord.notice && !c.okAt.has(u.address));
  if (!stop.length) return;
  const gone = new Set(stop);
  c.users = c.users.filter((u) => !gone.has(u));
  const at = Date.now();
  try {
    const stmts = await Promise.all(stop.map((u) => stopChannelStmt(db, settingsKey!, u, blamed.get(u.channels.discord.webhookUrl!)!, at, 'notice')));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    console.warn(`alerts: ${stop.length} user channel(s) turned off: Discord refused the first post to a link saved while its connection notice did not reach it`);
  } catch (e) {
    console.error('alerts: a channel on trial could not be turned off:', e);
  }
}

/** A row's successful post is written to it (settings.ts hookOkStmt) at most this often: the proof is the same whenever it was last renewed. */
export const OK_NOTE_EVERY_MS = 24 * 3_600_000;
/**
 * Records in each served row whose link was posted to with success that it was (`okAt`): the row's proof of its link,
 * which every isolate's dispatch reads (userTarget `proven`) and which lets the Settings switch turn the channel on
 * again without a post of its own; a row is written at most once in OK_NOTE_EVERY_MS.
 */
async function noteHooksOk(db: D1Database | undefined, urls: Set<string>) {
  const c = db ? usersCache.get(db) : undefined;
  if (!db || !c || !settingsKey) return;
  const now = Date.now();
  const due = c.users.filter((u) => urls.has(u.channels.discord.webhookUrl!) && !(now - (c.okAt.get(u.address) ?? 0) < OK_NOTE_EVERY_MS));
  if (!due.length) return;
  try {
    const stmts = due.map((u) => hookOkStmt(db, settingsKey!, u.address, u.channels.discord.webhookUrl!, now));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    for (const u of due) c.okAt.set(u.address, now);
  } catch (e) {
    console.error('alerts: a successful post could not be recorded in its settings row:', e);
  }
}

/**
 * One post. `op` marks the operator's channel (DISCORD_WEBHOOK_URL), which goes first and is never cut or held by any
 * budget (the dispatch's post count and deadline, the fan-out window, the invalid-answer budget); `proven`, a user's
 * row that records a successful post to its link (`okAt`); `fresh`, a user's row with none whose link was first
 * turned on within SETTLED_MS (the only kind the invalid-answer budget holds once spent); `trial`, a user's row saved
 * on with the connection notice's note and no successful post, which the first answer that blames its link turns off
 * (stopTrialHooks). `files`: the files the post attaches (a digest's pictures; postWebhook sends them as a form), and,
 * when Discord refuses them, the post goes once more as text only (textOnly). `more`: the posts that follow it to the
 * same channel (a digest's second message), each sent only after the one before it was taken, in order, by the same
 * worker of the dispatch, and each counted as a post.
 */
interface Target { url: string; body: Record<string, unknown>; files?: PostFile[]; more?: WebhookPost[]; op?: boolean; proven?: boolean; fresh?: boolean; trial?: boolean }
/** The posts a target makes when every one is taken (its own and those that follow it). */
const postsOf = (t: Target) => 1 + (t.more?.length ?? 0);
/** A user's target as the fan-outs build it, with what the settings read knows of its link (`okAt`, `onAt`, by address). */
const userTarget = (u: StoredSettings, body: Record<string, unknown>, db?: D1Database): Target => {
  const c = db ? usersCache.get(db) : undefined;
  const proven = !!c?.okAt.has(u.address);
  const onAt = c?.onAt.get(u.address) ?? u.updatedAt;
  return { url: u.channels.discord.webhookUrl!, body, proven, fresh: !proven && onAt > Date.now() - SETTLED_MS, trial: !proven && !!u.channels.discord.notice };
};
/**
 * Where in the subscribers an alert's posts begin: a different place for each alert (a digest of its label), so the
 * posts a deadline or a budget cuts off are never always the same channels' (the settings are read in one fixed
 * order, first saved first).
 */
const startAt = (what: string, n: number): number => {
  if (n < 2) return 0;
  const h = sha256(new TextEncoder().encode(what));
  return (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % n;
};

/**
 * One body to each webhook, a few at a time, within the alert's fan-out window (windowFor) and what is left of
 * `budget`; what could not start is handed back (`left`) to a dispatch that sends later (AlertBudget.defers), else
 * recorded, never dropped unseen. The operator's channel goes first; then every subscriber in one order, from startAt
 * on, so what a window, a count or a deadline cuts moves from alert to alert. What is known of a hook decides only
 * who is held once the invalid-answer budget is spent (a link turned on within SETTLED_MS that has never worked: no
 * `okAt` in its row and no success here), never the order. A hook in a 429 pause (Discord's Retry-After) is handed
 * back too when the dispatch sends later, and so is a subscriber's post that a 429 answers; the operator's channel
 * waits a short pause out in place, within the alert's window, and is otherwise skipped as a hook in its backoff is.
 * A 429 that limits the site's address (siteWide) halts a dispatch that sends later: every subscriber's post left is
 * handed back (AlertBudget.halted). A dispatch that does not send later (a cron run's forum and governance alerts,
 * whose claim is taken) never records a subscriber as not sent for such a limit: a short pause is waited out in
 * place, once, within the alert's window and the dispatch's deadline, and past a longer one the post goes anyway, its
 * own answer deciding (a limit that is still there answers again, and is counted as invalid like any other); the
 * operator's channel waits a short one out, or is posted anyway, the same way. A hook held for the window as kept
 * rate-limited (RATE_LIMITED_HOLD_AFTER) is skipped and recorded, never handed back: its posts cost the dispatch
 * nothing, and a part kept for it drains. A row on trial (Target.trial) whose link an answer blames is turned off
 * (stopTrialHooks). `budget`, when given, is the dispatch's (AlertBudget): its post count, its deadline and its
 * records are shared with the dispatch's other alerts, and the dispatch writes the records when it ends
 * (flushAlerts); without one, the alert writes its own.
 */
async function postAll(targets: Target[], db: D1Database | undefined, what: string, budget?: AlertBudget, handBack = false): Promise<{ posted: number; reached: number; skipped: number; left: Target[] }> {
  if (!sending) {
    // A run that does not send alerts (sendsAlerts) posts nothing; what it would have posted is logged and recorded
    // as not sent, so a production Worker left without SEND_ALERTS shows in the health view instead of going quiet.
    if (targets.length) {
      const label = `${what} (SEND_ALERTS is not yes)`;
      console.log(`alerts: ${targets.length} posts for ${label} not sent`);
      await recordSkipped(db, targets.length, label);
    }
    return { posted: 0, reached: 0, skipped: targets.length, left: [] };
  }
  const b: AlertBudget = budget ?? { posts: Infinity, until: Infinity, started: true, waiting: 0 };
  // `handBack`: this alert sends later what does not fit now although its dispatch does not (a digest, whose channels
  // are claimed one by one and released when not posted), so its cuts are handed back as a deferring dispatch's are.
  // A limit on the site's address then halts this alert only, and closes the run's budget for the alerts after it.
  const defers = !!b.defers || handBack;
  let haltedHere = false;
  const halted = () => !!b.halted || haltedHere;
  const w = windowOf(Date.now());
  const rec = await recordsOf(db, b, w);
  const subs = targets.filter((t) => !t.op);
  const k = startAt(what, subs.length);
  const queue = [...targets.filter((t) => t.op), ...subs.slice(k), ...subs.slice(0, k)];
  // Read once a dispatch: the invalid answers of the window as every isolate counted them, to which the dispatch adds
  // its own. Each post to a user's hook takes one from what is left under the ceiling before it starts, and a hook not
  // proven here one from what is left of the budget too; both are given back when the answer is not invalid.
  if (subs.length && rec.spent == null) rec.spent = await invalidSpent(db, w);
  const used = (rec.spent ?? 0) + rec.pending;
  let room = INVALID_BUDGET - used, ceiling = INVALID_CEILING - used;
  // The window opens at the alert's first post (a stream message's at its first alert's), and lasts long enough for
  // all of this alert's subscriber posts at Discord's pace (a target that makes two posts counts two); the dispatch's
  // deadline bounds it.
  const opened = b.shared ? (b.opened ??= Date.now()) : Date.now();
  const span = windowFor(subs.reduce((n, t) => n + postsOf(t), 0));
  const deadline = b.deadline ?? Infinity;
  let posted = 0, reached = 0, skipped = 0, refused = 0, held = 0, invalid = 0, over = 0, late = 0, limited = 0;
  // Posts sent again without their pictures (Discord refused the files), and posts that follow a target's first that
  // were not taken (a digest's second message).
  let fellBack = 0, lostAfter = 0;
  // A subscriber's post answered 429 in a dispatch that cannot send later: a limit that is not the hook's own bucket is
  // waited out once and the post sent again; a hook's own bucket, a second 429, or a pause longer than the alert can
  // wait is recorded as not sent (the alert's claim is taken, so no later run posts it).
  let rateLimited = 0;
  const retried = new Set<Target>();
  // The subscribers a dispatch that sends later takes back (`left`), by what cut them.
  const left: Target[] = [];
  const waits = { window: 0, late: 0, over: 0, held: 0, paused: 0, halted: 0 };
  const dead = new Map<string, number>();
  // Rows on trial whose link an answer blamed (stopTrialHooks).
  const blamed = new Map<string, number>();
  // How long the operator's channel may wait a 429 pause out in place: a short Retry-After, within the alert's window.
  const opWait = () => Math.min(FANOUT_DEADLINE_MS, opened + span - Date.now());
  // The limit on the site's address this dispatch has waited out in place: a later post waits again only for a limit
  // heard since.
  let waited = 0;
  // The posts that follow a target's first one (a digest's second message), once the first was taken: in order, each
  // after the one before it was taken; a 429 whose Retry-After the alert can wait is waited out once, and files
  // Discord refuses are dropped for the text alone. The hook has just taken a post, so it is proven: each post takes a
  // unit of the ceiling only. Returns how many were not taken.
  const postMore = async (t: Target): Promise<number> => {
    const list = t.more ?? [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!t.op) ceiling--;
      b.posts--;
      let r = await postOnce(t.url, m.body, m.files, !t.op);
      if (r.a.status === 429 && r.a.waitMs <= Math.min(opWait(), t.op ? Infinity : deadline - Date.now())) {
        await sleep(r.a.waitMs);
        b.posts--;
        r = await postOnce(t.url, m.body, m.files, !t.op);
      }
      if (m.files?.length && filesRefused(r.a)) {
        b.posts--;
        fellBack++;
        r = await postOnce(t.url, textOnly(m.body), undefined, !t.op);
      }
      if (r.a.invalid) invalid++;
      else if (!t.op) ceiling++;
      if (r.a.dead && !t.op) dead.set(t.url, r.a.status);
      if (!r.a.ok) return list.length - i;
      posted++;
    }
    return 0;
  };
  const run = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const f = hooks.get(t.url);
      if (f && (f.until > Date.now() || f.held > Date.now())) {
        // In its backoff, its dead hold, or held for the window as kept rate-limited: not posted, and recorded (the
        // last apart, so the record says so). Under a dispatch that sends later too: a part kept for such a hook
        // would otherwise be offered again at every alarm for a day and never drain.
        skipped++;
        if (!(f.until > Date.now())) limited++;
        continue;
      }
      // Discord limits the site's address (a 429 of global scope, or with none of its headers, to any post): a
      // dispatch that sends later hands every subscriber's post back from then on, as a deadline cut does. Without
      // one, a subscriber's post waits a short limit out here, once, within the alert's window and the dispatch's
      // deadline, and is posted anyway past a longer one, never recorded as not sent for it: its own answer decides.
      // The operator's channel waits a short one out, within the alert's window, and is posted anyway past it.
      if (!t.op && halted()) { left.push(t); waits.halted++; continue; }
      const wide = sitePause - Date.now();
      if (wide > 0) {
        if (!t.op && defers) { left.push(t); waits.halted++; continue; }
        const until = sitePause;
        if (until > waited && wide <= (t.op ? opWait() : Math.min(opWait(), deadline - Date.now()))) { await sleep(wide); waited = Math.max(waited, until); }
      }
      if (f && f.pause > Date.now()) {
        // Discord's Retry-After is not over: a subscriber's post waits for the next alarm of a dispatch that sends
        // later (the pause is a few seconds; the alarm comes after it), else it is skipped as before; the operator's
        // channel waits a short pause out here.
        if (!t.op) {
          if (defers) { left.push(t); waits.paused++; } else skipped++;
          continue;
        }
        const wait = f.pause - Date.now();
        if (wait > opWait()) { skipped++; continue; }
        await sleep(wait);
      }
      const proven = !!f?.ok || !!t.proven || !t.fresh;
      if (!t.op) {
        const now = Date.now();
        // a target of two posts (a digest) starts only when its second can start before the deadline at Discord's pace
        const cut = now - opened > span ? 'window' : now + (postsOf(t) - 1) * POST_PACE_MS >= deadline ? 'late' : b.posts < postsOf(t) ? 'over' : ceiling <= 0 || (!proven && room <= 0) ? 'held' : null;
        if (cut) {
          // an alert that hands back (a digest) keeps a hook held by the invalid-answer budget recorded, as before: the
          // budget lasts the window, and handing it back would claim and release it every run of the day
          if (b.defers || (handBack && cut !== 'held')) { left.push(t); waits[cut]++; continue; }
          if (cut === 'held') held++;
          else { skipped++; if (cut === 'late') late++; else if (cut === 'over') over++; }
          continue;
        }
        ceiling--;
        if (!proven) room--;
      }
      b.posts--;
      let { a, counted } = await postOnce(t.url, t.body, t.files, !t.op);
      // Discord refused the files (or the request's size): the same words go once more without the pictures, with a
      // note saying so, rather than the channel losing the message.
      if (t.files?.length && filesRefused(a)) {
        b.posts--;
        fellBack++;
        ({ a, counted } = await postOnce(t.url, textOnly(t.body), undefined, !t.op));
      }
      if (a.invalid) invalid++;
      else if (!t.op) {
        ceiling++;
        if (!proven) room++;
      }
      // A limit on the site's address halts a dispatch that sends later: its subscribers' posts left wait for the
      // next alarm (spentOut), as the rest of its alerts do.
      if (siteWide(a) && defers) {
        if (b.defers) b.halted = true;
        else { haltedHere = true; b.closed = true; b.paused = true; }
      }
      if (a.ok) {
        posted++;
        reached++;
        rec.ok.add(t.url);
        if (t.more?.length) lostAfter += await postMore(t);
      }
      // A refused body is lost and recorded with the posts not sent; any other failure counts against the hook only.
      else if (a.refused) refused++;
      // A 429 did not take the post: a dispatch that sends later takes a subscriber's back for its next alarm; the
      // operator's channel is posted once more after a short Retry-After, within the alert's window.
      else if (a.status === 429) {
        if (!t.op) {
          if (defers) { left.push(t); waits.paused++; }
          // not the hook's own bucket (the site's address, or a bucket shared beyond this hook): posted once more
          else if (a.scope !== 'user' && !retried.has(t) && a.waitMs <= opWait() && Date.now() + a.waitMs < deadline) { retried.add(t); await sleep(a.waitMs); queue.push(t); }
          else rateLimited++;
        }
        else if (a.waitMs <= opWait()) { await sleep(a.waitMs); queue.unshift(t); }
      }
      if (a.dead && !t.op) dead.set(t.url, a.status);
      else if (t.trial && !rec.ok.has(t.url) && blamesLink(a, counted)) blamed.set(t.url, a.status);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POST_CONCURRENCY, queue.length) }, run));
  rec.pending += invalid;
  countInvalid(w, invalid);
  await stopDeadHooks(db, dead);
  await stopTrialHooks(db, blamed);
  if (fellBack) console.warn(`alerts: ${fellBack} posts for ${what} were sent without their pictures (Discord refused the files)`);
  if (skipped || refused || held || rateLimited || lostAfter) {
    const n = skipped + refused + held + rateLimited + lostAfter;
    const notes = [
      refused ? `${refused} refused by Discord` : '',
      lostAfter ? `${lostAfter} second message(s) not taken after the first was` : '',
      rateLimited ? `${rateLimited} answered rate-limited, the claim taken` : '',
      over ? `${over} past the run's post budget` : '',
      late ? `${late} past the run's deadline` : '',
      held ? `${held} held: invalid-answer budget spent` : '',
      limited ? `${limited} to links held for the window: Discord answered them rate-limited, their buckets filled by posts from elsewhere` : '',
    ].filter(Boolean);
    const label = notes.length ? `${what} (${notes.join('; ')})` : what;
    console.error(`alerts: ${n} of ${targets.length} posts for ${label} not sent (window passed, webhook backed off, budget spent or body refused)`);
    noteSkipped(rec, n, label);
  }
  if (left.length) {
    const notes = [
      waits.window ? `${waits.window} past the alert's window` : '',
      waits.late ? `${waits.late} past the run's deadline` : '',
      waits.over ? `${waits.over} past the run's post budget` : '',
      waits.held ? `${waits.held} held: invalid-answer budget spent` : '',
      waits.paused ? `${waits.paused} paused by Discord's Retry-After` : '',
      waits.halted ? `${waits.halted} paused: Discord limited the site's address` : '',
    ].filter(Boolean);
    console.warn(`alerts: ${left.length} of ${targets.length} posts for ${what} wait for a later run (${notes.join('; ')})`);
  }
  if (!budget) await flushAlerts(db, b);
  return { posted, reached, skipped: skipped + held, left };
}
/** Waits `ms`. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Whether a run of the Worker posts alerts: only when its SEND_ALERTS secret is 'yes', which only production has
 * (`wrangler secret put SEND_ALERTS`, value yes; scripts/deploy-check.sh does not deploy without it). Any other run,
 * such as `wrangler dev` on a copy of the production database, posts nothing and never reads the users' settings: a
 * copy holds none of the claims production took after it and every user's settings as they were then, so it would
 * post again what production posted, to channels their owners have since changed or deleted.
 */
export const sendsAlerts = (env: { SEND_ALERTS?: string }): boolean => env.SEND_ALERTS === 'yes';

let settingsKey: string | undefined;
/**
 * Whether this run posts. Each entry of the Worker (index.ts fetch and scheduled, the LiveHub constructor) sets it
 * from sendsAlerts(env) before anything else runs; it is true before that only for code that calls the dispatcher
 * directly (the tests).
 */
let sending = true;
/** The dispatcher needs the settings key and whether this run posts; the Worker sets both at each entry (index.ts, live-hub.ts). */
export function configureAlerts(key: string | undefined, send = true) { settingsKey = key; sending = send; }
/**
 * Whether this run posts alerts, as its entry set it (configureAlerts). The Settings test route asks it first, so a
 * Worker without SEND_ALERTS says that alerts are off instead of a refusal the page would put on the user's link.
 */
export const alertsOn = (): boolean => sending;

// In-memory fast-path deduplication cache (protects against simultaneous WS fanout within the same isolate)
const memoryAlertCache = new Set<string>();
/** Forgets the claims this isolate holds in memory (a test's fresh isolate; the stored claims stay). */
export const resetClaimMemory = () => memoryAlertCache.clear();

function checkMemoryLock(keys: string[]): boolean {
  for (const k of keys) {
    if (memoryAlertCache.has(k)) return false;
  }
  for (const k of keys) {
    memoryAlertCache.add(k);
  }
  if (memoryAlertCache.size > 2000) {
    const first = memoryAlertCache.values().next().value;
    if (first) memoryAlertCache.delete(first);
  }
  return true;
}

/**
 * Atomically claim alert keys in the D1 `kv` table with INSERT OR IGNORE. True when this caller is the first to
 * claim every key, false when any was claimed before (already sent), so offering the same thing again never posts
 * it twice. Fails open: when D1 cannot be written the post goes ahead (a repeat post in another isolate is better
 * than a lost alert), and the memory lock still stops a repeat within this isolate.
 */
export async function claimDiscordAlert(
  db: D1Database | undefined,
  keys: string[],
  now = Date.now(),
): Promise<boolean> {
  if (!checkMemoryLock(keys)) return false;
  if (!db) return true;

  try {
    for (const key of keys) {
      const res = await db
        .prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(key, '1', now)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error('claimDiscordAlert error:', err);
    return true;
  }
}

/**
 * Each key claimed on its own, where claimDiscordAlert takes a set together: the keys this caller is the first to
 * claim. Fails open the same way, for the keys D1 has not answered: when a batch cannot be written, its keys and
 * those of the batches after it count as claimed (the memory lock let them through), while a key an earlier batch
 * found claimed stays refused (another record of the same crossing has posted to that channel).
 */
export async function claimEach(db: D1Database | undefined, keys: string[], now = Date.now()): Promise<Set<string>> {
  const fresh = keys.filter((k) => checkMemoryLock([k]));
  if (!db || !fresh.length) return new Set(fresh);
  const won = new Set<string>();
  let i = 0;
  try {
    for (; i < fresh.length; i += 80) {
      const part = fresh.slice(i, i + 80);
      const res = await db.batch(part.map((k) => db.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(k, '1', now)));
      part.forEach((k, j) => { if (Number(res[j]?.meta?.changes ?? 0) > 0) won.add(k); });
    }
    return won;
  } catch (err) {
    console.error('claimDiscordAlert error:', err);
    for (const k of fresh.slice(i)) won.add(k);
    return won;
  }
}

/**
 * Gives claims back: the keys of channels a digest claimed and could not post this run (postAll handed them back), so
 * a later run can take them. A key whose delete D1 does not answer stays claimed, and its channel goes without that
 * period's digest, as a claim taken and not posted always did; the caller records it.
 */
export async function releaseClaims(db: D1Database, keys: string[]): Promise<number> {
  for (const k of keys) memoryAlertCache.delete(k);
  let freed = 0;
  for (let i = 0; i < keys.length; i += 80) {
    const part = keys.slice(i, i + 80);
    try {
      await db.prepare(`DELETE FROM kv WHERE key IN (${part.map(() => '?').join(',')})`).bind(...part).run();
      freed += part.length;
    } catch (err) {
      console.error('digest: claims of channels not posted could not be given back', err);
    }
  }
  return freed;
}

/**
 * The crossing a NAM bridge record belongs to: the packet both chains record, named by its source channel and its
 * sequence. The sending chain numbers the packets of a channel once each and the receiving chain's record carries
 * the same number, so a crossing's two records (Namada's and Osmosis's) give the same key and any other crossing
 * gives another, however alike its addresses, amount and time; no time window is involved. A crossing to Osmosis
 * leaves on Namada's channel (NAM.namadaChannel), one to Namada on Osmosis's (NAM.osmoChannel), and a record counts
 * only when it names its own end of that pair. Null for a record no packet was bound to (a Namada leg that no packet
 * of its own inner transaction fits) and for a move in another coin: such a record is posted on its own id and pairs
 * with nothing, since a guess could only make it hide a crossing it does not belong to.
 */
export function crossingOf(flow: Flow): string | null {
  if ((flow.kind !== 'ibc_in' && flow.kind !== 'ibc_out') || isOtherCoin(flow)) return null;
  if (flow.meta?.channel !== (flow.chain === 'namada' ? NAM.namadaChannel : NAM.osmoChannel)) return null;
  const seq = flow.meta?.packetSequence;
  if (typeof seq !== 'string' || !/^\d+$/.test(seq)) return null;
  const toOsmosis = (flow.chain === 'osmosis') === (flow.kind === 'ibc_in');
  return `${toOsmosis ? NAM.namadaChannel : NAM.osmoChannel}:${seq}`;
}

/**
 * Whether a "Before this" row is a record of the crossing read as crossingIn: the same record, the same packet, or,
 * when a record carries no packet, the other chain's bridge record of the same amount within CROSSING_PAIR_MS (the
 * rule shared/flow-rules.ts pairs the two records of a crossing by).
 */
function sameCrossing(m: PriorMove, c: NonNullable<MoveContext['crossingIn']>): boolean {
  if (m.id === c.id) return true;
  if (m.kind !== 'ibc_in' && m.kind !== 'ibc_out') return false;
  if (m.crossing && c.crossing) return m.crossing === c.crossing;
  return m.chain !== 'osmosis' && Math.abs(m.amount - c.amount) < 1e-6 && Math.abs(m.ts - c.ts) <= CROSSING_PAIR_MS;
}

/** A channel in a stored key: the webhook URL holds the token that posts to it, so the key keeps a digest, never the URL. */
const channelKey = (url: string) => bytesToHex(sha256(new TextEncoder().encode(url))).slice(0, 32);

/** Settings are read at most once per this long per database (a saved change takes effect within it); decrypted copies live in memory only. */
export const USERS_CACHE_MS = 15_000;
/** kv `alerts.skipped` labels for subscribers a read of the settings did not serve. */
export const UNSERVED_WHAT = 'subscribers left unread (past the cap, or settings that do not open)';
export const UNREAD_WHAT = 'subscribers (their settings could not be read)';
/** The users read (readDeliverable), when each served row's link last had a successful post (`okAt`) and was first turned on (`onAt`), by address. */
const usersCache = new WeakMap<D1Database, { at: number; users: StoredSettings[]; okAt: Map<string, number>; onAt: Map<string, number> }>();
/** Thrown by a resumed alert (sendDiscordWhaleAlert `resume`) when the users' settings could not be read: the part is kept as it is, and the alarm's resume stops (live-hub.ts sendPending). */
export class UsersUnreadError extends Error {
  constructor(cause: unknown) { super(`the users' settings could not be read: ${String(cause).slice(0, 120)}`); }
}
/**
 * The users the dispatcher serves, or null when their settings could not be read now (a failed D1 read), which is not
 * an empty match: a dispatch that sends later keeps the alert for its next alarm (AlertBudget.defers), any other
 * records the read with the posts not sent, so a failed read is never left quiet.
 */
async function getUsers(db?: D1Database, budget?: AlertBudget): Promise<StoredSettings[] | null> {
  // A run that does not send alerts never decrypts the users' settings (a database copy holds them as they were).
  if (!db || !sending) return [];
  const c = usersCache.get(db);
  if (c && Date.now() - c.at < USERS_CACHE_MS) return c.users;
  // Recorded with the posts not sent: in the dispatch's records when there is one (written once, when it ends).
  const note = async (n: number, what: string) => {
    if (budget) noteSkipped(await recordsOf(db, budget, windowOf(Date.now())), n, what);
    else await recordSkipped(db, n, what);
  };
  try {
    const { users, unserved, okAt, onAt } = await readDeliverable(db, settingsKey);
    usersCache.set(db, { at: Date.now(), users, okAt, onAt });
    // Subscribers the read left out (past the cap, or settings that do not open) are recorded once a read, with the
    // posts not sent, so the health view shows them.
    if (unserved) await note(unserved, UNSERVED_WHAT);
    return users;
  } catch (e) {
    console.error('alerts: the users\' settings could not be read', e);
    if (!budget?.defers) await note(1, UNREAD_WHAT);
    return null;
  }
}

/**
 * A NAM move at or above the whale size. A move in another coin (shielded USDC, OSMO…: meta.tokenSymbol) is never
 * one, whatever its size: its amount is in that coin's units, not NAM.
 */
export const isNamWhale = (flow: Flow, whaleNam: number): boolean => !isOtherCoin(flow) && flow.amount >= whaleNam;

/**
 * A move the operator's channel hears of: a NAM whale (isNamWhale) that is neither a bot round trip (the site leaves
 * those out of every buy and sell figure, and the Large trade rule leaves them out) nor a claim of staking rewards (no
 * market event). Plain transfers stay: NAM moving between two wallets is the market's business. Owner's calls of
 * 2026-10-23.
 */
export const operatorMove = (flow: Flow, whaleNam: number): boolean => isNamWhale(flow, whaleNam) && !isBotFlow(flow) && flow.kind !== 'rewards';

/**
 * Whether the live alert pass (live-hub.ts alertFlows) offers a move to sendDiscordWhaleAlert at all. `minNam` is a
 * NAM size, so it reads NAM moves only. A move into or out of the shielded set is always offered, and so is a move
 * in another coin: no NAM size can measure it, and only a watchlist can match it (no rule or whale size is in its
 * coin), so it is offered for the watchers of its addresses whatever its size.
 */
export const offeredForAlerts = (flow: Flow, minNam: number): boolean =>
  isOtherCoin(flow) || flow.kind === 'shield' || flow.kind === 'unshield' || flow.amount >= minNam;

// ---------------------------------------------------------------- the messages
//
// Every message is one card with the same bones (docs/design/owner-decisions.md 16): above the title, why it reached
// this channel; the title, the amount and what happened in the site's own words, which a lock screen shows; the first
// line of the text, who moved it and the price with its source in plain words, which a lock screen shows next (no
// markdown and no Discord time stamp there); then the links, what the person did before (this site's records) and what
// the site's own page says such a move means; the figures, each with its source; the record and its block in the
// footer; the move's own time. Text an outsider wrote (a label, a tag, a bridge receiver, a forum post, a proposal) is
// shown as text, never as markdown or a link, and kept to TEXT_MAX; fits() keeps every message inside Discord's limits.

const ORIGIN = SITE.origin;
/** Every message comes from one sender, the site, with the site's own mark (owner decision 4: the Namada symbol is placed nowhere). */
export const SENDER = { username: SITE.name, avatar_url: `${ORIGIN}/icon-512.png` } as const;
/**
 * The colour bar of a forum post, a governance proposal and the Settings test message: the site's --ink-3, --ink and
 * --accent (docs/design/system.md 4.1, dark). A move's bar is the hue of the tag the site puts on it (shared/kinds.ts
 * HUE_HEX): direction is in the words, never in a green or a red.
 */
export const COLOUR = { forum: 0x858585, governance: 0xf5f5f5, test: 0xffff00 } as const;
/** Discord's limits on an embed's parts, and on all the embeds of one message together (`total`). */
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25, total: 6000 } as const;
/**
 * Outsider text is kept to these lengths in a message: a label or a tag, a validator's name, a proposal's authors, a
 * forum display name and user name, a forum category, a forum excerpt, a proposal's abstract and a title. The chain
 * bounds only a whole proposal (10,000 bytes), so its authors alone could otherwise fill a description.
 */
export const TEXT_MAX = { label: 80, validator: 60, authors: 120, displayName: 80, username: 60, category: 50, excerpt: 300, abstract: 220, title: 250 } as const;

/**
 * `s` cut to at most `max` characters, "…" last: never inside a character made of two code units, and never after a
 * backslash left alone by the cut (it would escape the "…").
 */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return max === 1 ? '…' : '';
  let t = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  const tail = /\\+$/.exec(t);
  if (tail && tail[0].length % 2 === 1) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
/**
 * In a description or a field, where Discord renders markdown: the text on one line with every markdown character
 * escaped (a leading quote, heading or list mark too, and "<" so no mention, channel or time stamp is made of it), so
 * a label or a post reads as typed.
 */
export const textSafe = (s: string) =>
  plainMd(s.replace(/[\r\n]+/g, ' ').replace(/[\\`*_<]/g, '\\$&').replace(/\|\|/g, '| |').replace(/~~/g, '~ ~').replace(/^\s*([>#-])/, '\\$1'));
/** In a title or an author line (no markdown is rendered there): one line, links broken. */
const oneLine = (s: string) => plainMd(s.replace(/[\r\n]+/g, ' ').trim());
/** Inside a masked link's text a bracket would end the link: none is kept. */
const linkText = (s: string) => textSafe(s).replace(/[[\]]/g, '');
/** The page of an address on the site, where what it did before and after this move is listed. */
const sitePage = (addr: string) => `${ORIGIN}/activity?addr=${encodeURIComponent(addr)}`;
const unix = (ms: number) => Math.floor(ms / 1000);
const EXPLORER_NAME: Record<string, string> = { osmosis: 'Mintscan', namada: 'namada.valopers.com' };
const I = INTERNAL_ADDRESSES;
/** A protocol account by its name inside a sentence; such an account is never the person of a card. */
const PROTOCOL_WORDS: Record<string, string> = {
  [I.masp]: 'the shielded pool', [I.pos]: 'the staking account', [I.ibc]: 'the bridge account', [I.pgf]: 'the public funding account',
  [I.governance]: 'the governance account', [I.osmoTransfer]: 'the Osmosis bridge account',
};
/** An age inside a sentence ("50 min"); one under five seconds is "moments". */
const ageWords = (ms: number) => (fmtAge(ms) === 'now' ? 'moments' : fmtAge(ms));
const pct0 = (x: number) => `${Math.round(Math.abs(x))}%`;
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One side of a move in words: a protocol account by its name ("the shielded pool"); a label with the short address
 * beside it (a genesis label names many addresses) and a wallet's own tag with its byline, as every page writes them;
 * a short address; or, for text a bridge sender chose that is no address (an Osmosis receiver is free text), that text
 * in a code span, where it can neither link nor format, said to be no address.
 */
function sideWords(s: Party): string {
  const a = s.address;
  if (!a) return 'an account this record does not name';
  if (PROTOCOL_WORDS[a]) return PROTOCOL_WORDS[a];
  if (!chainOf(a)) return `\`${plainMd(codeSafe(fmtAddr(a)))}\` (not an address)`;
  if (!s.label) return fmtAddr(a);
  const by = tagByline(s.source, s.author);
  return `${textSafe(cutText(s.label, TEXT_MAX.label))}${labelNeedsAddr(a, s.label) ? ` ${fmtAddr(a)}` : ''}${by ? ` (${by})` : ''}`;
}
/** A bridge record's side: the bridge's own account stands for the other end, which this record does not name. */
function crossingSide(s: Party, role: 'sender' | 'receiver', chain: string): string {
  if (s.address === I.ibc || s.address === I.osmoTransfer) return `a ${role} on ${chain} this record does not name`;
  return sideWords(s);
}
/** The person of a card, when it has a page on the site: a real address of either chain, never a protocol account. */
const pagePerson = (s: Party): Party | null => (s.address && !isInternal(s.address) && chainOf(s.address) ? s : null);
/** A masked link to an address's page on the site, its text the label and short address, or the short address. */
const personLink = (s: Party) => `[${linkText(s.label ? `${cutText(s.label, TEXT_MAX.label)} ${fmtAddr(s.address)}` : fmtAddr(s.address))} on NamadaTrade](${sitePage(s.address!)})`;

// ---------------------------------------------------------------- fitting a card into Discord's limits

interface Field { name: string; value: string; inline: boolean }
/** One embed as Discord takes it. */
export interface Embed {
  author?: { name: string; url?: string };
  title?: string;
  url?: string;
  color: number;
  description?: string;
  fields: Field[];
  footer?: { text: string };
  timestamp?: string;
}
/**
 * A part of a card's text: its words, the separator before it, and what fits() may do to it: `role` names the parts it
 * shortens (with `shorten`, to at most the length given) or drops, in TRIM_ORDER.
 */
interface Part { text: string; sep: string; role?: 'before' | 'abstract' | 'excerpt' | 'authors' | 'means'; shorten?: (max: number) => string }
/** A card before it is fitted: its embed without a description, and the description's parts. */
export interface Card { embed: Omit<Embed, 'description'>; parts: Part[] }
/**
 * What fits() trims first, until the card is inside the limits: the "Before this" line shortened, the abstract, the
 * excerpt, the authors, then the "Before this" line and the "what this means" line dropped; past all of them the
 * description is cut at DISCORD_LIMITS.description less six characters, "…" last.
 */
const TRIM_ORDER: { role: NonNullable<Part['role']>; drop?: true }[] = [
  { role: 'before' }, { role: 'abstract' }, { role: 'excerpt' }, { role: 'authors' }, { role: 'before', drop: true }, { role: 'means', drop: true },
];
/** A part shortened below this many characters is dropped instead. */
const PART_MIN = 40;

/** The characters Discord counts for one embed against DISCORD_LIMITS.total: title, description, footer, author and every field's name and value. */
export const embedCount = (e: Partial<Embed>): number =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.author?.name.length ?? 0)
  + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
/** The description: its shown parts, each after its separator; the "what this means" line sits right under "Before this", else after a blank line. */
const joinParts = (parts: Part[]) => {
  const shown = parts.filter((p) => p.text);
  return shown.map((p, i) => (i ? (p.role === 'means' && shown[i - 1].role !== 'before' ? '\n\n' : p.sep) : '') + p.text).join('');
};

/**
 * The card as one embed inside Discord's limits, in `room` characters of the message's DISCORD_LIMITS.total: each part
 * with a limit of its own cut to it (title, author, footer, fields), then the description trimmed in TRIM_ORDER until
 * the embed fits, then cut. A body over a limit is refused whole by Discord (sources/discord.ts DISCORD_INVALID_FORM_BODY)
 * and the alert's claim is already taken, so the card is cut here instead.
 */
export function fits(card: Card, room: number = DISCORD_LIMITS.total): Embed {
  const L = DISCORD_LIMITS;
  const e: Embed = {
    ...card.embed,
    ...(card.embed.author ? { author: { ...card.embed.author, name: cutText(card.embed.author.name, L.author) } } : {}),
    ...(card.embed.title != null ? { title: cutText(card.embed.title, L.title) } : {}),
    ...(card.embed.footer ? { footer: { text: cutText(card.embed.footer.text, L.footer) } } : {}),
    fields: card.embed.fields.slice(0, L.fields).map((f) => ({ ...f, name: cutText(f.name, L.fieldName), value: cutText(f.value, L.fieldValue) })),
  };
  const parts = card.parts.map((p) => ({ ...p }));
  const over = () => {
    const d = joinParts(parts).length;
    return Math.max(embedCount(e) + d - room, d - (L.description - 6));
  };
  for (const step of TRIM_ORDER) {
    for (const p of parts) {
      const x = over();
      if (x <= 0) break;
      if (p.role !== step.role || !p.text) continue;
      const max = p.text.length - x;
      p.text = step.drop || !p.shorten || max < PART_MIN ? '' : p.shorten(max);
    }
  }
  let d = joinParts(parts);
  const max = Math.min(L.description - 6, room - embedCount(e));
  if (d.length > max) d = cutText(d, Math.max(0, max));
  // fields last: only a message whose other embed left too little room gets here
  while (e.fields.length && embedCount(e) + d.length > room) e.fields.pop();
  return d ? { ...e, description: d } : e;
}

// ---------------------------------------------------------------- a move

/** A settle coin and its amount ("113.59 allUSDC (counted at a dollar)", "375.7190 OSMO"), as the settle sentence on the site writes them (web/src/lib/settle.ts). */
const coinWords = (c: SettledCoin) =>
  `${fmtCoin(Math.abs(c.amount), c.rate === 'stable' ? 2 : 4)} ${c.symbol}${c.rate === 'stable' && c.symbol !== 'USDC' ? ' (counted at a dollar)' : ''}`;
/** The rate a coin that is no dollar was valued at, and where it came from ("OSMO at $0.048443, this transaction's own rate"). */
const rateWords = (c: SettledCoin) =>
  `${c.symbol} at ${fmtUsdRule(c.usdEach)}, ${c.rate === 'tx' ? 'this transaction’s own rate' : `the Osmosis ${c.symbol} quote for that minute`}`;

/**
 * What the trader got or paid, with the NAM the settle price counts (fees in), so the three trade figures add up
 * ("113.59 allUSDC (counted at a dollar) for 799,995 NAM given, fees in"), then the rate of each coin that is no dollar,
 * then the gas, each on a line of its own.
 */
function settleField(s: Settle): Field {
  const got = s.coins.filter((c) => c.amount > 0), paid = s.coins.filter((c) => c.amount < 0);
  const nam = `${fmtNamRule(s.nam)} NAM`;
  const words = (cs: SettledCoin[]) => listWords(cs.map(coinWords));
  const trade = s.side === 'sell'
    ? `${words(got)} for ${nam} given, fees in${paid.length ? `; paid ${words(paid)}` : ''}`
    : `${words(paid)}, fees in, for ${nam}${got.length ? `; got ${words(got)}` : ''}`;
  const rates = [...new Map(s.coins.filter((c) => c.rate !== 'stable').map((c) => [c.symbol, c] as const)).values()].map((c) => `\n${rateWords(c)}`).join('');
  const gas = s.gasUsd != null ? `\n${s.side === 'sell' ? 'less' : 'plus'} ${fmtUsdRule(s.gasUsd)} of gas` : s.gasLeftOut ? '\ngas left out: no price for its coin that minute' : '';
  return { name: s.side === 'sell' ? 'Received' : 'Paid', value: `${trade}${rates}${gas}`, inline: false };
}

/** "Worth $1,678" or "under $1". */
const worthWords = (v: number) => (v >= 1 ? fmtUsdRule(v) : 'under $1');

/**
 * A run of earlier moves of one kind as one clause, newest first: "sold 49,491 NAM 5 min earlier", "sold 49,491,
 * 49,491 and 99,221 NAM in the 14 min before".
 */
function runClauses(moves: PriorMove[], at: number, whose: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < moves.length;) {
    const m = moves[i];
    let j = i + 1;
    while (j < moves.length && moves[j].kind === m.kind && moves[j].chain === m.chain && moves[j].received === m.received) j++;
    const run = moves.slice(i, j);
    const amt = `${listWords(run.map((x) => fmtNamRule(x.amount)))} NAM`;
    const words = pastWords(m, m.received, amt, run.length > 1);
    // "the receiver received" says the receiver twice
    const said = `${whose}${words}`.replace(/^the receiver received /, 'the receiver got ');
    out.push(run.length === 1 ? `${said} ${ageWords(at - m.ts)} earlier` : `${said} in the ${ageWords(at - run[run.length - 1].ts)} before`);
    i = j;
  }
  return out;
}

/**
 * The embed of one move's alert (one card; see the section's head), from the move and what was read beside it
 * (sources/discord-context.ts MoveContext). `late` marks an alert the LiveHub kept for a later alarm (PendingAlert).
 * A move found late says so in the title and in its field (owner decision 14), with the time it happened; the embed's
 * time is always the move's own.
 */
export function moveCard(flow: Flow, ctx: MoveContext = {}, late = false): Card {
  const f = flow;
  const otherCoin = isOtherCoin(f);
  const bot = isBotFlow(f);
  const via = f.meta?.via;
  const foundLate = via === 'catch-up search' || via === 'late scan';
  const { party: p0, other: o0 } = partiesOf(f);
  const sides = sidesOf(f);
  const person = pagePerson(p0);
  const dest = bridgeDest(f.kind, f.chain);
  const twoSided = dest != null || f.kind === 'transfer';
  const txUrl = explorerTx(f.chain, explorerHashOf(f));
  const how = priceHowOf(f);
  const route = how === 'spot' ? priceRouteOf(f) ?? ctx.priceRoute ?? null : null;
  const src = priceSourceWords(how, priceAtOf(f), route);
  const trade = f.kind === 'buy' || f.kind === 'sell';
  const settle = trade ? ctx.settle ?? null : null;
  const P = sideWords(p0);

  // ---- line 1: who, then the price with its source (plain words: a lock screen shows this line)
  let who: string;
  const validator = ctx.validatorName ? textSafe(cutText(ctx.validatorName, TEXT_MAX.validator)) : typeof f.meta?.validator === 'string' ? fmtAddr(f.meta.validator) : null;
  const pools = f.poolId ? f.poolId.split(',').map((x) => x.trim()).filter(Boolean) : [];
  switch (f.kind) {
    case 'buy': who = `Bought by ${P}`; break;
    case 'sell': who = `Sold by ${P}`; break;
    case 'ibc_in': case 'ibc_out': {
      const there = dest === 'osmosis' ? 'Osmosis' : 'Namada', here = dest === 'osmosis' ? 'Namada' : 'Osmosis';
      who = `From ${crossingSide(sides.from, 'sender', here)} to ${crossingSide(sides.to, 'receiver', there)}`;
      break;
    }
    case 'shield': who = `From ${P} into the shielded pool`; break;
    case 'unshield': who = `To ${P}, from the shielded pool`; break;
    case 'bond': who = `By ${P}${validator ? `, with validator ${validator}` : ''}`; break;
    case 'unbond': who = `By ${P}${validator ? `, from validator ${validator}` : ''}`; break;
    case 'withdraw': case 'pgf': who = `To ${P}`; break;
    case 'rewards': who = `Claimed by ${P}`; break;
    case 'lp_add': case 'lp_remove': who = `By ${P}${pools.length ? `, pool${pools.length > 1 ? 's' : ''} ${listWords(pools)}` : ''}`; break;
    case 'transfer': case 'pos_balance': who = `From ${sideWords(sides.from)} to ${sideWords(sides.to)}`; break;
    default: {
      if (isIbcRefund(f)) { who = `Refunded to ${P}: a send to Namada that timed out`; break; }
      const bought = Number(f.meta?.namBought), sold = Number(f.meta?.namSold);
      if (bot && Number.isFinite(bought) && Number.isFinite(sold)) {
        const net = bought - sold;
        const netWords = fmtNamRule(Math.abs(net)) === '0' ? 'no NAM changed hands net' : `${fmtNamRule(Math.abs(net))} NAM ${net > 0 ? 'bought' : 'sold'} net`;
        who = `By ${P}: bought ${fmtNamRule(bought)} and sold ${fmtNamRule(sold)} NAM in one transaction (${netWords})`;
      } else who = `By ${P}`;
    }
  }
  let value: string;
  const quoteName = route != null ? 'the Osmosis route quote for that minute' : 'the Osmosis quote for that minute';
  if (otherCoin) value = 'No dollar value is on record for this move.';
  else if (settle) {
    const q = how === 'spot' && f.priceUsd ? f.priceUsd : null;
    const d = q ? (settle.usdPerNam / q - 1) * 100 : 0;
    const cmp = !q ? '' : Math.abs(d) < 0.5 ? `, about ${quoteName} (${fmtUsdRule(q)})` : `, ${pct0(d)} ${d < 0 ? 'under' : 'over'} ${quoteName} (${fmtUsdRule(q)})`;
    value = `Settled at ${fmtUsdRule(settle.usdPerNam)} a NAM, ${fmtUsdRule(settleUsd(settle))} in all${cmp}.`;
  } else if (trade && how === 'execution' && f.priceUsd && f.valueUsd != null) {
    value = `At ${fmtUsdRule(f.priceUsd)} a NAM, ${fmtUsdRule(f.valueUsd)} in all (${src.short}).`;
  } else if (trade) {
    value = f.priceUsd && f.valueUsd != null && how !== 'none'
      ? `What it settled at is not on record; at ${fmtUsdRule(f.priceUsd)} a NAM (${src.short}) it is worth about ${worthWords(f.valueUsd)}.`
      : 'No price is on record for this trade.';
  } else if (f.valueUsd != null && f.priceUsd != null && how !== 'none') value = `Worth ${worthWords(f.valueUsd)} at ${fmtUsdRule(f.priceUsd)} a NAM (${src.short}).`;
  else value = 'No price is on record for this move.';
  const line1 = `${who}. ${value}`;

  // ---- line 2: the links: the person's page on the site (both sides of a crossing or a transfer), the record on an explorer
  const links: string[] = [];
  if (person) links.push(personLink(person));
  const otherPerson = twoSided ? pagePerson(o0) : null;
  if (otherPerson && otherPerson.address !== person?.address) links.push(personLink(otherPerson));
  links.push(`[Transaction on ${EXPLORER_NAME[f.chain] ?? 'an explorer'}](${txUrl})`);

  // ---- line 3: before this, only what is on record
  const whose = twoSided && person ? (person.address === f.to ? 'the receiver' : 'the sender') : 'this address';
  const otherWhose = whose === 'the receiver' ? 'the sender' : 'the receiver';
  const clauses: string[] = [];
  if (person) {
    const crossingIn = ctx.crossingIn ?? null;
    if (crossingIn) clauses.push(`received ${fmtNamRule(crossingIn.amount)} NAM from Namada ${ageWords(f.ts - crossingIn.ts)} earlier`);
    // The crossing named above is left out of the list, whichever of its two records the list holds: the Namada
    // sending record is kept there and the Osmosis receiving record is the one read for crossingIn.
    const own = (ctx.before ?? []).filter((m) => !(crossingIn && sameCrossing(m, crossingIn)));
    clauses.push(...runClauses(own, f.ts, twoSided ? `${whose} ` : ''));
  }
  // the other side's moves, each move once: one between the two sides is already in the person's list
  const listed = new Set((ctx.before ?? []).map((m) => m.id));
  if (twoSided && otherPerson) clauses.push(...runClauses((ctx.otherBefore ?? []).filter((m) => !listed.has(m.id)), f.ts, `${person ? otherWhose : 'the other side'} `));
  const t = ctx.trades30d;
  if (t && (person || dest === 'osmosis')) {
    const by = trade ? 'this address' : 'the receiver';
    clauses.push(t.n === 0
      ? `no ${t.side === 'sell' ? 'sale' : 'purchase'} by ${by} in the 30 days before`
      : `${t.side === 'sell' ? 'sold' : 'bought'} ${fmtNamRule(t.nam)} NAM in ${t.n} trade${t.n === 1 ? '' : 's'} in the 30 days before${t.firstTs != null ? `, the first ${ageWords(f.ts - t.firstTs)} before this one` : ''}`);
  }
  const h = ctx.history;
  if (h && person) {
    const many = h.capped ? `more than ${HISTORY_COUNT_MAX.toLocaleString('en-US')}` : h.n.toLocaleString('en-US');
    if (h.n === 0) clauses.push(`no earlier move by ${whose} on record`);
    else if (!(ctx.before ?? []).length && !ctx.crossingIn) clauses.push(`no move by ${whose} in the 7 days before; ${many} earlier on record${h.last != null ? `, the latest <t:${unix(h.last)}:D>` : ''}`);
    else clauses.push(`${many} move${h.n === 1 ? '' : 's'} by ${whose} on record before this${!h.capped && h.first != null ? `, the first <t:${unix(h.first)}:D>` : ''}`);
  }
  const before = (n: number) => (n ? `Before this: ${clauses.slice(0, n).join('; ')} (this site's records).` : '');

  // ---- line 4: what the site's own page says such a move means, with its source
  let means = '';
  if (dest === 'osmosis' && ctx.onDeck && ctx.onDeck.bridgedIn > 0) {
    means = `On deck at the receiver as of this post: ${fmtNamRule(ctx.onDeck.remaining)} NAM of ${fmtNamRule(ctx.onDeck.bridgedIn)} NAM bridged in over the last 7 days, not yet sold or sent back (this site's records).`;
  } else if ((dest === 'namada' && f.to === I.masp) || f.kind === 'shield') means = 'Inside the shielded pool the holder and its later moves are not visible.';
  else if (f.kind === 'unbond' && ctx.unlockAt) {
    const u = ctx.unlockAt;
    means = u.at == null ? `Spendable when the wait ends: ${u.note}.`
      : u.source === 'estimate' ? `Spendable when the wait ends, around <t:${unix(u.at)}:D> (<t:${unix(u.at)}:R>; ${u.note}).`
      : `Spendable when the wait ends, <t:${unix(u.at)}:f> (<t:${unix(u.at)}:R>; ${u.note}).`;
  } else if (f.kind === 'bond' && ctx.wait) means = `Out of the spendable supply until unstaked; unstaking takes ${ctx.wait.epochs} epochs, about ${Math.round(ctx.wait.days)} days (${ctx.wait.note}).`;
  else if (f.kind === 'withdraw') means = person ? 'Spendable now. What this address does with it next shows on its page.' : 'Spendable now.';

  // ---- fields: the figures, each with its source
  const fields: Field[] = [];
  if (settle) {
    // the two prices side by side, then what was paid or received across the card: its coins, rates and gas take lines
    fields.push({ name: 'Settled at', value: `${fmtUsdRule(settle.usdPerNam)} a NAM`, inline: true });
    if (f.priceUsd && how !== 'none' && how !== 'execution') fields.push({ name: how === 'spot' ? 'Quote that minute' : 'Price that minute', value: `${fmtUsdRule(f.priceUsd)} a NAM\n${capFirst(src.long)}`, inline: true });
    fields.push(settleField(settle));
  } else if (!otherCoin && f.valueUsd != null && f.priceUsd != null && how !== 'none' && !(trade && how === 'execution')) {
    fields.push({ name: 'Worth', value: worthWords(f.valueUsd), inline: true });
    fields.push({ name: how === 'spot' ? 'Quote that minute' : 'Price that minute', value: `${fmtUsdRule(f.priceUsd)} a NAM\n${capFirst(src.long)}`, inline: true });
  }
  // Owner decision 14: a move found late says so, with the time it happened (Discord shows <t:…:f> in each reader's
  // zone): one the Osmosis live stream missed and the catch-up search found later (meta.via 'catch-up search'), one
  // the Namada live scan read well after its block because it was behind (meta.via 'late scan', live-hub.ts
  // LATE_SCAN_MS), and one whose alert waited for a later alarm (`late`, live-hub.ts PendingAlert).
  if (foundLate || late) {
    const at = unix(f.ts);
    const why = via === 'late scan' ? 'The live scan was behind and read this move late' : via === 'catch-up search' ? 'The live feed missed this move' : 'This alert waited for a later run';
    fields.push({ name: 'Found late', value: `${why}; it happened <t:${at}:f> (<t:${at}:R>).`, inline: false });
  }

  // ---- why this post reached the channel, above the title: the watchlist first (the more specific reason a
  // subscriber gave), the subscriber's rule in their words at their size, or the operator channel's whale size
  const rule = ctx.rule ? `${ctx.rule.title} · your rule at ${fmtNamRule(ctx.rule.thresholdNam)} NAM` : null;
  const author = ctx.watched?.length
    ? { name: `Watchlist: ${ctx.watched.map((w) => fmtAddr(w)).join(', ')}${rule ? ` · also ${rule}` : ''}`, url: `${ORIGIN}/settings#watchlist` }
    : rule ? { name: rule, url: `${ORIGIN}/settings#rules` }
    : ctx.whaleNam ? { name: `Large move · ${fmtNamRule(ctx.whaleNam)} NAM or more` }
    : undefined;

  return {
    embed: {
      ...(author ? { author: { ...author, name: oneLine(author.name) } } : {}),
      title: oneLine(`${moveTitle(f)}${foundLate ? ' · found late' : late ? ' · sent late' : ''}`),
      url: person ? sitePage(person.address!) : txUrl,
      color: HUE_HEX[kindInfo(tagOfFlow(f)).hue] ?? HUE_HEX.neutral,
      fields,
      footer: { text: `NamadaTrade · ${CHAIN_WORD[f.chain] ?? f.chain} record, block ${Number.isFinite(f.height) ? f.height.toLocaleString('en-US') : 'not known'}` },
      timestamp: new Date(Number.isFinite(f.ts) ? f.ts : Date.now()).toISOString(),
    },
    parts: [
      { text: line1, sep: '' },
      { text: links.join(' · '), sep: '\n\n' },
      { text: before(clauses.length), sep: '\n\n', role: 'before', shorten: (max) => { for (let n = clauses.length - 1; n > 0; n--) if (before(n).length <= max) return before(n); return ''; } },
      { text: means, sep: '\n', role: 'means' },
    ],
  };
}

/** One move's alert as Discord takes it: the sender and one card (moveCard), inside Discord's limits. */
export function buildFlowDiscordBody(flow: Flow, ctx: MoveContext = {}, late = false) {
  return { ...SENDER, embeds: [fits(moveCard(flow, ctx, late))] };
}

// ---------------------------------------------------------------- a forum post

/** A new forum topic or reply: the topic in the title, the opening words as the line a lock screen shows, then who wrote it and when. */
export function forumCard(post: ForumPost, categoryName?: string | null): Card {
  const isNew = post.isNewTopic || post.postNumber === 1;
  const topic = oneLine(cutText(String(post.topicTitle ?? ''), TEXT_MAX.title));
  const url = safeHttpUrl(post.url);
  const user = textSafe(cutText(String(post.username ?? ''), TEXT_MAX.username));
  const by = post.displayName ? `${textSafe(cutText(post.displayName, TEXT_MAX.displayName))} (@${user})` : `@${user}`;
  const at = Date.parse(post.createdAt);
  const excerpt = post.excerpt ? textSafe(cutText(post.excerpt, TEXT_MAX.excerpt)) : '';
  const tail = `By ${by}${Number.isFinite(at) ? ` · <t:${unix(at)}:R>` : ''}${url ? ` · [Read on forum.namada.net](${url})` : ''}`;
  return {
    embed: {
      author: { name: `Forum · ${categoryName ? oneLine(cutText(categoryName, TEXT_MAX.category)) : 'forum.namada.net'}`, url: 'https://forum.namada.net' },
      title: isNew ? `New topic: ${topic}` : `Reply ${post.postNumber} in: ${topic}`,
      ...(url ? { url } : {}),
      color: COLOUR.forum,
      fields: [],
      footer: { text: 'NamadaTrade · forum.namada.net' },
      timestamp: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    },
    parts: [
      { text: excerpt || (isNew ? 'A new topic.' : 'A new reply.'), sep: '', role: excerpt ? 'excerpt' : undefined, shorten: (max) => cutText(excerpt, max) },
      { text: tail, sep: '\n\n' },
    ],
  };
}

// ---------------------------------------------------------------- a governance proposal

/** What the governance alert adds to the proposal: the current epoch, the epoch length and how it was measured, and when the indexer was read. */
export interface GovContext { nowEpoch?: number | null; epochSec?: number | null; epochNote?: string | null; readAt?: number }

/**
 * A proposal that is new or changed status: the outcome or the state in the title ("New proposal" only while it is
 * open: a proposal first read already past voting is titled by its status), the votes with their shares as Supply
 * shows them (Yes and No; Abstain has no share there), the type, authors and epochs with the current epoch, an
 * estimate of the clock times ahead (late by up to one epoch: the current epoch began up to one epoch before the
 * read), the abstract, and links: the discussion, the proposal on namada.valopers.com and, while it is open, the votes
 * on the site (Supply lists only open proposals). The status and votes are as the indexer was read, and say so.
 */
export function govCard(p: GovernanceProposal, isNew: boolean, g: GovContext = {}): Card {
  const readAt = g.readAt ?? Date.now();
  const total = p.yayNam + p.nayNam + p.abstainNam;
  const share = (n: number) => (total > 0 ? ` (${fmtPctRule((n / total) * 100, 1)})` : '');
  const status = proposalStatusWords(p.status);
  const open = proposalOpen(p.status);
  const title = oneLine(cutText(String(p.title ?? ''), TEXT_MAX.title));
  const head = open
    ? isNew ? `New proposal ${p.id}` : /voting/i.test(p.status) ? `Voting opened on proposal ${p.id}` : `Proposal ${p.id}, voting not started`
    : `Proposal ${p.id} ${status.charAt(0).toLowerCase()}${status.slice(1)}`;
  const votes = total > 0
    ? `${status}. Yes ${fmtNamRule(p.yayNam)} NAM${share(p.yayNam)}, no ${fmtNamRule(p.nayNam)} NAM${share(p.nayNam)}, abstain ${fmtNamRule(p.abstainNam)} NAM, of ${fmtNamRule(total)} NAM voted.`
    : `${status}. No votes cast yet.`;
  const ep = (n: number) => n.toLocaleString('en-US');
  let window = `voting epochs ${ep(p.startEpoch)} to ${ep(p.endEpoch)}`;
  if (g.nowEpoch != null) window += `, now epoch ${ep(g.nowEpoch)}`;
  if (g.nowEpoch != null && g.epochSec && p.endEpoch > g.nowEpoch && open) {
    const at = (e: number) => unix(readAt + (e - g.nowEpoch!) * g.epochSec! * 1000);
    const est = `estimate, late by up to one epoch${g.epochNote ? `: ${g.epochNote}` : ''}`;
    window += p.startEpoch > g.nowEpoch
      ? ` · voting opens around <t:${at(p.startEpoch)}:D> and closes around <t:${at(p.endEpoch)}:D> (${est})`
      : ` · voting closes around <t:${at(p.endEpoch)}:D> (${est})`;
  }
  const authors = p.authors ? textSafe(oneLine(p.authors)) : '';
  const typeLine = (a: string) => `${proposalTypeWords(p.type)}${a ? ` by ${a}` : ''} · ${window}.`;
  const own = safeHttpUrl(p.discussionsUrl);
  const ownOk = own != null && own.length <= GOV_LINK_MAX;
  const valopers = `https://namada.valopers.com/proposals/${p.id}`;
  const links = [
    ownOk ? `[Discussion on ${new URL(own!).host}](${own})` : null,
    `[Proposal ${p.id} on namada.valopers.com](${valopers})`,
    open ? `[Votes on NamadaTrade](${ORIGIN}/supply)` : null,
  ].filter(Boolean).join(' · ');
  const abstract = p.abstract ? textSafe(p.abstract) : '';
  const quote = (max: number) => (abstract ? `> ${cutText(abstract, max)}` : '');
  return {
    embed: {
      author: { name: 'Governance · indexer.namada.net', ...(open ? { url: `${ORIGIN}/supply` } : {}) },
      title: `${head}: ${title}`,
      url: ownOk ? own! : valopers,
      color: COLOUR.governance,
      fields: [
        { name: 'Yes', value: `${fmtNamRule(p.yayNam)} NAM${share(p.yayNam)}`, inline: true },
        { name: 'No', value: `${fmtNamRule(p.nayNam)} NAM${share(p.nayNam)}`, inline: true },
        { name: 'Abstain', value: `${fmtNamRule(p.abstainNam)} NAM`, inline: true },
      ],
      footer: { text: `NamadaTrade · status and votes as read from indexer.namada.net${own && !ownOk ? ` · the proposal's own discussion link is ${own.length} characters long, too long to post here` : ''}` },
      timestamp: new Date(readAt).toISOString(),
    },
    parts: [
      { text: votes, sep: '' },
      { text: typeLine(cutText(authors, TEXT_MAX.authors)), sep: '\n\n', role: 'authors', shorten: (max) => typeLine(cutText(authors, Math.max(0, Math.min(TEXT_MAX.authors, max - typeLine('').length)))) },
      { text: quote(TEXT_MAX.abstract + 2), sep: '\n\n', role: 'abstract', shorten: (max) => quote(max - 2) },
      { text: links, sep: '\n\n' },
    ],
  };
}

// ---------------------------------------------------------------- the Settings test message and the connection notice

/** The rules, watchlist, forum and digest switches and quiet hours a channel is connected with, in the words Settings shows. */
export function settingsFields(u: StoredSettings): Field[] {
  const p = u.notifications;
  const rules = alertRules(thresholdsOf(p));
  const isOn = (id: string) => !!p.rules[id as keyof typeof p.rules]?.on;
  const on = rules.filter((r) => isOn(r.id)).map((r) => `${r.title}: ${r.condition}`);
  const off = rules.filter((r) => !isOn(r.id)).map((r) => r.title);
  const n = p.watchlistOn ? p.watchlist.length : 0;
  const q = p.quietHoursUtc;
  const hh = (x: number) => `${String(x).padStart(2, '0')}:00`;
  return [
    { name: 'Your rules', value: `${on.length ? on.join('\n') : 'No rule is on.'}${off.length ? `\nOff: ${off.join(', ')}` : ''}`, inline: false },
    { name: 'Watchlist', value: n ? `${n} address${n === 1 ? '' : 'es'}` : 'off', inline: true },
    { name: 'Forum and governance', value: p.forumAndGov ? 'on' : 'off', inline: true },
    { name: 'Daily digest', value: p.dailyDigest ? 'on' : 'off', inline: true },
    // a sentence, so not a third-width column (Discord draws an inline field as one)
    { name: 'Quiet hours', value: q ? `${hh(q.start)} to ${hh(q.end)} UTC. A move made in these hours, or a forum post or proposal read in them, is not sent, then or later.` : 'none', inline: false },
  ];
}

/** What every alert card holds, as the test message and the connection notice say it. */
export const CARD_WORDS = 'the amount and what happened in the title, who moved it with the names this site knows, the price with its source, and links to the mover’s page on NamadaTrade and to an explorer';

/**
 * The Settings test message: the rules as saved, what the cards will hold, and, as a second embed, the newest move on
 * record that matches these rules, built as its alert would be (`example`). `null`: the search reached the oldest
 * record and found none; undefined: it gave up before that, or could not be read (analytics.ts lastAlertBefore), which
 * is not "none on record".
 */
/** What the test message shows as its example (testExample). */
export type TestExample = { flow: Flow; ctx: MoveContext } | null | 'gave-up' | 'unread' | undefined;

export function testBody(u: StoredSettings, example: TestExample, now = Date.now()) {
  const anyRule = Object.values(u.notifications.rules).some((r) => r?.on);
  const first = fits({
    embed: {
      title: 'Alerts will arrive here',
      url: `${ORIGIN}/settings`,
      color: COLOUR.test,
      fields: settingsFields(u),
      footer: { text: 'NamadaTrade · change these in Settings' },
      timestamp: new Date(now).toISOString(),
    },
    parts: [{ text: `This channel is connected for ${fmtAddr(u.address)}. Each alert is one card${anyRule && example && typeof example === 'object' ? ' like the example below' : ''}: ${CARD_WORDS}.`, sep: '' }],
  });
  const embeds: Embed[] = [first];
  const room = DISCORD_LIMITS.total - embedCount(first);
  if (anyRule && example && typeof example === 'object') {
    const card = moveCard(example.flow, example.ctx);
    embeds.push(fits({ ...card, embed: { ...card.embed, author: { name: 'Example: the newest move on record that matches these rules', url: `${ORIGIN}/alerts` } } }, room));
  } else if (anyRule && example !== undefined) {
    const [title, text] = example === null
      ? ['No move on record matches these rules yet', 'The first one will arrive as a card, the move in its title.']
      : example === 'gave-up'
      ? ['No example this time', 'None among the newest moves looked at matches these rules; the Alerts page keeps looking.']
      : ['No example this time', 'The newest move that matches these rules could not be read just now; the Alerts page lists them.'];
    embeds.push(fits({ embed: { title, color: COLOUR.test, fields: [], footer: { text: 'NamadaTrade' } }, parts: [{ text, sep: '' }] }, room));
  }
  return { ...SENDER, embeds };
}

/**
 * The connection notice a save posts to a link it turns on (and the cron's sweep posts again to a channel on trial):
 * what will arrive, the rules as saved. No example is read for it: it is posted inside the save's request.
 */
export function noticeBody(u: StoredSettings, now = Date.now()) {
  return {
    ...SENDER,
    embeds: [fits({
      embed: {
        title: 'Discord channel connected',
        url: `${ORIGIN}/settings`,
        color: COLOUR.test,
        fields: settingsFields(u),
        footer: { text: 'NamadaTrade · change these in Settings' },
        timestamp: new Date(now).toISOString(),
      },
      parts: [{ text: `Alerts for ${fmtAddr(u.address)} will arrive here, each as one card: ${CARD_WORDS}. A test message from Settings shows one, built from the newest move that matches your rules.`, sep: '' }],
    })],
  };
}

/**
 * The subscribers' part of a move's alert that a LiveHub dispatch could not send now (AlertBudget.defers), kept for
 * its next alarm in Durable Object storage (live-hub.ts): the move, when the part was first kept (`at`), how many
 * subscriber posts it held when last kept (`n`), which claims are taken (`claims`: none; the move's own key only,
 * taken by the operator's part, 'flow'; or that and the crossing's per-channel keys, 'all', once its posts started)
 * and the channels it waits for (`only`: digests of their links, never a link): those that matched when it was kept
 * whole, or, once its posts started, those still to post to; a part kept because the settings could not be read names
 * none, and a part kept by code before 2026-10-23 may name none either. The hub bounds each channel's share of its
 * list by them (live-hub.ts PENDING_CHANNEL_MAX). It is sent marked found late, to the subscribers that still match
 * the move then, under the next alarm's budget, and kept again for what does not fit, for a channel in its quiet
 * hours now whose move happened outside them (the part waits for an alarm after them) and, unchanged, when the
 * settings could not be read (UsersUnreadError). A part is let go when every channel was posted or recorded as not
 * sent (a hook held for the window, RATE_LIMITED_HOLD_AFTER, or a channel past its share of the list), no row holds
 * those links any more, or the move is older than the hub's age limit (live-hub.ts LATE_ALERT_MAX_AGE_MS).
 */
export interface PendingAlert { flow: Flow; at: number; n: number; claims: 'none' | 'flow' | 'all'; only?: string[] }

/**
 * One move's alert: the operator's channel at once, then every matching subscriber. The move is claimed in parts, as
 * the forum and governance alerts are (sendForumGov): the operator's part takes the move's claim at once, the
 * subscribers' part takes it (and a crossing's per-channel claims) only when their posts start. The answer is the
 * subscribers' part not sent now, for a dispatch that sends later (`budget.defers`: the LiveHub keeps it, PendingAlert,
 * and offers it again as `resume` on its next alarm); null when nothing is left. Without such a dispatch, what is cut
 * is recorded with the posts not sent. A settings read that fails is not an empty match: a dispatch that sends later
 * keeps the subscribers' part whole (a resumed part as it is, by UsersUnreadError), any other records the read.
 */
export async function sendDiscordWhaleAlert(
  webhookUrl: string | undefined,
  flow: Flow,
  db?: D1Database,
  systemThreshold = 10000,
  budget?: AlertBudget,
  resume?: PendingAlert,
): Promise<PendingAlert | null> {
  const late = !!resume;
  // 1. The operator's channel, for NAM moves at or above the whale size (another coin's units are not NAM). Marked
  //    op: the site's own channel is served first and is never dropped for a shared fan-out window that a wallet's
  //    low thresholds could fill with subscriber posts; one per move, and only a real whale makes one. A part kept
  //    from an earlier run holds subscribers only: the operator was posted when the move was first offered. A bot
  //    round trip and a rewards claim are not offered to it (owner's calls, 2026-10-23: the site leaves bot trades out
  //    of every buy and sell figure, and a claim of staking rewards is no market event); a watcher still hears of them.
  //    Each target's body is built once the move's context is read (step 2b); `why` holds what its card says above
  //    the title.
  const op: Target[] = [];
  const why = new Map<Target, Pick<MoveContext, 'whaleNam' | 'rule' | 'watched'>>();
  if (!resume && webhookUrl && operatorMove(flow, systemThreshold)) {
    const t: Target = { url: webhookUrl, body: {}, op: true };
    op.push(t);
    why.set(t, { whaleNam: systemThreshold });
  }

  // 2. Fan out per user: the same rules as the UI and the replay harness, with that user's thresholds (the rules
  //    are in NAM, so a move in another coin can match a watchlist only). One post per webhook, whoever shares it
  //    (the first matching user's tag names it). A part whose posts had started goes to the channels left (`only`).
  //    A matching subscriber in quiet hours is not posted; on a resumed part their channel is kept for an alarm after
  //    them when the move happened outside them, as a channel nobody matches any more is not.
  const only = resume?.only ? new Set(resume.only) : null;
  const seen = new Set<string>(webhookUrl ? [webhookUrl] : []);
  const subs: Target[] = [];
  const quietKeys = new Set<string>();
  const users = await getUsers(db, budget);
  const unread = users == null;
  if (unread && resume) throw new UsersUnreadError('read failed');
  for (const u of users ?? []) {
    const url = u.channels.discord.webhookUrl!;
    if (seen.has(url)) continue;
    const key = channelKey(url);
    if (only && !only.has(key)) continue;
    const p = u.notifications;
    const watched = p.watchlistOn && p.watchlist.some((w) => w === flow.from || w === flow.to);
    const hits = evaluateFlow(flow, thresholdsOf(p));
    if (!watched && hits.length === 0) continue;
    // In quiet hours now: not posted. On a resumed part the channel is kept for an alarm after them only when the move
    // itself fell outside them; a move inside them is dropped, as the direct path drops it (a subscriber whose quiet
    // hours cover the day would otherwise turn every resumed part into a day's wait recorded as not sent).
    if (inQuietHours(p)) { if (resume && !inQuietHours(p, flow.ts)) quietKeys.add(key); continue; }
    seen.add(url);
    const t = userTarget(u, {}, db);
    subs.push(t);
    // what the card says above its title: the watched addresses this move touches, and the first matching rule in the
    // site's words at this subscriber's size (shared/alerts.ts alertRules)
    const rule = hits.length ? alertRules(thresholdsOf(p)).find((r) => r.id === hits[0].ruleId) : undefined;
    why.set(t, {
      ...(watched ? { watched: p.watchlist.filter((w) => w === flow.from || w === flow.to) } : {}),
      ...(rule ? { rule: { id: rule.id, title: rule.title, thresholdNam: rule.thresholdNam } } : {}),
    });
  }
  // A channel another subscriber of the same link is posted to now is not kept for the quiet one.
  const quiet = [...quietKeys].filter((k) => !subs.some((t) => channelKey(t.url) === k));
  // Nothing to post and nothing to keep: no claim is taken. A read that failed under a dispatch that sends later keeps
  // the subscribers' part whole, for the next alarm's read.
  if (!op.length && !subs.length && !quiet.length && !(unread && budget?.defers)) return null;

  // 2b. The move's context (sources/discord-context.ts: both sides' labels, a trade's settle price, what the person did
  //     before, what the site's pages say such a move means), read once for every body of this move, and only when
  //     something is posted now. It is read before any claim is taken and is bounded in time: a read that fails or
  //     runs late gives a card with the move alone, so it can never cost the alert.
  if (op.length || (subs.length && !(budget && spentOut(budget)) && !(unread && budget?.defers))) {
    const read = await readMoveContext(db, flow);
    for (const t of [...op, ...subs]) t.body = buildFlowDiscordBody(read.flow, { ...read.ctx, ...why.get(t) }, late);
  }

  // 3. The claims, taken only for a part that will be posted, so a move that posts nothing holds no key another move
  //    needs. The first names the move itself (its flow id), never only its transaction: one transaction or Namada
  //    batch (whose moves all carry the wrapper hash) can hold several moves of one kind, and each is its own alert.
  //    The id is the move's identity on every path (the stream, the catch-up search and the Namada scan parse one
  //    transaction into the same ids, and `flows` stores rows by it), so one move is still posted once: a move offered
  //    again (a block read again, a transaction the catch-up search finds again) is refused at it, and a part kept for
  //    a later run holds it already.
  //    A NAM bridge crossing is recorded on both chains under two ids, and its two records do not reach the same
  //    channels: the "NAM bridged to Osmosis" rule reads the Osmosis receive only, while the operator and watchers of
  //    either address hear of both. So the crossing (its packet, crossingOf) is claimed per channel: each channel
  //    hears of it once, from whichever record reaches it first, and the channels the first record took never keep
  //    the second record from the channels only it reaches.
  const key = `alert:flow:${flow.id}`;
  const what = late ? `move ${flow.id} (kept from an earlier run)` : `move ${flow.id}`;
  const crossing = crossingOf(flow);
  const chanKey = (url: string) => `alert:ibc:${crossing}:${channelKey(url)}`;
  let claims: PendingAlert['claims'] = resume?.claims ?? 'none';
  const at = resume?.at ?? Date.now();

  // 4. The operator's part takes the move's claim at once, whatever the dispatch has left (postAll never cuts it).
  if (op.length) {
    if (!(await claimDiscordAlert(db, [key], Date.now()))) return null;
    claims = 'flow';
  }
  // 5. The subscribers' part goes now, with the operator's, unless the dispatch's post count or deadline is spent, or
  //    the settings could not be read: then it waits whole for the next alarm, its claims as they are, or, for a
  //    dispatch that cannot send later, is recorded with the posts not sent (nothing would be sent, and a claim is a
  //    D1 call of the dispatch).
  const waits = (subs.length > 0 && !!budget && spentOut(budget)) || (unread && !!budget?.defers);
  let send: Target[] = op;
  if (subs.length && !waits) {
    if (claims === 'none') {
      if (!(await claimDiscordAlert(db, [key], Date.now()))) return null;
      claims = 'flow';
    }
    send = [...op, ...subs];
  }
  if (crossing) {
    // The crossing's per-channel claims, for the channels posted to now whose claims are not yet taken.
    const claim = send.filter((t) => t.op || claims !== 'all');
    if (claim.length) {
      const won = await claimEach(db, claim.map((t) => chanKey(t.url)), Date.now());
      send = send.filter((t) => !claim.includes(t) || won.has(chanKey(t.url)));
    }
  }
  if (subs.length && !waits) claims = 'all';
  const { left } = send.length ? await postAll(send, db, what, budget) : { left: [] as Target[] };
  if (waits) {
    if (budget!.defers) {
      // The channels the part waits for are named, so the hub can bound each channel's share of its list; a part kept
      // because the settings could not be read names none, and is offered again as it is.
      if (unread) return { flow, at, n: 0, claims, ...(only ? { only: [...only] } : {}) };
      const keys = [...subs.map((t) => channelKey(t.url)), ...quiet];
      return { flow, at, n: keys.length, claims, only: keys };
    }
    noteSkipped(await recordsOf(db, budget!, windowOf(Date.now())), subs.length, `move ${flow.id} (past the run's post budget or deadline)`);
    return null;
  }
  // What waits for the next alarm: the posts the dispatch could not start now, and the channels in their quiet hours.
  const keep = [...left.map((t) => channelKey(t.url)), ...quiet];
  if (!keep.length) return null;
  return { flow, at, n: keep.length, claims, only: keep };
}

/** The posts of one forum or governance alert: the operator's channel, then every forumAndGov subscriber outside quiet hours, one post per webhook. */
function forumGovTargets(webhookUrl: string | undefined, users: StoredSettings[], body: Record<string, unknown>, db?: D1Database): Target[] {
  const seen = new Set<string>(webhookUrl ? [webhookUrl] : []);
  const out: Target[] = webhookUrl ? [{ url: webhookUrl, body, op: true }] : [];
  for (const u of users) {
    const url = u.channels.discord.webhookUrl!;
    if (!u.notifications.forumAndGov || inQuietHours(u.notifications) || seen.has(url)) continue;
    seen.add(url);
    out.push(userTarget(u, body, db));
  }
  return out;
}

/**
 * One forum or governance alert, claimed per part: the operator's channel is posted at once, under its own claim
 * (`<key>:op`), whatever the run's budget; the subscribers' posts are admitted by the run's budget and claimed under
 * `key` only when they start. An alert whose subscribers do not fit, or whose subscribers could not be read (a failed
 * settings read is not an empty match), waits for the next run ('waiting'), which posts them and not the operator
 * again; the run's later alerts wait in order, as admit closes the budget.
 */
async function sendForumGov(webhookUrl: string | undefined, body: Record<string, unknown>, key: string, what: string, db: D1Database | undefined, budget: AlertBudget | undefined): Promise<'done' | 'waiting'> {
  // A read that failed is recorded by getUsers (the cron's dispatch does not send later); the operator is still posted.
  const users = await getUsers(db, budget);
  const targets = forumGovTargets(webhookUrl, users ?? [], body, db);
  const op = targets.filter((t) => t.op), subs = targets.filter((t) => !t.op);
  if (op.length && (await claimDiscordAlert(db, [`${key}:op`], Date.now()))) await postAll(op, db, what, budget);
  if (users == null && budget) {
    budget.waiting++;
    budget.closed = true;
    budget.unread = true;
    return 'waiting';
  }
  if (!subs.length) return 'done';
  if (!admit(budget, subs.length)) return 'waiting';
  if (!(await claimDiscordAlert(db, [key], Date.now()))) return 'done';
  await postAll(subs, db, what, budget);
  return 'done';
}

/**
 * Send a deduplicated Discord notification for new Namada Forum topics or replies (forumCard). With a run's `budget`
 * (alertBudget), the operator is posted at once and subscribers whose posts do not fit wait, unclaimed, for the next
 * run (sendForumGov). `categoryName`: the topic's category, as the forum's topic list names it (cron.ts reads it from
 * intel.topics).
 */
export async function sendDiscordForumAlert(
  webhookUrl: string | undefined,
  post: ForumPost,
  db?: D1Database,
  budget?: AlertBudget,
  categoryName?: string | null,
): Promise<'done' | 'waiting'> {
  const body = { ...SENDER, embeds: [fits(forumCard(post, categoryName))] };
  return sendForumGov(webhookUrl, body, `alert:forum:post:${post.id}`, `forum post ${post.id}`, db, budget);
}

/**
 * The longest discussions-to link a governance alert carries. The link is the proposal author's own text, and the
 * chain bounds only the whole proposal (max_proposal_content_size, 10,000 bytes on mainnet), while Discord refuses a
 * whole message whose embed url is over 2048 characters or whose description is over 4096: one refused body reaches
 * no channel, and the alert's claim is already taken. A longer link is left out, the proposal's page is linked in its
 * place, and the alert says so. The links of the 43 mainnet proposals to 2026-10-22 are at most 116 characters.
 */
export const GOV_LINK_MAX = 512;

/**
 * Send a deduplicated Discord notification for a governance proposal that is new or changed status (govCard). With a
 * run's `budget`, an alert whose subscribers do not fit waits for the next run, its operator post sent at once
 * (sendForumGov). `g`: the current epoch, the measured epoch length and when the indexer was read (cron.ts).
 */
export async function sendDiscordGovAlert(
  webhookUrl: string | undefined,
  prop: GovernanceProposal,
  isNew: boolean,
  db?: D1Database,
  budget?: AlertBudget,
  g: GovContext = {},
): Promise<'done' | 'waiting'> {
  const body = { ...SENDER, embeds: [fits(govCard(prop, isNew, g))] };
  return sendForumGov(webhookUrl, body, `alert:gov:prop:${prop.id}:${prop.status}`, `proposal ${prop.id} ${prop.status}`, db, budget);
}

// ---------------------------------------------------------------- the daily and weekly digest

/**
 * One period's digest as the cron hands it to the dispatcher (worker/src/digest/deliver.ts builds it from the build
 * of worker/src/digest/build.ts): the period's claim key and label, and the posts of each recipient, built only once
 * the channels they go to are claimed.
 * - `key`: alert:digest:daily:<UTC date> or alert:digest:weekly:<ISO week>; `what`: "digest 2026-10-23" or "weekly
 *   digest 2026-W44", the label postAll and the health view show (never an address or a channel).
 * - `maxPosts`: the most posts one recipient's digest takes (a second message carries the attention section, or the
 *   recipient's own embed when the first message has no room for it), counted against the run's budget before any
 *   claim.
 * - `operator`: the operator's posts, given the digest's channels (the operator's among them), its subscribers and
 *   the wallets past the watchlist cap.
 * - `subscribers`: reads the watchlists of these wallets (bounded, after their claims) and gives each one's posts; a
 *   read that fails gives every watchlist embed its "not read" line, never no digest.
 */
export interface DigestDelivery {
  key: string;
  what: string;
  maxPosts: number;
  operator(t: { channels: number; subscribers: number; watchCapWallets: number }): WebhookPost[];
  subscribers(wallets: StoredSettings[]): Promise<{ postsOf: (u: StoredSettings) => WebhookPost[]; capped: number }>;
}

/**
 * What one run did with a period's digest.
 * - 'off': this Worker does not send alerts (SEND_ALERTS is not yes): nothing was claimed, read or posted.
 * - 'done': every channel already has it (an earlier run, or another isolate, took them all), or no channel takes it
 *   (`channels` 0: no operator channel and no subscriber with the switch on; the period's key is claimed so that
 *   later runs do not build it again).
 * - 'waiting': nothing could start this run (its posts, its window or Discord's limit on the site's address were
 *   spent, or the claims could not be read); nothing was claimed, and the next run asks again.
 * - 'sent': `channels` were claimed and posted to now (the operator's first, never cut), `reached` of them took the
 *   first message; `left` channels wait for the next run (null: the subscribers' settings could not be read, so who
 *   is left is not known), whose rebuilt digest goes to them; `first` when this run took the period's key.
 */
export type DigestOutcome =
  | { state: 'off' }
  | { state: 'done'; channels: number }
  | { state: 'waiting'; left: number | null; unread?: boolean; paused?: boolean }
  | { state: 'sent'; channels: number; reached: number; left: number | null; total: number; subscribers: number; first: boolean };

/** The claim of one channel's digest under the period's key: the operator's, or a digest of the link (never the link). */
const digestChannelKey = (key: string, t: Pick<Target, 'url' | 'op'>) => `${key}:${t.op ? 'op' : channelKey(t.url)}`;

/**
 * How many subscribers of a digest start this run, `per` posts each, after the operator's `opPosts` (which the
 * budget never cuts), within the run's posts and the posts that fit before its deadline at Discord's pace. The first alert of a run takes as many as its posts allow, a later one as many as are left
 * while the run's window is open and no earlier alert waits; those left wait for the next run, and every later alert
 * of the run then waits too (the alerts a run sends are always the first ones offered, as admit keeps them).
 */
function admitDigest(budget: AlertBudget, opPosts: number, per: number, n: number): number {
  const now = Date.now();
  const limited = sitePause > now;
  // A later alert of the run starts only within the run's window, as admit has it; the first is bounded by the deadline.
  const shut = budget.closed || limited || (budget.started && now >= budget.until);
  // The posts that fit before the run's deadline at Discord's pace (POST_PACE_MS a post, POST_CONCURRENCY at once),
  // so a run claims only the channels it can post; one that does not fit after all is handed back (sendDiscordDigest).
  const paced = budget.deadline == null || !Number.isFinite(budget.deadline) ? Infinity : Math.floor(Math.max(0, budget.deadline - now) / POST_PACE_MS) * POST_CONCURRENCY;
  const room = Math.min(budget.posts, paced) - opPosts;
  const k = shut ? 0 : Math.max(0, Math.min(n, Math.floor(room / Math.max(1, per))));
  if (k < n) {
    budget.waiting++;
    budget.closed = true;
    if (limited) budget.paused = true;
  }
  if (k > 0 || opPosts > 0) budget.started = true;
  return k;
}

/**
 * The period's own claim and the channel claims already taken under it (the range from `<key>` to `<key>;` of kv's
 * primary key: the key itself and every `<key>:…`), or null when unread.
 */
async function digestClaims(db: D1Database, key: string): Promise<Set<string> | null> {
  try {
    const r = await db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ?').bind(key, `${key};`).all<{ key: string }>();
    return new Set((r.results ?? []).map((x) => x.key));
  } catch (e) {
    console.error('digest: its claims could not be read', e);
    return null;
  }
}

/**
 * Sends one period's digest through the alerts' own path, under the run's budget (alertBudget): the operator's
 * channel first and never cut, then every subscriber with the digest switch on (notifications.dailyDigest; a row
 * saved before the switch existed reads as off), one post per link, the first-saved wallet's watchlist for a link
 * two wallets saved. Quiet hours are not read: the switch says the digest is sent even in them.
 *
 * A digest is two messages a channel on most days, so with many subscribers it cannot go in one run under
 * RUN_ALERT_POSTS. Each channel is claimed on its own under the period's key (`<key>:op`, `<key>:<link digest>`,
 * claimEach), so the channels a run cannot take wait for the next, which builds the digest again for them and posts
 * only to channels with no claim; no channel is ever posted the same period twice, and a channel's two messages go in
 * one run. The period's key itself is claimed by the run that starts it: it is what "the digest of that day was sent"
 * means to the next day's operator embed and to the cron's question whether a period is still open.
 *
 * Nothing is claimed by a Worker that does not send alerts (`off`), by a run that can start nothing (`waiting`), or
 * before the claims taken so far are read. The watchlists are read after the claims, for the wallets claimed only.
 * A run takes only the channels whose posts fit its count and, at Discord's pace, its deadline (admitDigest); a
 * channel claimed that the window, the deadline, the count or a Retry-After pause still cuts is handed back by postAll
 * and its claim given back (releaseClaims), so it waits for the next run instead of going without that day's digest.
 */
export async function sendDiscordDigest(webhookUrl: string | undefined, d: DigestDelivery, db: D1Database, budget: AlertBudget): Promise<DigestOutcome> {
  if (!sending) return { state: 'off' };
  const taken = await digestClaims(db, d.key);
  if (!taken) {
    budget.waiting++;
    budget.closed = true;
    return { state: 'waiting', left: null };
  }
  // A failed read of the settings is not an empty match: the operator is posted now and the subscribers wait.
  const users = await getUsers(db, budget);
  const seen = new Set<string>(webhookUrl ? [webhookUrl] : []);
  const wallets: StoredSettings[] = [];
  for (const u of users ?? []) {
    const url = u.channels.discord.webhookUrl!;
    if (!u.notifications.dailyDigest || seen.has(url)) continue;
    seen.add(url);
    wallets.push(u);
  }
  const op: Target | null = webhookUrl ? { url: webhookUrl, body: {}, op: true } : null;
  const subs = wallets.map((u) => ({ t: userTarget(u, {}, db), u }));
  const total = (op ? 1 : 0) + subs.length;
  const opNow = op && !taken.has(digestChannelKey(d.key, op)) ? op : null;
  const open = subs.filter((x) => !taken.has(digestChannelKey(d.key, x.t)));
  const first = !taken.has(d.key);
  if (!opNow && !open.length && users != null) {
    // Every channel has it, or none takes it: a period with no channel is claimed, so no later run builds it again.
    if (first) await claimEach(db, [d.key], Date.now());
    return { state: 'done', channels: total };
  }
  // The subscribers in a different order each period (the label holds the date), so the ones a run cannot take are
  // not always the same.
  const k0 = startAt(d.what, open.length);
  const order = [...open.slice(k0), ...open.slice(0, k0)];
  const opPosts = opNow ? d.maxPosts : 0;
  const k = users == null ? 0 : admitDigest(budget, opPosts, d.maxPosts, order.length);
  if (users == null) {
    budget.waiting++;
    budget.closed = true;
    budget.unread = true;
    if (opNow) budget.started = true;
  }
  const go = order.slice(0, k);
  const left = users == null ? null : order.length - k;
  if (!opNow && !go.length) return { state: 'waiting', left, ...(users == null ? { unread: true } : {}), ...(budget.paused ? { paused: true } : {}) };
  if (first) await claimEach(db, [d.key], Date.now());
  const offered = [...(opNow ? [{ t: opNow, u: null as StoredSettings | null }] : []), ...go];
  const won = await claimEach(db, offered.map((x) => digestChannelKey(d.key, x.t)), Date.now());
  const send = offered.filter((x) => won.has(digestChannelKey(d.key, x.t)));
  const mine = send.filter((x) => x.u).map((x) => x.u!);
  const own = await d.subscribers(mine);
  for (const x of send) {
    const posts = x.u ? own.postsOf(x.u) : d.operator({ channels: total, subscribers: subs.length, watchCapWallets: own.capped });
    if (!posts.length) continue;
    x.t.body = posts[0].body;
    x.t.files = posts[0].files;
    x.t.more = posts.slice(1);
  }
  const targets = send.map((x) => x.t).filter((t) => Object.keys(t.body).length > 0);
  const r = targets.length ? await postAll(targets, db, d.what, budget, true) : { reached: 0, left: [] as Target[] };
  // A channel the run's window, deadline or posts cut, or that Discord paused, was claimed and not posted: its claim is
  // given back so the next run posts it, and it is counted as waiting, not as not sent.
  let back = 0;
  if (r.left.length) {
    back = await releaseClaims(db, r.left.map((t) => digestChannelKey(d.key, t)));
    if (back < r.left.length) await noteNotSent(db, budget, r.left.length - back, `${d.what} (claims of channels not posted could not be given back)`);
    budget.waiting++;
    budget.closed = true;
  }
  return {
    state: 'sent', channels: targets.length - r.left.length, reached: r.reached, left: left == null ? null : left + back, total, subscribers: subs.length, first,
  };
}

/**
 * Settings test posts have a budget of invalid answers of their own per window, apart from the alerts' (kv
 * `alerts.invalid.test`): any signed-in wallet may send one to a link of its choice, so test posts sent together could
 * otherwise spend the alerts' budget and ceiling and hold every subscriber's alerts. Each test post to a link not
 * proven here takes one unit of it before it is posted, by one statement that adds it only while fewer than this many
 * are taken (so test posts sent at once never pass it together), and gives it back when the answer is not invalid; a
 * link with a recorded success (the row's `okAt`, or a success in this isolate) takes none. A wallet whose test was
 * answered invalid waits for the next window (api.ts), so spending the budget takes as many wallets with saved rows
 * as units, a quarter of the rows the site keeps at all (settings.ts USER_ROWS_MAX). With INVALID_CEILING it stays
 * well under what Discord allows an address (10,000 invalid requests in 10 minutes): at most 1,500 a window.
 */
export const TEST_INVALID_BUDGET = 500;
const TEST_INVALID_KEY = 'alerts.invalid.test';
/** This isolate's own count of test posts' units, used without a database or when the stored count cannot be written. */
let localTest = { w: 0, n: 0 };
/** Units of the test posts' budget taken in window `w`, by every isolate, or by this one when the count cannot be read. */
async function testSpent(db: D1Database | undefined, w: number): Promise<number> {
  const mine = localTest.w === w ? localTest.n : 0;
  if (!db) return mine;
  const cur = await kvGetJson<{ w: number; n: number }>(db, TEST_INVALID_KEY).catch(() => null);
  return cur && cur.w === w && Number.isFinite(cur.n) ? cur.n : mine;
}
/**
 * Takes one unit of the test posts' budget for window `w`: true when taken. The upsert writes only while the stored
 * count of the window is under TEST_INVALID_BUDGET (a row of an earlier window is replaced), so test posts sent at
 * once, from any isolate, take at most the budget between them. A failed write falls back to this isolate's count.
 */
async function reserveTest(db: D1Database | undefined, w: number): Promise<boolean> {
  const local = () => {
    if (localTest.w !== w) localTest = { w, n: 0 };
    if (localTest.n >= TEST_INVALID_BUDGET) return false;
    localTest.n++;
    return true;
  };
  if (!db) return local();
  try {
    const r = await db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?1, json_object('w', ?2, 'n', 1), ?3)
       ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_extract(kv.value, '$.w') = ?2 THEN json_object('w', ?2, 'n', json_extract(kv.value, '$.n') + 1) ELSE excluded.value END, updated_at = excluded.updated_at
       WHERE json_extract(kv.value, '$.w') IS NOT ?2 OR json_extract(kv.value, '$.n') < ?4`,
    ).bind(TEST_INVALID_KEY, w, Date.now(), TEST_INVALID_BUDGET).run();
    return Number(r.meta?.changes ?? 0) > 0;
  } catch (e) {
    console.error('alerts.invalid.test:', e);
    return local();
  }
}
/** Gives back the unit a test post took in window `w` (its answer was not invalid). */
async function releaseTest(db: D1Database | undefined, w: number) {
  if (!db) {
    if (localTest.w === w && localTest.n > 0) localTest.n--;
    return;
  }
  await db.prepare(
    `UPDATE kv SET value = json_object('w', ?2, 'n', MAX(0, json_extract(value, '$.n') - 1)), updated_at = ?3 WHERE key = ?1 AND json_extract(value, '$.w') = ?2`,
  ).bind(TEST_INVALID_KEY, w, Date.now()).run().catch((e) => console.error('alerts.invalid.test:', e));
}

/**
 * Whether a Settings test post, or the connection notice a save posts, to this link is held, and by what: 'link' when
 * the link is in its backoff here (it failed lately, or Discord said it is gone or its token is wrong); 'limited' when
 * it is held for the window as kept rate-limited (RATE_LIMITED_HOLD_AFTER); 'pause' when Discord's Retry-After for it
 * has not ended (a few seconds); 'site' when the alerts' ceiling of invalid answers is spent for the window, or the
 * test posts' own budget is (TEST_INVALID_BUDGET) and neither is the link proven (`proven`: a success recorded in its
 * row, settings.ts linkProven; a success in this isolate counts too) nor the wallet's row saved today (`fresh`: such a
 * wallet's post goes once a window whatever the budget, api.ts, so a new subscriber's save is never held by other
 * wallets' made-up links). A read only: sendDiscordTestPost takes the unit itself before it posts.
 */
export async function testPostHeld(webhookUrl: string, db?: D1Database, proven = false, fresh = false): Promise<false | 'link' | 'limited' | 'pause' | 'site'> {
  const f = hooks.get(webhookUrl);
  const now = Date.now();
  if (f && f.until > now) return 'link';
  if (f && f.held > now) return 'limited';
  if (f && f.pause > now) return 'pause';
  const w = windowOf(now);
  if ((await invalidSpent(db, w)) >= INVALID_CEILING) return 'site';
  if (proven || fresh || f?.ok) return false;
  return (await testSpent(db, w)) >= TEST_INVALID_BUDGET ? 'site' : false;
}

/**
 * The Settings test message to a user's link (sendDiscordTestPost, `what` 'test'): 'held' when it is not posted
 * (testPostHeld, or no unit of the test posts' budget was left), else whether Discord took it.
 */
export async function sendDiscordTestAlert(webhookUrl: string, u: StoredSettings, db?: D1Database, proven = false): Promise<boolean | 'held'> {
  const r = await sendDiscordTestPost(webhookUrl, u, db, proven, false, 'test');
  return r === 'held' ? 'held' : r.ok;
}

/** The test message's example is read (testExample) within this long; past it the message says it could not be read. */
export const TEST_EXAMPLE_MS = 4000;
/**
 * The test message's example: the newest move on record that matches the rules on (analytics.ts lastAlertBefore,
 * which pages back at most 500 candidates), with its context, as its alert would be built. null when the search
 * reached the oldest record and found none; 'gave-up' when it stopped before that; 'unread' when a read failed or ran
 * past TEST_EXAMPLE_MS; undefined when no rule is on (the message then shows no example).
 */
export async function testExample(db: D1Database, u: StoredSettings, now = Date.now()): Promise<TestExample> {
  if (!Object.values(u.notifications.rules).some((r) => r?.on)) return undefined;
  const th = thresholdsOf(u.notifications);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<TestExample> => {
    const hit = await lastAlertBefore(db, now, th);
    if (hit == null) return hit === null ? null : 'gave-up';
    const row = await db.prepare(`${FLOW_SELECT} WHERE f.id = ?`).bind(hit.flowId).first<any>();
    if (!row) return 'unread';
    const read = await readMoveContext(db, rowToFlow(row), now);
    const rule = alertRules(th).find((r) => r.id === hit.ruleId);
    return { flow: read.flow, ctx: { ...read.ctx, ...(rule ? { rule: { id: rule.id, title: rule.title, thresholdNam: rule.thresholdNam } } : {}) } };
  })().catch((e): TestExample => {
    console.warn('alerts: the example of a test message could not be read:', e);
    return 'unread';
  });
  const late = new Promise<TestExample>((resolve) => { timer = setTimeout(() => resolve('unread'), TEST_EXAMPLE_MS); });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One test post's answer: whether Discord took it (`ok`), its status (0 for no answer), whether the answer was
 * invalid (a 401, 403, 404 or a 429 not of shared scope, as Discord counts them), whether it blames the link itself
 * (`blames`: Discord's own refusal of it, or a 429 of user scope the site's own posts did not cause, blamesLink; the
 * wallet then waits for the next window after an invalid one, api.ts, and a row on trial is turned off; a 429 of
 * global scope or with none of Discord's headers limits the site's address and blames nothing), whether it said the
 * link is dead (`dead`: gone, or its token wrong), and whether the post went past a spent test budget on a fresh row's
 * allowance (`over`: the wallet then waits for the next window too).
 */
export interface TestPostAnswer { ok: boolean; status: number; invalid: boolean; blames: boolean; dead: boolean; over: boolean }

/**
 * The post the Settings test sends (`what` 'test': testBody, the newest matching move as its example), which is also,
 * as the connection notice (`what` 'notice': noticeBody), what a save posts to a link it turns on (api.ts PUT
 * /api/me/settings) and the cron's sweep posts again to a channel on trial: 'held' when it is not posted, else its
 * answer (TestPostAnswer). The answer is counted against
 * the link here as an alert's is, and an invalid answer keeps the unit the post took of the test posts' budget, never
 * the alerts' (kv `alerts.invalid`); a proven link takes no unit, and a fresh row's post goes once without one when
 * the budget is spent. A run that does not send alerts posts nothing and answers as no answer.
 */
export async function sendDiscordTestPost(webhookUrl: string, u: StoredSettings, db?: D1Database, proven = false, fresh = false, what: 'notice' | 'test' = 'notice'): Promise<'held' | TestPostAnswer> {
  if (!sending) {
    console.log('alerts: test post not sent (this run does not send alerts: SEND_ALERTS is not yes)');
    return { ok: false, status: 0, invalid: false, blames: false, dead: false, over: false };
  }
  if (await testPostHeld(webhookUrl, db, proven, fresh)) return 'held';
  // The test message's example is read before a unit of the budget is taken, so a slow read holds none.
  const body = what === 'test' ? testBody(u, db ? await testExample(db, u) : undefined) : noticeBody(u);
  const w = windowOf(Date.now());
  let unit = !(proven || hooks.get(webhookUrl)?.ok);
  let over = false;
  if (unit && !(await reserveTest(db, w))) {
    if (!fresh) return 'held';
    unit = false;
    over = true;
  }
  let res: Response;
  const startedAt = notePost(webhookUrl);
  try { res = await postWebhook(webhookUrl, body); } catch (e) {
    noteAnswer(webhookUrl, NO_ANSWER, true, startedAt);
    if (unit) await releaseTest(db, w);
    throw e;
  }
  let a: Answer;
  try { a = await answerOf(res); } finally { await releaseBody(res); }
  const counted = noteAnswer(webhookUrl, a, true, startedAt);
  if (unit && !a.invalid) await releaseTest(db, w);
  return { ok: a.ok, status: a.status, invalid: a.invalid, blames: blamesLink(a, counted), dead: a.dead, over };
}

/**
 * The digest's preview (api.ts POST /api/me/settings/test with { preview: 'digest' }): the posts a subscriber with
 * this wallet's settings would get, as built now, under the test post's own rules: 'held' as testPostHeld and the test
 * posts' budget decide, one unit of that budget for a link not proven here (kept when an answer is invalid, given back
 * otherwise), and each answer counted against the link as an alert's is. The posts go in order, each only after the
 * one before it was taken; files Discord refuses are dropped for the text alone, as a digest's are. The answer is the
 * first post's that was not taken, or the last one's. No claim is taken and the digest's delivery record is not
 * touched. A run that does not send alerts posts nothing and answers as no answer.
 */
export async function sendDiscordPreview(webhookUrl: string, posts: WebhookPost[], db?: D1Database, proven = false, fresh = false): Promise<'held' | TestPostAnswer> {
  const none: TestPostAnswer = { ok: false, status: 0, invalid: false, blames: false, dead: false, over: false };
  if (!sending) {
    console.log('alerts: digest preview not sent (this run does not send alerts: SEND_ALERTS is not yes)');
    return none;
  }
  if (!posts.length) return none;
  if (await testPostHeld(webhookUrl, db, proven, fresh)) return 'held';
  const w = windowOf(Date.now());
  let unit = !(proven || hooks.get(webhookUrl)?.ok);
  let over = false;
  if (unit && !(await reserveTest(db, w))) {
    if (!fresh) return 'held';
    unit = false;
    over = true;
  }
  let last: { a: Answer; counted: boolean } = { a: NO_ANSWER, counted: false };
  let invalid = false;
  for (const p of posts) {
    last = await postOnce(webhookUrl, p.body, p.files, true);
    if (p.files?.length && filesRefused(last.a)) last = await postOnce(webhookUrl, textOnly(p.body), undefined, true);
    if (last.a.invalid) invalid = true;
    if (!last.a.ok) break;
  }
  if (unit && !invalid) await releaseTest(db, w);
  const { a, counted } = last;
  return { ok: a.ok, status: a.status, invalid: a.invalid, blames: blamesLink(a, counted), dead: a.dead, over };
}

/** No notice the cron's tick posts again to a channel on trial starts later than this after its sweep began. */
export const NOTICE_SWEEP_WINDOW_MS = 20_000;
/**
 * The cron's sweep of the channels on trial (a row saved on while its connection notice did not reach the channel,
 * settings.ts `notice`) that no post has reached within NOTICE_TRIAL_MS of the save, or of the notice last posted
 * again (settings.ts trialsDue: at most NOTICE_SWEEP_MAX a tick, oldest first). A quiet channel is not a dead one, so
 * none is turned off for having been quiet: the connection notice is posted to each once more, one at a time, through
 * the test post (sendDiscordTestPost: under the test posts' budget, and counted against the link as an alert's answer
 * is), and its answer decides. Discord taking it proves the link (the row's okAt, hookOkStmt): the note goes and the
 * channel keeps its place for good. An answer that blames the link (blamesLink) turns the channel off, visibly, as an
 * alert's answer would (stopChannelStmt with reason 'notice', or as a dead link when Discord says it is gone or its
 * token is wrong). Any other answer, none among them, says nothing against the link: the trial goes on for another
 * day with the try counted (settings.ts noticeTriedStmt), and the channel is turned off, visibly, only once
 * NOTICE_TRIES_MAX such notices on as many days did not reach it. A notice that is held (the link paused or backed off
 * here, the test posts' budget or the alerts' ceiling spent) is neither posted nor counted, and the row is tried on a
 * later tick. No notice starts past NOTICE_SWEEP_WINDOW_MS. Every write is made only over the row as it was read and
 * while it records no successful post. Run by the cron's tick on the Worker that sends alerts only (a copy of the
 * database posts nothing, so it proves nothing either); returns how many rows were written.
 */
export async function sweepNoticeChannels(db: D1Database, secret: string, now = Date.now()): Promise<number> {
  if (!sending) return 0;
  const due = await trialsDue(db, secret, now);
  if (!due.length) return 0;
  const end = Date.now() + NOTICE_SWEEP_WINDOW_MS;
  const c = usersCache.get(db);
  const done = { proven: 0, stopped: 0, tried: 0 };
  let written = 0;
  for (const s of due) {
    if (Date.now() >= end) break;
    const url = s.channels.discord.webhookUrl!;
    let a: 'held' | TestPostAnswer;
    try {
      a = await sendDiscordTestPost(url, s, db);
    } catch (e) {
      console.error('alerts: the connection notice to a channel on trial could not be posted', e);
      a = { ok: false, status: 0, invalid: false, blames: false, dead: false, over: false };
    }
    if (a === 'held') continue;
    const at = Date.now();
    const stops = !a.ok && (a.blames || (s.channels.discord.notice?.tries?.n ?? 0) + 1 >= NOTICE_TRIES_MAX);
    try {
      const stmt = a.ok
        ? hookOkStmt(db, secret, s.address, url, at)
        : a.blames
        ? await stopChannelStmt(db, secret, s, a.status, at, a.dead ? undefined : 'notice')
        : await noticeTriedStmt(db, secret, s, a.status, at);
      const changes = Number((await stmt.run()).meta?.changes ?? 0);
      if (!changes) continue;
      written += changes;
    } catch (e) {
      console.error('alerts: a channel on trial was not written after its notice was posted again', e);
      continue;
    }
    if (a.ok) done.proven++;
    else if (stops) done.stopped++;
    else done.tried++;
    // This isolate's read of the settings follows at once: a proven link is off its trial, a channel turned off is not served.
    if (c && a.ok) c.okAt.set(s.address, at);
    else if (c && stops) c.users = c.users.filter((u) => u.address !== s.address);
  }
  if (written) console.warn(`alerts: the connection notice was posted again to channels on trial: ${done.proven} proven, ${done.stopped} turned off, ${done.tried} to be tried again the next day`);
  return written;
}

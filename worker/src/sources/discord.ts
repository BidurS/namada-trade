import { explorerHashOf, isOtherCoin } from '../../../shared/flow-rules';
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { safeHttpUrl } from '../../../shared/flow-rules';
import { EXPLORERS, NAM, NAMADA } from '../config';
import { evaluateFlow } from '../../../shared/alerts';
import { readDeliverable, inQuietHours, stopChannelStmt, hookOkStmt, thresholdsOf, trialsDue, noticeTriedStmt, NOTICE_TRIES_MAX, type StoredSettings } from '../settings';
import { SITE } from '../../../shared/site';
import { chainOf } from '../util';
import { kvGetJson, kvSet } from '../db';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * A webhook that accepts the request and never answers must not hold up its caller (the cron's tick, the live
 * stream): every post ends after this long.
 */
export const WEBHOOK_TIMEOUT_MS = 8000;
/**
 * Every post names no one: a mention in text an outsider wrote (a forum post, a proposal, a label, a bridge receiver
 * string) is shown as text, never turned into a notification.
 */
const postWebhook = (url: string, body: Record<string, unknown>) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
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
 * (stopTrialHooks).
 */
interface Target { url: string; body: Record<string, unknown>; op?: boolean; proven?: boolean; fresh?: boolean; trial?: boolean }
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
async function postAll(targets: Target[], db: D1Database | undefined, what: string, budget?: AlertBudget): Promise<{ posted: number; skipped: number; left: Target[] }> {
  if (!sending) {
    // A run that does not send alerts (sendsAlerts) posts nothing; what it would have posted is logged and recorded
    // as not sent, so a production Worker left without SEND_ALERTS shows in the health view instead of going quiet.
    if (targets.length) {
      const label = `${what} (SEND_ALERTS is not yes)`;
      console.log(`alerts: ${targets.length} posts for ${label} not sent`);
      await recordSkipped(db, targets.length, label);
    }
    return { posted: 0, skipped: targets.length, left: [] };
  }
  const b: AlertBudget = budget ?? { posts: Infinity, until: Infinity, started: true, waiting: 0 };
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
  // all of this alert's subscribers at Discord's pace; the dispatch's deadline bounds it.
  const opened = b.shared ? (b.opened ??= Date.now()) : Date.now();
  const span = windowFor(subs.length);
  const deadline = b.deadline ?? Infinity;
  let posted = 0, skipped = 0, refused = 0, held = 0, invalid = 0, over = 0, late = 0, limited = 0;
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
      if (!t.op && b.halted) { left.push(t); waits.halted++; continue; }
      const wide = sitePause - Date.now();
      if (wide > 0) {
        if (!t.op && b.defers) { left.push(t); waits.halted++; continue; }
        const until = sitePause;
        if (until > waited && wide <= (t.op ? opWait() : Math.min(opWait(), deadline - Date.now()))) { await sleep(wide); waited = Math.max(waited, until); }
      }
      if (f && f.pause > Date.now()) {
        // Discord's Retry-After is not over: a subscriber's post waits for the next alarm of a dispatch that sends
        // later (the pause is a few seconds; the alarm comes after it), else it is skipped as before; the operator's
        // channel waits a short pause out here.
        if (!t.op) {
          if (b.defers) { left.push(t); waits.paused++; } else skipped++;
          continue;
        }
        const wait = f.pause - Date.now();
        if (wait > opWait()) { skipped++; continue; }
        await sleep(wait);
      }
      const proven = !!f?.ok || !!t.proven || !t.fresh;
      if (!t.op) {
        const now = Date.now();
        const cut = now - opened > span ? 'window' : now >= deadline ? 'late' : b.posts <= 0 ? 'over' : ceiling <= 0 || (!proven && room <= 0) ? 'held' : null;
        if (cut) {
          if (b.defers) { left.push(t); waits[cut]++; continue; }
          if (cut === 'held') held++;
          else { skipped++; if (cut === 'late') late++; else if (cut === 'over') over++; }
          continue;
        }
        ceiling--;
        if (!proven) room--;
      }
      b.posts--;
      let a: Answer;
      const startedAt = notePost(t.url);
      try {
        const res = await postWebhook(t.url, t.body);
        try { a = await answerOf(res); } finally { await releaseBody(res); }
      } catch { a = NO_ANSWER; }
      if (a.invalid) invalid++;
      else if (!t.op) {
        ceiling++;
        if (!proven) room++;
      }
      const counted = noteAnswer(t.url, a, !t.op, startedAt);
      // A limit on the site's address halts a dispatch that sends later: its subscribers' posts left wait for the
      // next alarm (spentOut), as the rest of its alerts do.
      if (siteWide(a) && b.defers) b.halted = true;
      if (a.ok) { posted++; rec.ok.add(t.url); }
      // A refused body is lost and recorded with the posts not sent; any other failure counts against the hook only.
      else if (a.refused) refused++;
      // A 429 did not take the post: a dispatch that sends later takes a subscriber's back for its next alarm; the
      // operator's channel is posted once more after a short Retry-After, within the alert's window.
      else if (a.status === 429) {
        if (!t.op) {
          if (b.defers) { left.push(t); waits.paused++; }
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
  if (skipped || refused || held || rateLimited) {
    const n = skipped + refused + held + rateLimited;
    const notes = [
      refused ? `${refused} refused by Discord` : '',
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
  return { posted, skipped: skipped + held, left };
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

const NAMADA_AVATAR =
  'https://raw.githubusercontent.com/anoma/namada-chain-registry/main/namada/images/namada.svg';

// In-memory fast-path deduplication cache (protects against simultaneous WS fanout within the same isolate)
const memoryAlertCache = new Set<string>();

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
async function claimEach(db: D1Database | undefined, keys: string[], now = Date.now()): Promise<Set<string>> {
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
 * Whether the live alert pass (live-hub.ts alertFlows) offers a move to sendDiscordWhaleAlert at all. `minNam` is a
 * NAM size, so it reads NAM moves only. A move into or out of the shielded set is always offered, and so is a move
 * in another coin: no NAM size can measure it, and only a watchlist can match it (no rule or whale size is in its
 * coin), so it is offered for the watchers of its addresses whatever its size.
 */
export const offeredForAlerts = (flow: Flow, minNam: number): boolean =>
  isOtherCoin(flow) || flow.kind === 'shield' || flow.kind === 'unshield' || flow.amount >= minNam;

/**
 * The embed of one move's alert. `customTag` names the rule or the watchlist that matched for a subscriber; `late`
 * marks an alert the LiveHub kept for a later alarm (PendingAlert): it says so, with the time the move happened, as a
 * move found late does (owner decision 14).
 */
export function buildFlowDiscordBody(flow: Flow, usdPrice: number | null, customTag?: string, late = false) {
  // The coin the amount is in: a move in another coin is named by its own symbol (meta.tokenSymbol), never as NAM.
  const assetSymbol = isOtherCoin(flow)
    ? String(flow.meta!.tokenSymbol)
    : flow.chain === 'namada' && flow.counterDenom ? flow.counterDenom : 'NAM';

  const valueStr = flow.valueUsd
    ? `$${flow.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : assetSymbol === 'NAM' && usdPrice
    ? `$${(flow.amount * usdPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `${assetSymbol} Asset`;

  const amountStr = `${flow.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${assetSymbol}`;

  const txUrl =
    flow.chain === 'osmosis'
      ? EXPLORERS.osmoTx(flow.txHash)
      : NAMADA.explorerTx(explorerHashOf(flow));

  let title = `${customTag ? `[${customTag}] ` : ''}🐋 Whale Move on ${flow.chain.toUpperCase()}`;
  let color = 0x5865f2;

  const isToOsmosis =
    (flow.chain === 'osmosis' && flow.kind === 'ibc_in') ||
    (flow.chain === 'namada' && flow.kind === 'ibc_out');

  switch (flow.kind) {
    case 'buy':
      title = `${customTag ? `[${customTag}] ` : ''}🟢 BUY on Osmosis: ${amountStr}`;
      color = 0x57f287;
      break;
    case 'sell':
      title = `${customTag ? `[${customTag}] ` : ''}🔴 SELL on Osmosis: ${amountStr}`;
      color = 0xed4245;
      break;
    case 'ibc_in':
    case 'ibc_out':
      title = isToOsmosis
        ? `${customTag ? `[${customTag}] ` : ''}🌉 IBC Bridge Namada → Osmosis: ${amountStr}`
        : `${customTag ? `[${customTag}] ` : ''}🌉 IBC Bridge Osmosis → Namada: ${amountStr}`;
      color = 0xfee75c;
      break;
    case 'shield':
      title = `${customTag ? `[${customTag}] ` : ''}🛡️ MASP Shielded: ${amountStr}`;
      color = 0x9b59b6;
      break;
    case 'unshield':
      title = `${customTag ? `[${customTag}] ` : ''}🔓 MASP Unshielded: ${amountStr}`;
      color = 0xe67e22;
      break;
    case 'bond':
      title = `${customTag ? `[${customTag}] ` : ''}🥩 Staking Bond: ${amountStr}`;
      color = 0x3498db;
      break;
    case 'withdraw':
      title = `${customTag ? `[${customTag}] ` : ''}💸 Staking Withdrawal: ${amountStr}`;
      color = 0xe74c3c;
      break;
    default:
      title = `${customTag ? `[${customTag}] ` : ''}🐋 Flow [${flow.kind.toUpperCase()}]: ${amountStr}`;
  }

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Amount', value: amountStr, inline: true },
    { name: 'Est. Value', value: valueStr, inline: true },
    { name: 'Block Height', value: `#${flow.height.toLocaleString()}`, inline: true },
  ];

  // Addresses and labels are text outsiders chose (a bridge receiver, a wallet's tag): shown, never rendered as markdown.
  const party = (addr: string, label: string | null | undefined) =>
    `\`${codeSafe(addr.slice(0, 14))}...${codeSafe(addr.slice(-6))}\`${label ? ` (${plainMd(codeSafe(label))})` : ''}${chainOf(addr) ? '' : ' (not an address)'}`;
  if (flow.from) fields.push({ name: 'From', value: party(flow.from, flow.fromLabel), inline: true });
  if (flow.to) fields.push({ name: 'To', value: party(flow.to, flow.toLabel), inline: true });
  // Owner decision 14: a move found late says so, with the time it happened (Discord renders <t:…:f> in each reader's
  // time zone): one the Osmosis live stream missed and the catch-up search found later (meta.via 'catch-up search'),
  // one the Namada live scan read well after its block because it was behind (meta.via 'late scan', live-hub.ts
  // LATE_SCAN_MS), and one whose alert waited for a later alarm (`late`, live-hub.ts PendingAlert).
  const via = (flow.meta as { via?: string } | undefined)?.via;
  if (via === 'catch-up search' || via === 'late scan' || late) {
    const t = Math.floor(flow.ts / 1000);
    const why = via === 'late scan' ? 'The live scan was behind and read this move late' : via === 'catch-up search' ? 'The live feed missed this move' : 'This alert waited for a later run';
    fields.push({ name: 'Found late', value: `${why}; it happened <t:${t}:f> (<t:${t}:R>).`, inline: false });
  }
  if (flow.chain === 'osmosis' && flow.counterDenom && flow.counterAmount) {
    fields.push({
      name: 'Counter Asset',
      value: `${flow.counterAmount.toFixed(2)} ${flow.counterDenom}`,
      inline: true,
    });
  }

  return {
    username: 'Namada Whale Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title,
        url: txUrl,
        color,
        description: `Tx: [${flow.txHash.slice(0, 16)}...](${txUrl}) on **${flow.chain.toUpperCase()}**`,
        fields,
        footer: {
          text: `NamadaTrade • Deduplicated Cross-Chain Whale Monitor`,
        },
        timestamp: new Date(flow.ts || Date.now()).toISOString(),
      },
    ],
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
  usdPrice: number | null,
  db?: D1Database,
  systemThreshold = 10000,
  budget?: AlertBudget,
  resume?: PendingAlert,
): Promise<PendingAlert | null> {
  const late = !!resume;
  // 1. The operator's channel, for NAM moves at or above the whale size (another coin's units are not NAM). Marked
  //    op: the site's own channel is served first and is never dropped for a shared fan-out window that a wallet's
  //    low thresholds could fill with subscriber posts; one per move, and only a real whale makes one. A part kept
  //    from an earlier run holds subscribers only: the operator was posted when the move was first offered.
  const op: Target[] = [];
  if (!resume && webhookUrl && isNamWhale(flow, systemThreshold)) op.push({ url: webhookUrl, body: buildFlowDiscordBody(flow, usdPrice), op: true });

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
    subs.push(userTarget(u, buildFlowDiscordBody(flow, usdPrice, watched ? 'WATCHLIST' : hits[0].ruleId.toUpperCase(), late), db));
  }
  // A channel another subscriber of the same link is posted to now is not kept for the quiet one.
  const quiet = [...quietKeys].filter((k) => !subs.some((t) => channelKey(t.url) === k));
  // Nothing to post and nothing to keep: no claim is taken. A read that failed under a dispatch that sends later keeps
  // the subscribers' part whole, for the next alarm's read.
  if (!op.length && !subs.length && !quiet.length && !(unread && budget?.defers)) return null;

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
 * Send a deduplicated Discord notification for new Namada Forum topics or replies. With a run's `budget`
 * (alertBudget), the operator is posted at once and subscribers whose posts do not fit wait, unclaimed, for the next
 * run (sendForumGov).
 */
export async function sendDiscordForumAlert(
  webhookUrl: string | undefined,
  post: ForumPost,
  db?: D1Database,
  budget?: AlertBudget,
): Promise<'done' | 'waiting'> {
  const isNewTopic = post.isNewTopic || post.postNumber === 1;
  // Forum text is whatever its author wrote: shown as text (plainMd), so a reply cannot hide a link under other words.
  const title = isNewTopic
    ? `🏛️ New Namada Forum Topic: ${plainMd(post.topicTitle)}`
    : `💬 New Forum Reply: ${plainMd(post.topicTitle)} (#${post.postNumber})`;

  const authorDisplay = post.displayName
    ? `${plainMd(post.displayName)} (@${plainMd(post.username)})`
    : `@${plainMd(post.username)}`;

  const body = {
    username: 'Namada Forum & Governance Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: title.slice(0, 250),
        url: post.url,
        color: isNewTopic ? 0xffff00 : 0x38bdf8,
        description: post.excerpt
          ? `> ${plainMd(post.excerpt)}\n\n[Read full post on forum.namada.net ↗](${post.url})`
          : `[View discussion on forum.namada.net ↗](${post.url})`,
        fields: [
          { name: 'Author', value: authorDisplay, inline: true },
          {
            name: 'Activity Type',
            value: isNewTopic ? 'New Thread (OP)' : `Reply #${post.postNumber}`,
            inline: true,
          },
          { name: 'Topic ID', value: `#${post.topicId}`, inline: true },
        ],
        footer: {
          text: 'NamadaTrade • Namada Discourse Forum Monitor',
        },
        timestamp: new Date(post.createdAt || Date.now()).toISOString(),
      },
    ],
  };

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
 * Send a deduplicated Discord notification for Namada On-Chain Governance Proposals. With a run's `budget`, an alert
 * whose subscribers do not fit waits for the next run, its operator post sent at once (sendForumGov).
 */
export async function sendDiscordGovAlert(
  webhookUrl: string | undefined,
  prop: GovernanceProposal,
  isNew: boolean,
  db?: D1Database,
  budget?: AlertBudget,
): Promise<'done' | 'waiting'> {
  // Proposal text is whatever its author submitted on chain: shown as text (plainMd).
  const title = isNew
    ? `🗳️ New On-Chain Proposal #${prop.id}: ${plainMd(prop.title)}`
    : `⚖️ Proposal #${prop.id} Status → ${prop.status.toUpperCase()}: ${plainMd(prop.title)}`;

  const color =
    prop.status.toLowerCase().includes('pass')
      ? 0x10b981
      : prop.status.toLowerCase().includes('reject')
      ? 0xf43f5e
      : 0xa855f7;

  const own = safeHttpUrl(prop.discussionsUrl);
  const tooLong = own != null && own.length > GOV_LINK_MAX;
  const propUrl = own && !tooLong ? own : `https://namada.valopers.com/proposals/${prop.id}`;
  const linkNote = tooLong ? `\n\nThe proposal's own discussion link is ${own.length} characters long, too long to post here.` : '';

  const body = {
    username: 'Namada Forum & Governance Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: title.slice(0, 250),
        url: propUrl,
        color,
        description: (prop.abstract
          ? `${plainMd(prop.abstract)}\n\n[View Discussion / Proposal ↗](${propUrl})`
          : `[View Proposal #${prop.id} ↗](${propUrl})`) + linkNote,
        fields: [
          { name: 'Status', value: `\`${prop.status}\``, inline: true },
          { name: 'Type', value: `\`${prop.type}\``, inline: true },
          {
            name: 'Voting Window',
            value: `Epoch ${prop.startEpoch} → ${prop.endEpoch}`,
            inline: true,
          },
          {
            name: 'YAY Votes',
            value: `${Math.round(prop.yayNam).toLocaleString()} NAM`,
            inline: true,
          },
          {
            name: 'NAY Votes',
            value: `${Math.round(prop.nayNam).toLocaleString()} NAM`,
            inline: true,
          },
          {
            name: 'ABSTAIN',
            value: `${Math.round(prop.abstainNam).toLocaleString()} NAM`,
            inline: true,
          },
        ],
        footer: {
          text: 'NamadaTrade • On-Chain Governance Monitor',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  return sendForumGov(webhookUrl, body, `alert:gov:prop:${prop.id}:${prop.status}`, `proposal ${prop.id} ${prop.status}`, db, budget);
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
 * Send a test Discord webhook message to verify user's webhook configuration: 'held' when it is not posted
 * (testPostHeld, or no unit of the test posts' budget was left), else whether Discord took it (sendDiscordTestPost,
 * which also says whether the answer was invalid).
 */
export async function sendDiscordTestAlert(webhookUrl: string, u: StoredSettings, db?: D1Database, proven = false): Promise<boolean | 'held'> {
  const r = await sendDiscordTestPost(webhookUrl, u, db, proven);
  return r === 'held' ? 'held' : r.ok;
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
 * The test post itself, which is also the connection notice a save posts to a link it turns on (api.ts PUT
 * /api/me/settings): 'held' when it is not posted, else its answer (TestPostAnswer). The answer is counted against
 * the link here as an alert's is, and an invalid answer keeps the unit the post took of the test posts' budget, never
 * the alerts' (kv `alerts.invalid`); a proven link takes no unit, and a fresh row's post goes once without one when
 * the budget is spent. A run that does not send alerts posts nothing and answers as no answer.
 */
export async function sendDiscordTestPost(webhookUrl: string, u: StoredSettings, db?: D1Database, proven = false, fresh = false): Promise<'held' | TestPostAnswer> {
  if (!sending) {
    console.log('alerts: test post not sent (this run does not send alerts: SEND_ALERTS is not yes)');
    return { ok: false, status: 0, invalid: false, blames: false, dead: false, over: false };
  }
  if (await testPostHeld(webhookUrl, db, proven, fresh)) return 'held';
  const w = windowOf(Date.now());
  let unit = !(proven || hooks.get(webhookUrl)?.ok);
  let over = false;
  if (unit && !(await reserveTest(db, w))) {
    if (!fresh) return 'held';
    unit = false;
    over = true;
  }
  const p = u.notifications;
  const on = Object.entries(p.rules).filter(([, r]) => r.on).map(([id, r]) => `${id} ≥ ${r.thresholdNam.toLocaleString()} NAM`);
  const body = {
    username: 'NamadaTrade',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: 'Discord channel connected',
        url: `${SITE.origin}/settings`,
        color: 0xffff00,
        description: `Alerts for \`${u.address.slice(0, 12)}…${u.address.slice(-6)}\` will arrive here.`,
        fields: [
          { name: 'Rules on', value: on.length ? on.join('\n') : 'none', inline: false },
          { name: 'Watchlist', value: p.watchlistOn && p.watchlist.length ? `${p.watchlist.length} address(es)` : 'off', inline: true },
          { name: 'Forum & governance', value: p.forumAndGov ? 'on' : 'off', inline: true },
          { name: 'Quiet hours (UTC)', value: p.quietHoursUtc ? `${p.quietHoursUtc.start}:00–${p.quietHoursUtc.end}:00` : 'none', inline: true },
        ],
        footer: { text: 'NamadaTrade · change these in Settings' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
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

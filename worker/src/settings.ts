// Per-user settings, encrypted at rest.
//
// What the operator can and cannot see: everything a user saves (watchlist, thresholds, Discord webhook)
// is stored as one AES-256-GCM blob under `kv` key `user:<address>`, keyed by the SETTINGS_KEY secret.
// D1 exports and backups therefore contain ciphertext only. Beside the blob, in plain text: when the row
// was first and last saved, whether its Discord channel is on, which link it holds as a keyed digest (an HMAC
// under the same secret, so a copy without the key cannot be checked against a link), when that link was first
// turned on, when a post to it last succeeded, and when a channel saved on whose connection notice did not reach it
// was saved or last had the notice posted again (the cap on channels, the dispatcher's read, its proof of a link and
// the cron's sweep of such channels use these without decrypting). The API never returns the webhook URL,
// only a mask and whether one is set. The decrypted settings exist in memory only while an alert
// is being dispatched. (An operator who changes this code can of course read anything; that is true of
// every hosted service and is said plainly in the Privacy section of the UI.)
import { base64 } from '@scure/base';
import type { AlertRuleId, NotificationPrefs, TelegramChannel, UserSettings } from '../../shared/types';
import { DEFAULT_THRESHOLDS, type AlertThresholds } from '../../shared/alerts';
import { kvGetJson } from './db';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface StoredSettings {
  address: string;
  notifications: NotificationPrefs;
  /**
   * `stopped`: why the channel is off though its owner did not pause it: the dispatcher turned it off because Discord
   * said its webhook is gone (404) or its token wrong (401) (sources/discord.ts stopDeadHooks), the save that would
   * have turned it on was answered so by the connection notice (api.ts PUT /api/me/settings), or, with `reason`
   * 'notice', that notice did not reach the channel (`status` Discord's answer, or 0 for no answer); with `savedAt`
   * too, a channel saved on with the note below was turned off later because no post reached it: the first answer
   * that blamed its link (`status`, `at`: sources/discord.ts stopTrialHooks, the Settings test post, the notice the
   * cron's tick posts again), or, with `tries`, NOTICE_TRIES_MAX notices the tick posted again on as many days that
   * did not reach it either (`status` the last one's answer, 0 for none: sources/discord.ts sweepNoticeChannels).
   * Cleared when the owner saves a link or turns the channel on.
   * `notice`: the connection notice the save that turned the channel on posted did not reach it, twice, with an answer
   * that says nothing of the link itself (none, a 5xx, a 429 of shared or global scope or with none of Discord's
   * headers; `status` is the answer, 0 for none), and the channel is on anyway, on trial: no post has reached the link
   * yet, so the dispatcher's first post, or a test post, proves it (the row's okAt) or, answered with a refusal of the
   * link, stops it; when no post has reached it within NOTICE_TRIAL_MS, the cron's tick posts the notice again, once
   * a day (`tries`: how many it posted, and the last one's answer and time), which proves or stops it the same way.
   * Cleared when the owner saves a link or turns the channel on; shown by the API only while the row records no
   * successful post (publicView `proven`).
   */
  channels: { discord: { enabled: boolean; webhookUrl: string | null; stopped?: StoppedChannel; notice?: NoticeNotTaken }; telegram?: StoredTelegram };
  createdAt: number;
  updatedAt: number;
}
/**
 * The Telegram chat a row's alerts go to (worker/src/telegram-bot.ts). `chatId` is set only by the bot's handshake (a
 * one-time code the owner's Settings page made, sent back by Telegram when the owner pressed Start), never by the page;
 * it is cleared, with `stopped` saying why, when Telegram says the person blocked the bot or the bot left the group, or
 * someone in the chat sent /stop. A row saved before the channel existed has no `telegram`.
 */
export interface StoredTelegram { enabled: boolean; chatId: number | null; kind: 'private' | 'group' | null; title: string | null; linkedAt: number | null; stopped?: TelegramChannel['stopped'] }
/** A row's Telegram channel, as stored or, for a row saved before it existed, unlinked. */
export const telegramOf = (s: StoredSettings): StoredTelegram =>
  s.channels.telegram ?? { enabled: false, chatId: null, kind: null, title: null, linkedAt: null };
/** Alerts go to the row's Telegram chat: a chat is linked and sending is on. */
export const telegramOn = (s: StoredSettings): boolean => !!(s.channels.telegram?.enabled && s.channels.telegram.chatId != null);
/**
 * Why a channel is off: Discord's answer that the link is dead (`status` 404 or 401, no `reason`), or the connection
 * notice the save posts was not taken (`reason` 'notice'; `status` is Discord's answer, or 0 when it gave none); with
 * `savedAt` (when the link was saved on with the notice's note), no post reached a channel on trial: `status` is the
 * answer that blamed the link, or, with `tries` (NOTICE_TRIES_MAX), the answer to the last of the notices the cron's
 * tick posted again, none of which reached it.
 */
export interface StoppedChannel { status: number; at: number; reason?: 'notice'; savedAt?: number; tries?: number }
/**
 * A connection notice that did not reach a channel saved on: Discord's answer to it (`status`, 0 for none) and when the
 * link was saved (`at`); `tries`, once the cron's tick has posted the notice again: how many times, and the last one's
 * answer and time.
 */
export interface NoticeNotTaken { status: number; at: number; tries?: { n: number; status: number; at: number } }

const RULE_IDS: AlertRuleId[] = ['ibc_inventory', 'unlock', 'big_swap', 'unshield', 'bond'];
const KEY_OF: Record<AlertRuleId, keyof AlertThresholds> = { ibc_inventory: 'ibcInventory', unlock: 'unlock', big_swap: 'bigSwap', unshield: 'unshield', bond: 'bond' };

export function defaultPrefs(): NotificationPrefs {
  return {
    rules: Object.fromEntries(RULE_IDS.map((id) => [id, { on: true, thresholdNam: DEFAULT_THRESHOLDS[KEY_OF[id]] }])) as NotificationPrefs['rules'],
    watchlist: [],
    watchlistOn: true,
    forumAndGov: false,
    dailyDigest: false,
    quietHoursUtc: null,
  };
}

export function thresholdsOf(p: NotificationPrefs): AlertThresholds {
  const th = { ...DEFAULT_THRESHOLDS };
  for (const id of RULE_IDS) {
    const r = p.rules[id];
    // A disabled rule gets an unreachable threshold so evaluateFlow never fires it.
    th[KEY_OF[id]] = r?.on ? Math.max(1, Number(r.thresholdNam) || DEFAULT_THRESHOLDS[KEY_OF[id]]) : Number.MAX_SAFE_INTEGER;
  }
  return th;
}

export function inQuietHours(p: NotificationPrefs, now = Date.now()): boolean {
  const q = p.quietHoursUtc;
  if (!q) return false;
  const h = new Date(now).getUTCHours();
  return q.start <= q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

// ---------------------------------------------------------------- crypto

/** The imported key of the last secret used: the dispatcher's read opens every row with Discord on under one key. */
let lastKey: { secret: string; key: Promise<CryptoKey> } | null = null;
async function aesKey(secret: string): Promise<CryptoKey> {
  if (lastKey?.secret === secret) return lastKey.key;
  const raw = base64.decode(secret.trim());
  if (raw.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes, base64');
  const key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  lastKey = { secret, key };
  key.catch(() => { if (lastKey?.key === key) lastKey = null; });
  return key;
}

async function seal(secret: string, obj: unknown): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return `v1.${base64.encode(iv)}.${base64.encode(ct)}`;
}

async function open(secret: string, blob: string): Promise<any> {
  const [v, ivB, ctB] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown settings format');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64.decode(ivB) }, key, base64.decode(ctB));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------------------------------------------------------------- storage

export function requireKey(env: { SETTINGS_KEY?: string }): string {
  if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not configured; run `wrangler secret put SETTINGS_KEY`');
  return env.SETTINGS_KEY;
}

export async function loadSettings(db: D1Database, secret: string, address: string): Promise<StoredSettings | null> {
  const blob = await kvGetJson<{ blob: string }>(db, `user:${address}`);
  // The plaintext alert settings from before sign-in existed (`webhook:user:<address>`) are not read: nothing
  // proves a row there belongs to whoever signs in as the address, and its webhook URL never passed applyUpdate's
  // check. None existed in production on 2026-10-21; sweepAuth deletes any a restore brings back.
  return blob?.blob ? ((await open(secret, blob.blob)) as StoredSettings) : null;
}

/**
 * Discord channels on at most, site-wide. A channel is a link: rows that share one link take one place, as the
 * dispatcher posts once per link and turns a link off once. A save that would turn one more on is refused
 * (saveSettings). A place is held only by a proven link: the API turns a link on only once a post to it succeeded
 * (api.ts PUT /api/me/settings posts a connection notice to a link it turns on and keeps the channel off when Discord
 * does not take it; `okAt` records the success), so a row with Discord on is always a link that took a post, and it
 * holds its place for good: a quiet channel is not a dead one, and no grace, sweep or test post is needed to keep or
 * free a place. A link Discord later answers is gone or has a wrong token is turned off visibly (sources/discord.ts
 * stopDeadHooks), which frees its place.
 */
export const DELIVERABLE_MAX = 500;
/**
 * The most addresses that may have saved settings, with Discord on or off. Sign-ins are free (any fresh key is a new
 * address) and a row is kept for good, so free addresses could otherwise grow the one database every other write
 * shares. A sealed row is at most about 12.8 KB (SETTINGS_MAX_BYTES), so the rows stay under about 26 MB. It is four
 * times DELIVERABLE_MAX, so rows saved with Discord off (rules and a watchlist saved before a link, or with the
 * channel turned off) never take a channel's place, and it bounds the dispatcher's read too, which takes every row of
 * the channels it serves (readDeliverable). A new address past it is refused (the request answers 503, the cron's
 * health row says so); Delete everything frees a place.
 */
export const USER_ROWS_MAX = 4 * DELIVERABLE_MAX;
/** Every saved settings row, as a range the primary key answers (index entries only, never the sealed values). */
const USER_ROWS = `key >= 'user:' AND key < 'user;'`;
/**
 * The user: rows whose Discord channel is on: the exact WHERE of the partial index kv_user_deliverable (migration
 * 0012; SQLite matches a partial index by expression), so the cap's count and the dispatcher's read touch those rows
 * only, and a row saved with Discord off never takes a place. A row written before 0012 has no `on` (json_extract
 * gives NULL) and counts as on, so no row of the old shape drops out unseen. json_extract runs on user: rows only.
 */
const DELIVERABLE_ROWS = `${USER_ROWS} AND json_extract(value, '$.on') IS NOT 0`;
/** The channel a row with Discord on is: its link's digest, or the row itself for a row of the old shape (no digest). */
const LINK = `COALESCE(json_extract(value, '$.hook'), key)`;
/** The distinct links that hold a place: the links of the rows with Discord on other than `self` (a parameter naming the row's key). */
const OTHER_LINKS = (self: string) => `(SELECT COUNT(DISTINCT ${LINK}) FROM kv WHERE ${DELIVERABLE_ROWS} AND key <> ${self})`;
/** Whether another row with Discord on holds the place of link `hook` (a parameter). */
const SHARED_LINK = (self: string, hook: string) => `EXISTS (SELECT 1 FROM kv WHERE ${DELIVERABLE_ROWS} AND key <> ${self} AND json_extract(value, '$.hook') = ${hook})`;
const deliverable = (s: StoredSettings) => !!(s.channels.discord.enabled && s.channels.discord.webhookUrl);
const enc = new TextEncoder();
/** Which Telegram chat a row is linked to, as stored beside the sealed blob (`tgc`): an HMAC of the chat id under the settings secret, cut to 128 bits. */
export const chatDigest = (secret: string, chatId: number): string =>
  bytesToHex(hmac(sha256, enc.encode(secret.trim()), enc.encode(`telegram-chat:${chatId}`))).slice(0, 32);
/**
 * Which channel a Discord link is, as stored beside the sealed blob: an HMAC of the link under the settings secret,
 * cut to 128 bits. Rows that share a link have the same digest, and a copy of the database without the secret cannot
 * be checked against a link someone holds.
 */
export const hookDigest = (secret: string, url: string): string =>
  bytesToHex(hmac(sha256, enc.encode(secret.trim()), enc.encode(`discord-link:${url}`))).slice(0, 32);
/**
 * The stored row: the sealed settings, and beside them in plain text when they were first and last saved, whether
 * Discord is on, the saved link's digest (`hook`, on or off), when that link was first turned on (`onAt`, kept by
 * saveSettings while the row keeps the link; for a new row, now when it is on) and, for a channel on with the
 * connection notice's note, when it was saved so or the notice was last posted again (`noticeAt`, which trialsDue
 * reads). `okAt`, the last successful post to the link, is written by hookOkStmt only and kept the same way.
 * For Telegram: `tg`, whether alerts go to the row's chat (telegramOn), and `tgc`, the linked chat's digest (on or
 * off), so the bot finds the rows of a chat that sent /stop or blocked it without opening every row.
 */
const rowValue = async (secret: string, s: StoredSettings, at = Date.now()) => {
  const on = deliverable(s);
  const url = s.channels.discord.webhookUrl;
  const notice = s.channels.discord.notice;
  const noticeAt = on && notice ? notice.tries?.at ?? notice.at : null;
  const chat = s.channels.telegram?.chatId;
  return JSON.stringify({ blob: await seal(secret, s), updatedAt: s.updatedAt, createdAt: s.createdAt, on, hook: url ? hookDigest(secret, url) : null, onAt: on ? at : null, noticeAt, tg: telegramOn(s), tgc: chat != null ? chatDigest(secret, chat) : null });
};

/**
 * Stores the user's settings; false when refused. Both caps are counted by the insert itself (D1 runs one statement
 * at a time, so saves made together cannot pass either cap together):
 * - a new address is written only while fewer than USER_ROWS_MAX addresses have a row; an address that has a row can
 *   always change it;
 * - a save that turns Discord on, or gives a row with Discord on another link, is written only when that link
 *   already holds a place through another row, or while fewer than DELIVERABLE_MAX links of other rows hold one; a
 *   save that leaves Discord off, or keeps it on with the same link, is never refused by this cap and takes no new
 *   place.
 * The row keeps `onAt` (the link's first-on time) and `okAt` (its last successful post) while it keeps the same
 * link, on or off; another link starts from this save with neither, so the API proves it by a post before it is
 * turned on. A channel past the cap is refused to its owner instead of left out of the alerts unseen (refusalOf says
 * which cap refused).
 */
export async function saveSettings(db: D1Database, secret: string, s: StoredSettings): Promise<boolean> {
  const now = Date.now();
  const url = s.channels.discord.webhookUrl;
  const link = url ? hookDigest(secret, url) : null;
  const hook = deliverable(s) ? link : null;
  const same = `json_extract(kv.value, '$.hook') = ?5`;
  const r = await db.prepare(
    `INSERT INTO kv (key, value, updated_at) SELECT ?1, ?2, ?3
     WHERE (EXISTS (SELECT 1 FROM kv WHERE key = ?1) OR (SELECT COUNT(*) FROM kv WHERE ${USER_ROWS}) < ${USER_ROWS_MAX})
       AND (?4 IS NULL
         OR EXISTS (SELECT 1 FROM kv WHERE key = ?1 AND json_extract(value, '$.on') IS NOT 0 AND json_extract(value, '$.hook') = ?4)
         OR ${SHARED_LINK('?1', '?4')} OR ${OTHER_LINKS('?1')} < ${DELIVERABLE_MAX})
     ON CONFLICT(key) DO UPDATE SET value = json_set(excluded.value,
         '$.onAt', CASE WHEN ?5 IS NULL THEN NULL WHEN ${same} THEN COALESCE(json_extract(kv.value, '$.onAt'), json_extract(excluded.value, '$.onAt')) ELSE json_extract(excluded.value, '$.onAt') END,
         '$.okAt', CASE WHEN ?5 IS NOT NULL AND ${same} THEN json_extract(kv.value, '$.okAt') END),
       updated_at = excluded.updated_at`,
  ).bind(`user:${s.address}`, await rowValue(secret, s, now), now, hook, link).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** What a wallet is told when USER_ROWS_MAX refused its first save. */
export const SETTINGS_FULL = 'This site cannot keep alert settings for more wallets right now, so nothing was saved. Please try again later.';
/**
 * What a wallet is told when DELIVERABLE_MAX refused the save that turns its Discord channel on: the row is then saved
 * with the channel off (api.ts), so the link and every other change are kept.
 */
export const CHANNELS_FULL = `Discord alerts are full: this site serves ${DELIVERABLE_MAX} channels and all are taken. Your changes were saved with sending off; turn sending on later, when a channel has been freed.`;

/**
 * Which cap refused a save of `s`, read after saveSettings returned false, for the answer only: 'rows' when the
 * address has no row and USER_ROWS_MAX addresses have one, else 'channels'. A failed read says 'rows', whose answer
 * asks the wallet to try again later.
 */
export async function refusalOf(db: D1Database, s: StoredSettings): Promise<'rows' | 'channels'> {
  const r = await db.prepare(`SELECT EXISTS (SELECT 1 FROM kv WHERE key = ?1) has, (SELECT COUNT(*) FROM kv WHERE ${USER_ROWS}) n`)
    .bind(`user:${s.address}`).first<{ has: number; n: number }>().catch(() => null);
  if (!r || !(r.has || Number(r.n) < USER_ROWS_MAX)) return 'rows';
  return 'channels';
}

/**
 * Whether a save that turns link `url` on in `address`'s row would be refused by DELIVERABLE_MAX, read before the
 * connection notice is posted (api.ts), so a full site posts nothing to a link it cannot serve. A read only: the save
 * itself counts the cap again, in its own statement. A failed read says there is room.
 */
export async function channelsFull(db: D1Database, secret: string, address: string, url: string): Promise<boolean> {
  const r = await db.prepare(`SELECT (${SHARED_LINK('?1', '?2')} OR ${OTHER_LINKS('?1')} < ${DELIVERABLE_MAX}) AS room`)
    .bind(`user:${address}`, hookDigest(secret, url)).first<{ room: number }>().catch(() => null);
  return !!r && !r.room;
}

/**
 * kv `settings.refused`: saves the caps refused, in all and the last one (the cron's health row reads it). `total`
 * and `lastAt` count new addresses past USER_ROWS_MAX, `channels` and `channelsAt` channels past DELIVERABLE_MAX.
 */
export interface SettingsRefused { total: number; lastAt: number; channels?: number; channelsAt?: number }
/** Adds one refusal to kv `settings.refused`, in one statement (an atomic upsert). */
export async function noteSettingsRefused(db: D1Database, at = Date.now(), cap: 'rows' | 'channels' = 'rows'): Promise<void> {
  const [n, last] = cap === 'rows' ? ['total', 'lastAt'] : ['channels', 'channelsAt'];
  const first = cap === 'rows' ? `json_object('total', 1, 'lastAt', ?1)` : `json_object('total', 0, 'lastAt', 0, 'channels', 1, 'channelsAt', ?1)`;
  await db.prepare(
    `INSERT INTO kv (key,value,updated_at) VALUES ('settings.refused', ${first}, ?1)
     ON CONFLICT(key) DO UPDATE SET value = json_set(kv.value, '$.${n}', COALESCE(json_extract(kv.value, '$.${n}'), 0) + 1, '$.${last}', ?1), updated_at = ?1`,
  ).bind(at).run().catch((e) => console.error('settings: a refused save was not recorded', e));
}

/** How many addresses have saved settings. */
export async function userRowCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) n FROM kv WHERE ${USER_ROWS}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** How many saved settings rows have their Discord channel on (on the partial index kv_user_deliverable). */
export async function deliverableCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) n FROM kv WHERE ${DELIVERABLE_ROWS}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** How many Discord channels hold a place under DELIVERABLE_MAX: the distinct links of the rows with Discord on. */
export async function placeCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(DISTINCT ${LINK}) n FROM kv WHERE ${DELIVERABLE_ROWS}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * The statement that records a successful post to `url` at `at` in `address`'s row, while that row still holds that
 * link, on or off (a row with Discord off records it without a place; its next save turns the channel on through
 * the cap, and needs no post of its own). For db.batch.
 */
export function hookOkStmt(db: D1Database, secret: string, address: string, url: string, at: number): D1PreparedStatement {
  return db.prepare(`UPDATE kv SET value = json_set(value, '$.okAt', ?1) WHERE key = ?2 AND json_extract(value, '$.hook') = ?3`)
    .bind(at, `user:${address}`, hookDigest(secret, url));
}

/** Whether a post to `url` from `address`'s row ever succeeded (`okAt`), while the row holds that link. */
export async function linkProven(db: D1Database, secret: string, address: string, url: string): Promise<boolean> {
  const r = await db.prepare("SELECT json_extract(value, '$.okAt') IS NOT NULL AND json_extract(value, '$.hook') = ?2 AS proven FROM kv WHERE key = ?1")
    .bind(`user:${address}`, hookDigest(secret, url)).first<{ proven: number }>().catch(() => null);
  return !!r?.proven;
}

/**
 * The statement that turns `s`'s Discord channel off, for Discord answering `status` (its webhook gone or its token
 * wrong), for db.batch. It writes only over the row as it was read (the same updatedAt), so a save the owner made
 * since is never overwritten. It keeps the row's updated_at and createdAt, so turning a channel off never moves the
 * row in the read, and the link's first-on time (`onAt`); the row's plain `on` becomes false, so the channel's place
 * under DELIVERABLE_MAX is freed (the owner turning it on again is counted like any other channel). With `reason`
 * 'notice' it ends a channel's trial (a row saved on with the connection notice's note, `notice`): `status` is the
 * answer that blamed the link, or, with `tries`, the last of the notices the cron's tick posted again; the stop
 * records when the link was saved (`savedAt`), and it writes only while the row still records no successful post (no
 * `okAt`), so a post another isolate made with success meanwhile keeps the channel on.
 */
export async function stopChannelStmt(db: D1Database, secret: string, s: StoredSettings, status: number, at: number, reason?: 'notice', tries?: number): Promise<D1PreparedStatement> {
  const n = structuredClone(s);
  const savedAt = s.channels.discord.notice?.at;
  n.channels.discord.enabled = false;
  n.channels.discord.stopped = reason ? { status, at, reason, ...(savedAt != null ? { savedAt } : {}), ...(tries ? { tries } : {}) } : { status, at };
  delete n.channels.discord.notice;
  const unproven = reason ? " AND json_extract(value, '$.okAt') IS NULL" : '';
  return db.prepare(`UPDATE kv SET value = json_set(?, '$.onAt', json_extract(value, '$.onAt')) WHERE key = ? AND json_extract(value, '$.updatedAt') = ?${unproven}`)
    .bind(await rowValue(secret, n), `user:${s.address}`, s.updatedAt);
}

/**
 * How long a channel saved on with the connection notice's note (its notice was answered nothing against the link,
 * twice) waits for a post to reach it before the cron's tick posts the notice again, and how long it waits between
 * such posts (sources/discord.ts sweepNoticeChannels).
 */
export const NOTICE_TRIAL_MS = 24 * 3_600_000;
/**
 * The most channels on trial one tick posts the notice to; the rest wait for the next tick. Each post is a few
 * subrequests of the tick (the test posts' budget read and taken, the post, the row written), so the tick's own reads
 * and its forum and governance alerts stay well inside the per-invocation limit (sources/discord.ts RUN_ALERT_POSTS).
 */
export const NOTICE_SWEEP_MAX = 5;
/**
 * How many notices the cron's tick posts again, a day apart, to a channel on trial whose every answer says nothing
 * against the link (no answer, a 5xx, a 429 that is not the link's own) before the channel is turned off, visibly: the
 * link has then taken no post for as many days after its save.
 */
export const NOTICE_TRIES_MAX = 3;
/**
 * The channels saved on with the connection notice's note whose row records no successful post (`noticeAt` and no
 * `okAt` beside the blob) and whose notice was saved, or last posted again, more than NOTICE_TRIAL_MS before `now`: at
 * most NOTICE_SWEEP_MAX, oldest first, opened. Rows that do not open under the key are left as they are
 * (readDeliverable records them).
 */
export async function trialsDue(db: D1Database, secret: string, now = Date.now()): Promise<StoredSettings[]> {
  const rows = (await db.prepare(
    `SELECT key, value FROM kv WHERE ${DELIVERABLE_ROWS} AND json_extract(value, '$.noticeAt') < ?1 AND json_extract(value, '$.okAt') IS NULL
     ORDER BY json_extract(value, '$.noticeAt') LIMIT ${NOTICE_SWEEP_MAX}`,
  ).bind(now - NOTICE_TRIAL_MS).all<{ key: string; value: string }>()).results ?? [];
  const due: StoredSettings[] = [];
  for (const r of rows) {
    try {
      const s = (await open(secret, JSON.parse(r.value).blob)) as StoredSettings;
      if (deliverable(s) && s.channels.discord.notice) due.push(s);
    } catch (e) {
      console.error(`settings: a channel on trial could not be opened (${r.key.slice(0, 20)}…):`, e);
    }
  }
  return due;
}
/**
 * The statement that records a notice the cron's tick posted again to `s`'s channel on trial, which Discord answered
 * `status` at `at` with nothing against the link (sources/discord.ts sweepNoticeChannels), for db.batch: the trial goes
 * on from `at` (the row's `noticeAt`), the try counted in the note (`notice.tries`); at NOTICE_TRIES_MAX tries the
 * channel is turned off instead (stopChannelStmt with reason 'notice' and the tries). Either writes only over the row
 * as it was read (the same updatedAt) and while it records no successful post, and keeps the row's updated_at,
 * createdAt and the link's first-on time.
 */
export async function noticeTriedStmt(db: D1Database, secret: string, s: StoredSettings, status: number, at: number): Promise<D1PreparedStatement> {
  const notice = s.channels.discord.notice!;
  const tries = (notice.tries?.n ?? 0) + 1;
  if (tries >= NOTICE_TRIES_MAX) return stopChannelStmt(db, secret, s, status, at, 'notice', tries);
  const n = structuredClone(s);
  n.channels.discord.notice = { ...notice, tries: { n: tries, status, at } };
  return db.prepare(`UPDATE kv SET value = json_set(?, '$.onAt', json_extract(value, '$.onAt')) WHERE key = ? AND json_extract(value, '$.updatedAt') = ? AND json_extract(value, '$.okAt') IS NULL`)
    .bind(await rowValue(secret, n), `user:${s.address}`, s.updatedAt);
}

/** The address's settings, any plaintext settings from before sign-in, its test-post cooldowns and its Telegram link code. */
export async function deleteSettings(db: D1Database, address: string): Promise<void> {
  const code = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(`tglinkby:${address}`).first<{ value: string }>().catch(() => null);
  await db.prepare('DELETE FROM kv WHERE key IN (?, ?, ?, ?, ?, ?)')
    .bind(`user:${address}`, `webhook:user:${address}`, `webhook_test:${address}`, `tg_test:${address}`, `tglinkby:${address}`, `tglink:${code?.value ?? ''}`).run();
}

/**
 * Decrypted settings of the users the dispatcher serves (used only by the dispatcher): every row of at most
 * DELIVERABLE_MAX channels (links), first saved first; how many rows with Discord on were not served (rows of the
 * channels past DELIVERABLE_MAX, which only rows of the old shape or a restored copy can make, since the save admits
 * a channel only under the cap, and rows that do not open under this key); when a post to each served row's link last
 * succeeded (`okAt`, by address: the dispatcher's proof that the link works, whichever isolate posted to it); and
 * when each served row's link was first turned on (`onAt`, by address; the row's last save for a row of the old
 * shape). The dispatcher records `unserved` with the posts not sent (kv alerts.skipped), so a subscriber left out
 * shows in the health view. A failed read throws.
 */
export async function readDeliverable(db: D1Database, secret: string | undefined): Promise<{ users: StoredSettings[]; unserved: number; okAt: Map<string, number>; onAt: Map<string, number> }> {
  const okAt = new Map<string, number>();
  const onAt = new Map<string, number>();
  if (!secret) return { users: [], unserved: 0, okAt, onAt };
  const rows = (await db.prepare(
    `WITH r AS (
       SELECT key, value, ${LINK} AS link, COALESCE(json_extract(value, '$.createdAt'), updated_at) AS first, json_extract(value, '$.okAt') AS ok, COALESCE(json_extract(value, '$.onAt'), updated_at) AS on_at
       FROM kv WHERE ${DELIVERABLE_ROWS}
     ), links AS (
       SELECT link, ROW_NUMBER() OVER (ORDER BY MIN(first), link) AS n FROM r GROUP BY link
     )
     SELECT r.value AS value, r.ok AS ok, r.on_at AS on_at, links.n AS n FROM r JOIN links ON links.link = r.link
     WHERE links.n <= ${DELIVERABLE_MAX} ORDER BY links.n, r.first, r.key`,
  ).all<{ value: string; ok: number | null; on_at: number | null; n: number }>()).results ?? [];
  let unserved = 0;
  if (rows.length && Number(rows[rows.length - 1].n) >= DELIVERABLE_MAX) {
    const n = await deliverableCount(db);
    unserved = Math.max(0, n - rows.length);
    if (unserved) console.warn(`allDeliverable: ${unserved} user rows with Discord on past the ${DELIVERABLE_MAX} channels read`);
  }
  const users: StoredSettings[] = [];
  for (const r of rows) {
    try {
      const { blob } = JSON.parse(r.value);
      const s = (await open(secret, blob)) as StoredSettings;
      if (!deliverable(s)) continue;
      users.push(s);
      if (r.ok != null && Number.isFinite(Number(r.ok))) okAt.set(s.address, Number(r.ok));
      if (r.on_at != null && Number.isFinite(Number(r.on_at))) onAt.set(s.address, Number(r.on_at));
    } catch { unserved++; }
  }
  return { users, unserved, okAt, onAt };
}

/** The users readDeliverable serves. */
export const allDeliverable = async (db: D1Database, secret: string | undefined): Promise<StoredSettings[]> => (await readDeliverable(db, secret)).users;

/**
 * Public view: no secrets. `proven`: a post to the saved link has succeeded (the row's okAt, linkProven), so the note
 * of a connection notice that did not reach the channel is left out: the link works.
 */
export function publicView(s: StoredSettings, proven = false): UserSettings {
  const d = s.channels.discord;
  const url = d.webhookUrl;
  return {
    address: s.address,
    notifications: s.notifications,
    channels: { discord: { enabled: d.enabled, hasUrl: !!url, webhookUrlMasked: url ? `${url.slice(0, 38)}••••${url.slice(-4)}` : null, stopped: d.stopped ?? null, notice: d.notice && !proven ? d.notice : null }, telegram: telegramView(s) },
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** The Telegram channel's public view: never the chat id. */
export function telegramView(s: StoredSettings): TelegramChannel {
  const t = telegramOf(s);
  const linked = t.chatId != null;
  return { linked, enabled: linked && t.enabled, kind: linked ? t.kind : null, title: linked ? t.title : null, linkedAt: linked ? t.linkedAt : null, stopped: t.stopped ?? null };
}

/**
 * A Discord webhook link. Its id is a snowflake (at most 20 digits) and its token is 68 characters today; at most 100
 * are taken. With both parts unbounded, one 16 KB request stored a link of about 16,300 characters.
 */
export const WEBHOOK_URL_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,100}$/;
/**
 * The most one address's settings may hold as JSON before sealing. The largest the checks below allow (100 watched
 * addresses of 85 characters, the longest link, every other field at its largest) is about 9.5 KB, so a stored row
 * stays under about 14 KB. A field added later cannot grow the row past it unnoticed.
 */
export const SETTINGS_MAX_BYTES = 10 * 1024;

/** Validate and merge a client update onto stored settings. Secrets only change when explicitly sent. */
export function applyUpdate(cur: StoredSettings, body: any): StoredSettings | string {
  const n = structuredClone(cur);
  const np = body.notifications;
  if (np) {
    if (np.rules) for (const id of RULE_IDS) {
      const r = np.rules[id];
      if (r) n.notifications.rules[id] = { on: !!r.on, thresholdNam: Math.min(1e12, Math.max(1, Number(r.thresholdNam) || n.notifications.rules[id].thresholdNam)) };
    }
    if (Array.isArray(np.watchlist)) {
      const list = [...new Set(np.watchlist.map((a: any) => String(a).trim()).filter((a: string) => /^(tnam1|osmo1)[0-9a-z]{20,80}$/.test(a)))].slice(0, 100);
      n.notifications.watchlist = list as string[];
    }
    if (typeof np.watchlistOn === 'boolean') n.notifications.watchlistOn = np.watchlistOn;
    if (typeof np.forumAndGov === 'boolean') n.notifications.forumAndGov = np.forumAndGov;
    if (typeof np.dailyDigest === 'boolean') n.notifications.dailyDigest = np.dailyDigest;
    if (np.quietHoursUtc === null) n.notifications.quietHoursUtc = null;
    else if (np.quietHoursUtc && Number.isInteger(np.quietHoursUtc.start) && Number.isInteger(np.quietHoursUtc.end)) {
      const { start, end } = np.quietHoursUtc;
      if (start < 0 || start > 23 || end < 0 || end > 24) return 'quiet hours must be 0–23 / 0–24 UTC';
      n.notifications.quietHoursUtc = { start, end };
    }
  }
  const d = body.channels?.discord;
  if (d) {
    if (typeof d.enabled === 'boolean') n.channels.discord.enabled = d.enabled;
    if (typeof d.webhookUrl === 'string') {
      const u = d.webhookUrl.trim();
      if (u === '') n.channels.discord.webhookUrl = null;
      else if (!WEBHOOK_URL_RE.test(u)) return 'that is not a Discord webhook URL';
      else n.channels.discord.webhookUrl = u;
    }
    if (!n.channels.discord.webhookUrl) n.channels.discord.enabled = false;
    // The owner saved a link or turned the channel on: the dispatcher's stop no longer applies, and neither does the
    // note of a notice that did not reach the channel when the save posts the notice again (another link, or a channel
    // that was off: api.ts). A save that keeps the channel on with the same link posts nothing, so its note, and the
    // trial it starts (sources/discord.ts sweepNoticeChannels, from the note's own time and its tries), stay.
    if (d.enabled === true || typeof d.webhookUrl === 'string') {
      delete n.channels.discord.stopped;
      if (n.channels.discord.webhookUrl !== cur.channels.discord.webhookUrl || !cur.channels.discord.enabled) delete n.channels.discord.notice;
    }
  }
  const t = body.channels?.telegram;
  if (t) {
    const tg = telegramUpdate(telegramOf(n), t);
    if (typeof tg === 'string') return tg;
    n.channels.telegram = tg;
  }
  n.updatedAt = Date.now();
  if (new TextEncoder().encode(JSON.stringify(n)).length > SETTINGS_MAX_BYTES) return 'these settings are too large to save';
  return n;
}

/**
 * The page's change `t` to a row's Telegram channel `cur`: sending on or off, or the chat disconnected; it never sets a
 * chat (only the bot's handshake does: worker/src/telegram-bot.ts). api.ts applies it again to the channel as stored
 * just before the save, so a chat the bot unlinked meanwhile is not put back.
 */
export function telegramUpdate(cur: StoredTelegram, t: any): StoredTelegram | string {
  if (t.disconnect === true) return { enabled: false, chatId: null, kind: null, title: null, linkedAt: null };
  if (typeof t.enabled !== 'boolean') return cur;
  if (t.enabled && cur.chatId == null) return 'connect a Telegram chat first';
  return { ...cur, enabled: t.enabled };
}

// ---------------------------------------------------------------- Telegram rows

/** The user: rows whose Telegram chat is on, the exact WHERE of migration 0013's partial index kv_user_telegram. */
const TELEGRAM_ROWS = `${USER_ROWS} AND json_extract(value, '$.tg') = 1`;
/**
 * The most Telegram chats the dispatcher sends to, site-wide: the chats of the rows linked first. It is the live hub's
 * share of messages per invocation (sources/telegram.ts TG_LIVE_SENDS), so one alert to every chat fits one invocation,
 * inside about 8 seconds at Telegram's pace. The bot refuses a link past it (telegram-bot.ts).
 */
export const TELEGRAM_CHATS_MAX = 200;
/**
 * What a wallet is told when TELEGRAM_CHATS_MAX refused the save that turns its paused chat on again: the row is then
 * saved with sending still paused (api.ts), so every other change is kept.
 */
export const TELEGRAM_FULL = `Telegram alerts are full: this site sends to ${TELEGRAM_CHATS_MAX} chats and all are taken. Your changes were saved with sending to Telegram paused; turn it on later, when a chat has been freed.`;

/** How many distinct chats have Telegram on, other than `chatId`'s (the bot's cap on a new link). */
export async function telegramChatsOther(db: D1Database, secret: string, chatId: number): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(DISTINCT json_extract(value, '$.tgc')) n FROM kv WHERE ${TELEGRAM_ROWS} AND json_extract(value, '$.tgc') <> ?1`)
    .bind(chatDigest(secret, chatId)).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * The rows the Telegram dispatcher serves: every row with Telegram on, opened, those of the first TELEGRAM_CHATS_MAX
 * chats (first linked first), and how many rows were left out (past the cap, or not opening under the key).
 */
export async function readTelegram(db: D1Database, secret: string | undefined): Promise<{ users: StoredSettings[]; unserved: number }> {
  if (!secret) return { users: [], unserved: 0 };
  const rows = (await db.prepare(`SELECT key, value FROM kv WHERE ${TELEGRAM_ROWS} ORDER BY COALESCE(json_extract(value, '$.createdAt'), updated_at), key`)
    .all<{ key: string; value: string }>()).results ?? [];
  const users: StoredSettings[] = [];
  const chats = new Set<number>();
  let unserved = 0;
  for (const r of rows) {
    try {
      const s = (await open(secret, JSON.parse(r.value).blob)) as StoredSettings;
      if (!telegramOn(s)) continue;
      const chat = s.channels.telegram!.chatId!;
      if (!chats.has(chat) && chats.size >= TELEGRAM_CHATS_MAX) { unserved++; continue; }
      chats.add(chat);
      users.push(s);
    } catch { unserved++; }
  }
  return { users, unserved };
}

/**
 * The rows linked to Telegram chat `chatId`, on or off, opened: the bot's /status and /stop, a blocked bot or a group
 * left (unlinkChat), a group made a supergroup (moveChat), a test message to a chat that is gone. On migration 0014's
 * index kv_user_telegram_chat (the chat's digest over the user: range, whose terms this WHERE repeats), so a /status
 * from anyone reads that chat's rows only.
 */
export async function rowsOfChat(db: D1Database, secret: string, chatId: number): Promise<StoredSettings[]> {
  const rows = (await db.prepare(`SELECT value FROM kv WHERE ${USER_ROWS} AND json_extract(value, '$.tgc') = ?1`)
    .bind(chatDigest(secret, chatId)).all<{ value: string }>()).results ?? [];
  const out: StoredSettings[] = [];
  for (const r of rows) {
    try {
      const s = (await open(secret, JSON.parse(r.value).blob)) as StoredSettings;
      if (s.channels.telegram?.chatId === chatId) out.push(s);
    } catch { /* a row that does not open is left as it is */ }
  }
  return out;
}

/**
 * Writes `s` with its Telegram chat changed by `change`, only over the row as it was read (the same updatedAt), so a
 * save its owner made since is never overwritten; it keeps the Discord link's first-on time (`onAt`) and last success
 * (`okAt`). It moves updatedAt on, so a write from a copy read before it (the Discord dispatcher's cached rows, a
 * Settings save in flight) is refused instead of bringing the old chat back. False when the row changed meanwhile.
 */
export async function writeTelegram(db: D1Database, secret: string, s: StoredSettings, change: (t: StoredTelegram) => StoredTelegram): Promise<boolean> {
  const n = structuredClone(s);
  n.channels.telegram = change(telegramOf(n));
  n.updatedAt = Math.max(Date.now(), s.updatedAt + 1);
  const r = await db.prepare(`UPDATE kv SET value = json_set(?1, '$.onAt', json_extract(value, '$.onAt'), '$.okAt', json_extract(value, '$.okAt')) WHERE key = ?2 AND json_extract(value, '$.updatedAt') = ?3`)
    .bind(await rowValue(secret, n), `user:${s.address}`, s.updatedAt).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/**
 * Unlinks every row of chat `chatId` (`reason`: the person blocked the bot, the bot left the group, or /stop); how many
 * rows. A row a Settings save wrote after it was read is read again, up to three times (as the bot's link does), so the
 * save cannot keep a chat that asked to stop.
 */
export async function unlinkChat(db: D1Database, secret: string, chatId: number, reason: 'blocked' | 'removed' | 'stop', at = Date.now()): Promise<number> {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    let missed = 0;
    for (const s of await rowsOfChat(db, secret, chatId)) {
      if (await writeTelegram(db, secret, s, () => ({ enabled: false, chatId: null, kind: null, title: null, linkedAt: null, stopped: { reason, at } }))) n++;
      else missed++;
    }
    if (!missed) break;
  }
  return n;
}

/** Moves every row of a group Telegram turned into a supergroup (its id changes: `migrate_to_chat_id`) to the new id. */
export async function moveChat(db: D1Database, secret: string, from: number, to: number): Promise<void> {
  for (const s of await rowsOfChat(db, secret, from)) await writeTelegram(db, secret, s, (t) => ({ ...t, chatId: to }));
}

// Telegram delivery: the same alerts the Discord channels get, to each subscriber's own Telegram chat or group, and
// the site's own posts to its public channel (TELEGRAM_CHANNEL).
//
// A chat is linked only by the bot's handshake (worker/src/telegram-bot.ts); its rules, watchlist and quiet hours are
// the row's own, the ones Discord uses, so a subscriber chooses once and every channel they turn on hears the same
// moves. Each move and proposal alert is the Discord card (sources/discord.ts moveCard, govCard), fitted the same way
// and written as Telegram's HTML: the title, the text, every figure with its source, and a button back to the site. A
// forum post is its topic's title and category only (forumMessage): no excerpt, no author, no link from the post.
//
// The public channel hears the moves the X account posts, from the same selector and allowlist (public-posts.ts: at
// most one move a closed hour, its largest by dollars, and the hour's largest bridge crossing when its move is no
// crossing; sendTelegramHour), never each move as it arrives, and the forum posts and proposals the subscribers hear:
// a forum post as the subscribers get it, a proposal as X posts it (public-posts.ts publicProposal: its title as plain
// words, none of its authors, abstract or discussion link).
//
// Kept simpler than the Discord dispatcher on purpose: Telegram's limits are the bot's, not a link's (about 30
// messages a second, one a second to one chat: https://core.telegram.org/bots/faq), a chat is never made up (it
// exists because someone pressed Start), and a chat Telegram says is gone (the person blocked the bot, the bot left
// the group) is unlinked at once, visibly in Settings. Telegram runs after Discord in each invocation, under its own
// share of messages and time (TgRun), so it never delays Discord's alerts. Each part of an alert (the public channel,
// the subscribers) is claimed once (`alert:tg:` keys, swept with the other claims: auth.ts sweepAuth), so an alert
// offered again is never sent twice; a part none of whose messages Telegram took for want of an answer is given back,
// and one it refused is not sent again. What each alert sent, failed or left is kept in kv `telegram.last`.
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { alertRules, evaluateFlow } from '../../../shared/alerts';
import { SITE } from '../../../shared/site';
import { fmtAddr, fmtAge, fmtUtcLong } from '../../../shared/format';
import { chatDigest, inQuietHours, moveChat, readTelegram, thresholdsOf, unlinkChat, type StoredSettings } from '../settings';
import { kvSet } from '../db';
import { readMoveContext, type MoveContext } from './discord-context';
import {
  alertsOn, claimDiscordAlert, claimEach, crossingOf, releaseClaims, fits, govCard, moveCard, recordSkipped, settingsFields, sitePage,
  CARD_WORDS, TEXT_MAX, type Card, type Embed, type GovContext, type TestExample,
} from './discord';
import { claimTaken, hourPick, plainOutsider, publicProposal, publicRecord, publicTitle, publicValue, publicWho, publicWhy, type HourPart, type PublicHour, type PublicMove } from '../public-posts';

export interface TelegramEnv { DB: D1Database; SETTINGS_KEY?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHANNEL?: string }

const ORIGIN = SITE.origin;
const API = 'https://api.telegram.org';
/** A call Telegram does not answer within this long is given up, so it never holds the alarm or the cron's tick. */
export const TG_TIMEOUT_MS = 5000;
/** Messages a second the dispatcher sends, under Telegram's about 30 a second for one bot. */
export const TG_PER_SECOND = 25;
/** Messages sent at once inside a second (the runtime allows six outgoing connections at once). */
const TG_CONCURRENCY = 5;
/** The characters of a card's text: Telegram takes 4,096 a message, and the field names and the time are added to it. */
export const TG_CARD_ROOM = 3500;

/** Telegram's answer to one call. `migrateTo`: a group Telegram made a supergroup answers with its new id. */
export interface TgAnswer { ok: boolean; status: number; description?: string; retryAfter?: number; migrateTo?: number; result?: any }

/**
 * One Bot API call. The token is in the path only and never logged: a failed call is told by its status and
 * Telegram's own description.
 */
export async function tgCall(token: string, method: string, body: Record<string, unknown>): Promise<TgAnswer> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const j = (await res.json().catch(() => null)) as any;
    return { ok: !!j?.ok, status: res.status, description: typeof j?.description === 'string' ? j.description.slice(0, 200) : undefined, retryAfter: Number(j?.parameters?.retry_after) || undefined, migrateTo: Number(j?.parameters?.migrate_to_chat_id) || undefined, result: j?.result };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ---------------------------------------------------------------- the card as Telegram HTML

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
/**
 * A character the card escaped for Discord (sources/discord.ts textSafe: `\*`, `\_`, `\<`…) is set aside as a private
 * character while the links and code spans are read, so text an outsider wrote can never open one, then shown as itself.
 * A character of that private range the text already held (an outsider's) is replaced first, so unhide never turns it
 * into the markup it stands for after the links were read (own audit 2026-10-29, Low 8).
 */
const hide = (s: string) => s.replace(/[\uE000-\uE07F]/g, '\uFFFD').replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const unhide = (s: string) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
const text = (s: string) => esc(unhide(s));
/** A Discord time stamp in words: the full UTC time, or for a relative one its age ("12 min ago"). */
const stamp = (sec: string, style: string, now: number) => {
  const ms = Number(sec) * 1000;
  if (style !== 'R') return fmtUtcLong(ms);
  const age = fmtAge(now - ms);
  return age === 'now' ? 'moments ago' : `${age} ago`;
};

/**
 * Discord's markdown as the cards write it, in Telegram's HTML: masked links (only https), code spans, bold and time
 * stamps; everything else is text, escaped.
 */
export function mdToHtml(md: string, now = Date.now()): string {
  const t = hide(md).replace(/<t:(\d{1,12}):([a-zA-Z])>/g, (_, sec: string, style: string) => stamp(sec, style, now));
  let out = '';
  let last = 0;
  for (const m of t.matchAll(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|`([^`\n]*)`|\*\*([^*\n]+)\*\*/g)) {
    out += text(t.slice(last, m.index));
    if (m[2]) out += `<a href="${attr(unhide(m[2]))}">${text(m[1])}</a>`;
    else if (m[3] != null) out += `<code>${text(m[3])}</code>`;
    else out += `<b>${text(m[4])}</b>`;
    last = m.index! + m[0].length;
  }
  return out + text(t.slice(last));
}

/** The same markdown as plain text (X posts): a link becomes its words, a code span its content, a time stamp its words. */
export function mdToPlain(md: string, now = Date.now()): string {
  const t = hide(md).replace(/<t:(\d{1,12}):([a-zA-Z])>/g, (_, sec: string, style: string) => stamp(sec, style, now));
  return unhide(t.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, '$1').replace(/`([^`\n]*)`/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1'));
}

/**
 * One fitted embed as a Telegram message: why it reached this chat (the embed's author line) in italics, the title in
 * bold and linked, the text, each figure under its name, then the record and the move's time. Titles, names and the
 * author line are plain text in Discord, so they are escaped as they are.
 */
export function embedHtml(e: Embed, now = Date.now()): string {
  const out: string[] = [];
  if (e.author?.name) out.push(`<i>${esc(e.author.name)}</i>`);
  if (e.title) out.push(e.url ? `<a href="${attr(e.url)}"><b>${esc(e.title)}</b></a>` : `<b>${esc(e.title)}</b>`);
  if (e.description) out.push(mdToHtml(e.description, now));
  if (e.fields.length) out.push(e.fields.map((f) => `<b>${esc(f.name)}</b>\n${mdToHtml(f.value, now)}`).join('\n\n'));
  const foot = [e.footer?.text ? esc(e.footer.text) : '', e.timestamp ? esc(fmtUtcLong(Date.parse(e.timestamp))) : ''].filter(Boolean).join(' · ');
  if (foot) out.push(`<i>${foot}</i>`);
  return out.join('\n\n');
}

/** A message: its HTML, and the button under it (a page of the site). */
export interface TgMessage { html: string; button?: { text: string; url: string } }

/** A card as one Telegram message, fitted to TG_CARD_ROOM; its link becomes the button when it is a page of the site. */
export function cardMessage(card: Card, now = Date.now()): TgMessage {
  const e = fits(card, TG_CARD_ROOM);
  const url = e.url?.startsWith(`${ORIGIN}/`) ? e.url : `${ORIGIN}/alerts`;
  return { html: embedHtml(e, now), button: { text: 'Open on NamadaTrade', url } };
}

/** Sends one message, without a link preview (the card has its own links). */
export const tgSend = (token: string, chat: number | string, m: TgMessage) => tgCall(token, 'sendMessage', {
  chat_id: chat,
  text: m.html,
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
  ...(m.button ? { reply_markup: { inline_keyboard: [[{ text: m.button.text, url: m.button.url }]] } } : {}),
});

// ---------------------------------------------------------------- the subscribers

/** Settings are read at most once per this long per database (a link or a change takes effect within it). */
export const TG_USERS_CACHE_MS = 15_000;
/** kv `alerts.skipped` label for Telegram subscribers a read of the settings did not serve. */
export const TG_UNSERVED_WHAT = 'Telegram subscribers left unread (past the chat cap, or settings that do not open)';
const usersCache = new WeakMap<D1Database, { at: number; users: StoredSettings[] }>();
/** The rows with Telegram on, or null when they could not be read now (never an empty match). */
async function telegramUsers(env: TelegramEnv): Promise<StoredSettings[] | null> {
  const c = usersCache.get(env.DB);
  if (c && Date.now() - c.at < TG_USERS_CACHE_MS) return c.users;
  try {
    const { users, unserved } = await readTelegram(env.DB, env.SETTINGS_KEY);
    usersCache.set(env.DB, { at: Date.now(), users });
    // Rows the read left out are recorded once a read, as Discord's are, so the health view shows them.
    if (unserved) {
      console.warn(`telegram: ${unserved} rows with Telegram on were not served (past the cap, or not opening)`);
      await recordSkipped(env.DB, unserved, TG_UNSERVED_WHAT);
    }
    return users;
  } catch (e) {
    console.error('telegram: the subscribers could not be read', e);
    return null;
  }
}
/** Forgets the cached subscribers (a chat was linked or unlinked here, or a test). */
export const forgetTelegramUsers = (db: D1Database) => usersCache.delete(db);

/** Whether this Worker sends Telegram alerts: it sends alerts (SEND_ALERTS) and has the bot's token. */
export const sendsTelegram = (env: Pick<TelegramEnv, 'TELEGRAM_BOT_TOKEN'>): boolean => alertsOn() && !!env.TELEGRAM_BOT_TOKEN;

/**
 * What one invocation may spend on Telegram: messages left (`left`) and the time they must start by (`until`). Every
 * message is one subrequest of the invocation that already holds Discord's posts and the chain reads (the runtime
 * allows 1,000), and it runs after Discord's alerts, so a slow or busy Telegram never delays them. What does not fit
 * is counted (`skipped`, kv telegram.last) and its claim is never taken or is given back.
 */
export interface TgRun { left: number; until: number; skipped: number; ms: number; deadline: number }
/** A run's share: `sends` messages, which start within `ms` of its first alert and never past `deadline`. */
export const telegramRun = (sends: number, ms: number, deadline = Infinity): TgRun => ({ left: sends, until: NaN, skipped: 0, ms, deadline });
/** Whether the run may start another alert; its time counts from its first. */
const open = (run: TgRun): boolean => {
  if (Number.isNaN(run.until)) run.until = Math.min(Date.now() + run.ms, run.deadline);
  return run.left > 0 && Date.now() <= run.until;
};
/** The live hub's share per alarm or stream batch (Discord's is 520 posts: discord.ts LIVE_ALERT_POSTS). */
export const TG_LIVE_SENDS = 200;
export const TG_LIVE_MS = 20_000;
/** The cron tick's share (Discord's is 600: discord.ts RUN_ALERT_POSTS). */
export const TG_CRON_SENDS = 100;
export const TG_CRON_MS = 15_000;

/** One message to send: the chat (a subscriber's id, or the public channel's name) and whether it is a subscriber's. */
interface TgTarget { chat: number | string; msg: TgMessage; user: boolean }
/** What became of one message: taken, refused by Telegram, not answered or busy (none, 5xx, 429), or not started (the run's share was spent). */
type TgOutcome = 'ok' | 'refused' | 'transient' | 'skipped';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * Whether Telegram's answer says the chat is gone for this bot, or it may not post there: blocked by the person, the bot
 * removed or muted, the chat deleted. A group made a supergroup is not gone (it answers migrate_to_chat_id).
 */
export const chatGone = (a: TgAnswer) => !a.migrateTo && (a.status === 403 || (a.status === 400 && /chat not found|group chat was deactivated|bot was kicked|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN/i.test(a.description ?? '')));
/** An answer that says nothing of the chat: none, a 5xx, or a 429 (Telegram busy or limiting the bot). */
const transient = (a: TgAnswer) => a.status === 0 || a.status >= 500 || a.status === 429;

/**
 * Sends one message, following a group Telegram made a supergroup to its new id (the rows move with it); the answer and
 * the chat it went to.
 */
export async function sendFollowing(env: TelegramEnv, chat: number | string, m: TgMessage): Promise<{ a: TgAnswer; chat: number | string }> {
  let a = await tgSend(env.TELEGRAM_BOT_TOKEN!, chat, m);
  if (!a.ok && a.migrateTo && typeof chat === 'number' && env.SETTINGS_KEY) {
    await moveChat(env.DB, env.SETTINGS_KEY, chat, a.migrateTo).catch((e) => console.error('telegram: a group that moved was not updated', e));
    forgetTelegramUsers(env.DB);
    chat = a.migrateTo;
    a = await tgSend(env.TELEGRAM_BOT_TOKEN!, chat, m);
  }
  return { a, chat };
}

/**
 * Sends the messages at TG_PER_SECOND, TG_CONCURRENCY at a time, while the run has messages and time left (checked
 * before each group, so a Telegram that does not answer holds the run at most one timeout past it). A 429 is sent once
 * more after its Retry-After when that is inside the run's time; a subscriber's chat Telegram says is gone is unlinked
 * (Settings says why). What was sent, failed and left is written to kv `telegram.last`; the answer is each message's
 * outcome, in order.
 */
export async function deliver(env: TelegramEnv, targets: TgTarget[], what: string, run: TgRun): Promise<TgOutcome[]> {
  const out: TgOutcome[] = targets.map(() => 'skipped');
  let sent = 0, failed = 0;
  const one = async (t: TgTarget, i: number) => {
    let { a, chat } = await sendFollowing(env, t.chat, t.msg);
    if (!a.ok && a.status === 429 && a.retryAfter && Date.now() + a.retryAfter * 1000 < run.until) {
      await sleep(a.retryAfter * 1000);
      a = await tgSend(env.TELEGRAM_BOT_TOKEN!, chat, t.msg);
    }
    if (a.ok) { sent++; out[i] = 'ok'; return; }
    failed++;
    out[i] = transient(a) ? 'transient' : 'refused';
    console.error(`telegram: ${what} not taken (${a.status}${a.description ? `: ${a.description}` : ''})`);
    if (t.user && typeof chat === 'number' && chatGone(a) && env.SETTINGS_KEY) {
      await unlinkChat(env.DB, env.SETTINGS_KEY, chat, a.status === 403 && chat > 0 ? 'blocked' : 'removed').catch((e) => console.error('telegram: a gone chat was not unlinked', e));
      forgetTelegramUsers(env.DB);
    }
  };
  let i = 0;
  outer: for (; i < targets.length; i += TG_PER_SECOND) {
    const began = Date.now();
    for (let j = i; j < Math.min(i + TG_PER_SECOND, targets.length); j += TG_CONCURRENCY) {
      if (run.left <= 0 || Date.now() > run.until) { i = j; break outer; }
      const group = targets.slice(j, Math.min(j + TG_CONCURRENCY, i + TG_PER_SECOND, j + run.left));
      run.left -= group.length;
      await Promise.all(group.map((t, k) => one(t, j + k)));
    }
    const wait = 1000 - (Date.now() - began);
    if (i + TG_PER_SECOND < targets.length && wait > 0) await sleep(Math.min(wait, Math.max(0, run.until - Date.now())));
  }
  const skipped = out.filter((o) => o === 'skipped').length;
  run.skipped += skipped;
  await kvSet(env.DB, 'telegram.last', JSON.stringify({ at: Date.now(), what, sent, failed, skipped })).catch(() => {});
  return out;
}

/**
 * Sends a part of an alert under its claim keys (`keys`, already taken): when none of its messages was taken and
 * every one was unanswered, busy or not started (Telegram down, the run's share spent), the keys are given back, so
 * the alert offered again (a catch-up search, the next run) reaches those chats; a message Telegram refused keeps them.
 */
async function sendPart(env: TelegramEnv, targets: TgTarget[], keys: string[], what: string, run: TgRun): Promise<void> {
  if (!targets.length) return;
  const out = await deliver(env, targets, what, run);
  if (out.every((o) => o === 'transient' || o === 'skipped')) await releaseClaims(env.DB, keys);
}

// ---------------------------------------------------------------- the alerts

/** What a move's card says above its title for one subscriber: the watched addresses it touches, or the first rule it matched. */
function matchOf(u: StoredSettings, flow: Flow): Pick<MoveContext, 'rule' | 'watched'> | null {
  const p = u.notifications;
  const watched = p.watchlistOn && p.watchlist.some((w) => w === flow.from || w === flow.to);
  const hits = evaluateFlow(flow, thresholdsOf(p));
  if (!watched && !hits.length) return null;
  const rule = hits.length ? alertRules(thresholdsOf(p)).find((r) => r.id === hits[0].ruleId) : undefined;
  return {
    ...(watched ? { watched: p.watchlist.filter((w) => w === flow.from || w === flow.to) } : {}),
    ...(rule ? { rule: { id: rule.id, title: rule.title, thresholdNam: rule.thresholdNam } } : {}),
  };
}

/**
 * One move's Telegram alerts: every subscriber whose rules or watchlist match it, outside their quiet hours, one
 * message per chat, claimed once (`alert:tg:flow:<id>`) after the subscribers are read, so a failed read costs them
 * nothing (the move offered again reaches them); a bridge crossing's two records reach each chat once (a claim per chat
 * and crossing, as Discord's). The public channel hears no move from here: it takes the hour's move (sendTelegramHour).
 * Nothing is claimed once the run's share is spent. Never throws: a failure is logged, and Discord's alerts are not
 * held by it.
 */
export async function sendTelegramMove(env: TelegramEnv, flow: Flow, run: TgRun = telegramRun(TG_LIVE_SENDS, TG_LIVE_MS)): Promise<void> {
  if (!sendsTelegram(env) || !open(run)) return;
  try {
    const crossing = crossingOf(flow);
    const chatKey = (c: number | string) => (typeof c === 'number' && env.SETTINGS_KEY ? chatDigest(env.SETTINGS_KEY, c) : 'channel');
    const crossKey = (c: number | string) => `alert:tg:ibc:${crossing}:${chatKey(c)}`;
    let read: Awaited<ReturnType<typeof readMoveContext>> | null = null;
    const card = async (why: Pick<MoveContext, 'rule' | 'watched'>) => {
      read ??= await readMoveContext(env.DB, flow);
      return cardMessage(moveCard(read.flow, { ...read.ctx, ...why }));
    };
    // claims a part: its own key, then, for a crossing, the chats no other record of it reached; the chats left and the keys taken
    const claim = async <T extends { chat: number | string }>(key: string, want: T[]): Promise<{ send: T[]; keys: string[] }> => {
      if (!want.length || !(await claimDiscordAlert(env.DB, [key]))) return { send: [], keys: [] };
      if (!crossing) return { send: want, keys: [key] };
      const won = await claimEach(env.DB, want.map((w) => crossKey(w.chat)));
      return { send: want.filter((w) => won.has(crossKey(w.chat))), keys: [key, ...won] };
    };

    const users = await telegramUsers(env);
    if (!users) return;
    const want: { chat: number; why: Pick<MoveContext, 'rule' | 'watched'> }[] = [];
    const seen = new Set<number>();
    for (const u of users) {
      const chat = u.channels.telegram!.chatId!;
      if (seen.has(chat)) continue;
      const why = matchOf(u, flow);
      if (!why || inQuietHours(u.notifications)) continue;
      seen.add(chat);
      want.push({ chat, why });
    }
    if (!want.length || !open(run)) return;
    const { send, keys } = await claim(`alert:tg:flow:${flow.id}`, want);
    if (!send.length) return;
    const targets: TgTarget[] = [];
    for (const w of send) targets.push({ chat: w.chat, user: true, msg: await card(w.why) });
    await sendPart(env, targets, keys, `move ${flow.id}`, run);
  } catch (e) {
    console.error(`telegram: move ${flow.id} not sent`, e);
  }
}

/**
 * A forum post or proposal: the public channel and every forumAndGov subscriber outside quiet hours, each part claimed
 * once (`alert:tg:ch:<key>`, `alert:tg:<key>`). `message(true)` is the channel's message, `message(false)` the
 * subscribers'.
 */
async function sendTelegramCard(env: TelegramEnv, message: (channel: boolean) => TgMessage, key: string, what: string, run: TgRun): Promise<void> {
  if (!sendsTelegram(env) || !open(run)) return;
  try {
    if (env.TELEGRAM_CHANNEL && (await claimDiscordAlert(env.DB, [`alert:tg:ch:${key}`]))) {
      await sendPart(env, [{ chat: env.TELEGRAM_CHANNEL, msg: message(true), user: false }], [`alert:tg:ch:${key}`], `${what} (channel)`, run);
    }
    const msg = message(false);
    const users = await telegramUsers(env);
    if (!users) return;
    const targets: TgTarget[] = [];
    const seen = new Set<number>();
    for (const u of users) {
      const chat = u.channels.telegram!.chatId!;
      if (seen.has(chat) || !u.notifications.forumAndGov || inQuietHours(u.notifications)) continue;
      seen.add(chat);
      targets.push({ chat, msg, user: true });
    }
    if (!targets.length || !open(run) || !(await claimDiscordAlert(env.DB, [`alert:tg:${key}`]))) return;
    await sendPart(env, targets, [`alert:tg:${key}`], what, run);
  } catch (e) {
    console.error(`telegram: ${what} not sent`, e);
  }
}

export const sendTelegramForum = (env: TelegramEnv, post: ForumPost, categoryName: string | null | undefined, run: TgRun) =>
  sendTelegramCard(env, () => forumMessage(post, categoryName), `forum:post:${post.id}`, `forum post ${post.id}`, run);
/** A proposal: the subscribers get its card as Discord's do; the public channel gets what X posts (publicProposal). */
export const sendTelegramGov = (env: TelegramEnv, prop: GovernanceProposal, isNew: boolean, g: GovContext, run: TgRun) =>
  sendTelegramCard(env, (channel) => cardMessage(govCard(channel ? publicProposal(prop) : prop, isNew, g)), `gov:prop:${prop.id}:${prop.status}`, `proposal ${prop.id} ${prop.status}`, run);

const FORUM = 'https://forum.namada.net';
/**
 * A forum post as a Telegram message, for the public channel and the subscribers alike: the topic's category above,
 * the topic's title (and the reply's number), the forum and the post's time below, and a button to the post on the
 * forum, its address built from the post's numbers alone. Nothing else of the post: no excerpt, no author, no link it
 * holds. The title and category are any forum account's words and the forum's, so they are written as plain words
 * (public-posts.ts plainOutsider: no link, no bare domain, no mention) and escaped.
 */
export function forumMessage(post: ForumPost, categoryName?: string | null): TgMessage {
  const n = Number(post.postNumber), topicId = Number(post.topicId);
  const isNew = post.isNewTopic || n === 1;
  const topic = plainOutsider(post.topicTitle, TEXT_MAX.title) || 'a topic with no title';
  const category = categoryName ? plainOutsider(categoryName, TEXT_MAX.category) : '';
  const at = Date.parse(post.createdAt);
  const title = isNew ? `New topic: ${topic}` : Number.isSafeInteger(n) && n > 1 ? `Reply ${n} in: ${topic}` : `A reply in: ${topic}`;
  const when = Number.isFinite(at) ? ` · ${fmtUtcLong(at)}` : '';
  const url = Number.isSafeInteger(topicId) && topicId > 0 ? `${FORUM}/t/${topicId}${Number.isSafeInteger(n) && n > 1 ? `/${n}` : ''}` : FORUM;
  return {
    html: `<i>Forum · ${esc(category || 'forum.namada.net')}</i>\n\n<b>${esc(title)}</b>\n\n<i>NamadaTrade · forum.namada.net${esc(when)}</i>`,
    button: { text: 'Read on forum.namada.net', url },
  };
}

// ---------------------------------------------------------------- the public channel's hour

/**
 * The hour's move (or crossing: `part`) as a Telegram message (the X post's words, public-posts.ts): why it was chosen
 * above, the title, who moved it and the dollars with their source, then the record and the move's time; the button
 * opens the person's page on the site, or the site's moves.
 */
export function hourMessage(m: PublicMove, hour: Pick<PublicHour, 'end'>, passed = false, part: HourPart = 'move'): TgMessage {
  return {
    html: `<i>${esc(publicWhy(hour, passed, part))}</i>\n\n<b>${esc(publicTitle(m))}</b>\n\n${esc(publicWho(m))}. ${esc(publicValue(m))}\n\n<i>NamadaTrade · ${esc(publicRecord(m))} · ${esc(fmtUtcLong(m.ts))}</i>`,
    button: { text: 'Open on NamadaTrade', url: m.person ? sitePage(m.person) : `${ORIGIN}/activity` },
  };
}

/**
 * The cron's tick: the closed hour's move and then its crossing (public-posts.ts publicHour and hourPick, the X
 * account's) to the public channel, each once (`alert:tg:ch:hour:<hour>`, `alert:tg:ch:hour:<hour>:ibc`), under the
 * run's share. A quiet part is claimed and sends nothing; an hour whose moves cannot be read, or whose message Telegram
 * did not answer, is left for the next tick (sendPart gives its claims back). A move is sent once
 * (`alert:tg:ibc:<crossing>:channel` or `alert:tg:ch:flow:<id>`, the keys the live channel posts used), so a
 * crossing's other record gives way to its hour's next move. Never throws.
 */
export async function sendTelegramHour(env: TelegramEnv, hour: PublicHour, run: TgRun): Promise<void> {
  if (!sendsTelegram(env) || !env.TELEGRAM_CHANNEL) return;
  for (const part of ['move', 'ibc'] as const) {
    try {
      const key = `alert:tg:ch:hour:${hour.key}${part === 'ibc' ? ':ibc' : ''}`;
      if ((await claimTaken(env.DB, key)) || !open(run)) continue;
      const posted = (m: PublicMove) => (m.crossing ? `alert:tg:ibc:${m.crossing}:channel` : `alert:tg:ch:flow:${m.id}`);
      const first = await hourPick(env.DB, await hour.moves(), part, posted);
      const keys = [key, ...(first ? [posted(first.move)] : [])];
      if (!(await claimDiscordAlert(env.DB, keys)) || !first) continue;
      await sendPart(env, [{ chat: env.TELEGRAM_CHANNEL, user: false, msg: hourMessage(first.move, hour, first.passed, part) }], keys, `hour ${hour.key}: ${part === 'ibc' ? 'crossing' : 'move'} ${first.move.id} (channel)`, run);
    } catch (e) {
      // the hour's moves not read: its other part would read the same failure
      console.error(`telegram: the hour ${hour.key} (${part}) not sent to the channel`, e);
      return;
    }
  }
}

// ---------------------------------------------------------------- the bot's own messages

/** The rules as saved, as the test message and the connection message list them (sources/discord.ts settingsFields). */
const rulesHtml = (u: StoredSettings) => settingsFields(u).filter((f) => f.name !== 'Daily digest').map((f) => `<b>${esc(f.name)}</b>\n${esc(f.value)}`).join('\n\n');
const settingsButton = { text: 'Change these in Settings', url: `${ORIGIN}/settings#delivery` };

/** What the bot says once a chat is linked: whose alerts arrive, and the rules as saved. */
export function connectedMessage(u: StoredSettings, group: boolean): TgMessage {
  return {
    html: `<b>Connected to NamadaTrade</b>\n\nAlerts for <code>${esc(fmtAddr(u.address))}</code> will arrive in this ${group ? 'group' : 'chat'}, each as one message: ${esc(CARD_WORDS)}.\n\n${rulesHtml(u)}\n\n<i>Send /stop to stop them here. Not investment advice.</i>`,
    button: settingsButton,
  };
}

/** The Settings test: the rules as saved, then the newest move on record that matches them, as its alert (sources/discord.ts testExample). */
export function testMessages(u: StoredSettings, example: TestExample, now = Date.now()): TgMessage[] {
  const first: TgMessage = { html: `<b>Test message from NamadaTrade</b>\n\nThis chat is connected for <code>${esc(fmtAddr(u.address))}</code>.\n\n${rulesHtml(u)}`, button: settingsButton };
  const anyRule = Object.values(u.notifications.rules).some((r) => r?.on);
  if (!anyRule || !example || typeof example !== 'object') return [first];
  const card = moveCard(example.flow, example.ctx);
  return [first, cardMessage({ ...card, embed: { ...card.embed, author: { name: 'Example: the newest move on record that matches these rules' } } }, now)];
}

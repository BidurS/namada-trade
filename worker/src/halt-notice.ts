// The one notice of a halt (shared/halt.ts HALT_NOTICE, owner 2026-11-02: "Pause notifications in discord and x and
// telegram with one notification"). While ALERTS_PAUSED names the halt, every alert is held (sources/discord.ts
// sendsAlerts), and the cron's tick posts this notice once to each place the site's alerts go: the operator's Discord
// channel (DISCORD_WEBHOOK_URL), the X account, and on Telegram the public channel (TELEGRAM_CHANNEL), the operator's
// chat (TELEGRAM_OWNER_CHAT) and every subscriber's chat. It goes around the paused dispatcher on purpose, and only on
// a Worker whose SEND_ALERTS is yes (production), so a copy of the database posts nothing.
//
// Each place is claimed in kv before its post (`halt:<id>:<place>:<try>`, INSERT OR IGNORE, under the tick's lock), and
// its answer is written over the claim. Only an answer that proves the notice was not taken is tried again at the next
// ticks, up to HALT_NOTICE_TRIES claims: on Discord and Telegram a 429, 502 or 503; on X also no answer and any 5xx,
// since X refuses the same text twice. Everything else is final: taken, refused, no answer in time or a 500/504 from
// Discord or Telegram (either may have posted), or a claim never answered (a tick cut off mid-post). So no place hears
// the notice twice. X's kill switch (kv x.on '0') is honoured: X is then left out, and nothing is claimed for it. A
// subscriber's chat inside their quiet hours is left for a later tick, unclaimed. A Telegram chat is named in kv by an
// HMAC under SETTINGS_KEY (as settings.ts chatDigest), so a copy of the database cannot be checked for a chat id;
// without the key no Telegram chat is posted to.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HALT, HALT_NOTICE } from '../../shared/halt';
import { inQuietHours, readTelegram } from './settings';
import { SENDER, WEBHOOK_TIMEOUT_MS } from './sources/discord';
import { tgCall } from './sources/telegram';
import { xPost, xSwitch } from './sources/x';
import type { Env } from './util';

/** Claims a place is given at most: the first try and two more, one tick apart at least. */
export const HALT_NOTICE_TRIES = 3;

type Outcome = { ok: boolean; status: number; at: number; detail?: string };
type Place = { name: string; again: (status: number) => boolean; send: () => Promise<{ ok: boolean; status: number; detail?: string }> };

/** Whether this Worker posts the halt's notice now: it sends alerts in production and its alerts are paused for this halt. */
export const postsHaltNotice = (env: Pick<Env, 'SEND_ALERTS' | 'ALERTS_PAUSED'>): boolean =>
  env.SEND_ALERTS === 'yes' && env.ALERTS_PAUSED === HALT.id;

/** Discord's and Telegram's answers that prove the notice was not taken: tried again. No answer in time may have posted. */
const notTaken = (status: number) => status === 429 || status === 502 || status === 503;
/** X's: no answer and any 5xx too, since X refuses a post whose text it already has. */
const xNotTaken = (status: number) => status === 0 || status === 429 || status >= 500;

/** A Telegram chat's name in kv: an HMAC under the settings secret, so no chat id can be read back from a copy. */
const chatName = (secret: string, chat: string): string =>
  bytesToHex(hmac(sha256, new TextEncoder().encode(secret.trim()), new TextEncoder().encode(`halt-chat:${chat}`))).slice(0, 32);

/** Every place the notice goes on this Worker now, Telegram's chats once each. */
async function places(env: Env, now: number): Promise<Place[]> {
  const out: Place[] = [];
  const hook = env.DISCORD_WEBHOOK_URL;
  if (hook) {
    out.push({
      name: 'discord',
      again: notTaken,
      send: async () => {
        try {
          const res = await fetch(hook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...SENDER, content: HALT_NOTICE, allowed_mentions: { parse: [] } }),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          return { ok: res.ok, status: res.status };
        } catch {
          return { ok: false, status: 0 };
        }
      },
    });
  }
  if (env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET && (await xSwitch(env.DB)) === 'on') {
    out.push({ name: 'x', again: xNotTaken, send: async () => { const a = await xPost(env, HALT_NOTICE); return { ok: a.ok, status: a.status, detail: a.detail }; } });
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.SETTINGS_KEY;
  if (token && !secret) console.error('halt notice: no SETTINGS_KEY, so no Telegram chat is posted to');
  if (token && secret) {
    const chats = new Set<string>();
    if (env.TELEGRAM_CHANNEL?.trim()) chats.add(env.TELEGRAM_CHANNEL.trim());
    if (env.TELEGRAM_OWNER_CHAT?.trim()) chats.add(env.TELEGRAM_OWNER_CHAT.trim());
    // A read of the subscribers that fails leaves their chats out of this tick only: they are offered again at the next.
    const subs = await readTelegram(env.DB, secret).catch((e) => { console.error('halt notice: the Telegram subscribers could not be read', e); return null; });
    const quiet = new Set<string>();
    for (const u of subs?.users ?? []) {
      const chat = u.channels.telegram?.chatId;
      if (chat == null) continue;
      if (inQuietHours(u.notifications, now)) quiet.add(String(chat));
      else chats.add(String(chat));
    }
    // A chat in a subscriber's quiet hours waits, unless another way already names it (the operator's chat, the channel).
    for (const c of quiet) if (!chats.has(c)) console.log('halt notice: a subscriber\'s chat is in its quiet hours; it waits');
    for (const chat of chats) {
      out.push({
        name: `tg:${chatName(secret, chat)}`,
        again: notTaken,
        send: async () => {
          const a = await tgCall(token, 'sendMessage', { chat_id: chat, text: HALT_NOTICE, link_preview_options: { is_disabled: true } });
          return { ok: a.ok, status: a.status, detail: a.description?.slice(0, 120) };
        },
      });
    }
  }
  return out;
}

/** The claims a place has, as stored: each try's outcome, or null for a claim never answered. */
async function triesOf(db: D1Database, prefix: string): Promise<(Outcome | null)[]> {
  const rows = (await db.prepare('SELECT value FROM kv WHERE key >= ?1 AND key < ?2').bind(prefix, `${prefix}~`).all<{ value: string }>()).results ?? [];
  return rows.map((r) => {
    try {
      const v = JSON.parse(r.value);
      return v && typeof v.ok === 'boolean' ? (v as Outcome) : null;
    } catch {
      return null;
    }
  });
}

/**
 * The tick's pass (cron.ts runCron, under the tick's lock): each place not yet done is claimed and posted to. Returns
 * how many places took the notice this pass.
 */
export async function postHaltNotice(env: Env, now = Date.now()): Promise<number> {
  if (!postsHaltNotice(env)) return 0;
  let taken = 0;
  for (const p of await places(env, now)) {
    const prefix = `halt:${HALT.id}:${p.name}:`;
    const tries = await triesOf(env.DB, prefix);
    // Done: taken, refused, an answer that may have posted, claimed and never answered, or out of tries.
    if (tries.some((t) => t == null || t.ok || !p.again(t.status)) || tries.length >= HALT_NOTICE_TRIES) continue;
    const key = `${prefix}${tries.length + 1}`;
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)').bind(key, JSON.stringify({ claimed: now }), now).run();
    if (!claim.meta?.changes) continue;
    const a = await p.send();
    const out: Outcome = { ok: a.ok, status: a.status, at: Date.now(), ...(a.detail ? { detail: a.detail } : {}) };
    await env.DB.prepare('UPDATE kv SET value = ?2, updated_at = ?3 WHERE key = ?1').bind(key, JSON.stringify(out), out.at).run();
    if (a.ok) taken++;
    console.log(`halt notice: ${p.name} ${a.ok ? 'taken' : `not taken (${a.status}${a.detail ? `: ${a.detail}` : ''})`}`);
  }
  return taken;
}

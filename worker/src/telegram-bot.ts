// The Telegram bot (@NamadaTrade_bot, shared/site.ts SITE.telegram): how a chat is linked to a wallet's alerts, and
// what the bot answers.
//
// Linking (in a group, by one of its admins), the only way a chat id reaches a settings row:
// 1. Signed in, the owner presses Connect in Settings: POST /api/me/telegram/link makes a one-time code (kv
//    `tglink:<code>`, LINK_CODE_MS) and answers two links, t.me/<bot>?start=<code> for a private chat and
//    ?startgroup=<code> for a group.
// 2. Telegram opens the bot; pressing Start (or picking a group) sends "/start <code>" to the bot's webhook
//    (POST /api/telegram/webhook, checked against TELEGRAM_WEBHOOK_SECRET, which Telegram sends in a header).
// 3. The code is taken once and the row gets that chat, with sending on; the bot says so in the chat, with the rules
//    as saved. A code that is used, expired or made up links nothing.
// So a chat is linked only by someone who holds both the signed-in wallet and the chat. The chat id is sealed in the
// row with the rest of the settings (settings.ts), and the API never answers it.
//
// Unlinking: Disconnect in Settings; /stop in the chat (in a group, from an admin); the person blocking the bot or the
// bot leaving the group (Telegram's my_chat_member update, or a 403 to an alert: sources/telegram.ts deliver).
import { SITE } from '../../shared/site';
import { fmtAddr } from '../../shared/format';
import { defaultPrefs, loadSettings, rowsOfChat, saveSettings, telegramChatsOther, unlinkChat, writeTelegram, TELEGRAM_CHATS_MAX, type StoredSettings } from './settings';
import { connectedMessage, forgetTelegramUsers, tgCall, tgSend, type TelegramEnv, type TgMessage } from './sources/telegram';

export interface BotEnv extends TelegramEnv { TELEGRAM_WEBHOOK_SECRET?: string }

/** The largest update the webhook reads; Telegram's text is at most 4,096 characters, about 24 KB as JSON escapes. */
export const WEBHOOK_MAX_BYTES = 64 * 1024;
/** A connect link works this long after Settings made it. */
export const LINK_CODE_MS = 15 * 60_000;
/** A code is 18 random bytes, base64url: 24 characters, inside Telegram's 64 for a start parameter. */
const CODE_RE = /^[A-Za-z0-9_-]{24}$/;
const BOT = SITE.telegram.bot;
const SETTINGS = `${SITE.origin}/settings#delivery`;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A new connect code for `address`, replacing any it had (`tglinkby:<address>` names it): the links Settings opens.
 */
export async function createLinkCode(db: D1Database, address: string, now = Date.now()): Promise<{ code: string; expiresAt: number; chat: string; group: string }> {
  const code = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const expiresAt = now + LINK_CODE_MS;
  const old = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(`tglinkby:${address}`).first<{ value: string }>().catch(() => null);
  await db.batch([
    db.prepare('DELETE FROM kv WHERE key = ?').bind(`tglink:${old?.value ?? ''}`),
    db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(`tglink:${code}`, JSON.stringify({ address, expiresAt }), now),
    db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(`tglinkby:${address}`, code, now),
  ]);
  return { code, expiresAt, chat: `https://t.me/${BOT}?start=${code}`, group: `https://t.me/${BOT}?startgroup=${code}` };
}

/** Deletes the address's open connect code (Cancel on the page). */
export async function revokeLinkCode(db: D1Database, address: string): Promise<void> {
  const row = await db.prepare('DELETE FROM kv WHERE key = ? RETURNING value').bind(`tglinkby:${address}`).first<{ value: string }>().catch(() => null);
  if (row?.value) await db.prepare('DELETE FROM kv WHERE key = ?').bind(`tglink:${row.value}`).run().catch(() => {});
}

/** Takes a code once: the address it was made for, or why it links nothing. */
async function takeCode(db: D1Database, code: string, now: number): Promise<{ address: string } | 'unknown' | 'expired'> {
  if (!CODE_RE.test(code)) return 'unknown';
  const row = await db.prepare('DELETE FROM kv WHERE key = ? RETURNING value').bind(`tglink:${code}`).first<{ value: string }>();
  if (!row) return 'unknown';
  let v: { address?: string; expiresAt?: number } = {};
  try { v = JSON.parse(row.value); } catch { return 'unknown'; }
  await db.prepare('DELETE FROM kv WHERE key = ? AND value = ?').bind(`tglinkby:${v.address}`, code).run().catch(() => {});
  if (!v.address) return 'unknown';
  if (!(Number(v.expiresAt) > now)) return 'expired';
  return { address: v.address };
}

const say = (html: string, button?: TgMessage['button']): TgMessage => ({ html, button });
const settingsButton = { text: 'Open Settings', url: SETTINGS };
export const WORDS = {
  hello: say(`<b>NamadaTrade alerts</b>\n\nThis bot sends you NamadaTrade's alerts on NAM: big moves, bridging, unstaking, the shielded pool, governance and the addresses you watch, by the rules you choose.\n\nTo connect, sign in at namada.trade, open Settings, and press <b>Connect Telegram</b>.`, settingsButton),
  groupHello: say(`To send NamadaTrade alerts to this group, a group admin signs in at namada.trade, opens Settings, presses <b>Connect Telegram</b>, then <b>Add to a group</b>.`, settingsButton),
  adminOnlyLink: say(`Only an admin of this group can connect it to NamadaTrade alerts.`),
  moved: say(`NamadaTrade alerts for this wallet now go to another chat, connected in Settings. Send /status to see what still arrives here.`),
  unknown: say(`This connect link does not work: it was used already or is not one of ours. Make a new one in Settings.`, settingsButton),
  expired: say(`This connect link has expired (links work for 15 minutes). Make a new one in Settings.`, settingsButton),
  full: say(`NamadaTrade cannot send alerts to more Telegram chats right now, so this chat was not connected. Please try again later.`),
  rowsFull: say(`NamadaTrade cannot keep alert settings for more wallets right now, so this chat was not connected. Please try again later.`),
  stopped: say(`Stopped: no more NamadaTrade alerts here. To connect again, press Connect in Settings.`, settingsButton),
  notLinked: say(`This chat gets no NamadaTrade alerts. To connect it, press Connect in Settings.`, settingsButton),
  adminOnly: say(`Only an admin of this group can stop its alerts.`),
  busy: say(`This chat could not be connected just now. Make a new link in Settings and try again.`, settingsButton),
  help: say(`<b>Commands</b>\n/status: which wallets' alerts arrive here\n/stop: stop all alerts here\n\nChoose which moves you hear of in Settings.`, settingsButton),
};

/** The chat of an update as the bot uses it: its id, whether it is a group, and a group's name. */
interface Chat { id: number; group: boolean; title: string | null }
const chatOf = (c: any): Chat | null =>
  c && Number.isSafeInteger(c.id) && ['private', 'group', 'supergroup'].includes(c.type)
    ? { id: c.id, group: c.type !== 'private', title: c.type !== 'private' && typeof c.title === 'string' ? c.title.slice(0, 128) : null }
    : null;

/**
 * Links `chat` to the wallet a code names: the reply the bot sends. The site's chat cap is checked before the code is
 * taken, so a full site spends no code. A wallet with a row gets the chat by writeTelegram, which writes only over the
 * row as read (a Settings save made meanwhile is read again, up to three times); a wallet without one gets a new row.
 * The chat the wallet had before is told its alerts moved.
 */
async function link(env: BotEnv, chat: Chat, code: string, now: number): Promise<TgMessage> {
  const key = env.SETTINGS_KEY!;
  if ((await telegramChatsOther(env.DB, key, chat.id)) >= TELEGRAM_CHATS_MAX) return WORDS.full;
  const taken = await takeCode(env.DB, code, now);
  if (taken === 'unknown') return WORDS.unknown;
  if (taken === 'expired') return WORDS.expired;
  const linked = { enabled: true, chatId: chat.id, kind: chat.group ? 'group' as const : 'private' as const, title: chat.title, linkedAt: now };
  for (let i = 0; i < 3; i++) {
    const cur = await loadSettings(env.DB, key, taken.address);
    if (!cur) {
      const s: StoredSettings = { address: taken.address, notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null }, telegram: linked }, createdAt: now, updatedAt: now };
      if (!(await saveSettings(env.DB, key, s))) return WORDS.rowsFull;
      forgetTelegramUsers(env.DB);
      return connectedMessage(s, chat.group);
    }
    const before = cur.channels.telegram?.chatId;
    if (await writeTelegram(env.DB, key, cur, () => linked)) {
      forgetTelegramUsers(env.DB);
      if (before != null && before !== chat.id) await tgSend(env.TELEGRAM_BOT_TOKEN!, before, WORDS.moved).catch(() => {});
      return connectedMessage({ ...cur, channels: { ...cur.channels, telegram: linked } }, chat.group);
    }
  }
  return WORDS.busy;
}

/**
 * Whether the sender of message `m` is an admin of group `chatId`, as Telegram says now. An admin posting anonymously
 * sends as the group itself (`sender_chat`), which only an admin can.
 */
async function isAdmin(env: BotEnv, chatId: number, m: any): Promise<boolean> {
  if (m?.sender_chat?.id === chatId) return true;
  const userId = m?.from?.id;
  if (!Number.isSafeInteger(userId)) return false;
  const a = await tgCall(env.TELEGRAM_BOT_TOKEN!, 'getChatMember', { chat_id: chatId, user_id: userId });
  return a.ok && ['creator', 'administrator'].includes(a.result?.status);
}

/** Which wallets' alerts arrive in `chat`. */
async function status(env: BotEnv, chat: Chat): Promise<TgMessage> {
  const rows = await rowsOfChat(env.DB, env.SETTINGS_KEY!, chat.id);
  if (!rows.length) return WORDS.notLinked;
  // In a group, every member reads the answer: the count only, no wallet.
  if (chat.group) return say(`This group gets NamadaTrade alerts for ${rows.length === 1 ? 'one wallet' : `${rows.length} wallets`}.`, settingsButton);
  const lines = rows.map((s) => `<code>${fmtAddr(s.address)}</code>: sending ${s.channels.telegram?.enabled ? 'on' : 'paused in Settings'}`);
  return say(`Alerts here are for:\n${lines.join('\n')}`, settingsButton);
}

/**
 * One update from Telegram. Answers commands only (in a group, those addressed to the bot or its own start), and
 * unlinks a chat whose member status says the bot was blocked or removed. Errors are logged; the webhook always
 * answers 200, so Telegram never repeats an update.
 */
export async function handleUpdate(env: BotEnv, u: any, now = Date.now()): Promise<void> {
  const key = env.SETTINGS_KEY;
  if (!key || !env.TELEGRAM_BOT_TOKEN) return;
  const member = u?.my_chat_member;
  if (member) {
    const chat = chatOf(member.chat);
    if (chat && ['left', 'kicked'].includes(member.new_chat_member?.status)) {
      await unlinkChat(env.DB, key, chat.id, chat.group ? 'removed' : 'blocked', now);
      forgetTelegramUsers(env.DB);
    }
    return;
  }
  const m = u?.message;
  const chat = chatOf(m?.chat);
  if (!chat || typeof m.text !== 'string') return;
  const cmd = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(\S+))?/.exec(m.text.trim());
  if (cmd?.[2] && cmd[2].toLowerCase() !== BOT.toLowerCase()) return;
  if (!cmd) { if (!chat.group) await tgSend(env.TELEGRAM_BOT_TOKEN, chat.id, WORDS.help); return; }
  // In a group, a command not addressed to the bot may be another bot's: only the bot's own are answered.
  if (chat.group && !cmd[2] && !['start', 'stop', 'status'].includes(cmd[1])) return;
  let reply: TgMessage;
  switch (cmd[1]) {
    case 'start':
      reply = !cmd[3] ? (chat.group ? WORDS.groupHello : WORDS.hello)
        : chat.group && !(await isAdmin(env, chat.id, m)) ? WORDS.adminOnlyLink
        : await link(env, chat, cmd[3], now);
      break;
    case 'stop':
      if (chat.group && !(await isAdmin(env, chat.id, m))) { reply = WORDS.adminOnly; break; }
      reply = (await unlinkChat(env.DB, key, chat.id, 'stop', now)) ? WORDS.stopped : WORDS.notLinked;
      forgetTelegramUsers(env.DB);
      break;
    case 'status':
      reply = await status(env, chat);
      break;
    default:
      reply = WORDS.help;
  }
  await tgSend(env.TELEGRAM_BOT_TOKEN, chat.id, reply);
}

/** Constant-time comparison of the webhook's secret header. */
export function secretMatches(given: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !given || given.length !== secret.length) return false;
  let d = 0;
  for (let i = 0; i < secret.length; i++) d |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return d === 0;
}

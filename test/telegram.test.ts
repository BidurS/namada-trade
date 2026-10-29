// Telegram alerts (worker/src/telegram-bot.ts, sources/telegram.ts, settings.ts): a chat is linked only by the bot's
// handshake (a one-time code Settings made, sent back by Telegram when Start is pressed), never by the page; the chat id
// never leaves the server; the alerts follow the row's own rules, watchlist and quiet hours, once per move; a chat
// Telegram says is gone, or that sent /stop, is unlinked and Settings says why; and Discord's card is written as
// Telegram's HTML with text an outsider wrote kept as text. Fetch is stubbed: nothing reaches Telegram.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, type TestD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { createSession, sweepAuth, tokenHash, type Session } from '../worker/src/auth';
import { applyUpdate, chatDigest, defaultPrefs, loadSettings, readTelegram, rowsOfChat, saveSettings, stopChannelStmt, TELEGRAM_CHATS_MAX, TELEGRAM_FULL, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, moveCard } from '../worker/src/sources/discord';
import { cardMessage, embedHtml, forgetTelegramUsers, mdToHtml, sendTelegramMove, telegramRun, TG_UNSERVED_WHAT } from '../worker/src/sources/telegram';
import { LINK_CODE_MS, linkKey, secretMatches } from '../worker/src/telegram-bot';
import { rowToFlow } from '../worker/src/analytics';
import type { Flow } from '../shared/types';

const KEY = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0=';
const TOKEN = '123:test-token';
const SECRET = 'S'.repeat(40);
const WATCHED = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';
const CHAT = 5550001;
const GROUP = -1005550002;
const addr = (i: number) => `tnam1qtelegram${String(i).padStart(5, '0')}${'q'.repeat(28)}`;
let t = 0;

/** Telegram as a stub: `answer` decides each call's answer by method and chat; every call is kept. */
/** Telegram's usual answers: a message taken, and the sender an admin of any group. */
const fine = (method: string) => ({ json: { ok: true, result: method === 'getChatMember' ? { status: 'administrator' } : {} } });
function telegram(answer: (method: string, body: any) => { status?: number; json: any } = fine) {
  const calls: { method: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    const url = String(u);
    const method = url.split('/').pop()!;
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    const a = answer(method, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
  return { calls, sent: (chat: number | string) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chat) };
}

const env = (db: TestD1, extra: Record<string, unknown> = {}) =>
  ({ DB: db, SETTINGS_KEY: KEY, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, ...extra }) as any;
const signIn = async (db: TestD1, address: string) => (await createSession(db as any, address, 'namada', 'namada')) as Session;
const authed = (s: Session, extra: RequestInit = {}) => ({ ...extra, headers: { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' } });
const getSettings = async (db: TestD1, s: Session) => ((await (await app.request('/api/me/settings', authed(s), env(db))).json()) as any).settings;
const linkCode = async (db: TestD1, s: Session) => {
  const r = await app.request('/api/me/telegram/link', authed(s, { method: 'POST', body: '{}' }), env(db));
  expect(r.status).toBe(200);
  const j = (await r.json()) as any;
  return { ...j, code: new URL(j.chat).searchParams.get('start')! };
};
const update = (db: TestD1, body: unknown, secret: string | null = SECRET) =>
  app.request('/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: JSON.stringify(body) }, env(db));
const start = (db: TestD1, code: string, chat = CHAT, group = false) =>
  update(db, { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: group ? { id: chat, type: 'supergroup', title: 'NAM desk' } : { id: chat, type: 'private' }, text: group ? `/start@NamadaTrade_bot ${code}` : `/start ${code}` } });
const watchOnly = { rules: { big_swap: { on: false }, ibc_inventory: { on: false }, unlock: { on: false }, unshield: { on: false }, bond: { on: false } }, watchlist: [WATCHED], watchlistOn: true, forumAndGov: false };
const moveFromWatched = (n: number): Flow => ({ id: `osmosis:TGQ${n}:0`, chain: 'osmosis', height: n, ts: t, txHash: `TGQ${n}`, kind: 'sell', from: WATCHED, to: null, amount: 500, meta: null }) as unknown as Flow;

beforeEach(() => {
  t = Date.UTC(2026, 9, 28, 9);
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  configureAlerts(KEY, true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('linking a chat', () => {
  it('links the chat where Start is pressed, says so there, and never answers the chat id', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await signIn(db, addr(1));
    const l = await linkCode(db, s);
    expect(l.chat).toMatch(/^https:\/\/t\.me\/NamadaTrade_bot\?start=[A-Za-z0-9_-]{24}$/);
    expect(l.group).toBe(l.chat.replace('?start=', '?startgroup='));
    expect((await start(db, l.code)).status).toBe(200);
    const view = await getSettings(db, s);
    expect(view.channels.telegram).toMatchObject({ linked: true, enabled: true, kind: 'private', title: null });
    expect(JSON.stringify(view)).not.toContain(String(CHAT));
    const said = tg.sent(CHAT);
    expect(said).toHaveLength(1);
    expect(said[0].body.text).toContain('Connected to NamadaTrade');
    expect(said[0].body.parse_mode).toBe('HTML');
    // the export does not carry it either
    const ex = await (await app.request('/api/me/export', authed(s), env(db))).text();
    expect(ex).not.toContain(String(CHAT));
  });

  it('a code links once, a made-up or expired code links nothing', async () => {
    const db = testD1();
    const tg = telegram();
    const a = await signIn(db, addr(2));
    const l = await linkCode(db, a);
    await start(db, l.code);
    await start(db, l.code, CHAT + 1);
    expect(tg.sent(CHAT + 1)[0].body.text).toContain('does not work');
    await start(db, 'A'.repeat(24), CHAT + 2);
    expect(tg.sent(CHAT + 2)[0].body.text).toContain('does not work');
    const l2 = await linkCode(db, a);
    t += LINK_CODE_MS + 1;
    await start(db, l2.code, CHAT + 3);
    expect(tg.sent(CHAT + 3)[0].body.text).toContain('expired');
    expect((await loadSettings(db as any, KEY, addr(2)))!.channels.telegram!.chatId).toBe(CHAT);
  });

  it('a new code replaces the address\'s earlier one, and the sweep deletes old codes', async () => {
    const db = testD1();
    const tg = telegram();
    const a = await signIn(db, addr(3));
    const first = await linkCode(db, a);
    await linkCode(db, a);
    await start(db, first.code, CHAT + 4);
    expect(tg.sent(CHAT + 4)[0].body.text).toContain('does not work');
    t += 2 * 3_600_000;
    await sweepAuth(db as any);
    const left = await db.prepare("SELECT COUNT(*) n FROM kv WHERE key >= 'tglink' AND key < 'tglinl'").first<{ n: number }>();
    expect(Number(left!.n)).toBe(0);
  });

  it('links a group from its startgroup command, with its name', async () => {
    const db = testD1();
    telegram();
    const s = await signIn(db, addr(4));
    const l = await linkCode(db, s);
    await start(db, l.code, GROUP, true);
    expect((await getSettings(db, s)).channels.telegram).toMatchObject({ linked: true, kind: 'group', title: 'NAM desk' });
  });

  it('the webhook answers 404 to a wrong or missing secret, and links nothing', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await signIn(db, addr(5));
    const l = await linkCode(db, s);
    expect((await update(db, { message: { chat: { id: CHAT, type: 'private' }, text: `/start ${l.code}` } }, null)).status).toBe(404);
    expect((await update(db, { message: { chat: { id: CHAT, type: 'private' }, text: `/start ${l.code}` } }, 'x'.repeat(40))).status).toBe(404);
    expect(tg.calls).toHaveLength(0);
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(false);
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET.slice(1), SECRET)).toBe(false);
    expect(secretMatches(SECRET, undefined)).toBe(false);
  });

  it('the page can switch sending and disconnect, but never set a chat', () => {
    const s: StoredSettings = { address: addr(6), notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 1, updatedAt: 1 };
    expect(applyUpdate(s, { channels: { telegram: { enabled: true } } })).toBe('connect a Telegram chat first');
    const forged = applyUpdate(s, { channels: { telegram: { chatId: CHAT, enabled: false } } }) as StoredSettings;
    expect(forged.channels.telegram?.chatId ?? null).toBeNull();
    const linked = { ...s, channels: { ...s.channels, telegram: { enabled: true, chatId: CHAT, kind: 'private' as const, title: null, linkedAt: 1 } } };
    expect((applyUpdate(linked, { channels: { telegram: { enabled: false } } }) as StoredSettings).channels.telegram).toMatchObject({ enabled: false, chatId: CHAT });
    expect((applyUpdate(linked, { channels: { telegram: { disconnect: true } } }) as StoredSettings).channels.telegram!.chatId).toBeNull();
  });
});

describe('sending', () => {
  async function linked(db: TestD1, i: number, chat: number, prefs: object = watchOnly) {
    const s = await signIn(db, addr(i));
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ notifications: prefs }) }), env(db));
    const l = await linkCode(db, s);
    await start(db, l.code, chat);
    forgetTelegramUsers(db as any);
    return s;
  }

  it('sends a matching move once, by the row\'s own rules, with a button back to the site', async () => {
    const db = testD1();
    const tg = telegram();
    await linked(db, 10, CHAT);
    const other = await linked(db, 11, CHAT + 10, { ...watchOnly, watchlist: [], watchlistOn: false });
    void other;
    const f = moveFromWatched(1);
    await sendTelegramMove(env(db), f);
    await sendTelegramMove(env(db), f);
    const msgs = tg.sent(CHAT).filter((c) => !c.body.text.includes('Connected'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body.text).toContain('Watchlist');
    expect(msgs[0].body.reply_markup.inline_keyboard[0][0].url).toMatch(/^https:\/\/namada\.trade\//);
    expect(msgs[0].body.link_preview_options).toEqual({ is_disabled: true });
    expect(tg.sent(CHAT + 10).filter((c) => !c.body.text.includes('Connected'))).toHaveLength(0);
  });

  it('sends nothing in quiet hours, or with sending paused, or from a Worker that sends no alerts', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await linked(db, 12, CHAT, { ...watchOnly, quietHoursUtc: { start: 8, end: 10 } });
    await sendTelegramMove(env(db), moveFromWatched(2));
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ notifications: { quietHoursUtc: null }, channels: { telegram: { enabled: false } } }) }), env(db));
    await sendTelegramMove(env(db), moveFromWatched(3));
    expect((await readTelegram(db as any, KEY)).users).toHaveLength(0);
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ channels: { telegram: { enabled: true } } }) }), env(db));
    configureAlerts(KEY, false);
    await sendTelegramMove(env(db), moveFromWatched(4));
    expect(tg.sent(CHAT).filter((c) => !c.body.text.includes('Connected'))).toHaveLength(0);
  });

  it('a chat that blocked the bot is unlinked at the first alert, and Settings says why', async () => {
    const db = testD1();
    const s = await linked(db, 13, CHAT);
    const tg = telegram((m) => (m === 'sendMessage' ? { status: 403, json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } } : fine(m)));
    await sendTelegramMove(env(db), moveFromWatched(5));
    expect(tg.sent(CHAT)).toHaveLength(1);
    const view = (await getSettings(db, s)).channels.telegram;
    expect(view).toMatchObject({ linked: false, enabled: false, stopped: { reason: 'blocked' } });
    forgetTelegramUsers(db as any);
    await sendTelegramMove(env(db), moveFromWatched(6));
    expect(tg.sent(CHAT)).toHaveLength(1);
  });

  it('a group Telegram made a supergroup moves to its new id', async () => {
    const db = testD1();
    await linked(db, 14, GROUP);
    const NEW = -1009990001;
    const tg = telegram((m, b) => (m === 'sendMessage' && b.chat_id === GROUP ? { status: 400, json: { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: NEW } } } : fine(m)));
    await sendTelegramMove(env(db), moveFromWatched(7));
    expect(tg.sent(NEW)).toHaveLength(1);
    expect((await loadSettings(db as any, KEY, addr(14)))!.channels.telegram!.chatId).toBe(NEW);
  });

  it('/stop unlinks the chat; in a group only from an admin; leaving the group unlinks it too', async () => {
    const db = testD1();
    telegram();
    const s = await linked(db, 15, CHAT);
    await update(db, { message: { chat: { id: CHAT, type: 'private' }, from: { id: 42 }, text: '/stop' } });
    expect((await getSettings(db, s)).channels.telegram).toMatchObject({ linked: false, stopped: { reason: 'stop' } });

    const g = await signIn(db, addr(16));
    const l = await linkCode(db, g);
    await start(db, l.code, GROUP, true);
    const tg = telegram((m) => (m === 'getChatMember' ? { json: { ok: true, result: { status: 'member' } } } : fine(m)));
    await update(db, { message: { chat: { id: GROUP, type: 'supergroup', title: 'NAM desk' }, from: { id: 7 }, text: '/stop@NamadaTrade_bot' } });
    expect(tg.sent(GROUP)[0].body.text).toContain('Only an admin');
    expect((await getSettings(db, g)).channels.telegram.linked).toBe(true);
    // another bot's command in the group is not answered
    await update(db, { message: { chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/stop@SomeOtherBot' } });
    expect(tg.sent(GROUP)).toHaveLength(1);
    await update(db, { my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'NAM desk' }, new_chat_member: { status: 'left' } } });
    expect((await getSettings(db, g)).channels.telegram).toMatchObject({ linked: false, stopped: { reason: 'removed' } });
  });

  it('the test message goes to the linked chat, once per 30 s', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await linked(db, 17, CHAT);
    const first = await app.request('/api/me/telegram/test', authed(s, { method: 'POST', body: '{}' }), env(db));
    expect(await first.json()).toEqual({ success: true });
    expect(tg.sent(CHAT).some((c) => c.body.text.includes('Test message'))).toBe(true);
    expect((await app.request('/api/me/telegram/test', authed(s, { method: 'POST', body: '{}' }), env(db))).status).toBe(429);
  });

  it('a server that sends no Telegram makes no connect link', async () => {
    const db = testD1();
    const s = await signIn(db, addr(18));
    const r = await app.request('/api/me/telegram/link', authed(s, { method: 'POST', body: '{}' }), env(db, { TELEGRAM_BOT_TOKEN: undefined }));
    expect(r.status).toBe(503);
  });

  it('a saved row keeps its chat through a Discord-only save', async () => {
    const db = testD1();
    telegram();
    const s = await linked(db, 19, CHAT);
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ notifications: { forumAndGov: true } }) }), env(db));
    const row = (await loadSettings(db as any, KEY, addr(19)))!;
    expect(row.channels.telegram!.chatId).toBe(CHAT);
    expect(await saveSettings(db as any, KEY, row)).toBe(true);
    expect((await readTelegram(db as any, KEY)).users.map((u) => u.address)).toEqual([addr(19)]);
  });
});

describe('review fixes', () => {
  async function linked(db: TestD1, i: number, chat: number, prefs: object = watchOnly) {
    const s = await signIn(db, addr(i));
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ notifications: prefs }) }), env(db));
    const l = await linkCode(db, s);
    await start(db, l.code, chat, chat < 0);
    forgetTelegramUsers(db as any);
    return s;
  }
  const others = (tg: ReturnType<typeof telegram>, chat: number) => tg.sent(chat).filter((c) => !c.body.text.includes('Connected'));

  it('only a group admin can link a group; an anonymous admin can stop it', async () => {
    const db = testD1();
    const tg = telegram((m) => (m === 'getChatMember' ? { json: { ok: true, result: { status: 'member' } } } : fine(m)));
    const s = await signIn(db, addr(30));
    const l = await linkCode(db, s);
    await start(db, l.code, GROUP, true);
    expect(tg.sent(GROUP)[0].body.text).toContain('Only an admin');
    expect(tg.sent(GROUP)[0].body.text).toContain('no longer works');
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(false);
    // the code was sent where the group's members may read it: it is spent, so none of them can link it elsewhere
    await start(db, l.code, CHAT + 60);
    expect(tg.sent(CHAT + 60)[0].body.text).toContain('does not work');
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(false);
    telegram();
    const l2 = await linkCode(db, s);
    await start(db, l2.code, GROUP, true);
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(true);
    telegram((m) => (m === 'getChatMember' ? { json: { ok: true, result: { status: 'member' } } } : fine(m)));
    await update(db, { message: { chat: { id: GROUP, type: 'supergroup' }, from: { id: 1087968824 }, sender_chat: { id: GROUP, type: 'supergroup' }, text: '/stop@NamadaTrade_bot' } });
    expect((await getSettings(db, s)).channels.telegram).toMatchObject({ linked: false, stopped: { reason: 'stop' } });
  });

  it('a group\'s /status names no wallet', async () => {
    const db = testD1();
    const tg = telegram();
    await linked(db, 31, GROUP);
    await update(db, { message: { chat: { id: GROUP, type: 'supergroup' }, from: { id: 7 }, text: '/status@NamadaTrade_bot' } });
    const said = tg.sent(GROUP).at(-1)!.body.text;
    expect(said).toContain('one wallet');
    expect(said).not.toContain('tnam1');
  });

  it('Telegram down: the claim is given back, so the move offered again reaches the chat', async () => {
    const db = testD1();
    telegram();
    await linked(db, 32, CHAT);
    let down = true;
    const tg = telegram((m) => (m === 'sendMessage' && down ? { status: 502, json: { ok: false, description: 'Bad Gateway' } } : fine(m)));
    const f = moveFromWatched(40);
    await sendTelegramMove(env(db), f);
    down = false;
    await sendTelegramMove(env(db), f);
    await sendTelegramMove(env(db), f);
    expect(tg.sent(CHAT).filter((c) => c.body.text.includes('Watchlist'))).toHaveLength(2);
    expect(others(tg, CHAT).length).toBe(2);
  });

  it('a run whose share is spent claims nothing, and the next run sends it', async () => {
    const db = testD1();
    telegram();
    await linked(db, 33, CHAT);
    const tg = telegram();
    const f = moveFromWatched(41);
    await sendTelegramMove(env(db), f, 10000, telegramRun(0, 10_000));
    expect(others(tg, CHAT)).toHaveLength(0);
    await sendTelegramMove(env(db), f, 10000, telegramRun(10, 10_000));
    expect(others(tg, CHAT)).toHaveLength(1);
  });

  it('the public channel and the subscribers are claimed apart: a failed read of the subscribers costs them nothing', async () => {
    const db = testD1();
    telegram();
    await linked(db, 34, CHAT);
    const tg = telegram();
    const big: Flow = { ...moveFromWatched(42), from: 'osmo1someoneelsexxxxxxxxxxxxxxxxxxxxxxxxxxxxx', amount: 50_000 } as Flow;
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("'$.tg') = 1")) throw new Error('D1 down');
      return prepare(sql);
    });
    const e = env(db, { TELEGRAM_CHANNEL: '@NamadaTradeAlerts' });
    forgetTelegramUsers(db as any);
    await sendTelegramMove(e, { ...big, from: WATCHED } as Flow);
    expect(tg.sent('@NamadaTradeAlerts')).toHaveLength(1);
    expect(others(tg, CHAT)).toHaveLength(0);
    spy.mockRestore();
    forgetTelegramUsers(db as any);
    await sendTelegramMove(e, { ...big, from: WATCHED } as Flow);
    expect(tg.sent('@NamadaTradeAlerts')).toHaveLength(1);
    expect(others(tg, CHAT)).toHaveLength(1);
  });

  it('a Settings save does not put back a chat the bot unlinked while it ran, and a stale Discord stop cannot relink it', async () => {
    const db = testD1();
    telegram();
    const s = await linked(db, 35, CHAT);
    const stale = (await loadSettings(db as any, KEY, addr(35)))!;
    await update(db, { message: { chat: { id: CHAT, type: 'private' }, from: { id: 42 }, text: '/stop' } });
    // a save that does not touch Telegram keeps the unlink
    await app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify({ notifications: { forumAndGov: true } }) }), env(db));
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(false);
    // the Discord dispatcher's copy read before the unlink cannot be written over it
    const stmt = await stopChannelStmt(db as any, KEY, stale, 404, Date.now());
    expect(Number((await stmt.run()).meta?.changes ?? 0)).toBe(0);
    expect((await loadSettings(db as any, KEY, addr(35)))!.channels.telegram!.chatId).toBeNull();
  });

  it('relinking a wallet to another chat tells the old one; a full site spends no code; Cancel revokes the link', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await linked(db, 36, CHAT);
    const l = await linkCode(db, s);
    await start(db, l.code, CHAT + 50);
    expect(tg.sent(CHAT).at(-1)!.body.text).toContain('now go to another chat');
    const l2 = await linkCode(db, s);
    expect((await app.request('/api/me/telegram/link', authed(s, { method: 'DELETE' }), env(db))).status).toBe(200);
    await start(db, l2.code, CHAT + 51);
    expect(tg.sent(CHAT + 51)[0].body.text).toContain('does not work');
  });

  it('the test message follows a group Telegram made a supergroup instead of disconnecting it', async () => {
    const db = testD1();
    telegram();
    const s = await linked(db, 37, GROUP);
    const NEW = -1009990002;
    const tg = telegram((m, b) => (m === 'sendMessage' && b.chat_id === GROUP ? { status: 400, json: { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: NEW } } } : fine(m)));
    const r = await app.request('/api/me/telegram/test', authed(s, { method: 'POST', body: '{}' }), env(db));
    expect(await r.json()).toEqual({ success: true });
    expect(tg.sent(NEW).length).toBeGreaterThan(0);
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(true);
  });

  it('a long update is read, not refused', async () => {
    const db = testD1();
    const tg = telegram();
    const r = await update(db, { message: { chat: { id: CHAT, type: 'private' }, text: 'ж'.repeat(4096).replace(/ж/g, '\\u0436') } });
    expect(r.status).toBe(200);
    expect(tg.sent(CHAT)).toHaveLength(1);
  });
});

// External audit (2026-10-29), as verified: a connect code is spent by a refusal in a group, kept as an HMAC and bound
// to the session that made it; the rows of a chat are read on an index; a resumed chat takes a place under the chat
// cap; and a /stop is not undone by a Settings save that ran beside it.
describe('external audit fixes', () => {
  async function linked(db: TestD1, i: number, chat: number) {
    const s = await signIn(db, addr(i));
    const l = await linkCode(db, s);
    await start(db, l.code, chat, chat < 0);
    forgetTelegramUsers(db as any);
    return s;
  }
  /** `n` rows of other wallets with Telegram on, each its own chat, as the site's chat cap counts them. */
  const otherChats = (db: TestD1, n: number, from = 0) => {
    const ins = db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    for (let i = from; i < from + n; i++) ins.run(`user:tnam1qother${String(i).padStart(4, '0')}`, JSON.stringify({ tg: true, tgc: `other${i}` }), 1);
  };
  const dropOtherChats = (db: TestD1, n: number) => db.raw.prepare("DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key >= 'user:tnam1qother' AND key < 'user:tnam1qothes' LIMIT ?)").run(n);
  const put = (db: TestD1, s: Session, body: object) => app.request('/api/me/settings', authed(s, { method: 'PUT', body: JSON.stringify(body) }), env(db));
  const codeRows = (db: TestD1) => db.raw.prepare("SELECT key, value FROM kv WHERE key >= 'tglink' AND key < 'tglinl'").all() as { key: string; value: string }[];

  it('a full site spends no code sent in a private chat, but spends one sent in a group', async () => {
    const db = testD1();
    const tg = telegram();
    otherChats(db, TELEGRAM_CHATS_MAX);
    const s = await signIn(db, addr(50));
    const l = await linkCode(db, s);
    await start(db, l.code, CHAT);
    expect(tg.sent(CHAT)[0].body.text).toContain('cannot send alerts to more Telegram chats');
    dropOtherChats(db, 1);
    await start(db, l.code, CHAT);
    expect((await getSettings(db, s)).channels.telegram).toMatchObject({ linked: true, kind: 'private' });
    otherChats(db, 1, TELEGRAM_CHATS_MAX);
    const l2 = await linkCode(db, s);
    await start(db, l2.code, GROUP, true);
    expect(tg.sent(GROUP)[0].body.text).toContain('no longer works');
    dropOtherChats(db, 5);
    await start(db, l2.code, CHAT + 61);
    expect(tg.sent(CHAT + 61)[0].body.text).toContain('does not work');
    expect((await getSettings(db, s)).channels.telegram).toMatchObject({ linked: true, kind: 'private' });
  });

  it('a code is stored as an HMAC under the secret, never as itself, and names the session that made it', async () => {
    const db = testD1();
    telegram();
    const s = await signIn(db, addr(51));
    const l = await linkCode(db, s);
    const rows = db.raw.prepare('SELECT key, value FROM kv').all() as { key: string; value: string }[];
    expect(rows.filter((r) => r.key.includes(l.code) || r.value.includes(l.code))).toEqual([]);
    const row = rows.find((r) => r.key === linkKey(KEY, l.code))!;
    expect(JSON.parse(row.value)).toMatchObject({ address: addr(51), by: tokenHash(s.token) });
    expect(rows.find((r) => r.key === `tglinkby:${addr(51)}`)!.value).toBe(linkKey(KEY, l.code).slice('tglink:'.length));
    await start(db, l.code);
    expect((await getSettings(db, s)).channels.telegram.linked).toBe(true);
    expect(codeRows(db)).toEqual([]);
  });

  it('signing out, revoking the key that made a code or deleting the account ends its code; an API key\'s code links', async () => {
    const db = testD1();
    const tg = telegram();
    const s = await signIn(db, addr(52));
    const out = await linkCode(db, s);
    await app.request('/api/auth/logout', authed(s, { method: 'POST', body: '{}' }), env(db));
    expect(codeRows(db).filter((r) => r.key.startsWith('tglink:'))).toEqual([]);
    await start(db, out.code, CHAT + 70);
    expect(tg.sent(CHAT + 70)[0].body.text).toContain('does not work');

    const device = await signIn(db, addr(52));
    const key = (await createSession(db as any, addr(52), 'namada', 'api', null, tokenHash(device.token))) as Session;
    const byKey = await linkCode(db, key);
    expect((await app.request(`/api/me/sessions/${tokenHash(key.token).slice(0, 8)}`, authed(device, { method: 'DELETE' }), env(db))).status).toBe(200);
    await start(db, byKey.code, CHAT + 71);
    expect(tg.sent(CHAT + 71)[0].body.text).toContain('does not work');
    // a code whose maker was ended while it was being made (its row outlived the revoke) links nothing either
    const key2 = (await createSession(db as any, addr(52), 'namada', 'api', null, tokenHash(device.token))) as Session;
    const late = await linkCode(db, key2);
    db.raw.prepare('DELETE FROM kv WHERE key = ?').run(`session:${tokenHash(key2.token)}`);
    await start(db, late.code, CHAT + 72);
    expect(tg.sent(CHAT + 72)[0].body.text).toContain('was signed out');
    expect((await getSettings(db, device)).channels.telegram.linked).toBe(false);
    // a live API key's code links (an API key may connect a chat)
    const key3 = (await createSession(db as any, addr(52), 'namada', 'api', null, tokenHash(device.token))) as Session;
    await start(db, (await linkCode(db, key3)).code, CHAT + 73);
    expect((await getSettings(db, device)).channels.telegram).toMatchObject({ linked: true, enabled: true });

    await linkCode(db, device);
    expect((await app.request('/api/me', authed(device, { method: 'DELETE' }), env(db))).status).toBe(200);
    expect(codeRows(db)).toEqual([]);
  });

  it('the rows of a chat are read on migration 0016\'s index, paused rows too', async () => {
    const db = testD1();
    telegram();
    otherChats(db, 50);
    const s = await linked(db, 53, CHAT);
    await linked(db, 54, CHAT + 80);
    await put(db, s, { channels: { telegram: { enabled: false } } });
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { seen.push(sql); return prepare(sql); });
    expect((await rowsOfChat(db as any, KEY, CHAT)).map((r) => [r.address, r.channels.telegram?.enabled])).toEqual([[addr(53), false]]);
    const sql = seen.find((q) => q.includes("'$.tgc'"))!;
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(chatDigest(KEY, CHAT)) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/USING (COVERING )?INDEX kv_user_telegram_chat\b/);
    expect(plan).not.toMatch(/SCAN kv\b/);
  });

  it('a paused chat resumed in Settings takes a place under the chat cap: past it the row is saved still paused', async () => {
    const db = testD1();
    telegram();
    const a = await linked(db, 55, CHAT);
    otherChats(db, TELEGRAM_CHATS_MAX - 1);
    expect((await put(db, a, { channels: { telegram: { enabled: false } } })).status).toBe(200);
    const b = await linked(db, 56, CHAT + 90);
    expect((await getSettings(db, b)).channels.telegram.enabled).toBe(true);
    const r = await put(db, a, { notifications: { forumAndGov: true }, channels: { telegram: { enabled: true } } });
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.error).toBe(TELEGRAM_FULL);
    expect(j.settings.channels.telegram).toMatchObject({ linked: true, enabled: false });
    expect(j.settings.notifications.forumAndGov).toBe(true);
    expect((await readTelegram(db as any, KEY)).users.map((u) => u.address)).not.toContain(addr(55));
    // a save that keeps a chat on takes no new place
    expect((await put(db, b, { notifications: { forumAndGov: true } })).status).toBe(200);
    // a place freed is taken
    expect((await put(db, b, { channels: { telegram: { enabled: false } } })).status).toBe(200);
    expect((await put(db, a, { channels: { telegram: { enabled: true } } })).status).toBe(200);
    expect((await getSettings(db, a)).channels.telegram.enabled).toBe(true);
  });

  it('rows the dispatcher\'s read leaves out are recorded with the posts not sent, as Discord\'s are', async () => {
    const db = testD1();
    telegram();
    await linked(db, 60, CHAT);
    otherChats(db, 3);
    await sendTelegramMove(env(db), moveFromWatched(60));
    const skipped = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as { value: string }).value);
    expect(skipped).toMatchObject({ total: 3, last: { what: TG_UNSERVED_WHAT, n: 3 } });
  });

  it('a /stop that lands while a Settings save runs is not undone by it, either way round', async () => {
    const db = testD1();
    const tg = telegram();
    const stop = () => update(db, { message: { chat: { id: CHAT, type: 'private' }, from: { id: 42 }, text: '/stop' } });
    const prepare = db.prepare.bind(db);
    /** Runs `then` once, right after the statement matching `sql` bound to `param` has run (`first`) or right before (`run`). */
    const between = (sql: RegExp, param: unknown, how: 'first' | 'run', then: () => Promise<unknown>) => {
      let once = true;
      vi.spyOn(db, 'prepare').mockImplementation((q: string) => {
        const st = prepare(q);
        if (!sql.test(q)) return st;
        const bind = st.bind.bind(st);
        (st as any).bind = (...p: unknown[]) => {
          const b = bind(...p);
          if (once && (param === undefined || p[0] === param)) {
            const orig = (b as any)[how].bind(b);
            (b as any)[how] = async (...a: unknown[]) => {
              if (!once) return orig(...a);
              once = false;
              if (how === 'run') { await then(); return orig(...a); }
              const res = await orig(...a);
              await then();
              return res;
            };
          }
          return b;
        };
        return st;
      });
    };

    // The save read the row before the /stop (the switch's body always names Telegram): resuming is refused, a pause
    // keeps the chat unlinked.
    const s = await linked(db, 57, CHAT);
    await put(db, s, { channels: { telegram: { enabled: false } } });
    between(/^SELECT value FROM kv WHERE key=\?$/, `user:${addr(57)}`, 'first', stop);
    expect((await put(db, s, { channels: { telegram: { enabled: true } } })).status).toBe(400);
    vi.mocked(db.prepare).mockRestore();
    expect((await loadSettings(db as any, KEY, addr(57)))!.channels.telegram).toMatchObject({ chatId: null, stopped: { reason: 'stop' } });
    const s2 = await linked(db, 58, CHAT);
    between(/^SELECT value FROM kv WHERE key=\?$/, `user:${addr(58)}`, 'first', stop);
    const paused = await put(db, s2, { channels: { telegram: { enabled: false } } });
    expect(paused.status).toBe(200);
    vi.mocked(db.prepare).mockRestore();
    expect(((await paused.json()) as any).settings.channels.telegram).toMatchObject({ linked: false, stopped: { reason: 'stop' } });
    // nor is the chat told it was disconnected in Settings
    expect(tg.sent(CHAT).filter((c) => c.body.text.includes('disconnected from this chat in Settings'))).toHaveLength(0);

    // The save wrote the row after the /stop read it: the /stop reads it again and unlinks it.
    const s3 = await linked(db, 59, CHAT);
    between(/^UPDATE kv SET value = json_set\(\?1, '\$\.onAt'/, undefined, 'run', async () => { t += 1000; await put(db, s3, { notifications: { forumAndGov: true } }); });
    await stop();
    vi.mocked(db.prepare).mockRestore();
    expect(tg.sent(CHAT).at(-1)!.body.text).toContain('Stopped');
    const row = (await loadSettings(db as any, KEY, addr(59)))!;
    expect(row.channels.telegram).toMatchObject({ chatId: null, stopped: { reason: 'stop' } });
    expect(row.notifications.forumAndGov).toBe(true);
  });
});

describe('the card as Telegram HTML', () => {
  it('keeps text an outsider wrote as text: no tag, no link, no code span it did not have', () => {
    const md = 'Label \\<b\\>hi\\</b\\> \\`x\\` [real](https://namada.trade/a?b=1&c=2) and [fake] (https://evil.example) & `code<1>`';
    const html = mdToHtml(md);
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain('`x`');
    expect(html).toContain('<a href="https://namada.trade/a?b=1&amp;c=2">real</a>');
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain('<code>code&lt;1&gt;</code>');
    expect(html).toContain('&amp;');
  });

  it('writes Discord time stamps in words', () => {
    const at = Date.UTC(2026, 9, 28, 8, 30);
    expect(mdToHtml(`<t:${at / 1000}:f>`, at)).toBe('28 Oct 2026, 08:30\u00a0UTC');
    expect(mdToHtml(`<t:${at / 1000}:R>`, at + 12 * 60_000)).toBe('12\u00a0min ago');
  });

  it('every real card becomes a message inside Telegram\'s limit, its links working and nothing of Discord\'s markup left', () => {
    const rows: Record<string, any> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'discord-rows.json'), 'utf8')).rows;
    for (const k of Object.keys(rows)) {
      const f = rowToFlow(rows[k]);
      const m = cardMessage(moveCard(f, { whaleNam: 10000, watched: [f.from!] }));
      const visible = m.html.replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot);/g, 'x');
      expect(visible.length, k).toBeLessThanOrEqual(4096);
      expect(m.html, k).not.toMatch(/\]\(https?:|<t:\d+/);
      expect(m.html, k).toMatch(/<b>.+<\/b>/);
      for (const href of m.html.matchAll(/href="([^"]+)"/g)) expect(href[1], k).toMatch(/^https:\/\//);
    }
    expect(embedHtml({ title: 'A <b>', color: 0, fields: [{ name: 'X&Y', value: '1', inline: true }] })).toBe('<b>A &lt;b&gt;</b>\n\n<b>X&amp;Y</b>\n1');
  });
});

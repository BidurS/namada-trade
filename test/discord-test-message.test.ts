// The Settings test message and the connection notice: the rules as saved, in the words Settings shows; the
// watchlist as a count; quiet hours with what they do (a move in them is not sent, then or later); and, in the test
// message, a real example: the newest move on record that matches the rules, built as its alert would be. A search
// that found none says so; one that gave up before the oldest record is not "none on record".
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { applyUpdate, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { configureAlerts, noticeBody, sendDiscordTestAlert, sendDiscordTestPost, testBody, testExample, COLOUR } from '../worker/src/sources/discord';
import { resetContextCache } from '../worker/src/sources/discord-context';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { BANNED } from './banned-words';

const HOOK = 'https://discord.com/api/webhooks/0/test-message';
const user = (over: Record<string, unknown> = {}): StoredSettings => {
  const base: StoredSettings = { address: 'tnam1qxuser00000000000000000000000000000000', notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: HOOK } }, createdAt: 0, updatedAt: 0 };
  const u = Object.keys(over).length ? applyUpdate(base, over) : base;
  if (typeof u === 'string') throw new Error(u);
  return u;
};
const field = (e: any, name: string) => e.fields.find((f: any) => f.name === name)?.value;
const T = Date.UTC(2026, 9, 23, 16);

afterEach(() => vi.unstubAllGlobals());

describe('the rules, the watchlist, the forum switch and quiet hours, as saved', () => {
  it('the default rules in the words Settings shows; no watchlist; no quiet hours', () => {
    const e = testBody(user(), undefined, T).embeds[0];
    expect(e.title).toBe('Alerts will arrive here');
    expect(e.color).toBe(COLOUR.test);
    expect(field(e, 'Your rules')).toBe([
      'NAM bridged to Osmosis: 25,000 NAM or more crossed from Namada to Osmosis in one transfer',
      'NAM unstaked: 100,000 NAM or more started unstaking, or finished unstaking and was withdrawn',
      'Large trade: A single buy or sell of 10,000 NAM or more on Osmosis, bot trades left out',
      'NAM left the shielded set: 50,000 NAM or more moved out of the shielded set to a personal address',
      'Large amount staked: 1,000,000 NAM or more staked in one transaction',
      // the sixth rule, from 2026-10-30: on by default for a new subscriber
      'Shielded NAM sent to Osmosis: 100,000 NAM or more sent to Osmosis by the shielded set itself, or by an address that had at least half of it from the shielded set in the hour before',
    ].join('\n'));
    expect(field(e, 'Watchlist')).toBe('off');
    expect(field(e, 'Quiet hours')).toBe('none');
    expect(e.description).toBe('This channel is connected for tnam1qxuse…00000. Each alert is one card: the amount and what happened in the title, who moved it with the names this site knows, the price with its source, and links to the mover’s page on NamadaTrade and to an explorer.');
  });
  it('a changed set: two watched addresses, a rule at 500 NAM, one off, quiet hours said with what they do and as a full-width line', () => {
    const u = user({ notifications: { watchlist: ['tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse', 'bogus', 'osmo1mpgtkc7aym9f3k8ll7hahtu7rvpdjc95e6m5tg'], quietHoursUtc: { start: 22, end: 7 }, forumAndGov: true, rules: { big_swap: { on: true, thresholdNam: 500 }, bond: { on: false, thresholdNam: 1_000_000 } } } });
    const e = testBody(u, undefined, T).embeds[0];
    expect(field(e, 'Your rules')).toContain('Large trade: A single buy or sell of 500 NAM or more on Osmosis, bot trades left out');
    expect(field(e, 'Your rules')).toMatch(/\nOff: Large amount staked$/);
    expect(field(e, 'Watchlist')).toBe('2 addresses');
    expect(field(e, 'Forum and governance')).toBe('on');
    expect(e.fields.find((f: any) => f.name === 'Quiet hours')).toEqual({ name: 'Quiet hours', value: '22:00 to 07:00 UTC. A move made in these hours, or a forum post or proposal read in them, is not sent, then or later.', inline: false });
    for (const t of [e.title, e.description, ...e.fields.flatMap((f: any) => [f.name, f.value])]) expect(t).not.toMatch(BANNED);
  });
  it('the connection notice says what will arrive and how to see one, with the same fields and no example', () => {
    const b = noticeBody(user(), T);
    expect(b.embeds).toHaveLength(1);
    expect(b.embeds[0].title).toBe('Discord channel connected');
    expect(b.embeds[0].description).toContain('A test message from Settings shows one, built from the newest move that matches your rules.');
    expect(b.username).toBe('NamadaTrade');
  });
});

describe('the example: the newest move on record that matches these rules', () => {
  const recv = 'tnam1qpy8mfjj25y60xeyucscy7cl0m9qdme7nq272cf3';
  it('read with its context and built as its alert would be, under its own heading', async () => {
    resetContextCache();
    const db = testD1();
    insert(db, 'flows', [
      { id: 'namada:EX1:1', chain: 'namada', height: 1, ts: T - 60_000, tx_hash: 'EX1', kind: 'unshield', from_addr: INTERNAL_ADDRESSES.masp, to_addr: recv, amount_num: 50_000, price_usd: 0.000874, value_usd: 43.68, meta: '{"source":"t","priceSource":"spot"}' },
    ]);
    const u = user();
    const ex = await testExample(db as any, u, T);
    expect(ex && typeof ex === 'object').toBe(true);
    const b = testBody(u, ex, T);
    expect(b.embeds).toHaveLength(2);
    const e = b.embeds[1];
    expect(e.author).toEqual({ name: 'Example: the newest move on record that matches these rules', url: 'https://namada.trade/alerts' });
    expect(e.title).toBe('50,000 NAM moved out of the shielded set');
    expect(String(e.description)).toMatch(/^To tnam1qpy8m…72cf3, from the shielded pool\. Worth \$43\.68 at \$0\.000874 a NAM \(Osmosis quote\)\./);
    expect(String(e.description)).toContain("Before this: no earlier move by this address on record (this site's records).");
    expect(b.embeds[0].description).toContain('one card like the example below');
  });
  it('none on record is said; a search that gave up before the oldest record is not "none"; no rule on, no example', async () => {
    const db = testD1();
    expect(await testExample(db as any, user(), T)).toBeNull();
    expect(testBody(user(), null, T).embeds[1].title).toBe('No move on record matches these rules yet');
    const gaveUp = testBody(user(), 'gave-up', T).embeds[1];
    expect(gaveUp.title).toBe('No example this time');
    expect(gaveUp.description).toBe('None among the newest moves looked at matches these rules; the Alerts page keeps looking.');
    expect(testBody(user(), 'unread', T).embeds[1].description).toBe('The newest move that matches these rules could not be read just now; the Alerts page lists them.');
    const off = user({ notifications: { rules: Object.fromEntries(['ibc_inventory', 'unlock', 'big_swap', 'unshield', 'bond', 'exit_bridge'].map((id) => [id, { on: false, thresholdNam: 100_000 }])) } });
    expect(await testExample(db as any, off, T)).toBeUndefined();
    expect(testBody(off, undefined, T).embeds).toHaveLength(1);
    expect(testBody(off, undefined, T).embeds[0].fields[0].value).toMatch(/^No rule is on\./);
  });
  it('the test route\'s post carries the example; the notice a save posts does not read one', async () => {
    resetContextCache();
    const db = testD1();
    insert(db, 'flows', [
      { id: 'namada:EX2:1', chain: 'namada', height: 2, ts: Date.now() - 60_000, tx_hash: 'EX2', kind: 'unshield', from_addr: INTERNAL_ADDRESSES.masp, to_addr: recv, amount_num: 60_000, price_usd: null, value_usd: null, meta: '{"source":"t"}' },
    ]);
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }));
    configureAlerts(undefined, true);
    expect(await sendDiscordTestAlert(HOOK, user(), db as any, true)).toBe(true);
    expect(bodies[0].embeds).toHaveLength(2);
    expect(bodies[0].embeds[1].title).toBe('60,000 NAM moved out of the shielded set');
    const prepare = vi.spyOn(db, 'prepare');
    const notice = await sendDiscordTestPost(HOOK, user(), db as any, true);
    expect(notice).toMatchObject({ ok: true });
    expect(bodies[1].embeds).toHaveLength(1);
    expect(bodies[1].embeds[0].title).toBe('Discord channel connected');
    expect(prepare.mock.calls.some(([sql]) => /FROM flows/.test(String(sql)))).toBe(false);
  });
});

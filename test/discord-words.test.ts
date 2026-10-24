// Discord alert cards in the site's words, built from stored rows of every kind (test/fixtures/discord-rows.json): no
// banned word, emoji, rule id or "address(es)"; a title that starts with the amount; a first line (what a lock screen
// shows) with no markdown and no time stamp; a trade's figure what it settled at, with the quote of its minute as the
// comparison; every price with its source; who the operator's channel hears of; colours by the site's hues; one
// sender with the site's mark; and Discord's limits in the worst case outsiders can make.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFlowDiscordBody, operatorMove, embedCount, fits, cutText, DISCORD_LIMITS, SENDER, configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { contextWithoutReads, type MoveContext } from '../worker/src/sources/discord-context';
import { rowToFlow } from '../worker/src/analytics';
import { boundFlowText } from '../worker/src/util';
import { settleMetaOf, settleOf } from '../shared/settle';
import { HUE_HEX } from '../shared/kinds';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { lintMessageFile, MESSAGE_SOURCES } from '../scripts/copy-lint';
import { BANNED } from './banned-words';
import { testD1 } from './d1-sqlite';
import type { Flow } from '../shared/types';

const ROOT = join(__dirname, '..');
const ROWS: Record<string, any> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'discord-rows.json'), 'utf8')).rows;
const flowOf = (k: string): Flow => rowToFlow(ROWS[k]);
/** The card the live path builds: the flow, the context that needs no read, and why it reached the channel. */
const card = (f: Flow, ctx: MoveContext = { whaleNam: 10_000 }, late = false) => buildFlowDiscordBody(f, { ...contextWithoutReads(f), ...ctx }, late);
const line1 = (e: any) => String(e.description).split('\n')[0];
const EMOJI = /\p{Extended_Pictographic}/u;
const RULE_ID = /\b(ibc_inventory|big_swap|IBC_INVENTORY|BIG_SWAP|UNLOCK|UNSHIELD|WATCHLIST)\b|\[[A-Z_]+\]/;
const I = INTERNAL_ADDRESSES;

afterEach(() => vi.unstubAllGlobals());

/** Every text of an embed a reader sees. */
const texts = (e: any): string[] => [e.title, e.author?.name, e.description, e.footer?.text, ...e.fields.flatMap((f: any) => [f.name, f.value])].filter((x) => typeof x === 'string');

/** Discord's limits on one message (DISCORD_LIMITS). */
function withinLimits(body: { embeds: any[] }) {
  for (const e of body.embeds) {
    expect(e.title?.length ?? 0).toBeLessThanOrEqual(256);
    expect(e.description?.length ?? 0).toBeLessThanOrEqual(4096);
    expect(e.author?.name?.length ?? 0).toBeLessThanOrEqual(256);
    expect(e.footer?.text?.length ?? 0).toBeLessThanOrEqual(2048);
    expect(e.fields.length).toBeLessThanOrEqual(25);
    for (const f of e.fields) { expect(f.name.length).toBeLessThanOrEqual(256); expect(f.value.length).toBeLessThanOrEqual(1024); }
  }
  expect(body.embeds.reduce((n, e) => n + embedCount(e), 0)).toBeLessThanOrEqual(6000);
}

describe('every card of every kind, in the site\'s words', () => {
  const ctxs: [string, MoveContext][] = [
    ['operator', { whaleNam: 10_000 }],
    ['rule', { rule: { id: 'big_swap', title: 'Large trade', thresholdNam: 10_000 } }],
    ['watchlist', { watched: ['tnam1qpjppur46s3ja5uwzsyamxwzvtwnkeeycyl472u3'] }],
  ];
  for (const k of Object.keys(ROWS)) {
    it(`${k}: no banned word, emoji, rule id or "address(es)"; the amount first; a plain first line; the move's own time`, () => {
      const f = flowOf(k);
      for (const [, ctx] of ctxs) for (const late of [false, true]) {
        const body = card(f, ctx, late);
        expect(body.username).toBe('NamadaTrade');
        const e = body.embeds[0];
        for (const t of texts(e)) {
          expect(t, `${k}: ${t}`).not.toMatch(BANNED);
          expect(t).not.toMatch(EMOJI);
          expect(t).not.toMatch(RULE_ID);
          expect(t).not.toMatch(/address\(es\)/);
        }
        expect(e.title).toMatch(/^[\d,.]+ (NAM|[A-Z]{2,6}) /);
        // a lock screen shows the first line raw: no link, code or emphasis mark, and no Discord time stamp
        expect(line1(e)).not.toMatch(/\]\(|\*\*|`|<t:|^>/);
        expect(e.timestamp).toBe(new Date(f.ts).toISOString());
        expect(e.footer.text).toMatch(/^NamadaTrade · (Osmosis|Namada) record, block [\d,]+$/);
        withinLimits(body);
      }
    });
  }
});

describe('a trade: what it settled at leads, the quote of its minute is the comparison', () => {
  it('the 791,848 NAM sale settled at $113.59 (not the quote times the amount), 69% under the quote, the NAM the settle counts named', () => {
    const e = card(flowOf('sell')).embeds[0];
    expect(line1(e)).toBe('Sold by osmo1nn62s…evpvh. Settled at $0.000142 a NAM, $113.59 in all, 69% under the Osmosis quote for that minute ($0.000451).');
    expect(JSON.stringify(e)).not.toContain('357.41');
    expect(e.fields.map((f: any) => [f.name, f.inline])).toEqual([['Settled at', true], ['Quote that minute', true], ['Received', false]]);
    expect(e.fields[2].value).toBe('113.59 allUSDC (counted at a dollar) for 799,995 NAM given, fees in\nless $0.007377 of gas');
    expect(e.fields[1].value).toBe('$0.000451 a NAM\nThe Osmosis quote for that minute');
  });
  it('a sale paid in OSMO says the rate it was valued at and where that came from', () => {
    const e = card(flowOf('lateSell')).embeds[0];
    expect(e.fields.find((f: any) => f.name === 'Received').value).toBe('375.7190 OSMO for 21,898 NAM given, fees in\nOSMO at $0.048443, this transaction’s own rate\nless $0.003622 of gas');
  });
  it('a buy whose gas has no price that minute says the gas is left out', () => {
    // the gas's coin has no price that minute: the batch's quote read found none (readMoveContext)
    const f = flowOf('buy');
    const e = card(f, { whaleNam: 10_000, settle: settleOf('buy', settleMetaOf(f.meta)!, {}) }).embeds[0];
    expect(e.fields.find((x: any) => x.name === 'Paid').value).toBe('10.00 allUSDC (counted at a dollar), fees in, for 92,426 NAM\ngas left out: no price for its coin that minute');
  });
  it('a trade with no settle record says what it settled at is not on record, and values it at its quote, said so', () => {
    const f = flowOf('sell');
    f.meta = { ...f.meta, settle: undefined };
    const e = card(f).embeds[0];
    expect(line1(e)).toBe('Sold by osmo1nn62s…evpvh. What it settled at is not on record; at $0.000451 a NAM (Osmosis quote) it is worth about $357.41.');
  });
  it('a trade priced by its own coins is "the trade\'s own price": no quote field and no comparison', () => {
    const f: Flow = { ...flowOf('buy'), counterDenom: 'USDC', counterAmount: 50, amount: 100_000, priceUsd: 0.0005, valueUsd: 50, meta: { trader: 'osmo1x' } };
    const e = card(f).embeds[0];
    expect(line1(e)).toBe("Bought by osmo16u4xs…v5qmm. At $0.000500 a NAM, $50.00 in all (trade's own price).");
    expect(e.fields).toEqual([]);
  });
  it('a trade with no price at all says so', () => {
    const f: Flow = { ...flowOf('sell'), priceUsd: null, valueUsd: null, meta: {} };
    expect(line1(card(f).embeds[0])).toBe('Sold by osmo1nn62s…evpvh. No price is on record for this trade.');
  });
});

describe('every other price names its source', () => {
  it('the quote: "(Osmosis quote)" on the first line, the long form in its field', () => {
    const e = card(flowOf('ibcToOsmosis')).embeds[0];
    expect(line1(e)).toBe('From tnam1qzdxr…58su2 to osmo1nn62s…evpvh. Worth $1,678 at $0.001119 a NAM (Osmosis quote).');
    expect(e.fields).toEqual([{ name: 'Worth', value: '$1,678', inline: true }, { name: 'Quote that minute', value: '$0.001119 a NAM\nThe Osmosis quote for that minute', inline: true }]);
  });
  it('the route\'s spot, from the stamp the live hub writes or from the price\'s read log', () => {
    const f = flowOf('ibcToOsmosis');
    const stamped = card({ ...f, meta: { ...f.meta, priceRoute: 1000 } }).embeds[0];
    expect(line1(stamped)).toContain('(Osmosis route quote, 1,000 NAM).');
    expect(stamped.fields[1].value).toBe('$0.001119 a NAM\nThe Osmosis route quote for that minute (the route for selling 1,000 NAM)');
    expect(line1(card(f, { whaleNam: 10_000, priceRoute: 1000 }).embeds[0])).toContain('(Osmosis route quote, 1,000 NAM).');
    // a route on a price that is not the quote is no route
    expect(line1(card({ ...flowOf('withdraw'), meta: { priceRoute: 1000 } }).embeds[0])).toContain('(stored price, source not stated)');
  });
  it('a price with no source stored says so; the pool\'s close names its hour; no price is said', () => {
    expect(line1(card(flowOf('withdraw')).embeds[0])).toContain('Worth $989.32 at $0.000846 a NAM (stored price, source not stated).');
    const pool = card({ ...flowOf('withdraw'), meta: { priceSource: 'pool_1h', priceAt: Date.UTC(2026, 9, 23, 18) } }).embeds[0];
    expect(line1(pool)).toContain("(pool's hourly close, hour ending 19:00 UTC).");
    expect(pool.fields[1]).toEqual({ name: 'Price that minute', value: '$0.000846 a NAM\nThe pool’s close for the hour ending 19:00 UTC (Osmosis app data), as no Osmosis quote was stored for that minute', inline: true });
    const none = card({ ...flowOf('unbond'), priceUsd: null, valueUsd: null }).embeds[0];
    expect(line1(none)).toMatch(/\. No price is on record for this move\.$/);
    expect(none.fields).toEqual([]);
  });
  it('another coin: its own unit, no dollar figure', () => {
    const e = card(flowOf('otherCoin'), { watched: ['osmo1sqdwxh2tlvpmsh7rapjmtmyeg4pn4hu494v9mf'] }).embeds[0];
    expect(e.title).toBe('290 OSMO moved out of the shielded set to Osmosis');
    expect(line1(e)).toBe('To osmo1sqdwx…4v9mf, from the shielded pool. No dollar value is on record for this move.');
    expect(e.fields).toEqual([]);
  });
});

describe('who a card names', () => {
  it('a label in the site\'s words with its short address, a protocol account by its name', () => {
    expect(line1(card(flowOf('withdraw')).embeds[0])).toMatch(/^To Public sale allocation \(genesis\) tnam1qqvt7…w7jsd\./);
    expect(line1(card(flowOf('ibcToShielded')).embeds[0])).toMatch(/^From osmo17yg0z…8xrmx to the shielded pool\./);
  });
  it('a transfer names both sides as every page does; public funding goes to its receiver', () => {
    const t = card({ ...flowOf('transfer'), fromLabel: 'Genesis: af_backers', fromLabelSource: 'genesis', fromLabelPlain: undefined }).embeds[0];
    expect(line1(t)).toMatch(/^From Early backers \(genesis\) osmo1r0wmz…fqeal to osmo1q2kls…8sacw\./);
    const pgf = card({ ...flowOf('rewards'), kind: 'pgf', from: I.pgf }).embeds[0];
    expect(line1(pgf)).toMatch(/^To tnam1qzkc4…4zhxn\./);
  });
  it('the Namada record of a shielded withdrawal names no person: the bridge account stands for a receiver on Osmosis', () => {
    const f: Flow = { ...flowOf('ibcToOsmosisNamadaRecord'), from: I.masp, to: I.ibc, fromLabel: null, toLabel: null };
    const e = card(f).embeds[0];
    expect(e.title).toBe('1,500,000 NAM bridged to Osmosis');
    expect(line1(e)).toMatch(/^From the shielded pool to a receiver on Osmosis this record does not name\./);
    expect(JSON.stringify(e)).not.toContain('activity?addr=');
    expect(e.url).toMatch(/^https:\/\/namada\.valopers\.com\/transactions\//);
    // a person's send that no packet bound: the person is named, the far end is not
    const g = card({ ...f, from: 'tnam1qzdxrdjvkhlxmxqna5c09d3sst6d9mhufcu58su2' }).embeds[0];
    expect(line1(g)).toMatch(/^From tnam1qzdxr…58su2 to a receiver on Osmosis this record does not name\./);
    expect(g.url).toBe('https://namada.trade/activity?addr=tnam1qzdxrdjvkhlxmxqna5c09d3sst6d9mhufcu58su2');
  });
  it('above the title: the watchlist first, then the rule at the subscriber\'s size; the operator\'s whale size', () => {
    expect(card(flowOf('sell'), { watched: ['osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh'], rule: { id: 'big_swap', title: 'Large trade', thresholdNam: 10_000 } }).embeds[0].author)
      .toEqual({ name: 'Watchlist: osmo1nn62s…evpvh · also Large trade · your rule at 10,000 NAM', url: 'https://namada.trade/settings#watchlist' });
    expect(card(flowOf('sell'), { rule: { id: 'big_swap', title: 'Large trade', thresholdNam: 500 } }).embeds[0].author)
      .toEqual({ name: 'Large trade · your rule at 500 NAM', url: 'https://namada.trade/settings#rules' });
    expect(card(flowOf('sell')).embeds[0].author).toEqual({ name: 'Large move · 10,000 NAM or more' });
  });
});

describe('who the operator\'s channel hears of (owner\'s calls, 2026-10-23)', () => {
  it('bot round trips and rewards claims are left out; plain transfers and every other whale stay', () => {
    expect(operatorMove(flowOf('bot'), 10_000)).toBe(false);
    expect(operatorMove(flowOf('rewards'), 10_000)).toBe(false);
    for (const k of ['transfer', 'sell', 'buy', 'ibcToOsmosis', 'unshield', 'withdraw', 'bond', 'unbond', 'lpAdd', 'lpRemove', 'shield']) expect(operatorMove(flowOf(k), 10_000), k).toBe(true);
    expect(operatorMove(flowOf('otherCoin'), 10)).toBe(false);
  });
  it('the operator\'s channel is not posted a bot round trip; a watcher of the bot hears of it with what it netted', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(String(init?.body)) }); return new Response(null, { status: 204 }); }));
    configureAlerts(undefined, true);
    await sendDiscordWhaleAlert('https://discord.com/api/webhooks/88/op', { ...flowOf('bot'), id: 'osmosis:BOTWORDS:0' }, testD1() as any, 10_000);
    expect(calls).toHaveLength(0);
    const e = card(flowOf('bot'), { watched: ['osmo1khrd2gyj6hu2s6hh4kpgp42etgdfch3rtvmz82'] }).embeds[0];
    expect(e.title).toBe('46,275 NAM bot round trip on Osmosis');
    expect(line1(e)).toMatch(/^By osmo1khrd2…vmz82: bought 46,275 and sold 46,182 NAM in one transaction \(92\.5 NAM bought net\)\./);
  });
});

describe('the site\'s hues and mark', () => {
  it('each kind\'s bar is its tag\'s hue, as tokens.css defines it (dark)', () => {
    const css = readFileSync(join(ROOT, 'web/src/styles/tokens.css'), 'utf8');
    const token = (name: string) => parseInt(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, 'i').exec(css)![1], 16);
    for (const h of ['buy', 'sell', 'ibc', 'shield', 'pos'] as const) expect(HUE_HEX[h]).toBe(token(h));
    expect(HUE_HEX.neutral).toBe(token('ink-2'));
    expect(card(flowOf('sell')).embeds[0].color).toBe(HUE_HEX.sell);
    expect(card(flowOf('buy')).embeds[0].color).toBe(HUE_HEX.buy);
    expect(card(flowOf('ibcToOsmosis')).embeds[0].color).toBe(HUE_HEX.ibc);
    expect(card(flowOf('unshield')).embeds[0].color).toBe(HUE_HEX.shield);
    expect(card(flowOf('withdraw')).embeds[0].color).toBe(HUE_HEX.pos);
    expect(card(flowOf('bot')).embeds[0].color).toBe(HUE_HEX.neutral);
  });
  it('one sender, the site, with the site\'s own mark, which the site serves', () => {
    expect(SENDER).toEqual({ username: 'NamadaTrade', avatar_url: 'https://namada.trade/icon-512.png' });
    expect(existsSync(join(ROOT, 'web/public/icon-512.png'))).toBe(true);
  });
});

describe('the copy rules over the message builders\' source', () => {
  it('no banned word in any literal the builders write, and a planted one is found', () => {
    for (const m of MESSAGE_SOURCES) expect(lintMessageFile(join(ROOT, m.file), m.names)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'copy-'));
    const file = join(dir, 'x.ts');
    writeFileSync(file, "export function moveCard() { return 'IBC transfer'; }\nconst x = 'IBC elsewhere';\n");
    expect(lintMessageFile(file, new Set(['moveCard'])).map((f) => f.word)).toEqual(['IBC']);
  });
});

describe('Discord\'s limits in the worst case outsiders can make', () => {
  it('the longest labels and tags, a 32 KB memo cut to 256, a 128-character receiver, a long validator name and a full context stay inside every limit', () => {
    const big = 'x'.repeat(32_000);
    const f = boundFlowText({
      ...flowOf('unbond'), from: I.pos, to: 'osmo1' + '[a](http://e.v)*_'.repeat(20),
      meta: { ...flowOf('unbond').meta, memo: big, validator: 'tnam1qvalidator' + 'q'.repeat(30) },
      toLabel: 'Genesis: ' + 'af_backers, '.repeat(40), toLabelSource: 'genesis',
    } as Flow);
    expect((f.meta as any).memo.length).toBeLessThanOrEqual(256);
    expect(f.to!.length).toBeLessThanOrEqual(128);
    const prior = (i: number) => ({ id: `p${i}`, kind: (['sell', 'buy', 'bond'] as const)[i % 3], chain: 'osmosis' as const, amount: 123_456_789.123, ts: f.ts - i * 60_000, received: i % 2 === 0 });
    const ctx: MoveContext = {
      before: [0, 1, 2].map(prior), otherBefore: [3, 4, 5].map(prior), history: { n: 999_999, first: 1, last: 2, capped: true },
      trades30d: { side: 'sell', n: 999_999, nam: 9e12, firstTs: 1 }, validatorName: 'v'.repeat(5000) + '[x](http://e.v)',
      unlockAt: { at: f.ts + 1e9, source: 'estimate', note: 'n'.repeat(3000) }, crossingIn: { id: 'c', amount: 9e12, ts: 1 },
      watched: ['tnam1qpjppur46s3ja5uwzsyamxwzvtwnkeeycyl472u3', 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh'],
      rule: { id: 'unlock', title: 'NAM unstaked', thresholdNam: 1 },
    };
    for (const late of [false, true]) {
      const body = buildFlowDiscordBody(f, ctx, late);
      withinLimits(body);
      expect(JSON.stringify(body)).not.toContain('](http://e.v');
    }
    // a wallet's tag of the longest kind the labels route takes (64 characters) keeps its byline
    const tagged = buildFlowDiscordBody({ ...flowOf('withdraw'), toLabel: 'T'.repeat(64), toLabelPlain: 'T'.repeat(64), toLabelSource: 'user', toLabelAuthor: 'tnam1qauthor…' }, {});
    expect(line1(tagged.embeds[0])).toContain(`${'T'.repeat(64)} tnam1qqvt7…w7jsd (Tag by tnam1qauthor…)`);
  });
  it('fits() trims in its order: the "Before this" line first, then the abstract, the excerpt, the authors, then drops; the description is cut last', () => {
    const before = Array.from({ length: 300 }, (_, i) => `clause ${i} `.padEnd(30, 'b'));
    const card = (room?: number) => fits({
      embed: { title: 't', color: 0, fields: [{ name: 'f', value: 'v'.repeat(1000), inline: true }], footer: { text: 'NamadaTrade' } },
      parts: [
        { text: 'first line', sep: '' },
        { text: `Before this: ${before.join('; ')} (this site's records).`, sep: '\n\n', role: 'before', shorten: (max) => { for (let n = before.length - 1; n > 0; n--) { const t = `Before this: ${before.slice(0, n).join('; ')} (this site's records).`; if (t.length <= max) return t; } return ''; } },
        { text: 'what it means', sep: '\n', role: 'means' },
      ],
    }, room);
    const e = card();
    expect(e.description!.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    expect(e.description).toMatch(/^first line\n\nBefore this: clause 0/);
    expect(e.description).toMatch(/\(this site's records\)\.\nwhat it means$/);
    // a room that leaves little: the "Before this" line goes whole, then the meaning, and the first line stays
    expect(card(1100).description).toBe('first line\n\nwhat it means');
    const small = card(1030);
    expect(small.description).toBe('first line');
    expect(embedCount(small)).toBeLessThanOrEqual(1030);
  });
  it('cutText never leaves half a character or a lone escape before its "…"', () => {
    expect(cutText('abc', 5)).toBe('abc');
    expect(cutText('abcdef', 4)).toBe('abc…');
    expect(cutText('ab\\_cd', 4)).toBe('ab…');
    expect(cutText('a😀b', 3)).toBe('a…');
  });
});

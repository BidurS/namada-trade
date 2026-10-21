// Review C (fix-alerts): every alert size and every alert word is NAM, so they apply to NAM amounts only. A move in
// another coin (shielded OSMO, USDC…) carries meta.tokenSymbol and its amount is in that coin's units. Before, a
// 60,000 OSMO unshield was published by GET /api/alerts/recent as "60,000 NAM moved out of the shielded set", passed
// the operator's NAM whale size and every subscriber's NAM unshield rule.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { evaluateFlow, DEFAULT_THRESHOLDS } from '../shared/alerts';
import { alertsBetween, lastAlertBefore } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { configureAlerts, buildFlowDiscordBody, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { testD1, insert } from './d1-sqlite';
import type { AlertsRecentResponse, Flow } from '../shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

type Hub = { alertFlows(flows: Flow[], threshold?: number, minNam?: number): Promise<void> };
const hubWith = (env: Record<string, unknown>): Hub => Object.assign(Object.create(LiveHub.prototype), { env, lastPriceUsd: null });

const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const OSMO_TOKEN = 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75';
const USER = 'tnam1qxuser00000000000000000000000000000000';
const KEY = base64.encode(new Uint8Array(32).fill(5));
const NOW = Date.UTC(2026, 9, 21, 12);
const H = 3600000;
const D = 24 * H;
const NAM_WORD = /\bNAM\b/;

/** The record's input: 60,000 OSMO leaving the shielded set to a personal address (parse/namada.ts Case A shape). */
const osmoOut = (id = 'osmo'): Flow => ({
  id, chain: 'namada', height: 1, ts: NOW - H, txHash: id.toUpperCase(), kind: 'unshield', from: MASP, to: USER, amount: 60000,
  counterDenom: 'OSMO', counterAmount: 60000, meta: { tokenSymbol: 'OSMO', descriptor: 'transfer-from-wasm' },
});

let calls: { url: string; body: any }[] = [];
const stubFetch = () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 204 });
  }));
};
afterEach(() => vi.unstubAllGlobals());

const subscriber = (n: string, webhookUrl: string, watchlist: string[] = []): StoredSettings => {
  const s: StoredSettings = { address: `tnam1q${n}${'q'.repeat(39 - n.length)}`, notifications: { ...defaultPrefs(), watchlist }, channels: { discord: { enabled: true, webhookUrl } }, createdAt: NOW, updatedAt: NOW };
  for (const r of Object.values(s.notifications.rules)) r.thresholdNam = 1; // every rule on at its lowest size
  return s;
};

const row = (id: string, ts: number, kind: string, amount: number, meta: Record<string, unknown> | null, from = MASP, to = USER) => ({
  id, chain: 'namada', height: 1, ts, tx_hash: id.toUpperCase(), kind, from_addr: from, to_addr: to, amount_num: amount, meta: meta ? JSON.stringify(meta) : null,
});

describe('review C: NAM alert sizes and words apply to NAM amounts only', () => {
  it('the shared rules give no hit for a move in another coin, at any size, on any rule', () => {
    expect(evaluateFlow(osmoOut())).toEqual([]);
    // the same move in NAM is the hit it always was
    expect(evaluateFlow({ ...osmoOut(), meta: { descriptor: 'transfer-from-wasm' } }).map((h) => [h.ruleId, h.title, h.amountNam]))
      .toEqual([['unshield', '60,000 NAM moved out of the shielded set', 60000]]);
    // every rule, each with another coin's amount far above every NAM size
    const coin = { tokenSymbol: 'USDC' };
    const big = 1e12;
    for (const f of [
      { ...osmoOut('b'), kind: 'bond', from: USER, to: POS },
      { ...osmoOut('w'), kind: 'withdraw', from: POS },
      { ...osmoOut('u'), kind: 'unbond', from: POS },
      { ...osmoOut('s'), chain: 'osmosis', kind: 'sell', from: 'osmo1seller', to: null },
      { ...osmoOut('i'), chain: 'osmosis', kind: 'ibc_in', from: USER, to: 'osmo1receiver' },
    ] as Flow[]) {
      expect(evaluateFlow({ ...f, amount: big, meta: coin }), f.kind).toEqual([]);
      expect(evaluateFlow({ ...f, amount: big, meta: null }), f.kind).toHaveLength(1);
    }
  });

  it('a real-shaped OSMO unshield from the block reader is no NAM hit', () => {
    const attr = (key: string, value: string) => ({ key, value });
    const flows = parseNamadaBlock({
      height: 1, ts: NOW, events: [{
        type: 'token/transfer',
        attributes: [
          attr('token-event-descriptor', 'transfer-from-wasm'), attr('hash', 'A'.repeat(64)),
          attr('source-accounts', JSON.stringify([[[`internal-address/${MASP}`, OSMO_TOKEN], '60000000000']])),
          attr('target-accounts', JSON.stringify([[[`internal-address/${USER}`, OSMO_TOKEN], '60000000000']])),
        ],
      }],
    }, null).flows;
    expect(flows.map((f) => [f.kind, f.amount, f.meta?.tokenSymbol])).toEqual([['unshield', 60000, 'OSMO']]);
    expect(evaluateFlow(flows[0])).toEqual([]);
  });

  it('GET /api/alerts/recent and the last-alert search never publish an OSMO unshield as NAM', async () => {
    const db = testD1();
    insert(db, 'flows', [
      row('osmo', NOW - H, 'unshield', 60000, { tokenSymbol: 'OSMO' }),
      row('nam-old', NOW - 16 * D, 'bond', 2999716, null, USER, POS),
    ]);
    const body = (await (await app.request(`/api/alerts/recent?at=${NOW}`, {}, { DB: db } as any)).json()) as AlertsRecentResponse;
    expect(body.hits).toEqual([]);
    expect(body.last).toMatchObject({ flowId: 'nam-old', ruleId: 'bond', title: '2,999,716 NAM staked' });
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS)).toMatchObject({ flowId: 'nam-old' });
  });

  it('rows in another coin never fill the rows the alert reads take', async () => {
    const db = testD1();
    insert(db, 'flows', [
      ...Array.from({ length: 500 }, (_, i) => row(`usdc${i}`, NOW - (i + 1) * 1000, 'unshield', 90000, { tokenSymbol: 'USDC' })),
      row('nam', NOW - 2 * H, 'unshield', 60000, null),
    ]);
    // 500 newer USDC rows: the 24 h read's 500 rows and the last-alert search's first page are NAM rows only
    expect((await alertsBetween(db as any, NOW - D, NOW, DEFAULT_THRESHOLDS)).map((h) => h.flowId)).toEqual(['nam']);
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS, 1, 100)).toMatchObject({ flowId: 'nam', amountNam: 60000 });
  });

  it('Discord: no operator or rule post for another coin; a watcher still hears of it, in that coin', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/77/op';
    const RULES = 'https://discord.com/api/webhooks/77/rules';
    const WATCH = 'https://discord.com/api/webhooks/77/watch';
    await saveSettings(db as any, KEY, subscriber('rules', RULES));
    await saveSettings(db as any, KEY, subscriber('watch', WATCH, [USER]));
    await sendDiscordWhaleAlert(OP, osmoOut('osmo-discord'), 0.001, db as any, 10000);
    expect(calls.map((c) => c.url)).toEqual([WATCH]);
    const embed = calls[0].body.embeds[0];
    expect(embed.title).toBe('[WATCHLIST] 🔓 MASP Unshielded: 60,000 OSMO');
    expect(JSON.stringify(embed)).not.toMatch(NAM_WORD);
  });

  it('a bridge move in another coin never takes the pairing claim of a NAM crossing with the same numbers', async () => {
    stubFetch();
    const db = testD1();
    const OP = 'https://discord.com/api/webhooks/77/ibc-op';
    const RECV = 'osmo1v77receiver';
    // 30,000 USDC sent from Namada (no Osmosis twin is ever recorded for it), then 30,000 NAM crossing between the
    // same two addresses in the same ten minutes
    const usdc: Flow = { ...osmoOut('usdc-ibc'), kind: 'ibc_out', from: USER, to: RECV, amount: 30000, counterDenom: 'USDC', counterAmount: 30000, meta: { tokenSymbol: 'USDC' } };
    const nam: Flow = { id: 'osmosis:V77IBC:ibc_in:3', chain: 'osmosis', height: 1, ts: usdc.ts + 1000, txHash: 'V77IBC', kind: 'ibc_in', from: USER, to: RECV, amount: 30000, meta: null };
    await saveSettings(db as any, KEY, subscriber('ibcwatch', 'https://discord.com/api/webhooks/77/ibc-watch', [USER]));
    configureAlerts(KEY);
    await sendDiscordWhaleAlert(OP, usdc, null, db as any, 10000);
    await sendDiscordWhaleAlert(OP, nam, null, db as any, 10000);
    expect(calls.filter((c) => c.url === OP).map((c) => c.body.embeds[0].title)).toEqual(['🌉 IBC Bridge Namada → Osmosis: 30,000 NAM']);
  });

  it('a move that names its coin only in meta.tokenSymbol is still named by it', () => {
    const body = buildFlowDiscordBody({ ...osmoOut('meta-only'), counterDenom: null, counterAmount: null }, 0.001);
    expect(body.embeds[0].title).toBe('🔓 MASP Unshielded: 60,000 OSMO');
    expect(JSON.stringify(body.embeds[0])).not.toMatch(NAM_WORD);
  });

  it('the live pass: another coin is never a NAM whale, and its watchers hear of it at any size', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/77/live-op';
    const WATCH = 'https://discord.com/api/webhooks/77/live-watch';
    await saveSettings(db as any, KEY, { ...subscriber('livewatch', WATCH, [USER]), notifications: { ...defaultPrefs(), watchlist: [USER] } });
    const osmo = osmoOut('osmo-live');
    const usdc: Flow = { ...osmoOut('usdc-live'), kind: 'transfer', from: 'tnam1qsender000000000000000000000000000000000', amount: 5, counterDenom: 'USDC', counterAmount: 5, meta: { tokenSymbol: 'USDC' } };
    const nam: Flow = { ...osmoOut('nam-live'), to: 'tnam1qother00000000000000000000000000000000', counterDenom: null, counterAmount: null, meta: { descriptor: 'transfer-from-wasm' } };
    // the Namada scan's pass: whale size 10,000 NAM, offered from 10 NAM
    await hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db }).alertFlows([osmo, usdc, nam], 10000, 10);
    expect(osmo.whale).toBeUndefined();
    expect(nam.whale).toBe(true);
    expect(calls.filter((c) => c.url === OP).map((c) => c.body.embeds[0].title)).toEqual(['🔓 MASP Unshielded: 60,000 NAM']);
    // the watcher's own NAM rule (unshield at the default 50,000) still fires on the NAM move
    expect(calls.filter((c) => c.url === WATCH).map((c) => c.body.embeds[0].title)).toEqual([
      '[WATCHLIST] 🔓 MASP Unshielded: 60,000 OSMO',
      '[WATCHLIST] 🐋 Flow [TRANSFER]: 5 USDC',
      '[UNSHIELD] 🔓 MASP Unshielded: 60,000 NAM',
    ]);
  });
});

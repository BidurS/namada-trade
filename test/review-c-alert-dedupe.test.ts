// Review C (fix-alerts): the alert claim names the move, not only its transaction, and is taken only for a move that
// will be posted. Before, `alert:tx:<chain>:<hash>:<kind>` was claimed for every move offered, before any size or
// rule check, so the first move of a kind in a transaction (an Osmosis multi-send, a Namada batch under one wrapper
// hash) held back every later move of that kind, however large, from every channel.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import { parseNamadaBlock, type NamadaBlock } from '../worker/src/parse/namada';
import { parseOsmosisTx, type NormTx } from '../worker/src/parse/osmosis';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

// LiveHub is a Durable Object; only its alert pass is exercised here, on an instance made without its constructor
// (which would open sockets and fetch prices).
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

type Hub = { alertFlows(flows: Flow[], threshold?: number, minNam?: number): Promise<void> };
const hubWith = (env: Record<string, unknown>): Hub => Object.assign(Object.create(LiveHub.prototype), { env, lastPriceUsd: null });

const KEY = base64.encode(new Uint8Array(32).fill(7));
const NOW = Date.now();
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

let calls: { url: string; body: any }[] = [];
const stubFetch = () => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
    calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 204 });
  }));
};
afterEach(() => vi.unstubAllGlobals());

const keys = (db: ReturnType<typeof testD1>) =>
  db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'alert:%' ORDER BY key").all().map((r: any) => r.key as string);

/** An Osmosis transaction with two NAM bank sends: a 100 NAM self-send first (the decoy), then 1,000,000 NAM out. */
const multiSend = (hash: string, first = 100, second = 1_000_000): NormTx => {
  const send = (from: string, to: string, nam: number) => ({
    type: 'transfer',
    attributes: [{ key: 'recipient', value: to }, { key: 'sender', value: from }, { key: 'amount', value: `${nam * 1e6}${NAM.osmoDenom}` }],
  });
  return { height: 1, hash, code: 0, ts: NOW, events: [send('osmo1v54self', 'osmo1v54self', first), send('osmo1v54self', 'osmo1v54recv', second)] };
};
const osmoCtx = () => ({ poolAddrs: new Map<string, string>(), priceUsd: null, assets: new Map() });

/** Mainnet block 8251377, read as the live scan reads it (test/unbond.test.ts block()). */
function block8251377(): NamadaBlock {
  const r = fx('namada_block_8251377.json').result;
  const blk = fx('namada_block_8251377_txs.json').result.block;
  return {
    height: 8251377,
    ts: Date.parse(blk.header.time),
    events: [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])],
  };
}

describe('review C: one move never holds back another move of the same transaction', () => {
  it('Osmosis multi-send: a 100 NAM self-send before a 1,000,000 NAM send does not hide the send', async () => {
    stubFetch();
    const db = testD1();
    configureAlerts(KEY);
    const OP = 'https://discord.com/api/webhooks/54/op';
    const WATCH = 'https://discord.com/api/webhooks/54/watch';
    const watcher: StoredSettings = { address: `tnam1qwatch${'q'.repeat(34)}`, notifications: { ...defaultPrefs(), watchlist: ['osmo1v54recv'] }, channels: { discord: { enabled: true, webhookUrl: WATCH } }, createdAt: NOW, updatedAt: NOW };
    await saveSettings(db as any, KEY, watcher);

    const flows = parseOsmosisTx(multiSend('V54TX1'), osmoCtx()).flows;
    // the parser gives each send its own move under one hash and kind: the shape the old tx-wide claim collapsed
    expect(flows.map((f) => [f.id, f.kind, f.txHash, f.amount])).toEqual([
      ['osmosis:V54TX1:xfer:0', 'transfer', 'V54TX1', 100],
      ['osmosis:V54TX1:xfer:100', 'transfer', 'V54TX1', 1_000_000],
    ]);
    // the live pass, as the stream runs it (Osmosis: whale size 10,000, offered from 100)
    await hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db }).alertFlows(flows, 10000, 100);

    expect(calls.map((c) => c.url).sort()).toEqual([OP, WATCH].sort());
    for (const c of calls) expect(c.body.embeds[0].title).toContain('1,000,000 NAM');
    // the claim names the move that was posted; the decoy, which posted nothing, holds no key
    expect(keys(db)).toEqual(['alert:flow:osmosis:V54TX1:xfer:100']);
  });

  it('Namada batch (mainnet wrapper 90D489A0…): a 50 NAM withdraw before a 20,000 NAM withdraw does not hide it', async () => {
    stubFetch();
    const db = testD1();
    const OP2 = 'https://discord.com/api/webhooks/54/op2';
    const flows = parseNamadaBlock(block8251377(), null).flows;
    expect(flows.map((f) => [f.kind, f.txHash.slice(0, 8), f.amount])).toEqual([['withdraw', '90D489A0', 50], ['withdraw', '90D489A0', 100]]);
    flows[1].amount = 20000; // the second inner tx of the batch as a whale
    for (const f of flows) await sendDiscordWhaleAlert(OP2, f, null, db as any, 10000);
    expect(calls.map((c) => c.url)).toEqual([OP2]);
    expect(calls[0].body.embeds[0].title).toContain('20,000 NAM');
    expect(keys(db)).toEqual([`alert:flow:${flows[1].id}`]);
  });

  it('two whales in one transaction are two posts', async () => {
    stubFetch();
    const db = testD1();
    const OP = 'https://discord.com/api/webhooks/54/two';
    const flows = parseOsmosisTx(multiSend('V54TX3', 500_000, 1_000_000), osmoCtx()).flows;
    await hubWith({ DISCORD_WEBHOOK_URL: OP, DB: db }).alertFlows(flows, 10000, 100);
    expect(calls.map((c) => c.body.embeds[0].title)).toEqual(['🐋 Flow [TRANSFER]: 500,000 NAM', '🐋 Flow [TRANSFER]: 1,000,000 NAM']);
  });

  it('a move the stream posted and the catch-up search finds again is posted once, in this isolate and in another', async () => {
    stubFetch();
    const db = testD1();
    const OP = 'https://discord.com/api/webhooks/54/once';
    const [, whale] = parseOsmosisTx(multiSend('V54TX4'), osmoCtx()).flows;
    await sendDiscordWhaleAlert(OP, whale, null, db as any, 10000);
    // the catch-up search parses the same transaction into the same ids (and marks them found late)
    const [, again] = parseOsmosisTx(multiSend('V54TX4'), osmoCtx()).flows;
    expect(again.id).toBe(whale.id);
    await sendDiscordWhaleAlert(OP, { ...again, meta: { via: 'catch-up search' } }, null, db as any, 10000);
    expect(calls).toHaveLength(1);
    // a fresh isolate has no memory lock: the D1 claim alone stops the repeat
    vi.resetModules();
    const fresh = await import('../worker/src/sources/discord');
    await fresh.sendDiscordWhaleAlert(OP, { ...again, meta: { via: 'catch-up search' } }, null, db as any, 10000);
    expect(calls).toHaveLength(1);
    expect(keys(db)).toEqual([`alert:flow:${whale.id}`]);
  });
});

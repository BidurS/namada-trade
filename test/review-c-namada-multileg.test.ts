// Review run 2, group C (worker/src/parse/namada.ts:parseNamadaBlock:nam-multi-leg-event-collapsed-to-largest-source-
// and-target): a NAM token/transfer event with several sources or targets is one flow per leg, each with its own
// amount, so no account is credited with another's NAM and no account of the event goes missing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { parseNamadaBlock, MASP_FEE_CAP_NAM } from '../worker/src/parse/namada';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1 } from './d1-sqlite';
import { stmt, runBatch } from '../worker/src/db';
import { configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import type { Flow } from '../shared/types';

const MASP = NAMADA.internal.masp;
afterEach(() => vi.unstubAllGlobals());

type L = [string, string]; // account, NAM base units
const ev = (hash: string, src: L[], dst: L[]) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'source-accounts', value: JSON.stringify(src.map(([a, n]) => [[`internal-address/${a}`, NAM.namadaToken], n])) },
    { key: 'target-accounts', value: JSON.stringify(dst.map(([a, n]) => [[`internal-address/${a}`, NAM.namadaToken], n])) },
  ],
});
const parse = (e: ReturnType<typeof ev>) => parseNamadaBlock({ height: 1, ts: 1, events: [e] }, null);
const sumBy = (fl: Flow[], key: 'from' | 'to', who: string) => fl.filter((f) => f[key] === who).reduce((s, f) => s + f.amount, 0);
const B = Array.from({ length: 9 }, (_, i) => `B${i + 1}`);

describe('a NAM event with several legs is one flow per leg', () => {
  it('one source, ten targets: C is credited with its own 1,000.000009 NAM, every B with its own leg, no whale', () => {
    const h = 'AA'.repeat(32);
    const p = parse(ev(h, [['O', '10000000000']], [['C', '1000000009'], ...B.map((b): L => [b, '999999999'])]));
    expect(p.flows).toHaveLength(10);
    expect(p.flows[0]).toMatchObject({ id: `namada:${h}:0`, from: 'O', to: 'C', kind: 'transfer', amount: 1000.000009 });
    for (const b of B) expect(p.flows.find((f) => f.to === b)).toMatchObject({ from: 'O', kind: 'transfer', amount: 999.999999 });
    expect(new Set(p.flows.map((f) => f.id)).size).toBe(10);
    expect(p.flows.slice(1).map((f) => f.id)).toEqual(B.map((_, k) => `namada:${h}:0:${k + 1}`));
    expect(p.flows.reduce((s, f) => s + f.amount, 0)).toBeCloseTo(10000, 6);
    expect(p.flows.some((f) => f.amount >= 10000)).toBe(false);
    expect(p.moves).toHaveLength(11);
  });

  it('every leg is stored (the one-row-per-event index takes each leg\'s own id)', async () => {
    const db = testD1();
    const p = parse(ev('A3'.repeat(32), [['O', '10000000000']], [['C', '1000000009'], ...B.map((b): L => [b, '999999999'])]));
    await runBatch(db as any, p.flows.map(stmt.flow));
    expect(db.raw.prepare("SELECT COUNT(*) n, SUM(amount_num) s FROM flows WHERE chain = 'namada'").get()).toEqual({ n: 10, s: expect.closeTo(10000, 6) });
  });

  it('the watcher of a secondary target is alerted; the operator gets no inflated whale post', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const db = testD1();
    const KEY = base64.encode(new Uint8Array(32).fill(8));
    configureAlerts(KEY);
    const watcher = (address: string, url: string, watch: string): StoredSettings => {
      const s: StoredSettings = { address, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: url } }, createdAt: 1, updatedAt: 1 };
      for (const r of Object.values(s.notifications.rules)) r.on = false; // every rule off: the watchlist alone
      s.notifications.watchlist = [watch];
      return s;
    };
    await saveSettings(db as any, KEY, watcher('tnam1qwatcherw' + 'q'.repeat(31), 'https://discord.com/api/webhooks/41/u1', 'B1'));
    await saveSettings(db as any, KEY, watcher('tnam1qwatcherv' + 'q'.repeat(31), 'https://discord.com/api/webhooks/42/u2', 'C'));
    const p = parse(ev('A4'.repeat(32), [['O', '10000000000']], [['C', '1000000009'], ...B.map((b): L => [b, '999999999'])]));
    // LiveHub.alertFlows on Namada: every flow of 10 NAM or more is offered
    for (const f of p.flows) await sendDiscordWhaleAlert('https://discord.com/api/webhooks/40/op', f, null, db as any, 10000);
    expect(calls.filter((u) => u.endsWith('/40/op'))).toHaveLength(0);
    expect(calls.filter((u) => u.endsWith('/41/u1'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/42/u2'))).toHaveLength(1);
  });

  it('several sources, one target: one flow per source with its own amount', () => {
    const p = parse(ev('A5'.repeat(32), [['X', '3000000'], ['Y', '7000000']], [['Z', '10000000']]));
    expect(p.flows.map((f) => [f.from, f.to, f.amount])).toEqual([['Y', 'Z', 7], ['X', 'Z', 3]]);
    expect(p.flows[0].meta).not.toHaveProperty('pairing');
  });

  it('an unshield to 100 targets of 10,000: 100 unshields, the pool\'s whole outflow in the flows, no fee absorbed', () => {
    const tg = Array.from({ length: 100 }, (_, i): L => [`T${i}`, '10000000000']);
    const p = parse(ev('A6'.repeat(32), [[MASP, '1000000000000']], tg));
    expect(p.flows).toHaveLength(100);
    expect(p.flows.every((f) => f.kind === 'unshield' && f.from === MASP && f.amount === 10000)).toBe(true);
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
    expect(sumBy(p.flows, 'from', MASP)).toBe(1_000_000);
  });

  it('the pool beside transparent co-sources: the pool\'s flows carry exactly the 1,000 NAM it lost', () => {
    const p = parse(ev('A7'.repeat(32), [[MASP, '1000000000'], ['X1', '999000000'], ['X2', '999000000']], [['Y', '2000000000'], ['Z', '998000000']]));
    expect(sumBy(p.flows, 'from', MASP)).toBe(1000);
    expect(p.flows.filter((f) => f.from === MASP).every((f) => f.kind === 'unshield')).toBe(true);
    for (const [who, n] of [['X1', 999], ['X2', 999]] as const) expect(sumBy(p.flows, 'from', who)).toBe(n);
    expect(sumBy(p.flows, 'to', 'Y')).toBe(2000);
    expect(sumBy(p.flows, 'to', 'Z')).toBe(998);
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
    // the pairs themselves are a reading (the event does not say who paid whom), and say so
    expect(p.flows.every((f) => f.meta?.pairing === 'largest-first')).toBe(true);
  });

  it('a shield leg smaller than a transparent leg of the same event is a shield of its own', () => {
    const p = parse(ev('A8'.repeat(32), [['X', '1010000000']], [['Y', '1000000000'], [MASP, '10000000']]));
    expect(p.flows.map((f) => [f.kind, f.from, f.to, f.amount])).toEqual([['transfer', 'X', 'Y', 1000], ['shield', 'X', MASP, 10]]);
  });

  it('a side leg above the fee cap is not a fee: two unshields, each with its own amount', () => {
    const over = String((MASP_FEE_CAP_NAM + 1) * 1e6);
    const p = parse(ev('A9'.repeat(32), [[MASP, String(1000e6 + (MASP_FEE_CAP_NAM + 1) * 1e6)]], [['U', '1000000000'], ['G', over]]));
    expect(p.flows.map((f) => [f.kind, f.to, f.amount])).toEqual([['unshield', 'U', 1000], ['unshield', 'G', MASP_FEE_CAP_NAM + 1]]);
    expect(p.flows[0].meta).not.toHaveProperty('maspFeeNam');
  });
});

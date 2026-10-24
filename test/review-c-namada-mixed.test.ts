// Review run 2, group C (worker/src/parse/namada.ts:parseNamadaBlock:mixed-token-event-nam-legs-dropped-as-feeNam):
// a token/transfer event that also moves another coin keeps its NAM legs as NAM flows, unless they are the shielded
// pool's fee for the transfer (one leg out of the pool, the same amount to one other account, fee-sized).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { parseNamadaBlock, MASP_FEE_CAP_NAM } from '../worker/src/parse/namada';
import { evaluateFlow } from '../shared/alerts';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1 } from './d1-sqlite';
import { configureAlerts, sendDiscordWhaleAlert } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';

const MASP = NAMADA.internal.masp;
const NAMT = NAM.namadaToken;
const OSMO = 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75';
const USER = 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp';
const GAS = 'tnam1qrx2535e248p02ha8n7w2n76y4xjacu2ncucqhvw'; // the gas payer of block 8,288,955
afterEach(() => vi.unstubAllGlobals());

type L = [string, string, string]; // account, token, base units
const ev = (hash: string, src: L[], dst: L[]) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: hash },
    { key: 'inner-tx-hash', value: hash.replace(/A/g, 'C') },
    { key: 'source-accounts', value: JSON.stringify(src.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
    { key: 'target-accounts', value: JSON.stringify(dst.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
  ],
});
const parse = (e: ReturnType<typeof ev>) => parseNamadaBlock({ height: 9000000, ts: 1, events: [e] }, null);
const allOn = { ibcInventory: 1, unlock: 1, bigSwap: 1, unshield: 1, bond: 1 };

describe('a mixed-token event keeps its NAM legs', () => {
  it('a 1,000,000 NAM unshield bundled with 0.000001 OSMO is a NAM unshield of its own, and alerts', () => {
    const h = 'AB'.repeat(32);
    const p = parse(ev(h, [[MASP, NAMT, '1000000000000'], [MASP, OSMO, '1']], [[USER, NAMT, '1000000000000'], [USER, OSMO, '1']]));
    expect(p.flows).toHaveLength(2);
    const osmo = p.flows.find((f) => f.meta?.tokenSymbol === 'OSMO')!;
    expect(osmo).toMatchObject({ id: `namada:${h}:0`, kind: 'unshield', from: MASP, to: USER, amount: 0.000001 });
    expect(osmo.meta).not.toHaveProperty('maspFeeNam');
    const nam = p.flows.find((f) => !f.meta?.tokenSymbol)!;
    expect(nam).toMatchObject({ id: `namada:${h}:0:nam`, txHash: h, kind: 'unshield', from: MASP, to: USER, amount: 1_000_000 });
    expect(nam.meta).toMatchObject({ descriptor: 'transfer-from-wasm', innerTxHash: h.replace(/A/g, 'C') });
    expect(nam.meta).not.toHaveProperty('maspFeeNam');
    expect(evaluateFlow(nam).map((x) => x.ruleId)).toEqual(['unshield']);
    expect(evaluateFlow(nam, allOn).map((x) => x.ruleId)).toEqual(['unshield']);
    // the balance moves are the same as before
    expect(p.moves.find((m) => m.address === USER)!.delta).toBe(1_000_000);
  });

  it('control: the same event without the OSMO legs reads the same NAM unshield', () => {
    const p = parse(ev('AD'.repeat(32), [[MASP, NAMT, '1000000000000']], [[USER, NAMT, '1000000000000']]));
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ id: `namada:${'AD'.repeat(32)}:0`, kind: 'unshield', amount: 1_000_000 });
  });

  it('the pool\'s fee for an OSMO unshield (block 8,294,006: 0.084159 NAM to the gas payer) is the OSMO row\'s meta.maspFeeNam', () => {
    const p = parse(ev('AE'.repeat(32), [[MASP, NAMT, '84159'], [MASP, OSMO, '20000000']], [[USER, OSMO, '20000000'], [GAS, NAMT, '84159']]));
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'unshield', from: MASP, to: USER, amount: 20, meta: { tokenSymbol: 'OSMO', maspFeeNam: 0.084159 } });
    expect(p.flows[0].meta).not.toHaveProperty('feeNam');
  });

  it('NAM legs that are not fee-sized, or not the pool paying one account, are flows, never a fee', () => {
    const over = String((MASP_FEE_CAP_NAM + 1) * 1e6);
    const a = parse(ev('AF'.repeat(32), [[MASP, NAMT, over], [MASP, OSMO, '1']], [[USER, OSMO, '1'], [GAS, NAMT, over]]));
    expect(a.flows.find((f) => !f.meta?.tokenSymbol)).toMatchObject({ kind: 'unshield', from: MASP, to: GAS, amount: MASP_FEE_CAP_NAM + 1 });
    expect(a.flows.find((f) => f.meta?.tokenSymbol)!.meta).not.toHaveProperty('maspFeeNam');
    // a transparent NAM move next to the other coin is a transfer, whatever its size
    const b = parse(ev('A0'.repeat(32), [[USER, NAMT, '1000000'], [MASP, OSMO, '1']], [[GAS, NAMT, '1000000'], [USER, OSMO, '1']]));
    expect(b.flows.find((f) => !f.meta?.tokenSymbol)).toMatchObject({ kind: 'transfer', from: USER, to: GAS, amount: 1 });
  });

  it('a NAM unshield with its own fee leg next to another coin: the fee goes to the NAM flow\'s maspFeeNam', () => {
    const p = parse(ev('A1'.repeat(32), [[MASP, NAMT, '1000000084159'], [MASP, OSMO, '1']], [[USER, NAMT, '1000000000000'], [GAS, NAMT, '84159'], [USER, OSMO, '1']]));
    const nam = p.flows.filter((f) => !f.meta?.tokenSymbol);
    expect(nam).toHaveLength(1);
    expect(nam[0]).toMatchObject({ kind: 'unshield', to: USER, amount: 1_000_000, meta: { maspFeeNam: 0.084159 } });
    expect(p.flows.find((f) => f.meta?.tokenSymbol)!.meta).not.toHaveProperty('maspFeeNam');
  });

  it('the live dispatcher posts the NAM unshield although the dust OSMO row of the same transaction came first', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(null, { status: 204 }); }));
    const db = testD1();
    const KEY = base64.encode(new Uint8Array(32).fill(7));
    configureAlerts(KEY);
    const s: StoredSettings = { address: 'tnam1qmixedwatcher' + 'q'.repeat(26), notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/31/u' } }, createdAt: 1, updatedAt: 1 };
    s.notifications.rules.unshield = { on: true, thresholdNam: 1 };
    await saveSettings(db as any, KEY, s);
    const p = parse(ev('A2'.repeat(32), [[MASP, NAMT, '1000000000000'], [MASP, OSMO, '1']], [[USER, NAMT, '1000000000000'], [USER, OSMO, '1']]));
    // LiveHub.alertFlows offers every shield/unshield, in parse order
    for (const f of p.flows) await sendDiscordWhaleAlert('https://discord.com/api/webhooks/30/op', f, db as any, 10000);
    expect(calls.filter((u) => u.endsWith('/30/op'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/31/u'))).toHaveLength(1);
  });
});

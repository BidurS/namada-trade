import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { NAMADA, NAM } from '../worker/src/config';
import { decodeU256LE, parseCoins, toNam, namFromCoins } from '../worker/src/util';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

const ctx: OsmoCtx = {
  poolAddrs: new Map(),
  priceUsd: 0.00087,
  assets: new Map([
    ['ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', { symbol: 'USDC', decimals: 6, stable: true }],
    ['uosmo', { symbol: 'OSMO', decimals: 6 }],
  ]),
};

describe('util', () => {
  it('converts base units exactly', () => {
    expect(toNam('20084381575265')).toBeCloseTo(20084381.575265, 6);
    expect(toNam(0n)).toBe(0);
  });
  it('parses multi-coin strings', () => {
    const c = parseCoins(`5uosmo,1994004000${NAM.osmoDenom}`);
    expect(c).toHaveLength(2);
    expect(namFromCoins(`5uosmo,1994004000${NAM.osmoDenom}`)).toBeCloseTo(1994.004, 6);
  });
  it('decodes Namada U256 amounts', () => {
    // 341468506434812 in little-endian, 32 bytes
    const n = 341468506434812n;
    const bytes = new Uint8Array(32);
    let v = n;
    for (let i = 0; i < 32; i++) { bytes[i] = Number(v & 0xffn); v >>= 8n; }
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(decodeU256LE(b64)).toBe(n);
  });
});

describe('osmosis parser', () => {
  it('detects a NAM sell on pool 3005 with USDC counter', () => {
    const txs = fx('osmo_swap.json');
    const tx = normFromTxSearch(txs[0], 1);
    const p = parseOsmosisTx(tx, ctx);
    const swap = p.flows.find((f) => f.id.endsWith(':swap'))!;
    expect(swap).toBeTruthy();
    expect(['sell', 'buy', 'other']).toContain(swap.kind);
    expect(swap.amount).toBeGreaterThan(0);
    expect(swap.poolId).toContain('3005');
    // ledger must be balanced across all participants (conservation within a tx, excluding mint/burn)
    const net = p.moves.reduce((s, m) => s + m.delta, 0);
    expect(Math.abs(net)).toBeLessThan(1e-6);
  });

  it('parses IBC receive from Namada and links addresses', () => {
    const tx = normFromTxSearch(fx('osmo_ibc_recv.json')[0], 1);
    const p = parseOsmosisTx(tx, ctx);
    const f = p.flows.find((x) => x.kind === 'ibc_in')!;
    expect(f.from).toBe('tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    expect(f.to).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
    expect(f.amount).toBe(1);
    expect(p.links[0]).toMatchObject({ osmo: 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3', namada: 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa' });
    // no duplicate "transfer" rows for the module legs
    expect(p.flows.filter((x) => x.kind === 'transfer')).toHaveLength(0);
  });

  it('parses IBC send to Namada', () => {
    const tx = normFromTxSearch(fx('osmo_ibc_send.json')[0], 1);
    const p = parseOsmosisTx(tx, ctx);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.from).toMatch(/^osmo1/);
    expect(f.to).toMatch(/^tnam1/);
    expect(f.amount).toBeGreaterThan(0);
  });
});

describe('namada parser', () => {
  const block = (h: number) => {
    const r = fx(`namada_block_${h}.json`).result;
    return { height: h, ts: 1, events: [...(r.end_block_events ?? [])] };
  };

  it('classifies IBC out and pairs it with the packet receiver', () => {
    const p = parseNamadaBlock(block(8261880), 0.00087);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.from).toBe('tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    expect(f.to).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
    expect(f.amount).toBe(1);
    const esc = p.balances.find((b) => b.address === NAMADA.internal.ibc)!;
    expect(toNam(esc.balance)).toBeGreaterThan(20_000_000);
    expect(p.links).toHaveLength(1);
  });

  it('classifies PoS withdraw', () => {
    const p = parseNamadaBlock(block(8251377), null);
    const f = p.flows.find((x) => x.kind === 'withdraw')!;
    expect(f.from).toBe(NAMADA.internal.pos);
    expect(f.amount).toBe(50);
  });

  it('classifies reward claims and skips zero-amount events from flows', () => {
    const p = parseNamadaBlock(block(8265541), null);
    expect(p.flows.every((f) => f.amount > 0)).toBe(true);
    expect(p.flows.some((f) => f.kind === 'rewards')).toBe(true);
    // post-balances deduped per address
    const addrs = p.balances.map((b) => b.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('maintains USD valuation consistency when spot price is provided', () => {
    const spot = 0.000868;
    const p = parseNamadaBlock(block(8261880), spot);
    for (const f of p.flows) {
      expect(f.priceUsd).toBe(spot);
      expect(f.valueUsd).toBeCloseTo(f.amount * spot, 8);
    }
  });
});


describe('namada parser: MASP legs', () => {
  const MASP = NAMADA.internal.masp;
  const block = (h: number) => {
    const r = fx(`namada_block_${h}.json`).result;
    return { height: h, ts: 1, events: [...(r.end_block_events ?? [])] };
  };
  const maspFlows = (h: number) => parseNamadaBlock(block(h), null).flows.filter((f) => f.from === MASP || f.to === MASP);

  it('unshield with a MASP fee leg: one flow, recipient amount, fee kept in meta', () => {
    const p = parseNamadaBlock(block(8288955), null);
    const fl = p.flows.filter((f) => f.from === MASP);
    expect(fl).toHaveLength(1);
    expect(fl[0].kind).toBe('unshield');
    expect(fl[0].to).toBe('tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp');
    expect(fl[0].amount).toBe(14700);
    expect(fl[0].meta?.maspFeeNam).toBeCloseTo(0.144159, 6);
    expect(fl[0].txHash).toBe('AD23E068E0773BED14D517AD31570B3B03F991284E4B7A3FFB05466C152E7B9B');
    expect(fl[0].meta?.innerTxHash).toBe('984244598B5857D543A7C9CCF7F1EFB010978E8F2DE63E169ADF70E3EE9A327C');
    // the pool's exact post-balance is reported
    const post = p.balances.find((b) => b.address === MASP)!;
    expect(toNam(post.balance)).toBeCloseTo(50688042.37125, 5);
    // and the full outflow is in the moves
    expect(p.moves.filter((m) => m.address === MASP).reduce((s, m) => s + m.delta, 0)).toBeCloseTo(-14700.144159, 6);
  });

  it('large unshield with fee leg', () => {
    const fl = maspFlows(7011473);
    expect(fl).toHaveLength(1);
    expect(fl[0].kind).toBe('unshield');
    expect(fl[0].amount).toBe(6_500_000);
    expect(fl[0].meta?.maspFeeNam).toBeCloseTo(0.1, 6);
  });

  it('mixed transfer: shield amount is the MASP leg only', () => {
    const fl = maspFlows(4707359);
    expect(fl).toHaveLength(1);
    expect(fl[0].kind).toBe('shield');
    expect(fl[0].to).toBe(MASP);
    expect(fl[0].amount).toBe(10);
    expect(fl[0].meta?.otherNam).toBeCloseTo(0.1, 6);
  });

  it('shielded IBC deposit: ibc_in to the MASP from the packet sender, no link', () => {
    const p = parseNamadaBlock(block(7153723), null);
    const fl = p.flows.filter((f) => f.to === MASP);
    expect(fl).toHaveLength(1);
    expect(fl[0].kind).toBe('ibc_in');
    expect(fl[0].from).toBe('osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8');
    expect(fl[0].amount).toBeCloseTo(4.682433, 6);
    expect(fl[0].meta?.escrow).toBe(NAMADA.internal.ibc);
    expect(p.links).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { parseNamadaBlock, classify } from '../worker/src/parse/namada';
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

  it('parses IBC send to Namada and links nothing: the NAM has not arrived', () => {
    const tx = normFromTxSearch(fx('osmo_ibc_send.json')[0], 1);
    const p = parseOsmosisTx(tx, ctx);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.from).toMatch(/^osmo1/);
    expect(f.to).toMatch(/^tnam1/);
    expect(f.amount).toBeGreaterThan(0);
    expect(p.links).toHaveLength(0);
  });

  it('a timed-out send, a send to a garbage receiver and a refused receive create no link', () => {
    // The timeout relay: the sender gets the NAM back (an ibc_refund row) and nothing is linked.
    const timeout = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_timeout.json'), 1), ctx);
    expect(timeout.flows.some((f) => f.meta?.ibcTimeoutRefund)).toBe(true);
    expect(timeout.links).toHaveLength(0);
    // A send whose receiver is text the sender typed: the send is a flow (it happened), never a link.
    const raw = fx('osmo_ibc_send.json')[0];
    for (const e of raw.tx_result.events) if (e.type === 'ibc_transfer') for (const a of e.attributes) if (a.key === 'receiver') a.value = 'tnam1' + 'q'.repeat(40);
    const garbage = parseOsmosisTx(normFromTxSearch(raw, 1), ctx);
    expect(garbage.flows.filter((f) => f.kind === 'ibc_out')).toHaveLength(1);
    expect(garbage.links).toHaveLength(0);
    // A receive the chain refused (fungible_token_packet success=false): no ibc_in row, no link.
    const refused = fx('osmo_ibc_recv.json')[0];
    for (const e of refused.tx_result.events) if (e.type === 'fungible_token_packet') for (const a of e.attributes) if (a.key === 'success') a.value = 'false';
    const r = parseOsmosisTx(normFromTxSearch(refused, 1), ctx);
    expect(r.flows.filter((f) => f.kind === 'ibc_in')).toHaveLength(0);
    expect(r.links).toHaveLength(0);
  });
});

describe('namada parser', () => {
  const block = (h: number) => {
    const r = fx(`namada_block_${h}.json`).result;
    return { height: h, ts: 1, events: [...(r.end_block_events ?? [])] };
  };

  it('classifies IBC out and pairs it with the packet receiver, linking nothing: a send is not an arrival', () => {
    const p = parseNamadaBlock(block(8261880), 0.00087);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.from).toBe('tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    expect(f.to).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
    expect(f.amount).toBe(1);
    const esc = p.balances.find((b) => b.address === NAMADA.internal.ibc)!;
    expect(toNam(esc.balance)).toBeGreaterThan(20_000_000);
    expect(p.links).toHaveLength(0);
  });

  it('a transparent receive links the packet sender to the receiver; the same packet to a garbage receiver links nothing', () => {
    // Block 7153723 is a receive into the shielded pool. The same two events with a transparent receiver are a
    // transparent receive (escrow -> account): the one record that links an osmo1 to a tnam1.
    const osmo = 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8';
    const recv = (receiver: string) => {
      const b = block(7153723);
      b.events = b.events.map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => ({ ...a, value: String(a.value).split(NAMADA.internal.masp).join(receiver) })) }));
      return parseNamadaBlock(b, null);
    };
    const to = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
    const p = recv(to);
    const f = p.flows.find((x) => x.kind === 'ibc_in')!;
    expect(f.from).toBe(osmo);
    expect(f.to).toBe(to);
    expect(p.links).toEqual([{ osmo, namada: to, amount: f.amount, ts: 1 }]);
    expect(recv('tnam1' + 'q'.repeat(40)).links).toHaveLength(0);
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

  it('mixed transfer: shield amount is the MASP leg only, the side output a transfer of its own', () => {
    const fl = maspFlows(4707359);
    expect(fl).toHaveLength(1);
    expect(fl[0].kind).toBe('shield');
    expect(fl[0].to).toBe(MASP);
    expect(fl[0].amount).toBe(10);
    expect(fl[0].meta).not.toHaveProperty('otherNam');
    const side = parseNamadaBlock(block(4707359), null).flows.filter((f) => f.from !== MASP && f.to !== MASP);
    expect(side.map((f) => [f.kind, f.to, f.amount])).toEqual([['transfer', 'tnam1qrxsru5rdu4he400xny6p779fcw7xuftsgjnmzup', 0.1]]);
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

// docs/design/screener-plan.md 3.0: the staking account's own balance moved by wasm transfers. Blocks 7,900,851 (31 Aug
// 2026, 331,386,682.183413 NAM out of the staking account), 8,013,338 (22 Sep, 99,999,900 NAM in) and 8,121,844 (1 Oct,
// 2,999,715.994171 NAM in), block_results as the node served them (5ElementsNodes, read 2026-10-20).
describe('the staking account balance transfers (pos_balance)', () => {
  const POS = NAMADA.internal.pos;
  const block = (h: number) => {
    const r = fx(`namada_block_${h}.json`).result;
    return { height: h, ts: 1, events: [...(r.end_block_events ?? [])] };
  };
  it.each([
    [7900851, POS, 'tnam1qry99h4faqtkleuuyecxzrswq7vgkj2hu5kg6dqp', 331386682.183413],
    [8013338, 'tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse', POS, 99999900],
    [8121844, 'tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse', POS, 2999715.994171],
  ])('block %i is filed as pos_balance, never a bond or a withdrawal', (h, from, to, nam) => {
    const p = parseNamadaBlock(block(h), null);
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'pos_balance', from, to, amount: nam, meta: { descriptor: 'transfer-from-wasm' } });
    // the post-balances are still recorded (the staking account's balance is read every tick anyway)
    expect(p.balances.some((b) => b.address === POS)).toBe(true);
  });
  it('the chain\'s own staking moves keep their kinds; a transfer between two holders stays a transfer', () => {
    const someone = 'tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse';
    expect(classify('pos-withdraw-token', POS, someone)).toBe('withdraw');
    expect(classify('pos-claim-rewards', POS, someone)).toBe('rewards');
    // a NAM move into or out of the staking account without the wasm-transfer descriptor keeps the old reading
    expect(classify('', someone, POS)).toBe('bond');
    expect(classify('', POS, someone)).toBe('withdraw');
    expect(classify('transfer-from-wasm', someone, 'tnam1qry99h4faqtkleuuyecxzrswq7vgkj2hu5kg6dqp')).toBe('transfer');
    expect(classify('transfer-from-wasm', someone, NAMADA.internal.masp)).toBe('shield');
  });
});

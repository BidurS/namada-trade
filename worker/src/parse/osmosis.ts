import { NAM, OSMOSIS } from '../config';
import { namFromCoins, parseCoins, isRealAddress } from '../util';
import type { Flow, Move } from '../../../shared/types';

export interface RawEvent {
  type: string;
  attributes: { key: string; value: string }[];
}

export interface NormTx {
  height: number;
  hash: string;
  code: number;
  ts: number;
  events: RawEvent[];
}

export interface OsmoCtx {
  /** pool address -> pool id */
  poolAddrs: Map<string, string>;
  /** current NAM/USD (fallback when the counter asset is not a stable) */
  priceUsd: number | null;
  /** denom -> { symbol, decimals } */
  assets: Map<string, { symbol: string; decimals: number; stable?: boolean }>;
}

/** Normalize a tx_search result entry */
export function normFromTxSearch(t: any, ts: number): NormTx {
  return {
    height: Number(t.height),
    hash: String(t.hash).toUpperCase(),
    code: Number(t.tx_result?.code ?? 0),
    ts,
    events: (t.tx_result?.events ?? []) as RawEvent[],
  };
}

/** Normalize a websocket `tm.event='Tx'` message */
export function normFromWs(msg: any, ts: number): NormTx | null {
  const tr = msg?.result?.data?.value?.TxResult;
  if (!tr) return null;
  const hash = msg?.result?.events?.['tx.hash']?.[0] ?? '';
  return {
    height: Number(tr.height),
    hash: String(hash).toUpperCase(),
    code: Number(tr.result?.code ?? 0),
    ts,
    events: (tr.result?.events ?? []) as RawEvent[],
  };
}

/** Attributes as ordered list of groups. Handles both one-transfer-per-event and legacy batched events. */
function attrGroups(e: RawEvent, firstKey: string): Record<string, string>[] {
  const groups: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  for (const { key, value } of e.attributes) {
    if (key === firstKey && cur[firstKey] !== undefined) {
      groups.push(cur);
      cur = {};
    }
    cur[key] = value;
  }
  if (Object.keys(cur).length) groups.push(cur);
  // carry msg_index to all groups
  const mi = groups.find((g) => g.msg_index !== undefined)?.msg_index;
  if (mi !== undefined) groups.forEach((g) => (g.msg_index ??= mi));
  return groups;
}

function attrs(e: RawEvent): Record<string, string> {
  const o: Record<string, string> = {};
  for (const { key, value } of e.attributes) o[key] = value;
  return o;
}

function signerOf(tx: NormTx): string | null {
  for (const e of tx.events) {
    if (e.type === 'tx') {
      const a = attrs(e);
      if (a.fee_payer) return a.fee_payer;
    }
  }
  for (const e of tx.events) {
    if (e.type === 'message') {
      const a = attrs(e);
      if (a.sender && a.action) return a.sender;
    }
  }
  for (const e of tx.events) {
    if (e.type === 'message') {
      const a = attrs(e);
      if (a.sender) return a.sender;
    }
  }
  return null;
}

function counterOf(coins: string, ctx: OsmoCtx) {
  const c = parseCoins(coins).find((x) => x.denom !== NAM.osmoDenom);
  if (!c) return null;
  const meta = ctx.assets.get(c.denom);
  const decimals = meta?.decimals ?? 6;
  return {
    denom: c.denom,
    symbol: meta?.symbol ?? shortDenom(c.denom),
    amount: Number(c.amount) / 10 ** decimals,
    stable: !!meta?.stable,
  };
}

export function shortDenom(d: string): string {
  if (d === 'uosmo') return 'OSMO';
  if (d.startsWith('ibc/')) return d.slice(0, 10) + '…';
  if (d.startsWith('factory/')) return d.split('/').pop() ?? d;
  return d;
}

export interface OsmoParsed {
  moves: Move[];
  flows: Flow[];
  links: { osmo: string; namada: string; amount: number; ts: number }[];
}

export function parseOsmosisTx(tx: NormTx, ctx: OsmoCtx): OsmoParsed {
  const out: OsmoParsed = { moves: [], flows: [], links: [] };
  if (tx.code !== 0) return out;

  // ---- 1. Raw ledger from bank events ----
  const namTransfers: { from: string; to: string; amount: number; idx: number }[] = [];
  tx.events.forEach((e, i) => {
    if (e.type === 'transfer') {
      attrGroups(e, 'recipient').forEach((g, j) => {
        const amt = namFromCoins(g.amount);
        if (amt > 0 && g.sender && g.recipient) {
          const idx = i * 100 + j;
          namTransfers.push({ from: g.sender, to: g.recipient, amount: amt, idx });
          out.moves.push(mv(tx, g.sender, -amt, idx), mv(tx, g.recipient, amt, idx));
        }
      });
    } else if (e.type === 'coinbase' || e.type === 'burn') {
      const a = attrs(e);
      const amt = namFromCoins(a.amount);
      const who = e.type === 'coinbase' ? a.minter : a.burner;
      if (amt > 0 && who) out.moves.push(mv(tx, who, e.type === 'coinbase' ? amt : -amt, i * 100 + 99));
    }
  });

  const signer = signerOf(tx);

  // ---- 2. Swaps ----
  let namSold = 0;
  let namBought = 0;
  let sellCounter: ReturnType<typeof counterOf> = null;
  let buyCounter: ReturnType<typeof counterOf> = null;
  const pools = new Set<string>();
  for (const e of tx.events) {
    if (e.type !== 'token_swapped') continue;
    const a = attrs(e);
    const inNam = namFromCoins(a.tokens_in);
    const outNam = namFromCoins(a.tokens_out);
    if (inNam > 0) {
      namSold += inNam;
      sellCounter ??= counterOf(a.tokens_out, ctx);
      pools.add(a.pool_id);
    }
    if (outNam > 0) {
      namBought += outNam;
      buyCounter ??= counterOf(a.tokens_in, ctx);
      pools.add(a.pool_id);
    }
  }
  const isSwap = namSold > 0 || namBought > 0;
  if (isSwap) {
    const net = namBought - namSold;
    const gross = Math.max(namBought, namSold);
    const isArb = namSold > 0 && namBought > 0 && Math.abs(net) < gross * 0.05;
    const kind = isArb ? 'other' : net > 0 ? 'buy' : 'sell';
    const amount = isArb ? gross : Math.abs(net);
    const counter = kind === 'buy' ? buyCounter : sellCounter;
    let priceUsd = ctx.priceUsd;
    if (counter?.stable && amount > 0 && !isArb) priceUsd = counter.amount / amount;
    out.flows.push({
      id: `osmosis:${tx.hash}:swap`,
      chain: 'osmosis',
      height: tx.height,
      ts: tx.ts,
      txHash: tx.hash,
      kind,
      from: kind === 'buy' ? null : signer,
      to: kind === 'buy' ? signer : null,
      amount,
      counterDenom: counter?.symbol ?? null,
      counterAmount: counter?.amount ?? null,
      poolId: [...pools].join(','),
      priceUsd,
      valueUsd: priceUsd != null ? priceUsd * amount : null,
      meta: isArb ? { arb: true, namSold, namBought } : { trader: signer },
    });
  }

  // ---- 3. IBC ----
  // Packet sequences of this tx's sends on the NAM channel, by message index, so a bridge-out row can be matched to
  // a later timeout refund of the same packet.
  const sendSeq = new Map<string, string>();
  for (const e of tx.events) {
    if (e.type !== 'send_packet') continue;
    const a = attrs(e);
    if (a.packet_src_channel === NAM.osmoChannel && a.packet_sequence) sendSeq.set(a.msg_index ?? '', a.packet_sequence);
  }
  const seqFor = (msgIndex: string | undefined) => sendSeq.get(msgIndex ?? '') ?? (sendSeq.size === 1 ? [...sendSeq.values()][0] : undefined);
  tx.events.forEach((e, i) => {
    if (e.type === 'recv_packet') {
      const a = attrs(e);
      if (a.packet_dst_channel && a.packet_dst_channel !== NAM.osmoChannel) return;
      const pd = safeJson(a.packet_data);
      if (!pd || !String(pd.denom).endsWith(NAM.namadaToken)) return;
      // only count successful receives
      const ok = tx.events.some((x) => x.type === 'fungible_token_packet' && attrs(x).success === 'true');
      if (!ok) return;
      const amount = Number(pd.amount) / 10 ** NAM.decimals;
      out.flows.push(flow(tx, `ibc_in:${i}`, 'ibc_in', pd.sender, pd.receiver, amount, ctx.priceUsd, { memo: pd.memo, channel: NAM.osmoChannel }));
      // A link joins two real accounts only (the packet's sender and receiver are text the sender chose).
      if (isRealAddress(pd.receiver) === 'osmosis' && isRealAddress(pd.sender) === 'namada') out.links.push({ osmo: pd.receiver, namada: pd.sender, amount, ts: tx.ts });
    } else if (e.type === 'ibc_transfer') {
      const a = attrs(e);
      if (a.denom !== NAM.osmoDenom) return;
      const amount = Number(a.amount) / 10 ** NAM.decimals;
      const seq = seqFor(a.msg_index);
      out.flows.push(flow(tx, `ibc_out:${i}`, 'ibc_out', a.sender, a.receiver, amount, ctx.priceUsd, { memo: a.memo, channel: NAM.osmoChannel, ...(seq ? { packetSequence: seq } : {}) }));
      if (isRealAddress(a.receiver) === 'namada' && isRealAddress(a.sender) === 'osmosis') out.links.push({ osmo: a.sender, namada: a.receiver, amount, ts: tx.ts });
    } else if (e.type === 'timeout_packet') {
      const a = attrs(e);
      if (a.packet_src_channel === NAM.osmoChannel) {
        // The transfer module's 'timeout' event of the same message names who got the NAM back; the tx signer is
        // only the relayer that delivered the timeout.
        const te = tx.events.map(attrs).find((x, k) => tx.events[k].type === 'timeout' && (x.msg_index ?? '') === (a.msg_index ?? '') && x.refund_receiver);
        const receiver = te?.refund_receiver ?? null;
        const refund = te?.refund_amount && String(te.refund_denom ?? '').endsWith(NAM.namadaToken)
          ? Number(te.refund_amount) / 10 ** NAM.decimals
          : namTransfers.filter((t) => t.from === OSMOSIS.transferModule && (!receiver || t.to === receiver)).reduce((s, t) => s + t.amount, 0);
        if (refund > 0) {
          out.flows.push(flow(tx, `ibc_refund:${i}`, 'other', OSMOSIS.transferModule, receiver ?? signer, refund, ctx.priceUsd, {
            ibcTimeoutRefund: true, channel: NAM.osmoChannel,
            ...(a.packet_sequence ? { packetSequence: a.packet_sequence } : {}),
            ...(receiver ? { refundReceiver: receiver } : { relayer: signer }),
          }));
        }
      }
    }
  });
  const isIbc = out.flows.some((f) => f.kind === 'ibc_in' || f.kind === 'ibc_out');

  // ---- 4. LP + plain transfers (only if not explained by swap) ----
  if (!isSwap) {
    let lpAdd = 0, lpRemove = 0;
    const lpPools = new Set<string>();
    for (const t of namTransfers) {
      const toPool = ctx.poolAddrs.get(t.to);
      const fromPool = ctx.poolAddrs.get(t.from);
      if (toPool) { lpAdd += t.amount; lpPools.add(toPool); continue; }
      if (fromPool) { lpRemove += t.amount; lpPools.add(fromPool); continue; }
      if (isIbc && (t.from === OSMOSIS.transferModule || t.to === OSMOSIS.transferModule)) continue;
      if (t.from === OSMOSIS.transferModule || t.to === OSMOSIS.transferModule) continue;
      out.flows.push(flow(tx, `xfer:${t.idx}`, 'transfer', t.from, t.to, t.amount, ctx.priceUsd, null));
    }
    if (lpAdd > 0) out.flows.push({ ...flow(tx, 'lp_add', 'lp_add', signer, null, lpAdd, ctx.priceUsd, null), poolId: [...lpPools].join(',') });
    if (lpRemove > 0) out.flows.push({ ...flow(tx, 'lp_remove', 'lp_remove', null, signer, lpRemove, ctx.priceUsd, null), poolId: [...lpPools].join(',') });
  }

  return out;
}

function mv(tx: NormTx, address: string, delta: number, idx: number): Move {
  return { chain: 'osmosis', address, height: tx.height, ts: tx.ts, txHash: tx.hash, idx, delta };
}

function flow(
  tx: NormTx, suffix: string, kind: Flow['kind'], from: string | null, to: string | null,
  amount: number, priceUsd: number | null, meta: Record<string, unknown> | null,
): Flow {
  return {
    id: `osmosis:${tx.hash}:${suffix}`,
    chain: 'osmosis',
    height: tx.height,
    ts: tx.ts,
    txHash: tx.hash,
    kind,
    from,
    to,
    amount,
    priceUsd,
    valueUsd: priceUsd != null ? priceUsd * amount : null,
    meta,
  };
}

function safeJson(s: string | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

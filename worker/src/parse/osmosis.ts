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

/**
 * A label for a coin the asset map does not know. A tokenfactory coin is named by anyone who creates one
 * (factory/<creator>/<any name>), so its label keeps the factory path and its creator: a coin someone called "USDC"
 * must never read as USDC, which only the asset map's Noble USDC may be.
 */
export function shortDenom(d: string): string {
  if (d === 'uosmo') return 'OSMO';
  if (d === OSMOSIS.allUsdc) return 'allUSDC';
  if (d.startsWith('ibc/')) return d.slice(0, 10) + '…';
  if (d.startsWith('factory/')) {
    const [, creator = '', ...name] = d.split('/');
    return `factory/${creator.slice(0, 10)}…/${name.join('/')}`;
  }
  return d;
}

/** The NAM in a coin string, in base units (exact, for matching a swap's amounts with its bank legs). */
function namBase(coins: string | undefined): bigint {
  return parseCoins(coins).filter((c) => c.denom === NAM.osmoDenom).reduce((a, c) => a + BigInt(c.amount), 0n);
}

export interface OsmoParsed {
  moves: Move[];
  flows: Flow[];
  links: { osmo: string; namada: string; amount: number; ts: number }[];
}

export function parseOsmosisTx(tx: NormTx, ctx: OsmoCtx): OsmoParsed {
  const out: OsmoParsed = { moves: [], flows: [], links: [] };
  if (tx.code !== 0) return out;

  // Every event's attributes, and the message it belongs to (msg_index; '' for the transaction's own events, the
  // post-handler's, and every event of an old transaction that predates msg_index). A transaction can carry several
  // messages, so a fact about one message (a swap, a packet's outcome, its channel) is read only from that message.
  const ev = tx.events.map(attrs);
  const msgOf = ev.map((a) => a.msg_index ?? '');
  /** The events of `type` after event `i` in its message, up to that message's next event of i's own type. */
  const after = (i: number, type: string) => {
    const found: Record<string, string>[] = [];
    for (let k = i + 1; k < tx.events.length; k++) {
      if (msgOf[k] !== msgOf[i]) continue;
      if (tx.events[k].type === tx.events[i].type) break;
      if (tx.events[k].type === type) found.push(ev[k]);
    }
    return found;
  };
  /** The nearest event of `type` before event `i` in its message, not past that message's previous event of i's own type. */
  const before = (i: number, type: string) => {
    for (let k = i - 1; k >= 0; k--) {
      if (msgOf[k] !== msgOf[i]) continue;
      if (tx.events[k].type === tx.events[i].type) return null;
      if (tx.events[k].type === type) return ev[k];
    }
    return null;
  };

  // ---- 1. Raw ledger from bank events ----
  // Every bank transfer in order (any coin: a swap's legs are told apart by their neighbours); `base` is its NAM.
  const transfers: { from: string; to: string; amount: number; base: bigint; idx: number; ev: number; msg: string }[] = [];
  tx.events.forEach((e, i) => {
    if (e.type === 'transfer') {
      attrGroups(e, 'recipient').forEach((g, j) => {
        if (!g.sender || !g.recipient) return;
        const idx = i * 100 + j;
        const base = namBase(g.amount), amt = namFromCoins(g.amount);
        transfers.push({ from: g.sender, to: g.recipient, amount: amt, base, idx, ev: i, msg: g.msg_index ?? '' });
        if (base > 0n) out.moves.push(mv(tx, g.sender, -amt, idx), mv(tx, g.recipient, amt, idx));
      });
    } else if (e.type === 'coinbase' || e.type === 'burn') {
      const a = ev[i];
      const amt = namFromCoins(a.amount);
      const who = e.type === 'coinbase' ? a.minter : a.burner;
      if (amt > 0 && who) out.moves.push(mv(tx, who, e.type === 'coinbase' ? amt : -amt, i * 100 + 99));
    }
  });
  const namTransfers = transfers.filter((t) => t.base > 0n);

  const signer = signerOf(tx);

  // ---- 2. Swaps ----
  // One leg per NAM-moving token_swapped event: which way the NAM went, through which pool, against what.
  const legs: { pool: string; side: 'sell' | 'buy'; nam: number; counter: ReturnType<typeof counterOf> }[] = [];
  // The NAM bank legs that are a swap's own (they are the swap, not transfers), and the messages that swapped NAM.
  // Each token_swapped event comes after the bank legs of its hop (the poolmanager, test/fixtures/osmo_swap.json):
  // NAM in is the taker fee to the taker-fee collector, then exactly tokens_in into the pool, then (a concentrated
  // pool) the spread reward to the pool's spread account, then the other coin out of the pool; NAM out is exactly
  // tokens_out from the pool to the swapper. Nothing else can sit between those legs, so a send placed in the same
  // message (authz, a contract) is never mistaken for one of them.
  const swapLegIdx = new Set<number>();
  const swapMsgs = new Set<string>();
  /** Messages with a NAM swap whose bank legs could not be told apart (an old event shape): all their NAM legs are the swap's, as before. */
  const unmatchedMsgs = new Set<string>();
  const prevSwap = new Map<string, number>();
  tx.events.forEach((e, i) => {
    if (e.type !== 'token_swapped') return;
    const a = ev[i];
    const m = msgOf[i];
    const from = prevSwap.get(m) ?? -1;
    prevSwap.set(m, i);
    const inBase = namBase(a.tokens_in), outBase = namBase(a.tokens_out);
    if (inBase > 0n) legs.push({ pool: a.pool_id, side: 'sell', nam: namFromCoins(a.tokens_in), counter: counterOf(a.tokens_out, ctx) });
    if (outBase > 0n) legs.push({ pool: a.pool_id, side: 'buy', nam: namFromCoins(a.tokens_out), counter: counterOf(a.tokens_in, ctx) });
    if (inBase === 0n && outBase === 0n) return;
    swapMsgs.add(m);
    const w = transfers.filter((t) => t.msg === m && t.ev > from && t.ev < i);
    const lastIn = (ok: (t: (typeof w)[number]) => boolean) => { for (let k = w.length - 1; k >= 0; k--) if (ok(w[k])) return k; return -1; };
    if (inBase > 0n) {
      const k = lastIn((t) => t.base === inBase && (!a.sender || t.from === a.sender));
      if (k < 0) unmatchedMsgs.add(m);
      else {
        swapLegIdx.add(w[k].idx);
        const fee = w[k - 1], spread = w[k + 1];
        if (fee && fee.base > 0n && fee.from === w[k].from && fee.to === OSMOSIS.takerFeeCollector) swapLegIdx.add(fee.idx);
        if (spread && spread.base > 0n && spread.from === w[k].from && spread.to !== w[k].to) swapLegIdx.add(spread.idx);
      }
    }
    if (outBase > 0n) {
      const k = lastIn((t) => t.base === outBase && (!a.sender || t.to === a.sender));
      if (k < 0) unmatchedMsgs.add(m);
      else swapLegIdx.add(w[k].idx);
    }
  });
  const namSold = legs.filter((l) => l.side === 'sell').reduce((s, l) => s + l.nam, 0);
  const namBought = legs.filter((l) => l.side === 'buy').reduce((s, l) => s + l.nam, 0);
  const pools = new Set(legs.map((l) => l.pool));
  const isSwap = legs.length > 0;
  if (isSwap) {
    const net = namBought - namSold;
    const gross = Math.max(namBought, namSold);
    const isArb = namSold > 0 && namBought > 0 && Math.abs(net) < gross * 0.05;
    const kind = isArb ? 'other' : net > 0 ? 'buy' : 'sell';
    const amount = isArb ? gross : Math.abs(net);
    // The counter coin is the sum over the legs that make up `amount` (the trade's own side; for a round trip its
    // larger side), when they all paid in one coin. A trade with legs both ways and a net amount has no such set of
    // legs: dividing one leg's coin by the net NAM was a made-up price, so it records no counter coin at all.
    const side = isArb ? (namSold >= namBought ? 'sell' : 'buy') : kind;
    const mine = legs.filter((l) => l.side === side);
    const one = mine[0]?.counter;
    const paired = (isArb || mine.length === legs.length) && !!one && mine.every((l) => l.counter?.denom === one.denom);
    const counter = paired ? { ...one, amount: mine.reduce((s, l) => s + l.counter!.amount, 0) } : null;
    // A trade sets its own price only in a pool trusted for the price (OSMOSIS.pricePoolIds) against the asset map's
    // stable coin: any other pool is priced at the quote, like a trade against a coin that is not a stable.
    const trusted = !!counter?.stable && mine.every((l) => OSMOSIS.pricePoolIds.includes(l.pool));
    let priceUsd = ctx.priceUsd;
    if (counter && trusted && amount > 0 && !isArb) priceUsd = counter.amount / amount;
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
  // Each packet event is read with its own message's events: the channel of a send is on that message's send_packet
  // (ibc_transfer has none), a receive's outcome on that message's fungible_token_packet, a refund's receiver on that
  // message's timeout or fungible_token_packet. Only channel-98451 is the Osmosis <-> Namada bridge.
  /** NAM the transfer module paid back in message `m` (to `receiver` when known), for a refund that does not state its amount. */
  const paidBack = (m: string, receiver: string | null) =>
    namTransfers.filter((t) => t.msg === m && t.from === OSMOSIS.transferModule && (!receiver || t.to === receiver)).reduce((s, t) => s + t.amount, 0);
  const refundFlow = (i: number, receiver: string | null, refund: number, why: Record<string, unknown>) => {
    const a = ev[i];
    out.flows.push(flow(tx, `ibc_refund:${i}`, 'other', OSMOSIS.transferModule, receiver ?? signer, refund, ctx.priceUsd, {
      // ibcTimeoutRefund is the flag every reader of refunds uses (analytics, cron, series, shared/flow-rules.ts),
      // whatever the reason; refundReason says which.
      ibcTimeoutRefund: true, ...why, channel: a.packet_src_channel,
      ...(a.packet_sequence ? { packetSequence: a.packet_sequence } : {}),
      ...(receiver ? { refundReceiver: receiver } : { relayer: signer }),
    }));
  };
  tx.events.forEach((e, i) => {
    if (e.type === 'recv_packet') {
      const a = ev[i];
      if (a.packet_dst_channel !== NAM.osmoChannel) return;
      const pd = safeJson(a.packet_data);
      // NAM itself (native on Namada): only that packet denom mints NAM.osmoDenom on this channel.
      if (!pd || pd.denom !== NAM.namadaToken) return;
      // Only a receive whose own message says it succeeded: the transfer module's fungible_token_packet for this
      // packet (same message, same denom and amount) with success=true. A refused packet in a relay transaction
      // that also delivers others (each in its own message) has none (ibc-go renames a failed callback's events
      // ibccallbackerror-*) or says success=false.
      const ok = after(i, 'fungible_token_packet').some((x) => x.success === 'true' && x.denom === pd.denom && (x.amount === undefined || x.amount === String(pd.amount)));
      if (!ok) return;
      const amount = Number(pd.amount) / 10 ** NAM.decimals;
      out.flows.push(flow(tx, `ibc_in:${i}`, 'ibc_in', pd.sender, pd.receiver, amount, ctx.priceUsd, { memo: pd.memo, channel: a.packet_dst_channel }));
      // A link joins two real accounts only (the packet's sender and receiver are text the sender chose).
      if (isRealAddress(pd.receiver) === 'osmosis' && isRealAddress(pd.sender) === 'namada') out.links.push({ osmo: pd.receiver, namada: pd.sender, amount, ts: tx.ts });
    } else if (e.type === 'ibc_transfer') {
      const a = ev[i];
      if (a.denom !== NAM.osmoDenom) return;
      // The packet of this transfer: the send_packet just before it in the same message. A send on another channel
      // (the NAM voucher forwarded to a third chain) is not a crossing to Namada and is not recorded as one: its bank
      // leg into that channel's escrow account is an ordinary transfer (section 4). Its sequence is never another
      // message's, so a refund cancels the send it belongs to.
      const sp = before(i, 'send_packet');
      if (!sp || sp.packet_src_channel !== NAM.osmoChannel) return;
      const pd = safeJson(sp.packet_data);
      if (pd && (String(pd.amount) !== String(a.amount) || !String(pd.denom ?? '').endsWith(NAM.namadaToken))) return;
      const amount = Number(a.amount) / 10 ** NAM.decimals;
      out.flows.push(flow(tx, `ibc_out:${i}`, 'ibc_out', a.sender, a.receiver, amount, ctx.priceUsd, { memo: a.memo, channel: sp.packet_src_channel, ...(sp.packet_sequence ? { packetSequence: sp.packet_sequence } : {}) }));
      // No link from a send: the receiver is text the sender chose, and a send that times out is refunded. A link is
      // written only from the receiving chain's record (recv_packet above, 'ibc_in' in parse/namada.ts).
    } else if (e.type === 'timeout_packet') {
      const a = ev[i];
      if (a.packet_src_channel !== NAM.osmoChannel) return;
      // The transfer module's 'timeout' event of the same message names who got the NAM back; the tx signer is
      // only the relayer that delivered the timeout.
      const te = after(i, 'timeout').find((x) => x.refund_receiver);
      const receiver = te?.refund_receiver ?? null;
      const refund = te?.refund_amount && String(te.refund_denom ?? '').endsWith(NAM.namadaToken)
        ? Number(te.refund_amount) / 10 ** NAM.decimals
        : paidBack(msgOf[i], receiver);
      if (refund > 0) refundFlow(i, receiver, refund, { refundReason: 'timeout' });
    } else if (e.type === 'acknowledge_packet') {
      const a = ev[i];
      if (a.packet_src_channel !== NAM.osmoChannel) return;
      // An acknowledgement of a send. ibc-go's transfer module answers it, in the same message and after the
      // acknowledge_packet event, with fungible_token_packet carrying the packet's sender, receiver, denom, amount
      // and memo, the acknowledgement, and `success` (a result) or `error` (the receiving chain refused the packet);
      // ibc-go v7 puts success / error in a second fungible_token_packet event. On an error the transfer module
      // refunds the sender on Osmosis (the NAM voucher minted back to the transfer module and sent to the packet's
      // sender: the bank legs of a timeout refund), so the send never left Osmosis and is recorded as refunded.
      const ftp = after(i, 'fungible_token_packet');
      const error = ftp.find((x) => x.error)?.error;
      if (!error) return; // a result: the NAM arrived on Namada, whose own record is the twin
      const data = ftp.find((x) => x.amount !== undefined);
      if (!data || !String(data.denom ?? '').endsWith(NAM.namadaToken)) return; // another coin's packet on the channel
      const receiver = data.sender || null;
      const refund = Number(data.amount) / 10 ** NAM.decimals || paidBack(msgOf[i], receiver);
      if (refund > 0) refundFlow(i, receiver, refund, { refundReason: 'error_acknowledgement', ackError: String(error).slice(0, 200) });
    }
  });

  // ---- 4. LP + plain transfers ----
  // Every NAM bank leg that is not a swap's own: legs in messages without a NAM swap, and in a swap message the legs
  // that are not one of its hops (section 2). Such a leg in a swap message is still the swap's when it only carries
  // the swap's NAM between the trader and the swapper (a router contract and its entry point): both its ends are the
  // signer or an account the message leaves where it started (as much NAM in as out). A send to anyone else in the
  // same message (authz, a contract) changes that account's NAM and is recorded.
  const netIn = new Map<string, Map<string, bigint>>();
  for (const t of namTransfers) {
    if (!swapMsgs.has(t.msg)) continue;
    const n = netIn.get(t.msg) ?? netIn.set(t.msg, new Map()).get(t.msg)!;
    n.set(t.from, (n.get(t.from) ?? 0n) - t.base);
    n.set(t.to, (n.get(t.to) ?? 0n) + t.base);
  }
  const theSwaps = (t: (typeof namTransfers)[number]) => {
    if (!swapMsgs.has(t.msg)) return false;
    if (unmatchedMsgs.has(t.msg) || swapLegIdx.has(t.idx)) return true;
    const n = netIn.get(t.msg)!;
    const settled = (x: string) => x === signer || x === OSMOSIS.transferModule || n.get(x) === 0n;
    return settled(t.from) && settled(t.to);
  };
  let lpAdd = 0, lpRemove = 0;
  const lpPools = new Set<string>();
  for (const t of namTransfers) {
    if (theSwaps(t)) continue;
    const toPool = ctx.poolAddrs.get(t.to);
    const fromPool = ctx.poolAddrs.get(t.from);
    if (toPool) { lpAdd += t.amount; lpPools.add(toPool); continue; }
    if (fromPool) { lpRemove += t.amount; lpPools.add(fromPool); continue; }
    // The transfer module's legs are the bridge's (ibc_in / ibc_out / refund rows above), not transfers.
    if (t.from === OSMOSIS.transferModule || t.to === OSMOSIS.transferModule) continue;
    out.flows.push(flow(tx, `xfer:${t.idx}`, 'transfer', t.from, t.to, t.amount, ctx.priceUsd, null));
  }
  if (lpAdd > 0) out.flows.push({ ...flow(tx, 'lp_add', 'lp_add', signer, null, lpAdd, ctx.priceUsd, null), poolId: [...lpPools].join(',') });
  if (lpRemove > 0) out.flows.push({ ...flow(tx, 'lp_remove', 'lp_remove', null, signer, lpRemove, ctx.priceUsd, null), poolId: [...lpPools].join(',') });

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

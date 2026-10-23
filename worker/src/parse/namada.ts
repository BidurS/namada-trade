import { NAM, NAMADA } from '../config';
import { toNam, isRealAddress, boundFlowText } from '../util';
import type { Flow, Move } from '../../../shared/types';
import type { RawEvent } from './osmosis';

export interface NamadaBlock {
  height: number;
  ts: number;
  events: RawEvent[]; // end_block_events (+ tx events if any)
}

export interface BalanceUpdate {
  address: string;
  balance: string; // base units
  height: number;
}

export interface NamadaParsed {
  moves: Move[];
  flows: Flow[];
  balances: BalanceUpdate[];
  /** `flowId`: the flow the link was read from (one flow per link), so a block written again never counts it twice (db.ts stmt.linkOnce). */
  links: { osmo: string; namada: string; amount: number; ts: number; flowId: string }[];
  /**
   * Wrapper hashes of the transfers whose shielded-pool fee was read from the events alone (no fee payer was given
   * for the wrapper): the wrapper's header names its fee payer (namada-tx.ts feePayersOf), and parsing the block
   * again with it gives the reading tied to that account.
   */
  feePayerWanted: string[];
}

type Entry = [[string, string], string];

const NAMADA_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [NAM.namadaToken]: { symbol: 'NAM', decimals: 6 },
  tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75: { symbol: 'OSMO', decimals: 6 },
  tnam1p443nycjk2w0q3al3vfnw3gw7w4qga07psfqnjtm: { symbol: 'USDC', decimals: 6 },
  tnam1pkg30gnt4q0zn7j00r6hms4ajrxn6f5ysyyl7w9m: { symbol: 'ATOM', decimals: 6 },
  tnam1p4px8sw3am4qvetj7eu77gftm4fz4hcw2ulpldc7: { symbol: 'stOSMO', decimals: 6 },
  tnam1p5hpxyzdpyjdmdt5axx0q8sl6tvfzdmehse9ca7z: { symbol: 'allBTC', decimals: 8 },
};

function tokenMeta(tokenAddr: string) {
  return NAMADA_TOKENS[tokenAddr] || { symbol: tokenAddr.slice(0, 8) + '…', decimals: 6 };
}

function toTokenUnits(raw: bigint, decimals = 6): number {
  return Number(raw) / 10 ** decimals;
}

/** A whole number of base units as the chain writes it, or null for anything else (never read as a guess). */
const unitsOf = (s: string): bigint | null => (/^\d+$/.test(s) ? BigInt(s) : null);

/** One (account, token) side of a token/transfer event with a readable, non-zero amount. */
interface Leg {
  account: string;
  token: string;
  units: bigint;
}

function legs(json: string | undefined): Leg[] {
  const out: Leg[] = [];
  for (const x of entries(json)) {
    const units = unitsOf(x.amount);
    if (units !== null && units > 0n) out.push({ account: x.account, token: x.token, units });
  }
  return out;
}

const byUnitsDesc = (a: Leg, b: Leg) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0);

/**
 * The largest NAM leg the shielded pool can pay one other account in a transfer and still be read as that
 * transfer's fee (the pool pays the gas payer) rather than as NAM leaving the pool. The fee legs on record are
 * 0.084159 NAM (block 8,294,006), 0.1 (7,011,473) and 0.144159 (8,288,955); the 4,631 fee legs the shielded-pool
 * history step found averaged 0.76 NAM (docs/decisions.md). A larger leg is a flow of its own, so a side leg can
 * never carry a real move out of sight: at most this much per transfer is ever filed as a fee.
 */
export const MASP_FEE_CAP_NAM = 5;
const MASP_FEE_CAP = BigInt(MASP_FEE_CAP_NAM) * 1_000_000n;

function attrs(e: RawEvent): Record<string, string> {
  const o: Record<string, string> = {};
  // Chain data as a node sent it: an event without attributes, or an attribute that is not a string, is read as empty.
  for (const a of Array.isArray(e.attributes) ? e.attributes : []) if (a && typeof a.key === 'string') o[a.key] = typeof a.value === 'string' ? a.value : '';
  return o;
}

/** "internal-address/tnam1..." | "external-address/osmo1..." -> bare address */
export function bareAccount(a: string): string {
  const i = a.indexOf('/');
  return i >= 0 ? a.slice(i + 1) : a;
}

function entries(json: string | undefined): { account: string; token: string; amount: string }[] {
  if (!json) return [];
  try {
    return (JSON.parse(json) as Entry[]).map(([[acct, token], amount]) => ({
      account: bareAccount(acct),
      token,
      amount: String(amount),
    }));
  } catch {
    return [];
  }
}

const I = NAMADA.internal;
/** The protocol's own accounts (staking, bridge escrow, shielded pool, PGF, governance): never a gas payer. */
const INTERNAL = new Set<string>(Object.values(I));

/**
 * The kind of one token/transfer event. The staking account's own balance moved by a wasm transfer (descriptor
 * `transfer-from-wasm`, either side the staking account) is 'pos_balance', not a bond or a withdrawal: on
 * 2026-08-31 such a transfer moved 331,386,682 NAM out of the staking account and on 22 Sep and 1 Oct the same
 * amount came back, while the chain's total stake never moved and the receiving address had no bond
 * (docs/design/screener-plan.md 3.0). Holders' own bonds and unbonds are recorded from the indexer and the live bond
 * and unbond decoders (namada-bond.ts, namada-unbond.ts: a bond moves NAM to the staking account with no event);
 * the chain's staking logic moves NAM with its own descriptors (pos-claim-rewards, pos-withdraw-token).
 */
export function classify(descriptor: string, from: string | null, to: string | null): Flow['kind'] {
  if (descriptor === 'pos-claim-rewards') return 'rewards';
  if (descriptor === 'pos-withdraw-token') return 'withdraw';
  if (descriptor === 'transfer-from-wasm' && (to === I.pos || from === I.pos)) return 'pos_balance';
  if (to === I.pos) return 'bond';
  if (from === I.pos) return 'withdraw';
  // IBC before MASP: a shielded IBC withdrawal (MASP -> escrow) is 'ibc_out' and a shielded IBC deposit
  // (escrow -> MASP) is 'ibc_in', the kinds the indexer backfill uses for ibcUnshieldingTransfer / ibcShieldingTransfer.
  if (to === I.ibc) return 'ibc_out';
  if (from === I.ibc) return 'ibc_in';
  if (to === I.masp) return 'shield';
  if (from === I.masp) return 'unshield';
  if (from === I.pgf) return 'pgf';
  return 'transfer';
}

interface Packet {
  sender: string;
  receiver: string;
  /** base units, as the packet carries them */
  amount: string;
  denom: string;
  dir: 'out' | 'in';
  /**
   * The inner transaction that sent or received the packet. A packet belongs to the transfer of the same inner
   * transaction and to no other: the wrapper hash is shared by every inner transaction of a relayer's batch.
   */
  innerHash: string;
  /** false when the ICS-20 receive callback of the same inner transaction reported a failure (nothing was credited) */
  ok: boolean;
  /** Namada's end of the channel as the event names it ('' when it names none) */
  channel: string;
  /**
   * The packet's sequence on its source channel (packet_sequence), or null when the event gives no whole number. The
   * other chain's record of the same packet carries the same sequence, so the two records of one crossing can be
   * told from any other crossing (worker/src/sources/discord.ts crossingOf).
   */
  sequence: string | null;
}

function ibcPackets(block: NamadaBlock): Packet[] {
  // The ICS-20 callback's verdict per receiving inner transaction (fungible_token_packet `success`).
  const failed = new Set<string>();
  for (const e of block.events) {
    if (e?.type !== 'fungible_token_packet') continue;
    const a = attrs(e);
    const inner = (a['inner-tx-hash'] || '').toUpperCase();
    if (inner && a.success !== undefined && a.success !== 'true') failed.add(inner);
  }
  const out: Packet[] = [];
  for (const e of block.events) {
    if (e?.type !== 'send_packet' && e?.type !== 'recv_packet') continue;
    const a = attrs(e);
    const dir = e.type === 'send_packet' ? 'out' : 'in';
    const ch = dir === 'out' ? a.packet_src_channel : a.packet_dst_channel;
    if (ch && ch !== NAM.namadaChannel) continue; // only the Osmosis channel
    let pd: any;
    try {
      pd = JSON.parse(a.packet_data);
    } catch {
      continue;
    }
    if (typeof pd?.sender !== 'string' || typeof pd?.receiver !== 'string' || !pd.sender || !pd.receiver) continue;
    const innerHash = (a['inner-tx-hash'] || '').toUpperCase();
    out.push({
      sender: pd.sender,
      receiver: pd.receiver,
      amount: String(pd.amount || '0'),
      denom: String(pd.denom || ''),
      dir,
      innerHash,
      ok: !(innerHash && failed.has(innerHash)),
      channel: ch || '',
      sequence: /^\d+$/.test(a.packet_sequence ?? '') ? a.packet_sequence : null,
    });
  }
  return out;
}

/** NAM as an ICS-20 denom: native when Namada sends it, with the counterparty's trace prefix when it comes back. */
const isNamDenom = (denom: string) => denom === NAM.namadaToken || denom.endsWith(`/${NAM.namadaToken}`);

/** A target the shielded pool may be paying its fee to: an account that can pay gas, at most MASP_FEE_CAP_NAM. */
const feeSized = (l: Leg) => !INTERNAL.has(l.account) && l.units <= MASP_FEE_CAP;

/**
 * The NAM legs of a transfer of another coin are the shielded pool's fee for it (the pool pays the gas payer, block
 * 8,294,006) only when that is all they can be: one leg out of the pool, the same amount into one other account that
 * can pay gas (not a protocol account: NAM from the pool into the bridge escrow is a bridge send), at most
 * MASP_FEE_CAP_NAM, and that account the wrapper's fee payer when the wrapper is known (`payer`). Anything else is
 * NAM that moved and gets flows of its own.
 */
function maspFeeOf(src: Leg[], dst: Leg[], payer: string | undefined): bigint | null {
  if (src.length !== 1 || dst.length !== 1) return null;
  const [s] = src;
  const [d] = dst;
  return s.account === I.masp && feeSized(d) && s.units === d.units && (payer === undefined || d.account === payer) ? s.units : null;
}

/**
 * Who paid whom in one token's legs. The event lists its sources and its targets per account, not the pairs:
 * - one source: one leg per target, from that source, with the target's own amount (exact);
 * - one target: one leg per source, to that target, with the source's own amount (exact);
 * - several of each: sources and targets are paired largest with largest. Every account's sent and received total
 *   and the shielded pool's own legs stay exact; the pairs are a reading, said in meta.pairing.
 * A side with no legs at all (the chain names none) gives legs with that end left null.
 */
function pairLegs(s: Leg[], d: Leg[]): { legs: { from: string | null; to: string | null; units: bigint }[]; assumed: boolean } {
  if (!s.length) return { legs: d.map((t) => ({ from: null, to: t.account, units: t.units })), assumed: false };
  if (!d.length) return { legs: s.map((x) => ({ from: x.account, to: null, units: x.units })), assumed: false };
  if (s.length === 1) return { legs: d.map((t) => ({ from: s[0].account, to: t.account, units: t.units })), assumed: false };
  if (d.length === 1) return { legs: s.map((x) => ({ from: x.account, to: d[0].account, units: x.units })), assumed: false };
  const out: { from: string | null; to: string | null; units: bigint }[] = [];
  let i = 0;
  let j = 0;
  let ri = s[0].units;
  let rj = d[0].units;
  while (i < s.length && j < d.length) {
    const u = ri < rj ? ri : rj;
    out.push({ from: s[i].account, to: d[j].account, units: u });
    ri -= u;
    rj -= u;
    if (ri === 0n && ++i < s.length) ri = s[i].units;
    if (rj === 0n && ++j < d.length) rj = d[j].units;
  }
  return { legs: out, assumed: true };
}

/**
 * `feePayers`: the fee payer of each wrapper of the block, by wrapper hash (namada-tx.ts feePayersOf, from the block's
 * tx bytes). No event names it, so without it the shielded pool's fee is read from the events alone (namFlows).
 */
export function parseNamadaBlock(block: NamadaBlock, priceUsd: number | null, feePayers?: ReadonlyMap<string, string>): NamadaParsed {
  const out: NamadaParsed = { moves: [], flows: [], balances: [], links: [], feePayerWanted: [] };
  const packets = ibcPackets(block);
  const usedPackets = new Set<number>();
  /** The wrapper's fee payer, undefined when not given (a wrapper read without it is noted in feePayerWanted). */
  const payerOf = (txHash: string): string | undefined => feePayers?.get(txHash);
  const wantPayer = (txHash: string) => {
    if (!out.feePayerWanted.includes(txHash)) out.feePayerWanted.push(txHash);
  };

  /**
   * The packet of a bridge leg: sent or received by the same inner transaction, on the Osmosis channel, NAM, the
   * leg's own amount, and the leg's account as its sender (out) or receiver (in). None that fits: the leg keeps the
   * escrow as its other end and nothing is linked, never another transfer's packet.
   *
   * A shielded withdrawal (the pool's NAM into the escrow, blocks 3,837,012 and 3,824,208) is the one send whose
   * packet names another sender: the NAM leaves the pool, and the packet is sent from the transparent refund address
   * the wallet picks for it (the indexer files the same inner transactions, ibcUnshieldingTransfer, under that
   * address). So a leg out of the pool takes its inner transaction's packet whatever sender the packet names; the
   * inner transaction, NAM, the amount, the callback and one packet per leg are required of it as of any other.
   */
  const bindPacket = (want: 'out' | 'in', innerTxHash: string, from: string | null, to: string | null, units: bigint): Packet | null => {
    if (!innerTxHash) return null;
    const k = packets.findIndex(
      (p, n) =>
        !usedPackets.has(n) &&
        p.dir === want &&
        p.innerHash === innerTxHash &&
        p.ok &&
        isNamDenom(p.denom) &&
        unitsOf(p.amount) === units &&
        (want === 'out' ? p.sender === from || from === I.masp : p.receiver === to),
    );
    if (k < 0) return null;
    usedPackets.add(k);
    return packets[k];
  };

  /**
   * The NAM flows of one event's NAM legs, one per leg (pairLegs). The first keeps the id `idBase`, so an event with
   * one source and one target is written as before; the others are `idBase:<n>`.
   *
   * The shielded pool's fee: an unshield (the pool the only source) usually carries a second, small target, the gas
   * payer the pool pays for the transaction (blocks 8,288,955, 7,011,473). That target's leg is kept in the first
   * flow's meta (maspFeeNam), so pool accounting can add it back, and never a leg above MASP_FEE_CAP_NAM or into a
   * protocol account (staking, the bridge escrow: those never pay gas, so a small bond or bridge send out of the pool
   * is a flow of its own). Which target paid gas:
   * - the wrapper's fee payer, when it is given (`feePayers`, the key in the wrapper's header): its leg is the fee,
   *   whatever its size next to the others, and no leg is when it is not a target (the fee was paid from elsewhere);
   * - otherwise the events alone, which never name it (the chain emits no event for the fee itself, and a
   *   masp/fee-payment event of the same inner transaction is there for 19 of the 2,491 fee-shaped pool transfers in
   *   the 70,908 blocks of scripts/out/history/masp_blocks): the smallest target, when it is the only one that can be
   *   the fee. When another can too (303 of the 2,491), none is read as the fee and each is a flow of its own, the
   *   gas payer's an unshield to it: the smallest is not always the gas payer (block 4,349,059: 0.0625 NAM to an
   *   account that held exactly that afterwards, the gas payer, and 0.000001 to one that already held NAM), and a
   *   fee read off the wrong leg hides the recipient's receipt.
   * The limit left without the wrapper: the one target that can be the fee is read as the fee even when the fee was
   * paid from elsewhere, so up to MASP_FEE_CAP_NAM per transfer can be filed as a fee and not as the receipt of the
   * account it went to. Every leg is in the flows or in maspFeeNam either way, so the pool's outflow stays whole.
   * Every other leg is a flow of its own too, a shield's side output included (block 4,707,359: 10 NAM shielded and
   * 0.1 NAM to another account, a transparent transfer that never touched the pool).
   */
  const namFlows = (idBase: string, txHash: string, innerTxHash: string, descriptor: string, src: Leg[], dst: Leg[]) => {
    if (!src.length && !dst.length) return;
    const s = [...src].sort(byUnitsDesc);
    const d = [...dst].sort(byUnitsDesc);
    let maspFee: bigint | null = null;
    if (s.length === 1 && s[0].account === I.masp && d.length > 1) {
      const payer = payerOf(txHash);
      let k = -1;
      if (payer !== undefined) k = d.findIndex((l) => l.account === payer && feeSized(l));
      else {
        const can = d.filter(feeSized);
        if (can.length) wantPayer(txHash);
        if (can.length === 1 && can[0] === d[d.length - 1]) k = d.length - 1;
      }
      if (k >= 0) maspFee = d.splice(k, 1)[0].units;
    }
    const { legs: pairs, assumed } = pairLegs(s, d);
    pairs.forEach((l, k) => {
      const id = k === 0 ? idBase : `${idBase}:${k}`;
      const amount = toNam(l.units);
      const kind = classify(descriptor, l.from, l.to);
      let flowFrom = l.from;
      let flowTo = l.to;
      const meta: Record<string, unknown> = {
        descriptor,
        ...(innerTxHash ? { innerTxHash } : {}),
        ...(k === 0 && maspFee !== null ? { maspFeeNam: toNam(maspFee) } : {}),
        ...(assumed ? { pairing: 'largest-first' } : {}),
      };

      // Pair with the IBC packet of the same inner transaction (including a direct IBC -> MASP shield, escrow -> pool)
      if (kind === 'ibc_out' || kind === 'ibc_in') {
        const want = kind === 'ibc_out' ? 'out' : 'in';
        const p = bindPacket(want, innerTxHash, l.from, l.to, l.units);
        // The packet's own identity, as the Osmosis records keep theirs (meta.channel is this chain's end of it).
        if (p?.channel) meta.channel = p.channel;
        if (p?.sequence) meta.packetSequence = p.sequence;
        if (p && want === 'out') {
          // No link from a send: the receiver is text the sender chose, and a send that times out is refunded.
          flowTo = p.receiver;
          meta.escrow = I.ibc;
        } else if (p) {
          flowFrom = p.sender;
          meta.escrow = I.ibc;
          // The NAM arrived here: this is the one record that links the osmo1 sender to the tnam1 receiver. Two real
          // accounts only (the checksum), never the shielded pool.
          if (isRealAddress(p.sender) === 'osmosis' && isRealAddress(p.receiver) === 'namada' && p.receiver !== I.masp) {
            out.links.push({ osmo: p.sender, namada: p.receiver, amount, ts: block.ts, flowId: id });
          }
        }
      }

      out.flows.push({
        id,
        chain: 'namada',
        height: block.height,
        ts: block.ts,
        txHash,
        kind,
        from: flowFrom,
        to: flowTo,
        amount,
        priceUsd,
        valueUsd: priceUsd != null ? priceUsd * amount : null,
        meta,
      });
    });
  };

  block.events.forEach((e, i) => {
    // Handle IBC-MASP mint/burn of non-NAM IBC tokens (e.g. direct IBC shield/unshield of OSMO/USDC)
    if (e.type === 'token/mint' || e.type === 'token/burn') {
      const a = attrs(e);
      if (a['token-event-descriptor'] !== 'ibc') return;
      const tokenAddr = a['token-address'] || '';
      if (!tokenAddr || tokenAddr === NAM.namadaToken) return;
      const target = bareAccount(a['target-account'] || '');
      if (target !== I.masp) return;

      const wrapperHash = (a.hash || a['inner-tx-hash'] || `blk${block.height}`).toUpperCase();
      const innerTxHash = (a['inner-tx-hash'] || '').toUpperCase();
      const tMeta = tokenMeta(tokenAddr);
      const units = unitsOf(a.amount || '0');
      const tokenAmt = units === null ? 0 : toTokenUnits(units, tMeta.decimals);
      if (tokenAmt <= 0) return;

      const isShield = e.type === 'token/mint';
      // The packet of the same inner transaction only (see Packet.innerHash); none: the escrow stands for the other end.
      const pi = innerTxHash
        ? packets.findIndex((p, n) => !usedPackets.has(n) && p.dir === (isShield ? 'in' : 'out') && p.innerHash === innerTxHash && p.ok)
        : -1;
      if (pi >= 0) usedPackets.add(pi);
      const pkt = pi >= 0 ? packets[pi] : undefined;

      out.flows.push({
        id: `namada:${wrapperHash}:ibcmasp:${i}`,
        chain: 'namada',
        height: block.height,
        ts: block.ts,
        txHash: wrapperHash,
        kind: isShield ? 'shield' : 'unshield',
        from: isShield ? pkt?.sender || I.ibc : I.masp,
        to: isShield ? I.masp : pkt?.receiver || I.ibc,
        amount: tokenAmt,
        counterDenom: tMeta.symbol,
        counterAmount: tokenAmt,
        priceUsd: null,
        valueUsd: null,
        meta: {
          descriptor: 'ibc-masp',
          tokenSymbol: tMeta.symbol,
          tokenAddress: tokenAddr,
          innerTxHash: innerTxHash || undefined,
        },
      });
      return;
    }

    if (e.type !== 'token/transfer') return;
    const a = attrs(e);
    // Use outer wrapper hash (a.hash) as primary txHash so explorer links & searches match namada.valopers.com
    const txHash = (a.hash || a['inner-tx-hash'] || `blk${block.height}`).toUpperCase();
    const innerTxHash = (a['inner-tx-hash'] || '').toUpperCase();
    const descriptor = a['token-event-descriptor'] ?? '';

    // Absolute post-balances: authoritative balance for each touched NAM account
    for (const p of entries(a['post-balances'])) {
      if (p.token !== NAM.namadaToken) continue;
      out.balances.push({ address: p.account, balance: p.amount, height: block.height });
    }

    const allSrc = legs(a['source-accounts']);
    const allDst = legs(a['target-accounts']);

    const namSrc = allSrc.filter((x) => x.token === NAM.namadaToken);
    const namDst = allDst.filter((x) => x.token === NAM.namadaToken);
    const nonNamSrc = allSrc.filter((x) => x.token !== NAM.namadaToken);
    const nonNamDst = allDst.filter((x) => x.token !== NAM.namadaToken);

    // Record NAM balance moves
    namSrc.forEach((s, j) => out.moves.push(mv(block, txHash, i * 100 + j, s.account, -toNam(s.units))));
    namDst.forEach((d, j) => out.moves.push(mv(block, txHash, i * 100 + 50 + j, d.account, toNam(d.units))));

    // Case A: Non-NAM token transfer (e.g. shielding/unshielding OSMO, USDC, ATOM on Namada)
    if (nonNamSrc.length > 0 || nonNamDst.length > 0) {
      const s0 = nonNamSrc[0];
      const d0 = nonNamDst[0];
      const tokenAddr = s0?.token || d0?.token || '';
      const tMeta = tokenMeta(tokenAddr);
      const from = s0?.account ?? null;
      const to = d0?.account ?? null;
      const tokenAmt = Math.max(
        nonNamSrc.reduce((s, x) => s + toTokenUnits(x.units, tMeta.decimals), 0),
        nonNamDst.reduce((s, x) => s + toTokenUnits(x.units, tMeta.decimals), 0),
      );
      // The NAM legs of the same event: the pool's fee for it when that is all they can be, else NAM flows of their own.
      const payer = payerOf(txHash);
      const feeUnits = maspFeeOf(namSrc, namDst, payer);
      if (payer === undefined && feeUnits !== null) wantPayer(txHash);
      const kind = classify(descriptor, from, to);

      out.flows.push({
        id: `namada:${txHash}:${i}`,
        chain: 'namada',
        height: block.height,
        ts: block.ts,
        txHash,
        kind,
        from,
        to,
        amount: tokenAmt,
        counterDenom: tMeta.symbol,
        counterAmount: tokenAmt,
        priceUsd: null,
        valueUsd: null,
        meta: {
          descriptor,
          tokenSymbol: tMeta.symbol,
          tokenAddress: tokenAddr,
          // The pool's fee under the key pool accounting reads (the same as on a NAM unshield): it is NAM that left
          // the pool. Not `feeNam`: older builds wrote that for every NAM source of the event, whoever sent it.
          ...(feeUnits !== null ? { maspFeeNam: toNam(feeUnits) } : {}),
          innerTxHash: innerTxHash || undefined,
        },
      });
      // `:nam` keeps these ids apart from every Case B id of the block (`namada:<hash>:<i>[:<n>]`).
      if (feeUnits === null) namFlows(`namada:${txHash}:${i}:nam`, txHash, innerTxHash, descriptor, namSrc, namDst);
      return;
    }

    // Case B: Pure NAM transfer
    namFlows(`namada:${txHash}:${i}`, txHash, innerTxHash, descriptor, namSrc, namDst);
  });

  // Keep only the last post-balance per address within the block
  const last = new Map<string, BalanceUpdate>();
  for (const b of out.balances) last.set(b.address, b);
  out.balances = [...last.values()];
  // A packet's receiver and sender are the sender's own text: every flow is kept with them bounded.
  out.flows = out.flows.map(boundFlowText);
  return out;
}

function mv(b: NamadaBlock, txHash: string, idx: number, address: string, delta: number): Move {
  return { chain: 'namada', address, height: b.height, ts: b.ts, txHash, idx, delta };
}

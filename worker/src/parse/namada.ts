import { NAM, NAMADA } from '../config';
import { toNam } from '../util';
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
  links: { osmo: string; namada: string; amount: number; ts: number }[];
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

function toTokenUnits(raw: string, decimals = 6): number {
  return Number(raw) / 10 ** decimals;
}

function attrs(e: RawEvent): Record<string, string> {
  const o: Record<string, string> = {};
  for (const { key, value } of e.attributes) o[key] = value;
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

function classify(descriptor: string, from: string | null, to: string | null): Flow['kind'] {
  if (descriptor === 'pos-claim-rewards') return 'rewards';
  if (descriptor === 'pos-withdraw-token') return 'withdraw';
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
  amount: string;
  denom: string;
  dir: 'out' | 'in';
  hash: string;
}

function ibcPackets(block: NamadaBlock): Packet[] {
  const out: Packet[] = [];
  for (const e of block.events) {
    if (e.type !== 'send_packet' && e.type !== 'recv_packet') continue;
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
    if (!pd?.sender || !pd?.receiver) continue;
    out.push({
      sender: pd.sender,
      receiver: pd.receiver,
      amount: String(pd.amount || '0'),
      denom: String(pd.denom || ''),
      dir,
      hash: String(a.hash || a['inner-tx-hash'] || '').toUpperCase(),
    });
  }
  return out;
}

export function parseNamadaBlock(block: NamadaBlock, priceUsd: number | null): NamadaParsed {
  const out: NamadaParsed = { moves: [], flows: [], balances: [], links: [] };
  const packets = ibcPackets(block);
  const usedPackets = new Set<number>();

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
      const tokenAmt = toTokenUnits(a.amount || '0', tMeta.decimals);
      if (tokenAmt <= 0) return;

      const isShield = e.type === 'token/mint';
      const pkt = packets.find(
        (p) => p.dir === (isShield ? 'in' : 'out') && (!p.hash || p.hash === wrapperHash),
      );

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

    const allSrc = entries(a['source-accounts']).filter((x) => x.amount !== '0');
    const allDst = entries(a['target-accounts']).filter((x) => x.amount !== '0');

    const namSrc = allSrc.filter((x) => x.token === NAM.namadaToken);
    const namDst = allDst.filter((x) => x.token === NAM.namadaToken);
    const nonNamSrc = allSrc.filter((x) => x.token !== NAM.namadaToken);
    const nonNamDst = allDst.filter((x) => x.token !== NAM.namadaToken);

    // Record NAM balance moves
    namSrc.forEach((s, j) => out.moves.push(mv(block, txHash, i * 100 + j, s.account, -toNam(s.amount))));
    namDst.forEach((d, j) => out.moves.push(mv(block, txHash, i * 100 + 50 + j, d.account, toNam(d.amount))));

    // Case A: Non-NAM token transfer (e.g. shielding/unshielding OSMO, USDC, ATOM on Namada)
    if (nonNamSrc.length > 0 || nonNamDst.length > 0) {
      const s0 = nonNamSrc[0];
      const d0 = nonNamDst[0];
      const tokenAddr = s0?.token || d0?.token || '';
      const tMeta = tokenMeta(tokenAddr);
      const from = s0?.account ?? null;
      const to = d0?.account ?? null;
      const tokenAmt = Math.max(
        nonNamSrc.reduce((s, x) => s + toTokenUnits(x.amount, tMeta.decimals), 0),
        nonNamDst.reduce((s, x) => s + toTokenUnits(x.amount, tMeta.decimals), 0),
      );
      const feeNam = namSrc.reduce((s, x) => s + toNam(x.amount), 0);
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
          feeNam: feeNam > 0 ? feeNam : undefined,
          innerTxHash: innerTxHash || undefined,
        },
      });
      return;
    }

    // Case B: Pure NAM transfer
    if (!namSrc.length && !namDst.length) return;

    // When unshielding NAM from MASP, Namada may include a tiny fee output first and the user output second!
    // Pick the largest target account when source is MASP so we don't mistake the gas fee for the recipient.
    const sortedSrc = [...namSrc].sort((a, b) => toNam(b.amount) - toNam(a.amount));
    const sortedDst = [...namDst].sort((a, b) => toNam(b.amount) - toNam(a.amount));
    const sumSrc = namSrc.reduce((s, x) => s + toNam(x.amount), 0);
    const sumDst = namDst.reduce((s, x) => s + toNam(x.amount), 0);

    const from = sortedSrc[0]?.account ?? null;
    const to = sortedDst[0]?.account ?? null;
    // The flow's amount is its main leg. Whatever else left or entered the MASP in the same transfer (the fee the
    // MASP pays to the gas payer, a side output of a mixed transfer) is kept in meta so pool accounting can add it back.
    let amount = Math.max(sumSrc, sumDst);
    let maspFeeNam: number | undefined;
    let otherNam: number | undefined;
    if (from === I.masp && sortedDst.length > 1) {
      amount = toNam(sortedDst[0].amount);
      maspFeeNam = sumSrc - amount;
    } else if (to === I.masp && sortedDst.length > 1) {
      amount = toNam(sortedDst[0].amount);
      otherNam = sumDst - amount;
    }
    const kind = classify(descriptor, from, to);

    let flowFrom = from;
    let flowTo = to;
    const meta: Record<string, unknown> = {
      descriptor,
      ...(innerTxHash ? { innerTxHash } : {}),
      ...(maspFeeNam && maspFeeNam > 0 ? { maspFeeNam } : {}),
      ...(otherNam && otherNam > 0 ? { otherNam } : {}),
    };

    // Pair with IBC packet (including direct IBC -> MASP shield where from === I.ibc && to === I.masp)
    if (kind === 'ibc_out' || kind === 'ibc_in') {
      const want = kind === 'ibc_out' ? 'out' : 'in';
      const pi = packets.findIndex(
        (p, k) =>
          !usedPackets.has(k) &&
          p.dir === want &&
          (want === 'out' ? p.sender === from : p.receiver === to),
      );
      if (pi >= 0) {
        usedPackets.add(pi);
        const p = packets[pi];
        if (want === 'out') {
          flowTo = p.receiver;
          meta.escrow = I.ibc;
        } else {
          flowFrom = p.sender;
          meta.escrow = I.ibc;
        }
        const osmo = want === 'out' ? p.receiver : p.sender;
        const nam = want === 'out' ? p.sender : p.receiver;
        if (osmo?.startsWith('osmo1') && nam?.startsWith('tnam1') && nam !== I.masp) {
          out.links.push({ osmo, namada: nam, amount, ts: block.ts });
        }
      }
    }

    out.flows.push({
      id: `namada:${txHash}:${i}`,
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

  // Keep only the last post-balance per address within the block
  const last = new Map<string, BalanceUpdate>();
  for (const b of out.balances) last.set(b.address, b);
  out.balances = [...last.values()];
  return out;
}

function mv(b: NamadaBlock, txHash: string, idx: number, address: string, delta: number): Move {
  return { chain: 'namada', address, height: b.height, ts: b.ts, txHash, idx, delta };
}

// The words for a move, one table for the Worker's Discord alerts (worker/src/sources/discord.ts) and the web app
// (Home's latest moves, Supply's votes): what a move is called ("791,848 NAM sold on Osmosis"), its past tense in a list
// of earlier moves ("sold 49,491 and 99,221 NAM"), which side of it is the person and the word before that person
// ("to", "from", "by"), and a governance proposal's status and type in plain words. The verbs are the alert rules' own
// (shared/alerts.ts: "started unstaking", "unlocked and withdrawn from staking", "moved out of the shielded set",
// "bridged to Osmosis", "staked", "Bought", "Sold"), and a crossing is named by where the NAM went (shared/kinds.ts).
import type { Flow, FlowKind } from './types';
import { INTERNAL_ADDRESSES, isInternal } from './alerts';
import { label_plain } from './labels';
import { bridgeDest, tagKindOf, type TagKind } from './kinds';
import { isBotFlow, isIbcRefund, isOtherCoin } from './flow-rules';
import { fmtNamRule } from './format';

export const CHAIN_WORD: Record<string, string> = { osmosis: 'Osmosis', namada: 'Namada' };

type MoveLike = Pick<Flow, 'kind' | 'chain'> & { meta?: Record<string, unknown> | null };

/** The tag a move shows: a bridge timeout refund, a bot round trip whatever its kind, else its kind by where the NAM went. */
export const tagOfFlow = (f: MoveLike): TagKind => (isIbcRefund(f) ? 'bridgeRefund' : isBotFlow(f) ? 'bot' : tagKindOf(f.kind, f.chain));

/** One side of a move: its address, the label the site shows for it, and, for a wallet's own tag, where it came from and who wrote it. */
export interface Party { address: string | null; label: string | null; source: string | null; author: string | null }

type LabelledLike = Pick<Flow, 'kind' | 'from' | 'to'> & Partial<Pick<Flow,
  'fromLabel' | 'toLabel' | 'fromLabelPlain' | 'toLabelPlain' | 'fromLabelSource' | 'toLabelSource' | 'fromLabelAuthor' | 'toLabelAuthor'>>;

/**
 * A move's two sides with their labels: the label the server sent (label_plain), else label_plain of the raw label,
 * which names a protocol account by its address even when no label was joined (a move from the live stream).
 */
export function sidesOf(f: LabelledLike): { from: Party; to: Party } {
  const side = (address: string | null, plain: string | null | undefined, raw: string | null | undefined, source: string | null | undefined, author: string | null | undefined): Party => ({
    address, label: address ? plain ?? label_plain(raw, address, source) : null, source: source ?? null, author: author ?? null,
  });
  return {
    from: side(f.from, f.fromLabelPlain, f.fromLabel, f.fromLabelSource, f.fromLabelAuthor),
    to: side(f.to, f.toLabelPlain, f.toLabel, f.toLabelSource, f.toLabelAuthor),
  };
}

/**
 * Both sides of a move (sidesOf), the person first: the receiver of a buy, the seller of a sale, the side that is not a
 * protocol account (the staking account, the bridge account, the shielded pool), the sender of a shield or a bond,
 * else the receiver.
 */
export function partiesOf(f: LabelledLike): { party: Party; other: Party } {
  const { from, to } = sidesOf(f);
  if (f.kind === 'buy') return { party: to, other: from };
  if (f.kind === 'sell') return { party: from, other: to };
  if (isInternal(f.from) && !isInternal(f.to)) return { party: to, other: from };
  if (isInternal(f.to) && !isInternal(f.from)) return { party: from, other: to };
  if (f.kind === 'shield' || f.kind === 'bond') return { party: from, other: to };
  return to.address ? { party: to, other: from } : { party: from, other: to };
}

/** The person a move names (partiesOf). */
export const partyOf = (f: LabelledLike): Party => partiesOf(f).party;

/** The word before the person a move names, as Home's latest moves writes it ("to", "from", "by"), with its space; none for other kinds. */
export const partyPreposition = (kind: FlowKind | string): string =>
  kind === 'unshield' || kind === 'withdraw' ? 'to ' : kind === 'shield' ? 'from ' : kind === 'unbond' || kind === 'bond' ? 'by ' : '';

/**
 * What a move is called, amount first: "791,848 NAM sold on Osmosis", "1,500,000 NAM bridged to Osmosis", "25,100 NAM
 * started unstaking", "290 OSMO moved out of the shielded set to Osmosis". A move in another coin keeps its own symbol
 * (meta.tokenSymbol); amounts follow the site's rule (fmtNamRule: no cents from 1,000 up).
 */
export function moveTitle(f: MoveLike & Pick<Flow, 'amount' | 'to'>): string {
  const coin = isOtherCoin(f) ? String(f.meta!.tokenSymbol) : 'NAM';
  const amt = `${fmtNamRule(f.amount)} ${coin}`;
  const dest = bridgeDest(f.kind, f.chain);
  if (dest === 'osmosis') return `${amt} bridged to Osmosis`;
  if (dest === 'namada') return f.to === INTERNAL_ADDRESSES.masp ? `${amt} bridged to Namada, into the shielded pool` : `${amt} bridged to Namada`;
  const chain = CHAIN_WORD[f.chain] ?? f.chain;
  switch (f.kind) {
    case 'buy': return `${amt} bought on Osmosis`;
    case 'sell': return `${amt} sold on Osmosis`;
    case 'shield': return `${amt} moved into the shielded set`;
    case 'unshield': return typeof f.to === 'string' && f.to.startsWith('osmo1') ? `${amt} moved out of the shielded set to Osmosis` : `${amt} moved out of the shielded set`;
    case 'bond': return `${amt} staked`;
    case 'unbond': return `${amt} started unstaking`;
    case 'withdraw': return `${amt} unlocked and withdrawn from staking`;
    case 'rewards': return `${amt} of staking rewards claimed`;
    case 'lp_add': return `${amt} added to a pool`;
    case 'lp_remove': return `${amt} removed from a pool`;
    case 'pgf': return `${amt} of public funding paid`;
    case 'pos_balance': return `${amt} moved within the staking account`;
    case 'transfer': return `${amt} transferred on ${chain}`;
    default: return isIbcRefund(f) ? `${amt} refunded by the bridge` : isBotFlow(f) ? `${amt} bot round trip on Osmosis` : `${amt} moved on ${chain}`;
  }
}

/** "a", "a and b", "a, b and c" */
export const listWords = (parts: string[]): string =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

/**
 * An earlier move in the past tense, with its amount words ("49,491 and 99,221 NAM"), as a list of what an address did
 * before says it: "sold 49,491 and 99,221 NAM", "received 1,500,000 NAM from Namada", "bridged 300,000 NAM to Osmosis".
 * `received`: the address was that move's receiver; `many`: the amounts are of several moves.
 */
export function pastWords(m: Pick<Flow, 'kind' | 'chain'> & { meta?: Record<string, unknown> | null }, received: boolean, amt: string, many = false): string {
  const dest = bridgeDest(m.kind, m.chain);
  if (dest) return received ? `received ${amt} from ${dest === 'osmosis' ? 'Namada' : 'Osmosis'}` : `bridged ${amt} to ${CHAIN_WORD[dest]}`;
  switch (m.kind) {
    case 'buy': return `bought ${amt}`;
    case 'sell': return `sold ${amt}`;
    case 'shield': return `moved ${amt} into the shielded set`;
    case 'unshield': return `moved ${amt} out of the shielded set`;
    case 'bond': return `staked ${amt}`;
    case 'unbond': return `started unstaking ${amt}`;
    case 'withdraw': return `withdrew ${amt} from staking`;
    case 'rewards': return `claimed ${amt} of staking rewards`;
    case 'lp_add': return `added ${amt} to a pool`;
    case 'lp_remove': return `removed ${amt} from a pool`;
    case 'pgf': return received ? `received ${amt} of public funding` : `paid ${amt} of public funding`;
    case 'transfer': return `${received ? 'received' : 'sent'} ${amt} in ${many ? 'transfers' : 'a transfer'}`;
    default: return isIbcRefund(m) ? `got ${amt} back from the bridge` : `moved ${amt}`;
  }
}

// ---------------------------------------------------------------- governance

/** Whether a proposal is still open, as Supply's "Votes in progress" lists it (worker/src/analytics.ts: /voting|pending/). */
export const proposalOpen = (status: string): boolean => /voting|pending/i.test(status);

/**
 * A proposal's status in plain words: "Voting not started", "Voting now", "Passed", "Rejected", "Passed and executed".
 * The indexer's executedRejected is a rejection (nothing was executed); anything else keeps its own word, capitalised.
 */
export function proposalStatusWords(s: string): string {
  const t = s.trim().toLowerCase();
  if (t === 'executedpassed') return 'Passed and executed';
  if (t === 'executedrejected') return 'Rejected';
  if (/voting/.test(t)) return 'Voting now';
  if (/pending/.test(t)) return 'Voting not started';
  if (/passed/.test(t)) return 'Passed';
  if (/rejected/.test(t)) return 'Rejected';
  return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : 'Status not known';
}

/** A proposal's type in plain words: "Public funding", "Public funding payment", "Code change", "Proposal". */
export function proposalTypeWords(s: string): string {
  const t = s.trim().toLowerCase().replace(/_/g, ' ');
  if (/pgf/.test(t)) return t.includes('payment') ? 'Public funding payment' : 'Public funding';
  if (/wasm|code/.test(t)) return 'Code change';
  if (/default/.test(t)) return 'Proposal';
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Proposal';
}

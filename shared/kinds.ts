// Flow kinds: what the page shows for each kind of move (system.md 8 "Tag", 11 "Flow kinds").
// The plain word is visible; the expert term (the old word) is in the tag's popover.
// Hues are CSS variable names from tokens.css; glyph names are the shell's Icon names. The web app
// (web/src/lib/kinds.ts re-exports this file) and the Worker's Discord alerts share the table, so a card's colour is
// the colour of the tag the site puts on the same move.
//
// Bridge crossings are named by where the NAM went, never by record kind: each crossing is recorded on
// both chains (an ibc_out on the sending chain, an ibc_in on the receiving one), so "in" and "out"
// alone meant opposite directions on the two chains. Osmosis ibc_in and Namada ibc_out are NAM going to
// Osmosis (the market); Osmosis ibc_out and Namada ibc_in are NAM going to Namada.
import type { Chain, FlowKind } from './types';

export type TagKind =
  | 'buy' | 'sell' | 'shieldIn' | 'shieldOut' | 'staked' | 'unstaking' | 'unlocked'
  | 'toOsmosis' | 'toNamada' | 'bridgedIn' | 'bridgedOut' | 'poolAdd' | 'poolRemove' | 'bot' | 'pgf'
  | 'transfer' | 'reward' | 'bridgeRefund' | 'posBalance';

export type Hue = 'buy' | 'sell' | 'ibc' | 'shield' | 'pos' | 'neutral';

/**
 * Each hue's dark-theme value in web/src/styles/tokens.css (docs/design/system.md 4.1), for a place that cannot read
 * the CSS: a Discord alert's colour bar. `neutral` is --ink-2, as a neutral tag's text is.
 */
export const HUE_HEX: Record<Hue, number> = { buy: 0x3987e5, sell: 0xd95926, ibc: 0x199e70, shield: 0x9085e9, pos: 0xd55181, neutral: 0xa8a8a8 };

export interface KindInfo {
  /** Sentence-case word on the tag. */
  word: string;
  /** Icon name (12 px flow glyph). */
  glyph: string;
  /** Hue token (`--buy`, `--sell`, …); `neutral` uses ink-2. */
  hue: Hue;
  /** The expert term, shown on tap. */
  expert: string;
  /** Glossary entry id, when the tag has one. */
  term?: string;
}

export const KINDS: Record<TagKind, KindInfo> = {
  buy:        { word: 'Buy',               glyph: 'buy',         hue: 'buy',     expert: 'Swap: USDC or OSMO for NAM' },
  sell:       { word: 'Sell',              glyph: 'sell',        hue: 'sell',    expert: 'Swap: NAM for USDC or OSMO' },
  shieldIn:   { word: 'Shielded in',       glyph: 'shield',      hue: 'shield',  expert: 'Shield (into the MASP)', term: 'shielded-set' },
  shieldOut:  { word: 'Shielded out',      glyph: 'shield',      hue: 'shield',  expert: 'Unshield (out of the MASP)', term: 'shielded-set' },
  staked:     { word: 'Staked',            glyph: 'lock',        hue: 'pos',     expert: 'Bond', term: 'staked' },
  unstaking:  { word: 'Unstaking',         glyph: 'lock',        hue: 'pos',     expert: 'Unbond', term: 'unstaking' },
  unlocked:   { word: 'Unlocked',          glyph: 'lock',        hue: 'pos',     expert: 'Withdraw', term: 'unlocked' },
  toOsmosis:  { word: 'Bridged to Osmosis', glyph: 'bridge',     hue: 'ibc',     expert: 'IBC transfer, Namada to Osmosis', term: 'bridged' },
  toNamada:   { word: 'Bridged to Namada', glyph: 'bridge',      hue: 'ibc',     expert: 'IBC transfer, Osmosis to Namada', term: 'bridged' },
  // A record kind without its chain (the Activity "What" filter asks the server by record kind): the
  // direction is not known here, so the words name the record, not a direction.
  bridgedIn:  { word: 'Bridge, arriving side', glyph: 'bridge',  hue: 'ibc',     expert: 'IBC transfer, the receiving chain’s record', term: 'bridged' },
  bridgedOut: { word: 'Bridge, leaving side', glyph: 'bridge',   hue: 'ibc',     expert: 'IBC transfer, the sending chain’s record', term: 'bridged' },
  poolAdd:    { word: 'Added to pool',     glyph: 'pool-add',    hue: 'buy',     expert: 'Liquidity added (LP add)', term: 'pool' },
  poolRemove: { word: 'Removed from pool', glyph: 'pool-remove', hue: 'sell',    expert: 'Liquidity removed (LP remove)', term: 'pool' },
  bot:        { word: 'Bot trade',         glyph: 'bot',         hue: 'neutral', expert: 'Arbitrage', term: 'bot-trade' },
  pgf:        { word: 'Public funding',    glyph: 'pgf',         hue: 'neutral', expert: 'PGF, public goods funding' },
  transfer:   { word: 'Transfer',          glyph: 'arrow',       hue: 'neutral', expert: 'Transparent transfer' },
  reward:     { word: 'Staking reward',    glyph: 'lock',        hue: 'pos',     expert: 'Rewards claim' },
  // An Osmosis → Namada send whose packet timed out: the bridge gave the NAM back to the sender on Osmosis
  // (shared/flow-rules.ts isIbcRefund). Not a trade and not a crossing, so it has no sign.
  bridgeRefund: { word: 'Bridge refund',   glyph: 'bridge',      hue: 'ibc',     expert: 'IBC timeout refund (the send timed out; the NAM went back to the sender on Osmosis)', term: 'bridged' },
  // A transfer of the staking account's own balance (shared/types.ts 'pos_balance'): not staking or unstaking by a holder.
  posBalance: { word: 'Staking account balance', glyph: 'lock',  hue: 'pos',     expert: 'Internal transfer', term: 'staking-account' },
};

/** The API's flow kind to the tag kind. */
export const FLOW_TO_TAG: Record<FlowKind, TagKind> = {
  buy: 'buy',
  sell: 'sell',
  shield: 'shieldIn',
  unshield: 'shieldOut',
  bond: 'staked',
  unbond: 'unstaking',
  withdraw: 'unlocked',
  ibc_in: 'bridgedIn',
  ibc_out: 'bridgedOut',
  lp_add: 'poolAdd',
  lp_remove: 'poolRemove',
  other: 'bot',
  pgf: 'pgf',
  transfer: 'transfer',
  rewards: 'reward',
  pos_balance: 'posBalance',
};

/** Where a bridge crossing took the NAM, from one of its records; null for other kinds or an unknown chain. */
export function bridgeDest(kind: FlowKind | string, chain: Chain | string | null | undefined): 'osmosis' | 'namada' | null {
  if ((kind !== 'ibc_in' && kind !== 'ibc_out') || (chain !== 'osmosis' && chain !== 'namada')) return null;
  return (chain === 'osmosis') === (kind === 'ibc_in') ? 'osmosis' : 'namada';
}

/**
 * The API's flow kind to the tag kind. Pass the flow's chain: a bridge record then says where the NAM
 * went ('toOsmosis', 'toNamada'). Without it a bridge record keeps its record word (no direction).
 */
export const tagKindOf = (k: FlowKind | string, chain?: Chain | string | null): TagKind => {
  const dest = bridgeDest(k, chain);
  if (dest) return dest === 'osmosis' ? 'toOsmosis' : 'toNamada';
  return (FLOW_TO_TAG as Record<string, TagKind>)[k] ?? 'transfer';
};
export const kindInfo = (k: TagKind | FlowKind | string, chain?: Chain | string | null): KindInfo => {
  const dest = bridgeDest(k, chain);
  if (dest) return KINDS[dest === 'osmosis' ? 'toOsmosis' : 'toNamada'];
  return (KINDS as Record<string, KindInfo>)[k] ?? KINDS[tagKindOf(k)];
};

/**
 * Sign of a flow kind from the market's point of view (+ NAM bought or arriving on Osmosis, − sold or
 * leaving it). A bridge record without its chain has no sign: its direction is not known.
 */
export const kindSign = (k: TagKind): 1 | -1 | 0 =>
  k === 'buy' || k === 'toOsmosis' || k === 'poolAdd' || k === 'shieldIn' ? 1
  : k === 'sell' || k === 'toNamada' || k === 'poolRemove' || k === 'shieldOut' ? -1
  : 0;

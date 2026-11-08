// NAM since genesis (the Supply page): the parts of the growth from the genesis total to the minted total now, from
// two live figures (all NAM in existence; the chain's running total of shielded rewards) and the dated split in
// web/src/generated/supply.ts (staking and public-funding inflation over the epochs the public record lets them be told
// apart). Pure functions, no React: a missing or ill-fitting input gives null with the reason, never a stand-in (N2).
import type { SupplySplit } from '../../generated/supply';

export interface GenesisParts {
  genesisNam: number;
  nowNam: number;
  /** all NAM now less the genesis total */
  growthNam: number;
  /** minted into the shielded pool as shielded rewards: the chain's own running total */
  rewardsNam: number;
  /** staking and public-funding inflation over the split's epochs */
  stakingNam: number;
  publicFundingNam: number;
  /** the rest of the growth: staking and public funding before the split's first epoch, and whatever was minted after its last */
  togetherNam: number;
}

export type GenesisAnswer = { parts: GenesisParts; why: null } | { parts: null; why: string };

/**
 * The four parts of the growth since genesis, or why they cannot be said: a live figure not read, a total at or below
 * the genesis total, or a remainder below zero (the live figures do not fit the dated split, which is then not drawn).
 */
export function sinceGenesisParts(total: number | null | undefined, rewards: number | null | undefined, split: SupplySplit): GenesisAnswer {
  if (total == null || !Number.isFinite(total)) return { parts: null, why: 'All NAM in existence was not read.' };
  if (rewards == null || !Number.isFinite(rewards)) return { parts: null, why: 'The chain’s total of shielded rewards was not read.' };
  const growthNam = total - split.genesisNam;
  if (!(growthNam > 0)) return { parts: null, why: 'All NAM in existence reads at or below the genesis total, so no growth can be split.' };
  const togetherNam = growthNam - rewards - split.stakingNam - split.publicFundingNam;
  if (togetherNam < 0 || rewards < 0) return { parts: null, why: 'The live figures do not fit the dated split (the parts would exceed the growth), so it is not shown.' };
  return {
    parts: { genesisNam: split.genesisNam, nowNam: total, growthNam, rewardsNam: rewards, stakingNam: split.stakingNam, publicFundingNam: split.publicFundingNam, togetherNam },
    why: null,
  };
}

/** Each part's share of the growth, in percent, in the bar's order: rewards, staking, public funding, together. */
export function genesisShares(p: GenesisParts): { key: 'rewards' | 'staking' | 'publicFunding' | 'together'; nam: number; pct: number }[] {
  const of = p.growthNam;
  const pct = (n: number) => (of > 0 ? (n / of) * 100 : 0);
  return [
    { key: 'rewards', nam: p.rewardsNam, pct: pct(p.rewardsNam) },
    { key: 'staking', nam: p.stakingNam, pct: pct(p.stakingNam) },
    { key: 'publicFunding', nam: p.publicFundingNam, pct: pct(p.publicFundingNam) },
    { key: 'together', nam: p.togetherNam, pct: pct(p.togetherNam) },
  ];
}

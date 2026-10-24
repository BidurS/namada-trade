// The guides' search-facing words: path, name, heading, <title>, description and the day the text was last checked
// against its sources. shared/routes.ts builds one route from each, so the shell's first chunk carries only these
// lines; the guides' text, citations and questions are in shared/guides.ts (loaded with the guide screen).
//
// The rules of shared/copy.ts apply, and one more: every sentence about Namada is cited to Namada's own docs, specs or
// posts (shared/guides.ts), and no live figure is typed; a guide links the page that shows it instead.

export type GuideSlug =
  | 'what-is-namada'
  | 'how-to-buy-nam'
  | 'how-to-stake-nam'
  | 'how-the-shielded-pool-works'
  | 'how-namada-governance-works'
  | 'nam-supply-and-inflation';

export interface GuideMeta {
  slug: GuideSlug;
  /** Short name for links (the hub, the footer of a guide, search). */
  label: string;
  /** The visible heading: the question the guide answers. */
  h1: string;
  /** <title> without the site suffix (at most 46 characters). */
  title: string;
  /** Meta description, at most 155 characters. */
  description: string;
  /** The day the text was last checked against every source it cites (YYYY-MM-DD): the sitemap's lastmod. */
  updated: string;
}

export const GUIDES_PATH = '/guides';
export const guidePath = (slug: GuideSlug): string => `${GUIDES_PATH}/${slug}`;

export const GUIDE_META: GuideMeta[] = [
  {
    slug: 'what-is-namada',
    label: 'What is Namada?',
    h1: 'What is Namada, and what is NAM used for?',
    title: 'What is Namada: the network and its NAM coin',
    description: 'Namada is a proof-of-stake network built for private transfers of many assets. What NAM pays for, how the network is run, and which wallets work with it.',
    updated: '2026-10-24',
  },
  {
    slug: 'how-to-buy-nam',
    label: 'How to buy NAM',
    h1: 'How do you buy NAM, and how does it reach a Namada wallet?',
    title: 'How to buy NAM and move it to Namada',
    description: 'Where NAM trades, how a swap on Osmosis works, and how NAM moves between Osmosis and a Namada wallet, transparent or shielded, step by step.',
    updated: '2026-10-24',
  },
  {
    slug: 'how-to-stake-nam',
    label: 'How to stake NAM',
    h1: 'How do you stake NAM, claim rewards and unstake?',
    title: 'How to stake NAM, claim rewards and unstake',
    description: 'Staking NAM step by step: picking a validator, when a stake starts to count, claiming rewards, the risk of slashing, and how unstaking and withdrawal work.',
    updated: '2026-10-24',
  },
  {
    slug: 'how-the-shielded-pool-works',
    label: 'How the shielded pool works',
    h1: 'How does Namada\'s shielded pool work, and what are shielded rewards?',
    title: 'How Namada\'s shielded pool and rewards work',
    description: 'What the shielded pool hides and what stays public, how shielding and unshielding work, what viewing keys are for, and how shielded rewards are paid.',
    updated: '2026-10-24',
  },
  {
    slug: 'how-namada-governance-works',
    label: 'How governance works',
    h1: 'How does Namada governance work?',
    title: 'How Namada governance works: proposals, votes',
    description: 'Who can propose a change to Namada, who votes and how, when a proposal passes, and how public goods funding pays for work on the ecosystem.',
    updated: '2026-10-24',
  },
  {
    slug: 'nam-supply-and-inflation',
    label: 'NAM supply and inflation',
    h1: 'Where does new NAM come from?',
    title: 'NAM supply, inflation and rewards explained',
    description: 'How much NAM existed at launch, where new NAM comes from (staking rewards, public goods funding, shielded rewards) and which settings can change it.',
    updated: '2026-10-24',
  },
];

export const guideMeta = (slug: string): GuideMeta | undefined => GUIDE_META.find((g) => g.slug === slug);

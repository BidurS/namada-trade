// The guides' text (headings, names and descriptions are in shared/guide-meta.ts). The Worker renders it into the
// server page (worker/src/seo.ts guideHtml) and the guide screen renders the same sentences, so what a search engine
// reads is what a person reads.
//
// Rules, on top of those in shared/copy.ts (test/guides.test.ts checks what a test can):
// - Every paragraph about Namada cites at least one of Namada's own pages (docs.namada.net, specs.namada.net,
//   namada.net and its blog, Namada's GitHub, forum posts by its stewards); a sentence about Osmosis cites Osmosis's
//   docs. The guide says only what its sources say; each guide was checked against them on its `updated` day.
// - No figure that can change is typed (a rate, a balance, a price, a setting governance can vote on): the section
//   links the page of this site that shows it now. A figure that cannot change (a past date, the amount at launch)
//   is allowed in a paragraph marked `fixed`.
// - Plain words: no IBC, MASP, PoS or DEX in view; spell the thing out.
import type { GuideSlug } from './guide-meta';
import type { Guide, Source } from './guide-types';

/** Namada's own pages and Osmosis's docs, by id, shared by the guides. */
const S = {
  docsIndex: { publisher: 'Namada docs', title: 'About Namada', url: 'https://docs.namada.net/' },
  specsIntro: { publisher: 'Namada specs', title: 'Introduction', url: 'https://specs.namada.net/' },
  mainnets: { publisher: 'Namada docs', title: 'Mainnets', url: 'https://docs.namada.net/networks/mainnets' },
  blogLive: { publisher: 'Namada blog', title: 'Namada Mainnet is Live!', url: 'https://namada.net/blog/namada-mainnet-is-live' },
  blogComplete: { publisher: 'Namada blog', title: 'Namada Mainnet Launch is Complete!', url: 'https://namada.net/blog/namada-mainnet-launch-is-complete' },
  blogShielding: { publisher: 'Namada blog', title: 'Shielding the Multichain: How Namada\'s Data Protection Works', url: 'https://namada.net/blog/shielding-the-multichain-how-namadas-data-protection-works' },
  impressum: { publisher: 'namada.net', title: 'Impressum', url: 'https://namada.net/impressum' },
  home: { publisher: 'namada.net', title: 'Namada: your gateway to the shielded multichain', url: 'https://namada.net/' },
  start: { publisher: 'namada.net', title: 'Start', url: 'https://namada.net/start' },
  stakingPage: { publisher: 'namada.net', title: 'Staking', url: 'https://namada.net/staking' },
  governancePage: { publisher: 'namada.net', title: 'Governance', url: 'https://namada.net/governance' },
  keychainPage: { publisher: 'namada.net', title: 'Keychain', url: 'https://namada.net/keychain' },
  delegators: { publisher: 'Namada docs', title: 'Bonding and proof of stake', url: 'https://docs.namada.net/users/delegators' },
  governanceDocs: { publisher: 'Namada docs', title: 'Governance', url: 'https://docs.namada.net/users/governance' },
  pgfDocs: { publisher: 'Namada docs', title: 'Public Goods Funding', url: 'https://docs.namada.net/users/public-goods-funding' },
  feeSpecs: { publisher: 'Namada specs', title: 'Fee system', url: 'https://specs.namada.net/base-ledger/fee-system' },
  addresses: { publisher: 'Namada docs', title: 'An introduction to Namada addresses and keys', url: 'https://docs.namada.net/users/addresses' },
  shieldedDocs: { publisher: 'Namada docs', title: 'The multi-asset shielded pool', url: 'https://docs.namada.net/users/shielded-accounts' },
  shieldedRewards: { publisher: 'Namada docs', title: 'Shielded rewards', url: 'https://docs.namada.net/users/shielded-accounts/shielded-rewards' },
  ibcDocs: { publisher: 'Namada docs', title: 'Transferring assets over Inter-Blockchain Communication', url: 'https://docs.namada.net/users/ibc' },
  namadillo: { publisher: 'Namada docs', title: 'Namadillo', url: 'https://docs.namada.net/users/namadillo' },
  namadilloIbc: { publisher: 'Namada docs', title: 'Namadillo: Inter-Blockchain Communication transfers', url: 'https://docs.namada.net/users/namadillo/ibc' },
  namadilloStaking: { publisher: 'Namada docs', title: 'Namadillo: staking', url: 'https://docs.namada.net/users/namadillo/staking' },
  namadilloGovernance: { publisher: 'Namada docs', title: 'Namadillo: governance', url: 'https://docs.namada.net/users/namadillo/governance' },
  blogNamadillo: { publisher: 'Namada blog', title: 'Introducing Namadillo: Your Portal to the Shielded Ecosystem', url: 'https://namada.net/blog/introducing-namadillo-your-portal-to-the-shielded-ecosystem' },
  keychainDocs: { publisher: 'Namada docs', title: 'Namada Keychain browser extension', url: 'https://docs.namada.net/users/keychain' },
  keychainLedger: { publisher: 'Namada docs', title: 'Using a Ledger hardware wallet', url: 'https://docs.namada.net/users/keychain/ledger' },
  cliWallet: { publisher: 'Namada docs', title: 'File system wallet', url: 'https://docs.namada.net/users/wallet/file-system-wallet' },
  services: { publisher: 'Namada docs', title: 'Services and infrastructure', url: 'https://docs.namada.net/networks/services' },
  namadilloShield: { publisher: 'Namada docs', title: 'Namadillo: shielding assets', url: 'https://docs.namada.net/users/namadillo/shield' },
  namadilloUnshield: { publisher: 'Namada docs', title: 'Namadillo: unshielding assets', url: 'https://docs.namada.net/users/namadillo/unshield' },
  transparentIbc: { publisher: 'Namada docs', title: 'Transparent transfers between chains', url: 'https://docs.namada.net/users/ibc/transparent-ibc' },
  relaying: { publisher: 'Namada docs', title: 'Relaying on Namada', url: 'https://docs.namada.net/operators/ibc' },
  chainRegistry: { publisher: 'Namada on GitHub', title: 'Namada chain registry: the Namada and Osmosis channel', url: 'https://github.com/namada-net/namada-chain-registry/blob/main/_IBC/namada-osmosis.json' },
  osmosisNam: { publisher: 'Osmosis app', title: 'Namada (NAM)', url: 'https://app.osmosis.zone/assets/NAM' },
  osmoTrading: { publisher: 'Osmosis docs', title: 'How trading works on Osmosis', url: 'https://docs.osmosis.zone/learn/how-trading-works/' },
  osmoStart: { publisher: 'Osmosis docs', title: 'Getting started', url: 'https://docs.osmosis.zone/learn/get-started' },
  osmoGlossary: { publisher: 'Osmosis docs', title: 'Glossary', url: 'https://docs.osmosis.zone/learn/terminology' },
  osmoToken: { publisher: 'Osmosis docs', title: 'The OSMO token', url: 'https://docs.osmosis.zone/learn/osmo/' },
  specsMasp: { publisher: 'Namada specs', title: 'Multi-asset shielded pool', url: 'https://specs.namada.net/modules/masp' },
  maspLedger: { publisher: 'Namada specs', title: 'Shielded pool storage interface specification', url: 'https://specs.namada.net/modules/masp/ledger-integration' },
  blogMaspCc: { publisher: 'Namada blog', title: 'Understanding the shielded pool and convert circuits', url: 'https://namada.net/blog/understanding-the-masp-and-cc-circuits' },
  privacyDocs: { publisher: 'Namada docs', title: 'Shielding', url: 'https://docs.namada.net/introduction/privacy' },
  shieldingDocs: { publisher: 'Namada docs', title: 'Shielding assets', url: 'https://docs.namada.net/users/shielded-accounts/shielding' },
  shieldedTransfers: { publisher: 'Namada docs', title: 'Shielded transfers', url: 'https://docs.namada.net/users/shielded-accounts/shielded-transfers' },
  unshieldingDocs: { publisher: 'Namada docs', title: 'Unshielding assets', url: 'https://docs.namada.net/users/shielded-accounts/unshielding' },
  shieldedSync: { publisher: 'Namada docs', title: 'Shielded sync', url: 'https://docs.namada.net/users/shielded-accounts/shielded-sync' },
  maspKeys: { publisher: 'Namada docs', title: 'Shielded key management', url: 'https://docs.namada.net/users/shielded-accounts/masp-keys' },
  poolIncentives: { publisher: 'Namada specs', title: 'Shielded pool incentives', url: 'https://specs.namada.net/modules/masp/shielded-pool-incentives' },
  feesDocs: { publisher: 'Namada docs', title: 'Fees on Namada', url: 'https://docs.namada.net/users/fees' },
  genesisBalances: { publisher: 'Namada on GitHub', title: 'Mainnet genesis: balances', url: 'https://github.com/namada-net/namada-mainnet-genesis/blob/main/genesis/balances.toml' },
  genesisParams: { publisher: 'Namada on GitHub', title: 'Mainnet genesis: parameters', url: 'https://github.com/namada-net/namada-mainnet-genesis/blob/main/genesis/parameters.toml' },
  blogGenesis: { publisher: 'Namada blog', title: 'Namada Community Genesis Process, Cryptoeconomic Mechanisms, and the Genesis Allocations', url: 'https://namada.net/blog/namada-community-genesis-process-cryptoeconomic-mechanisms-and-the-genesis-allocations' },
  inflationSpecs: { publisher: 'Namada specs', title: 'Inflation system', url: 'https://specs.namada.net/modules/proof-of-stake/inflation-system' },
  rewardDistribution: { publisher: 'Namada specs', title: 'Reward distribution', url: 'https://specs.namada.net/modules/proof-of-stake/reward-distribution' },
  blogCubic: { publisher: 'Namada blog', title: 'The Namada Cubic Proof-of-Stake', url: 'https://namada.net/blog/namada-cubic-proof-of-stake' },
  govOnChain: { publisher: 'Namada specs', title: 'On-chain governance', url: 'https://specs.namada.net/modules/governance/on-chain' },
  govCode: { publisher: 'Namada on GitHub', title: 'Governance code: finalizing a proposal', url: 'https://github.com/namada-net/namada/blob/main/crates/governance/src/finalize_block.rs' },
  cubicSlashing: { publisher: 'Namada specs', title: 'Slashing procedure', url: 'https://specs.namada.net/modules/proof-of-stake/cubic-slashing' },
  operatorStaking: { publisher: 'Namada docs', title: 'Staking (bonding)', url: 'https://docs.namada.net/operators/validators/staking' },
  cubicSlashingDocs: { publisher: 'Namada docs', title: 'Cubic slashing', url: 'https://docs.namada.net/introduction/protocol-intro/cubic-slashing' },
  jailing: { publisher: 'Namada docs', title: 'Jailed validators', url: 'https://docs.namada.net/operators/validators/jailing' },
  proposalTypes: { publisher: 'Namada docs', title: 'Types of governance proposals', url: 'https://docs.namada.net/users/governance/proposal-types' },
  governanceActions: { publisher: 'Namada docs', title: 'Governance actions', url: 'https://docs.namada.net/users/governance/governance-actions' },
  proposalStructure: { publisher: 'Namada docs', title: 'Creating a proposal', url: 'https://docs.namada.net/users/governance/proposal-structure' },
  protocolIntro: { publisher: 'Namada docs', title: 'Introduction to the Namada protocol', url: 'https://docs.namada.net/introduction/protocol-intro' },
  pgfFunding: { publisher: 'Namada docs', title: 'Proposing funding', url: 'https://docs.namada.net/users/public-goods-funding/funding' },
  pgfStewards: { publisher: 'Namada docs', title: 'Stewards', url: 'https://docs.namada.net/users/public-goods-funding/stewards' },
  govUtils: { publisher: 'Namada on GitHub', title: 'Governance code: counting votes', url: 'https://github.com/namada-net/namada/blob/main/crates/governance/src/utils.rs' },
} satisfies Record<string, Source>;

const pick = <K extends keyof typeof S>(...ids: K[]): Record<string, Source> => Object.fromEntries(ids.map((id) => [id, S[id]]));

const whatIsNamada: Guide = {
  slug: 'what-is-namada',
  published: '2026-10-24',
  lead: [
    { t: 'Namada is a proof-of-stake blockchain built for data protection: it uses zero-knowledge proofs so that assets from Namada and from other chains can be held and moved privately in one shared shielded pool.', src: ['docsIndex', 'specsIntro', 'shieldedDocs'] },
    { t: 'NAM is Namada\'s own coin. It is staked to secure the network, it carries the votes in governance, it pays transaction fees, and newly minted NAM rewards stakers and people who keep assets in the shielded pool.', src: ['stakingPage', 'governancePage', 'start', 'delegators', 'shieldedRewards', 'poolIncentives'] },
  ],
  sections: [
    {
      id: 'how-it-runs',
      h2: 'How is the Namada network run?',
      paras: [
        { t: 'Namada is its own layer-one chain secured by proof of stake: validators agree on blocks with the CometBFT consensus algorithm, any account can stake NAM with a validator, and a validator in the consensus set uses the NAM staked to it as its voting power over new blocks.', src: ['specsIntro', 'delegators'] },
        { t: 'Its mainnet started on 3 December 2024 at 15:00 UTC and opened in five phases; on 20 June 2025 Namada announced that the launch was complete, with full transferability of NAM enabled.', src: ['mainnets', 'blogLive', 'blogComplete'], fixed: true },
        { t: 'The Anoma Foundation owns and operates namada.net and stewarded the code for the mainnet, and said at launch that it operated no validators; the launch was coordinated by many community teams, and the chain is governed by the people who stake NAM.', src: ['impressum', 'blogLive', 'governancePage'] },
      ],
      see: [{ to: '/staking', label: 'How much NAM is staked now, and the staking rate' }],
    },
    {
      id: 'what-nam-does',
      h2: 'What is NAM used for?',
      paras: [
        { t: 'NAM is the staking coin: staked NAM gives validators their voting power over new blocks, and stakers earn a share of the NAM minted as rewards once per epoch.', src: ['stakingPage', 'delegators'] },
        { t: 'NAM is the voting coin too: accounts with staked NAM vote on governance proposals, with voting power in proportion to the NAM they have staked.', src: ['governanceDocs', 'governancePage'] },
        { t: 'Fees can be paid in NAM, which namada.net says gives the lowest fees, or in other tokens on a list that governance controls; every fee goes to the validator that proposed the block.', src: ['start', 'feeSpecs'] },
        { t: 'New NAM also pays for public goods, minted into an on-chain fund whose payments are approved by governance or by stewards that governance elects, and rewards people who keep eligible assets in the shielded pool.', src: ['pgfDocs', 'shieldedRewards', 'poolIncentives'] },
      ],
      see: [{ to: '/', label: 'NAM price and where all NAM sits now' }],
    },
    {
      id: 'what-is-private',
      h2: 'What does Namada keep private?',
      paras: [
        { t: 'Namada has two kinds of address you send to: a transparent address, starting with tnam, whose balance and transactions are public, and a shielded payment address, starting with znam, which receives into the shielded pool.', src: ['addresses'] },
        { t: 'Every asset shares the one shielded pool, so each shielded transaction strengthens the protection for everyone in it; the pool is a zero-knowledge circuit that extends the Sapling circuit of Zcash to many assets.', src: ['shieldedDocs', 'blogShielding'] },
      ],
      see: [{ to: '/shielded', label: 'How much NAM is in the shielded pool now' }],
    },
    {
      id: 'connections',
      h2: 'Which chains does Namada connect to?',
      paras: [
        { t: 'Namada connects to other chains through Inter-Blockchain Communication, the protocol Cosmos chains speak to move assets between them, so assets from those chains can be brought to Namada once a connection between the two chains is open.', src: ['ibcDocs', 'docsIndex', 'home'] },
        { t: 'At the time of writing, namada.net lists support for other ecosystems, such as Ethereum and Solana, as coming soon.', src: ['home'] },
      ],
      see: [{ to: '/osmosis', label: 'NAM on Osmosis: its pools and what trades there' }],
    },
    {
      id: 'wallets',
      h2: 'Which wallets work with Namada?',
      paras: [
        { t: 'Namada Keychain is the browser extension for Namada keys and accounts: namada.net offers it for Chrome and Firefox, it signs what you do in Namada web apps, and it can be used with a Ledger hardware wallet.', src: ['keychainDocs', 'keychainPage', 'start'] },
        { t: 'Namadillo is a web app for using Namada with the Keychain: staking, voting, and moving assets between Namada and other chains. Namada\'s docs say Heliax develops it, and community members host copies of it too.', src: ['namadillo', 'namadilloStaking', 'namadilloGovernance', 'namadilloIbc', 'blogNamadillo'] },
        { t: 'Keplr, the Cosmos wallet, works alongside Namadillo: it signs the other chain\'s side of a transfer into Namada, while the Namada side is signed with Namada Keychain.', src: ['namadilloIbc'] },
        { t: 'A Ledger works through Namada Keychain or the command line. Shielded actions need a Ledger Nano S Plus or newer; Namada\'s docs say older devices can still make transparent ones such as staking, while namada.net says the original Nano S is not supported. For the command line, the namadaw wallet keeps encrypted keys on disk.', src: ['keychainLedger', 'start', 'cliWallet'] },
      ],
    },
  ],
  faq: [
    {
      q: 'When did Namada launch?',
      a: [{ t: 'Namada\'s mainnet started on 3 December 2024 at 15:00 UTC, and on 20 June 2025 Namada announced that its five-phase launch was complete, with full transferability of NAM enabled.', src: ['mainnets', 'blogLive', 'blogComplete'], fixed: true }],
    },
    {
      q: 'Who runs Namada?',
      a: [{ t: 'Validators run the chain and NAM stakers govern it. The Anoma Foundation operates namada.net and stewarded the mainnet code, and said at launch that it operated no validators; Namada\'s docs list Heliax as the developer of Namadillo and the operator of public endpoints such as the block explorer.', src: ['stakingPage', 'governancePage', 'blogLive', 'impressum', 'namadillo', 'services'] }],
    },
    {
      q: 'Can fees be paid in coins other than NAM?',
      a: [{ t: 'Yes. Namada accepts fees in any token on a list that governance controls, and namada.net says paying in NAM gives the lowest fees.', src: ['feeSpecs', 'start'] }],
    },
    {
      q: 'Is NamadaTrade part of Namada?',
      a: [{ t: 'No. NamadaTrade is an independent site that reads public data from Namada and Osmosis. It is not run by or affiliated with the Anoma Foundation, Heliax or any other team that builds Namada.', src: [] }],
    },
  ],
  related: ['/guides/how-to-buy-nam', '/guides/how-to-stake-nam', '/guides/how-the-shielded-pool-works', '/guides/nam-supply-and-inflation', '/faq'],
  sources: pick('docsIndex', 'specsIntro', 'shieldedDocs', 'stakingPage', 'governancePage', 'start', 'shieldedRewards', 'delegators', 'mainnets', 'blogLive', 'blogComplete',
    'impressum', 'governanceDocs', 'feeSpecs', 'pgfDocs', 'addresses', 'blogShielding', 'ibcDocs', 'home', 'keychainDocs', 'keychainPage', 'namadillo', 'namadilloStaking',
    'namadilloGovernance', 'namadilloIbc', 'blogNamadillo', 'keychainLedger', 'cliWallet', 'services', 'poolIncentives'),
};

const howToBuyNam: Guide = {
  slug: 'how-to-buy-nam',
  published: '2026-10-24',
  lead: [
    { t: 'NAM can be bought by swapping another coin for it in the NAM pools on Osmosis, where a swap trades against a pool\'s reserves rather than through a central order-matching engine; it can then be moved to a Namada wallet, transparent or shielded, through Inter-Blockchain Communication.', src: ['osmosisNam', 'osmoTrading', 'namadilloIbc'] },
    { t: 'namada.net\'s Start page says you need NAM to use Namada and get the lowest fees, but does not say where to get it; this guide follows the route this site sees NAM take, with each step cited to Namada\'s or Osmosis\'s own docs.', src: ['start'] },
  ],
  sections: [
    {
      id: 'where-it-trades',
      h2: 'Where does NAM trade?',
      paras: [
        { t: 'The Osmosis app lists NAM as Namada (NAM): on Osmosis it is a coin that arrived from its home chain over Inter-Blockchain Communication, and it trades against other coins in pools.', src: ['osmosisNam', 'osmoStart', 'chainRegistry', 'osmoTrading'] },
        { t: 'Namada records its connection to Osmosis, the transfer channel between the two chains, in its official chain registry.', src: ['chainRegistry'] },
        { t: 'Prices on Osmosis come from the pools themselves: each pool sets a price from the ratio of the coins it holds, and Osmosis routes each trade across whichever pools give the best result.', src: ['osmoTrading'] },
      ],
      see: [{ to: '/osmosis', label: 'The NAM pools on Osmosis and what traded there' }, { to: '/trade', label: 'What a purchase of a given size costs now' }],
    },
    {
      id: 'buy-on-osmosis',
      h2: 'How do you buy NAM on Osmosis?',
      paras: [
        { t: 'You first need a Cosmos wallet such as Keplr with coins on Osmosis: Osmosis\'s guide says to install the wallet, connect it to the app, and deposit coins from their home chain on the Portfolio page.', src: ['osmoStart'] },
        { t: 'Then, on the Trade page, pick the coin you pay with and NAM as the coin you receive, and enter an amount. Each swap pays the pool\'s swap fee to its liquidity providers and a network fee for the transaction.', src: ['osmoTrading'] },
        { t: 'A larger order moves the price more: price impact is how much your own trade moves the price, and it grows with the size of the trade compared with the pool\'s depth. Your slippage tolerance sets how far the price may move before the swap is reverted instead of filled.', src: ['osmoTrading', 'osmoGlossary'] },
      ],
      see: [{ to: '/trade', label: 'The price move for each order size, quoted now' }],
    },
    {
      id: 'osmosis-to-namada',
      h2: 'How does NAM get from Osmosis to a Namada wallet?',
      paras: [
        { t: 'In Namadillo, a deposit brings coins from another chain into Namada: connect Keplr, which signs the transfer on the source chain, choose the chain, the asset and the amount, choose a transparent or shielded deposit, and approve it in Keplr.', src: ['namadilloIbc'] },
        { t: 'A shielded deposit lands straight in your shielded balance; Namadillo\'s Shield Assets menu offers the same deposit from another chain.', src: ['namadilloShield', 'namadilloIbc'] },
      ],
      see: [{ to: '/activity', label: 'Every crossing of NAM between Namada and Osmosis' }],
    },
    {
      id: 'namada-to-osmosis',
      h2: 'How does NAM go from Namada to Osmosis?',
      paras: [
        { t: 'In Namadillo, a withdrawal sends coins to another chain: choose the destination chain, the asset and the amount, give a receiver address on that chain (an Osmosis address starts with osmo) or connect Keplr to fill it in, and approve the transfer in Namada Keychain.', src: ['namadilloIbc'] },
        { t: 'Coins in your shielded balance can be withdrawn straight to another chain as well, from Namadillo\'s Unshield menu.', src: ['namadilloUnshield'] },
      ],
      see: [{ to: '/supply', label: 'NAM that crossed to Osmosis and has not been sold' }],
    },
    {
      id: 'costs-and-risks',
      h2: 'What does moving NAM cost, and what can go wrong?',
      paras: [
        { t: 'Each chain charges its own fee. On Namada you can pay in NAM, which namada.net says gives the lowest fees, or in another token on a list governance controls; on Osmosis the network fee can be paid in many of the tokens Osmosis lists.', src: ['start', 'feeSpecs', 'osmoToken'] },
        { t: 'A transfer between chains needs a relayer to carry it; if none does before it times out, the coins are returned to the sender.', src: ['transparentIbc', 'relaying'] },
        { t: 'If a transfer out of the shielded pool fails, the coins cannot go back to the shielded address: Namada Keychain creates a refund account that receives them in its transparent balance. Namada\'s docs advise moving them on soon; that account cannot be restored from your seed phrase, only from its own private key if you back it up.', src: ['namadilloUnshield'] },
        { t: 'The same coin sent over two different channels becomes two different coins on the receiving chain, so it matters which channel a transfer uses; Namada lists its channel to Osmosis in its chain registry.', src: ['transparentIbc', 'relaying', 'chainRegistry'] },
      ],
    },
  ],
  faq: [
    {
      q: 'Do I need NAM to pay fees on Namada?',
      a: [{ t: 'Not always. Namada accepts fees in any token on a list that governance controls, but namada.net says you need NAM to get the lowest fees.', src: ['feeSpecs', 'start'] }],
    },
    {
      q: 'Can coins go from Osmosis straight into a shielded balance?',
      a: [{ t: 'Yes. A shielded deposit in Namadillo moves assets from another chain directly into your shielded balance, signed in Keplr on the source chain.', src: ['namadilloShield', 'namadilloIbc'] }],
    },
    {
      q: 'Why did my transfer come back?',
      a: [{ t: 'A transfer that no relayer delivers before it times out is refunded to the sender. One that fails on its way out of the shielded pool is refunded to a refund account that Namada Keychain creates, in its transparent balance.', src: ['transparentIbc', 'namadilloUnshield'] }],
    },
    {
      q: 'Does NamadaTrade sell NAM or hold funds?',
      a: [{ t: 'No. NamadaTrade only reads public data: it shows Osmosis quotes and what trades paid, and it never trades for anyone or holds funds.', src: [] }],
    },
  ],
  related: ['/guides/what-is-namada', '/guides/how-the-shielded-pool-works', '/learn/how-nam-trading-works', '/osmosis', '/trade'],
  sources: pick('osmosisNam', 'osmoTrading', 'namadilloIbc', 'start', 'osmoStart', 'chainRegistry', 'osmoGlossary', 'namadilloShield', 'namadilloUnshield', 'feeSpecs', 'osmoToken', 'transparentIbc', 'relaying'),
};

const shieldedPool: Guide = {
  slug: 'how-the-shielded-pool-works',
  published: '2026-10-24',
  lead: [
    { t: 'Namada\'s shielded pool is one pool where assets from Namada and other chains are held and moved privately: a zero-knowledge circuit that extends the Sapling circuit of Zcash to many assets, which protects everyone in it more as more transactions use it.', src: ['shieldedDocs', 'specsMasp', 'privacyDocs'] },
    { t: 'Shielded rewards pay newly minted NAM to people who keep eligible assets in the pool, without locking them; governance decides which assets are eligible and how much each pays.', src: ['shieldedRewards', 'poolIncentives', 'namadilloShield'] },
  ],
  sections: [
    {
      id: 'hidden-and-public',
      h2: 'What does the shielded pool hide, and what stays public?',
      paras: [
        { t: 'Inside the pool, an observer cannot see who sent a transfer, who received it, which asset it was or how much was sent; Namada\'s posts describe shielded transactions as indistinguishable from one another, though a transaction\'s fee and the account that pays it are public.', src: ['blogMaspCc', 'blogShielding', 'maspLedger'] },
        { t: 'The pool\'s own balance of each asset is transparent, as in Zcash: from outside, the pool is an account holding assets. That is how this site can show how much NAM it holds. Assets that leave the pool are public again.', src: ['maspLedger', 'blogShielding'] },
        { t: 'Moving in and out can still reveal things: Namada\'s docs warn that transfers into and out of Namada can expose personal information, and advise bringing funds in from a different public address than the one used for your other public transactions.', src: ['privacyDocs'] },
      ],
      see: [{ to: '/shielded', label: 'How much NAM is in the shielded pool now, and what moved' }],
    },
    {
      id: 'moving-assets',
      h2: 'How do shielding, shielded transfers and unshielding work?',
      paras: [
        { t: 'Shielding moves assets from a transparent address, starting with tnam, to a shielded payment address, starting with znam; assets can also arrive in the pool straight from another chain.', src: ['shieldingDocs', 'namadilloShield'] },
        { t: 'A shielded transfer moves assets from one shielded address to another, and unshielding moves them back to a transparent address; both need the spending key of the shielded account.', src: ['shieldedTransfers', 'unshieldingDocs'] },
        { t: 'In Namadillo, Shield Assets takes assets from your transparent Namada balance or from another chain, and Unshield sends them to your transparent balance or straight to another chain.', src: ['namadilloShield', 'namadilloUnshield'] },
        { t: 'A wallet needs its own copy of the pool\'s notes to know what it holds, so it keeps in step with the chain, which Namada\'s docs call shielded sync and recommend doing through an indexer.', src: ['shieldedSync'] },
      ],
    },
    {
      id: 'keys',
      h2: 'What are spending keys, viewing keys and payment addresses?',
      paras: [
        { t: 'A spending key, starting with zsknam, authorizes spending from a shielded account and must be kept private; a viewing key, starting with zvknam, shows the account\'s incoming and outgoing balances but cannot spend them.', src: ['addresses', 'maspKeys'] },
        { t: 'A payment address, starting with znam, is what you share to receive. Many payment addresses can be made from the same spending key, and Namada\'s docs recommend making several.', src: ['addresses', 'maspKeys'] },
        { t: 'Viewing keys are how you choose what to reveal: you can let a specific party see an account\'s transaction history without giving them the power to spend.', src: ['blogShielding', 'addresses'] },
      ],
    },
    {
      id: 'shielded-rewards',
      h2: 'How do shielded rewards work?',
      paras: [
        { t: 'Namada pays shielded rewards in NAM to everyone keeping eligible assets in the pool, and the assets do not need to be locked; governance adds assets to the eligible list or removes them, and sets each asset\'s reward settings.', src: ['shieldedRewards', 'poolIncentives', 'namadilloShield'] },
        { t: 'Each asset\'s rate comes from a controller that aims at a target amount of that asset in the pool, so the rate is highest when little of the asset is shielded. The rewards are newly minted NAM, held in a shielded rewards pool until they are paid.', src: ['poolIncentives', 'namadilloShield'] },
        { t: 'Namadillo\'s docs describe rewards arriving every day, and namada.net says they are added to your shielded account automatically; the amounts Namadillo shows in advance are estimates.', src: ['namadilloShield', 'start'] },
        { t: 'Rewards compound while the assets stay shielded. They are claimed through the convert circuit, which happens when assets are converted to the current period, as they must be before they leave the pool.', src: ['poolIncentives'] },
      ],
      see: [{ to: '/shielded', label: 'The shielded pool\'s size and moves, with their sources' }],
    },
    {
      id: 'fees',
      h2: 'How are fees paid for shielded transactions?',
      paras: [
        { t: 'When a transaction spends from the shielded pool, as a shielded transfer or an unshielding does, its fee can be paid from the shielded balance, which Namada\'s docs call good practice for privacy; unless a gas payer is named, the command-line client unshields the fee to a disposable address and pays it from there.', src: ['feesDocs'] },
        { t: 'Paying the fee of a transparent transaction from the shielded pool is possible but discouraged, because it could link the two.', src: ['feesDocs'] },
      ],
    },
  ],
  faq: [
    {
      q: 'Can anyone see how much is in the shielded pool?',
      a: [{ t: 'Yes. The pool\'s balance of each asset is transparent, though who owns what inside it is not. This site shows the NAM in the pool with its source and time.', src: ['maspLedger', 'blogMaspCc'] }],
    },
    {
      q: 'Do I have to lock assets to earn shielded rewards?',
      a: [{ t: 'No. Assets do not need to be locked: rewards accrue while eligible assets stay in the shielded pool.', src: ['poolIncentives', 'shieldedRewards'] }],
    },
    {
      q: 'Which assets earn shielded rewards?',
      a: [{ t: 'Governance decides, so the list is read from the chain, not from a document: Namada\'s docs show the command that lists the eligible assets, and Namadillo shows no estimated reward for an asset that is not eligible.', src: ['shieldedRewards', 'namadilloShield'] }],
    },
    {
      q: 'Is the shielded pool the same as Zcash?',
      a: [{ t: 'No, but it builds on Zcash\'s work: Namada\'s pool extends the Sapling circuit developed for Zcash so that it can hold many assets, not one.', src: ['shieldedDocs', 'specsMasp'] }],
    },
    {
      q: 'Can a viewing key spend my funds?',
      a: [{ t: 'No. A viewing key shows an account\'s balances; only its spending key can spend them.', src: ['addresses'] }],
    },
  ],
  related: ['/shielded', '/guides/what-is-namada', '/guides/how-to-buy-nam', '/guides/nam-supply-and-inflation', '/faq'],
  sources: pick('shieldedDocs', 'specsMasp', 'privacyDocs', 'shieldedRewards', 'poolIncentives', 'namadilloShield', 'blogMaspCc', 'blogShielding', 'maspLedger', 'shieldingDocs',
    'shieldedTransfers', 'unshieldingDocs', 'namadilloUnshield', 'shieldedSync', 'addresses', 'maspKeys', 'start', 'feesDocs'),
};

const namSupply: Guide = {
  slug: 'nam-supply-and-inflation',
  published: '2026-10-24',
  lead: [
    { t: 'New NAM is minted by the protocol for three things: staking rewards, public goods funding and shielded rewards, and each adds to the supply. Governance sets the public goods rate directly, and the caps and targets of the controllers that set the staking and shielded reward rates each epoch.', src: ['inflationSpecs', 'pgfDocs', 'poolIncentives'] },
    { t: 'Namada\'s mainnet started with 1,000,000,000 NAM in its genesis balances file, a total namada.net\'s genesis post had proposed with no lockups.', src: ['genesisBalances', 'blogGenesis'], fixed: true },
  ],
  sections: [
    {
      id: 'at-launch',
      h2: 'How much NAM existed at launch?',
      paras: [
        { t: 'The mainnet genesis balances file, published in Namada\'s GitHub organisation, gives out 1,000,000,000 NAM in all, and the chain started from it on 3 December 2024 at 15:00 UTC.', src: ['genesisBalances', 'mainnets', 'blogLive'], fixed: true },
        { t: 'Before launch, namada.net\'s genesis post proposed that total with no lockups and set out the groups it would be allocated to.', src: ['blogGenesis'] },
        { t: 'NAM could not be transferred at first: the genesis settings made it non-transferable until the launch\'s last phase, and namada.net\'s post of 20 June 2025 announced that full transferability of NAM was enabled and the launch complete.', src: ['genesisParams', 'blogComplete'], fixed: true },
      ],
      see: [{ to: '/', label: 'All NAM in existence now, with its source and time' }],
    },
    {
      id: 'staking-rewards',
      h2: 'How do staking rewards add NAM?',
      paras: [
        { t: 'Each epoch the protocol mints staking rewards for the validators in the consensus set, with extra for proposing and voting on blocks; each validator\'s rewards are shared with its delegators by stake, after the validator\'s commission.', src: ['delegators', 'rewardDistribution', 'operatorStaking'] },
        { t: 'The amount follows a controller that aims at a target share of all NAM being staked: when less is staked than the target, the rate rises to draw more stake, up to a maximum rate. The target and the maximum are settings governance can change.', src: ['inflationSpecs', 'blogGenesis', 'blogCubic'] },
      ],
      see: [{ to: '/staking', label: 'The staking rate the network reports now' }],
    },
    {
      id: 'public-goods',
      h2: 'What is public goods funding?',
      paras: [
        { t: 'Public goods funding regularly mints NAM into an on-chain account, at a rate governance sets, to pay for public goods; stewards elected by governance help direct it and receive a share of inflation themselves.', src: ['pgfDocs', 'blogGenesis'] },
      ],
    },
    {
      id: 'shielded-minting',
      h2: 'How do shielded rewards add NAM?',
      paras: [
        { t: 'Namada also mints NAM to reward people who keep eligible assets in the shielded pool: the minted NAM is held in a shielded rewards pool and paid out per asset by controllers aiming at target amounts that governance configures.', src: ['poolIncentives'] },
      ],
      see: [{ to: '/shielded', label: 'The shielded pool now' }],
    },
    {
      id: 'switched-on',
      h2: 'Were these rates always on?',
      paras: [
        { t: 'No. In the genesis settings the staking, public goods and steward inflation rates were all zero, and namada.net\'s launch post said staking rewards and public goods funding would start in the second phase and shielded rewards in the fourth.', src: ['genesisParams', 'blogLive'] },
        { t: 'Because governance sets these settings and the controllers move the rates every epoch, the rates in force are read from the chain, not from a document. This site shows the staking rate the network\'s indexer reports, with the time it was read.', src: ['inflationSpecs', 'poolIncentives'] },
      ],
      see: [{ to: '/staking', label: 'The staking rate and how much is staked now' }],
    },
    {
      id: 'destroyed',
      h2: 'Is any NAM destroyed?',
      paras: [
        { t: 'Transaction fees are not destroyed: Namada\'s fee rules pay every fee to the validator that proposed the block.', src: ['feeSpecs'] },
        { t: 'The deposit locked with a governance proposal is returned to its author if the proposal passes and burned if it is rejected, according to Namada\'s specs and code.', src: ['govOnChain', 'govCode'] },
        { t: 'Slashed NAM is not destroyed for now: namada.net\'s proof-of-stake post says slashed tokens stay in the proof-of-stake account on mainnet, and that a future upgrade may move them to a slash pool; Namada\'s specs describe that pool, from which governance could refund validators or burn the tokens.', src: ['blogCubic', 'cubicSlashing'] },
      ],
    },
  ],
  faq: [
    {
      q: 'What is the total supply of NAM now?',
      a: [{ t: 'It changes as rewards are minted each epoch, so it is not typed here: this site\'s home page shows all NAM in existence, read from Namada nodes with its time.', src: ['delegators'] }],
    },
    {
      q: 'Are there token unlocks or vesting?',
      a: [{ t: 'namada.net\'s genesis post proposed the genesis supply with no lockups. At launch the genesis settings made NAM non-transferable; namada.net\'s post of 20 June 2025 announced that full transferability was enabled and the launch complete.', src: ['blogGenesis', 'genesisParams', 'blogComplete'], fixed: true }],
    },
    {
      q: 'Who decides the inflation rates?',
      a: [{ t: 'Governance. The staking rate\'s cap and target, the public goods rates and each asset\'s shielded reward settings are all parameters that NAM stakers can change by vote.', src: ['inflationSpecs', 'pgfDocs', 'shieldedRewards', 'governancePage'] }],
    },
    {
      q: 'Where do transaction fees go?',
      a: [{ t: 'To the validator that proposed the block, in whichever accepted token the fee was paid; fees are not shared among the other validators.', src: ['feeSpecs'] }],
    },
  ],
  related: ['/guides/how-to-stake-nam', '/guides/how-namada-governance-works', '/guides/how-the-shielded-pool-works', '/staking', '/'],
  sources: pick('inflationSpecs', 'pgfDocs', 'poolIncentives', 'genesisBalances', 'blogGenesis', 'mainnets', 'blogLive', 'genesisParams', 'blogComplete', 'delegators',
    'rewardDistribution', 'blogCubic', 'feeSpecs', 'govOnChain', 'govCode', 'cubicSlashing', 'shieldedRewards', 'governancePage', 'operatorStaking'),
};

const howToStake: Guide = {
  slug: 'how-to-stake-nam',
  published: '2026-10-24',
  lead: [
    { t: 'You stake NAM by bonding it to one or more validators, in Namadillo or from the command line. The stake starts to count after a short delay, earns rewards each epoch that you claim with a transaction, and takes a set number of epochs to unlock when you unstake.', src: ['namadilloStaking', 'delegators', 'stakingPage'] },
    { t: 'Staking also gives you a vote in governance, and it carries a risk: if your validator breaks the protocol, part of your stake can be slashed.', src: ['governanceDocs', 'delegators'] },
  ],
  sections: [
    {
      id: 'before-staking',
      h2: 'What do you need before staking?',
      paras: [
        { t: 'You need NAM in an account and some left over for fees: Namada\'s docs say a delegator needs an account with a positive NAM balance, and namada.net advises leaving some free balance to pay transaction fees.', src: ['delegators', 'stakingPage'] },
        { t: 'Namadillo\'s Staking panel does the rest: stake, unstake, redelegate and claim rewards, signed with Namada Keychain, which also supports a Ledger.', src: ['namadilloStaking'] },
      ],
      see: [{ to: '/staking', label: 'How much NAM is staked now, the staking rate and the unstaking wait' }],
    },
    {
      id: 'choosing',
      h2: 'How do you choose a validator?',
      paras: [
        { t: 'Check each validator\'s commission, the share of block rewards it keeps as its fee, before you stake; namada.net advises researching validators and their commission rates first.', src: ['delegators', 'stakingPage'] },
        { t: 'Size matters too: Namada\'s slashing makes it increasingly risky to stake with a validator that holds a lot of stake, and its docs suggest choosing validators with less stake, which also spreads stake across the network.', src: ['delegators'] },
        { t: 'Namadillo can stake with several validators in a single action.', src: ['namadilloStaking'] },
      ],
    },
    {
      id: 'when-it-counts',
      h2: 'When does a new stake start to count?',
      paras: [
        { t: 'A new bond becomes active after the pipeline length, a number of epochs set by the chain, which Namada\'s docs currently give as two; namada.net says an epoch lasts about six hours, depending on block times, and that rewards start accruing after that delay.', src: ['delegators', 'namadilloStaking', 'stakingPage'] },
        { t: 'Staking rewards are computed and minted once per epoch, at the very beginning of the new epoch.', src: ['delegators'] },
      ],
    },
    {
      id: 'claiming',
      h2: 'How do you claim staking rewards?',
      paras: [
        { t: 'Staking rewards wait for you to claim them with a transaction, in Namadillo\'s Staking panel or from the command line; claimed rewards go to your transparent balance, where they can be used at once.', src: ['stakingPage', 'delegators', 'namadilloStaking'] },
        { t: 'The rewards are newly minted NAM shared among validators and their delegators in proportion to their stake, minus each validator\'s commission, at a rate that follows a controller whose settings governance can change.', src: ['rewardDistribution', 'operatorStaking', 'inflationSpecs'] },
      ],
      see: [{ to: '/staking', label: 'The staking rate the network reports now' }],
    },
    {
      id: 'unstaking',
      h2: 'How long does unstaking take?',
      paras: [
        { t: 'Unstaking, which Namada calls unbonding, takes your NAM off a validator, but it cannot be withdrawn straight away: it becomes withdrawable once the pipeline length, the unbonding length and the cubic slashing window have passed, three settings you can query from the chain.', src: ['delegators', 'operatorStaking'] },
        { t: 'The wait is a whole number of epochs set by the chain; this site\'s staking page shows it in days, worked out from the chain\'s own settings and the measured epoch length.', src: ['delegators'] },
        { t: 'NAM that is unbonding can still be slashed for a fault committed while it was staked: the unbonding length exists so that stake used to misbehave cannot be withdrawn before it is punished.', src: ['cubicSlashing', 'genesisParams'] },
        { t: 'When the wait is over, a withdraw transaction moves all fully unbonded NAM back to your account.', src: ['delegators'] },
      ],
      see: [{ to: '/staking', label: 'The unstaking wait now, from the chain\'s settings' }, { to: '/supply', label: 'Staked NAM being unlocked, and when' }],
    },
    {
      id: 'redelegating',
      h2: 'Can you move stake without unstaking?',
      paras: [
        { t: 'Yes: a redelegation moves bonded NAM from one validator to another without unbonding, withdrawing and bonding again, and the new bond counts for the new validator after the pipeline length.', src: ['delegators', 'namadilloStaking', 'stakingPage'] },
        { t: 'You cannot unbond or redelegate from a jailed validator that is waiting to be slashed; otherwise both are allowed, and bonding to a jailed validator is always allowed.', src: ['delegators'] },
      ],
    },
    {
      id: 'slashing',
      h2: 'What can go wrong with staking?',
      paras: [
        { t: 'A validator that breaks the protocol, for example by double signing a block or proposing an invalid block, is jailed and slashed, and its delegators lose part of the stake they had with it.', src: ['cubicSlashingDocs', 'delegators', 'stakingPage'] },
        { t: 'Namada\'s slashing is cubic: the amount slashed grows with the cube of the stake involved in the misbehaviour, so that a validator holding a third or more of the voting power would lose all of its stake.', src: ['cubicSlashingDocs'] },
        { t: 'A validator can also be jailed without being slashed, for too much downtime; a jailed validator stays out of the validator set until it unjails itself.', src: ['jailing'] },
      ],
    },
  ],
  faq: [
    {
      q: 'How long is the Namada unbonding period?',
      a: [{ t: 'It is a number of epochs set by the chain: the pipeline length, the unbonding length and the cubic slashing window together. This site\'s staking page shows the wait in days, read from those settings.', src: ['delegators', 'operatorStaking'] }],
    },
    {
      q: 'Do staking rewards compound automatically?',
      a: [{ t: 'Not as Namada\'s docs describe them: rewards wait to be claimed with a transaction and then land in your transparent balance, so staking them is a separate step. Namada\'s specs page on reward distribution still describes rewards as bonded automatically, but the docs and namada.net say they must be claimed.', src: ['delegators', 'stakingPage', 'rewardDistribution'] }],
    },
    {
      q: 'Is there a minimum amount of NAM to stake?',
      a: [{ t: 'Namada\'s docs name no minimum amount: they say you need an account with a positive NAM balance, and namada.net advises keeping some NAM unstaked to pay fees.', src: ['delegators', 'stakingPage'] }],
    },
    {
      q: 'Does staking give me a vote?',
      a: [{ t: 'Yes. Accounts with active bonds vote on governance proposals with power in proportion to their stake. By default your validator votes for you, and if you vote yourself, your vote overrides it.', src: ['governanceDocs', 'blogGenesis', 'govOnChain'] }],
    },
    {
      q: 'Can I use NAM while it is staked?',
      a: [{ t: 'No. Staked NAM is bonded: it cannot be transferred or spent until you unbond it and withdraw it after the wait, though you can redelegate it to another validator.', src: ['stakingPage', 'operatorStaking', 'delegators'] }],
    },
  ],
  related: ['/staking', '/guides/how-namada-governance-works', '/guides/nam-supply-and-inflation', '/learn/how-nam-trading-works', '/supply'],
  sources: pick('namadilloStaking', 'delegators', 'stakingPage', 'governanceDocs', 'rewardDistribution', 'operatorStaking', 'inflationSpecs', 'cubicSlashing', 'genesisParams',
    'cubicSlashingDocs', 'jailing', 'blogGenesis', 'govOnChain'),
};

const governance: Guide = {
  slug: 'how-namada-governance-works',
  published: '2026-10-24',
  lead: [
    { t: 'Namada is governed on chain by the people who stake NAM: any account can submit a proposal with a NAM deposit, accounts with staked NAM vote on it, and a proposal that passes can change the protocol and its settings or direct public goods funding.', src: ['governancePage', 'governanceDocs', 'proposalTypes'] },
    { t: 'Your voting power is your staked NAM. Your validator votes for you by default, you can vote yourself to override it, and Namadillo lists current, upcoming and past proposals with their tally.', src: ['governanceDocs', 'blogGenesis', 'govOnChain', 'namadilloGovernance'] },
  ],
  sections: [
    {
      id: 'proposing',
      h2: 'Who can make a governance proposal?',
      paras: [
        { t: 'Any account can submit a proposal, but it must lock a deposit of NAM, the minimum proposal fund, while the proposal is open; the amount is a protocol setting you can read from the chain.', src: ['governanceDocs', 'protocolIntro'] },
        { t: 'The deposit is returned to the author if the proposal passes and burned if it is rejected, according to namada.net, Namada\'s specs and its code; Namada\'s governance docs say instead that a rejected proposal\'s deposit is kept in the governance account.', src: ['governancePage', 'govOnChain', 'govCode', 'governanceDocs'] },
        { t: 'Namada\'s docs describe submitting a proposal from the command line, with its title, its voting epochs and any code in a file.', src: ['governanceActions', 'proposalStructure'] },
      ],
    },
    {
      id: 'kinds',
      h2: 'What kinds of proposals are there?',
      paras: [
        { t: 'Namada\'s docs list three types: default proposals, which can carry code that runs if they pass, such as a change to protocol parameters; steward proposals, which add or remove public goods stewards; and public goods funding proposals.', src: ['proposalTypes', 'protocolIntro'] },
        { t: 'A default proposal\'s code runs automatically if it passes, and its changes take effect at the beginning of its activation epoch.', src: ['governanceActions', 'protocolIntro'] },
      ],
    },
    {
      id: 'voting',
      h2: 'Who votes on proposals, and how?',
      paras: [
        { t: 'Accounts with active bonds vote, with voting power in proportion to the NAM they have staked; Namadillo says you cannot vote if you have not staked.', src: ['governanceDocs', 'namadilloGovernance'] },
        { t: 'Validators vote with their delegators\' stake by default, but only in roughly the first two thirds of the voting period; delegators can vote during the whole period, and a delegator\'s own vote overrides its validator\'s.', src: ['governanceDocs', 'governancePage', 'govOnChain', 'blogGenesis'] },
        { t: 'The choices are yay, nay and abstain, and in Namadillo you can change your vote while voting is still open.', src: ['namadilloGovernance'] },
        { t: 'Each proposal names its own voting start and end epochs within limits the chain sets, and the votes are counted at the beginning of its activation epoch.', src: ['proposalStructure', 'governanceActions'] },
      ],
      see: [{ to: '/supply', label: 'Votes in progress now' }],
    },
    {
      id: 'passing',
      h2: 'When does a proposal pass?',
      paras: [
        { t: 'A default proposal needs at least two fifths of all active voting power to vote, and its yay votes must be at least two thirds of the yay and nay votes together. namada.net\'s governance page gives two thirds of the voting power instead; the docs and the code that counts the votes say two fifths.', src: ['governanceActions', 'govUtils', 'governancePage'] },
        { t: 'A steward proposal needs at least a third of the active voting power to vote, with more yay votes than nay votes.', src: ['governanceActions', 'govUtils'] },
        { t: 'A funding proposal from a steward passes without any yay votes unless it is vetoed: it fails if at least a third of the voting power votes and yay votes do not outnumber nay votes.', src: ['pgfFunding', 'governanceActions', 'govUtils'] },
        { t: 'Namada\'s specs say these rules are written into the protocol rather than chosen by each proposal.', src: ['govOnChain'] },
      ],
    },
    {
      id: 'public-goods-funding',
      h2: 'How does public goods funding work?',
      paras: [
        { t: 'Public goods funding mints NAM into an on-chain account at a rate governance sets and pays it to approved recipients, either continuously, every epoch, or retroactively, in a single payment.', src: ['pgfDocs', 'pgfFunding'] },
        { t: 'Stewards are people or groups elected by governance to find good recipients: a steward can propose funding, receives a share of inflation, can resign at any time and can be removed by governance.', src: ['pgfDocs', 'pgfStewards'] },
      ],
    },
    {
      id: 'following',
      h2: 'Where can you follow and vote on proposals?',
      paras: [
        { t: 'Namadillo\'s Governance page lists current, upcoming and past proposals with their type, voting epochs, tally and turnout; to vote, open a proposal, choose your vote and sign it with Namada Keychain.', src: ['namadilloGovernance', 'blogNamadillo'] },
        { t: 'This site\'s supply page lists the votes in progress beside the figures on staking and unstaking.', src: [] },
      ],
      see: [{ to: '/supply', label: 'Votes in progress now' }],
    },
  ],
  faq: [
    {
      q: 'Can I vote if my NAM is not staked?',
      a: [{ t: 'No. Voting power comes from staked NAM: accounts with active bonds vote, and Namadillo says you cannot vote without staking.', src: ['governanceDocs', 'namadilloGovernance'] }],
    },
    {
      q: 'What happens to the deposit if a proposal fails?',
      a: [{ t: 'It is burned, according to namada.net, Namada\'s specs and its code; Namada\'s governance docs say instead that it is kept in the governance account. If the proposal passes, the deposit is returned to its author.', src: ['governancePage', 'govOnChain', 'govCode', 'governanceDocs'] }],
    },
    {
      q: 'Does my validator vote for me?',
      a: [{ t: 'By default, yes: validators vote with their delegators\' stake. If you vote yourself, your vote replaces your validator\'s for your stake.', src: ['blogGenesis', 'govOnChain', 'governanceDocs'] }],
    },
    {
      q: 'Can governance change staking rewards and inflation?',
      a: [{ t: 'Yes. The staking rate\'s cap and target, the public goods rate and the stewards\' rate are parameters governance can change, and a default proposal can carry code that changes protocol parameters.', src: ['inflationSpecs', 'pgfDocs', 'pgfStewards', 'protocolIntro'] }],
    },
  ],
  related: ['/guides/how-to-stake-nam', '/guides/nam-supply-and-inflation', '/guides/what-is-namada', '/supply', '/staking'],
  sources: pick('governancePage', 'governanceDocs', 'proposalTypes', 'govOnChain', 'namadilloGovernance', 'protocolIntro', 'govCode', 'governanceActions', 'proposalStructure', 'blogGenesis',
    'govUtils', 'pgfFunding', 'pgfDocs', 'pgfStewards', 'blogNamadillo', 'inflationSpecs'),
};

export const GUIDES: Record<GuideSlug, Guide> = {
  'what-is-namada': whatIsNamada,
  'how-to-buy-nam': howToBuyNam,
  'how-to-stake-nam': howToStake,
  'how-the-shielded-pool-works': shieldedPool,
  'how-namada-governance-works': governance,
  'nam-supply-and-inflation': namSupply,
};

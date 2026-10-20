// Site-wide words and the plain-language text of every page, in one place.
//
// The Worker renders these paragraphs into the server-rendered page (worker/src/seo.ts) and the
// React views render the same sentences visibly, so what a search engine reads in the raw HTML is
// also what a person reads on screen (docs/design/seo-requirements.md, Must 3).
//
// Rules for everything in this file:
// - No figures. A number is never typed here: each page names the figures it states as `FactKey`s,
//   and the Worker (or the view) fills them from the API with their source and time (N2).
// - Plain words first. No SQS, IBC, DEX, PoS, MASP, ABCI, RPC, cron, webhook, npm, bare D1 to D7.
// - Describe what happened, never what to do. This is not investment advice.
// - Sentence case. The first sentence of a page and of each section answers its heading.

/** Figures a page states. Each is computed from stored readings, with its own source and time. */
export type FactKey =
  | 'price'      // NAM price in USDC from the Osmosis router
  | 'supply'     // total NAM in existence
  | 'staked'     // NAM staked with validators, and its share of all NAM
  | 'shielded'   // NAM in the shielded pool, and its share
  | 'osmosis'    // NAM held on Osmosis (wallets and pools), and its share
  | 'depth'      // money in the Osmosis NAM pools, and how many pools
  | 'volume'     // NAM bought and sold on Osmosis in the last 24 hours, bots removed
  | 'holders'    // holder counts on Namada and Osmosis, protocol accounts excluded
  | 'top10'      // share of all NAM held by the 10 largest Namada holders
  | 'unbonding'  // the unstaking wait, from the chain's own settings
  | 'apr';       // the staking rate the network indexer reports

// SITE lives in shared/site.ts so the shell (routes, titles, footer) can read it without loading every page's BODY.
import { SITE } from './site';
export { SITE };

export interface CopySection {
  /** An H2, written as the question it answers. */
  h2: string;
  /** The first sentence answers the H2. */
  paras: string[];
  /** Figures this section states, listed under it. */
  facts?: FactKey[];
}

export interface PageCopy {
  /** Lead paragraphs under the H1. The first sentence answers the H1. */
  paras: string[];
  /** Figures stated right under the lead, in this order. */
  facts: FactKey[];
  /** Sections with their own H2 (the SEO pages). */
  sections?: CopySection[];
}

/** Plain-language text per route id (shared/routes.ts). Settings is private and has none. */
export const BODY: Record<string, PageCopy> = {
  home: {
    paras: [
      SITE.sub,
      'NAM is staked on Namada and traded on Osmosis, where the pools are small enough that a single order moves the price. This site reports what moved NAM, who moved it and what a trade costs, from public data.',
    ],
    facts: ['price', 'supply', 'staked', 'shielded', 'osmosis', 'depth', 'holders'],
  },
  trade: {
    paras: [
      SITE.quoteNotOrder,
      'This page asks the Osmosis router what a sale or purchase of NAM would return right now, and shows how far that order moves the price. The pools hold little money, so a large order gets a worse average price than a small one.',
    ],
    facts: ['price', 'depth', 'osmosis'],
  },
  supply: {
    paras: [
      'NAM can only be sold on Osmosis, so NAM that has crossed over from Namada and has not been sold or sent back is the first thing to watch. Staked NAM becomes sellable only after the unstaking wait.',
      'This page lists NAM that crossed to Osmosis, unstaking and its unlock dates, the addresses buying and selling most, and votes in progress. It describes what happened; it does not predict prices.',
    ],
    facts: ['unbonding', 'staked', 'osmosis', 'depth'],
  },
  shielded: {
    paras: [
      'The shielded pool is the part of Namada where balances are private: how much NAM it holds is public, but who owns it is not.',
      'This page shows the pool\'s share of all NAM over time, how much moved in and out, and the largest moves out of it to personal addresses. NAM inside the pool cannot be attributed to anyone.',
    ],
    facts: ['shielded', 'supply'],
  },
  activity: {
    paras: [
      'Every swap, bridge crossing, staking move and shielded move involving NAM on Namada and Osmosis, newest first, each with its transaction and where its time and price came from.',
      'Bot trades, round trips made for a tiny profit, are marked so they can be left out. Amounts are in NAM; a dollar value uses the price at the time of the move when that price is known.',
    ],
    facts: ['price', 'staked', 'shielded'],
  },
  holders: {
    paras: [
      'Holders are addresses with spendable or staked NAM on Namada, or NAM on Osmosis. Protocol accounts, such as the staking, shielded pool and bridge accounts, are left out because they hold NAM on behalf of others.',
      'Staked NAM is read from the chain address by address. NAM in the shielded pool cannot be attributed to anyone, so the share held by the largest addresses describes only the visible part of the supply.',
    ],
    facts: ['holders', 'top10', 'shielded', 'supply'],
  },
  alerts: {
    paras: [
      'Alerts say when NAM is bridged to Osmosis, unstaked, traded in large size, moved out of the shielded pool or staked in large size. Sizes are in NAM, and each one is shown with its dollar value at the current price.',
      'Signing in with a Namada or Keplr wallet lets you choose which alerts reach you, at what size, and where. Signing a message costs nothing and moves nothing.',
    ],
    facts: ['price', 'depth'],
  },
  staking: {
    paras: [
      'Staking locks NAM with a validator, an operator that helps run the Namada network, and in return the stake earns newly issued NAM. Staked NAM cannot be sold or moved until it has been unstaked and the unstaking wait has passed.',
      'The rate below is the one the network indexer reports: a yearly rate before the validator\'s commission. It changes with the share of all NAM that is staked, and it is not a promise.',
    ],
    facts: ['staked', 'apr', 'unbonding'],
    sections: [
      {
        h2: 'What does staking NAM earn?',
        paras: [
          'Staked NAM earns new NAM at a yearly rate set by the network, minus the commission the chosen validator keeps. The rate falls as more of all NAM is staked and rises as less is, so the figure here is a reading at the time shown.',
        ],
        facts: ['apr', 'staked'],
      },
      {
        h2: 'How long does unstaking NAM take?',
        paras: [
          'Unstaking takes a set number of epochs, the network\'s accounting periods: the pipeline length, the unbonding length and the penalty window, all set by the chain. An epoch lasts at least six hours and longer when blocks are slow, so the wait in days is an estimate: the figure here uses the epoch length measured on the chain. Guides often quote two weeks.',
          'During the wait the NAM earns nothing and cannot be moved. When the wait ends it is unlocked: spendable, and free to be bridged or sold.',
        ],
        facts: ['unbonding'],
      },
      {
        h2: 'What do unstaking, restaking and redelegating mean?',
        paras: [
          'Unstaking asks the network to unlock staked NAM, which becomes spendable after the wait. Restaking stakes unlocked NAM again, with the same or a different validator. Redelegating moves a stake from one validator to another without unlocking it, so the NAM never becomes spendable and is not a sale.',
        ],
      },
      {
        h2: 'How much NAM is staked?',
        paras: [
          'The amount staked is the chain\'s own total stake, shown with its share of all NAM. Namada\'s staking account also holds NAM on its way out: unstaking, ready to withdraw, or rewards not yet claimed. Staked NAM can reach a market only after it has been unstaked, the wait has passed and, to be sold, it has crossed to Osmosis.',
        ],
        facts: ['staked', 'supply'],
      },
    ],
  },
  osmosis: {
    paras: [
      'Osmosis is where NAM trades. NAM reaches it by crossing from Namada, and it is sold into pools: shared pots of NAM and another coin that anyone trades against.',
      'The pools hold little money compared with the NAM on Namada, so the size of an order changes the price it gets. The figures below say how much the pools hold, how much NAM sits on Osmosis and how much traded in the last day.',
    ],
    facts: ['depth', 'osmosis', 'volume', 'price'],
    sections: [
      {
        h2: 'How much money is in the NAM pools on Osmosis?',
        paras: [
          'The combined depth of the NAM pools is what every order trades against. It is measured in dollars and read from the Osmosis router, together with the number of pools.',
        ],
        facts: ['depth'],
      },
      {
        h2: 'Why does a small NAM order move the price?',
        paras: [
          'Each trade takes coins out of one side of a pool and adds them to the other, and the price moves with every coin taken. When the pools hold little money a modest order moves the price noticeably, so a large order gets a worse average price than a small one. The Trade page quotes the move for any size.',
        ],
        facts: ['depth', 'price'],
      },
      {
        h2: 'How much NAM traded on Osmosis in the last day?',
        paras: [
          'Trading volume counts the NAM bought and sold on Osmosis over the last day, with bot round trips removed.',
        ],
        facts: ['volume'],
      },
      {
        h2: 'How much NAM is on Osmosis?',
        paras: [
          'NAM held on Osmosis, in wallets and in pools, is the part of the supply that can be sold without first crossing from Namada.',
        ],
        facts: ['osmosis', 'supply'],
      },
    ],
  },
  learn: {
    paras: [
      'NAM passes through up to four steps on its way to a sale: staked, unlocked, bridged and sold. Every step is public, which is why each one can be watched before it reaches the market.',
    ],
    facts: ['staked', 'unbonding', 'osmosis', 'depth'],
    sections: [
      {
        h2: 'What does staked NAM mean?',
        paras: [
          'Staked NAM is locked with a validator: it earns new NAM but cannot be sold or moved.',
        ],
        facts: ['staked'],
      },
      {
        h2: 'How is staked NAM unlocked?',
        paras: [
          'Asking to unstake starts a wait set by the chain in epochs, its accounting periods. When the wait ends the NAM is unlocked: spendable, and free to be moved.',
        ],
        facts: ['unbonding'],
      },
      {
        h2: 'Why does NAM cross to Osmosis before a sale?',
        paras: [
          'NAM can only be sold on Osmosis, so it has to be bridged there first. A crossing usually comes before a sale, which is why this site tracks NAM that crossed and has not yet been sold or sent back.',
        ],
        facts: ['osmosis'],
      },
      {
        h2: 'What happens when NAM is sold?',
        paras: [
          'On Osmosis, NAM is sold into small pools, so the size of an order moves the price it gets. The Trade page quotes any size against the pools as they are now.',
        ],
        facts: ['depth', 'price'],
      },
      {
        h2: 'Which figures describe a trade before it happens?',
        paras: [
          'Three figures describe a trade before it happens: how much money the pools hold, how far an order of a given size moves the price, and how much NAM is already waiting on Osmosis. None of them is a forecast, and nothing on this site is investment advice.',
        ],
      },
    ],
  },
  faq: {
    paras: [
      'Short answers to the questions people ask about NAM and about this site. Every figure it states carries its source and the time it was read.',
    ],
    facts: ['price', 'shielded'],
    sections: [
      {
        h2: 'Why is this NAM price different from other sites?',
        paras: [
          'This site\'s price is the current NAM price in USDC from the Osmosis router, read every minute and shown beside the price that real trades paid. Another site may show an older trade, a single pool, an average over a day or a market where NAM barely trades.',
        ],
        facts: ['price'],
      },
      {
        h2: 'Why can\'t I see who holds shielded NAM?',
        paras: [
          'NAM in the shielded pool is private by design: the network publishes how much the pool holds, not who owns it. This site reports the pool\'s total and every move into and out of it, and does not try to attribute what is inside.',
        ],
        facts: ['shielded'],
      },
      {
        h2: 'How old is this number?',
        paras: [
          'Every figure carries its source and the time it was read. A figure older than its usual refresh is marked old, and a figure that could not be read shows a dash and the reason, never a guess.',
        ],
      },
      {
        h2: 'Where does the data come from?',
        paras: [
          'Prices and pool depth come from the Osmosis router; balances, staking and the shielded pool from public Namada nodes; history and the staking rate from indexer.namada.net; NAM on Osmosis from Osmosis\'s own balance records. Where two independent sources exist they are compared, and the results are shown under How we know.',
        ],
      },
      {
        h2: 'How is NAM bought?',
        paras: [
          'NAM trades on Osmosis against USDC and other coins, so a purchase is a swap in one of the NAM pools there; moving the NAM back to Namada is a separate crossing. This site shows the quote and the price move for a given size and never trades for anyone.',
        ],
      },
      {
        h2: 'What does this site not do?',
        paras: [
          'It does not trade, hold funds, give investment advice or ask for a wallet\'s secret. Signing in is a signed message that costs nothing and moves nothing, and what is stored is the alert choices and where they are sent.',
        ],
      },
    ],
  },
};

/** The not-found view and the server's 404 page (system.md 9.9). */
export const NOT_FOUND = {
  h1: 'That page does not exist',
  lead: 'The address may be mistyped, or the page may have moved. These are the pages that exist:',
} as const;

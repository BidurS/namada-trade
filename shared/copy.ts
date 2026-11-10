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
  | 'apr'        // the staking rate the network indexer reports
  | 'depthSell'  // what selling the depth page's quoted size fetches across every Osmosis pool, from the newest depth minute
  | 'depthBid'   // USD of bids within the quoted distance of the price across every pool, from the same minute
  | 'checks'     // how many of the site's cross-checks pass, of all of them, as of the newest check
  | 'tick'       // when the site's last reading of every source completed
  | 'bridgeAccount'  // NAM in Namada's bridge account, one account for every channel
  | 'bridgeHeld'     // NAM the chains read hold between them, and how many chains that is
  | 'validatorCount' // how many validators have NAM staked with them, on the newest day on record
  | 'validatorThird'; // how few of them, largest first, hold more than a third of the staked NAM

/**
 * What the two derived values on the Trade page count (no figures). The series API sends the same sentences with
 * each figure (worker/src/series-api.ts readValues), so the page and the API say the same words. Never "market cap".
 */
export const VALUE_WORDS = {
  allNamLabel: 'All NAM at today’s price',
  allNam: 'Every NAM in existence (the chain’s total supply) at today’s quoted price.',
  spendableLabel: 'Spendable NAM at today’s price',
  spendable: 'NAM in ordinary accounts on Namada plus NAM on Osmosis, at today’s price. Staked NAM, NAM on its way out of staking, the shielded pool and public funding are left out.',
} as const;

// SITE lives in shared/site.ts so the shell (routes, titles, footer) can read it without loading every page's BODY.
import { SITE } from './site';
export { SITE };

/** The site's own links as the questions page writes them: namada.trade, namadatrade, github.com/BidurS/namada-trade. */
const SITE_HOST = new URL(SITE.origin).host;
const X_HANDLE = new URL(SITE.x).pathname.slice(1);
const REPO_PATH = SITE.repo.replace(/^https:\/\//, '');

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
  /**
   * The facts whose times date the page in the sitemap, when they are not every fact it states: the depth page is
   * dated by its newest stored minute alone, not by the price it also quotes.
   */
  dated?: FactKey[];
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
  depth: {
    paras: [
      'Every bid and ask for NAM on Osmosis, read from the chain\'s own state each minute: the concentrated-liquidity pools\' tick maps, the weighted pools\' reserves and the order book\'s resting orders, merged into one ladder with each rung naming its pool and fee.',
      'The first figure is what a sale or a purchase of a given size fetches right now across every pool, filled best price first after each pool\'s fee and the chain\'s taker fee. A level of a concentrated pool is a reading of its tick map, not a resting order; the order book\'s levels are real orders. Nothing here is advice and nothing is traded from this page.',
    ],
    facts: ['depthSell', 'depthBid', 'price'],
    dated: ['depthSell', 'depthBid'],
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
      'Spendable and staked NAM are read from the chain for every address: the chain lists all balances and all bonds, address by address, and the flow index keeps moved addresses current in between. NAM in the shielded pool cannot be attributed to anyone, so the share held by the largest addresses describes only the visible part of the supply.',
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
        h2: 'Is this the order book?',
        paras: [
          'It is the order book and the pools, merged. NAM on Osmosis trades in one order book of limit orders against USDC and in a set of pools where NAM is swapped against USDC, OSMO and other coins. The Depth page reads every one of them from the chain each minute and merges them into one answer: what selling or buying a given amount of NAM would fetch across all of them, which pool takes each part, what rests at every price, and who placed it. Every figure carries the block it was read at, and a pool that could not be read is named with the reason rather than filled in.',
        ],
      },
      {
        h2: 'What does this site not do?',
        paras: [
          'It does not trade, hold funds, give investment advice or ask for a wallet\'s secret. Signing in is a signed message that costs nothing and moves nothing, and what is stored is the alert choices and where they are sent.',
        ],
      },
      {
        h2: 'Is NamadaTrade run by the Namada team?',
        paras: [
          'No. NamadaTrade is an independent site. It is not run by or affiliated with the Anoma Foundation, which operates namada.net, with Heliax, or with any other team that builds Namada. It reads public data from Namada and Osmosis, and its guides cite Namada\'s own docs, specs, site, blog or code for each paragraph about the network.',
        ],
      },
      {
        // The footer links here (/faq#q-official). The links are read from SITE, so a handle changes in one place.
        h2: 'Which links are NamadaTrade\'s own?',
        paras: [
          `NamadaTrade's own links are this site, ${SITE_HOST}, its X account @${X_HANDLE}, its Telegram bot @${SITE.telegram.bot} and its source code on GitHub, ${REPO_PATH}. A site, account or bot that uses the name anywhere else is not this site.`,
          `${SITE.neverAsks} Sign in, on ${SITE_HOST} itself, signs a short message that costs nothing and moves nothing. Someone who asks you to sign something to verify a wallet, or for a seed phrase, is not this site.`,
        ],
      },
    ],
  },
  guides: {
    paras: [
      'Plain guides to the questions people ask about Namada and NAM, each written from Namada\'s own documentation, specifications and posts, with a numbered source after every paragraph.',
      'No live figure is typed into a guide: where a number changes, such as the staking rate, the unstaking wait or the price, the guide links the page of this site that shows it now, with its source and age.',
    ],
    facts: [],
  },
  bridges: {
    paras: [
      'NAM leaves Namada over bridge channels, one for each chain Namada is connected to. This page lists every channel the chain has opened, the chain it leads to and the NAM that chain holds through it.',
      'Namada keeps one bridge account for every channel, so the account alone does not say where the NAM went. The other chains do: each one reports the NAM it received over its channel, and the page sets their sum against the account.',
    ],
    facts: ['bridgeAccount', 'bridgeHeld'],
    sections: [
      {
        h2: 'Why does the bridge account hold more than the chains do?',
        paras: [
          'NAM stays in the account when a transfer was refused or timed out on the other chain and was never refunded, and when it was sent to a chain this site cannot read. The page states both: the NAM in transfers known to be stuck, and the channels that have no figure.',
          'What is left is NAM in the account beyond what the chains read hold and the stuck transfers. It may be on a chain that is not read. It is shown as it is, never explained away, and while it is more than a small amount the cross-check that compares the two sides says it needs a look.',
        ],
      },
      {
        h2: 'Which chains cannot be read?',
        paras: [
          'A chain is read by asking one of its public nodes for the total of NAM it has issued for its channel. A chain whose nodes do not answer that question, as Penumbra\'s do not, is listed with its channel and no figure, never with a zero.',
        ],
      },
      {
        h2: 'How current is each figure?',
        paras: [
          'The channel list is read from a Namada node several times a day, and each chain is asked again several times an hour. Every figure carries the time of its own reading. A chain that did not answer keeps its last figure, marked old, until it answers again, and a figure more than half an hour old is left out of the sum.',
        ],
      },
    ],
  },
  // The validators view (docs/design/platform-plan.md, release C). Two paragraphs: the list of validators is the
  // page's evidence, and its figures are the page's own (web/src/screens/seo/Validators.tsx).
  governance: {
    paras: [
      'NAM holders who stake vote on proposals: changes to the network\'s rules, to how much new NAM is made, and to where the NAM held for public funding goes. This page lists the proposals in voting and the latest ones decided.',
      'Each proposal shows the NAM that voted yes, no and abstain as the network\'s indexer counts it, with the time of that reading. A proposal\'s title and its discussion link are its author\'s own text.',
    ],
    facts: [],
    sections: [
      {
        h2: 'What can a vote change?',
        paras: [
          'A proposal can change a rule of the network, name who looks after the public funding or pay from it, or record a decision that changes no rule. One that changes how much NAM is made, or moves public funds, changes where NAM is and how much there is, which is why the Supply page lists the open votes too.',
        ],
      },
      {
        h2: 'How much NAM is held for public funding?',
        paras: [
          'A share of the new NAM the network makes goes to an account held for public funding. Proposals decide who receives from it. The figure is that account\'s balance as a Namada node reports it.',
        ],
      },
    ],
  },
  validators: {
    paras: [
      'Namada is run by its validators: the operators that produce its blocks, with whom NAM is staked. This page lists every validator that has stake, with the NAM staked with it, its share of all staked NAM, the number of addresses staked with it, its commission and its state.',
      'The figures are the first complete listing of each UTC day, read from a Namada node, while names, commission and state come from the network indexer\'s list and may be missing. How few validators together hold more than a third, and more than two thirds, of the staked NAM describes how that NAM is spread, and nothing more.',
    ],
    facts: ['validatorCount', 'validatorThird'],
  },
  // The platform pages (docs/design/platform-plan.md, release A). The API page's list of routes is not typed here:
  // it is drawn from shared/api-catalog.ts by the view and by the server-rendered page.
  developers: {
    paras: [
      'The figures the pages show are also served as data, to anyone, with no key and no account. This page lists the documented routes: what each answers, the parameters it reads and the fields of its answer.',
      'The answers are the ones the pages themselves read, so a figure here and the same figure on a page are one reading. Most figures come with a stamp that says where the figure was read, when, and whether that reading is current, old or missing.',
    ],
    facts: [],
    sections: [
      {
        h2: 'How do I read a stamp?',
        paras: [
          'A stamp is a small object beside a figure, most often named prov or with a name ending in Prov. Its source says where the figure was read, its at is the time of that reading in unix milliseconds, and its status is live, stale, missing or conflict.',
          'A figure whose source did not answer is left empty, with the reason in the stamp\'s note. The depth routes carry a list of stamps instead, one for each read behind the minute, with what was read, when and at which block.',
        ],
      },
      {
        h2: 'How often can I ask?',
        paras: [
          'An answer is kept for a short time, from a few seconds to a few minutes depending on the route, so asking again within that time returns the same reading.',
          'The requests that cost more to answer are limited by the address they come from, a newer long-form address by its network, and each kind of request on its own. The kinds and their limits are listed below, and a request over a limit is refused with the number of seconds to wait.',
        ],
      },
      {
        h2: 'Can I ask for a past moment?',
        paras: [
          'A route that lists the parameter at answers as of that moment, a time in unix milliseconds, as the Rewind control on the pages does. A figure that was not recorded over time is either left empty with a note, or given as a current reading whose stamp carries its own, later time.',
        ],
      },
      {
        h2: 'Is there a description a program can read?',
        paras: [
          'The same list is served as an OpenAPI document, made from the list this page is drawn from. The code behind every route is public under the MIT licence, with the type of every answer.',
        ],
      },
      {
        h2: 'What is a key for?',
        paras: [
          'Reading the routes on this page needs no key. A key made on the Settings page stands for one signed-in wallet: it does what that wallet\'s own session can do, such as changing its alert choices and writing its public tags, and it changes nothing about the routes listed here.',
        ],
      },
    ],
  },
  status: {
    paras: [
      'This page says whether the figures on this site are current: which of its cross-checks pass, whether each source it reads answered at the last reading, and when that reading completed.',
      'A cross-check compares two sources for the same thing. It passes, needs a look, has nothing to compare when there was no trade to check against, or has no recent result when one of its sources stopped answering.',
    ],
    facts: ['checks', 'tick'],
    sections: [
      {
        h2: 'What do the states of a figure mean?',
        paras: [
          'Fresh: read within its usual refresh time. Old: older than that, so it is shown dimmed with its age. No data: the source did not answer, and nothing is put in its place. Sources disagree: two sources give different values, and both are shown.',
        ],
      },
      {
        h2: 'Where is this as data?',
        paras: [
          'The cross-checks and the sources are served as data, and so is whether the last reading completed: that answer carries an error status while something is failing, so an outside monitor can watch it.',
        ],
      },
    ],
  },
  methodology: {
    paras: [
      'Every figure on this site is read from a public source and shown with that source and the time of the reading. This page says, figure by figure, what is counted, where it is read and what is left out.',
      'The site is built to two rules. A reading that failed is to be shown as missing, or as an estimate that says it is one, and never as if it had been read. And a series starts on the day its record begins: nothing is drawn before it.',
    ],
    facts: [],
    sections: [
      {
        h2: 'What is the NAM price?',
        paras: [
          'The price is the NAM price in USDC from the Osmosis router, read every minute: the router\'s own price for NAM when it lists one, and otherwise the reference pool\'s own price, read from a small quote through that pool alone. Beside it the site shows the last trade price: the middle price of one hour\'s trades, from the swaps recorded on Osmosis.',
          'The two differ when no trade has happened for a while, which is why both are shown.',
        ],
        facts: ['price'],
      },
      {
        h2: 'What counts as a holder?',
        paras: [
          'A holder is an address holding spendable or staked NAM. The protocol\'s own accounts, such as the staking account, the bridge account and the shielded pool, are left out, and NAM inside the shielded pool cannot be attributed to anyone.',
          'Balances and stakes come from the chain\'s own lists of every balance and every stake, each read whole from a Namada node.',
        ],
      },
      {
        h2: 'How are all NAM, staked NAM and shielded NAM read?',
        paras: [
          'All NAM in existence, NAM staked with validators and NAM in the shielded pool are read from Namada nodes. Staked NAM is the chain\'s own total stake, not the balance of the staking account, which also holds NAM on its way out of staking and unclaimed rewards.',
        ],
        facts: ['supply', 'staked', 'shielded'],
      },
      {
        h2: 'How is NAM on Osmosis counted?',
        paras: [
          'NAM on Osmosis, in wallets and in pools, is the amount Osmosis itself reports for NAM. The bridge account on Namada holds NAM for every chain it bridges to, so the two figures are compared in a cross-check rather than assumed equal.',
        ],
        facts: ['osmosis'],
      },
      {
        h2: 'What is the money in the pools?',
        paras: [
          'The money in the pools is what each pool holds, its NAM at the NAM price and its other coin at that coin\'s own price. A pool that holds a coin with no price is left out of the total, and the figure says how many pools it counts.',
        ],
        facts: ['depth'],
      },
      {
        h2: 'What is counted as traded?',
        paras: [
          'Traded NAM is every buy and sell of NAM recorded on Osmosis in the window, with bot round trips left out: trades that buy and sell at once for a small profit and leave no one holding more or less NAM.',
        ],
        facts: ['volume'],
      },
      {
        h2: 'How do I know a figure is right?',
        paras: [
          'Each figure names its source and the age of its reading. The site also compares its sources with each other in cross-checks, and their results are public on the status page. When two sources disagree, both values are shown.',
        ],
      },
    ],
  },
  privacy: {
    paras: [
      'Reading this site needs no account. For a reader who has not signed in, what the site remembers, such as the appearance chosen, what was opened or searched lately and the time of the last visit, is kept in that reader\'s own browser.',
      SITE.privacy,
    ],
    facts: [],
    sections: [
      {
        h2: 'What does the host keep about a request?',
        paras: [
          'Cloudflare, which hosts the site, keeps a log of each request for up to seven days: what was asked for, which can include a word searched or an address looked up, when, and the request data sent with it, such as the address it came from and the browser\'s details. The operator can read that log to find faults.',
          'Requests that cost more to answer are limited by the address they come from, and that count lasts about a minute. A page\'s live connection is counted by the address it comes from for as long as it stays open, and forgotten when it closes. The number of live connections open at once is recorded each hour, as a number and nothing else.',
        ],
      },
      {
        h2: 'What is stored when I sign in?',
        paras: [
          'Signing in is a signed message, never a transaction, and it moves nothing. Your address, which is public on the chain anyway, becomes the key for your settings and sessions.',
          'Your alert choices, watchlist and quiet hours, your Telegram chat and your Discord channel link are encrypted before they are stored. Sessions and keys are random tokens with when they were made and last used. No IP address and no browser details are stored with them.',
          'Your tags on addresses are public: every user sees them, signed with your address. They are the only thing you write that others see.',
        ],
      },
      {
        h2: 'Who can read what is stored?',
        paras: [
          'The database and its backups hold your choices only in encrypted form, so the site\'s operator cannot read your watchlist or your Discord link by looking at the data. The honest limit: whoever deploys this site could change its code to record them while they are decrypted to send an alert. That is true of every hosted service, and this one says so.',
        ],
      },
      {
        h2: 'How do I take or delete what is stored?',
        paras: [
          'The Settings page saves your settings and your list of sessions as a file. The Discord channel link is in it only with its middle left out, and of the Telegram chat only whether one is linked and a group\'s name.',
          'Its delete button removes your settings, your Discord link, every session and every key, on every device. Tags you wrote on addresses are public and stay.',
        ],
      },
    ],
  },
  terms: {
    paras: [
      'NamadaTrade reports public data from Namada and Osmosis as it finds it. It gives no advice, holds no funds and makes no trade.',
      SITE.disclaimer,
    ],
    facts: [],
    sections: [
      {
        h2: 'Can I rely on a figure?',
        paras: [
          'Every figure is a reading of a public source at a stated time, and a source can be late, wrong or silent. The site shows the age of each reading and says when one is missing. It makes no promise that a figure is complete, correct or current, and what anyone does with one is their own decision.',
        ],
      },
      {
        h2: 'Does the site trade or hold anything?',
        paras: [
          SITE.quoteNotOrder,
          'Signing in is a signed message that moves nothing. ' + SITE.neverAsks,
        ],
      },
      {
        h2: 'May I use the figures and the code?',
        paras: [
          'The figures are public facts, free to read and to cite; naming this site and the time of the reading lets the next reader check them. The code is public under the MIT licence, which says it comes without warranty.',
        ],
      },
      {
        h2: 'Can the site change?',
        paras: [
          'Any page or route may change, be limited or stop. The request limits for each address are listed on the API page.',
        ],
      },
    ],
  },
};

/**
 * The shielded page's sentences that state figures (2026-11-07: the pool as a ledger, how NAM enters it, the moves
 * out grouped by recipient and a move's share of the pool). Each takes its figures already formatted by the view
 * (shared/format.ts), so no figure is typed here; the view puts the stamp beside the sentence. Bridge words, never
 * the protocol's acronym: a crossing "straight over the bridge".
 */
const SHIELDED_ACTIVITY_NOUN = (one: boolean) => (one ? 'shielded transaction' : 'shielded transactions');
export const SHIELDED_WORDS = {
  /** the pool as a ledger: what went in and came out since the record's start, the rewards the chain has minted since it began (no transaction shows them), and the gap to today's balance */
  makeup: (since: string, inNam: string, outNam: string, rewardsNam: string, balanceNam: string, gapNam: string) =>
    `Since ${since}, ${inNam} NAM was shielded and ${outNam} NAM unshielded. Since the chain began it has minted ${rewardsNam} NAM into the pool as shielded rewards, which no transaction shows. In − out + rewards = today’s ${balanceNam} NAM, within ${gapNam} NAM.`,
  /** the ledger's four parts as the waterfall names them (the drawing's row labels) */
  makeupRows: { in: 'Shielded in', rewards: 'Shielded rewards minted', out: 'Unshielded', balance: 'Today’s balance' } as const,
  /** how NAM entered the pool: straight over the bridge against from Namada addresses */
  bridgeShare: (sharePct: string, crossings: string) =>
    `Of all NAM ever shielded, ${sharePct} arrived straight over the bridge in ${crossings}; the rest came from Namada addresses.`,
  /** what the ledger's sentences are counted from (their stamp's label in the section's source sheet) */
  makeupScope: 'The pool as a ledger: moves since this site’s record starts, rewards the chain’s own total',
  bridgeScope: 'How NAM entered the pool',
  /** a recipient's moves out in the window, on a phone, where the group stands for its rows */
  group: (moves: string, nam: string, since: string) => `To the same address: ${moves}, ${nam} NAM since ${since}`,
  /** a move's share of the pool's NAM before it ("about" when read from the minute before the block, not the block's own record) */
  poolShare: (pct: string, about: boolean) => `${about ? 'about ' : ''}${pct} of the pool`,
  /** a group's largest move's share, on a phone */
  largestShare: (pct: string, about: boolean) => `the largest took ${about ? 'about ' : ''}${pct} of the pool`,
  /** the column heads the desktop table adds */
  shareHead: '% of the pool',
  movesHead: 'Moves',
  /** the moves-out list's lead, now that crossings straight out of the pool to the bridge account are listed too */
  outLead: 'The biggest single moves out of the shielded set, largest first: to a personal address, or straight over the bridge to the receiver the record names (older records name only the bridge account). Moves to staking and the other protocol accounts are left out.',
  outEmpty: 'Nothing left the shielded set for a personal address or over the bridge in 30 days.',
  /**
   * Activity inside the pool (2026-11-08): the transactions the chain recorded, counted per day from this site's own
   * record of each block, never users. `txs` and `inside` arrive as words with their count ("12 shielded
   * transactions", "9"), so the sentence types no figure.
   */
  activity: (txs: string, inside: string) => `${txs} in 7 days, ${inside} in a block with no NAM moving into or out of the pool.`,
  /** the noun, singular and plural, and the count in words */
  activityNoun: SHIELDED_ACTIVITY_NOUN,
  activityCount: (n: string, one: boolean) => `${n} ${SHIELDED_ACTIVITY_NOUN(one)}`,
  /** what the sentence and the bars are counted from (their stamp's label in the source sheet) */
  activityScope: 'Shielded transactions a day, from this site’s record of each block',
  /** the record's start, said with the figures: earlier days are not counted */
  activitySince: (day: string) => `Counted since ${day}; earlier days are not counted.`,
  /** when not every day of the week is counted yet */
  activityPartial: (days: string) => `${days} of the 7 days ${days === '1' ? 'is' : 'are'} counted so far.`,
  /** the desktop chart's heading and unit line */
  activityHead: 'Shielded transactions a day',
  activityUnit: 'Each bar is one UTC day: every shielded transaction the chain recorded that day, the darker part those in a block with no NAM moving into or out of the pool (entirely inside it, in another coin, or paying a fee from it). A day without a bar was not counted.',
  activityKey: { all: 'Shielded transactions', inside: 'No NAM into or out of the pool' } as const,
  activityNone: 'No day is counted yet: a day is counted once the block follower has scanned past its end.',
} as const;

/**
 * The Supply page's "NAM since genesis" sentences (2026-11-07). Every figure arrives already formatted: the words
 * type none (N2), and web/src/screens/supply/since-genesis.ts computes the parts from the API's live figures and the
 * dated split in web/src/generated/supply.ts.
 */
export const SUPPLY_WORDS = {
  heading: 'NAM since genesis',
  /** the one sentence (a phone shows it alone, in place of the "What this page shows" paragraph) */
  sinceGenesis: (genesisNam: string, nowNam: string, rewardsNam: string, fromEpoch: string, toEpoch: string, stakingNam: string, publicFundingNam: string) =>
    `Since genesis, NAM supply grew from ${genesisNam} to ${nowNam} NAM: ${rewardsNam} NAM minted into the shielded pool as shielded rewards (the chain’s own total), the rest staking inflation and public-funding inflation, which can be told apart only from epoch ${fromEpoch} on (${stakingNam} and ${publicFundingNam} NAM from epoch ${fromEpoch} to ${toEpoch}; before that, together).`,
  /** the bar's four parts, as its legend names them */
  parts: {
    rewards: 'Shielded rewards, minted into the pool (the chain’s own total)',
    staking: (fromEpoch: string, toEpoch: string) => `Staking inflation, epochs ${fromEpoch} to ${toEpoch}`,
    publicFunding: (fromEpoch: string, toEpoch: string) => `Public-funding inflation, epochs ${fromEpoch} to ${toEpoch}`,
    together: (fromEpoch: string, toEpoch: string) => `Staking and public funding together: before epoch ${fromEpoch}, and since epoch ${toEpoch}`,
  } as const,
  /** the modelled caveat under the bar */
  caveat: (derivedOn: string, fromEpoch: string, toEpoch: string, measuredEpochs: string, epochs: string, modelledEpochs: string, modelledFrom: string, modelledTo: string, modelledStakingNam: string) =>
    `The split from epoch ${fromEpoch} to ${toEpoch} was re-derived ${derivedOn} from indexer.namada.net and the chain’s inflation formulas, epoch by epoch for ${measuredEpochs} of the ${epochs} epochs; for the rest, among them the ${modelledEpochs} epochs from ${modelledFrom} to ${modelledTo} that the indexer lacks, the formulas were carried across, so about ${modelledStakingNam} NAM of the staking figure is modelled, not measured. Before epoch ${fromEpoch} only the total growth is on record, so staking and public funding are said together there, and so is what was minted after epoch ${toEpoch}.`,
  /** the newest epoch's staking inflation, the chain's own record of it */
  mintNow: (nam: string, epoch: string, block: string) => `${nam} NAM of staking inflation was minted into the staking account as epoch ${epoch} started (the chain’s record, block ${block}).`,
  mintNotRead: 'How much staking inflation an epoch mints is not read yet: the chain records it as an epoch starts, and no epoch has started since this site began reading the record.',
  /** the one large transfer into the public-funding account */
  transfer: (nam: string, block: string, day: string) =>
    `The public-funding account also received ${nam} NAM in one transfer at block ${block} (${day}): moved from another account, not newly minted.`,
  /** the source-line labels */
  scope: {
    total: 'All NAM in existence',
    rewards: 'Shielded rewards minted, the chain’s total',
    split: 'The dated split: staking and public-funding inflation by epoch',
    mint: 'The newest epoch’s staking inflation, the chain’s record',
  } as const,
  /** the tag on the dated part */
  dated: (day: string) => `Static, dated ${day}`,
} as const;

/**
 * Whether the incidents timeline is shown: the "What happened on Namada" section of the Shielded page and the dotted
 * markers it explains on the Trade price chart and the Shielded trend. Hidden on the owner's word of 2026-11-08
 * ("hide it for now, will add later if needed"; docs/design/owner-decisions.md row 39): the rows (scripts/incidents.ts),
 * their tests and the generated file stay, so showing it again is this one flag.
 */
export const TIMELINE_SHOWN = false;

/**
 * The Supply page's genesis cohorts (2026-11-07, migration 0023): what the addresses funded at genesis hold now, by
 * cohort, against their allocations. Every figure arrives already formatted (N2); web/src/screens/supply/cohorts.ts
 * computes the parts from /api/series/cohorts. Plain words: what the addresses hold and where NAM went, never why.
 */
export const COHORT_WORDS = {
  heading: 'Genesis cohorts',
  /** the one sentence (a phone shows it alone, under the since-genesis sentence) */
  line: (allPct: string, backersPct: string, foundationPct: string, teamPct: string, publicPct: string, shieldedNam: string) =>
    `The addresses funded at genesis hold ${allPct} of their allocations; among them backers ${backersPct}, foundation ${foundationPct}, team ${teamPct}, public sale ${publicPct}; ${shieldedNam} NAM of theirs has moved into the shielded pool since this site’s record began.`,
  lead: 'What the addresses funded at genesis hold now, by cohort, against what they were allocated: spendable and staked NAM from the chain listings, and the NAM they have sent into the shielded pool since this site’s record began.',
  notLoaded: 'The allocation table is not loaded yet, so the cohorts cannot be counted.',
  noSnapshot: 'No daily snapshot of the cohorts exists yet: one is written on a day both chain listings complete.',
  /** the cohort table's heads */
  columns: { cohort: 'Cohort', addrs: 'Addresses', alloc: 'At genesis', held: 'Holds now', share: 'Share held', shielded: 'Into the shielded pool' } as const,
  /** the chart */
  chart: {
    what: 'Share of the genesis allocation held',
    unit: 'Percent of each cohort’s NAM at genesis that its addresses hold, spendable and staked, from the daily snapshot.',
    empty: 'No snapshot in this window.',
  } as const,
  /** the large allocations */
  large: {
    heading: (minNam: string) => `Allocations of ${minNam} NAM or more`,
    lead: 'Each with what it holds now and what has left it, as the flow index records it.',
    holds: 'Holds now',
    left: 'What left it',
    spendable: 'spendable',
    staked: 'staked',
    atGenesis: (nam: string) => `${nam} NAM at genesis`,
    shielded: (nam: string, moves: string) => `${nam} NAM moved into the shielded pool (${moves})`,
    sentTo: 'sent to',
    /** `cut`: the recipient's onward moves were read up to the cap, so the count is a floor */
    sentOn: (addrs: string, cut: boolean) => `has since sent to ${addrs}${cut ? ' or more' : ''}`,
    more: (nam: string, addrs: string) => `and ${nam} NAM to ${addrs} more`,
    none: 'No move out of it is on record.',
    cut: (moves: string) => `counted over its newest ${moves} moves`,
    rewound: 'Under Rewind the holdings of these allocations are not shown: balances were not recorded over time.',
    notIndexed: 'The holder index has no reading for this address.',
  } as const,
  /** the source-line labels */
  scope: {
    cohorts: 'The cohorts’ holdings and shielded moves, from the daily snapshot',
    table: 'The allocation table, from the genesis file',
    holdings: 'What each large allocation holds now, from the holder index',
    moves: 'What left each large allocation, from the flow index',
  } as const,
} as const;

/** The incidents timeline's words (web/src/generated/events.ts INCIDENTS; the Shielded page and the chart markers). */
export const TIMELINE_WORDS = {
  heading: 'What happened on Namada',
  lead: 'Dated events on the chain, each with a source you can open: releases, halts and the moves this site’s pages carry. Nothing here says how or why.',
  ongoing: 'Ongoing',
  pagesLead: 'On this site:',
  /** the chart key's line for the dotted markers */
  chartKey: 'Dotted lines: dated events on Namada, listed under “What happened on Namada” on the Shielded page',
} as const;

/** The address sheet's sentences of 2026-11-07 (first seen, NAM that came out of the pool, a label's reason). */
export const ADDRESS_WORDS = {
  firstSeen: (date: string, since: string) => `First seen ${date} by this site, which has listed every Namada balance since ${since}.`,
  /** `moves` already in words ("3 moves"); `over` names the moves counted when the list is cut ("the newest 300 moves listed below") */
  fromPool: (fromPoolNam: string, receivedNam: string, moves: string, over?: string) =>
    `${fromPoolNam} of ${receivedNam} NAM received came out of the shielded pool (${moves})${over ? `, counted over ${over}` : ''}.`,
  whyLabel: 'Why this label',
} as const;

/** The not-found view and the server's 404 page (system.md 9.9). */
export const NOT_FOUND = {
  h1: 'That page does not exist',
  lead: 'The address may be mistyped, or the page may have moved. These are the pages that exist:',
} as const;

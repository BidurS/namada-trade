// All constants below were verified against live endpoints (see implementation_plan.md).

export const NAM = {
  symbol: 'NAM',
  decimals: 6,
  /** NAM voucher denom on Osmosis (trace: transfer/channel-98451/<namada token>) */
  osmoDenom: 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3',
  osmoHash: 'C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3',
  /** Native token address on Namada */
  namadaToken: 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7',
  osmoChannel: 'channel-98451',
  namadaChannel: 'channel-1',
  coingeckoId: 'namada',
} as const;

/** The Osmosis denoms of the coins besides NAM the parser names and the cron quotes, by symbol. */
const OSMO_COIN = {
  OSMO: 'uosmo',
  ATOM: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
  TIA: 'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877',
  ETH: 'factory/osmo1k6c8jln7ejuqwtqmay3yvzrg3kueaczl96pk067ldg8u835w0yhsw27twm/alloyed/allETH',
  KYVE: 'ibc/613BF0BF2F2146AE9941E923725745E931676B2C14E9768CD609FA0849B2AE13',
} as const;

export const OSMOSIS = {
  chainId: 'osmosis-1',
  /** Keplr infra; the key is appended at runtime from the KEPLR_KEY secret */
  keplrRpc: (key: string) => `https://api.keplr.app/rpc/osmosis/${key}`,
  keplrRest: (key: string) => `https://api.keplr.app/rest/osmosis/${key}`,
  keplrWs: (key: string) => `wss://api.keplr.app/rpc/osmosis/${key}/websocket`,
  sqs: 'https://sqs.osmosis.zone',
  /** Public Osmosis RPC for the catch-up search (tx_search by event, newest first; no height ranges there) */
  publicRpc: 'https://osmosis-rpc.publicnode.com',
  /**
   * Public Osmosis REST, asked for one address's bank balance (balances/{address}/by_denom) when the Keplr REST read
   * fails; it serves that route with the same answer shape as Keplr's (checked on 2026-10-23)
   */
  publicRest: 'https://osmosis-rest.publicnode.com',
  /** ICS-20 transfer module account (mints/burns NAM vouchers) */
  transferModule: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3',
  /** Main NAM pool used as the price reference (NAM/USDC concentrated-liquidity pool) */
  refPoolId: '3005',
  /**
   * The pools whose swaps may set an executed price: price.swap_1h (and its open/high/low/close/vwap), the price check
   * and a trade's own price on the tape. The reference pool only. Anyone can create an Osmosis pool, give it any price
   * and trade NAM through it, so a swap in any other pool is recorded as a trade but priced at the quote.
   */
  pricePoolIds: ['3005'] as readonly string[],
  /**
   * The poolmanager's taker-fee collector (module account 'taker_fee_collector': the first 20 bytes of the sha256 of
   * that name). A swap pays its taker fee here, in the coin it puts in: just before it pays the pool on an exact-in hop,
   * just after the pool has swapped (its token_swapped event) on an exact-out hop.
   */
  takerFeeCollector: 'osmo1r9jc2234fljy93z80cevqjt3nmjycec8aj4cc6',
  /**
   * The pools a coin other than NAM may be priced in, against Noble USDC: pool id to that coin's denom. A trade paid in
   * one of these coins is valued at its own transaction's swap of that coin against USDC through one of these pools
   * (worker/src/parse/osmosis.ts settleFor: the trader's own hops first, each counted for its size, a hop under
   * RATE_MIN_BASE a side left out). The rate is the trader's own hop, whatever the pool's depth: it is what that trader
   * converted at, and a thin pool's worse rate is the worse price that trade settled at. Any pool not listed here is
   * anyone's and sets no rate; the pools below were read from the trades' own transactions on 2026-10-23 (each coin's
   * USDC pool as the router chose it, with its liquidity in the Osmosis data API summary that day).
   */
  ratePools: {
    '1464': OSMO_COIN.OSMO, // OSMO/USDC, $13,934: the pool ProtoRev's backruns go through, a hop after the trader's own
    '1221': OSMO_COIN.OSMO, // OSMO/USDC, $2,101: the router's choice for the OSMO leg of a NAM trade paid in OSMO
    '1263': OSMO_COIN.OSMO, // OSMO/USDC, $3,164: the router's other choice for that leg
    '1251': OSMO_COIN.ATOM, // ATOM/USDC, $119,864: 60 of the 64 ATOM-paid trades stored by 2026-10-23 hopped through it
    '1247': OSMO_COIN.TIA, // TIA/USDC, $13,233
    '1652': OSMO_COIN.KYVE, // KYVE/USDC, $6,874
    '1948': OSMO_COIN.ETH, // allETH/USDC, $43,274
  } as Readonly<Record<string, string>>,
  /**
   * The coins besides NAM the cron stores an Osmosis quote of each minute (shared/settle.ts QUOTE_KEYS), so a trade paid
   * in one of them has a settle price at its minute: OSMO, and the coins NAM trades were most often paid in (ATOM, TIA,
   * ETH, KYVE: about 700,000 NAM of trades between 11 Aug and 21 Oct 2026).
   */
  quotedCoins: OSMO_COIN as Readonly<Record<string, string>>,
  /** Osmosis's alloyed USDT, 1:1 with the USDTs it holds */
  allUsdt: 'factory/osmo1em6xs47hd82806f5cxgyufguxrrc7l0aqx7nzzptjuqgswczk8csavdxek/alloyed/allUSDT',
  /** Noble USDC on Osmosis */
  usdcDenom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4',
  allUsdc: 'factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC',
  assetlist: 'https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/generated/frontend/assetlist.json',
} as const;

export const NAMADA = {
  chainId: 'namada.5f5de2dd1b88cba30586420',
  /** Ordered by preference. Both have full history (earliest block 1) and tx_index on. */
  rpcs: [
    { provider: '5ElementsNodes', url: 'https://rpc-namada.5elementsnodes.com' },
    { provider: 'Papadritta', url: 'https://rpc.papadritta.com' },
  ],
  /** Stale (~850k blocks behind at research time) – used only for static metadata */
  staleIndexer: 'https://indexer.namada.citizenweb3.com',
  valopersValidators: 'https://raw.githubusercontent.com/alxnode/valopers/refs/heads/main/namada/validators.json',
  multitoken: 'tnam1pyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqej6juv',
  internal: {
    pos: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp',
    ibc: 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4',
    masp: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah',
    pgf: 'tnam1pgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkhgajr',
    governance: 'tnam1q5qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrw33g6',
  },
  explorerTx: (h: string) => `https://namada.valopers.com/transactions/${h.toUpperCase()}`,
  explorerAddr: (a: string) => `https://namada.valopers.com/account/${a}`,
} as const;

export const EXPLORERS = {
  osmoTx: (h: string) => `https://www.mintscan.io/osmosis/tx/${h}`,
  osmoAddr: (a: string) => `https://www.mintscan.io/osmosis/address/${a}`,
};

export const INTERNAL_LABELS: Record<string, { label: string; category: string }> = {
  // The account holds what is staked plus NAM on its way out (unstaking, withdrawable, unclaimed rewards).
  [NAMADA.internal.pos]: { label: 'Namada PoS account (staked + unstaking + unclaimed rewards)', category: 'pos' },
  [NAMADA.internal.ibc]: { label: 'Namada IBC escrow', category: 'ibc' },
  [NAMADA.internal.masp]: { label: 'MASP shielded pool', category: 'masp' },
  [NAMADA.internal.pgf]: { label: 'Public Goods Funding', category: 'module' },
  [NAMADA.internal.governance]: { label: 'Governance', category: 'module' },
  [OSMOSIS.transferModule]: { label: 'Osmosis IBC transfer module', category: 'module' },
};

export const UA = 'NamadaTrade/1.0 (+cloudflare-worker)';

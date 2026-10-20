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

export const OSMOSIS = {
  chainId: 'osmosis-1',
  /** Keplr infra; the key is appended at runtime from the KEPLR_KEY secret */
  keplrRpc: (key: string) => `https://api.keplr.app/rpc/osmosis/${key}`,
  keplrRest: (key: string) => `https://api.keplr.app/rest/osmosis/${key}`,
  keplrWs: (key: string) => `wss://api.keplr.app/rpc/osmosis/${key}/websocket`,
  sqs: 'https://sqs.osmosis.zone',
  /** Public Osmosis RPC for the catch-up search (tx_search by event, newest first; no height ranges there) */
  publicRpc: 'https://osmosis-rpc.publicnode.com',
  /** ICS-20 transfer module account (mints/burns NAM vouchers) */
  transferModule: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3',
  /** Main NAM pool used as the price reference (NAM/USDC concentrated-liquidity pool) */
  refPoolId: '3005',
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
